// 管理接口（契约 7.3）：Bearer ADMIN_TOKEN 常量时间比较；所有写操作写 audit。

import type { Env, MarketRow } from '../types';
import {
  CONFIG_VALUE_KEYS,
  getConfig,
  setConfigValue,
  writeAudit,
  shanghaiMonth,
  type AppConfig,
} from '../db';
import { settleMarketDb, acquireForSettlement } from '../settle';

// ---- 常量时间比较（不依赖 Workers 专有的 crypto.subtle.timingSafeEqual，便于测试）----

export function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return diff === 0;
}

export async function requireAdmin(request: Request, env: Env): Promise<void> {
  const expected = env.ADMIN_TOKEN;
  // 未配置、空串或长度 < 32 一律拒绝：防止误配置导致管理接口裸奔。
  if (typeof expected !== 'string' || expected.length < 32) throw new Error('UNAUTHORIZED');
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  const token = auth.slice(7);
  if (!constantTimeEqual(token, expected)) throw new Error('UNAUTHORIZED');
}

// ---- config ----

export async function handleAdminGetConfig(env: Env, now: number): Promise<unknown> {
  const cfg = await getConfig(env, now);
  return cfg;
}

/** 数值键的合法范围（契约第 6 节）：越界一律拒绝。 */
const NUMERIC_BOUNDS: Partial<Record<keyof AppConfig, (n: number) => boolean>> = {
  max_bet_ratio: (n) => n > 0 && n <= 1,
  bet_min: (n) => n >= 1,
  seed_per_side: (n) => n >= 0,
  retain_bet_seasons: (n) => n >= 1,
  daily_chips: (n) => n >= 0,
  initial_chips: (n) => n >= 0,
  poll_confirmations: (n) => n >= 1,
};

export async function handleAdminPatchConfig(
  env: Env,
  body: unknown,
  now: number,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('INVALID_REQUEST');
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) throw new Error('INVALID_REQUEST');

  // 先整批校验再写入：任一项越界即拒绝（INVALID_CONFIG），合法项也不落库。
  const validated: [string, string][] = [];
  for (const [key, value] of entries) {
    if (!CONFIG_VALUE_KEYS.includes(key as keyof AppConfig)) {
      throw new Error('INVALID_REQUEST');
    }
    const bound = NUMERIC_BOUNDS[key as keyof AppConfig];
    if (bound) {
      const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(num) || !bound(num)) throw new Error('INVALID_CONFIG');
    } else if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error('INVALID_REQUEST');
    }
    validated.push([key, String(value)]);
  }
  for (const [key, value] of validated) {
    await setConfigValue(env, key, value, now);
  }
  await writeAudit(env, 'config.patch', 'admin', null, JSON.stringify(Object.keys(entries)), now);
  return getConfig(env, now);
}

// ---- markets ----

function validateCondition(condition: unknown): string {
  if (typeof condition !== 'object' || condition === null) throw new Error('INVALID_REQUEST');
  const c = condition as Record<string, unknown>;
  if (c.kind === 'name_regex') {
    if (typeof c.regex !== 'string') throw new Error('INVALID_REQUEST');
  } else if (c.kind === 'field_threshold') {
    if (
      typeof c.targetNameRegex !== 'string' ||
      typeof c.field !== 'string' ||
      !['>=', '>', '<=', '<', '='].includes(String(c.op)) ||
      typeof c.value !== 'number'
    ) {
      throw new Error('INVALID_REQUEST');
    }
  } else {
    throw new Error('INVALID_REQUEST');
  }
  return JSON.stringify(condition);
}

export async function handleAdminListMarkets(env: Env, url: URL, now: number): Promise<unknown> {
  await getConfig(env, now);
  const status = url.searchParams.get('status');
  const statuses = ['open', 'locked', 'settled', 'void'];
  if (status !== null && !statuses.includes(status)) throw new Error('INVALID_REQUEST');
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const { results } = await env.DB.prepare(`SELECT * FROM markets ${where} ORDER BY created_at DESC LIMIT 500`)
    .bind(...params)
    .all<MarketRow>();
  return { items: results };
}

export async function handleAdminCreateMarket(env: Env, body: unknown, now: number): Promise<unknown> {
  if (typeof body !== 'object' || body === null) throw new Error('INVALID_REQUEST');
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' && b.id.length > 0 ? b.id : `m_${now}`;
  const title = typeof b.title === 'string' && b.title.length > 0 ? b.title : null;
  if (!title || typeof b.deadline !== 'number' || !Number.isSafeInteger(b.deadline)) {
    throw new Error('INVALID_REQUEST');
  }
  const conditionJson = validateCondition(b.condition);
  const description = typeof b.description === 'string' ? b.description : '';
  const seedYes = typeof b.seedYes === 'number' && Number.isSafeInteger(b.seedYes) ? b.seedYes : 0;
  const seedNo = typeof b.seedNo === 'number' && Number.isSafeInteger(b.seedNo) ? b.seedNo : 0;
  const cfg = await getConfig(env, now);
  const finalSeedYes = seedYes || cfg.seed_per_side;
  const finalSeedNo = seedNo || cfg.seed_per_side;
  await env.DB.prepare(
    'INSERT OR IGNORE INTO markets (id, title, description, condition_json, deadline, status, seed_yes, seed_no, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
  )
    .bind(id, title, description, conditionJson, b.deadline, finalSeedYes, finalSeedNo, now, now)
    .run();
  await writeAudit(env, 'market.create', 'admin', id, title, now);
  const row = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
  return row;
}

