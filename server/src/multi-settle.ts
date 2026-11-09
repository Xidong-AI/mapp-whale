// 多结果市场结算（契约第 4 节）：纯计算函数，无 IO，与 D1 写入分离，便于单测。

export interface OutcomeInput {
  id: string;
  pool: number;
  seed: number;
  matched: boolean;
}

export interface BetInput {
  betId: string;
  userKey: string;
  outcomeId: string;
  amount: number;
}

export type SettleMode = 'first_match' | 'exclusive' | 'manual';

export interface ChooseOutcomeInput {
  mode: SettleMode;
  outcomes: OutcomeInput[];
  fallbackOutcomeId?: string | null;
  deadlinePassed: boolean;
}

export interface ChosenOutcome {
  outcomeId: string | null;
  void: boolean;
  reason: string;
}

export interface SettlementInput {
  outcomes: { id: string; pool: number; seed: number }[];
  bets: BetInput[];
  winningOutcomeId: string | null;
}

export interface Payout {
  betId: string;
  userKey: string;
  outcomeId: string;
  amount: number;
  payout: number;
}

export interface SettlementResult {
  void: boolean;
  winningOutcomeId: string | null;
  totalPool: number;
  payouts: Payout[];
  refunds: Payout[];
}

// ---- 赢家选择（纯函数）----

/** 按 settle_mode 选赢家；outcomeId 为 null 表示继续等待，不出结算结果。 */
export function chooseWinningOutcome(input: ChooseOutcomeInput): ChosenOutcome {
  const { mode, outcomes, fallbackOutcomeId, deadlinePassed } = input;
  const matched = outcomes.filter((o) => o.matched);

  const chooseFallback = (): ChosenOutcome => {
    if (fallbackOutcomeId) {
      const exists = outcomes.some((o) => o.id === fallbackOutcomeId);
      if (!exists) return { outcomeId: null, void: true, reason: 'fallback_missing' };
      return { outcomeId: fallbackOutcomeId, void: false, reason: 'fallback' };
    }
    return { outcomeId: null, void: true, reason: 'no_fallback' };
  };

  switch (mode) {
    case 'first_match': {
      const first = matched[0];
      if (first) return { outcomeId: first.id, void: false, reason: 'first_match' };
      if (deadlinePassed) return chooseFallback();
      return { outcomeId: null, void: false, reason: 'waiting' };
    }
    case 'exclusive': {
      if (matched.length === 1) {
        return { outcomeId: matched[0]!.id, void: false, reason: 'exclusive' };
      }
      if (matched.length > 1) {
        return { outcomeId: null, void: true, reason: 'exclusive_conflict' };
      }
      if (deadlinePassed) return chooseFallback();
      return { outcomeId: null, void: false, reason: 'waiting' };
    }
    case 'manual':
      // 仅管理员结算，cron 不动。
      return { outcomeId: null, void: false, reason: 'waiting_admin' };
  }
}

// ---- 派奖计算（纯函数）----

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** 计算多结果市场派奖；winningOutcomeId 为 null 表示 void 全额退款。 */
export function computeMultiSettlement(input: SettlementInput): SettlementResult {
  const totalPool = input.outcomes.reduce((sum, o) => sum + o.pool + o.seed, 0);
  const payoutRow = (bet: BetInput, payout: number): Payout => ({
    betId: bet.betId,
    userKey: bet.userKey,
    outcomeId: bet.outcomeId,
    amount: bet.amount,
    payout,
  });

  // 未产生赢家：void，全员按原额退款。
  if (input.winningOutcomeId === null) {
    return {
      void: true,
      winningOutcomeId: null,
      totalPool,
      payouts: [],
      refunds: input.bets.map((bet) => payoutRow(bet, bet.amount)),
    };
  }

  const winners = input.bets.filter((bet) => bet.outcomeId === input.winningOutcomeId);
  const winPool = winners.reduce((sum, bet) => sum + bet.amount, 0);
  const winSeed =
    input.outcomes.find((o) => o.id === input.winningOutcomeId)?.seed ?? 0;

  // 赢方用户池为 0：void，全员退款（含非赢家）。
  if (winPool === 0) {
    return {
      void: true,
      winningOutcomeId: input.winningOutcomeId,
      totalPool,
      payouts: [],
      refunds: input.bets.map((bet) => payoutRow(bet, bet.amount)),
    };
  }

  const denominator = winPool + winSeed;
  const payouts: Payout[] = winners.map((bet) => ({
    betId: bet.betId,
    userKey: bet.userKey,
    outcomeId: bet.outcomeId,
    amount: bet.amount,
    // floor(amount / (winPool + winSeed) * total)，余数销毁。
    payout: Math.floor((bet.amount / denominator) * totalPool),
  }));
  return {
    void: false,
    winningOutcomeId: input.winningOutcomeId,
    totalPool,
    payouts,
    refunds: [],
  };
}

// 运行时校验辅助：供调用方（未来接入 settle.ts 时）使用。
export function assertValidSettlementInput(input: SettlementInput): void {
  if (!Array.isArray(input.outcomes) || input.outcomes.length === 0) {
    throw new Error('INVALID_REQUEST');
  }
  for (const o of input.outcomes) {
    if (!isNonNegativeInteger(o.pool) || !isNonNegativeInteger(o.seed)) {
      throw new Error('INVALID_REQUEST');
    }
  }
  for (const bet of input.bets) {
    if (!isNonNegativeInteger(bet.amount) || !bet.outcomeId) {
      throw new Error('INVALID_REQUEST');
    }
  }
}
