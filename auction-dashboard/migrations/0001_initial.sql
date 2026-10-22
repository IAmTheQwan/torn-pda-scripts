PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auction_sales (
  listing_id INTEGER PRIMARY KEY,
  ended_at INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  item_uid INTEGER,
  item_name TEXT NOT NULL,
  item_type TEXT,
  item_sub_type TEXT,
  rarity TEXT,
  damage REAL,
  accuracy REAL,
  armor REAL,
  quality REAL,
  price INTEGER NOT NULL,
  bids INTEGER NOT NULL DEFAULT 0,
  bonus_signature TEXT NOT NULL DEFAULT '',
  bonus1_id INTEGER,
  bonus1_title TEXT,
  bonus1_value REAL,
  bonus2_id INTEGER,
  bonus2_title TEXT,
  bonus2_value REAL,
  ingested_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_auction_sales_ended
  ON auction_sales (ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_sales_item_ended
  ON auction_sales (item_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_sales_name
  ON auction_sales (item_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS daily_item_rollups (
  day TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  rarity TEXT NOT NULL DEFAULT '',
  bonus_signature TEXT NOT NULL DEFAULT '',
  sale_count INTEGER NOT NULL DEFAULT 0,
  price_total INTEGER NOT NULL DEFAULT 0,
  min_price INTEGER NOT NULL,
  max_price INTEGER NOT NULL,
  PRIMARY KEY (day, item_id, rarity, bonus_signature)
);

CREATE INDEX IF NOT EXISTS idx_daily_rollups_item_day
  ON daily_item_rollups (item_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_daily_rollups_day
  ON daily_item_rollups (day DESC);

CREATE TRIGGER IF NOT EXISTS trg_auction_sales_rollup
AFTER INSERT ON auction_sales
BEGIN
  INSERT INTO daily_item_rollups (
    day, item_id, item_name, rarity, bonus_signature,
    sale_count, price_total, min_price, max_price
  ) VALUES (
    date(NEW.ended_at, 'unixepoch'),
    NEW.item_id,
    NEW.item_name,
    COALESCE(NEW.rarity, ''),
    COALESCE(NEW.bonus_signature, ''),
    1,
    NEW.price,
    NEW.price,
    NEW.price
  )
  ON CONFLICT(day, item_id, rarity, bonus_signature) DO UPDATE SET
    item_name = excluded.item_name,
    sale_count = daily_item_rollups.sale_count + 1,
    price_total = daily_item_rollups.price_total + excluded.price_total,
    min_price = MIN(daily_item_rollups.min_price, excluded.min_price),
    max_price = MAX(daily_item_rollups.max_price, excluded.max_price);
END;

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS snapshot_batches (
  id TEXT PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  source_url TEXT,
  source_page INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshot_batches_captured
  ON snapshot_batches (captured_at DESC);

CREATE TABLE IF NOT EXISTS active_snapshots (
  batch_id TEXT NOT NULL,
  listing_key TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  item_id INTEGER,
  item_uid INTEGER,
  item_name TEXT NOT NULL,
  rarity TEXT,
  damage REAL,
  accuracy REAL,
  armor REAL,
  quality REAL,
  current_bid INTEGER,
  bids INTEGER,
  bonus_signature TEXT NOT NULL DEFAULT '',
  bonuses_json TEXT NOT NULL DEFAULT '[]',
  time_text TEXT,
  ends_at INTEGER,
  source_url TEXT,
  PRIMARY KEY (batch_id, listing_key),
  FOREIGN KEY (batch_id) REFERENCES snapshot_batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_active_snapshots_captured
  ON active_snapshots (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_snapshots_item
  ON active_snapshots (item_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_hash
  ON device_tokens (token_hash);
