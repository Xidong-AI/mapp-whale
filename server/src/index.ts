// 预言鲸后端入口：fetch 路由分派 + Cron（结算 / 月度归档维护）。

import type { Env, MarketRow } from './types';
import { parseAllowedOrigins, corsHeaders, isPreflight, preflightResponse, okResponse, errorResponse, type CorsContext } from './cors';
import { verifyPlatformRequest, userKeyOf, type PlatformIdentity } from './platform-auth';
import { getConfig, shanghaiMonth, setConfigValue, writeAudit } from './db';
import { evaluateCondition, settleMarketDb, acquireForSettlement, retryStuckSettling, type MarketCondition, type ModelInfo } from './settle';
import { handlePublicConfig, handlePublicMarkets, handlePublicLeaderboard } from './routes/public';
import { handleMe, handleClaim, handlePositions, handleHistory, handleRank } from './routes/me';
import { handlePlaceBet } from './routes/bets';
import {
  requireAdmin,
  runMaintenance,
  handleAdminGetConfig,
  handleAdminPatchConfig,
  handleAdminListMarkets,
  handleAdminCreateMarket,
  handleAdminPatchMarket,
  handleAdminSettle,
  handleAdminReopen,
  handleAdminStats,
  handleAdminMaintenance,
  handleAdminAudit,
} from './routes/admin';

const MONTHLY_CRON = '10 0 1 * *';

// ---- 错误码到 HTTP 状态 ----

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_CONFIG: 400,
  MARKET_NOT_OPEN: 409,
  BET_TOO_SMALL: 400,
  BET_TOO_LARGE: 400,
  INVALID_SIDE: 400,
  INVALID_CONFIDENCE: 400,
  INSUFFICIENT_CHIPS: 400,
  CONFLICT: 409,
  SANDBOX_READONLY: 403,
};

function codeOf(e: unknown): { status: number; code: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (STATUS_BY_CODE[msg]) return { status: STATUS_BY_CODE[msg]!, code: msg };
  return { status: 500, code: 'INTERNAL' };
}

// ---- 平台验签封装 ----

