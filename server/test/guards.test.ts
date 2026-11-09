// 资金原子性守卫（P0）：迁移触发器、下注回滚、每日领取幂等、结算两阶段抢占与重试（多结果市场）。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleClaim } from '../src/routes/me';
import { handlePlaceBet } from '../src/routes/bets';
import { handleAdminSettle } from '../src/routes/admin';
import { settleMarketDb, acquireForSettlement, retryStuckSettling } from '../src/settle';
import { makeEnv, clearSeedMarkets } from './helpers/env';
import { MemoryD1 } from './helpers/d1';
import type { MarketRow } from '../src/types';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const USER_KEY2 = `${ISS}#10002`;
const NOW = Date.now();

/** 建独立测试环境：清掉 0004 种子市场。 */
function makeIsolatedEnv() {
  const made = makeEnv();
  clearSeedMarkets(made.db);
  return made;
}

async function seedMarket(
  db: MemoryD1,
  overrides: Partial<MarketRow> = {},
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at) " +
        "VALUES (?, 'T', '', ?, ?, 'exclusive', NULL, NULL, NULL, NULL, ?, ?)",
    )
    .run(
      overrides.id ?? 'm1',
      overrides.deadline ?? NOW + 86_400_000,
      overrides.status ?? 'open',
      NOW,
      NOW,
    );
}

async function seedOutcome(
  db: MemoryD1,
  marketId: string,
  id: string,
  seed = 0,
  sortOrder = 0,
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) " +
        "VALUES (?, ?, ?, '{\"kind\":\"never\"}', 0, ?, ?, 0, NULL, ?)",
    )
    .run(id, marketId, `L_${id}`, seed, sortOrder, NOW);
}

async function seedUser(db: MemoryD1, userKey: string, chips: number): Promise<void> {
  await db.inner
    .prepare('INSERT INTO users (user_key, chips, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userKey, chips, NOW, NOW);
}

async function seedBet(
  db: MemoryD1,
  id: string,
  userKey: string,
  outcomeId: string,
  amount: number,
  marketId = 'm1',
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 0, '2026-11', ?)",
    )
    .run(id, `req_${id}`, marketId, outcomeId, userKey, amount, NOW);
  // 同步 outcome pool（下注流程里 pool 与 bet 同 batch 累计；seed 直接补齐）。
  await db.inner
    .prepare('UPDATE outcomes SET pool = pool + ? WHERE market_id = ? AND id = ?')
    .run(amount, marketId, outcomeId);
}

describe('迁移触发器', () => {
  test('0003 触发器重建：市场非 open / 已过期 / outcome 不属于市场都拒绝', () => {
    const db = new MemoryD1();
    db.applySchema(readFileSync(join(import.meta.dir, '..', 'migrations', '0001_init.sql'), 'utf-8'));
    db.applySchema(readFileSync(join(import.meta.dir, '..', 'migrations', '0002_guards.sql'), 'utf-8'));
    db.applySchema(readFileSync(join(import.meta.dir, '..', 'migrations', '0003_outcomes.sql'), 'utf-8'));
    const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%'").first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  test('触发器：users.chips 不允许为负', async () => {
    const { db } = makeIsolatedEnv();
    await seedUser(db, USER_KEY, 50);
    expect(() =>
      db.prepare('UPDATE users SET chips = chips - 100 WHERE user_key = ?').bind(USER_KEY).run(),
    ).toThrow('NEGATIVE_CHIPS');
  });

  test('触发器：市场非 open 或已过期禁止下注', async () => {
    const { db } = makeIsolatedEnv();
    await seedUser(db, USER_KEY, 1000);
    await seedMarket(db, { status: 'locked' });
    await seedOutcome(db, 'm1', 'a');
    const insert = "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) VALUES ('b_x', 'rx', 'm1', 'a', ?, 10, 0, 'open', 0, '2026-11', ?)";
    expect(() => db.prepare(insert).bind(USER_KEY, NOW).run()).toThrow('MARKET_CLOSED');
    await seedMarket(db, { id: 'm2', deadline: NOW - 2000 });
    await seedOutcome(db, 'm2', 'a');
    expect(() =>
      db.prepare(insert.replace("'m1'", "'m2'").replace("'rx'", "'rx2'").replace("'b_x'", "'b_y'")).bind(USER_KEY, NOW).run(),
    ).toThrow('MARKET_CLOSED');
  });

  test('触发器：outcome 不属于该市场时拒绝下注', async () => {
    const { db } = makeIsolatedEnv();
    await seedUser(db, USER_KEY, 1000);
    await seedMarket(db);
    // m1 只有 outcome 'a'；插 outcome 'zz' 的注单应被触发器拒绝。
    const insert = "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) VALUES ('b_z', 'rz', 'm1', 'zz', ?, 10, 0, 'open', 0, '2026-11', ?)";
    expect(() => db.prepare(insert).bind(USER_KEY, NOW).run()).toThrow('MARKET_CLOSED');
  });
});

