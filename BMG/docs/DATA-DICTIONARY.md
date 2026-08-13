# Data dictionary

## Capture JSON (`bmg.capture.v1`)

- `capture_id` — UUID generated in the browser.
- `observed_at` — UTC ISO-8601 time of the direct capture action.
- `source` — `torn-visible-bookie-dom` or `torn-visible-mybets-dom`.
- `page_url`, `page_hash` — route evidence, with credentials excluded.
- `events[]` — fixtures and every already-loaded market row.
- `bets[]` — visible Pending/Won/Lost/Refunded My Bets entries.

An event contains source ID, sport, title, league/competition, participants,
scheduled time, visible state/score, markets, and raw state text. A market contains
name, classified type, period, whether its visible row set was captured as a unit,
and selections. A selection contains name, optional handicap/line, decimal odds,
availability, and suspension state.

## SQLite entities

- `capture_runs` — immutable import envelope and raw JSON.
- `events` — one evolving identity per Torn event.
- `markets` — named proposition and settlement scope within an event.
- `selections` — one priced outcome within a market.
- `odds_observations` — append-only price/status at capture time.
- `event_outcomes` — visible or provider-resolved event scores/status.
- `bets` — stake, accepted price, state, payout, and profit.
- `bankroll_snapshots` — wallet, Bookie, stocks, other liquid value, and total.

Money is stored as whole Torn dollars (`INTEGER`). Decimal odds use `REAL` and are
validated above zero. Times are stored as UTC ISO text; raw source times are also
retained when ambiguity exists.

## Required analysis metadata (planned)

Each future pick must store model/version, probability, fair odds, observed odds,
decision time, stake rule, rejection reasons, and closing odds. Without those
fields, win rate alone cannot distinguish edge from luck.
