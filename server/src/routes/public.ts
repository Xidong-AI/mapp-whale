// 公开接口（契约 v2 第 5 节）：auth: none，不得泄露 user_key。

import type { Env, MarketRow, OutcomeRow } from '../types';
import { getConfig } from '../db';

export interface OutcomeView {
  id: string;
  label: string;
  pool: number;
  seed: number;
  implied: number;
  payout: number;
  hitCount: number;
  firstSeenAt: number | null;
}

export interface MarketView {
  id: string;
  title: string;
  description: string;
  deadline: number;
  status: string;
  settleMode: string;
  fallbackOutcomeId: string | null;
  winningOutcomeId: string | null;
  settledAt: number | null;
  settleReason: string | null;
  totalPool: number;
  participantCount?: number;
  outcomes: OutcomeView[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** 市场视图：totalPool = Σ(pool+seed)；implied = (pool+seed)/totalPool；payout = totalPool/(pool+seed)；空池按 1.0。 */
export function marketView(
  m: MarketRow,
  outcomes: OutcomeRow[],
  participantCount?: number,
): MarketView {
  const total = outcomes.reduce((sum, o) => sum + o.pool + o.seed, 0);
  const viewOutcomes = outcomes
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((o) => {
      const base = o.pool + o.seed;
      const implied = total === 0 ? 1.0 : base / total;
      const payout = base === 0 ? 1.0 : total / base;
      return {
        id: o.id,
        label: o.label,
        pool: o.pool,
        seed: o.seed,
        implied: round2(implied),
        payout: round2(payout),
        hitCount: o.hit_count,
        firstSeenAt: o.first_seen_at,
      };
    });
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    deadline: m.deadline,
    status: m.status,
    settleMode: m.settle_mode,
    fallbackOutcomeId: m.fallback_outcome_id,
    winningOutcomeId: m.winning_outcome_id,
    settledAt: m.settled_at,
    settleReason: m.settle_reason,
    totalPool: total,
    outcomes: viewOutcomes,
    ...(participantCount === undefined ? {} : { participantCount }),
  };
}

export async function handlePublicConfig(env: Env, now: number): Promise<unknown> {
  const cfg = await getConfig(env, now);
  return {
    productName: cfg.product_name,
    season: cfg.season,
    betMin: cfg.bet_min,
    maxBetRatio: cfg.max_bet_ratio,
    dailyChips: cfg.daily_chips,
    initialChips: cfg.initial_chips,
    pageSize: cfg.page_size,
    accuracyMinSamples: cfg.accuracy_min_samples,
    serverTime: now,
  };
}

export async function handlePublicMarkets(
  env: Env,
  url: URL,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  const id = url.searchParams.get('id');
  const status = url.searchParams.get('status');
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : cfg.page_size;
  const cursor = url.searchParams.get('cursor');

  if (id) {
    const row = await env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(id).first<MarketRow>();
    if (!row) throw new Error('NOT_FOUND');
    const outcomes = await fetchOutcomes(env, [row.id]);
    const counts = await participantCounts(env, [row.id]);
    return { items: [marketView(row, outcomes.get(row.id) ?? [], counts.get(row.id) ?? 0)], nextCursor: null };
  }

  const statuses = ['open', 'locked', 'settling', 'settled', 'void'];
  if (status !== null && !statuses.includes(status)) throw new Error('INVALID_REQUEST');

  let rows: MarketRow[];
  if (cursor) {
    const cur = await env.DB.prepare('SELECT * FROM markets WHERE id = ?')
      .bind(cursor)
      .first<MarketRow>();
    if (!cur) throw new Error('NOT_FOUND');
    rows = await fetchMarkets(env, status, limit + 1, 'AND (created_at < ? OR (created_at = ? AND id < ?))', [
      cur.created_at,
      cur.created_at,
      cur.id,
    ]);
  } else {
    rows = await fetchMarkets(env, status, limit + 1, '', []);
  }

  const nextCursor = rows.length > limit ? rows[limit - 1]!.id : null;
  const page = rows.slice(0, limit);
  const outcomeMap = await fetchOutcomes(env, page.map((m) => m.id));
  const counts = await participantCounts(env, page.map((m) => m.id));
  return {
    items: page.map((m) => marketView(m, outcomeMap.get(m.id) ?? [], counts.get(m.id) ?? 0)),
    nextCursor,
  };
}

async function participantCounts(env: Env, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT market_id, COUNT(DISTINCT user_key) AS n FROM bets WHERE market_id IN (${placeholders}) GROUP BY market_id`,
  )
    .bind(...ids)
    .all<{ market_id: string; n: number }>();
  return new Map(results.map((r) => [r.market_id, r.n]));
}

/** 按 market_id 批量取 outcomes，返回 market_id → 按 sort_order 排序的 outcomes。 */
async function fetchOutcomes(env: Env, marketIds: string[]): Promise<Map<string, OutcomeRow[]>> {
  const map = new Map<string, OutcomeRow[]>();
  if (marketIds.length === 0) return map;
  const placeholders = marketIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT * FROM outcomes WHERE market_id IN (${placeholders}) ORDER BY market_id, sort_order`,
  )
    .bind(...marketIds)
    .all<OutcomeRow>();
  for (const row of results) {
    const list = map.get(row.market_id) ?? [];
    list.push(row);
    map.set(row.market_id, list);
  }
  return map;
}

async function fetchMarkets(
  env: Env,
  status: string | null,
  limit: number,
  cursorClause: string,
  cursorParams: (number | string)[],
): Promise<MarketRow[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (cursorClause) {
    clauses.push(cursorClause.replace(/^\s*AND\s+/, ''));
    params.push(...cursorParams);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')} ` : '';
  const { results } = await env.DB.prepare(
    `SELECT * FROM markets ${where}ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...params, limit)
    .all<MarketRow>();
  return results;
}

export async function handlePublicLeaderboard(
  env: Env,
  url: URL,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  const type = url.searchParams.get('type') ?? 'assets';
  if (type !== 'assets' && type !== 'accuracy') throw new Error('INVALID_REQUEST');
  const season = url.searchParams.get('season') ?? cfg.season;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50);

  let items: { rank: number; displayName: string | null; chips?: number; accuracy?: number; samples?: number }[];
  if (type === 'assets') {
    const { results } = await env.DB.prepare(
      // 排除沙箱用户（user_key 含 #sandbox#），不影响正常生产用户。
      "SELECT display_name, chips FROM users WHERE user_key NOT LIKE '%#sandbox#%' ORDER BY chips DESC, user_key ASC LIMIT ?",
    )
      .bind(limit)
      .all<{ display_name: string | null; chips: number }>();
    items = results.map((r, i) => ({
      rank: i + 1,
      displayName: r.display_name,
      chips: r.chips,
    }));
  } else {
    const { results } = await env.DB.prepare(
      'SELECT user_key, display_name, correct, total, peak_chips FROM season_stats ' +
        "JOIN users USING (user_key) WHERE season = ? AND total >= ? AND user_key NOT LIKE '%#sandbox#%' " +
        'ORDER BY CAST(correct AS REAL) / total DESC, total DESC, user_key ASC LIMIT ?',
    )
      .bind(season, cfg.accuracy_min_samples, limit)
      .all<{ display_name: string | null; correct: number; total: number }>();
    items = results.map((r, i) => ({
      rank: i + 1,
      displayName: r.display_name,
      accuracy: r.total > 0 ? Math.round((r.correct / r.total) * 100) / 100 : 0,
      samples: r.total,
    }));
  }

  return { season, type, items };
}
