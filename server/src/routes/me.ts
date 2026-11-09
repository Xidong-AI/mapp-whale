// 用户接口（契约 7.2）：身份来自 JWT (iss, sub)。

import type { Env, UserRow, MarketRow, BetRow } from '../types';
import { getConfig, ensureUser, shanghaiDate, shanghaiNextMidnight, upsertSeasonStats, type AppConfig } from '../db';

export async function handleMe(
  env: Env,
  userKey: string,
  displayName: unknown,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  const user = await ensureUser(env, userKey, displayName, cfg, now);
  const today = shanghaiDate(now);
  const canClaim = user.last_claim_day !== today;
  const stats = await seasonStatsOf(env, cfg.season, userKey);
  return {
    displayName: user.display_name,
    chips: user.chips,
    season: cfg.season,
    canClaim,
    nextClaimAt: canClaim ? null : shanghaiNextMidnight(now),
    stats,
  };
}

export async function seasonStatsOf(
  env: Env,
  season: string,
  userKey: string,
): Promise<{ staked: number; payout: number; correct: number; total: number; accuracy: number | null }> {
  const row = await env.DB.prepare(
    'SELECT staked, payout, correct, total FROM season_stats WHERE season = ? AND user_key = ?',
  )
    .bind(season, userKey)
    .first<{ staked: number; payout: number; correct: number; total: number }>();
  if (!row) return { staked: 0, payout: 0, correct: 0, total: 0, accuracy: null };
  return {
    staked: row.staked,
    payout: row.payout,
    correct: row.correct,
    total: row.total,
    accuracy: row.total > 0 ? Math.round((row.correct / row.total) * 100) / 100 : null,
  };
}

export async function handleClaim(
  env: Env,
  userKey: string,
  displayName: unknown,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  const user = await ensureUser(env, userKey, displayName, cfg, now);
  const today = shanghaiDate(now);

  // 快速路径：同日已领取直接幂等返回。
  if (user.last_claim_day === today) {
    return { claimed: false, chips: user.chips, amount: 0 };
  }

  // 原子抢占：条件更新 + changes === 1 判定，防并发重复发放。
  const claimRes = await env.DB.prepare(
    'UPDATE users SET chips = chips + ?, last_claim_day = ?, updated_at = ? ' +
      'WHERE user_key = ? AND (last_claim_day IS NULL OR last_claim_day != ?)',
  )
    .bind(cfg.daily_chips, today, now, userKey, today)
    .run();
  if ((claimRes.meta.changes ?? 0) !== 1) {
    return { claimed: false, chips: user.chips, amount: 0 };
  }

  // 只有抢占成功才写流水与赛季统计。
  const userAfter = await env.DB.prepare('SELECT chips FROM users WHERE user_key = ?')
    .bind(userKey)
    .first<{ chips: number }>();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO ledger (user_key, market_id, bet_id, delta, reason, season, created_at) ' +
        'VALUES (?, NULL, NULL, ?, ?, ?, ?)',
    ).bind(userKey, cfg.daily_chips, 'claim', cfg.season, now),
    await upsertSeasonStats(env, cfg.season, userKey, {
      endChips: userAfter?.chips ?? user.chips + cfg.daily_chips,
    }),
  ]);
  return { claimed: true, chips: userAfter?.chips ?? user.chips + cfg.daily_chips, amount: cfg.daily_chips };
}

// ---- 持仓 ----

export interface PositionItem {
  marketId: string;
  marketTitle: string;
  marketStatus: string;
  outcomeId: string;
  outcomeLabel: string;
  amount: number;
  payout: number;
  status: 'open' | 'settled';
  createdAt: number;
}