export async function handleAdminPatchMarket(
  env: Env,
  id: string,
  body: unknown,
  now: number,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null) throw new Error('INVALID_REQUEST');
  const b = body as Record<string, unknown>;
  const market = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
  if (!market) throw new Error('NOT_FOUND');

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (typeof b.title === 'string' && b.title.length > 0) {
    updates.push('title = ?');
    params.push(b.title);
  }
  if (typeof b.description === 'string') {
    updates.push('description = ?');
    params.push(b.description);
  }
  if (typeof b.deadline === 'number' && Number.isSafeInteger(b.deadline)) {
    updates.push('deadline = ?');
    params.push(b.deadline);
  }
  if (typeof b.status === 'string') {
    // 仅允许 open ↔ locked，且 settling 中不允许转状态。
    if (market.status === 'settling') throw new Error('CONFLICT');
    const allowed =
      (market.status === 'open' && b.status === 'locked') ||
      (market.status === 'locked' && b.status === 'open');
    if (!allowed) throw new Error('INVALID_REQUEST');
    updates.push('status = ?');
    params.push(b.status);
  }
  if (updates.length === 0) throw new Error('INVALID_REQUEST');

  updates.push('updated_at = ?');
  params.push(now, id);
  await env.DB.prepare(`UPDATE markets SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
  await writeAudit(env, 'market.patch', 'admin', id, JSON.stringify(Object.keys(b)), now);
  return env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
}

export async function handleAdminSettle(
  env: Env,
  id: string,
  body: unknown,
  now: number,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null) throw new Error('INVALID_REQUEST');
  const b = body as Record<string, unknown>;
  const outcome = b.outcome;
  if (outcome !== 'yes' && outcome !== 'no' && outcome !== 'void') throw new Error('INVALID_REQUEST');
  const reason = typeof b.reason === 'string' && b.reason.length > 0 ? b.reason : 'manual';

  const market = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
  if (!market) throw new Error('NOT_FOUND');
  // 状态机：open/locked 需抢占为 settling；settling 允许直接重试（卡住的市场）；其余拒绝。
  if (market.status === 'open' || market.status === 'locked') {
    const acquired = await acquireForSettlement(env, id, now);
    if (!acquired) throw new Error('CONFLICT');
  } else if (market.status !== 'settling') {
    throw new Error('CONFLICT');
  }

  const cfg = await getConfig(env, now);
  const summary = await settleMarketDb(env, market, outcome, reason, cfg.season, now);
  await writeAudit(env, 'market.settle', 'admin', id, JSON.stringify(summary), now);
  return summary;
}

export async function handleAdminReopen(
  env: Env,
  id: string,
  body: unknown,
  now: number,
): Promise<unknown> {
  if (typeof body !== 'object' || body === null || (body as Record<string, unknown>).force !== true) {
    throw new Error('INVALID_REQUEST');
  }
  const market = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
  if (!market) throw new Error('NOT_FOUND');
  if (market.status !== 'settled') throw new Error('CONFLICT');
  const paid = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bets WHERE market_id = ? AND payout > 0 AND status != 'open'",
  )
    .bind(id)
    .first<{ n: number }>();
  if ((paid?.n ?? 0) > 0) throw new Error('CONFLICT');

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE markets SET status = 'open', outcome = NULL, settled_at = NULL, settle_reason = NULL, hit_count = 0, updated_at = ? WHERE id = ?",
    ).bind(now, id),
    env.DB.prepare(
      "UPDATE bets SET status = 'open', payout = 0 WHERE market_id = ? AND status IN ('won', 'lost', 'refunded')",
    ).bind(id),
    env.DB.prepare('INSERT INTO audit (action, actor, target, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      'market.reopen',
      'admin',
      id,
      null,
      now,
    ),
  ]);
  return env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
}

// ---- stats / maintenance / audit ----

export async function handleAdminStats(env: Env, now: number): Promise<unknown> {
  const count = async (table: string): Promise<number> => {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return r?.n ?? 0;
  };
  const pools = await env.DB.prepare(
    'SELECT COALESCE(SUM(yes_pool), 0) AS yesPool, COALESCE(SUM(no_pool), 0) AS noPool, ' +
      'COALESCE(SUM(seed_yes), 0) AS seedYes, COALESCE(SUM(seed_no), 0) AS seedNo FROM markets',
  ).first<{ yesPool: number; noPool: number; seedYes: number; seedNo: number }>();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM markets WHERE status IN ('open', 'locked') AND deadline <= ?",
  )
    .bind(now)
    .first<{ n: number }>();

  let storageBytes: number | null = null;
  try {
    const pages = await env.DB.prepare('PRAGMA page_count').first<{ page_count: number }>();
    const size = await env.DB.prepare('PRAGMA page_size').first<{ page_size: number }>();
    if (pages && size) storageBytes = pages.page_count * size.page_size;
  } catch {
    // PRAGMA 不可用时忽略。
  }

  return {
    users: await count('users'),
    markets: await count('markets'),
    bets: await count('bets'),
    ledger: await count('ledger'),
    audit: await count('audit'),
    seasonStats: await count('season_stats'),
    pools: pools ?? { yesPool: 0, noPool: 0, seedYes: 0, seedNo: 0 },
    pendingSettlements: pending?.n ?? 0,
    storageBytes,
    season: shanghaiMonth(now),
  };
}

export interface MaintenanceCounts {
  bets: number;
  ledger: number;
  audit: number;
}

/**
 * 存储保留策略（契约第 11 节）：
 * - bets 聚合进 season_stats 后删除（保留最近 retain_bet_seasons 个赛季）；
 * - 只聚合和删除 status != 'open' 的注单：open 注单保留到市场结算；
 * - ledger / audit 按天数删除。
 */
export async function runMaintenance(env: Env, now: number): Promise<MaintenanceCounts> {
  const cfg = await getConfig(env, now);

  // 赛季字符串 YYYY-MM 可按字典序比较。
  const current = cfg.season;
  const [y, m] = current.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y!, (m ?? 1) - 1 - (cfg.retain_bet_seasons - 1), 1));
  const cutoffSeason = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;

  let betsDeleted = 0;
  const { results: oldSeasons } = await env.DB.prepare(
    "SELECT DISTINCT season FROM bets WHERE season < ? AND status != 'open'",
  )
    .bind(cutoffSeason)
    .all<{ season: string }>();
  for (const { season } of oldSeasons) {
    const delCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bets WHERE season = ? AND status != 'open'",
    )
      .bind(season)
      .first<{ n: number }>();
    const deleted = delCount?.n ?? 0;
    if (deleted === 0) continue; // 该赛季只剩 open 注单，保留到市场结算
    const { results } = await env.DB.prepare(
      'SELECT user_key, SUM(amount) AS staked, SUM(payout) AS payout, ' +
        "SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS correct, COUNT(*) AS total " +
        "FROM bets WHERE season = ? AND status != 'open' GROUP BY user_key",
    )
      .bind(season)
      .all<{ user_key: string; staked: number; payout: number; correct: number; total: number }>();
    const stmts: D1PreparedStatement[] = results.map((r) =>
      env.DB.prepare(
        'INSERT INTO season_stats (season, user_key, start_chips, end_chips, staked, payout, correct, total, peak_chips) ' +
          'VALUES (?, ?, 0, 0, ?, ?, ?, ?, 0) ' +
          // 下注 / 结算时已实时累加过这些统计，这里只补缺失行，不重复累加。
          'ON CONFLICT(season, user_key) DO NOTHING',
      ).bind(season, r.user_key, r.staked, r.payout, r.correct, r.total),
    );
    stmts.push(env.DB.prepare("DELETE FROM bets WHERE season = ? AND status != 'open'").bind(season));
    await env.DB.batch(stmts);
    betsDeleted += deleted;
  }

  const ledgerRes = await env.DB.prepare('DELETE FROM ledger WHERE created_at < ?')
    .bind(now - cfg.retain_ledger_days * 86_400_000)
    .run();
  const auditRes = await env.DB.prepare('DELETE FROM audit WHERE created_at < ?')
    .bind(now - cfg.retain_audit_days * 86_400_000)
    .run();

  return {
    bets: betsDeleted,
    ledger: ledgerRes.meta.changes ?? 0,
    audit: auditRes.meta.changes ?? 0,
  };
}

export async function handleAdminMaintenance(env: Env, now: number): Promise<unknown> {
  const counts = await runMaintenance(env, now);
  await writeAudit(env, 'maintenance', 'admin', null, JSON.stringify(counts), now);
  return counts;
}

export async function handleAdminAudit(env: Env, url: URL, now: number): Promise<unknown> {
  await getConfig(env, now);
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? Math.floor(limitRaw) : 50;
  const { results } = await env.DB.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<{
      id: number;
      action: string;
      actor: string;
      target: string | null;
      detail: string | null;
      created_at: number;
    }>();
  return {
    items: results.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor,
      target: r.target,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  };
}
