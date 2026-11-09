// 结算引擎集成测试（契约 v2 第 4 节）：多 outcome 求值、chooseAndSettle、manual 市场等待、hit_count 累计。
import { describe, expect, test } from 'bun:test';
import { updateOutcomeHits, chooseAndSettle, evaluateConditionJson } from '../src/settle';
import { makeEnv, clearSeedMarkets } from './helpers/env';
import { MemoryD1 } from './helpers/d1';
import type { MarketRow } from '../src/types';
import type { ModelRow } from '../src/conditions';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const NOW = Date.now();

const V5_MODEL: ModelRow = { id: '1', name: 'DeepSeek-V5', context_window: 1_500_000 };

async function seedMarket(
  db: MemoryD1,
  overrides: Partial<MarketRow> = {},
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at) " +
        "VALUES (?, 'T', '', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
    )
    .run(
      overrides.id ?? 'm1',
      overrides.deadline ?? NOW + 86_400_000,
      overrides.status ?? 'open',
      overrides.settle_mode ?? 'exclusive',
      overrides.fallback_outcome_id ?? null,
      NOW,
      NOW,
    );
}

async function seedOutcome(
  db: MemoryD1,
  marketId: string,
  id: string,
  conditionJson: string,
  opts: { seed?: number; sortOrder?: number; hitCount?: number; pool?: number } = {},
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .run(id, marketId, `L_${id}`, conditionJson, opts.pool ?? 0, opts.seed ?? 0, opts.sortOrder ?? 0, opts.hitCount ?? 0, NOW);
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
  marketId: string,
  outcomeId: string,
  amount: number,
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

describe('evaluateConditionJson', () => {
  test('合法条件求值；非法 JSON / 非法条件返回 false 不抛异常', () => {
    expect(evaluateConditionJson('{"kind":"name_regex","regex":"V5","flags":"i"}', [V5_MODEL])).toBe(true);
    expect(evaluateConditionJson('not json', [V5_MODEL])).toBe(false);
    expect(evaluateConditionJson('{"kind":"bogus"}', [V5_MODEL])).toBe(false);
    expect(evaluateConditionJson('{"kind":"name_regex"}', [V5_MODEL])).toBe(false);
  });
});

describe('updateOutcomeHits', () => {
  test('命中累计 hit_count、记录 first_seen_at、达标进入 validHits', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', '{"kind":"name_regex","regex":"DeepSeek[- ]?V5","flags":"i"}', { hitCount: 1 });
    await seedOutcome(db, 'm1', 'b', '{"kind":"never"}', { sortOrder: 1 });

    const rows = await db.prepare("SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1' ORDER BY sort_order").all<{ id: string; condition_json: string; hit_count: number; first_seen_at: number | null }>();
    const hits = await updateOutcomeHits(env, 'm1', rows.results, [V5_MODEL], 2, NOW);
    expect(hits).toEqual(['a']); // a 达到 2 次
    const a = await db.prepare("SELECT hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1' AND id = 'a'").first<{ hit_count: number; first_seen_at: number | null }>();
    expect(a?.hit_count).toBe(2);
    expect(a?.first_seen_at).toBe(NOW); // 首次记录
    const b = await db.prepare("SELECT hit_count FROM outcomes WHERE market_id = 'm1' AND id = 'b'").first<{ hit_count: number }>();
    expect(b?.hit_count).toBe(0);
  });

  test('未命中：hit_count 清零；first_seen_at 保留', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    const seen = NOW - 1000;
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}', { hitCount: 3 });
    await db.inner.prepare("UPDATE outcomes SET first_seen_at = ? WHERE market_id = 'm1' AND id = 'a'").run(seen);

    const rows = await db.prepare("SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1'").all<{ id: string; condition_json: string; hit_count: number; first_seen_at: number | null }>();
    const hits = await updateOutcomeHits(env, 'm1', rows.results, [V5_MODEL], 2, NOW);
    expect(hits).toEqual([]);
    const a = await db.prepare("SELECT hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1' AND id = 'a'").first<{ hit_count: number; first_seen_at: number | null }>();
    expect(a?.hit_count).toBe(0);
    expect(a?.first_seen_at).toBe(seen);
  });

  test('first_seen_between 窗口边界', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', '{"kind":"first_seen_between","regex":"V5","flags":"i","start":100,"end":200}');
    const rows = await db.prepare("SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1'").all<{ id: string; condition_json: string; hit_count: number; first_seen_at: number | null }>();
    // 首次观测：不在窗口 [100,200) → false
    expect(await updateOutcomeHits(env, 'm1', rows.results, [V5_MODEL], 2, 99)).toEqual([]);
    // 首次观测落在窗口内 → true（但 hit 1 < 2 不达标）
    const hits = await updateOutcomeHits(env, 'm1', rows.results, [V5_MODEL], 2, 100);
    expect(hits).toEqual([]);
    expect((await db.prepare("SELECT hit_count FROM outcomes WHERE market_id = 'm1' AND id = 'a'").first<{ hit_count: number }>())?.hit_count).toBe(1);
    // 二次观测 199 仍在窗口（end 不含 200）→ 达标
    const rows2 = await db.prepare("SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1'").all<{ id: string; condition_json: string; hit_count: number; first_seen_at: number | null }>();
    expect(await updateOutcomeHits(env, 'm1', rows2.results, [V5_MODEL], 2, 199)).toEqual(['a']);
    // 二次观测 200 出窗 → 清零
    await db.inner.prepare("UPDATE outcomes SET hit_count = 0 WHERE market_id = 'm1' AND id = 'a'").run();
    const rows3 = await db.prepare("SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1'").all<{ id: string; condition_json: string; hit_count: number; first_seen_at: number | null }>();
    expect(await updateOutcomeHits(env, 'm1', rows3.results, [V5_MODEL], 2, 200)).toEqual([]);
  });

  test('field_range selector first：取首个命中名字模型', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', '{"kind":"field_range","targetNameRegex":"DeepSeek[- ]?V5","flags":"i","field":"context_window","min":1048576,"max":2097152,"selector":"first"}');
    const rows = await db.prepare("SELECT id, condition_json, hit_count, first_seen_at FROM outcomes WHERE market_id = 'm1'").all<{ id: string; condition_json: string; hit_count: number; first_seen_at: number | null }>();
    expect(await updateOutcomeHits(env, 'm1', rows.results, [V5_MODEL], 1, NOW)).toEqual(['a']);
  });
});

