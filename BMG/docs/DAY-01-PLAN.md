# Day 1 — Build the measuring instrument

Date: 2026-08-13

## Outcome for today

End the day with a working, repeatable path from a manually viewed Torn Bookie
game to normalized odds history in SQLite. Do not optimize picks from an empty
sample and do not risk the bankroll while the data path is unverified.

## Work blocks

1. **Foundation**
   - Create the BMG branch and folder.
   - Audit the legacy `origin/Bookie` script.
   - Freeze the capture JSON contract and relational schema.
2. **Capture**
   - Read every already-loaded market and selection from the manually expanded
     game card.
   - Capture Pending/Won/Lost/Refunded entries from the visible My Bets route.
   - Queue captures locally and export JSON without sending data to a third party.
3. **Ingest**
   - Import captures idempotently into SQLite.
   - Preserve event, league, market, selection, odds, status, result, bet, and raw
     source context.
4. **Verify**
   - Run syntax checks and unit tests.
   - Perform one manual Torn capture, import it, and compare the JSON/database
     values with the visible page.
5. **Closeout**
   - Record the latest bankroll components.
   - Note selector misses or ambiguous market names.
   - Commit only code/docs/sanitized fixtures.

## Betting posture

Today is data-validation day. The default decision is **paper pick only**. If the
manual capture has not been reconciled field-by-field, stake is zero.

After the pipeline is verified, the provisional limits are:

- 70% bankroll reserve;
- 2% maximum on one option;
- 3% maximum total exposure to one event;
- 10% maximum open exposure;
- 3% daily stop-loss;
- the Torn hard limit of $1,000,000,000 per option is always enforced;
- no martingale, loss chasing, or stake increase based on a short streak.

With $57,365,830, the initial 2% single-option cap is $1,147,316 and the 10%
open-exposure cap is $5,736,583. These limits shrink with the bankroll.

## Definition of done

- The same export can be imported twice without duplicate captures or odds rows.
- Two snapshots of one market produce two timestamped observations.
- My Bets settlement data updates a stable bet record.
- A two-outcome example with reciprocal-odds sum below one is identified as a
  mathematical review candidate, never as an automatic bet.
- No Torn request, navigation, refresh, or bet is initiated by BMG.

## Next session

After collecting representative samples from football and at least two other
sports, harden selectors and market classification. Then add official Torn API
money/log ingestion with explicit key disclosure and rate controls, followed by
external schedule/result providers. Probability models and picks come after data
quality and settlement reconciliation.
