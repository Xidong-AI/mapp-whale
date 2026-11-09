// settleTick 容错：单个市场结算失败只记录，不阻塞后续市场。
import { describe, expect, test } from 'bun:test';
import { settleTick } from '../src/index';
import { makeEnv } from './helpers/env';
import { MemoryD1, type ShimStmtLike } from './helpers/d1';
import type { Env } from '../src/types';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const NOW = Date.now();

async function seedMarket(db: MemoryD1, id: string, deadline: number): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, condition_json, deadline, status, seed_yes, seed_no, created_at, updated_at) " +
        "VALUES (?, 'T', '', '{}', ?, 'open', 0, 0, ?, ?)",
    )
    .run(id, deadline, NOW, NOW);
}

async function seedUser(db: MemoryD1, userKey: string, chips: number): Promise<void> {
  await db.inner
    .prepare('INSERT INTO users (user_key, chips, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userKey, chips, NOW, NOW);
}

async function seedUserBet(db: MemoryD1, marketId: string, userKey: string, side: 'yes' | 'no', amount: number): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO bets (id, client_request_id, market_id, user_key, side, amount, confidence, status, payout, season, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 0, '2026-11', ?)",
    )
    .run(`b_${marketId}_${userKey}`, `req_${marketId}_${userKey}`, marketId, userKey, side, amount, NOW);
}

/** trg_bets_market_open 要求市场 open 且未过期，先建未来市场、插注单，再把 deadline 改为已过期。 */
async function seedExpiredMarketWithBet(
  db: MemoryD1,
  marketId: string,
  userKey: string,
  side: 'yes' | 'no',
  amount: number,
): Promise<void> {
  await seedMarket(db, marketId, NOW + 86_400_000);
  await seedUserBet(db, marketId, userKey, side, amount);
  await db.inner.prepare('UPDATE markets SET deadline = ? WHERE id = ?').run(NOW - 1, marketId);
}

function stubModelsFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ name: 'deepseek-chat' }] }), { status: 200 })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 包装 DB：抢占（SET status = 'settling'）指定市场时注入失败。 */
function dbFailingAcquire(inner: MemoryD1, failingMarketId: string): Env['DB'] {
  return {
    prepare(sql: string) {
      const stmt = inner.prepare(sql);
      if (sql.includes("SET status = 'settling'")) {
        const wrapped = {
          bind(...args: unknown[]) {
            if (args.includes(failingMarketId)) throw new Error('INJECTED_ACQUIRE_FAILURE');
            stmt.bind(...args);
            return wrapped;
          },
          run: () => stmt.run(),
          all: <T>() => stmt.all<T>(),
          first: <T>() => stmt.first<T>(),
        };
        return wrapped as unknown as ShimStmtLike;
      }
      return stmt;
    },
    batch: <T>(statements: ShimStmtLike[]) => inner.batch<T>(statements as never),
    exec: (sql: string) => inner.exec(sql),
  } as unknown as Env['DB'];
}

describe('settleTick 单市场失败不阻塞', () => {
  test('坏市场抢占时抛错，后续市场仍被结算', async () => {
    const { env, db } = makeEnv();
    await seedUser(db, USER_KEY, 1000);
    await seedExpiredMarketWithBet(db, 'm_ok', USER_KEY, 'no', 100);
    await seedMarket(db, 'm_bad', NOW - 1); // 无注单，仅用于在 acquire 阶段抛错

    const testEnv = { ...env, DB: dbFailingAcquire(db, 'm_bad') };

    const restore = stubModelsFetch();
    try {
      const result = await settleTick(testEnv);
      expect(result.checked).toBe(2);
      expect(result.settled).toBe(1); // 只有 m_ok 成功

      // 坏市场失败后保持 open，错误被记录而不中断循环。
      const bad = await db.prepare("SELECT status FROM markets WHERE id = 'm_bad'").first<{ status: string }>();
      expect(bad?.status).toBe('open');

      // 后续市场正常结算并派奖（deadline → no，no 方赢 payout = 100）。
      const ok = await db
        .prepare("SELECT status, outcome FROM markets WHERE id = 'm_ok'")
        .first<{ status: string; outcome: string }>();
      expect(ok?.status).toBe('settled');
      expect(ok?.outcome).toBe('no');
      const chips = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
      expect(chips?.chips).toBe(1100);
    } finally {
      restore();
    }
  });

  test('models fetch 失败时直接返回，不抛异常', async () => {
    const { env } = makeEnv();
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    try {
      const r = await settleTick(env);
      expect(r.settled).toBe(0);
      expect(r.checked).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
