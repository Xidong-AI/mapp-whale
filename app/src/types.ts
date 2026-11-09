export type Side = "yes" | "no";
export type MarketStatus = "open" | "locked" | "settling" | "settled" | "void";
export type SettleMode = "first_match" | "exclusive" | "manual";
export type LeaderboardType = "assets" | "accuracy";

export interface PublicConfig {
  productName: string;
  season: string;
  betMin: number;
  maxBetRatio: number;
  dailyChips: number;
  initialChips: number;
  pageSize?: number;
  accuracyMinSamples?: number;
  serverTime: number;
}

export interface Outcome {
  id: string;
  label: string;
  pool: number;
  seed: number;
  implied: number;
  payout: number;
  /** Optional: the worker view reports watch progress per outcome. */
  hitCount?: number;
  firstSeenAt?: number | null;
}

export interface Market {
  id: string;
  title: string;
  description: string;
  deadline: number;
  status: MarketStatus;
  settleMode: SettleMode;
  fallbackOutcomeId: string | null;
  winningOutcomeId: string | null;
  totalPool: number;
  outcomes: Outcome[];
  settledAt: number | null;
  settleReason: string | null;
  participants?: number | null;
}

export interface MarketPage {
  items: Market[];
  nextCursor: string | null;
}

export interface MeStats {
  staked: number;
  payout: number;
  correct: number;
  total: number;
  accuracy: number | null;
}

export interface Me {
  displayName: string | null;
  chips: number;
  season: string;
  canClaim: boolean;
  nextClaimAt: number | null;
  stats: MeStats;
}

export interface ClaimResult {
  claimed: boolean;
  chips: number;
  amount: number;
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  chips: number;
  accuracy: number | null;
  samples: number | null;
}

export interface Leaderboard {
  season: string;
  type: LeaderboardType;
  items: LeaderboardEntry[];
}

export interface MyRank {
  rank: number | null;
  samples: number | null;
  season?: string;
  type?: LeaderboardType;
}

export interface BetInput {
  marketId: string;
  outcomeId: string;
  amount: number;
  confidence: number;
  clientRequestId: string;
  /** Client-reported display name for the first request; not an identity. */
  displayName?: string;
}

export interface BetResult {
  betId: string;
  chips: number;
  market: {
    id: string;
    totalPool: number;
    outcomes: Outcome[];
  };
  /** Present when the server returns the full market view. */
  marketFull?: Market;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PositionRow {
  marketId: string;
  title: string | null;
  outcomeId: string;
  outcomeLabel: string;
  amount: number;
  status: string;
  payout: number;
  createdAt: number | null;
}

export interface HistoryRow {
  id: string;
  marketId: string;
  title: string | null;
  outcomeId: string;
  outcomeLabel: string;
  amount: number;
  status: string;
  payout: number;
  createdAt: number | null;
  season: string | null;
}

export type ToastTone = "info" | "success" | "error";

export interface Prefs {
  tab: "markets" | "leaderboard" | "me";
  lastMarketId: string | null;
  lastOutcomeId: string | null;
  confidence: number;
  amount: number | null;
  theme: string;
}

export interface BetDraft {
  marketId: string;
  outcomeId: string;
  amount: number | null;
  confidence: number;
  updatedAt: number;
}
