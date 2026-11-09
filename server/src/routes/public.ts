// 公开接口（契约 7.1）：auth: none，不得泄露 user_key。

import type { Env, MarketRow } from '../types';
import { getConfig } from '../db';

export interface MarketView {
  id: string;
  title: string;
  description: string;
  deadline: number;
  status: string;
  outcome: string | null;
  yesPool: number;
  noPool: number;
  seedYes: number;
  seedNo: number;
  yesShare: number;
  impliedYes: number;
  payoutYes: number;
  payoutNo: number;
  hitCount: number;
  firstSeenAt: number | null;
  settledAt: number | null;
  settleReason: string | null;
  participantCount?: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function marketView(m: MarketRow, participantCount?: number): MarketView {
  const yesBase = m.yes_pool + m.seed_yes;
  const noBase = m.no_pool + m.seed_no;
  const total = yesBase + noBase;
  const userTotal = m.yes_pool + m.no_pool;
  // 空池按 1.0 处理，避免除零。
  const impliedYes = total === 0 ? 1.0 : yesBase / total;
  const payoutYes = yesBase === 0 ? 1.0 : round2(total / yesBase);
  const payoutNo = noBase === 0 ? 1.0 : round2(total / noBase);
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    deadline: m.deadline,
    status: m.status,
    outcome: m.outcome,
    yesPool: m.yes_pool,
    noPool: m.no_pool,
    seedYes: m.seed_yes,
    seedNo: m.seed_no,
    yesShare: userTotal === 0 ? 1.0 : round2(m.yes_pool / userTotal),
    impliedYes: round2(impliedYes),
    payoutYes,
    payoutNo,
    hitCount: m.hit_count,
    firstSeenAt: m.first_seen_at,
    settledAt: m.settled_at,
    settleReason: m.settle_reason,
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
    const counts = await participantCounts(env, [row.id]);
    return { items: [marketView(row, counts.get(row.id) ?? 0)], nextCursor: null };
  }

  const statuses = ['open', 'locked', 'settled', 'void'];
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
  const counts = await participantCounts(env, page.map((m) => m.id));
  return { items: page.map((m) => marketView(m, counts.get(m.id) ?? 0)), nextCursor };
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
