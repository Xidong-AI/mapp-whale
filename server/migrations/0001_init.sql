-- 预言鲸 · 初始化（契约第 5、6 节）

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_key      TEXT PRIMARY KEY,          -- `${iss}#${sub}`
  display_name  TEXT,                      -- 客户端首次上报，仅展示，非权威身份
  chips         INTEGER NOT NULL DEFAULT 0,
  last_claim_day TEXT,                     -- Asia/Shanghai 的 YYYY-MM-DD
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  condition_json TEXT NOT NULL,
  deadline       INTEGER NOT NULL,         -- epoch ms
  status         TEXT NOT NULL DEFAULT 'open', -- open|locked|settled|void
  outcome        TEXT,                     -- yes|no|void
  yes_pool       INTEGER NOT NULL DEFAULT 0,
  no_pool        INTEGER NOT NULL DEFAULT 0,
  seed_yes       INTEGER NOT NULL DEFAULT 0,
  seed_no        INTEGER NOT NULL DEFAULT 0,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER,
  settled_at     INTEGER,
  settle_reason  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
  id                TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  market_id         TEXT NOT NULL,
  user_key          TEXT NOT NULL,
  side              TEXT NOT NULL,         -- yes|no
  amount            INTEGER NOT NULL,
  confidence        INTEGER NOT NULL,      -- -100..100
  status            TEXT NOT NULL DEFAULT 'open', -- open|won|lost|refunded
  payout            INTEGER NOT NULL DEFAULT 0,
  season            TEXT NOT NULL,         -- YYYY-MM
  created_at        INTEGER NOT NULL,
  UNIQUE (user_key, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id, status);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_season ON bets(season);

CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key   TEXT NOT NULL,
  market_id  TEXT,
  bet_id     TEXT,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,                -- claim|bet|payout|refund|adjust
  season     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);

CREATE TABLE IF NOT EXISTS season_stats (
  season      TEXT NOT NULL,
  user_key    TEXT NOT NULL,
  start_chips INTEGER NOT NULL,
  end_chips   INTEGER NOT NULL,
  staked      INTEGER NOT NULL DEFAULT 0,
  payout      INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  peak_chips  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, user_key)
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);

-- config 默认值（契约第 6 节）。season 用 UTC+8（上海无夏令时）计算当前月份。
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES
  ('product_name', '预言鲸', strftime('%s','now') * 1000),
  ('season', strftime('%Y-%m', 'now', '+8 hours'), strftime('%s','now') * 1000),
  ('initial_chips', '1000', strftime('%s','now') * 1000),
  ('daily_chips', '100', strftime('%s','now') * 1000),
  ('bet_min', '10', strftime('%s','now') * 1000),
  ('max_bet_ratio', '0.5', strftime('%s','now') * 1000),
  ('seed_per_side', '5000', strftime('%s','now') * 1000),
  ('models_url', 'https://api.deepseek.com/models', strftime('%s','now') * 1000),
  ('poll_confirmations', '2', strftime('%s','now') * 1000),
  ('accuracy_min_samples', '5', strftime('%s','now') * 1000),
  ('page_size', '20', strftime('%s','now') * 1000),
  ('retain_bet_seasons', '2', strftime('%s','now') * 1000),
  ('retain_ledger_days', '90', strftime('%s','now') * 1000),
  ('retain_audit_days', '180', strftime('%s','now') * 1000);