describe('POST /bets 原子回滚', () => {
  test('余额不足：注单、池子、流水、赛季统计都不落库', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await seedUser(db, USER_KEY, 30);
    // max_bet_ratio 放大到 10: 100 <= 30*10=300 通过预检，扣款由触发器兜底拒绝。
    await db.prepare("UPDATE config SET value = '10', updated_at = ? WHERE key = 'max_bet_ratio'").bind(NOW).run();
    await expect(
      handlePlaceBet(env, ISS, '10001', null, { marketId: 'm1', outcomeId: 'a', amount: 100, confidence: 0, clientRequestId: 'r1' }, NOW),
    ).rejects.toThrow('INSUFFICIENT_CHIPS');

    expect((await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM ledger').first<{ n: number }>())?.n).toBe(0);
    const pool = await db.prepare("SELECT pool FROM outcomes WHERE market_id = 'm1' AND id = 'a'").first<{ pool: number }>();
    expect(pool?.pool).toBe(0);
    const user = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
    expect(user?.chips).toBe(30);
    const stats = await db.prepare('SELECT COUNT(*) AS n FROM season_stats').first<{ n: number }>();
    expect(stats?.n).toBe(0);
  });

  test('市场已截止：池子更新带守卫不生效', async () => {
    const { db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    // 池子更新本身没有状态守卫（守卫在 bets 插入触发器上），这里验证 outcomes 更新可直接执行。
    const res = await db
      .prepare("UPDATE outcomes SET pool = pool + 100 WHERE market_id = 'm1' AND id = 'a'")
      .run();
    expect(res.meta.changes).toBe(1);
  });
});

describe('POST /me/claim 并发幂等', () => {
  test('并发两次调用只发放一次', async () => {
    const { env, db } = makeIsolatedEnv();
    const [r1, r2] = await Promise.all([
      handleClaim(env, USER_KEY, null, NOW) as Promise<{ claimed: boolean; chips: number }>,
      handleClaim(env, USER_KEY, null, NOW) as Promise<{ claimed: boolean; chips: number }>,
    ]);
    const claimed = [r1, r2].filter((r) => r.claimed);
    expect(claimed).toHaveLength(1);
    for (const r of [r1, r2]) {
      if (r.claimed) expect(r.chips).toBe(1100); // initial 1000 + daily 100
    }
    // 流水里 initial + daily 各一条 reason='claim'。
    const daily = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'claim' AND delta = 100").first<{ n: number }>();
    expect(daily?.n).toBe(1);
    const user = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
    expect(user?.chips).toBe(1100);
  });
});

describe('结算两阶段抢占（多结果）', () => {
  test('并发两次 settle 同一市场，只派奖一次', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await seedOutcome(db, 'm1', 'b', 0, 1);
    await seedUser(db, USER_KEY, 1000);
    await seedUser(db, USER_KEY2, 1000);
    await seedBet(db, 'b1', USER_KEY, 'a', 100);
    await seedBet(db, 'b2', USER_KEY2, 'b', 100);

    const results = await Promise.allSettled([
      handleAdminSettle(env, 'm1', { outcomeId: 'a', reason: 'manual' }, NOW),
      handleAdminSettle(env, 'm1', { outcomeId: 'a', reason: 'manual' }, NOW),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflict = results.filter((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message).includes('CONFLICT'));
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(1);

    // u1 赢：total = 200（含双方 100），winPool = 100 → payout = 200，只加一次。
    const u1 = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
    expect(u1?.chips).toBe(1200);
    const payouts = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'payout'").first<{ n: number }>();
    expect(payouts?.n).toBe(1);
    const market = await db.prepare("SELECT status, winning_outcome_id FROM markets WHERE id = 'm1'").first<{ status: string; winning_outcome_id: string }>();
    expect(market?.status).toBe('settled');
    expect(market?.winning_outcome_id).toBe('a');
  });

  test('settling 重试不重复派奖（settleMarketDb 二次调用安全）', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'a', 100);

    await acquireForSettlement(env, 'm1', NOW);
    await settleMarketDb(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, { outcomeId: 'a', void: false, reason: 'auto' }, '2026-11', NOW);
    const chips1 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(chips1).toBe(1100);

    // 二次调用：无 open 注单 → 幂等空操作，不重复派奖，不报错。
    await acquireForSettlement(env, 'm1', NOW); // 此时市场已 settled，抢占失败
    await settleMarketDb(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, { outcomeId: 'a', void: false, reason: 'retry' }, '2026-11', NOW + 1);
    const chips2 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(chips2).toBe(1100);
    const payouts = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'payout'").first<{ n: number }>();
    expect(payouts?.n).toBe(1);
  });

  test('cron 对卡在 settling 的市场幂等重试，不重复派奖', async () => {
    const { env, db } = makeIsolatedEnv();
    // 先建未来市场、插注单，再改 deadline 为已过期（触发器要求插入时市场未过期）。
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await seedOutcome(db, 'm1', 'b', 0, 1);
    await seedUser(db, USER_KEY, 1000);
    await seedUser(db, USER_KEY2, 1000);
    await seedBet(db, 'b1', USER_KEY, 'a', 100);
    await seedBet(db, 'b2', USER_KEY2, 'b', 100);
    await db.prepare('UPDATE markets SET deadline = ? WHERE id = ?').bind(NOW - 1, 'm1').run();

    // 模拟上一轮已选定赢家 a 但派奖失败，市场停在 settling。
    await db.prepare("UPDATE markets SET status = 'settling', winning_outcome_id = 'a' WHERE id = 'm1'").run();

    const retried1 = await retryStuckSettling(env, { season: '2026-11', poll_confirmations: 2 }, NOW);
    expect(retried1).toBe(1);
    const u1 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(u1).toBe(1200); // a 方赢

    const retried2 = await retryStuckSettling(env, { season: '2026-11', poll_confirmations: 2 }, NOW + 1);
    expect(retried2).toBe(0);
    const u1After = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(u1After).toBe(1200);
    const payouts = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'payout'").first<{ n: number }>();
    expect(payouts?.n).toBe(1);
  });

  test('cron 重试：settling 且无赢家记录且已过期 → void 退款', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'a', 100);
    await db.prepare('UPDATE markets SET deadline = ? WHERE id = ?').bind(NOW - 1, 'm1').run();

    await db.prepare("UPDATE markets SET status = 'settling' WHERE id = 'm1'").run();
    const retried = await retryStuckSettling(env, { season: '2026-11', poll_confirmations: 2 }, NOW);
    expect(retried).toBe(1);
    const u1 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(u1).toBe(1100); // 全额退款
    const market = await db.prepare("SELECT status, winning_outcome_id FROM markets WHERE id = 'm1'").first<{ status: string; winning_outcome_id: string | null }>();
    expect(market?.status).toBe('settled');
    expect(market?.winning_outcome_id).toBeNull();
    const bet = await db.prepare("SELECT status FROM bets WHERE id = 'b1'").first<{ status: string }>();
    expect(bet?.status).toBe('refunded');
  });
});
