// 平台 JWT 验签（WebCrypto 自签 token，无外部服务）。
import { describe, expect, test } from 'bun:test';
import { verifyPlatformRequest, kidFromJwk, type PlatformIdentity } from '../src/platform-auth';

const ISS = 'https://linux.do';
const AUD = 'https://whale.example.com';
const APP_ID = 'test-app-id';
const URL_ME = 'https://whale.example.com/me';
const NOW = 1_760_000_000;

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

async function signToken(
  kp: KeyPair,
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = { alg: 'ES256', typ: 'mini-app-access+jwt', kid: kp.kid, ...headerOverrides };
  const claims: Record<string, unknown> = {
    iss: ISS,
    aud: AUD,
    app_id: APP_ID,
    channel: 'production',
    version: '1.0.0',
    sub: '12345',
    scopes: ['network.request'],
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: 'jti-1234567890abcdef',
    htm: 'GET',
    htu: URL_ME,
    query_keys: [],
    ...claimOverrides,
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

const resolveTestKey = (kp: KeyPair) => async (k: string): Promise<JsonWebKey | null> =>
  k === kp.kid ? kp.jwk : null;

async function verify(
  token: string,
  kp: KeyPair,
  opts: Partial<{ method: string; url: string; now: number }> = {},
): Promise<PlatformIdentity> {
  return verifyPlatformRequest({
    authorization: `Bearer ${token}`,
    issuer: ISS,
    audience: AUD,
    appId: APP_ID,
    scope: 'network.request',
    method: opts.method ?? 'GET',
    url: opts.url ?? URL_ME,
    now: opts.now ?? NOW,
    resolveKey: resolveTestKey(kp),
  });
}

describe('verifyPlatformRequest', () => {
  test('合法 token 通过', async () => {
    const kp = await makeKeypair();
    const identity = await verify(await signToken(kp), kp);
    expect(identity.sub).toBe('12345');
    expect(identity.iss).toBe(ISS);
    expect(identity.query_keys).toEqual([]);
  });

  test('篡改签名拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp);
    const parts = token.split('.');
    const b64 = parts[2]!.replaceAll('-', '+').replaceAll('_', '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const sigBytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    sigBytes[0] = (sigBytes[0]! ^ 0xff) & 0xff;
    const bad = `${parts[0]}.${parts[1]}.${b64u(sigBytes)}`;
    await expect(verify(bad, kp)).rejects.toThrow();
  });

  test('未知 kid 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp);
    await expect(
      verifyPlatformRequest({
        authorization: `Bearer ${token}`,
        issuer: ISS,
        audience: AUD,
        appId: APP_ID,
        scope: 'network.request',
        method: 'GET',
        url: URL_ME,
        now: NOW,
        resolveKey: async () => null,
      }),
    ).rejects.toThrow();
  });

  test('错误 aud 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { aud: 'https://evil.example.com' });
    await expect(verify(token, kp)).rejects.toThrow('claim mismatch');
  });

  test('错误 app_id 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { app_id: 'other-app' });
    await expect(verify(token, kp)).rejects.toThrow('claim mismatch');
  });

  test('错误 iss 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { iss: 'https://evil.example.com' });
    await expect(verify(token, kp)).rejects.toThrow('claim mismatch');
  });

  test('错误 htm 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp);
    await expect(verify(token, kp, { method: 'POST' })).rejects.toThrow('method mismatch');
  });

  test('错误 htu 路径拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp);
    await expect(verify(token, kp, { url: 'https://whale.example.com/me/claim' })).rejects.toThrow();
  });

  test('未声明的动态 query key 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp);
    await expect(verify(token, kp, { url: `${URL_ME}?limit=20` })).rejects.toThrow();
  });

  test('声明的动态 query key 通过；重复 key 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { query_keys: ['limit', 'cursor'] });
    const identity = await verify(token, kp, { url: `${URL_ME}?limit=20&cursor=abc` });
    expect([...identity.query_keys].sort()).toEqual(['cursor', 'limit']);

    const token2 = await signToken(kp, { query_keys: ['limit'] });
    await expect(verify(token2, kp, { url: `${URL_ME}?limit=20&limit=30` })).rejects.toThrow();
  });

  test('htu 中包含 mini_app_token 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, {
      htu: `${URL_ME}?mini_app_token=x`,
      query_keys: ['mini_app_token'],
    });
    await expect(verify(token, kp)).rejects.toThrow();
  });

  test('过期 token 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { iat: NOW - 800, nbf: NOW - 800, exp: NOW - 10 });
    await expect(verify(token, kp)).rejects.toThrow('expired');
  });

  test('nbf 未来时间拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { iat: NOW + 100, nbf: NOW + 100, exp: NOW + 400 });
    await expect(verify(token, kp)).rejects.toThrow();
  });

  test('算法混淆（HS256 / none）拒绝', async () => {
    const kp = await makeKeypair();
    const hs256 = await signToken(kp, {}, { alg: 'HS256' });
    await expect(verify(hs256, kp)).rejects.toThrow('bad header');
    const none = await signToken(kp, {}, { alg: 'none' });
    await expect(verify(none, kp)).rejects.toThrow('bad header');
  });

  test('缺少 Bearer 前缀拒绝', async () => {
    await expect(
      verifyPlatformRequest({
        authorization: 'Basic abc',
        issuer: ISS,
        audience: AUD,
        appId: APP_ID,
        scope: 'network.request',
        method: 'GET',
        url: URL_ME,
        now: NOW,
        resolveKey: async () => null,
      }),
    ).rejects.toThrow('bad authorization');
  });

  test('scopes 不匹配拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { scopes: ['network.websocket'] });
    await expect(verify(token, kp)).rejects.toThrow('bad scopes');
  });

  test('lifetime 超过 900s 拒绝', async () => {
    const kp = await makeKeypair();
    const token = await signToken(kp, { exp: NOW + 901 });
    await expect(verify(token, kp)).rejects.toThrow('bad lifetime');
  });
});
