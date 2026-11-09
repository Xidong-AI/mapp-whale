// 结算引擎（契约第 9 节）：纯计算函数与 D1 写入分离，便于单测。

import type { Env, MarketRow } from './types';
import { upsertSeasonStats, writeAudit } from './db';

// ---- 条件求值 ----

export interface ModelInfo {
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

export type MarketCondition =
  | { kind: 'name_regex'; regex: string; flags?: string }
  | {
      kind: 'field_threshold';
      targetNameRegex: string;
      field: string;
      op: '>=' | '>' | '<=' | '<' | '=';
      value: number;
    };

function parseRegex(pattern: string, flags: string | undefined): RegExp | null {
  try {
    // 只允许无状态 flag；g/y 会保留 lastIndex，跨模型 test 时漏判。
    const safeFlags = (flags ?? '').replace(/[^imsu]/g, '');
    const re = new RegExp(pattern, safeFlags);
    // 防 ReDoS：限制长度与常见灾难嵌套（简单启发式即可）。
    if (pattern.length > 256 || /(.+)*[+*]\s*[+*]/.test(pattern)) return null;
    return re;
  } catch {
    return null;
  }
}

/** 纯函数：按 condition_json 对模型列表求值。 */
export function evaluateCondition(condition: MarketCondition, models: ModelInfo[]): boolean {
  switch (condition.kind) {
    case 'name_regex': {
      const re = parseRegex(condition.regex, condition.flags);
      if (!re) return false;
      return models.some((m) => typeof m.name === 'string' && re.test(m.name));
    }
    case 'field_threshold': {
      const re = parseRegex(condition.targetNameRegex, 'i');
      if (!re) return false;
      // 任一命中目标名的模型字段满足阈值即算命中，而不是只看 find 的第一个模型。
      return models.some((m) => {
        if (typeof m.name !== 'string' || !re.test(m.name)) return false;
        const v = m[condition.field];
        if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        switch (condition.op) {
          case '>=':
            return v >= condition.value;
          case '>':
            return v > condition.value;
          case '<=':
            return v <= condition.value;
          case '<':
            return v < condition.value;
          case '=':
            return v === condition.value;
        }
        return false;
      });
    }
  }
}

// ---- 派奖计算（纯函数）----

export interface BetLike {
  id: string;
  user_key: string;
  side: 'yes' | 'no';
  amount: number;
}

export interface SettlementPayout {
  betId: string;
  userKey: string;
  payout: number;
}

export interface SettlementResult {
  /** winPool 为 0 时退款，outcome 记为 void。 */
  outcome: 'yes' | 'no' | 'void';
  refunds: SettlementPayout[];
  payouts: SettlementPayout[];
  loserBetIds: string[];
  /** 向下取整后被销毁的余数（整数，非负）。 */
  destroyedRemainder: number;
  winPool: number;
  losePool: number;
  totalPool: number;
}

/**
 * 纯计算：`payout = floor(amount / (winPool + seedWin) * total)`，余数销毁；
 * 赢方用户池为 0 时全员退款（void）。
 */
export function computeSettlement(
  outcome: 'yes' | 'no' | 'void',
  bets: BetLike[],
  seedWin: number,
  seedLose: number,
): SettlementResult {
  if (outcome === 'void') {
    return {
      outcome: 'void',
      refunds: bets.map((b) => ({ betId: b.id, userKey: b.user_key, payout: b.amount })),
      payouts: [],
      loserBetIds: [],
      destroyedRemainder: 0,
      winPool: 0,
      losePool: bets.filter((b) => b.side === 'no').reduce((s, b) => s + b.amount, 0),
      totalPool: bets.reduce((s, b) => s + b.amount, 0) + seedWin + seedLose,
    };
  }

  const winSide = outcome === 'yes' ? 'yes' : 'no';
  const winBets = bets.filter((b) => b.side === winSide);
  const loseBets = bets.filter((b) => b.side !== winSide);
  const winPool = winBets.reduce((s, b) => s + b.amount, 0);
  const losePool = loseBets.reduce((s, b) => s + b.amount, 0);
  const total = winPool + losePool + seedWin + seedLose;

  if (winPool <= 0) {
    return {
      outcome: 'void',
      refunds: bets.map((b) => ({ betId: b.id, userKey: b.user_key, payout: b.amount })),
      payouts: [],
      loserBetIds: [],
      destroyedRemainder: 0,
      winPool,
      losePool,
      totalPool: total,
    };
  }

  const payouts: SettlementPayout[] = winBets.map((b) => ({
    betId: b.id,
    userKey: b.user_key,
    payout: Math.floor((b.amount / (winPool + seedWin)) * total),
  }));
  const paid = payouts.reduce((s, p) => s + p.payout, 0);
  return {
    outcome,
    refunds: [],
    payouts,
    loserBetIds: loseBets.map((b) => b.id),
    destroyedRemainder: total - paid,
    winPool,
    losePool,
    totalPool: total,
  };
}

// ---- D1 写入 ----

export interface SettleOutcomeSummary {
  outcome: 'yes' | 'no' | 'void';
  winners: number;
  refunded: number;
  losers: number;
  paidChips: number;
  refundedChips: number;
  destroyedRemainder: number;
}

/**
 * 两阶段抢占：把市场从 open/locked 抢占为 settling。
 * 返回 false 表示已被其他调用方抢占，调用方不得派奖。
 */
export async function acquireForSettlement(env: Env, marketId: string, now: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE markets SET status = 'settling', updated_at = ? WHERE id = ? AND status IN ('open', 'locked')",
  )
    .bind(now, marketId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/**
 * 结算事务：写 bets.status/payout、users.chips、ledger、season_stats、markets、audit，
 * 全部在一个 D1 batch 内。只处理 status='open' 的注单；最终落 settled 要求市场处于
 * settling，因此并发重复调用或重试不会重复派奖（batch 原子回滚）。
 * 市场必须已通过 acquireForSettlement 抢占（或处于 settling 重试）。
 */
export async function settleMarketDb(
  env: Env,
  market: MarketRow,
  outcome: 'yes' | 'no' | 'void',
  reason: string,
  season: string,
  now: number,
): Promise<SettleOutcomeSummary> {
  const seedWin = outcome === 'no' ? market.seed_no : market.seed_yes;
  const seedLose = outcome === 'no' ? market.seed_yes : market.seed_no;

  const { results } = await env.DB.prepare(
    "SELECT id, user_key, side, amount FROM bets WHERE market_id = ? AND status = 'open'",
  )
    .bind(market.id)
    .all<{ id: string; user_key: string; side: 'yes' | 'no'; amount: number }>();

  const result = computeSettlement(outcome, results, seedWin, seedLose);
  const finalOutcome = result.outcome;

  const statements: D1PreparedStatement[] = [];

  // 结算前各用户余额，用于 season_stats 的 end_chips / peak_chips。
  const userKeys = [...new Set([...result.payouts, ...result.refunds].map((i) => i.userKey))];
  const credits = new Map<string, number>();
  for (const item of [...result.payouts, ...result.refunds]) {
    credits.set(item.userKey, (credits.get(item.userKey) ?? 0) + item.payout);
  }
  const chipsBefore = new Map<string, number>();
  for (const uk of userKeys) {
    const row = await env.DB.prepare('SELECT chips FROM users WHERE user_key = ?')
      .bind(uk)
      .first<{ chips: number }>();
    chipsBefore.set(uk, row?.chips ?? 0);
  }

  // 赢家 / 退款：更新 bets、users.chips、ledger、season_stats
  // 带 status='open' 守卫：settling 重试时已 won/lost/refunded 的注单跳过。
  const credit = (
    item: SettlementPayout,
    status: 'won' | 'refunded',
    ledgerReason: 'payout' | 'refund',
    correct: number,
    totalDelta: number,
  ) => {
    statements.push(
      env.DB.prepare("UPDATE bets SET status = ?, payout = ? WHERE id = ? AND status = 'open'").bind(
        status,
        item.payout,
        item.betId,
      ),
    );
    statements.push(
      env.DB.prepare('UPDATE users SET chips = chips + ?, updated_at = ? WHERE user_key = ?').bind(
        item.payout,
        now,
        item.userKey,
      ),
    );
    statements.push(
      env.DB.prepare(
        'INSERT INTO ledger (user_key, market_id, bet_id, delta, reason, season, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(item.userKey, market.id, item.betId, item.payout, ledgerReason, season, now),
    );
    const before = chipsBefore.get(item.userKey) ?? 0;
    const endChips = before + (credits.get(item.userKey) ?? 0);
    statements.push(
      upsertSeasonStats(env, season, item.userKey, {
        endChips,
        payout: ledgerReason === 'payout' ? item.payout : 0,
        correct,
        total: totalDelta,
      }),
    );
  };

  for (const item of result.payouts) credit(item, 'won', 'payout', 1, 0);
  for (const item of result.refunds) credit(item, 'refunded', 'refund', 0, -1);

  for (const betId of result.loserBetIds) {
    statements.push(
      env.DB.prepare("UPDATE bets SET status = 'lost', payout = 0 WHERE id = ? AND status = 'open'").bind(betId),
    );
  }

  statements.push(
    env.DB.prepare(
      "UPDATE markets SET status = 'settled', outcome = ?, settled_at = ?, settle_reason = ?, updated_at = ? " +
        "WHERE id = ? AND status = 'settling'",
    ).bind(finalOutcome, now, reason, now, market.id),
  );

  statements.push(
    env.DB.prepare(
      'INSERT INTO audit (action, actor, target, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      'settle',
      'system',
      market.id,
      JSON.stringify({
        outcome: finalOutcome,
        reason,
        winners: result.payouts.length,
        refunded: result.refunds.length,
        losers: result.loserBetIds.length,
        destroyed: result.destroyedRemainder,
      }),
      now,
    ),
  );

  await env.DB.batch(statements);

  // 确认最终落 settled 成功；若市场不处于 settling（如并发抢先已结算），视为冲突。
  const after = await env.DB.prepare('SELECT status FROM markets WHERE id = ?')
    .bind(market.id)
    .first<{ status: string }>();
  if (after?.status !== 'settled') throw new Error('CONFLICT');

  return {
    outcome: finalOutcome,
    winners: result.payouts.length,
    refunded: result.refunds.length,
    losers: result.loserBetIds.length,
    paidChips: result.payouts.reduce((s, p) => s + p.payout, 0),
    refundedChips: result.refunds.reduce((s, r) => s + r.payout, 0),
    destroyedRemainder: result.destroyedRemainder,
  };
}

/**
 * cron 重试：对 status='settling' 且 settled_at 为空或超过 5 分钟的市场重新结算。
 * 重新推断结果（hit_count 达标 → yes；已过期 → no）；settleMarketDb 只处理
 * status='open' 的注单，因此重试不会重复派奖。
 */
export async function retryStuckSettling(
  env: Env,
  cfg: { season: string; poll_confirmations: number },
  now: number,
): Promise<number> {
  const { results: stuck } = await env.DB.prepare(
    "SELECT * FROM markets WHERE status = 'settling' AND (settled_at IS NULL OR settled_at < ?)",
  )
    .bind(now - 5 * 60_000)
    .all<MarketRow>();

  let retried = 0;
  for (const market of stuck) {
    const outcome = market.hit_count >= cfg.poll_confirmations ? 'yes' : market.deadline <= now ? 'no' : null;
    if (!outcome) continue;
    await settleMarketDb(env, market, outcome, 'retry', cfg.season, now);
    retried++;
  }
  return retried;
}
