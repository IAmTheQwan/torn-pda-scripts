PRAGMA foreign_keys = ON;

-- The column itself is added by the guarded Python migration so existing and
-- fresh databases follow the same idempotent path. A half-win/half-loss is
-- stored as win/loss plus settlement_fraction=0.5.
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '9');
PRAGMA user_version = 9;
