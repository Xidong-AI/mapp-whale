// cron 与入口守卫：models_url 白名单（非白名单不带 Authorization、不结算）、
// PLATFORM_AUDIENCE 缺失返回 500、field_threshold 多模型命中。
import { describe, expect, test } from 'bun:test';
import { settleTick, default as worker } from '../src/index';
import { evaluateCondition, type ModelInfo } from '../src/settle';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';

const ISS = 'https://linux.do';
const USER_KEY = `${ISS}#10001`;
const NOW = Date.now();

/** trg_bets_market_open 要求市场 open 且未过期，先建未来市场、插注单，再把 deadline 改为已过期。 */
async function seedExpiredMarketWithBet(
  db: MemoryD1,
  marketId: string,
  conditionJson: string,
): Promise<void> {
  await db.inner
    .prepare(
      "INSERT INTO markets (id, title, description, condition_json, deadline, status, seed_yes, seed_no, created_at, updated_at) " +
        "VALUES (?, 'T', '', ?, ?, 'open', 0, 0, ?, ?)",
    )
    .run(marketId, conditionJson, NOW + 86_400_000, NOW, NOW);
  await db.inner
    .prepare(
      "INSERT INTO bets (id, client_request_id, market_id, user_key, side, amount, confidence, status, payout, season, created_at) " +
        "VALUES (?, ?, ?, ?, 'yes', 100, 0, 'open', 0, '2026-11', ?)",
    )
    .run(`b_${marketId}`, `req_${marketId}`, marketId, USER_KEY, NOW);
  await db.inner.prepare('UPDATE markets SET deadline = ? WHERE id = ?').run(NOW - 1, marketId);
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** 记录 fetch 调用的 url 与 headers。 */
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
      await db.prepare("UPDATE config SET value = ? WHERE key = 'models_url'").bind(url).run();
      await seedExpiredMarketWithBet(db, 'm1', '{}');

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
    await seedExpiredMarketWithBet(db, 'm1', '{}');

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
      const status = await db.prepare("SELECT status FROM markets WHERE id = 'm1'").first<{ status: string }>();
      expect(status?.status).toBe('settled');
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

describe('evaluateCondition field_threshold 多模型命中', () => {
  test('第一个命中名字的模型字段不满足时，后续模型满足即命中', () => {
    const models: ModelInfo[] = [
      { name: 'deepseek-v5', context_window: 100 },
      { name: 'deepseek-v6', context_window: 2097152 },
    ];
    const condition = {
      kind: 'field_threshold' as const,
      targetNameRegex: 'deepseek-v\\d',
      field: 'context_window',
      op: '>=' as const,
      value: 1000000,
    };
    expect(evaluateCondition(condition, models)).toBe(true);
  });

  test('所有命中名字的模型字段都不满足时不命中', () => {
    const models: ModelInfo[] = [
      { name: 'deepseek-v5', context_window: 100 },
      { name: 'deepseek-v6', context_window: 200 },
    ];
    const condition = {
      kind: 'field_threshold' as const,
      targetNameRegex: 'deepseek-v\\d',
      field: 'context_window',
      op: '>=' as const,
      value: 1000000,
    };
    expect(evaluateCondition(condition, models)).toBe(false);
  });

  test('字段类型非数字的模型被跳过，不影响后续模型判定', () => {
    const models: ModelInfo[] = [
      { name: 'deepseek-v5', context_window: '2097152' } as unknown as ModelInfo,
      { name: 'deepseek-v6', context_window: 2097152 },
    ];
    const condition = {
      kind: 'field_threshold' as const,
      targetNameRegex: 'deepseek-v\\d',
      field: 'context_window',
      op: '>=' as const,
      value: 1000000,
    };
    expect(evaluateCondition(condition, models)).toBe(true);
  });
});
