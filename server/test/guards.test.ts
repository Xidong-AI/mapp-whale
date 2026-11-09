// 资金原子性守卫（P0）：迁移触发器、下注回滚、每日领取幂等、结算两阶段抢占与重试。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleClaim } from '../src/routes/me';
import { handlePlaceBet } from '../src/routes/bets';
import { handleAdminSettle } from '../src/routes/admin';
import { settleMarketDb, acquireForSettlement, retryStuckSettling } from '../src/settle';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';
import type { MarketRow } from '../src/types';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const USER_KEY2 = `${ISS}#10002`;
const NOW = Date.now();

async function seedMarket(
  db: MemoryD1,
  overrides: Partial<MarketRow> = {},
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, condition_json, deadline, status, yes_pool, no_pool, seed_yes, seed_no, created_at, updated_at) " +
        "VALUES (?, 'T', '', '{}', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      overrides.id ?? 'm1',
      overrides.deadline ?? NOW + 86_400_000,
      overrides.status ?? 'open',
      overrides.yes_pool ?? 0,
      overrides.no_pool ?? 0,
      overrides.seed_yes ?? 0,
      overrides.seed_no ?? 0,
      NOW,
      NOW,
    );
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
  side: 'yes' | 'no',
  amount: number,
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO bets (id, client_request_id, market_id, user_key, side, amount, confidence, status, payout, season, created_at) " +
        "VALUES (?, ?, 'm1', ?, ?, ?, 0, 'open', 0, '2026-11', ?)",
    )
    .run(id, `req_${id}`, userKey, side, amount, NOW);
}

describe('迁移 0002_guards.sql', () => {
  test('能成功应用且幂等（IF NOT EXISTS 可重复执行）', () => {
    const db = new MemoryD1();
    db.applySchema(readFileSync(join(import.meta.dir, '..', 'migrations', '0001_init.sql'), 'utf-8'));
    const sql = readFileSync(join(import.meta.dir, '..', 'migrations', '0002_guards.sql'), 'utf-8');
    expect(() => db.applySchema(sql)).not.toThrow();
    expect(() => db.applySchema(sql)).not.toThrow();
    const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%'").first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  test('触发器：users.chips 不允许为负', async () => {
    const { db } = makeEnv();
    await seedUser(db, USER_KEY, 50);
    expect(() =>
      db.prepare('UPDATE users SET chips = chips - 100 WHERE user_key = ?').bind(USER_KEY).run(),
    ).toThrow('NEGATIVE_CHIPS');
  });

  test('触发器：市场非 open 或已过期禁止下注', async () => {
    const { db } = makeEnv();
    await seedUser(db, USER_KEY, 1000);
    await seedMarket(db, { status: 'locked' });
    const insert = "INSERT INTO bets (id, client_request_id, market_id, user_key, side, amount, confidence, status, payout, season, created_at) VALUES ('b_x', 'rx', 'm1', ?, 'yes', 10, 0, 'open', 0, '2026-11', ?)";
    expect(() => db.prepare(insert).bind(USER_KEY, NOW).run()).toThrow('MARKET_CLOSED');
    await seedMarket(db, { id: 'm2', deadline: NOW - 2000 });
    expect(() =>
      db.prepare(insert.replace("'m1'", "'m2'").replace("'rx'", "'rx2'")).bind(USER_KEY, NOW).run(),
    ).toThrow('MARKET_CLOSED');
  });
});

