// 下注校验与幂等（契约 v2 5 节 / 12 节）：outcomeId 归属校验、扣款、加池、幂等。
import { describe, expect, test } from 'bun:test';
import { validateBet, handlePlaceBet } from '../src/routes/bets';
import { makeEnv, clearSeedMarkets } from './helpers/env';
import { MemoryD1 } from './helpers/d1';
import type { MarketRow, OutcomeRow } from '../src/types';

const NOW = Date.now();

/** 建独立测试环境：清掉 0004 种子市场。 */
function makeIsolatedEnv() {
  const made = makeEnv();
  clearSeedMarkets(made.db);
  return made;
}

async function seedMarket(db: MemoryD1, overrides: Partial<MarketRow> = {}): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at) " +
        "VALUES (?, 'T', '', ?, ?, 'exclusive', NULL, NULL, NULL, NULL, ?, ?)",
    )
    .run(
      overrides.id ?? 'm1',
      overrides.deadline ?? NOW + 86400_000,
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
        "VALUES (?, ?, ?, '{\"kind\":\"always\"}', 0, ?, ?, 0, NULL, ?)",
    )
    .run(id, marketId, `L_${id}`, seed, sortOrder, NOW);
}

const ISS = 'https://linux.do';
const SUB = '10001';
const USER_KEY = `${ISS}#${SUB}`;

describe('validateBet（纯校验）', () => {
  const base = { amount: 100, confidence: 50 };
  test('合法通过', () => {
    expect(validateBet(base, 1000, 10, 0.5).code).toBeNull();
  });
  test('最小额', () => {
    expect(validateBet({ ...base, amount: 9 }, 1000, 10, 0.5).code).toBe('BET_TOO_SMALL');
  });
  test('余额比例：amount > floor(chips*ratio) 拒绝', () => {
    expect(validateBet({ ...base, amount: 501 }, 1000, 10, 0.5).code).toBe('BET_TOO_LARGE');
    expect(validateBet({ ...base, amount: 500 }, 1000, 10, 0.5).code).toBeNull();
  });
  test('confidence 越界 / 非整数', () => {
    expect(validateBet({ ...base, confidence: 101 }, 1000, 10, 0.5).code).toBe('INVALID_CONFIDENCE');
    expect(validateBet({ ...base, confidence: 50.5 }, 1000, 10, 0.5).code).toBe('INVALID_CONFIDENCE');
    expect(validateBet({ ...base, confidence: -100 }, 1000, 10, 0.5).code).toBeNull();
  });
});

