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

There is deliberately no direct userscript-to-server connection. This keeps the
first version inspectable, makes failed imports recoverable, and prevents private
Torn data from silently leaving the device.

## Capture boundary

The userscript observes only:

- Torn's currently visible Bookie or My Bets page;
- event cards and market rows Torn loaded after the player manually opened the
  event; an explicit **Expand active** click may activate Torn's own additional
  options control for that visible event;
- one direct click on BMG's Capture button.

It does not open events, cycle pages, refresh, operate from a hidden tab, notify
from background observations, or place a bet. Expansion is limited to the open
visible event and occurs only from the player's direct button press. IndexedDB
stores the resulting local snapshot; Export outbox is another direct user action.

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

## Analysis boundary

`opportunities` computes the reciprocal-odds sum for the latest selections in a
market. A sum below 1.0 is only a **math candidate**. Before treating it as an
arbitrage, all selections must be mutually exclusive, collectively exhaustive,
simultaneously available, governed by the same settlement rules, and within the
per-option cap. BMG never treats two picked options in a three-way market as full
coverage—the omitted draw remains a losing outcome.

## Planned adapters

1. Torn API adapter for disclosed, authorized money and Bookie log fields.
2. External sports schedule/results adapter with provider IDs and rate metadata.
3. Reconciliation jobs joining Torn game IDs, provider fixtures, and settled bets.
4. Model tables for forecasts, closing-line value, calibration, and pick decisions.

Adapters append observations. They do not rewrite source history.
