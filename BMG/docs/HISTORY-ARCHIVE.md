# Torn My Bets lifetime archive

## Reconciliation target

The 2026-08-13 foreground-browser capture loaded Torn's complete visible My
Bets archive and reconciled:

- 3,706 grouped game rows;
- 4,288 individual wagers, matching Torn's lifetime statistic exactly;
- 2,260 wins, 1,951 losses, and 77 refunds;
- zero unparsed wager summaries.

The summary archive includes every sport even though BMG's odds research and
future betting scope remains football. Multiple wagers under one game row are
stored separately.

## Immutable local files

Live exports are ignored by Git and remain under `BMG/exports/history-*/`:

- `torn-mybets-complete-summary-*.json` — all rows, raw visible attributes,
  normalized wagers, accepted odds, stakes, profit/payout, and finish text;
- `expanded-events.ndjson` — one append-only record for each fully opened game
  dropdown, including every displayed market, selection, decimal/fractional
  price, raw text, and expansion-completeness evidence;
- `expanded-event-failures.ndjson` — retry audit log; failures are never hidden;
- `detail-manifest.json` — durable completion and resume checkpoint.

The SQLite importer stores the raw JSON as evidence and also normalizes events,
markets, selections, odds, wagers, and settlement timestamps. Event outcomes
such as final scores are intentionally left blank until reconciled against an
authorized results source.

## Commands

```powershell
python .\BMG\src\bmg.py import .\BMG\exports\history-*\torn-mybets-complete-summary-*.json
python .\BMG\src\bmg.py import-details .\BMG\exports\history-*\expanded-events.ndjson
python .\BMG\src\bmg.py summary
```

Both import paths are idempotent. The detail importer keeps the newest complete
record for an event when an interrupted attempt produced an earlier duplicate.
