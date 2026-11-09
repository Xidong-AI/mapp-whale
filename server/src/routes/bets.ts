// 下注接口（契约 v2 第 5 节 POST /bets）：outcomeId 校验 + 幂等 + 同 batch 扣款/加池/插注/写流水。

import type { Env, BetRow, MarketRow, OutcomeRow } from '../types';
import { getConfig, ensureUser, userKeyOf, upsertSeasonStats } from '../db';
import { marketView } from './public';

export interface PlaceBetInput {
  marketId?: unknown;
  outcomeId?: unknown;
  amount?: unknown;
  confidence?: unknown;
  clientRequestId?: unknown;
}

export interface BetValidation {
  code: string | null;
  amount: number;
  confidence: number;
}

/** 纯校验函数：amount 与 confidence（outcome 归属与市场状态由调用方校验）。 */
export function validateBet(
  input: { amount: unknown; confidence: unknown },
  chips: number,
  betMin: number,
  maxBetRatio: number,
): BetValidation {
  const amount = typeof input.amount === 'number' && Number.isSafeInteger(input.amount) ? input.amount : NaN;
  if (!Number.isSafeInteger(amount) || amount < betMin) {
    return { code: 'BET_TOO_SMALL', amount: 0, confidence: 0 };
  }
  const maxAmount = Math.floor(chips * maxBetRatio);
  if (amount > maxAmount) {
    return { code: 'BET_TOO_LARGE', amount, confidence: 0 };
  }
  const confidence =
    typeof input.confidence === 'number' && Number.isSafeInteger(input.confidence) ? input.confidence : NaN;
  if (!Number.isSafeInteger(confidence) || confidence < -100 || confidence > 100) {
    return { code: 'INVALID_CONFIDENCE', amount, confidence: 0 };
  }
  return { code: null, amount, confidence };
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
    typeof input.outcomeId !== 'string' ||
    input.outcomeId.length === 0 ||
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
    const [market, user] = await Promise.all([
      env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(existing.market_id).first<MarketRow>(),
      env.DB.prepare('SELECT chips FROM users WHERE user_key = ?').bind(userKey).first<{ chips: number }>(),
    ]);
    if (!market || !user) throw new Error('INTERNAL');
    const outcomes = await env.DB.prepare(
      'SELECT * FROM outcomes WHERE market_id = ? ORDER BY sort_order',
    )
      .bind(existing.market_id)
      .all<OutcomeRow>();
    return {
      betId: existing.id,
      chips: user.chips,
      market: marketView(market, outcomes.results),
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

  // 3. outcome 必须属于该市场。
  const outcome = await env.DB.prepare('SELECT * FROM outcomes WHERE market_id = ? AND id = ?')
    .bind(market.id, input.outcomeId)
    .first<OutcomeRow>();
  if (!outcome) throw new Error('INVALID_OUTCOME');

  // 4–6. amount / 余额比例 / confidence。
  const check = validateBet(
    { amount: input.amount, confidence: input.confidence },
    user.chips,
    cfg.bet_min,
    cfg.max_bet_ratio,
  );
  if (check.code) throw new Error(check.code);

  const betId = `b_${crypto.randomUUID()}`;

  // 同一 D1 batch：扣款、加 outcome 池、插注、写流水、赛季统计。
  // 扣款无条件执行，负余额由迁移 0002 的 trg_users_chips_nonnegative 触发器兜底；
  // 市场关闭/过期/outcome 不属于该市场由 trg_bets_market_open 触发器兜底。
  // UNIQUE (user_key, client_request_id) 冲突或触发器 ABORT 都会让整个 batch 回滚。
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET chips = chips - ?, updated_at = ? WHERE user_key = ?')
        .bind(check.amount, now, userKey),
      env.DB.prepare(
        'UPDATE outcomes SET pool = pool + ? WHERE market_id = ? AND id = ?',
      ).bind(check.amount, market.id, outcome.id),
      env.DB.prepare(
        'INSERT INTO bets (id, client_request_id, market_id, outcome_id, user_key, amount, confidence, status, payout, season, created_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)",
      ).bind(betId, input.clientRequestId, market.id, outcome.id, userKey, check.amount, check.confidence, cfg.season, now),
      env.DB.prepare(
        'INSERT INTO ledger (user_key, market_id, outcome_id, bet_id, delta, reason, season, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(userKey, market.id, outcome.id, betId, -check.amount, 'bet', cfg.season, now),
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
    if (msg.includes('UNIQUE constraint failed')) {
      // 并发同一 clientRequestId：batch 已回滚，重查原结果返回。
      const again = await env.DB.prepare(
        'SELECT * FROM bets WHERE user_key = ? AND client_request_id = ?',
      )
        .bind(userKey, input.clientRequestId)
        .first<BetRow>();
      if (again) {
        const [existingMarket, existingUser] = await Promise.all([
          env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(again.market_id).first<MarketRow>(),
          env.DB.prepare('SELECT chips FROM users WHERE user_key = ?').bind(userKey).first<{ chips: number }>(),
        ]);
        if (existingMarket && existingUser) {
          const outcomes = await env.DB.prepare(
            'SELECT * FROM outcomes WHERE market_id = ? ORDER BY sort_order',
          )
            .bind(again.market_id)
            .all<OutcomeRow>();
          return {
            betId: again.id,
            chips: existingUser.chips,
            market: marketView(existingMarket, outcomes.results),
            idempotent: true,
          };
        }
      }
    }
    throw e;
  }

  const [updatedMarket, updatedUser, updatedOutcomes] = await Promise.all([
    env.DB.prepare('SELECT * FROM markets WHERE id = ?').bind(market.id).first<MarketRow>(),
    env.DB.prepare('SELECT chips FROM users WHERE user_key = ?').bind(userKey).first<{ chips: number }>(),
    env.DB.prepare('SELECT * FROM outcomes WHERE market_id = ? ORDER BY sort_order')
      .bind(market.id)
      .all<OutcomeRow>(),
  ]);
  if (!updatedMarket || !updatedUser) throw new Error('INTERNAL');

  return {
    betId,
    chips: updatedUser.chips,
    market: marketView(updatedMarket, updatedOutcomes.results),
  };
}
