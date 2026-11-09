// 下注校验与幂等（契约 7.2 / 12 节）。
import { describe, expect, test } from 'bun:test';
import { validateBet, handlePlaceBet } from '../src/routes/bets';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';
import type { MarketRow } from '../src/types';

async function seedMarket(db: MemoryD1, overrides: Partial<MarketRow> = {}): Promise<void> {
  const now = Date.now();
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, condition_json, deadline, status, yes_pool, no_pool, seed_yes, seed_no, created_at, updated_at) " +
        "VALUES (?, 'T', '', '{}', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      overrides.id ?? 'm1',
      overrides.deadline ?? now + 86400_000,
      overrides.status ?? 'open',
      overrides.yes_pool ?? 0,
      overrides.no_pool ?? 0,
      overrides.seed_yes ?? 5000,
      overrides.seed_no ?? 5000,
      now,
      now,
    );
}

const ISS = 'https://linux.do';
const SUB = '10001';
const USER_KEY = `${ISS}#${SUB}`;

describe('validateBet（纯校验）', () => {
  const base = { side: 'yes' as const, amount: 100, confidence: 50 };
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
  test('side 非法', () => {
    expect(validateBet({ ...base, side: 'big' }, 1000, 10, 0.5).code).toBe('INVALID_SIDE');
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
      { marketId: 'm1', side: 'yes', amount: 100, confidence: 72, clientRequestId, ...body },
      now,
    );
  }

  test('下注成功：扣款、加池、写流水', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    const r = (await place(env, {})) as { betId: string; chips: number; market: { yesPool: number } };
    expect(r.betId).toMatch(/^b_/);
    expect(r.chips).toBe(900); // 初始 1000 - 100
    expect(r.market.yesPool).toBe(100);
    const ledger = await db.prepare("SELECT delta, reason FROM ledger WHERE reason = 'bet'").all<{ delta: number }>();
    expect(ledger.results).toHaveLength(1);
    expect(ledger.results[0]!.delta).toBe(-100);
  });

  test('幂等：同 clientRequestId 返回原结果，不重复扣款', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    const r1 = (await place(env, {})) as { betId: string };
    const r2 = (await place(env, {})) as { betId: string; chips: number; idempotent?: boolean };
    expect(r2.betId).toBe(r1.betId);
    expect(r2.chips).toBe(900);
    expect(r2.idempotent).toBe(true);
    const bets = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(bets?.n).toBe(1);
  });

  test('市场不存在 / 非开放 / 已截止', async () => {
    const { env, db } = makeEnv();
    await expect(place(env, {})).rejects.toThrow('NOT_FOUND');
    await seedMarket(db, { status: 'locked' });
    await expect(place(env, {})).rejects.toThrow('MARKET_NOT_OPEN');
    await seedMarket(db, { id: 'm2', deadline: now - 1 });
    await expect(
      handlePlaceBet(env, ISS, SUB, null, { marketId: 'm2', side: 'yes', amount: 100, confidence: 0, clientRequestId: 'r2' }, now),
    ).rejects.toThrow('MARKET_NOT_OPEN');
  });

  test('余额比例校验用服务端余额', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await expect(place(env, { amount: 501 })).rejects.toThrow('BET_TOO_LARGE');
  });

  test('最小额校验', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await expect(place(env, { amount: 5 })).rejects.toThrow('BET_TOO_SMALL');
  });

  test('身份取 (iss, sub)，不同用户互不干扰', async () => {
    const { env, db } = makeEnv();
    await seedMarket(db);
    await place(env, { clientRequestId: 'x1' });
    const r2 = (await handlePlaceBet(
      env,
      ISS,
      '10002',
      null,
      { marketId: 'm1', side: 'no', amount: 100, confidence: 10, clientRequestId: 'x1' },
      now,
    )) as { chips: number };
    // 新用户拿到初始 1000 再扣 100。
    expect(r2.chips).toBe(900);
    const bets = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(bets?.n).toBe(2);
    void USER_KEY;
  });
});
