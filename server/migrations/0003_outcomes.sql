-- 多结果市场：重建 markets/outcomes/bets。生产当前 0 笔下注，可安全重建。
DROP TRIGGER IF EXISTS trg_bets_market_open;
DROP TABLE IF EXISTS bets;
DROP TABLE IF EXISTS markets;

CREATE TABLE markets (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  deadline            INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  settle_mode         TEXT NOT NULL DEFAULT 'exclusive',
  fallback_outcome_id TEXT,
  winning_outcome_id  TEXT,
  settled_at          INTEGER,
  settle_reason       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE outcomes (
  id             TEXT NOT NULL,
  market_id      TEXT NOT NULL,
  label          TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  pool           INTEGER NOT NULL DEFAULT 0,
  seed           INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (market_id, id)
);
CREATE INDEX idx_outcomes_market ON outcomes(market_id, sort_order);

CREATE TABLE bets (
  id                TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  market_id         TEXT NOT NULL,
  outcome_id        TEXT NOT NULL,
  user_key          TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  confidence        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  payout            INTEGER NOT NULL DEFAULT 0,
  season            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (user_key, client_request_id)
);
CREATE INDEX idx_bets_market ON bets(market_id, status);
CREATE INDEX idx_bets_user ON bets(user_key, created_at DESC);
CREATE INDEX idx_bets_season ON bets(season);

ALTER TABLE ledger ADD COLUMN outcome_id TEXT;

CREATE TRIGGER trg_bets_market_open
BEFORE INSERT ON bets
WHEN (SELECT status FROM markets WHERE id = NEW.market_id) IS NOT 'open'
  OR (SELECT deadline FROM markets WHERE id = NEW.market_id) <= CAST(strftime('%s','now') AS INTEGER) * 1000
  OR NOT EXISTS (SELECT 1 FROM outcomes WHERE market_id = NEW.market_id AND id = NEW.outcome_id)
BEGIN
  SELECT RAISE(ABORT, 'MARKET_CLOSED');
END;
