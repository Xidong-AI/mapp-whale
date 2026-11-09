// 环境绑定与共享类型（契约 v2 第 2 节：多结果市场）

export interface Env {
  DB: D1Database;
  DEEPSEEK_API_KEY: string;
  ADMIN_TOKEN: string;
  PLATFORM_ISSUER: string;
  PLATFORM_APP_ID: string;
  PLATFORM_AUDIENCE?: string;
  ALLOWED_ORIGINS?: string;
  DEEPSEEK_MODELS_URL?: string;
}

export type MarketStatus = 'open' | 'locked' | 'settling' | 'settled' | 'void';

export type SettleMode = 'first_match' | 'exclusive' | 'manual';

export interface MarketRow {
  id: string;
  title: string;
  description: string;
  deadline: number;
  status: MarketStatus;
  settle_mode: SettleMode;
  fallback_outcome_id: string | null;
  winning_outcome_id: string | null;
  settled_at: number | null;
  settle_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserRow {
  user_key: string;
  display_name: string | null;
  chips: number;
  last_claim_day: string | null;
  created_at: number;
  updated_at: number;
}

export interface OutcomeRow {
  id: string;
  market_id: string;
  label: string;
  condition_json: string;
  pool: number;
  seed: number;
  sort_order: number;
  hit_count: number;
  first_seen_at: number | null;
  created_at: number;
}

export interface BetRow {
  id: string;
  client_request_id: string;
  market_id: string;
  outcome_id: string;
  user_key: string;
  amount: number;
  confidence: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout: number;
  season: string;
  created_at: number;
}

// 统一 API 错误码（契约 v2 第 5 节）
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INVALID_CONDITION'
  | 'MARKET_NOT_OPEN'
  | 'BET_TOO_SMALL'
  | 'BET_TOO_LARGE'
  | 'INVALID_OUTCOME'
  | 'INVALID_CONFIDENCE'
  | 'INSUFFICIENT_CHIPS'
  | 'CONFLICT'
  | 'INTERNAL';