async function authenticate(request: Request, env: Env, url: URL): Promise<PlatformIdentity> {
  // audience 必须显式配置，缺失时视为服务端配置错误（500），不回退 url.origin。
  if (!env.PLATFORM_AUDIENCE) {
    throw new Error('PLATFORM_AUDIENCE_MISSING');
  }
  // 依次尝试 production 与 sandbox channel，任一验签成功即返回 identity。
  const channels = ['production', 'sandbox'] as const;
  for (const channel of channels) {
    try {
      return await verifyPlatformRequest({
        authorization: request.headers.get('Authorization') ?? '',
        issuer: env.PLATFORM_ISSUER,
        audience: env.PLATFORM_AUDIENCE,
        appId: env.PLATFORM_APP_ID,
        scope: 'network.request',
        method: request.method,
        url: url.toString(),
        channel,
      });
    } catch {
      // 尝试下一个 channel；全部失败时统一 401。
    }
  }
  // 不区分具体失败原因，统一 401，不回显 token 信息。
  throw new Error('UNAUTHORIZED');
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---- fetch ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ctx: CorsContext = {
      origin: request.headers.get('Origin'),
      allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    };
    const now = Date.now();

    // 预检放行，不验签。
    if (isPreflight(request)) return preflightResponse(ctx);

    try {
      return await route(request, env, url, ctx, now);
    } catch (e) {
      const { status, code } = codeOf(e);
      if (status === 500) {
        // 不输出 Authorization / token / 密钥等敏感信息。
        console.error(`[whale] internal error: ${code}`);
      }
      return errorResponse(status, code, code === 'INTERNAL' ? 'internal error' : code, ctx);
    }
  },

  // ---- Cron（契约第 9、11 节）----
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === MONTHLY_CRON) {
      ctx.waitUntil(monthlyArchive(env));
    } else {
      ctx.waitUntil(settleTick(env));
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  url: URL,
  ctx: CorsContext,
  now: number,
): Promise<Response> {
  const path = url.pathname;

  // 公开接口
  if (request.method === 'GET' && path === '/public/config') {
    return okResponse(await handlePublicConfig(env, now), ctx);
  }
  if (request.method === 'GET' && path === '/public/markets') {
    return okResponse(await handlePublicMarkets(env, url, now), ctx);
  }
  if (request.method === 'GET' && path === '/public/leaderboard') {
    return okResponse(await handlePublicLeaderboard(env, url, now), ctx);
  }

  // 用户接口：非预检请求必须验签
  const userPaths: Record<string, [string, string]> = {
    '/me': ['GET', 'me'],
    '/me/claim': ['POST', 'claim'],
    '/me/positions': ['GET', 'positions'],
    '/me/history': ['GET', 'history'],
    '/me/rank': ['GET', 'rank'],
    '/bets': ['POST', 'bets'],
  };
  const userRoute = userPaths[path];
  if (userRoute && request.method === userRoute[0]) {
    const identity = await authenticate(request, env, url);

    // 沙箱只读：除 /admin 外，写方法一律 403（提审文档约定，不写正式彩池/余额/排行榜）。
    if (
      identity.channel === 'sandbox' &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !path.startsWith('/admin')
    ) {
      throw new Error('SANDBOX_READONLY');
    }

    // 沙箱身份隔离：iss 加 #sandbox 后缀，userKey 与生产用户天然隔离。
    // 生产用户的 key 格式保持不变。
    const sandboxedIss = identity.channel === 'sandbox' ? `${identity.iss}#sandbox` : identity.iss;

    const userKey = userKeyOf({ ...identity, iss: sandboxedIss });
    const body = request.method === 'POST' ? await readJson(request) : {};
    const displayName = body['displayName'];
    switch (userRoute[1]) {
      case 'me':
        return okResponse(await handleMe(env, userKey, displayName, now), ctx);
      case 'claim':
        return okResponse(await handleClaim(env, userKey, displayName, now), ctx);
      case 'positions':
        return okResponse(await handlePositions(env, userKey, displayName, url, now), ctx);
      case 'history':
        return okResponse(await handleHistory(env, userKey, displayName, url, now), ctx);
      case 'rank':
        return okResponse(await handleRank(env, userKey, displayName, url, now), ctx);
      case 'bets':
        return okResponse(await handlePlaceBet(env, sandboxedIss, identity.sub, displayName, body, now), ctx);
    }
  }

  // 管理接口
  if (path.startsWith('/admin/')) {
    await requireAdmin(request, env);
    if (request.method === 'GET' && path === '/admin/config') {
      return okResponse(await handleAdminGetConfig(env, now), ctx);
    }
    if (request.method === 'PATCH' && path === '/admin/config') {
      return okResponse(await handleAdminPatchConfig(env, await readJson(request), now), ctx);
    }
    if (request.method === 'GET' && path === '/admin/markets') {
      return okResponse(await handleAdminListMarkets(env, url, now), ctx);
    }
    if (request.method === 'POST' && path === '/admin/markets') {
      return okResponse(await handleAdminCreateMarket(env, await readJson(request), now), ctx);
    }
    const marketMatch = path.match(/^\/admin\/markets\/([^/]+)(\/(settle|reopen))?$/);
    if (marketMatch) {
      const id = decodeURIComponent(marketMatch[1]!);
      const action = marketMatch[3];
      if (!action && request.method === 'PATCH') {
        return okResponse(await handleAdminPatchMarket(env, id, await readJson(request), now), ctx);
      }
      if (action === 'settle' && request.method === 'POST') {
        return okResponse(await handleAdminSettle(env, id, await readJson(request), now), ctx);
      }
      if (action === 'reopen' && request.method === 'POST') {
        return okResponse(await handleAdminReopen(env, id, await readJson(request), now), ctx);
      }
    }
    if (request.method === 'GET' && path === '/admin/stats') {
      return okResponse(await handleAdminStats(env, now), ctx);
    }
    if (request.method === 'POST' && path === '/admin/maintenance') {
      return okResponse(await handleAdminMaintenance(env, now), ctx);
    }
    if (request.method === 'GET' && path === '/admin/audit') {
      return okResponse(await handleAdminAudit(env, url, now), ctx);
    }
    return errorResponse(404, 'NOT_FOUND', 'NOT_FOUND', ctx);
  }

  return errorResponse(404, 'NOT_FOUND', 'NOT_FOUND', ctx);
}

