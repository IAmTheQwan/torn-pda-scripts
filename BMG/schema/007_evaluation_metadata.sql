PRAGMA foreign_keys = ON;

-- Closing-snapshot evidence is added by the guarded Python migration because
-- SQLite does not support portable ADD COLUMN IF NOT EXISTS. This numbered
-- checkpoint keeps fresh and existing databases on the same schema version.
INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '7');
PRAGMA user_version = 7;
