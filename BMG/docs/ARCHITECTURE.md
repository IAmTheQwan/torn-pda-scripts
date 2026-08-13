# Architecture

## Data flow

```text
Manually opened Torn Bookie/My Bets page
        |
        | direct Capture button, foreground page only
        v
BMG userscript -> IndexedDB outbox -> local JSON export
                                         |
                                         v
                               idempotent CLI import
                                         |
                                         v
                                      SQLite
                         events / markets / selections
                         odds / outcomes / bets / money
                                         |
                                         v
                         QA -> movement -> modeling -> picks
```

Independent sports reference data follows a parallel foreground path:

```text
Explicit user request -> visible in-app Flashscore league/match pages
        -> finite expand/read pass -> local ignored JSON export
        -> idempotent import -> competitions / seasons / teams / matches
                             -> standings / match stats / H2H snapshots
        -> event_match_links -> Torn events, odds, and historical bets
```

There is deliberately no direct userscript-to-server connection. This keeps the
first version inspectable, makes failed imports recoverable, and prevents private
Torn data from silently leaving the device.

## Capture boundary

The userscript observes only:

- Torn's currently visible Bookie or My Bets page;
- event cards and market rows Torn loaded after the player manually opened the
  event; an explicit **Expand active** click may activate Torn's own additional
  options control for that visible event;
- a direct BMG capture click, or a direct player click that opens a game while
  **Capture on game click** is armed.

It does not open events, cycle pages, refresh, operate from a hidden tab, notify
from background observations, or place a bet. Expansion and capture are limited
to the visible event produced by the player's trusted click. IndexedDB stores the
resulting local snapshot; Export outbox is another direct user action.

## Stable identities

- Capture: userscript UUID.
- Event: Torn game ID when present; otherwise a SHA-256 fingerprint of sport,
  title, and scheduled time.
- Market: event plus normalized market name/type/period.
- Selection: market plus normalized selection and handicap/line.
- Odds observation: capture plus selection.
- Bet: Torn/My Bets stable fingerprint excluding settlement status, allowing a
  pending row to become won/lost/refunded on a later capture.

Every table retains source text or raw JSON needed to diagnose a bad mapping.

External sports records use provider competition, season, team, and match IDs.
Canonical match rows are stored once: a future fixture becoming a result updates
the same match. `match_sources` preserves provider identity and
`event_match_links` is the reviewed bridge to Torn. Team aliases allow labels
such as `Manchester Utd` and `Manchester United` to resolve without rewriting
source data.

## Analysis boundary

`opportunities` computes the reciprocal-odds sum for the latest selections in a
market. A sum below 1.0 is only a **math candidate**. Before treating it as an
arbitrage, all selections must be mutually exclusive, collectively exhaustive,
simultaneously available, governed by the same settlement rules, and within the
per-option cap. BMG never treats two picked options in a three-way market as full
coverage—the omitted draw remains a losing outcome.

## Planned adapters

1. Torn API adapter for disclosed, authorized money and Bookie log fields.
2. Reconciliation jobs joining Torn game IDs, provider fixtures, and settled bets.
3. Model tables for forecasts, closing-line value, calibration, and pick decisions.

Adapters append observations. They do not rewrite source history.