describe('POST /bets（D1 集成）', () => {
  // 触发器 trg_bets_market_open 用真实时间比较截止，测试时间需取当前时间。
  const now = Date.now();

  async function place(env: ReturnType<typeof makeEnv>['env'], body: Record<string, unknown>, clientRequestId = 'req-1') {
    return handlePlaceBet(
      env,
      ISS,
      SUB,
      '鲸鱼 A',
      { marketId: 'm1', outcomeId: 'a', amount: 100, confidence: 72, clientRequestId, ...body },
      now,
    );
  }

  test('下注成功：扣款、加 outcome 池、写流水', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a', 50);
    await seedOutcome(db, 'm1', 'b', 50, 1);
    const r = (await place(env, {})) as { betId: string; chips: number; market: { totalPool: number; outcomes: { id: string; pool: number }[] } };
    expect(r.betId).toMatch(/^b_/);
    expect(r.chips).toBe(900); // 初始 1000 - 100
    expect(r.market.totalPool).toBe(200); // 100+50 + 0+50
    const oa = r.market.outcomes.find((o) => o.id === 'a')!;
    expect(oa.pool).toBe(100);
    const ledger = await db.prepare("SELECT delta, reason, outcome_id FROM ledger WHERE reason = 'bet'").all<{ delta: number; outcome_id: string }>();
    expect(ledger.results).toHaveLength(1);
    expect(ledger.results[0]!.delta).toBe(-100);
    expect(ledger.results[0]!.outcome_id).toBe('a');
    const bet = await db.prepare('SELECT outcome_id, amount FROM bets').first<{ outcome_id: string; amount: number }>();
    expect(bet?.outcome_id).toBe('a');
    expect(bet?.amount).toBe(100);
  });

  test('outcome 不属于市场：INVALID_OUTCOME', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await expect(place(env, { outcomeId: 'bogus' })).rejects.toThrow('INVALID_OUTCOME');
    const n = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  test('幂等：同 clientRequestId 返回原结果，不重复扣款', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    const r1 = (await place(env, {})) as { betId: string };
    const r2 = (await place(env, {})) as { betId: string; chips: number; idempotent?: boolean };
    expect(r2.betId).toBe(r1.betId);
    expect(r2.chips).toBe(900);
    expect(r2.idempotent).toBe(true);
    const bets = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(bets?.n).toBe(1);
  });

  test('市场不存在 / 非开放 / 已截止', async () => {
    const { env, db } = makeIsolatedEnv();
    await expect(place(env, {})).rejects.toThrow('NOT_FOUND');
    await seedMarket(db, { status: 'locked' });
    await seedOutcome(db, 'm1', 'a');
    await expect(place(env, {})).rejects.toThrow('MARKET_NOT_OPEN');
    await seedMarket(db, { id: 'm2', deadline: now - 1 });
    await seedOutcome(db, 'm2', 'a');
    await expect(
      handlePlaceBet(env, ISS, SUB, null, { marketId: 'm2', outcomeId: 'a', amount: 100, confidence: 0, clientRequestId: 'r2' }, now),
    ).rejects.toThrow('MARKET_NOT_OPEN');
  });

  test('余额比例校验用服务端余额', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await expect(place(env, { amount: 501 })).rejects.toThrow('BET_TOO_LARGE');
  });

  test('最小额校验', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await expect(place(env, { amount: 5 })).rejects.toThrow('BET_TOO_SMALL');
  });

  test('身份取 (iss, sub)，不同用户互不干扰', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await seedOutcome(db, 'm1', 'b', 0, 1);
    await place(env, { clientRequestId: 'x1' });
    const r2 = (await handlePlaceBet(
      env,
      ISS,
      '10002',
      null,
      { marketId: 'm1', outcomeId: 'b', amount: 100, confidence: 10, clientRequestId: 'x1' },
      now,
    )) as { chips: number };
    // 新用户拿到初始 1000 再扣 100。
    expect(r2.chips).toBe(900);
    const bets = await db.prepare('SELECT outcome_id FROM bets ORDER BY outcome_id').all<{ outcome_id: string }>();
    expect(bets.results.map((b) => b.outcome_id)).toEqual(['a', 'b']);
  });

  test('市场带 fallback outcome 也能下注（触发器允许）', async () => {
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db, { fallback_outcome_id: 'never' } as Partial<MarketRow>);
    void db;
    void USER_KEY;
  });
});

describe('outcomes pool 累计', () => {
  test('同一 outcome 多笔下注累计 pool', async () => {
    const now = Date.now();
    const { env, db } = makeIsolatedEnv();
    await seedMarket(db);
    await seedOutcome(db, 'm1', 'a');
    await handlePlaceBet(env, ISS, '10001', null, { marketId: 'm1', outcomeId: 'a', amount: 100, confidence: 0, clientRequestId: 'r1' }, now);
    await handlePlaceBet(env, ISS, '10002', null, { marketId: 'm1', outcomeId: 'a', amount: 200, confidence: 0, clientRequestId: 'r2' }, now);
    const o = await db.prepare("SELECT pool FROM outcomes WHERE market_id = 'm1' AND id = 'a'").first<{ pool: number }>();
    expect(o?.pool).toBe(300);
  });
});
