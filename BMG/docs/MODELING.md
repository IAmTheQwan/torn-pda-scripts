# Modeling and backtesting database

BMG schema v9 separates evidence from predictions so a profitable-looking
backtest cannot quietly use information that was unavailable at decision time.

## The three evidence layers

1. **Torn behavior and prices** — `events`, `markets`, `selections`,
   `odds_observations`, `bets`, and `capture_events` retain what Torn displayed,
   what was wagered, and which games were in each captured slate.
2. **Canonical football history** — competitions, seasons, teams, matches,
   standings, match stats, and H2H snapshots describe what happened independently
   of a wager.
3. **External market prices** — `match_markets`, `match_market_selections`, and
   `match_odds_observations` retain source, bookmaker, market rules, line, price,
   availability, and observation time.

`event_match_links` is the reviewed bridge between Torn and canonical matches.
An outcome is copied into Torn history only after that bridge is confirmed.

`match_status_observations` is the immutable provider-state history. A later
live or final refresh can never be used to reconstruct what was known at a
morning Torn capture.

The reciprocal-odds opportunity screen only evaluates complete three-way,
two-way moneyline, yes/no both-teams-to-score, and complementary over/under
markets. Overlapping or non-exhaustive shapes such as double chance and win to
nil are excluded even when their displayed reciprocal sum is below one.

## Research ledger

- `research_slates` and `research_slate_events` preserve the full candidate pool,
  including games that received no pick.
- `model_versions` freezes algorithm, features, training cutoff, and version.
- `team_rating_snapshots` stores as-of Elo, attack/defense strength, uncertainty,
  and match count without overwriting older states.
- `forecast_runs` and `match_forecasts` store probabilities, uncertainty bounds,
  fair prices, feature timestamps, and the exact information cutoff.
- `decision_records` stores every pick **and pass**, the offered Torn price,
  external reference price, estimated edge, expected value, stake rule, and
  rejection reasons.
- `market_review_coverage` stores every displayed Torn market considered by a
  paper run, including its selection depth and why it was eligible, partial,
  unsupported, unmapped, settlement-incompatible, or short of external books.
- `match_market_settlements` records the applicable ruleset and settlement
  fraction before a forecast is scored; ordinary time, half wins/losses,
  pushes, refunds, and voids are not guessed.
- `forecast_evaluations` stores outcome, Brier score, log loss, realized profit,
  closing price, and closing-line value.
- `backtest_runs` and `backtest_metrics` enforce chronological train/test windows.
  The database rejects a test period that begins before the training period ends.

## Safe build order

1. Import a complete historical match season and current fixtures.
2. Generate exact team/date reconciliation candidates:

   ```powershell
   python .\BMG\src\bmg.py reconcile
   python .\BMG\src\bmg.py reconciliation-review
   ```

3. Apply committed manual review decisions, confirm only unique same-date
   matches, and copy their scores into the Torn evidence layer:

   ```powershell
   python .\BMG\src\bmg.py event-match-review-apply
   python .\BMG\src\bmg.py reconcile --confirm-exact
   python .\BMG\src\bmg.py sync-outcomes
   ```

   `event-match-review-apply` rechecks the stored Torn and provider identities,
   competition scope, home/away roles, and six-hour kickoff guard before it
   confirms a link. Rejected lookalikes remain in the committed registry, and
   reviewed one-off pairs do not become global team aliases.

4. Import timestamped source-neutral odds captures:

   ```powershell
   python .\BMG\src\bmg.py import-odds .\BMG\exports\market-odds-*.json
   ```

5. Turn a Torn capture into an explicit paper-research slate:

   ```powershell
   python .\BMG\src\bmg.py slate CAPTURE_ID --complete --note "full visible football slate"
   ```

6. Generate a frozen, depth-aware paper-price ledger for a captured UTC date:

   ```powershell
   python .\BMG\src\bmg.py daily-review --date 2026-08-13 `
     --snapshot-label morning --min-books 5 --min-ev 0.03 `
     --output .\BMG\data\paper-review-2026-08-13.md
   ```

   Each event keeps its own Torn capture and information cutoff. External
   prices observed after that cutoff are excluded. The external-price benchmark
   supports ordinary-time 1X2, both-teams-to-score, and half-goal full-match
   totals. Whole-goal totals remain settlement mismatches until push
   probability is modeled. This command intentionally remains narrower than
   the score-model review.

   A `paper_pick` requires the 25th-percentile de-vigged bookmaker probability
   to clear the EV threshold. Its recorded paper stake uses fractional Kelly,
   a bankroll-percentage cap, and the Torn $1B option cap. The command never
   places a bet.

