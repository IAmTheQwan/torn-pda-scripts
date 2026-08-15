# Architecture

## Data flow

```text
Manually viewed Torn Bookie/My Bets page
        |
        | one direct Capture press per game, foreground page only
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

Version 0.11.0 makes no scripted request to Torn. A separate direct **Upload
pending** press may transmit only already-saved capture JSON to the disclosed
private Git inbox through GitHub's API; capture actions never upload. The
fine-grained token is limited to Contents read/write on that one private
repository and remains only in the userscript sandbox's page memory. The local
outbox and manual export remain available as fallbacks. `config/current-picks.json` may
still be used as an offline planning artifact, but the Torn userscript neither
loads nor renders it.

## Capture boundary

The userscript observes only:

- Torn's currently visible Bookie or My Bets page;
- one rendered football event card and the market rows Torn loads after each
  direct **Capture game** press;
- a manual session index that cannot advance again without another player press.

It does not highlight or scroll to picks, cycle pages, refresh Torn, fill a
stake, operate from a hidden tab, or place a bet. Its only Torn control
activation is the single-row foreground open/close handoff and finite additional-
options expansion tied to that row's player click. A temporary observer waits for the event's markets
and disconnects after settlement or an eight-second ceiling. IndexedDB stores
the resulting local snapshot; **Export outbox** and **Upload pending** are
separate direct user actions. Upload contacts only `api.github.com` for the
private inbox and never initiates a Torn request.

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
source data. Automatically bridged aliases are limited to a uniquely known
opponent in the same home/away role and kickoff window, with compatible
country/gender/youth scope. `team_alias_evidence` preserves the exact events
and matches behind the decision; pairs requiring two fuzzy names are never
automatically accepted.

## Analysis boundary

`opportunities` computes the reciprocal-odds sum for the latest selections in a
market. A sum below 1.0 is only a **math candidate**. Before treating it as an
arbitrage, all selections must be mutually exclusive, collectively exhaustive,
simultaneously available, governed by the same settlement rules, and within the
per-option cap. BMG never treats two picked options in a three-way market as full
coverage—the omitted draw remains a losing outcome.

## Adapter status

1. Torn API adapter for disclosed, authorized money and Bookie log fields.
2. Reconciliation jobs joining Torn game IDs, provider fixtures, and settled bets — **schema and conservative exact-link CLI implemented**.
3. Model tables for forecasts, closing-line value, calibration, and pick decisions — **implemented with an external-price benchmark plus a frozen, chronologically validated recency/Dixon-Coles score model; live graduation remains disabled pending forward samples**.
4. Source-neutral timestamped external-odds import — **implemented as `bmg.market-odds.v1`**.

Fixture state is append-only in `match_status_observations`. The score review
uses the latest provider observation no later than each Torn capture and fails
closed on missing, live, scored, reached, or disagreeing kickoff evidence.

Adapters append observations. They do not rewrite source history.
