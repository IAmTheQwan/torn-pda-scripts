# BMG — Bookie Master Grind

BMG is a local-first research system for Torn Bookie. It records the odds and
outcomes you are allowed to see, keeps an auditable history in SQLite, and adds
bankroll guardrails before any pick is considered.

The current odds research and future betting phase is intentionally scoped to
**football/soccer only**. Historical My Bets archival captures every sport so
the lifetime record can be reconciled exactly and retained without data loss.

The project starts with a betting bankroll of **$57,365,830**. It does not place
bets, click through games, refresh Torn pages, or exploit stale/misleading event
state. The first milestone is trustworthy data.

## Day-one quick start

1. Initialize the local database:

   ```powershell
   python .\BMG\src\bmg.py init
   ```

2. Install `userscripts/bmg-capture.user.js` in Torn PDA or a userscript manager.
3. Leave **Capture on game click** enabled and manually open a Torn Bookie game.
   BMG expands that visible event's additional options and saves the capture.
   Alternatively, press **Expand + capture** for the currently open game.
4. Press **Export outbox** and save the JSON file under `BMG/exports/`.
5. Import it and inspect the result:

   ```powershell
   python .\BMG\src\bmg.py import .\BMG\exports\bmg-captures-*.json
   python .\BMG\src\bmg.py summary
   python .\BMG\src\bmg.py risk
   python .\BMG\src\bmg.py opportunities
   ```

   Expanded historical dropdown archives use NDJSON and import separately:

   ```powershell
   python .\BMG\src\bmg.py import-details .\BMG\exports\history-*\expanded-events.ndjson
   ```

6. Import a manually initiated foreground Flashscore league capture:

   ```powershell
   python .\BMG\src\bmg.py import-flashscore .\BMG\exports\flashscore-*.json
   python .\BMG\src\bmg.py sports-summary
   ```

   The first pilot contains both complete Premier League seasons surfaces:
   2025/26 results and final standings plus the full 2026/27 fixture list. See
   `docs/FLASHSCORE-WORKFLOW.md` for the repeatable league workflow.

   Ranked collection progress and measured timing are available with:

   ```powershell
   python .\BMG\src\bmg.py collection-progress football-history-v1
   ```

   See `docs/COLLECTION-PROGRESS.md` for the current outcome-first and full
   three-year estimates. Flashscore imports accept plain `.json` or private
   `.json.gz.b64` archives.

7. Build the reviewed outcome/modeling bridge and inspect research readiness:

   ```powershell
   python .\BMG\src\bmg.py reconcile
   python .\BMG\src\bmg.py reconciliation-review
   python .\BMG\src\bmg.py team-alias-audit
   python .\BMG\src\bmg.py team-alias-apply
   python .\BMG\src\bmg.py reconcile --confirm-exact
   python .\BMG\src\bmg.py sync-outcomes
   python .\BMG\src\bmg.py modeling-summary
   python .\BMG\src\bmg.py history-performance --sport football
   ```

   `team-alias-audit` only marks aliases automatic when a known opponent,
   home/away role, kickoff window, and competition scope reproduce the same
   provider team. Accepted aliases retain event/match evidence in SQLite;
   two-name fuzzy candidates remain review-only.

   Timestamped external price captures import with `import-odds`. Full schema,
   slate, forecast, decision, settlement, and backtest details are in
   `docs/MODELING.md`.

8. Audit and collect API-Football coverage without exposing the key:

   ```powershell
   Copy-Item .\BMG\.env.example .\BMG\.env
   # Add API_FOOTBALL_KEY to the ignored .env file.
   python .\BMG\src\api_football.py status
   python .\BMG\src\api_football.py audit --refresh-catalog
   python .\BMG\src\api_football.py collect-season LEAGUE_ID SEASON
   python .\BMG\src\api_football.py backfill-exact --dry-run
   python .\BMG\src\api_football.py backfill-exact
   python .\BMG\src\api_football.py backfill-reviewed --dry-run
   python .\BMG\src\api_football.py backfill-reviewed
   ```

   The catalog and audit live under ignored `BMG/data/`; captures live under
   ignored `BMG/exports/`. API-Football fixture IDs are imported into the same
   canonical reference tables as Flashscore data. See `docs/API-FOOTBALL.md`.
   Reviewed aliases and stage mappings live in the committed, drift-checked
   `BMG/config/api-football-reviewed-mappings.json` registry.

For a smoke test without Torn data:

```powershell
python .\BMG\src\bmg.py --db .\BMG\data\smoke.sqlite init
python .\BMG\src\bmg.py --db .\BMG\data\smoke.sqlite import .\BMG\tests\fixtures\capture-history-v1.json
python .\BMG\src\bmg.py --db .\BMG\data\smoke.sqlite summary
python -m unittest discover -s .\BMG\tests -v
```

## What is tracked in Git

- database schema and importer code;
- the foreground capture userscript;
- data contracts, operating rules, and research notes;
- sanitized test fixtures.

The live SQLite database, exports, `.env`, and credentials are ignored. The
database is the evidence store; Git is the reproducible blueprint.

## Project map

- `userscripts/` — manual Torn page capture and JSON export.
- `src/` — SQLite initialization/import, bankroll and odds math CLI, plus the
  checkpointed in-app-browser history recovery helper.
- `schema/` — versioned Torn and source-neutral sports-reference models.
- `docs/` — architecture, compliance, data dictionary, bankroll policy, and plan.
- `tests/` — deterministic fixtures and regression tests.
- `data/`, `exports/` — local ignored runtime data.

Read `docs/DAY-01-PLAN.md` before betting real Torn money.
