# Workers 平台验签参考（后端实现必读）

来源：@librarian 于 2026-11-09 在 `wrangler 4.158.0 / workerd 1.20261104.1` 实测。

## 结论

- Workers 的 `nodejs_compat` 支持 `createPublicKey(JWK)`、`Buffer` 和 ES256 验签。
- 但当前 workerd 的 `node:crypto.verify()` **不接受 options 里的 `KeyObject`**（Node 接受）。
- 官方 `@discourse-mini-app/sdk/server` 正好这样调用，所以**不能原样运行**，会表现为 `PlatformAuthError`。
- 后端使用**原生 WebCrypto** 复刻 claim 校验，零依赖，CPU 开销低。

## 平台 JWT 校验要点

必须校验：`iss`、`aud`、`app_id`、`channel`、`scopes`、`htm`、`htu`、`query_keys`、`nbf`、`exp`、`iat`、`sub`、`jti`、`version`，可选 `trust_level`。

- `htu` 是 manifest 声明的固定端点 URL；实际 URL 的 path 必须一致，query 必须以 `htu` 的固定 query 为前缀，额外 query key 必须全部在 `query_keys` 里，且不能重复、不能含 `mini_app_token`。
- `audience` 用固定 `API_ORIGIN`，不要信任请求的 `Host` / `X-Forwarded-*`。
- JWKS 固定从 `${PLATFORM_ISSUER}/mini-app-api/jwks` 获取，模块作用域缓存；未知 `kid` 时有冷却地刷新一次。
- JWK 必须满足 `kty=EC`、`crv=P-256`、`alg=ES256`、`use=sig`、无 `d`。
- `kid` 是 SPKI DER 的 SHA-256 十六进制，不是 JWKS 里任意字符串。

## 参考实现（原生 WebCrypto）