describe('chooseAndSettle', () => {
  test('exclusive 恰一命中 → 派奖', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}', { seed: 0, pool: 100 });
    await seedOutcome(db, 'm1', 'b', '{"kind":"never"}', { seed: 0, sortOrder: 1, pool: 300 });
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'm1', 'a', 100);

    const ok = await chooseAndSettle(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, ['a'], [V5_MODEL], '2026-11', NOW);
    expect(ok).toBe(true);
    // total = 400；winPool = 100 → payout = 400。
    const chips = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(chips).toBe(1400);
    const market = await db.prepare("SELECT status, winning_outcome_id, settle_reason FROM markets WHERE id = 'm1'").first<{ status: string; winning_outcome_id: string | null; settle_reason: string }>();
    expect(market?.status).toBe('settled');
    expect(market?.winning_outcome_id).toBe('a');
    expect(market?.settle_reason).toBe('auto');
  });

  test('exclusive 零命中未截止 → 等待不结算', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}');
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'm1', 'a', 100);

    const ok = await chooseAndSettle(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, [], [V5_MODEL], '2026-11', NOW);
    expect(ok).toBe(false);
    const market = await db.prepare("SELECT status FROM markets WHERE id = 'm1'").first<{ status: string }>();
    expect(market?.status).toBe('open');
  });

  test('exclusive 零命中已截止 → fallback 结算', async () => {
    const { env, db } = makeEnv();
    // 先建未来市场、插注单，再改 deadline 为已过期（触发器要求插入时市场未过期）。
    await seedMarket(db, { fallback_outcome_id: 'b' });
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}', { pool: 100 });
    await seedOutcome(db, 'm1', 'b', '{"kind":"never"}', { sortOrder: 1, pool: 100 });
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'm1', 'b', 100);
    await db.inner.prepare('UPDATE markets SET deadline = ? WHERE id = ?').run(NOW - 1, 'm1');

    const ok = await chooseAndSettle(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, [], [V5_MODEL], '2026-11', NOW);
    expect(ok).toBe(true);
    // b 赢：total = 200，winPool = 100 → payout = 200。
    const chips = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(chips).toBe(1200);
    const market = await db.prepare("SELECT winning_outcome_id, settle_reason FROM markets WHERE id = 'm1'").first<{ winning_outcome_id: string | null; settle_reason: string }>();
    expect(market?.winning_outcome_id).toBe('b');
    expect(market?.settle_reason).toBe('fallback');
  });

  test('first_match：按 sort_order 第一个命中', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, { settle_mode: 'first_match' });
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}', { sortOrder: 0, pool: 100 });
    await seedOutcome(db, 'm1', 'b', '{"kind":"never"}', { sortOrder: 1, pool: 100 });
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'm1', 'a', 100);

    const ok = await chooseAndSettle(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, ['a', 'b'], [V5_MODEL], '2026-11', NOW);
    expect(ok).toBe(true);
    const market = await db.prepare("SELECT winning_outcome_id FROM markets WHERE id = 'm1'").first<{ winning_outcome_id: string | null }>();
    expect(market?.winning_outcome_id).toBe('a');
    // b1 押 a 且 a 赢：won。
    const bet = await db.prepare("SELECT status FROM bets WHERE id = 'b1'").first<{ status: string }>();
    expect(bet?.status).toBe('won');
  });

  test('manual 市场：有命中也不自动结算', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db, { settle_mode: 'manual' });
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}');
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'm1', 'a', 100);

    const ok = await chooseAndSettle(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, ['a'], [V5_MODEL], '2026-11', NOW);
    expect(ok).toBe(false);
    const market = await db.prepare("SELECT status FROM markets WHERE id = 'm1'").first<{ status: string }>();
    expect(market?.status).toBe('open');
  });

  test('winPool = 0 → void 全员退款', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}', { seed: 100 });
    await seedOutcome(db, 'm1', 'b', '{"kind":"never"}', { sortOrder: 1, pool: 200 });
    await seedUser(db, USER_KEY, 1000);
    await seedBet(db, 'b1', USER_KEY, 'm1', 'b', 100);

    const ok = await chooseAndSettle(env, (await db.prepare('SELECT * FROM markets WHERE id = ?').bind('m1').first<MarketRow>())!, ['a'], [V5_MODEL], '2026-11', NOW);
    expect(ok).toBe(true);
    const chips = (await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>())?.chips;
    expect(chips).toBe(1100); // 退款
    const market = await db.prepare("SELECT status, winning_outcome_id FROM markets WHERE id = 'm1'").first<{ status: string; winning_outcome_id: string | null }>();
    expect(market?.status).toBe('settled');
    expect(market?.winning_outcome_id).toBeNull();
  });
});
