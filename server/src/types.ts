// 环境绑定与共享类型（契约第 4 节）

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

export interface MarketRow {
  id: string;
  title: string;
  description: string;
  condition_json: string;
  deadline: number;
  status: 'open' | 'locked' | 'settling' | 'settled' | 'void';
  outcome: 'yes' | 'no' | 'void' | null;
  yes_pool: number;
  no_pool: number;
  seed_yes: number;
  seed_no: number;
  hit_count: number;
  first_seen_at: number | null;
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

export interface BetRow {
  id: string;
  client_request_id: string;
  market_id: string;
  user_key: string;
  side: 'yes' | 'no';
  amount: number;
  confidence: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout: number;
  season: string;
  created_at: number;
}

// 统一 API 错误码（契约第 7 节）
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'MARKET_NOT_OPEN'
  | 'BET_TOO_SMALL'
  | 'BET_TOO_LARGE'
  | 'INVALID_SIDE'
  | 'INVALID_CONFIDENCE'
  | 'INSUFFICIENT_CHIPS'
  | 'CONFLICT'
  | 'INTERNAL';