```ts
const enc = new TextEncoder();

function b64uToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("bad base64url");
  const b = Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0)
  );
  if (b64uFromBytes(b) !== s) throw new Error("non-canonical base64url");
  return b;
}

function b64uFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonPart(part: string): any {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64uToBytes(part)));
}

function checkUrl(htu: string, queryKeys: string[], actualUrl: string, audience: string) {
  if (typeof htu !== "string" || htu.length > 16384) throw new Error("bad htu");
  if (/[^\x21-\x7e]|\\|#/.test(htu) || /%(?![0-9a-f]{2})/i.test(htu)) {
    throw new Error("bad htu chars");
  }

  const base = new URL(htu);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("bad htu url");
  if (base.port && (Number(base.port) < 1 || Number(base.port) > 65535)) {
    throw new Error("bad htu port");
  }
  const rawPath = htu.match(/^https:\/\/[^/?#]*([^?#]*)/i)?.[1];
  if ((rawPath || "/") !== base.pathname) throw new Error("non-canonical htu path");
  if (base.searchParams.has("mini_app_token")) throw new Error("token in htu");
  if (!Array.isArray(queryKeys)) throw new Error("bad query_keys");

  const declared = new Set<string>();
  for (const k of queryKeys) {
    if (typeof k !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(k)) {
      throw new Error("bad query key");
    }
    if (k === "mini_app_token" || declared.has(k)) throw new Error("bad query key");
    if (base.searchParams.has(k)) throw new Error("query key in htu");
    declared.add(k);
  }

  const actual = new URL(String(actualUrl));
  const aud = new URL(audience);
  if (actual.origin !== aud.origin || base.origin !== actual.origin) throw new Error("origin mismatch");
  if (actual.pathname !== base.pathname) throw new Error("path mismatch");
  if (actual.searchParams.has("mini_app_token")) throw new Error("token in url");

  const rawQuery = (s: string) => (s.indexOf("?") < 0 ? "" : s.slice(s.indexOf("?") + 1));
  const hq = rawQuery(htu);
  const aq = rawQuery(String(actualUrl));
  let extra = "";

  if (aq !== hq) {
    if (hq && !aq.startsWith(`${hq}&`)) throw new Error("query prefix mismatch");
    extra = hq ? aq.slice(hq.length + 1) : aq;
    if (!extra) throw new Error("empty extra query");
  }

  const sp = new URLSearchParams(extra);
  if (sp.toString() !== extra) throw new Error("non-canonical query");

  const seen = new Set<string>();
  for (const [k] of sp) {
    if (!declared.has(k) || seen.has(k)) throw new Error("undeclared/duplicate query key");
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
  channel: "production" | "sandbox";
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

export async function verifyPlatformRequest(opts: {
  authorization: string;
  publicKey: JsonWebKey;
  issuer: string;
  audience: string;
  appId: string;
  scope: "network.request" | "network.websocket";
  method: string;
  url: string;
  channel?: "production" | "sandbox";
  version?: string;
  now?: number;
}): Promise<PlatformIdentity> {
  const {
    authorization,
    publicKey,
    issuer,
    audience,
    appId,
    scope,
    method,
    url,
    channel = "production",
    version,
    now = Math.floor(Date.now() / 1000),
  } = opts;

  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Error("bad authorization");
  }
  if (!["network.request", "network.websocket"].includes(scope)) throw new Error("bad scope");
  if (!["production", "sandbox"].includes(channel)) throw new Error("bad channel");
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  if (!methods.includes(method)) throw new Error("bad method");

  const token = authorization.slice(7);
  if (token.length > 131079) throw new Error("token too long");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("bad jwt");

  const header = jsonPart(parts[0]);
  const claims = jsonPart(parts[1]);

  if (header.alg !== "ES256" || header.typ !== "mini-app-access+jwt") throw new Error("bad header");
  if (header.jku || header.jwk || header.x5u || header.crit) throw new Error("forbidden header");
  if (!publicKey || publicKey.kty !== "EC" || publicKey.crv !== "P-256" || (publicKey as any).d) {
    throw new Error("bad jwk");
  }

  const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);

  const spki = await crypto.subtle.exportKey("spki", key);
  const kid = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
  if (header.kid !== kid) throw new Error("kid mismatch");

  const sig = b64uToBytes(parts[2]);
  if (sig.length !== 64) throw new Error("bad signature length");

  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    enc.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new Error("bad signature");

  const isInt = (n: unknown) => Number.isSafeInteger(n);
  if (claims.iss !== issuer || claims.aud !== audience || claims.app_id !== appId) {
    throw new Error("claim mismatch");
  }
  if (claims.channel !== channel) throw new Error("env mismatch");
  if (typeof claims.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(claims.version)) {
    throw new Error("bad version");
  }
  if (version !== undefined && claims.version !== version) throw new Error("version mismatch");
  if (typeof claims.sub !== "string" || !/^[1-9][0-9]{0,19}$/.test(claims.sub)) throw new Error("bad sub");
  if (
    claims.trust_level !== undefined &&
    (!isInt(claims.trust_level) || claims.trust_level < 0 || claims.trust_level > 4)
  ) {
    throw new Error("bad trust_level");
  }
  if (!Array.isArray(claims.scopes) || claims.scopes.length !== 1 || claims.scopes[0] !== scope) {
    throw new Error("bad scopes");
  }
  if (![claims.iat, claims.nbf, claims.exp, now].every(isInt)) throw new Error("bad time");
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 900) throw new Error("bad lifetime");
  if (claims.iat > now + 5 || claims.nbf > now + 5) throw new Error("not yet valid");
  if (claims.nbf > claims.iat || claims.iat - claims.nbf > 5) throw new Error("bad nbf");
  if (claims.exp <= now) throw new Error("expired");
  if (typeof claims.jti !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claims.jti)) {
    throw new Error("bad jti");
  }
  if (claims.htm !== method) throw new Error("method mismatch");
  if (typeof claims.htu !== "string") throw new Error("bad htu");

  const queryKeys = checkUrl(claims.htu, claims.query_keys, url, audience);
  return { ...claims, query_keys: queryKeys };
}
```

## CORS 处理

区分两类 `OPTIONS`：

```ts
const isPreflight =
  request.method === "OPTIONS" && request.headers.has("Access-Control-Request-Method");
```

- 预检（无 `Authorization`）：直接 204 + CORS 头，不验签。
- 业务请求（含声明为 `OPTIONS` 的业务调用）：正常验签。
- 所有响应（含 401/403/500）都加 CORS 头，否则浏览器只显示网络错误。
- `Access-Control-Allow-Origin` 用精确 origin，加 `Vary: Origin`。

## wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mapp-whale",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-09",
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "whale",
      "database_id": "<DATABASE_ID>",
      "migrations_dir": "migrations"
    }
  ],
  "triggers": { "crons": ["*/10 * * * *", "10 0 1 * *"] }
}
```

`compatibility_date >= 2026-08-04` 时 `nodejs_compat` 默认开启，不需要 `compatibility_flags`。

## D1 命令

```sh
npx wrangler d1 create whale
npx wrangler d1 migrations create whale init
npx wrangler d1 migrations apply whale --local
npx wrangler d1 migrations apply whale --remote
```

## 本地测试 Cron

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*"
```

## 注意

- 免费版每请求 CPU 10 ms。JWKS 必须模块级缓存，不要每请求拉取。
- `wrangler secret put DEEPSEEK_API_KEY` / `ADMIN_TOKEN` / `PLATFORM_ISSUER` / `PLATFORM_APP_ID`；本地用 `.dev.vars`，不要提交。
- Cron 中 `fetch` 加 `AbortSignal.timeout(10_000)`，失败只记录，不结算。