// ---- Cron：结算（每 10 分钟）----

export async function settleTick(env: Env): Promise<{ settled: number; checked: number }> {
  const now = Date.now();
  const cfg = await getConfig(env, now);

  // 结算数据源：失败只记录，不结算（契约 9 / 参考文档注意事项）。
  // models_url 白名单：仅允许 https 且 host 为 api.deepseek.com，
  // 不匹配时绝不附带 Authorization 发起请求，记录错误并放弃本轮结算。
  const allowed = (() => {
    try {
      const parsed = new URL(cfg.models_url);
      return parsed.protocol === 'https:' && parsed.hostname === 'api.deepseek.com';
    } catch {
      return false;
    }
  })();
  if (!allowed) {
    console.error(`[whale] models_url not allowed, skip settle (only https://api.deepseek.com is trusted)`);
    return { settled: 0, checked: 0 };
  }

  let models: ModelInfo[] = [];
  try {
    const res = await fetch(cfg.models_url, {
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models fetch failed: ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    models = Array.isArray(body.data) ? (body.data.filter((m) => typeof m === 'object' && m !== null) as ModelInfo[]) : [];
  } catch (e) {
    console.error(`[whale] models fetch failed: ${e instanceof Error ? e.message : 'unknown'}`);
    return { settled: 0, checked: 0 };
  }

  const { results: openMarkets } = await env.DB.prepare(
    "SELECT * FROM markets WHERE status = 'open'",
  ).all<MarketRow>();

  let settled = 0;
  for (const market of openMarkets) {
    // 单市场失败只记录，不阻塞后续市场。
    try {
      // 截止未结算：结算为 no。
      if (market.deadline <= now) {
        if (await acquireForSettlement(env, market.id, now)) {
          await settleMarketDb(env, market, 'no', 'deadline', cfg.season, now);
          settled++;
        }
        continue;
      }

      let condition: MarketCondition;
      try {
        condition = JSON.parse(market.condition_json) as MarketCondition;
      } catch {
        continue;
      }
      const hit = evaluateCondition(condition, models);
      if (hit) {
        const newCount = market.hit_count + 1;
        await env.DB.prepare(
          'UPDATE markets SET hit_count = ?, first_seen_at = COALESCE(first_seen_at, ?), updated_at = ? WHERE id = ?',
        )
          .bind(newCount, now, now, market.id)
          .run();
        if (newCount >= cfg.poll_confirmations) {
          const acquired = await acquireForSettlement(env, market.id, now);
          if (acquired) {
            market.hit_count = newCount;
            await settleMarketDb(env, market, 'yes', 'auto', cfg.season, now);
            settled++;
          }
        }
      } else if (market.hit_count !== 0) {
        await env.DB.prepare('UPDATE markets SET hit_count = 0, updated_at = ? WHERE id = ?')
          .bind(now, market.id)
          .run();
      }
    } catch (e) {
      console.error(`[whale] settle market ${market.id} failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  // 卡在 settling 的市场（上次派奖失败）：幂等重试。
  await retryStuckSettling(env, cfg, now);

  // 结算后 optimize（D1 可能拒绝 PRAGMA，忽略失败）。
  try {
    await env.DB.prepare('PRAGMA optimize').run();
  } catch {
    // ignore
  }
  return { settled, checked: openMarkets.length };
}

// ---- Cron：月度归档（每月 1 日，Asia/Shanghai）----

export async function monthlyArchive(env: Env): Promise<unknown> {
  const now = Date.now();
  const cfg = await getConfig(env, now);

  // 赛季翻页：config.season 落后于当前月份时更新。
  const currentMonth = shanghaiMonth(now);
  let seasonRolled = false;
  if (cfg.season !== currentMonth) {
    await setConfigValue(env, 'season', currentMonth, now);
    seasonRolled = true;
  }

  // 00:10 UTC = 08:10 上海；确认上海日期是 1 日才执行清理。
  const counts = await runMaintenance(env, now);
  await writeAudit(env, 'monthly.archive', 'system', null, JSON.stringify({ seasonRolled, counts }), now);
  return { seasonRolled, counts };
}

// 供测试引用的 corsHeaders 再导出
export { corsHeaders };
