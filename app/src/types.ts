export type Side = "yes" | "no";
export type MarketStatus = "open" | "locked" | "settled" | "void";
export type MarketOutcome = Side | "void";
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

export interface Market {
  id: string;
  title: string;
  description: string;
  deadline: number;
  status: MarketStatus;
  outcome: MarketOutcome | null;
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
  /** Optional: the contract does not currently define this field. Shown when present. */
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
  side: Side;
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
    yesPool: number;
    noPool: number;
    impliedYes: number;
  };
  /** Present when the server returns the full market view (current worker does). */
  marketFull?: Market;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PositionRow {
  marketId: string;
  title: string | null;
  side: Side;
  amount: number;
  status: string;
  payout: number;
  createdAt: number | null;
}

export interface HistoryRow {
  id: string;
  marketId: string;
  title: string | null;
  side: Side;
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
  confidence: number;
  amount: number | null;
  /** The app is dark-only; the id is kept for forward-compatible preferences. */
  theme: string;
}

export interface BetDraft {
  marketId: string;
  side: Side;
  amount: number | null;
  confidence: number;
  updatedAt: number;
}
