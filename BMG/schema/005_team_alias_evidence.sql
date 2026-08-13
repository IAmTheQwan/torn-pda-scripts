PRAGMA foreign_keys = ON;

-- Every automatically accepted Torn/provider team alias retains the exact
-- event and reference-match evidence that justified it.
CREATE TABLE IF NOT EXISTS team_alias_evidence (
    team_alias_evidence_id INTEGER PRIMARY KEY,
    team_alias_id INTEGER NOT NULL REFERENCES team_aliases(team_alias_id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES sports_matches(match_id) ON DELETE CASCADE,
    rule TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    observed_at TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    UNIQUE (team_alias_id, event_id, match_id, rule)
);

CREATE INDEX IF NOT EXISTS idx_team_alias_evidence_event
    ON team_alias_evidence (event_id, match_id);