7. Near kickoff, manually capture Torn again, import a new external odds
   snapshot, register the new Torn capture as a research slate, and create a
   second immutable review:

   ```powershell
   python .\BMG\src\bmg.py daily-review --date 2026-08-13 `
     --snapshot-label pre-kickoff `
     --output .\BMG\data\paper-review-2026-08-13-pre-kickoff.md
   ```

   The daily aggregate uses the latest registered capture for each event at
   that moment. Because the capture IDs and information cutoffs differ, the
   morning and pre-kickoff forecasts coexist rather than overwriting each
   other. A game that gains or loses betting options is evaluated against its
   own displayed market surface at each snapshot.

8. Refresh terminal fixture evidence and settle a review:

   ```powershell
   python .\BMG\src\api_football.py settle-review FORECAST_RUN_ID `
     --output .\BMG\data\settlement-review-2026-08-13.md
   ```

   The evaluator scores every binary forecast with Brier score and log loss,
   calculates hypothetical paper profit only for paper picks, and records
   closing-line value as `accepted Torn odds / closing consensus fair odds -
   1`. Closing consensus uses the latest complete per-bookmaker surface no
   later than scheduled kickoff. Post-kickoff observations cannot leak into it.
   Passes are scored for calibration but carry zero hypothetical stake.

9. Run the frozen chronological score-model holdout, then score the full Torn
   surface:

   ```powershell
   python .\BMG\src\bmg.py model-backtest `
     --test-start 2026-05-01T00:00:00Z `
     --test-end 2026-08-01T00:00:00Z
   python .\BMG\src\bmg.py score-review --date 2026-08-13 `
     --snapshot-label morning --min-ev 0.05 `
     --output .\BMG\data\score-review-2026-08-13.md
   ```

   `score-review` fits only records strictly earlier than the first Torn
   capture. It builds a recency-weighted, competition-shrunk attack/defense
   Poisson grid with a Dixon-Coles low-score adjustment. A timestamp-safe
   external 1X2 consensus anchors cross-league strength, while the historical
   model supplies score and total shape. Each supported selection must also
   have a same-contract external reference price.

   Supported ordinary-time contracts are 1X2, BTTS, DNB, double chance,
   match totals, home/away team totals, Asian handicaps in quarter-goal
   increments, and win-to-nil. Quarter lines retain half-win/half-loss payoff
   math and settle at a 0.5 fraction. No contract is converted to a binary bet
   when its push or split payoff differs.

   The priority-1 kickoff gate requires an as-of provider status and matching
   kickoff. If the provider was live/scored, the real kickoff had been reached,
   the times disagree, or no provider state existed by the Torn capture, every
   selection for that event is rejected. A timing mismatch is never a pick.

   A replay created after kickoff is labeled `retrospective_asof_replay`, not
   forward paper evidence. See `SCORE-MODEL-VALIDATION.md` for the first frozen
   holdout and replay results.

10. Inspect readiness and descriptive wager history:

   ```powershell
   python .\BMG\src\bmg.py modeling-summary
   python .\BMG\src\bmg.py history-performance --sport football
   ```

Historical ROI by league or market identifies areas to investigate and staking
mistakes to stop. It does **not** establish a future edge. A strategy graduates
from paper testing only after calibrated probabilities, positive closing-line
value, positive out-of-sample expected return, acceptable drawdown, and adequate
sample size agree.

## Market-odds capture contract

`bmg.market-odds.v1` is source-neutral. Each capture contains `capture_id`,
`observed_at`, `source`, optional default `bookmaker`, and `matches[]`. A match
references an already-imported `source_match_id`; each market retains a stable
source key, type, period, and selections with line/handicap, bookmaker, decimal
odds, availability, and optional selection-level observation time.

The same match/market/selection can therefore receive many timestamped prices.
Repeated import of the same capture ID is idempotent.
