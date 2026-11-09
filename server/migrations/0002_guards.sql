-- 资金原子性守卫（P0）：余额不为负、市场开放才可下注。

CREATE TRIGGER IF NOT EXISTS trg_users_chips_nonnegative
BEFORE UPDATE OF chips ON users
WHEN NEW.chips < 0
BEGIN
  SELECT RAISE(ABORT, 'NEGATIVE_CHIPS');
END;

CREATE TRIGGER IF NOT EXISTS trg_bets_market_open
BEFORE INSERT ON bets
WHEN (SELECT status FROM markets WHERE id = NEW.market_id) IS NOT 'open'
  OR (SELECT deadline FROM markets WHERE id = NEW.market_id) <= CAST(strftime('%s','now') AS INTEGER) * 1000
BEGIN
  SELECT RAISE(ABORT, 'MARKET_CLOSED');
END;
