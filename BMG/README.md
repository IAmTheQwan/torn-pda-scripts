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
- `src/` — SQLite initialization, import, bankroll, and odds math CLI.
- `schema/` — versioned relational model.
- `docs/` — architecture, compliance, data dictionary, bankroll policy, and plan.
- `tests/` — deterministic fixtures and regression tests.
- `data/`, `exports/` — local ignored runtime data.

Read `docs/DAY-01-PLAN.md` before betting real Torn money.
