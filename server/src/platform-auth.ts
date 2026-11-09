// 平台 JWT 验签：原生 WebCrypto 实现（workerd 的 node:crypto.verify 不接受 KeyObject，
// 不能用官方 SDK 的 server 模块，见 docs/workers-auth-reference.md）。
// claim 校验逻辑逐条复刻参考实现；JWKS 模块级缓存 + 未知 kid 冷却刷新。

const enc = new TextEncoder();

function b64uToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad base64url');
  const b = Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
  if (b64uFromBytes(b) !== s) throw new Error('non-canonical base64url');
  return b;
}

function b64uFromBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonPart(part: string): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b64uToBytes(part)),
  ) as Record<string, unknown>;
}

function checkUrl(
  htu: string,
  queryKeys: unknown,
  actualUrl: string,
  audience: string,
): string[] {
  if (typeof htu !== 'string' || htu.length > 16384) throw new Error('bad htu');
  if (/[^\x21-\x7e]|\\|#/.test(htu) || /%(?![0-9a-f]{2})/i.test(htu)) {
    throw new Error('bad htu chars');
  }

  const base = new URL(htu);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('bad htu url');
  }
  if (base.port && (Number(base.port) < 1 || Number(base.port) > 65535)) {
    throw new Error('bad htu port');
  }
  const rawPath = htu.match(/^https:\/\/[^/?#]*([^?#]*)/i)?.[1];
  if ((rawPath || '/') !== base.pathname) throw new Error('non-canonical htu path');
  if (base.searchParams.has('mini_app_token')) throw new Error('token in htu');
  if (!Array.isArray(queryKeys)) throw new Error('bad query_keys');

  const declared = new Set<string>();
  for (const k of queryKeys) {
    if (typeof k !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(k)) {
      throw new Error('bad query key');
    }
    if (k === 'mini_app_token' || declared.has(k)) throw new Error('bad query key');
    if (base.searchParams.has(k)) throw new Error('query key in htu');
    declared.add(k);
  }

  const actual = new URL(actualUrl);
  const aud = new URL(audience);
  if (actual.origin !== aud.origin || base.origin !== actual.origin) {
    throw new Error('origin mismatch');
  }
  if (actual.pathname !== base.pathname) throw new Error('path mismatch');
  if (actual.searchParams.has('mini_app_token')) throw new Error('token in url');

  const rawQuery = (s: string) => (s.indexOf('?') < 0 ? '' : s.slice(s.indexOf('?') + 1));
  const hq = rawQuery(htu);
  const aq = rawQuery(actualUrl);
  let extra = '';

  if (aq !== hq) {
    if (hq && !aq.startsWith(`${hq}&`)) throw new Error('query prefix mismatch');
    extra = hq ? aq.slice(hq.length + 1) : aq;
    if (!extra) throw new Error('empty extra query');
  }

  const sp = new URLSearchParams(extra);
  if (sp.toString() !== extra) throw new Error('non-canonical query');

  const seen = new Set<string>();
  for (const [k] of sp) {
    if (!declared.has(k) || seen.has(k)) {
      throw new Error('undeclared/duplicate query key');
    }
    seen.add(k);
  }
  return [...declared];
}

export interface PlatformIdentity {
  iss: string;
  aud: string;
  sub: string;
  app_id: string;
  version: string;
  channel: 'production' | 'sandbox';
  scopes: string[];
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  htm: string;
  htu: string;
  query_keys: string[];
  trust_level?: number;
}

export interface VerifyOptions {
  authorization: string;
  issuer: string;
  audience: string;
  appId: string;
  scope: 'network.request' | 'network.websocket';
  method: string;
  url: string;
  channel?: 'production' | 'sandbox';
  version?: string;
  now?: number;
  /** 测试或自定义 JWKS 来源时可注入；默认走 `${issuer}/mini-app-api/jwks`。 */
  resolveKey?: (kid: string) => Promise<JsonWebKey | null>;
}

// ---- JWKS 模块级缓存（免费版每请求 CPU 10 ms，不能每请求拉取）----

interface JwksState {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
  lastRefreshAttempt: number;
}

const jwksState: JwksState = { keys: new Map(), fetchedAt: 0, lastRefreshAttempt: 0 };
const JWKS_TTL_MS = 10 * 60_000;
const KID_REFRESH_COOLDOWN_MS = 60_000;

function validJwk(jwk: unknown): jwk is JsonWebKey {
  const j = jwk as Record<string, unknown> | null;
  return (
    typeof j === 'object' &&
    j !== null &&
    j.kty === 'EC' &&
    j.crv === 'P-256' &&
    (j.alg === undefined || j.alg === 'ES256') &&
    (j.use === undefined || j.use === 'sig') &&
    !('d' in j)
  );
}

/** kid = JWK 对应 SPKI DER 的 SHA-256 十六进制（不是 JWKS 里的任意字符串）。 */
export async function kidFromJwk(jwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const spki = (await crypto.subtle.exportKey('spki', key)) as ArrayBuffer;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)));
}

