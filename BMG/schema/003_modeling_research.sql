PRAGMA foreign_keys = ON;

-- Preserve explicit membership in a Torn capture even when an event has no
-- loaded markets. This is required to reconstruct the available slate rather
-- than analyzing only the games that eventually received a wager.
CREATE TABLE IF NOT EXISTS capture_events (
    capture_id TEXT NOT NULL REFERENCES capture_runs(capture_id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    captured_as_complete INTEGER NOT NULL DEFAULT 0 CHECK (captured_as_complete IN (0, 1)),
    PRIMARY KEY (capture_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_capture_events_event
    ON capture_events (event_id, capture_id);

-- A research slate is the candidate pool visible at one decision time. Picks
-- and passes are only comparable when this denominator is retained.
CREATE TABLE IF NOT EXISTS research_slates (
    slate_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT 'football',
    observed_at TEXT NOT NULL,
    capture_complete INTEGER NOT NULL DEFAULT 0 CHECK (capture_complete IN (0, 1)),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    created_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS research_slate_events (
    slate_id TEXT NOT NULL REFERENCES research_slates(slate_id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    capture_id TEXT REFERENCES capture_runs(capture_id) ON DELETE SET NULL,
    match_id INTEGER REFERENCES sports_matches(match_id) ON DELETE SET NULL,
    mapping_status TEXT NOT NULL DEFAULT 'unmapped'
        CHECK (mapping_status IN ('unmapped', 'candidate', 'confirmed', 'rejected')),
    PRIMARY KEY (slate_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_slate_events_match
    ON research_slate_events (match_id, mapping_status);

CREATE TABLE IF NOT EXISTS model_versions (
    model_version_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT 'football',
    algorithm TEXT NOT NULL,
    feature_spec_json TEXT NOT NULL DEFAULT '{}',
    training_cutoff TEXT,
    created_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    notes TEXT NOT NULL DEFAULT '',
    UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS team_rating_snapshots (
    team_rating_snapshot_id INTEGER PRIMARY KEY,
    model_version_id INTEGER NOT NULL REFERENCES model_versions(model_version_id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES sports_teams(team_id) ON DELETE CASCADE,
    competition_id INTEGER REFERENCES sports_competitions(competition_id) ON DELETE SET NULL,
    rated_at TEXT NOT NULL,
    information_cutoff TEXT NOT NULL,
    matches_included INTEGER NOT NULL DEFAULT 0 CHECK (matches_included >= 0),
    elo REAL,
    attack_strength REAL,
    defense_strength REAL,
    uncertainty REAL CHECK (uncertainty IS NULL OR uncertainty >= 0),
    raw_state_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (model_version_id, team_id, competition_id, rated_at)
);

CREATE INDEX IF NOT EXISTS idx_team_ratings_asof
    ON team_rating_snapshots (team_id, rated_at DESC, model_version_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_ratings_identity
    ON team_rating_snapshots (
        model_version_id, team_id, COALESCE(competition_id, -1), rated_at
    );

CREATE TABLE IF NOT EXISTS forecast_runs (
    forecast_run_id TEXT PRIMARY KEY,
    model_version_id INTEGER NOT NULL REFERENCES model_versions(model_version_id),
    slate_id TEXT REFERENCES research_slates(slate_id) ON DELETE SET NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper', 'backtest', 'live')),
    created_at TEXT NOT NULL,
    information_cutoff TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS match_forecasts (
    forecast_id INTEGER PRIMARY KEY,
    forecast_run_id TEXT NOT NULL REFERENCES forecast_runs(forecast_run_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    forecast_key TEXT NOT NULL,
    market_type TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT 'full_time',
    selection_key TEXT NOT NULL,
    selection_name TEXT NOT NULL,
    line REAL,
    predicted_probability REAL NOT NULL CHECK (predicted_probability >= 0 AND predicted_probability <= 1),
    probability_low REAL CHECK (probability_low IS NULL OR (probability_low >= 0 AND probability_low <= 1)),
    probability_high REAL CHECK (probability_high IS NULL OR (probability_high >= 0 AND probability_high <= 1)),
    fair_odds REAL CHECK (fair_odds IS NULL OR fair_odds >= 1),
    calibration_sample_size INTEGER CHECK (calibration_sample_size IS NULL OR calibration_sample_size >= 0),
    feature_as_of TEXT NOT NULL,
    features_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (forecast_run_id, match_id, forecast_key),
    CHECK (probability_low IS NULL OR probability_high IS NULL OR probability_low <= probability_high)
);

CREATE INDEX IF NOT EXISTS idx_match_forecasts_match
    ON match_forecasts (match_id, feature_as_of DESC);

-- Every considered selection receives a decision, including passes. This
-- prevents retrospective analysis from silently dropping unattractive games.
CREATE TABLE IF NOT EXISTS decision_records (
    decision_id TEXT PRIMARY KEY,
    forecast_id INTEGER NOT NULL REFERENCES match_forecasts(forecast_id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(event_id) ON DELETE SET NULL,
    selection_id INTEGER REFERENCES selections(selection_id) ON DELETE SET NULL,
    bankroll_snapshot_id INTEGER REFERENCES bankroll_snapshots(bankroll_snapshot_id) ON DELETE SET NULL,
    decided_at TEXT NOT NULL,
    bookmaker TEXT NOT NULL DEFAULT '',
    observed_odds REAL CHECK (observed_odds IS NULL OR observed_odds > 0),
    reference_odds REAL CHECK (reference_odds IS NULL OR reference_odds > 0),
    implied_probability REAL CHECK (implied_probability IS NULL OR (implied_probability >= 0 AND implied_probability <= 1)),
    conservative_probability REAL CHECK (conservative_probability IS NULL OR (conservative_probability >= 0 AND conservative_probability <= 1)),
    edge REAL,
    expected_value REAL,
    action TEXT NOT NULL CHECK (action IN ('paper_pick', 'bet', 'pass', 'reject')),
    recommended_stake INTEGER NOT NULL DEFAULT 0 CHECK (recommended_stake >= 0 AND recommended_stake <= 1000000000),
    actual_bet_id TEXT REFERENCES bets(external_bet_id) ON DELETE SET NULL,
    stake_rule TEXT NOT NULL DEFAULT '',
    rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_decisions_time_action
    ON decision_records (decided_at DESC, action);

-- Settlement is source/ruleset specific. It is stored instead of inferred at
-- query time so ordinary-time, overtime, void and refund rules stay auditable.
CREATE TABLE IF NOT EXISTS match_market_settlements (
    settlement_id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    settlement_key TEXT NOT NULL,
    market_type TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT 'full_time',
    selection_key TEXT NOT NULL,
    line REAL,
    ruleset TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'push', 'void', 'unknown')),
    settled_at TEXT NOT NULL,
    source TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (match_id, settlement_key, ruleset)
);

CREATE TABLE IF NOT EXISTS forecast_evaluations (
    decision_id TEXT PRIMARY KEY REFERENCES decision_records(decision_id) ON DELETE CASCADE,
    settlement_id INTEGER REFERENCES match_market_settlements(settlement_id) ON DELETE SET NULL,
    evaluated_at TEXT NOT NULL,
    actual_outcome REAL CHECK (actual_outcome IS NULL OR (actual_outcome >= 0 AND actual_outcome <= 1)),
    realized_profit INTEGER,
    brier_score REAL CHECK (brier_score IS NULL OR brier_score >= 0),
    log_loss REAL CHECK (log_loss IS NULL OR log_loss >= 0),
    closing_odds REAL CHECK (closing_odds IS NULL OR closing_odds > 0),
    closing_line_value REAL,
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS backtest_runs (
    backtest_run_id TEXT PRIMARY KEY,
    model_version_id INTEGER NOT NULL REFERENCES model_versions(model_version_id),
    created_at TEXT NOT NULL,
    training_start TEXT,
    training_end TEXT NOT NULL,
    test_start TEXT NOT NULL,
    test_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'running', 'complete', 'failed')),
    config_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '',
    CHECK (training_end < test_start),
    CHECK (test_start <= test_end)
);

CREATE TABLE IF NOT EXISTS backtest_metrics (
    backtest_run_id TEXT NOT NULL REFERENCES backtest_runs(backtest_run_id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL DEFAULT 'overall',
    scope_value TEXT NOT NULL DEFAULT '',
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
    lower_bound REAL,
    upper_bound REAL,
    PRIMARY KEY (backtest_run_id, scope_type, scope_value, metric_name)
);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '4');
PRAGMA user_version = 4;
