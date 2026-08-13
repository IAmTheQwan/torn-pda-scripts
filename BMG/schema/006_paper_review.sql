PRAGMA foreign_keys = ON;

-- A forecast or decision is only meaningful when the available market surface
-- is retained. One row is written for every Torn market visible in the source
-- capture, including markets that cannot be compared safely.
CREATE TABLE IF NOT EXISTS market_review_coverage (
    coverage_id INTEGER PRIMARY KEY,
    forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(forecast_run_id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    market_id INTEGER NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
    capture_id TEXT NOT NULL REFERENCES capture_runs(capture_id) ON DELETE CASCADE,
    match_id INTEGER REFERENCES sports_matches(match_id) ON DELETE SET NULL,
    market_name TEXT NOT NULL,
    market_type TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    torn_selection_count INTEGER NOT NULL DEFAULT 0 CHECK (torn_selection_count >= 0),
    torn_capture_complete INTEGER NOT NULL DEFAULT 0 CHECK (torn_capture_complete IN (0, 1)),
    exhaustive INTEGER NOT NULL DEFAULT 0 CHECK (exhaustive IN (0, 1)),
    external_market_name TEXT NOT NULL DEFAULT '',
    external_bookmaker_count INTEGER NOT NULL DEFAULT 0 CHECK (external_bookmaker_count >= 0),
    status TEXT NOT NULL CHECK (status IN (
        'eligible',
        'partial_torn',
        'unsupported_market',
        'settlement_mismatch',
        'unmapped_event',
        'no_external_market',
        'insufficient_books',
        'selection_mismatch'
    )),
    details_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (forecast_run_id, event_id, market_id)
);

CREATE INDEX IF NOT EXISTS idx_market_review_coverage_run_status
    ON market_review_coverage (forecast_run_id, status, event_id);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '6');
PRAGMA user_version = 6;
