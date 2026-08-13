# Flashscore league workflow

## Operating boundary

Each run begins with a direct user request and operates in the visible in-app
browser. It may navigate and expand the finite batch requested in that run. It
does not use a timer, direct hidden HTTP calls, background monitoring, or an
automatic restart. The next check requires another user instruction.

The 2026-08-13 session confirmed the account was signed in. A Flashscore account
is not required for league tables, results, fixtures, match stats, or H2H; login
may still expose user-managed favorites or account-specific presentation. BMG
records only the requested visible sports information, never account secrets.

## Per-league collection order

1. Open the league archive and record every visible season link and winner.
2. Record competition and season IDs, dates, and source URLs.
3. Capture Overall standings first; add Home, Away, Form, Over/Under, and HT/FT
   snapshots when the league exposes them.
4. Open Results and use the visible `Show more matches` control until it is gone.
5. Open Fixtures and do the same. Both surfaces import into `sports_matches`.
6. For selected matches, record Summary, overall/half stats, lineups, player
   stats, H2H, and any available odds panels.
7. Save the raw JSON under ignored `BMG/exports/`, import it, and run
   `sports-summary` before reconciliation or modeling.

Raw JSON may also be stored as a gzip-compressed Base64 archive ending in
`.json.gz.b64`; `import-flashscore` accepts either representation. SQLite keeps
the expanded raw JSON as capture evidence.

Start a collection run before opening a target, add checkpoints after meaningful
expansions or surfaces, and finish it after import/reconciliation. See
`COLLECTION-PROGRESS.md` for the commands, measured pilot, and current estimates.

## Premier League pilot

The first pass proved the full route with real visible data:

- Premier League 2025/26: 20 final standing rows and all 380 results.
- Premier League 2026/27: all 380 scheduled fixtures.
- Brighton–Manchester United on 2026-05-24: 40 overall match-stat rows.
- The same matchup: 30 ordered H2H meetings, reaching back to 1979.
- Stable provider IDs for 23 unique teams across the two seasons.

Flashscore showed exact kickoff times for only part of the distant schedule. BMG
therefore retains all 760 local display strings, stores the date for every match,
and only creates a UTC timestamp where a time was actually visible.

## What to collect next

For model depth, repeat this sequence for the active football leagues that most
often overlap Torn, then work backward through recent seasons. A practical order
is Premier League validation views, Champions League, Europa League, Conference
League, LaLiga, Serie A, Bundesliga, Ligue 1, and Eredivisie. Cup and national-
team competitions follow because their formats require different standings and
form assumptions.

H2H is preserved as an observation, but model queries should normally derive H2H
from canonical `sports_matches`. The snapshot remains useful evidence for
cross-competition meetings and for verifying that our historical coverage is not
missing a match.

The outcome-first backlog is ranked from the actual Torn wager archive rather
than from league popularity. Complete that pass before attempting universal
per-match stats: the first measured match-detail pass was nearly half the time of
collecting an entire 230-result league season.