describe('POST /bets 原子回滚', () => {
  test('余额不足：注单、池子、流水、赛季统计都不落库', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedUser(db, USER_KEY, 30);
    // max_bet_ratio 放大到 10: 100 <= 30*10=300 通过预检，扣款由触发器兜底拒绝。
    await db.prepare("UPDATE config SET value = '10', updated_at = ? WHERE key = 'max_bet_ratio'").bind(NOW).run();
    await expect(
      handlePlaceBet(env, ISS, '10001', null, { marketId: 'm1', side: 'yes', amount: 100, confidence: 0, clientRequestId: 'r1' }, NOW),
    ).rejects.toThrow('INSUFFICIENT_CHIPS');

    expect((await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM ledger').first<{ n: number }>())?.n).toBe(0);
    const pools = await db.prepare('SELECT yes_pool, no_pool FROM markets WHERE id = ?').bind('m1').first<{ yes_pool: number; no_pool: number }>();
    expect(pools?.yes_pool).toBe(0);
    expect(pools?.no_pool).toBe(0);
    const user = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
    expect(user?.chips).toBe(30);
    const stats = await db.prepare('SELECT COUNT(*) AS n FROM season_stats').first<{ n: number }>();
    expect(stats?.n).toBe(0);
  });

  test('市场已截止（预检通过场景外）：池子更新带守卫不生效', async () => {
    const { db } = makeEnv();
    await seedMarket(db, { deadline: NOW - 1 });
    // 池子更新守卫：非 open 或过期时静默不生效（配合触发器整批回滚）。
    const res = await db
      .prepare("UPDATE markets SET yes_pool = yes_pool + 100 WHERE id = ? AND status = 'open' AND deadline > ?")
      .bind('m1', NOW).run();
    expect(res.meta.changes).toBe(0);
  });
});

describe('POST /me/claim 并发幂等', () => {
  test('并发两次调用只发放一次', async () => {
    const { env, db } = makeEnv();
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

describe('结算两阶段抢占', () => {
  function setupSettleEnv() {
    const { env, db } = makeEnv();
    return { env, db };
  }

  test('并发两次 settle 同一市场，只派奖一次', async () => {
    const { env, db } = setupSettleEnv();
    await seedMarket(db);
    await seedUser(db, USER_KEY, 1000);
    await seedUser(db, USER_KEY2, 1000);
    await seedBet(db, 'b1', USER_KEY, 'yes', 100);
    await seedBet(db, 'b2', USER_KEY2, 'no', 100);

    const results = await Promise.allSettled([
      handleAdminSettle(env, 'm1', { outcome: 'yes', reason: 'manual' }, NOW),
      handleAdminSettle(env, 'm1', { outcome: 'yes', reason: 'manual' }, NOW),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflict = results.filter((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message).includes('CONFLICT'));
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(1);

    // u1 赢：payout = floor(100/100 * 200) = 200，只加一次。
    const u1 = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
    expect(u1?.chips).toBe(1200);
    const payouts = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'payout'").first<{ n: number }>();
    expect(payouts?.n).toBe(1);
    const market = await db.prepare("SELECT status, outcome FROM markets WHERE id = 'm1'").first<{ status: string; outcome: string }>();
    expect(market?.status).toBe('settled');
    expect(market?.outcome).toBe('yes');
  });

  test('settling 重试不重复派奖（settleMarketDb 二次调用安全）', async () => {
    const { env, db } = setupSettleEnv();
    await seedMarket(db);
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'yes', 100);

    await acquireForSettlement(env, 'm1', NOW);
    await settleMarketDb(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, 'yes', 'auto', '2026-11', NOW);
    const chips1 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    // 只有 b1（yes 100）一注：total = 100，payout = 100，无输方。
    expect(chips1).toBe(1100);

    // 二次调用：无 open 注单 → 幂等空操作，不重复派奖，不报错。
    await acquireForSettlement(env, 'm1', NOW); // 此时市场已 settled，抢占失败
    await settleMarketDb(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, 'yes', 'retry', '2026-11', NOW + 1);
    const chips2 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(chips2).toBe(1100);
    const payouts = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'payout'").first<{ n: number }>();
    expect(payouts?.n).toBe(1);
  });

  test('cron 对卡在 settling 的市场幂等重试，不重复派奖', async () => {
    const { env, db } = setupSettleEnv();
    await seedMarket(db, { deadline: NOW - 1 }); // 已过期 → 推断 outcome 为 no
    await seedUser(db, USER_KEY, 1000);
    await seedUser(db, USER_KEY2, 1000);
    await seedBet(db, 'b1', USER_KEY, 'yes', 100);
    await seedBet(db, 'b2', USER_KEY2, 'no', 100);

    // 模拟上次派奖失败，市场停在 settling。
    await db.prepare("UPDATE markets SET status = 'settling' WHERE id = 'm1'").run();

    const retried1 = await retryStuckSettling(env, { season: '2026-11', poll_confirmations: 2 }, NOW);
    expect(retried1).toBe(1);
    const u2 = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY2).first<{ chips: number }>())?.chips;
    expect(u2).toBe(1200); // no 方赢

    const retried2 = await retryStuckSettling(env, { season: '2026-11', poll_confirmations: 2 }, NOW + 1);
    expect(retried2).toBe(0);
    const u2After = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY2).first<{ chips: number }>())?.chips;
    expect(u2After).toBe(1200);
    const payouts = await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE reason = 'payout'").first<{ n: number }>();
    expect(payouts?.n).toBe(1);
  });
});
