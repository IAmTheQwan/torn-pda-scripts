PRAGMA foreign_keys = ON;

-- Immutable fixture state at each reference capture. This prevents a later
-- live/final update from leaking backwards into a morning decision review.
CREATE TABLE IF NOT EXISTS match_status_observations (
    capture_id TEXT NOT NULL REFERENCES reference_capture_runs(capture_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    scheduled_at TEXT,
    status TEXT NOT NULL DEFAULT '',
    home_score REAL,
    away_score REAL,
    provider_status_json TEXT NOT NULL DEFAULT '{}',
    raw_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (capture_id, match_id)
);

CREATE INDEX IF NOT EXISTS idx_match_status_asof
    ON match_status_observations (match_id, observed_at DESC);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '8');
PRAGMA user_version = 8;
