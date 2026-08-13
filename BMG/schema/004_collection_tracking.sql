PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS collection_plans (
    plan_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT 'football',
    history_years INTEGER NOT NULL DEFAULT 3 CHECK (history_years > 0),
    source TEXT NOT NULL DEFAULT 'flashscore-visible-browser',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'complete', 'cancelled')),
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS collection_targets (
    target_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES collection_plans(plan_id) ON DELETE CASCADE,
    torn_league_label TEXT NOT NULL,
    competition_family TEXT NOT NULL,
    jurisdiction TEXT NOT NULL DEFAULT '',
    wager_count INTEGER NOT NULL DEFAULT 0 CHECK (wager_count >= 0),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    staked INTEGER NOT NULL DEFAULT 0 CHECK (staked >= 0),
    linked_wager_count INTEGER NOT NULL DEFAULT 0 CHECK (linked_wager_count >= 0),
    priority_score REAL NOT NULL DEFAULT 0,
    planned_seasons INTEGER NOT NULL DEFAULT 3 CHECK (planned_seasons > 0),
    source_competition_id TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'mapped', 'collecting', 'captured', 'imported', 'reconciled', 'blocked', 'skipped')),
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (plan_id, torn_league_label)
);

CREATE INDEX IF NOT EXISTS idx_collection_targets_priority
    ON collection_targets (plan_id, status, priority_score DESC);

CREATE TABLE IF NOT EXISTS collection_target_league_labels (
    target_id TEXT NOT NULL REFERENCES collection_targets(target_id) ON DELETE CASCADE,
    torn_league_label TEXT NOT NULL,
    wager_count INTEGER NOT NULL DEFAULT 0 CHECK (wager_count >= 0),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    staked INTEGER NOT NULL DEFAULT 0 CHECK (staked >= 0),
    linked_wager_count INTEGER NOT NULL DEFAULT 0 CHECK (linked_wager_count >= 0),
    PRIMARY KEY (target_id, torn_league_label)
);

CREATE TABLE IF NOT EXISTS collection_runs (
    run_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES collection_plans(plan_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'foreground'
        CHECK (mode IN ('foreground', 'import', 'reconciliation', 'benchmark')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    active_seconds REAL CHECK (active_seconds IS NULL OR active_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'complete', 'partial', 'failed', 'cancelled')),
    pages_visited INTEGER NOT NULL DEFAULT 0 CHECK (pages_visited >= 0),
    matches_captured INTEGER NOT NULL DEFAULT 0 CHECK (matches_captured >= 0),
    standings_rows INTEGER NOT NULL DEFAULT 0 CHECK (standings_rows >= 0),
    stat_rows INTEGER NOT NULL DEFAULT 0 CHECK (stat_rows >= 0),
    h2h_rows INTEGER NOT NULL DEFAULT 0 CHECK (h2h_rows >= 0),
    bytes_exported INTEGER NOT NULL DEFAULT 0 CHECK (bytes_exported >= 0),
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS collection_run_targets (
    run_id TEXT NOT NULL REFERENCES collection_runs(run_id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES collection_targets(target_id) ON DELETE CASCADE,
    season_name TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    active_seconds REAL CHECK (active_seconds IS NULL OR active_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'complete', 'partial', 'failed', 'skipped')),
    pages_visited INTEGER NOT NULL DEFAULT 0 CHECK (pages_visited >= 0),
    matches_captured INTEGER NOT NULL DEFAULT 0 CHECK (matches_captured >= 0),
    standings_rows INTEGER NOT NULL DEFAULT 0 CHECK (standings_rows >= 0),
    stat_rows INTEGER NOT NULL DEFAULT 0 CHECK (stat_rows >= 0),
    h2h_rows INTEGER NOT NULL DEFAULT 0 CHECK (h2h_rows >= 0),
    notes TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, target_id, season_name)
);

CREATE TABLE IF NOT EXISTS collection_checkpoints (
    checkpoint_id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES collection_runs(run_id) ON DELETE CASCADE,
    target_id TEXT REFERENCES collection_targets(target_id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    phase TEXT NOT NULL,
    page_url TEXT NOT NULL DEFAULT '',
    items_visible INTEGER NOT NULL DEFAULT 0 CHECK (items_visible >= 0),
    elapsed_seconds REAL NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
    note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_collection_checkpoints_run
    ON collection_checkpoints (run_id, observed_at);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '5');
PRAGMA user_version = 5;
