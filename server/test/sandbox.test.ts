// 沙箱构建支持：channel=sandbox JWT 鉴权、身份隔离（iss#sandbox）、沙箱只读（SANDBOX_READONLY）。
import { describe, expect, test } from 'bun:test';
import { default as worker } from '../src/index';
import { kidFromJwk, setJwksForTest } from '../src/platform-auth';
import { handlePublicLeaderboard } from '../src/routes/public';
import { makeEnv } from './helpers/env';
import { MemoryD1 } from './helpers/d1';

const ISS = 'https://linux.do';
const AUD = 'https://whale.example.com';
const APP_ID = 'test-app-id';
const BASE = 'https://whale.example.com';
const NOW = Date.now();

interface KeyPair {
  privateKey: CryptoKey;
  jwk: JsonWebKey;
  kid: string;
}

async function makeKeypair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const kid = await kidFromJwk(jwk);
  return { privateKey: pair.privateKey, jwk, kid };
}

function b64u(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** 生成平台风格 token，channel 可指定 production / sandbox。 */
async function signToken(
  kp: KeyPair,
  opts: {
    channel: 'production' | 'sandbox';
    htm?: string;
    htuPath?: string;
    sub?: string;
  },
): Promise<string> {
  const header = { alg: 'ES256', typ: 'mini-app-access+jwt', kid: kp.kid };
  const claims = {
    iss: ISS,
    aud: AUD,
    app_id: APP_ID,
    channel: opts.channel,
    version: '1.0.0',
    sub: opts.sub ?? '12345',
    scopes: ['network.request'],
    iat: Math.floor(NOW / 1000),
    nbf: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 300,
    jti: `jti-${Math.random().toString(36).slice(2)}1234567890`,
    htm: opts.htm ?? 'GET',
    htu: `${BASE}${opts.htuPath ?? '/me'}`,
    query_keys: [],
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      kp.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${b64u(sig)}`;
}

function authRequest(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface ResBody {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

describe('sandbox JWT 鉴权', () => {
  test('sandbox token 访问 GET /me 返回 200', async () => {
    const kp = await makeKeypair();
    const { env } = makeEnv();
    // JWKS 模块级缓存注入测试公钥。
    setJwksForTest(new Map([[kp.kid, kp.jwk]]));

    const res = await worker.fetch(authRequest('GET', '/me', await signToken(kp, { channel: 'sandbox' })), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResBody;
    expect(body.ok).toBe(true);
  });

  test('production token 行为不变：GET /me 200，POST /me/claim 200', async () => {
    const kp = await makeKeypair();
    const { env } = makeEnv();
    setJwksForTest(new Map([[kp.kid, kp.jwk]]));

    const res = await worker.fetch(authRequest('GET', '/me', await signToken(kp, { channel: 'production' })), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResBody & { data?: { chips: number } };
    expect(body.ok).toBe(true);
    expect(body.data?.chips).toBe(1000);

    const claimRes = await worker.fetch(
      authRequest('POST', '/me/claim', await signToken(kp, { channel: 'production', htm: 'POST', htuPath: '/me/claim' })),
      env,
    );
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as ResBody;
    expect(claimBody.ok).toBe(true);
  });

  test('非法 token 统一 401，不回显原因', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(authRequest('GET', '/me', 'not-a-jwt'), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ResBody;
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });
});

describe('sandbox 只读', () => {
  test('sandbox POST /bets 返回 403 SANDBOX_READONLY', async () => {
    const kp = await makeKeypair();
    const { env, db } = makeEnv();
    setJwksForTest(new Map([[kp.kid, kp.jwk]]));
    await db.inner
      .prepare(
        "INSERT INTO markets (id, title, description, condition_json, deadline, status, created_at, updated_at) " +
          "VALUES ('m1', 'T', '', '{}', ?, 'open', ?, ?)",
      )
      .run(NOW + 86_400_000, NOW, NOW);

    const res = await worker.fetch(
      authRequest(
        'POST',
        '/bets',
        await signToken(kp, { channel: 'sandbox', htm: 'POST', htuPath: '/bets' }),
        { marketId: 'm1', side: 'yes', amount: 10, confidence: 0, clientRequestId: 'sb-1' },
      ),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ResBody;
    expect(body.error?.code).toBe('SANDBOX_READONLY');
    // 没有落库任何注单。
    const n = await db.prepare('SELECT COUNT(*) AS n FROM bets').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  test('sandbox POST /me/claim 返回 403 SANDBOX_READONLY', async () => {
    const kp = await makeKeypair();
    const { env } = makeEnv();
    setJwksForTest(new Map([[kp.kid, kp.jwk]]));

    const res = await worker.fetch(
      authRequest('POST', '/me/claim', await signToken(kp, { channel: 'sandbox', htm: 'POST', htuPath: '/me/claim' })),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ResBody;
    expect(body.error?.code).toBe('SANDBOX_READONLY');
  });

  test('sandbox GET /me/positions、/me/history、/me/rank 允许', async () => {
    const kp = await makeKeypair();
    const { env } = makeEnv();
    setJwksForTest(new Map([[kp.kid, kp.jwk]]));

    for (const path of ['/me/positions', '/me/history', '/me/rank']) {
      const res = await worker.fetch(
        authRequest('GET', path, await signToken(kp, { channel: 'sandbox', htuPath: path })),
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as ResBody;
      expect(body.ok).toBe(true);
    }
  });
});

describe('sandbox 身份隔离', () => {
  test('sandbox 用户 key 为 iss#sandbox#sub，与生产用户互不影响', async () => {
    const kp = await makeKeypair();
    const { env, db } = makeEnv();
    setJwksForTest(new Map([[kp.kid, kp.jwk]]));

    // 同一个 sub 的 sandbox 访问，落库的 user_key 应带 #sandbox 后缀 iss。
    const res = await worker.fetch(
      authRequest('GET', '/me', await signToken(kp, { channel: 'sandbox', sub: '20001' })),
      env,
    );
    expect(res.status).toBe(200);
    const row = await db
      .prepare('SELECT user_key FROM users WHERE user_key = ?')
      .bind(`${ISS}#sandbox#20001`)
      .first<{ user_key: string }>();
    expect(row?.user_key).toBe(`${ISS}#sandbox#20001`);
    // 生产 key 格式不受影响：不存在 `https://linux.do#20001` 用户。
    const prod = await db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE user_key = ?')
      .bind(`${ISS}#20001`)
      .first<{ n: number }>();
    expect(prod?.n).toBe(0);
  });
});