async function fetchJwks(issuer: string): Promise<Map<string, JsonWebKey>> {
  const res = await fetch(`${issuer}/mini-app-api/jwks`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const map = new Map<string, JsonWebKey>();
  if (Array.isArray(body.keys)) {
    for (const raw of body.keys) {
      if (!validJwk(raw)) continue;
      map.set(await kidFromJwk(raw), raw);
    }
  }
  return map;
}

async function refreshJwks(issuer: string, now: number): Promise<void> {
  if (now - jwksState.lastRefreshAttempt < KID_REFRESH_COOLDOWN_MS) return;
  jwksState.lastRefreshAttempt = now;
  try {
    jwksState.keys = await fetchJwks(issuer);
    jwksState.fetchedAt = now;
  } catch {
    // 拉取失败保留旧缓存，冷却期内不再重试。
  }
}

async function resolveKeyViaJwks(
  issuer: string,
  kid: string,
  now: number,
): Promise<JsonWebKey | null> {
  if (now - jwksState.fetchedAt > JWKS_TTL_MS || jwksState.keys.size === 0) {
    await refreshJwks(issuer, now);
  }
  if (!jwksState.keys.has(kid)) {
    // 未知 kid：冷却地刷新一次（平台可能刚轮换密钥）。
    await refreshJwks(issuer, now);
  }
  return jwksState.keys.get(kid) ?? null;
}

/** 仅供测试注入 JWKS（生产环境走网络拉取，Bun 测试无法访问平台 JWKS 端点）。 */
export function setJwksForTest(keys: Map<string, JsonWebKey>): void {
  jwksState.keys = keys;
  jwksState.fetchedAt = Date.now();
}

// ---- 验签主流程 ----

export async function verifyPlatformRequest(opts: VerifyOptions): Promise<PlatformIdentity> {
  const {
    authorization,
    issuer,
    audience,
    appId,
    scope,
    method,
    url,
    channel = 'production',
    version,
    now = Math.floor(Date.now() / 1000),
  } = opts;

  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new Error('bad authorization');
  }
  if (!['network.request', 'network.websocket'].includes(scope)) throw new Error('bad scope');
  if (!['production', 'sandbox'].includes(channel)) throw new Error('bad channel');
  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  if (!methods.includes(method)) throw new Error('bad method');

  const token = authorization.slice(7);
  if (token.length > 131079) throw new Error('token too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad jwt');

  const header = jsonPart(parts[0]!);
  const claims = jsonPart(parts[1]!) as Record<string, unknown>;

  if (header.alg !== 'ES256' || header.typ !== 'mini-app-access+jwt') {
    throw new Error('bad header');
  }
  if (header.jku || header.jwk || header.x5u || header.crit) {
    throw new Error('forbidden header');
  }

  let publicKey: JsonWebKey | null;
  if (opts.resolveKey) {
    publicKey = await opts.resolveKey(String(header.kid ?? ''));
  } else {
    publicKey = await resolveKeyViaJwks(issuer, String(header.kid ?? ''), now * 1000);
  }
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' || 'd' in publicKey) {
    throw new Error('bad jwk');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );

  const spki = (await crypto.subtle.exportKey('spki', key)) as ArrayBuffer;
  const kid = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)));
  if (header.kid !== kid) throw new Error('kid mismatch');

  const sig = b64uToBytes(String(parts[2]));
  if (sig.length !== 64) throw new Error('bad signature length');

  const okSig = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    sig,
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!okSig) throw new Error('bad signature');

  const isInt = (n: unknown) => Number.isSafeInteger(n);
  if (claims.iss !== issuer || claims.aud !== audience || claims.app_id !== appId) {
    throw new Error('claim mismatch');
  }
  if (claims.channel !== channel) throw new Error('env mismatch');
  if (typeof claims.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(claims.version)) {
    throw new Error('bad version');
  }
  if (version !== undefined && claims.version !== version) throw new Error('version mismatch');
  if (typeof claims.sub !== 'string' || !/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
    throw new Error('bad sub');
  }
  if (
    claims.trust_level !== undefined &&
    (!isInt(claims.trust_level) ||
      (claims.trust_level as number) < 0 ||
      (claims.trust_level as number) > 4)
  ) {
    throw new Error('bad trust_level');
  }
  if (!Array.isArray(claims.scopes) || claims.scopes.length !== 1 || claims.scopes[0] !== scope) {
    throw new Error('bad scopes');
  }
  if (![claims.iat, claims.nbf, claims.exp, now].every(isInt)) throw new Error('bad time');
  if ((claims.exp as number) <= (claims.iat as number) || (claims.exp as number) - (claims.iat as number) > 900) {
    throw new Error('bad lifetime');
  }
  if ((claims.iat as number) > now + 5 || (claims.nbf as number) > now + 5) {
    throw new Error('not yet valid');
  }
  if ((claims.nbf as number) > (claims.iat as number) || (claims.iat as number) - (claims.nbf as number) > 5) {
    throw new Error('bad nbf');
  }
  if ((claims.exp as number) <= now) throw new Error('expired');
  if (typeof claims.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(claims.jti)) {
    throw new Error('bad jti');
  }
  if (claims.htm !== method) throw new Error('method mismatch');
  if (typeof claims.htu !== 'string') throw new Error('bad htu');

  const queryKeys = checkUrl(claims.htu, claims.query_keys, url, audience);
  return { ...(claims as unknown as PlatformIdentity), query_keys: queryKeys };
}

/** 供调用方组装 user_key（契约：身份一律取 `(iss, sub)`）。 */
export function userKeyOf(identity: PlatformIdentity): string {
  return `${identity.iss}#${identity.sub}`;
}
