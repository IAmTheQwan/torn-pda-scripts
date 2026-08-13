# API-Football integration

BMG uses API-Football as a source of structured football schedules, results,
standings, statistics, events, lineups, and forward-looking bookmaker odds.
Provider records join the same canonical competition, season, team, and match
network used by Torn and Flashscore; they are not kept in an isolated model.

## Secret handling

The API key belongs only in `BMG/.env`, which is ignored by Git. The committed
`.env.example` contains names but no credential. Commands read the key locally
and never print it. If a key appears in chat, logs, a commit, or an export,
rotate it in the API-Football dashboard.

## Coverage audit

Run:

```powershell
python .\BMG\src\api_football.py audit --refresh-catalog
```

One catalog download is cached at
`BMG/data/api-football-catalog.json`. The audit compares every BMG collection
target with provider league name, country, required seasons, and per-season
coverage. It writes `BMG/data/api-football-coverage-audit.json` and classifies
matches as:

- `automatic`: strong name/country/season match with separation from the next
  candidate;
- `review`: plausible but requires human confirmation;
- `unmatched`: no reliable provider candidate.

The audit never writes guessed mappings into the live database. Confirmed
mappings must be reviewed before a bulk backfill.

The first bulk tier is intentionally stricter than the audit's `automatic`
label. `backfill-exact` accepts only targets with an exact normalized provider
league name, exact country, and every required API season present. It groups
duplicate targets into unique league-season jobs, commits one season at a time,
skips seasons already imported, and maintains a resumable ignored report.

```powershell
python .\BMG\src\api_football.py backfill-exact --dry-run
python .\BMG\src\api_football.py backfill-exact
```

The next tier uses the committed
`BMG/config/api-football-reviewed-mappings.json` registry. Each entry records
the Torn target labels, exact provider league ID/name/country, explicitly
approved seasons, and a rationale. The command fails closed if the current
audit or provider catalog drifts from any of those reviewed values; it does not
fall back to fuzzy matching.

```powershell
python .\BMG\src\api_football.py backfill-reviewed --dry-run
python .\BMG\src\api_football.py backfill-reviewed
```

Add mappings only after confirming that a rename or stage label denotes the
same competition. Common names in the wrong country and similar-looking cup or
league labels must remain outside the registry.

## League-season collection

Run a pilot with a confirmed provider league ID and API season year:

```powershell
python .\BMG\src\api_football.py collect-season LEAGUE_ID SEASON `
  --import-db .\BMG\data\pilot.sqlite
```

The command requests fixtures and official standings, preserves the provider
payload inside the private capture archive, transforms it to
`bmg.sports-league.v1`, and imports it into BMG's source-neutral tables. Use a
disposable database for the first validation; import into the live database
only after team names, dates, scores, and season identity are checked.

## Odds retention

Pre-match odds are only retained by the provider for seven days and live odds
have no provider-side history. BMG must therefore store prospective odds
snapshots as they become available. Torn odds remain separate and join through
the canonical match link. Historical API-Football fixture data does not imply
historical bookmaker odds are available.

## Operational limits

Ultra permits 75,000 requests per UTC day and 450 per minute. The client paces
requests below the per-second limit, follows pagination, retries transient
network failures, and stops on provider-reported errors. Bulk work should use
catalog coverage flags to avoid spending requests on unsupported statistics,
lineups, predictions, or odds.
