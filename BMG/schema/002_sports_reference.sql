PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reference_capture_runs (
    capture_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL,
    page_url TEXT NOT NULL DEFAULT '',
    display_timezone TEXT NOT NULL DEFAULT '',
    competition_count INTEGER NOT NULL DEFAULT 0 CHECK (competition_count >= 0),
    season_count INTEGER NOT NULL DEFAULT 0 CHECK (season_count >= 0),
    match_count INTEGER NOT NULL DEFAULT 0 CHECK (match_count >= 0),
    imported_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sports_competitions (
    competition_id INTEGER PRIMARY KEY,
    sport TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (sport, country, canonical_name)
);

CREATE TABLE IF NOT EXISTS competition_sources (
    competition_source_id INTEGER PRIMARY KEY,
    competition_id INTEGER NOT NULL REFERENCES sports_competitions(competition_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_competition_id TEXT NOT NULL,
    source_slug TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (source, source_competition_id)
);

CREATE TABLE IF NOT EXISTS competition_seasons (
    season_id INTEGER PRIMARY KEY,
    competition_id INTEGER NOT NULL REFERENCES sports_competitions(competition_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (competition_id, name)
);

CREATE TABLE IF NOT EXISTS season_sources (
    season_source_id INTEGER PRIMARY KEY,
    season_id INTEGER NOT NULL REFERENCES competition_seasons(season_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_season_id TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (source, source_season_id)
);

CREATE TABLE IF NOT EXISTS sports_teams (
    team_id INTEGER PRIMARY KEY,
    sport TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (sport, country, canonical_name)
);

CREATE TABLE IF NOT EXISTS team_sources (
    team_source_id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES sports_teams(team_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_team_id TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (source, source_team_id)
);

CREATE TABLE IF NOT EXISTS team_aliases (
    team_alias_id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES sports_teams(team_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    alias TEXT NOT NULL,
    canonical_alias TEXT NOT NULL,
    UNIQUE (source, canonical_alias, team_id)
);

CREATE INDEX IF NOT EXISTS idx_team_alias_lookup
    ON team_aliases (source, canonical_alias);

CREATE TABLE IF NOT EXISTS season_teams (
    season_id INTEGER NOT NULL REFERENCES competition_seasons(season_id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES sports_teams(team_id) ON DELETE CASCADE,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    PRIMARY KEY (season_id, team_id)
);

CREATE TABLE IF NOT EXISTS sports_matches (
    match_id INTEGER PRIMARY KEY,
    sport TEXT NOT NULL,
    competition_id INTEGER REFERENCES sports_competitions(competition_id) ON DELETE SET NULL,
    season_id INTEGER REFERENCES competition_seasons(season_id) ON DELETE SET NULL,
    home_team_id INTEGER NOT NULL REFERENCES sports_teams(team_id),
    away_team_id INTEGER NOT NULL REFERENCES sports_teams(team_id),
    round TEXT NOT NULL DEFAULT '',
    scheduled_at TEXT,
    scheduled_date TEXT,
    raw_scheduled_local TEXT NOT NULL DEFAULT '',
    display_timezone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    home_score REAL,
    away_score REAL,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    CHECK (home_team_id <> away_team_id)
);

CREATE INDEX IF NOT EXISTS idx_sports_matches_schedule
    ON sports_matches (scheduled_at, scheduled_date, sport);
CREATE INDEX IF NOT EXISTS idx_sports_matches_teams
    ON sports_matches (home_team_id, away_team_id, scheduled_date);

CREATE TABLE IF NOT EXISTS match_sources (
    match_source_id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_match_id TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (source, source_match_id)
);

CREATE TABLE IF NOT EXISTS standings_snapshots (
    standings_snapshot_id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES reference_capture_runs(capture_id) ON DELETE CASCADE,
    season_id INTEGER NOT NULL REFERENCES competition_seasons(season_id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    UNIQUE (capture_id, season_id, scope)
);

CREATE TABLE IF NOT EXISTS standing_rows (
    standings_snapshot_id INTEGER NOT NULL REFERENCES standings_snapshots(standings_snapshot_id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES sports_teams(team_id),
    rank INTEGER,
    played INTEGER,
    wins INTEGER,
    draws INTEGER,
    losses INTEGER,
    goals_for INTEGER,
    goals_against INTEGER,
    goal_difference INTEGER,
    points INTEGER,
    qualification TEXT NOT NULL DEFAULT '',
    form_json TEXT NOT NULL DEFAULT '[]',
    raw_json TEXT NOT NULL,
    PRIMARY KEY (standings_snapshot_id, team_id)
);

CREATE TABLE IF NOT EXISTS match_stats (
    match_stat_id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES reference_capture_runs(capture_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    period TEXT NOT NULL DEFAULT 'overall',
    stat_group TEXT NOT NULL DEFAULT '',
    stat_key TEXT NOT NULL,
    stat_name TEXT NOT NULL,
    home_raw TEXT NOT NULL DEFAULT '',
    away_raw TEXT NOT NULL DEFAULT '',
    home_value REAL,
    away_value REAL,
    home_numerator REAL,
    home_denominator REAL,
    away_numerator REAL,
    away_denominator REAL,
    observed_at TEXT NOT NULL,
    UNIQUE (capture_id, match_id, period, stat_group, stat_key)
);

CREATE INDEX IF NOT EXISTS idx_match_stats_match
    ON match_stats (match_id, period, stat_key);

CREATE TABLE IF NOT EXISTS h2h_snapshots (
    h2h_snapshot_id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES reference_capture_runs(capture_id) ON DELETE CASCADE,
    context_match_id INTEGER REFERENCES sports_matches(match_id) ON DELETE SET NULL,
    left_team_id INTEGER NOT NULL REFERENCES sports_teams(team_id),
    right_team_id INTEGER NOT NULL REFERENCES sports_teams(team_id),
    scope TEXT NOT NULL DEFAULT 'overall',
    observed_at TEXT NOT NULL,
    UNIQUE (capture_id, context_match_id, left_team_id, right_team_id, scope)
);

CREATE TABLE IF NOT EXISTS h2h_snapshot_matches (
    h2h_snapshot_id INTEGER NOT NULL REFERENCES h2h_snapshots(h2h_snapshot_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (h2h_snapshot_id, ordinal),
    UNIQUE (h2h_snapshot_id, match_id)
);

CREATE TABLE IF NOT EXISTS event_match_links (
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    link_method TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (event_id, match_id)
);

-- Future external odds observations attach to canonical matches. Torn odds remain
-- in markets/selections/odds_observations and join through event_match_links.
CREATE TABLE IF NOT EXISTS match_markets (
    match_market_id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_market_key TEXT NOT NULL,
    name TEXT NOT NULL,
    market_type TEXT NOT NULL DEFAULT 'other',
    period TEXT NOT NULL DEFAULT '',
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE (match_id, source, source_market_key)
);

CREATE TABLE IF NOT EXISTS match_market_selections (
    match_selection_id INTEGER PRIMARY KEY,
    match_market_id INTEGER NOT NULL REFERENCES match_markets(match_market_id) ON DELETE CASCADE,
    source_selection_key TEXT NOT NULL,
    name TEXT NOT NULL,
    handicap REAL,
    line REAL,
    UNIQUE (match_market_id, source_selection_key)
);

CREATE TABLE IF NOT EXISTS match_odds_observations (
    match_odds_observation_id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES reference_capture_runs(capture_id) ON DELETE CASCADE,
    match_selection_id INTEGER NOT NULL REFERENCES match_market_selections(match_selection_id) ON DELETE CASCADE,
    bookmaker TEXT NOT NULL DEFAULT '',
    observed_at TEXT NOT NULL,
    odds_decimal REAL NOT NULL CHECK (odds_decimal > 0),
    available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    UNIQUE (capture_id, match_selection_id, bookmaker)
);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '3');
PRAGMA user_version = 3;
