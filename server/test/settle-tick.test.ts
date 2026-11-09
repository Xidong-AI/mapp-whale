// settleTick 容错（多结果市场）：单个市场结算失败只记录，不阻塞后续市场；deadline 兜底结算。
import { describe, expect, test } from 'bun:test';
import { settleTick } from '../src/index';
import { makeEnv } from './helpers/env';
import { MemoryD1, type ShimStmtLike } from './helpers/d1';
import type { Env } from '../src/types';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const NOW = Date.now();

async function seedMarket(db: MemoryD1, id: string, deadline: number, settleMode = 'exclusive'): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at) " +
        "VALUES (?, 'T', '', ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)",
    )
    .run(id, deadline, settleMode, NOW, NOW);
}

async function seedOutcome(db: MemoryD1, marketId: string, id: string, conditionJson: string, sortOrder = 0): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0, ?, 0, NULL, ?)",
    )
    .run(id, marketId, `L_${id}`, conditionJson, sortOrder, NOW);
}

async function seedUser(db: MemoryD1, userKey: string, chips: number): Promise<void> {
  await db.inner
    .prepare('INSERT INTO users (user_key, chips, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userKey, chips, NOW, NOW);
}

/** trg_bets_market_open 要求市场 open 且未过期，先建未来市场、插注单，再把 deadline 改为已过期。 */
async function seedExpiredMarketWithBet(
  db: MemoryD1,
  marketId: string,
  userKey: string,
  outcomeId: string,
  amount: number,
): Promise<void> {
  await seedMarket(db, marketId, NOW + 86_400_000);
  await seedOutcome(db, marketId, outcomeId, '{"kind":"never"}');
  await db.inner
    .prepare(
      "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 0, '2026-11', ?)",
    )
    .run(`b_${marketId}_${userKey}`, `req_${marketId}_${userKey}`, marketId, outcomeId, userKey, amount, NOW);
  // 同步 outcome pool。
  await db.inner
    .prepare('UPDATE outcomes SET pool = pool + ? WHERE market_id = ? AND id = ?')
    .run(amount, marketId, outcomeId);
  await db.inner.prepare('UPDATE markets SET deadline = ? WHERE id = ?').run(NOW - 1, marketId);
}

function stubModelsFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: '1', name: 'deepseek-chat' }] }), { status: 200 })) as unknown as typeof fetch;
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
  test('坏市场抢占时抛错，后续市场仍被结算（deadline → fallback 退款）', async () => {
    const { env, db } = makeEnv();
    await seedUser(db, USER_KEY, 1000);
    // m_ok：过期无 fallback → void 退款（exclusive，零命中已截止，无 fallback → void）。
    await seedExpiredMarketWithBet(db, 'm_ok', USER_KEY, 'a', 100);
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

      // m_ok：无 fallback → void 全额退款。
      const ok = await db
        .prepare("SELECT status, winning_outcome_id FROM markets WHERE id = 'm_ok'")
        .first<{ status: string; winning_outcome_id: string | null }>();
      expect(ok?.status).toBe('settled');
      expect(ok?.winning_outcome_id).toBeNull();
      const chips = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
      expect(chips?.chips).toBe(1100); // 100 退款
    } finally {
      restore();
    }
  });

  test('deadline 到期有 fallback → 按 fallback 结算派奖', async () => {
    const { env, db } = makeEnv();
    await seedUser(db, USER_KEY, 1000);
    await seedMarket(db, 'm1', NOW + 86_400_000, 'exclusive');
    await db.inner.prepare("UPDATE markets SET fallback_outcome_id = 'a' WHERE id = 'm1'").run();
    await seedOutcome(db, 'm1', 'a', '{"kind":"never"}');
    await seedOutcome(db, 'm1', 'b', '{"kind":"never"}', 1);
    await db.inner
      .prepare(
        "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) " +
          "VALUES ('b1', 'r1', 'm1', 'a', ?, 100, 0, 'open', 0, '2026-11', ?)",
      )
      .run(USER_KEY, NOW);
    await db.inner.prepare("UPDATE outcomes SET pool = pool + 100 WHERE market_id = 'm1' AND id = 'a'").run();
    await db.inner.prepare('UPDATE markets SET deadline = ? WHERE id = ?').run(NOW - 1, 'm1');

    const restore = stubModelsFetch();
    try {
      const r = await settleTick(env);
      expect(r.settled).toBe(1);
      // a 是 fallback 且 b1 押 a：total = 100 → payout = 100（钱回到原处，数字不变）。
      const chips = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
      expect(chips?.chips).toBe(1100);
      const market = await db.prepare("SELECT status, winning_outcome_id, settle_reason FROM markets WHERE id = 'm1'").first<{ status: string; winning_outcome_id: string | null; settle_reason: string }>();
      expect(market?.status).toBe('settled');
      expect(market?.winning_outcome_id).toBe('a');
      expect(market?.settle_reason).toBe('fallback');
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

  test('连续 poll_confirmations 次命中触发 exclusive 自动结算', async () => {
    const { env, db } = makeEnv();
    await seedUser(db, USER_KEY, 1000);
    await seedMarket(db, 'm1', NOW + 86_400_000);
    // hit_count 已有 1 次历史命中；本轮 fetch 返回 V5 → 达到 2 次。
    await seedOutcome(db, 'm1', 'a', '{"kind":"name_regex","regex":"DeepSeek[- ]?V5","flags":"i"}');
    await db.inner.prepare("UPDATE outcomes SET hit_count = 1 WHERE market_id = 'm1' AND id = 'a'").run();
    await db.inner
      .prepare(
        "INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) " +
          "VALUES ('b1', 'r1', 'm1', 'a', ?, 100, 0, 'open', 0, '2026-11', ?)",
      )
      .run(USER_KEY, NOW);
    await db.inner.prepare("UPDATE outcomes SET pool = pool + 100 WHERE market_id = 'm1' AND id = 'a'").run();

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: '1', name: 'DeepSeek-V5' }] }), { status: 200 })) as unknown as typeof fetch;
    try {
      const r = await settleTick(env);
      expect(r.settled).toBe(1);
      // total = 100，winPool = 100 → payout = 100。
      const chips = await db.prepare('SELECT chips FROM users WHERE user_key = ?').bind(USER_KEY).first<{ chips: number }>();
      expect(chips?.chips).toBe(1100);
      const market = await db.prepare("SELECT status, winning_outcome_id FROM markets WHERE id = 'm1'").first<{ status: string; winning_outcome_id: string | null }>();
      expect(market?.status).toBe('settled');
      expect(market?.winning_outcome_id).toBe('a');
    } finally {
      globalThis.fetch = original;
    }
  });
});
