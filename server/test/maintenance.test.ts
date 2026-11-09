// 归档维护（契约第 11 节）：season_stats 不翻倍、open 注单保留、betsDeleted 统计正确（多结果市场 schema）。
import { describe, expect, test } from 'bun:test';
import { runMaintenance } from '../src/routes/admin';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const USER_KEY2 = `${ISS}#10002`;
const NOW = Date.now();

// 与配置默认赛季（当前月）同源：归档只处理 season < cutoff 的注单。
async function oldSeason(): Promise<string> {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 4); // retain_bet_seasons=2，4 个月前必然 < cutoff
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function seedMarket(db: MemoryD1): Promise<void> {
  // trg_bets_market_open 要求市场 open 且未过期才允许插入注单。
  await db.inner
    .prepare(
      "INSERT OR IGNORE INTO markets (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at) " +
        "VALUES ('m1', 'T', '', ?, 'open', 'exclusive', NULL, NULL, NULL, NULL, ?, ?)",
    )
    .run(NOW + 86_400_000, NOW, NOW);
  await db.inner
    .prepare(
      "INSERT OR IGNORE INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) " +
        "VALUES ('a', 'm1', 'A', '{\"kind\":\"never\"}', 0, 0, 0, 0, NULL, ?)",
    )
    .run(NOW);
}

async function seedBet(
  db: MemoryD1,
  id: string,
  userKey: string,
  season: string,
  status: 'open' | 'won' | 'lost' | 'refunded',
  amount: number,
  payout = 0,
): Promise<void> {
  await seedMarket(db);
  await db.inner
    .prepare(
      "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) " +
        "VALUES (?, ?, 'm1', 'a', ?, ?, 0, ?, ?, ?, ?)",
    )
    .run(id, `req_${id}`, userKey, amount, status, payout, season, NOW);
}

describe('runMaintenance 归档', () => {
  test('已结算旧注单归档：betsDeleted 正确，open 注单保留', async () => {
    const { env, db } = makeEnv();
    const season = await oldSeason();
    await seedBet(db, 'b1', USER_KEY, season, 'won', 100, 200);
    await seedBet(db, 'b2', USER_KEY, season, 'lost', 50);
    await seedBet(db, 'b3', USER_KEY2, season, 'open', 30); // open 注单保留到市场结算
    await seedBet(db, 'b4', USER_KEY2, season, 'refunded', 20);

    const counts = await runMaintenance(env, NOW);
    expect(counts.bets).toBe(3); // b1 b2 b4 被删除

    const remaining = await db.prepare('SELECT id FROM bets ORDER BY id').all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual(['b3']); // 只剩 open 注单

    // season_stats 聚合两个非 open 用户的行，且不含 open-only 用户。
    const stats = await db.prepare('SELECT user_key, staked, payout, correct, total FROM season_stats ORDER BY user_key').all<{
      user_key: string;
      staked: number;
      payout: number;
      correct: number;
      total: number;
    }>();
    expect(stats.results).toHaveLength(2);
    expect(stats.results[0]).toEqual({ user_key: USER_KEY, staked: 150, payout: 200, correct: 1, total: 2 });
    expect(stats.results[1]).toEqual({ user_key: USER_KEY2, staked: 20, payout: 0, correct: 0, total: 1 });
  });

  test('下注/结算已实时累加过 stats：归档不重复累加（DO NOTHING）', async () => {
    const { env, db } = makeEnv();
    const season = await oldSeason();
    await seedBet(db, 'b1', USER_KEY, season, 'lost', 100);
    // 模拟下注时 upsertSeasonStats 已实时累加过该行。
    await db.inner
      .prepare(
        'INSERT INTO season_stats (season, user_key, start_chips, end_chips, staked, payout, correct, total, peak_chips) ' +
          "VALUES (?, ?, 1000, 1000, 100, 0, 0, 1, 1000) ON CONFLICT(season, user_key) DO NOTHING",
      )
      .run(season, USER_KEY);

    await runMaintenance(env, NOW);

    const stats = await db.prepare('SELECT staked, payout, correct, total FROM season_stats WHERE season = ? AND user_key = ?')
      .bind(season, USER_KEY)
      .first<{ staked: number; payout: number; correct: number; total: number }>();
    expect(stats).toEqual({ staked: 100, payout: 0, correct: 0, total: 1 }); // 不翻倍
    const bets = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(bets?.n).toBe(0);
  });

  test('重复执行幂等：第二次运行 bets 为 0，betsDeleted 返回 0', async () => {
    const { env, db } = makeEnv();
    const season = await oldSeason();
    await seedBet(db, 'b1', USER_KEY, season, 'lost', 100);
    const first = await runMaintenance(env, NOW);
    expect(first.bets).toBe(1);
    const second = await runMaintenance(env, NOW);
    expect(second.bets).toBe(0);
    void season;
  });

  test('赛季只剩 open 注单：不删除，betsDeleted 为 0', async () => {
    const { env, db } = makeEnv();
    const season = await oldSeason();
    await seedBet(db, 'b1', USER_KEY, season, 'open', 30);
    const counts = await runMaintenance(env, NOW);
    expect(counts.bets).toBe(0);
    const remaining = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(remaining?.n).toBe(1);
  });

  test('ledger / audit 按保留天数清理', async () => {
    const { env, db } = makeEnv();
    const old = NOW - 181 * 86_400_000;
    await db.inner
      .prepare("INSERT INTO ledger (user_key, market_id, outcome_id, bet_id, delta, reason, season, created_at) VALUES (?, NULL, NULL, NULL, 1, 'claim', '2026-01', ?)")
      .run(USER_KEY, old);
    await db.inner
      .prepare("INSERT INTO ledger (user_key, market_id, outcome_id, bet_id, delta, reason, season, created_at) VALUES (?, NULL, NULL, NULL, 1, 'claim', '2026-01', ?)")
      .run(USER_KEY, NOW);
    await db.inner
      .prepare("INSERT INTO audit (action, actor, target, detail, created_at) VALUES ('test', 'admin', NULL, NULL, ?)")
      .run(old);
    const counts = await runMaintenance(env, NOW);
    expect(counts.ledger).toBe(1);
    expect(counts.audit).toBe(1);
    const ledger = await db.prepare('SELECT COUNT(*) AS n FROM ledger').first<{ n: number }>();
    expect(ledger?.n).toBe(1);
    const audit = await db.prepare('SELECT COUNT(*) AS n FROM audit').first<{ n: number }>();
    expect(audit?.n).toBe(0); // 唯一一条已过期删除
  });
});
