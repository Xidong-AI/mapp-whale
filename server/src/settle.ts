// 结算引擎（契约 v2 第 4 节）：纯函数复用 conditions.ts / multi-settle.ts，D1 写入与求值分离，便于单测。

import type { Env, MarketRow, OutcomeRow } from './types';
import { upsertSeasonStats, writeAudit } from './db';
import { parseCondition, evaluateCondition, InvalidConditionError, type Condition, type ModelRow } from './conditions';
import {
  chooseWinningOutcome,
  computeMultiSettlement,
  type BetInput,
  type OutcomeInput,
  type SettlementResult,
} from './multi-settle';

export type { ModelRow };

// ---- 条件求值 ----

/** 纯函数：解析并求值 condition_json；非法条件视为未命中（不中断轮询）。 */
export function evaluateConditionJson(conditionJson: string, models: ModelRow[]): boolean {
  try {
    return evaluateCondition(parseCondition(JSON.parse(conditionJson)), { models });
  } catch (e) {
    if (!(e instanceof InvalidConditionError)) {
      // JSON.parse 失败等也按未命中处理。
    }
    return false;
  }
}

// ---- D1 写入 ----

export interface SettleOutcomeSummary {
  outcome: string | null;
  void: boolean;
  reason: string;
  winners: number;
  refunded: number;
  losers: number;
  paidChips: number;
  refundedChips: number;
  destroyedRemainder: number;
  totalPool: number;
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

export interface SettleChoices {
  /** 指定赢家 outcome id；null 且 void=true 表示退款。 */
  outcomeId: string | null;
  void: boolean;
  reason: string;
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
  choices: SettleChoices,
  season: string,
  now: number,
): Promise<SettleOutcomeSummary> {
  const outcomeId = choices.void ? null : choices.outcomeId;

  const { results: bets } = await env.DB.prepare(
    "SELECT id, user_key, outcome_id, amount FROM bets WHERE market_id = ? AND status = 'open'",
  )
    .bind(market.id)
    .all<{ id: string; user_key: string; outcome_id: string; amount: number }>();

  const { results: outcomeRows } = await env.DB.prepare(
    'SELECT id, pool, seed FROM outcomes WHERE market_id = ?',
  )
    .bind(market.id)
    .all<{ id: string; pool: number; seed: number }>();

  const betInputs: BetInput[] = bets.map((b) => ({
    betId: b.id,
    userKey: b.user_key,
    outcomeId: b.outcome_id,
    amount: b.amount,
  }));
  const result: SettlementResult = computeMultiSettlement({
    outcomes: outcomeRows,
    bets: betInputs,
    winningOutcomeId: outcomeId,
  });

  // void 时最终 winning_outcome_id 记为 null；派奖时记赢家 outcome。
  const finalWinningId = result.void ? null : outcomeId;

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
    item: { betId: string; userKey: string; payout: number },
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
        'INSERT INTO ledger (user_key, market_id, outcome_id, bet_id, delta, reason, season, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(item.userKey, market.id, outcomeId, item.betId, item.payout, ledgerReason, season, now),
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

  // 非赢家：status='lost'。
  const settledBetIds = new Set([...result.payouts, ...result.refunds].map((i) => i.betId));
  for (const bet of bets) {
    if (!settledBetIds.has(bet.id)) {
      statements.push(
        env.DB.prepare("UPDATE bets SET status = 'lost', payout = 0 WHERE id = ? AND status = 'open'").bind(bet.id),
      );
    }
  }

  statements.push(
    env.DB.prepare(
      "UPDATE markets SET status = 'settled', winning_outcome_id = ?, settled_at = ?, settle_reason = ?, updated_at = ? " +
        "WHERE id = ? AND status = 'settling'",
    ).bind(finalWinningId, now, choices.reason, now, market.id),
  );

  statements.push(
    env.DB.prepare(
      'INSERT INTO audit (action, actor, target, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      'settle',
      'system',
      market.id,
      JSON.stringify({
        outcome: finalWinningId,
        void: result.void,
        reason: choices.reason,
        winners: result.payouts.length,
        refunded: result.refunds.length,
        losers: bets.length - settledBetIds.size,
        destroyed: result.totalPool - [...result.payouts, ...result.refunds].reduce((s, p) => s + p.payout, 0),
        totalPool: result.totalPool,
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
    outcome: finalWinningId,
    void: result.void,
    reason: choices.reason,
    winners: result.payouts.length,
    refunded: result.refunds.length,
    losers: bets.length - settledBetIds.size,
    paidChips: result.payouts.reduce((s, p) => s + p.payout, 0),
    refundedChips: result.refunds.reduce((s, r) => s + r.payout, 0),
    destroyedRemainder:
      result.totalPool - [...result.payouts, ...result.refunds].reduce((s, p) => s + p.payout, 0),
    totalPool: result.totalPool,
  };
}

/**
 * 提取条件树里的 first_seen_between 算子（取第一个），用于判断模型当前是否被观测到。
 */
function extractFirstSeen(
  condition: Condition,
): { regex: string; flags: string } | null {
  if (condition.kind === 'first_seen_between') {
    return { regex: condition.regex, flags: condition.flags ?? '' };
  }
  if (condition.kind === 'all' || condition.kind === 'any') {
    for (const child of condition.of) {
      const found = extractFirstSeen(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 对市场 outcomes 求值（契约第 4 节）：
 * - 命中累计 hit_count，未命中清零；连续 poll_confirmations 次命中视为有效命中。
 * - first_seen_between：首次观测到 regex 命中的模型时记录 first_seen_at（只记一次）。
 * 返回有效命中的 outcome id 列表。
 */
export async function updateOutcomeHits(
  env: Env,
  marketId: string,
  conditionRows: { id: string; condition_json: string; hit_count: number; first_seen_at: number | null }[],
  models: ModelRow[],
  pollConfirmations: number,
  now: number,
): Promise<string[]> {
  const validHits: string[] = [];
  for (const row of conditionRows) {
    let hit = false;
    let firstSeenAt = row.first_seen_at;
    try {
      const condition = parseCondition(JSON.parse(row.condition_json));
      // 尚未记录首次观测时间时，检查本轮是否观测到目标模型；观测到则记录 now。
      if (firstSeenAt === null) {
        const info = extractFirstSeen(condition);
        if (info) {
          try {
            const re = new RegExp(info.regex, info.flags);
            const start =
              condition.kind === 'first_seen_between' ? condition.start : null;
            const end =
              condition.kind === 'first_seen_between' ? condition.end : null;
            const inWindow =
              start === null || (now >= start && (end === null || now < end));
            if (inWindow && models.some((m) => re.test(m.name))) firstSeenAt = now;
          } catch {
            // 非法正则：不记录。
          }
        }
      }
      hit = evaluateCondition(condition, { models, firstSeenAt });
      if (hit && firstSeenAt === null) firstSeenAt = now;
    } catch {
      hit = false; // 非法 JSON / 非法条件视为未命中。
    }
    const newCount = hit ? row.hit_count + 1 : 0;
    const firstSeenChanged = firstSeenAt !== null && row.first_seen_at === null;
    if (newCount !== row.hit_count || firstSeenChanged) {
      await env.DB.prepare(
        'UPDATE outcomes SET hit_count = ?, first_seen_at = ? WHERE market_id = ? AND id = ?',
      )
        .bind(newCount, firstSeenAt, marketId, row.id)
        .run();
    }
    if (hit && newCount >= pollConfirmations) validHits.push(row.id);
  }
  return validHits;
}

// 供 index.ts settleTick 使用的选择逻辑封装。
export async function chooseAndSettle(
  env: Env,
  market: MarketRow,
  validHits: string[],
  models: ModelRow[],
  season: string,
  now: number,
): Promise<boolean> {
  const { results: outcomeRows } = await env.DB.prepare(
    'SELECT id, pool, seed, hit_count, sort_order FROM outcomes WHERE market_id = ? ORDER BY sort_order',
  )
    .bind(market.id)
    .all<{ id: string; pool: number; seed: number; hit_count: number; sort_order: number }>();
  if (outcomeRows.length === 0) return false;

  const outcomeInputs: OutcomeInput[] = outcomeRows.map((o) => ({
    id: o.id,
    pool: o.pool,
    seed: o.seed,
    matched: validHits.includes(o.id),
  }));
  const deadlinePassed = market.deadline <= now;
  const chosen = chooseWinningOutcome({
    mode: market.settle_mode,
    outcomes: outcomeInputs,
    fallbackOutcomeId: market.fallback_outcome_id,
    deadlinePassed,
  });

  if (chosen.outcomeId === null && !chosen.void) {
    return false; // 等待，不出结果。
  }
  if (chosen.outcomeId === null && chosen.void) {
    // void：需要抢占后退款。
    const acquired = await acquireForSettlement(env, market.id, now);
    if (!acquired) return false;
    await settleMarketDb(env, market, { outcomeId: null, void: true, reason: chosen.reason }, season, now);
    return true;
  }

  // 确认指定赢家存在（fallback 引用缺失时 chooseWinningOutcome 已判 void，这里防越界）。
  const exists = outcomeRows.some((o) => o.id === chosen.outcomeId);
  if (!exists) {
    const acquired = await acquireForSettlement(env, market.id, now);
    if (!acquired) return false;
    await settleMarketDb(
      env,
      market,
      { outcomeId: null, void: true, reason: 'fallback_missing' },
      season,
      now,
    );
    return true;
  }

  const acquired = await acquireForSettlement(env, market.id, now);
  if (!acquired) return false;
  await settleMarketDb(
    env,
    market,
    {
      outcomeId: chosen.outcomeId,
      void: false,
      reason: chosen.reason === 'fallback' ? 'fallback' : 'auto',
    },
    season,
    now,
  );
  return true;
}

// 向后兼容导出：type OutcomeRow re-export 供路由复用。
export type { OutcomeRow };

/**
 * cron 重试：对 status='settling' 且 settled_at 为空或超过 5 分钟的市场重新结算。
 * 重试时按当前数据重新推断赢家（结算守卫只处理 status='open' 的注单，不会重复派奖）。
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
    // 重试时以 fallback 推断（上一轮已选定赢家但写库失败的情形：以 winning_outcome_id 为准）。
    if (market.winning_outcome_id) {
      await settleMarketDb(
        env,
        market,
        { outcomeId: market.winning_outcome_id, void: false, reason: 'retry' },
        cfg.season,
        now,
      );
      retried++;
    } else if (market.deadline <= now) {
      await settleMarketDb(env, market, { outcomeId: null, void: true, reason: 'retry_void' }, cfg.season, now);
      retried++;
    }
    // 未过期且无赢家记录：等待下轮正常流程。
  }
  return retried;
}

// writeAudit 由 admin 路由使用；settle 内审计直接 INSERT，这里保留导出避免破坏现有 import。
export { writeAudit };
