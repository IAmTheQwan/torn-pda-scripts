# Data dictionary

## Capture JSON (`bmg.capture.v1`)

- `capture_id` — UUID generated in the browser.
- `observed_at` — UTC ISO-8601 time of the direct capture action.
- `source` — `torn-visible-bookie-dom` or `torn-visible-mybets-dom`.
- `page_url`, `page_hash` — route evidence, with credentials excluded.
- `events[]` — fixtures and every already-loaded market row.
- `bets[]` — visible Pending/Won/Lost/Refunded My Bets entries.

The full-history My Bets export retains all sports, raw row attributes,
settlement timestamp text, and every individual wager even when Torn groups
several wagers under one game row. Expanded dropdowns are stored as newline-
delimited `bmg.history-event-detail.v1` records so collection is resumable.

An event contains source ID, sport, title, league/competition, participants,
scheduled time, visible state/score, markets, raw state text, a capture-complete
flag, and the visible count of additional options remaining. A market contains
name, classified type, period, whether its visible row set was captured as a unit,
and selections. Market identity includes a sorted selection signature so Torn's
repeated handicap labels with opposite home/away orientations remain distinct. A
selection contains name, optional handicap/line, decimal odds, availability, and
suspension state.

## SQLite entities

- `capture_runs` — immutable import envelope and raw JSON.
- `events` — one evolving identity per Torn event.
- `markets` — named proposition and settlement scope within an event.
- `selections` — one priced outcome within a market.
- `odds_observations` — append-only price/status at capture time.
- `event_outcomes` — visible or provider-resolved event scores/status.
- `bets` — stake, accepted price, state, payout, and profit.
- `history_event_details` — immutable raw expanded-dropdown records and completeness counts.
- `bankroll_snapshots` — wallet, Bookie, stocks, other liquid value, and gross
  tracked asset total. Staking uses wallet + Bookie + other liquid; stock value
  remains excluded until sold or covered by an explicit haircut policy.
- `capture_events` — explicit event membership in a capture, including unpriced slate entries.

## Flashscore foreground capture (`bmg.flashscore-league.v1`)

- `competition` — sport, country, league name, stable source slug, and URL.
- `season` — provider season ID, label, date range, URL, and current flag.
- `standings[]` — table scope plus every team row and visible recent-form links.
- `matches[]` — provider match ID, round, raw local schedule, teams, state, score,
  and evidence URL. Fixtures and results use the same object.
- `match_details[].stats[]` — period, category, name, and raw home/away values.
- `match_details[].h2h` — the ordered H2H list visible for that match context.

Raw display times and the display timezone are retained. UTC is populated only
when the visible row includes a time and BMG can resolve the timezone safely.

## Sports-reference SQLite entities

- `reference_capture_runs` — immutable raw foreground capture envelope.
- `sports_competitions`, `competition_sources` — canonical league plus provider identity.
- `competition_seasons`, `season_sources` — season dates and provider season ID.
- `sports_teams`, `team_sources`, `team_aliases` — canonical team and source labels.
- `team_alias_evidence` — the Torn event, provider match, rule, confidence, and
  raw evidence supporting each automatically accepted alias.
- `season_teams` — membership observed for a competition season.
- `sports_matches`, `match_sources` — one fixture/result identity plus source evidence.
- `standings_snapshots`, `standing_rows` — append-only table observations.
- `match_stats` — period/category/stat values, with raw values and parsed ratios.
- `h2h_snapshots`, `h2h_snapshot_matches` — exactly which ordered meetings were visible.
- `event_match_links` — reviewed reconciliation between Torn events and sports matches.
- `match_markets`, `match_market_selections`, `match_odds_observations` — external
  odds-ready tables; Torn prices stay in their existing tables and join via the match link.

## Collection planning and timing entities

- `collection_plans` — named historical scope, source, years, and lifecycle.
- `collection_targets` — normalized competition backlog with wager/stake priority,
  source mapping, planned seasons, and state.
- `collection_target_league_labels` — every original Torn league/season label
  rolled into a normalized target.
- `collection_runs`, `collection_run_targets` — timed foreground/import/benchmark
  work with pages, rows, raw bytes, and completion state.
- `collection_checkpoints` — resumable phase, page, item count, and elapsed time.

League-season runs and single-match detail runs are measured separately so one
cannot silently distort the other's ETA.

## Modeling and evaluation entities

- `research_slates`, `research_slate_events` — the full candidate pool at a decision time.
- `match_status_observations` — immutable scheduled/live/final state, score, and
  provider kickoff at each reference capture for leakage-safe as-of checks.
- `model_versions` — immutable model identity, feature specification, and training cutoff.
- `team_rating_snapshots` — as-of team strength and uncertainty states.
- `forecast_runs`, `match_forecasts` — timestamped probability distributions and fair odds.
- `decision_records` — every pick, pass, or rejection with prices, edge, EV, and stake rule.
- `market_review_coverage` — one row for every Torn market visible to a paper
  run, with captured selection depth, completeness, external book count, and
  an explicit eligibility or rejection status.
- `match_market_settlements` — rules-aware win/loss/push/void evidence plus a
  0.5 settlement fraction for Asian quarter-line half wins/losses.
- `forecast_evaluations` — calibration, hypothetical profit, closing odds,
  closing-line value, and JSON evidence naming the closing captures, book count,
  cutoff, formula, and result sources.
- `backtest_runs`, `backtest_metrics` — chronological test definitions and results.

Money is stored as whole Torn dollars (`INTEGER`). Decimal odds use `REAL` and are
validated above zero. Times are stored as UTC ISO text; raw source times are also
retained when ambiguity exists.

These entities implement the required analysis metadata. Without a recorded
information cutoff and full slate denominator, a forecast is not eligible for a
backtest.
