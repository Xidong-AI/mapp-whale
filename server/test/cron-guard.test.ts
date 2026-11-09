// cron 与入口守卫：models_url 白名单、PLATFORM_AUDIENCE 缺失。
import { describe, expect, test } from 'bun:test';
import { settleTick, default as worker } from '../src/index';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const NOW = Date.now();

async function clearMarkets(db: MemoryD1): Promise<void> {
  await db.inner.prepare('DELETE FROM outcomes').run();
  await db.inner.prepare('DELETE FROM markets').run();
}

async function seedExpiredMarketWithBet(db: MemoryD1, marketId: string): Promise<void> {
  await db.inner
    .prepare(
      'INSERT INTO markets (id, title, description, deadline, status, settle_mode, fallback_outcome_id, winning_outcome_id, settled_at, settle_reason, created_at, updated_at) ' +
        "VALUES (?, 'T', '', ?, 'open', 'exclusive', 'b', NULL, NULL, NULL, ?, ?)",
    )
    .run(marketId, NOW + 86_400_000, NOW, NOW);
  for (const [i, oid] of ['a', 'b'].entries()) {
    await db.inner
      .prepare(
        'INSERT INTO outcomes (id, market_id, label, condition_json, pool, seed, sort_order, hit_count, first_seen_at, created_at) ' +
          "VALUES (?, ?, ?, '{\"kind\":\"never\"}', 0, 0, ?, 0, NULL, ?)",
      )
      .run(oid, marketId, oid.toUpperCase(), i, NOW);
  }
  await db.inner
    .prepare(
      'INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) ' +
        "VALUES (?, ?, ?, 'b', ?, 100, 0, 'open', 0, '2026-11', ?)",
    )
    .run(`b_${marketId}`, `req_${marketId}`, marketId, USER_KEY, NOW);
  await db.inner.prepare('UPDATE outcomes SET pool = 100 WHERE market_id = ? AND id = ?').run(marketId, 'b');
  await db.inner.prepare('UPDATE markets SET deadline = ? WHERE id = ?').run(NOW - 1, marketId);
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(calls: FetchCall[], respond: () => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('settleTick models_url 白名单', () => {
  test('非白名单 URL：不发起请求（不带 Authorization），不结算', async () => {
    for (const url of ['http://api.deepseek.com/models', 'https://evil.example.com/models', 'not-a-url']) {
      const { env, db } = makeEnv();
      await clearMarkets(db);
      await db.prepare("UPDATE config SET value = ? WHERE key = 'models_url'").bind(url).run();
      await seedExpiredMarketWithBet(db, 'm1');

      const calls: FetchCall[] = [];
      const restore = recordingFetch(calls, () => new Response('{}', { status: 200 }));
      try {
        const result = await settleTick(env);
        expect(calls).toHaveLength(0);
        expect(result.settled).toBe(0);
        expect(result.checked).toBe(0);
        const status = await db.prepare("SELECT status FROM markets WHERE id = 'm1'").first<{ status: string }>();
        expect(status?.status).toBe('open');
      } finally {
        restore();
      }
    }
  });

  test('白名单 URL：请求携带 Authorization，市场正常结算', async () => {
    const { env, db } = makeEnv();
    await clearMarkets(db);
    await seedExpiredMarketWithBet(db, 'm1');

    const calls: FetchCall[] = [];
    const restore = recordingFetch(calls, () =>
      new Response(JSON.stringify({ data: [{ name: 'deepseek-chat' }] }), { status: 200 }),
    );
    try {
      const result = await settleTick(env);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.deepseek.com/models');
      const headers = new Headers(calls[0]!.init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${env.DEEPSEEK_API_KEY}`);
      expect(result.settled).toBe(1);
      const market = await db
        .prepare("SELECT status, winning_outcome_id FROM markets WHERE id = 'm1'")
        .first<{ status: string; winning_outcome_id: string }>();
      expect(market?.status).toBe('settled');
      expect(market?.winning_outcome_id).toBe('b');
    } finally {
      restore();
    }
  });
});

describe('worker.fetch PLATFORM_AUDIENCE 缺失', () => {
  test('用户请求直接 500，不回退 url.origin', async () => {
    const { env } = makeEnv({ PLATFORM_AUDIENCE: undefined });
    const res = await worker.fetch(
      new Request('https://whale.example.com/me', { headers: { Authorization: 'Bearer whatever' } }),
      env,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL');
  });
});