export async function handlePositions(
  env: Env,
  userKey: string,
  displayName: unknown,
  url: URL,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  await ensureUser(env, userKey, displayName, cfg, now);
  const status = url.searchParams.get('status') ?? 'open';
  if (status !== 'open' && status !== 'settled') throw new Error('INVALID_REQUEST');
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : cfg.page_size;
  const statusFilter = status === 'open' ? "b.status = 'open'" : "b.status != 'open'";
  const cursor = url.searchParams.get('cursor');

  // 组级复合游标：cursor 为 market_id，先取该组在当前过滤下的定位时间，
  // 再按 (MAX(created_at), market_id) 定位下一页的完整分组。
  let havingClause = '';
  const cursorParams: (string | number)[] = [];
  if (cursor) {
    const anchor = await env.DB.prepare(
      `SELECT MAX(b.created_at) AS created_at FROM bets b WHERE b.user_key = ? AND b.market_id = ? AND ${statusFilter}`,
    )
      .bind(userKey, cursor)
      .first<{ created_at: number | null }>();
    if (!anchor || anchor.created_at === null) throw new Error('NOT_FOUND');
    havingClause = 'HAVING (MAX(b.created_at) < ? OR (MAX(b.created_at) = ? AND b.market_id < ?)) ';
    cursorParams.push(anchor.created_at, anchor.created_at, cursor);
  }

  const { results } = await env.DB.prepare(
    'SELECT b.market_id, b.outcome_id, o.label AS outcome_label, SUM(b.amount) AS amount, SUM(b.payout) AS payout, ' +
      "MAX(CASE WHEN b.status = 'open' THEN 'open' ELSE 'settled' END) AS status, MAX(b.created_at) AS created_at, " +
      'm.title AS market_title, m.status AS market_status ' +
      'FROM bets b JOIN markets m ON m.id = b.market_id JOIN outcomes o ON o.market_id = b.market_id AND o.id = b.outcome_id ' +
      `WHERE b.user_key = ? AND ${statusFilter} ` +
      'GROUP BY b.market_id, b.outcome_id, o.label ' +
      havingClause +
      'ORDER BY created_at DESC, b.market_id DESC LIMIT ?',
  )
    .bind(userKey, ...cursorParams, limit + 1)
    .all<{
      market_id: string;
      outcome_id: string;
      outcome_label: string;
      amount: number;
      payout: number;
      status: string;
      created_at: number;
      market_title: string;
      market_status: string;
    }>();

  const items: PositionItem[] = results.slice(0, limit).map((r) => ({
    marketId: r.market_id,
    marketTitle: r.market_title,
    marketStatus: r.market_status,
    outcomeId: r.outcome_id,
    outcomeLabel: r.outcome_label,
    amount: r.amount,
    payout: r.payout,
    status: r.status as 'open' | 'settled',
    createdAt: r.created_at,
  }));
  const last = results[limit - 1];
  return { items, nextCursor: results.length > limit && last ? last.market_id : null };
}

// ---- 历史 ----

export async function handleHistory(
  env: Env,
  userKey: string,
  displayName: unknown,
  url: URL,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  await ensureUser(env, userKey, displayName, cfg, now);
  const season = url.searchParams.get('season') ?? cfg.season;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : cfg.page_size;
  const cursor = url.searchParams.get('cursor');

  const cursorClause = cursor
    ? 'AND (created_at < (SELECT created_at FROM bets WHERE id = ?) OR (created_at = (SELECT created_at FROM bets WHERE id = ?) AND id < ?)) '
    : '';
  const cursorParams: (string | number)[] = cursor ? [cursor, cursor, cursor] : [];

  const { results } = await env.DB.prepare(
    'SELECT b.id, b.market_id, b.outcome_id, o.label AS outcome_label, b.amount, b.confidence, b.status, b.payout, b.created_at, m.title AS market_title ' +
      'FROM bets b JOIN markets m ON m.id = b.market_id JOIN outcomes o ON o.market_id = b.market_id AND o.id = b.outcome_id ' +
      'WHERE b.user_key = ? AND b.season = ? ' +
      cursorClause +
      'ORDER BY b.created_at DESC LIMIT ?',
  )
    .bind(userKey, season, ...cursorParams, limit + 1)
    .all<BetRow & { market_title: string; outcome_label: string }>();

  const nextCursor = results.length > limit ? results[limit - 1]!.id : null;
  return {
    items: results.slice(0, limit).map((b) => ({
      betId: b.id,
      marketId: b.market_id,
      marketTitle: b.market_title,
      outcomeId: b.outcome_id,
      outcomeLabel: b.outcome_label,
      amount: b.amount,
      confidence: b.confidence,
      status: b.status,
      payout: b.payout,
      createdAt: b.created_at,
    })),
    nextCursor,
  };
}

// ---- 排名 ----

export async function handleRank(
  env: Env,
  userKey: string,
  displayName: unknown,
  url: URL,
  now: number,
): Promise<unknown> {
  const cfg = await getConfig(env, now);
  await ensureUser(env, userKey, displayName, cfg, now);
  const type = url.searchParams.get('type') ?? 'assets';
  if (type !== 'assets' && type !== 'accuracy') throw new Error('INVALID_REQUEST');
  const season = url.searchParams.get('season') ?? cfg.season;

  if (type === 'assets') {
    const user = await env.DB.prepare('SELECT chips FROM users WHERE user_key = ?')
      .bind(userKey)
      .first<{ chips: number }>();
    const chips = user?.chips ?? 0;
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE chips > ?')
      .bind(chips)
      .all<{ n: number }>();
    return { season, type, rank: (results[0]?.n ?? 0) + 1, samples: null };
  }

  const stat = await env.DB.prepare(
    'SELECT correct, total FROM season_stats WHERE season = ? AND user_key = ?',
  )
    .bind(season, userKey)
    .first<{ correct: number; total: number }>();
  if (!stat || stat.total < cfg.accuracy_min_samples) {
    return { season, type, rank: null, samples: stat?.total ?? 0 };
  }
  const myAccuracy = stat.correct / stat.total;
  const { results } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM season_stats WHERE season = ? AND total >= ? ' +
      'AND CAST(correct AS REAL) / total > ?',
  )
    .bind(season, cfg.accuracy_min_samples, myAccuracy)
    .all<{ n: number }>();
  return {
    season,
    type,
    rank: (results[0]?.n ?? 0) + 1,
    samples: stat.total,
  };
}

export type { UserRow, MarketRow, AppConfig };