describe('排行榜过滤沙箱用户', () => {
  test('assets 与 accuracy 榜均不含 sandbox 用户，生产用户排名不受影响', async () => {
    const { env, db } = makeEnv();
    const prodKey = `${ISS}#10001`;
    const sbxKey = `${ISS}#sandbox#20001`;
    await db.inner
      .prepare('INSERT INTO users (user_key, chips, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(prodKey, 5000, NOW, NOW);
    await db.inner
      .prepare('INSERT INTO users (user_key, chips, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(sbxKey, 999_999, NOW, NOW);

    // season_stats：生产 4/5=0.8，sandbox 5/5=1.0，accuracy_min_samples 默认 5。
    await db.inner
      .prepare("INSERT INTO season_stats (season, user_key, start_chips, end_chips, staked, payout, correct, total, peak_chips) VALUES ('2026-11', ?, 1000, 1000, 100, 0, 4, 5, 1000)")
      .run(prodKey);
    await db.inner
      .prepare("INSERT INTO season_stats (season, user_key, start_chips, end_chips, staked, payout, correct, total, peak_chips) VALUES ('2026-11', ?, 1000, 1000, 100, 0, 5, 5, 1000)")
      .run(sbxKey);

    const assets = (await handlePublicLeaderboard(env, new URL(`${BASE}/public/leaderboard?type=assets`), NOW)) as {
      items: { displayName: string | null; chips: number }[];
    };
    expect(assets.items).toHaveLength(1);
    expect(assets.items[0]!.chips).toBe(5000);

    const accuracy = (await handlePublicLeaderboard(env, new URL(`${BASE}/public/leaderboard?type=accuracy`), NOW)) as {
      items: { displayName: string | null; accuracy: number }[];
    };
    expect(accuracy.items).toHaveLength(1);
    expect(accuracy.items[0]!.accuracy).toBe(0.8);
  });
});
