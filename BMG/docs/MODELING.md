# Modeling and backtesting database

BMG schema v4 separates evidence from predictions so a profitable-looking
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
- `match_market_settlements` records the applicable ruleset before a forecast is
  scored; ordinary time, extra time, pushes, refunds, and voids are not guessed.
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

3. After reviewing the report, confirm only unique same-date matches and copy
   their scores into the Torn evidence layer:

   ```powershell
   python .\BMG\src\bmg.py reconcile --confirm-exact
   python .\BMG\src\bmg.py sync-outcomes
   ```

4. Import timestamped source-neutral odds captures:

   ```powershell
   python .\BMG\src\bmg.py import-odds .\BMG\exports\market-odds-*.json
   ```

5. Turn a Torn capture into an explicit paper-research slate:

   ```powershell
   python .\BMG\src\bmg.py slate CAPTURE_ID --complete --note "full visible football slate"
   ```

6. Register a model only when its implementation and features are frozen:

   ```powershell
   python .\BMG\src\bmg.py model-register bmg-football 0.1.0 `
     --algorithm "recency Elo plus Dixon-Coles Poisson" `
     --feature-spec '{"elo":true,"goals":true,"xg":false}' `
     --training-cutoff 2026-05-31 --active
   ```

7. Inspect readiness and descriptive wager history:

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
