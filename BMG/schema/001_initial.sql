PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '2');

CREATE TABLE IF NOT EXISTS capture_runs (
    capture_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL,
    page_url TEXT NOT NULL DEFAULT '',
    page_hash TEXT NOT NULL DEFAULT '',
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    bet_count INTEGER NOT NULL DEFAULT 0 CHECK (bet_count >= 0),
    imported_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY,
    event_uid TEXT NOT NULL UNIQUE,
    source_event_id TEXT NOT NULL DEFAULT '',
    sport TEXT NOT NULL DEFAULT 'unknown',
    title TEXT NOT NULL,
    league TEXT NOT NULL DEFAULT '',
    home_team TEXT NOT NULL DEFAULT '',
    away_team TEXT NOT NULL DEFAULT '',
    scheduled_at TEXT,
    settled_at TEXT,
    visible_status TEXT NOT NULL DEFAULT '',
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    raw_state_text TEXT NOT NULL DEFAULT '',
    raw_finished_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_schedule ON events (scheduled_at, sport);
CREATE INDEX IF NOT EXISTS idx_events_source_id ON events (source_event_id);

CREATE TABLE IF NOT EXISTS markets (
    market_id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    market_key TEXT NOT NULL,
    name TEXT NOT NULL,
    market_type TEXT NOT NULL DEFAULT 'other',
    period TEXT NOT NULL DEFAULT '',
    captured_as_complete INTEGER NOT NULL DEFAULT 0 CHECK (captured_as_complete IN (0, 1)),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (event_id, market_key)
);

CREATE INDEX IF NOT EXISTS idx_markets_event ON markets (event_id);

CREATE TABLE IF NOT EXISTS market_captures (
    capture_id TEXT NOT NULL REFERENCES capture_runs(capture_id) ON DELETE CASCADE,
    market_id INTEGER NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
    captured_as_complete INTEGER NOT NULL DEFAULT 0 CHECK (captured_as_complete IN (0, 1)),
    PRIMARY KEY (capture_id, market_id)
);

CREATE TABLE IF NOT EXISTS selections (
    selection_id INTEGER PRIMARY KEY,
    market_id INTEGER NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
    selection_key TEXT NOT NULL,
    name TEXT NOT NULL,
    raw_name TEXT NOT NULL DEFAULT '',
    handicap REAL,
    line REAL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (market_id, selection_key)
);

CREATE INDEX IF NOT EXISTS idx_selections_market ON selections (market_id);

CREATE TABLE IF NOT EXISTS odds_observations (
    odds_observation_id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES capture_runs(capture_id) ON DELETE CASCADE,
    selection_id INTEGER NOT NULL REFERENCES selections(selection_id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    odds_decimal REAL NOT NULL CHECK (odds_decimal > 0),
    suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    UNIQUE (capture_id, selection_id)
);

CREATE INDEX IF NOT EXISTS idx_odds_selection_time
    ON odds_observations (selection_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS event_outcomes (
    event_outcome_id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES capture_runs(capture_id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    home_score REAL,
    away_score REAL,
    winner TEXT NOT NULL DEFAULT '',
    raw_score TEXT NOT NULL DEFAULT '',
    UNIQUE (capture_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_event_time
    ON event_outcomes (event_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS bets (
    external_bet_id TEXT PRIMARY KEY,
    capture_id TEXT REFERENCES capture_runs(capture_id) ON DELETE SET NULL,
    event_id INTEGER REFERENCES events(event_id) ON DELETE SET NULL,
    market_id INTEGER REFERENCES markets(market_id) ON DELETE SET NULL,
    selection_id INTEGER REFERENCES selections(selection_id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'win', 'loss', 'refund', 'unknown')),
    stake INTEGER NOT NULL CHECK (stake >= 0 AND stake <= 1000000000),
    odds_decimal REAL CHECK (odds_decimal IS NULL OR odds_decimal > 0),
    payout INTEGER CHECK (payout IS NULL OR payout >= 0),
    profit INTEGER,
    settled_at TEXT,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    raw_text TEXT NOT NULL DEFAULT '',
    raw_selection_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_bets_event_status ON bets (event_id, status);
CREATE INDEX IF NOT EXISTS idx_bets_last_seen ON bets (last_observed_at DESC);
CREATE TABLE IF NOT EXISTS history_event_details (
    detail_id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT 'unknown',
    title TEXT NOT NULL DEFAULT '',
    market_count INTEGER NOT NULL DEFAULT 0 CHECK (market_count >= 0),
    selection_count INTEGER NOT NULL DEFAULT 0 CHECK (selection_count >= 0),
    additional_expansion_passes INTEGER NOT NULL DEFAULT 0 CHECK (additional_expansion_passes >= 0),
    additional_controls_remaining INTEGER NOT NULL DEFAULT 0 CHECK (additional_controls_remaining >= 0),
    raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_details_event
    ON history_event_details (source_event_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS bankroll_snapshots (
    bankroll_snapshot_id INTEGER PRIMARY KEY,
    observed_at TEXT NOT NULL,
    wallet INTEGER NOT NULL DEFAULT 0 CHECK (wallet >= 0),
    bookie INTEGER NOT NULL DEFAULT 0 CHECK (bookie >= 0),
    stocks INTEGER NOT NULL DEFAULT 0 CHECK (stocks >= 0),
    other_liquid INTEGER NOT NULL DEFAULT 0 CHECK (other_liquid >= 0),
    total INTEGER NOT NULL CHECK (total >= 0),
    source TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_bankroll_time ON bankroll_snapshots (observed_at DESC);

PRAGMA user_version = 2;
