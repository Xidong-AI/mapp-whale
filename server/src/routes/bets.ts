// 下注接口（契约 7.2 POST /bets）：幂等 + 同 batch 扣款/加池/插注/写流水。

import type { Env, BetRow, MarketRow } from '../types';
import { getConfig, ensureUser, userKeyOf, upsertSeasonStats } from '../db';
import { marketView } from './public';

export interface PlaceBetInput {
  marketId?: unknown;
  side?: unknown;
  amount?: unknown;
  confidence?: unknown;
  clientRequestId?: unknown;
}

export interface BetValidation {
  code: string | null;
  side: 'yes' | 'no' | null;
  amount: number;
  confidence: number;
}

/** 纯校验函数（契约校验顺序 3–6，市场校验由调用方先做）。 */
export function validateBet(
  input: { side: unknown; amount: unknown; confidence: unknown },
  chips: number,
  betMin: number,
  maxBetRatio: number,
): BetValidation {
  if (input.side !== 'yes' && input.side !== 'no') {
    return { code: 'INVALID_SIDE', side: null, amount: 0, confidence: 0 };
  }
  const amount = typeof input.amount === 'number' && Number.isSafeInteger(input.amount) ? input.amount : NaN;
  if (!Number.isSafeInteger(amount) || amount < betMin) {
    return { code: 'BET_TOO_SMALL', side: null, amount: 0, confidence: 0 };
  }
  const maxAmount = Math.floor(chips * maxBetRatio);
  if (amount > maxAmount) {
    return { code: 'BET_TOO_LARGE', side: null, amount, confidence: 0 };
  }
  const confidence =
    typeof input.confidence === 'number' && Number.isSafeInteger(input.confidence) ? input.confidence : NaN;
  if (!Number.isSafeInteger(confidence) || confidence < -100 || confidence > 100) {
    return { code: 'INVALID_CONFIDENCE', side: null, amount, confidence: 0 };
  }
  return { code: null, side: input.side, amount, confidence };
}

export async function handlePlaceBet(
  env: Env,
  iss: string,
  sub: string,
  displayName: unknown,
  input: PlaceBetInput,
  now: number,
): Promise<unknown> {
  if (
    typeof input.marketId !== 'string' ||
    typeof input.clientRequestId !== 'string' ||
    input.clientRequestId.length === 0 ||
    input.clientRequestId.length > 128
  ) {
    throw new Error('INVALID_REQUEST');
  }
  const userKey = userKeyOf(iss, sub);

  // 1. clientRequestId 幂等：已存在则直接返回原结果。
  const existing = await env.DB.prepare(
    'SELECT * FROM bets WHERE user_key = ? AND client_request_id = ?',
  )
    .bind(userKey, input.clientRequestId)
    .first<BetRow>();
  if (existing) {
    const market = await env.DB.prepare('SELECT * FROM markets WHERE id = ?')
      .bind(existing.market_id)
      .first<MarketRow>();
    const user = await env.DB.prepare('SELECT chips FROM users WHERE user_key = ?').bind(userKey).first<{ chips: number }>();
    if (!market || !user) throw new Error('INTERNAL');
    return {
      betId: existing.id,
      chips: user.chips,
      market: marketView(market),
      idempotent: true,
    };
  }

  const cfg = await getConfig(env, now);
  const user = await ensureUser(env, userKey, displayName, cfg, now);

  // 2. 市场存在且 status = open、deadline > now。
  const market = await env.DB.prepare('SELECT * FROM markets WHERE id = ?')
    .bind(input.marketId)
    .first<MarketRow>();
  if (!market) throw new Error('NOT_FOUND');
  if (market.status !== 'open') throw new Error('MARKET_NOT_OPEN');
  if (market.deadline <= now) throw new Error('MARKET_NOT_OPEN');

  // 3–6. side / amount / 余额比例 / confidence。
  const check = validateBet(
    { side: input.side, amount: input.amount, confidence: input.confidence },
    user.chips,
    cfg.bet_min,
    cfg.max_bet_ratio,
  );
  if (check.code) throw new Error(check.code);

  const betId = `b_${crypto.randomUUID()}`;

  // 同一 D1 batch：扣款、加池、插注、写流水、赛季统计。
  // 扣款无条件执行，负余额由迁移 0002 的 trg_users_chips_nonnegative 触发器兜底；
  // 市场关闭/过期由 trg_bets_market_open 触发器兜底；池子更新再带状态与截止守卫。
  // UNIQUE (user_key, client_request_id) 冲突或触发器 ABORT 都会让整个 batch 回滚。
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET chips = chips - ?, updated_at = ? WHERE user_key = ?')
        .bind(check.amount, now, userKey),
      env.DB.prepare(
        `UPDATE markets SET ${check.side === 'yes' ? 'yes_pool' : 'no_pool'} = ${check.side === 'yes' ? 'yes_pool' : 'no_pool'} + ?, updated_at = ? ` +
          "WHERE id = ? AND status = 'open' AND deadline > ?",
      ).bind(check.amount, now, market.id, now),
      env.DB.prepare(
        'INSERT INTO bets (id, client_request_id, market_id, user_key, side, amount, confidence, status, payout, season, created_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)",
      ).bind(betId, input.clientRequestId, market.id, userKey, check.side, check.amount, check.confidence, cfg.season, now),
      env.DB.prepare(
        'INSERT INTO ledger (user_key, market_id, bet_id, delta, reason, season, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(userKey, market.id, betId, -check.amount, 'bet', cfg.season, now),
      await upsertSeasonStats(env, cfg.season, userKey, {
        startChips: user.chips,
        endChips: user.chips - check.amount,
        staked: check.amount,
        total: 1,
      }),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('NEGATIVE_CHIPS')) throw new Error('INSUFFICIENT_CHIPS');
    if (msg.includes('MARKET_CLOSED')) throw new Error('MARKET_NOT_OPEN');
    throw e;
  }

  const updatedMarket = await env.DB.prepare('SELECT * FROM markets WHERE id = ?')
    .bind(market.id)
    .first<MarketRow>();
  const updatedUser = await env.DB.prepare('SELECT chips FROM users WHERE user_key = ?')
    .bind(userKey)
    .first<{ chips: number }>();
  if (!updatedMarket || !updatedUser) throw new Error('INTERNAL');

  return {
    betId,
    chips: updatedUser.chips,
    market: marketView(updatedMarket),
  };
}
