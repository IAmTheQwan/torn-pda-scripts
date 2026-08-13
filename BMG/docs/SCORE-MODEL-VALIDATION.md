# Score-model validation

## Frozen chronological holdout

The first registered holdout trained on 42,885 scored matches strictly before
2026-05-01 and tested the untouched interval from 2026-05-01 through
2026-07-31. The test contained 10,214 matches; 7,789 had at least five
effective recent matches for both teams and 2,425 were thin-history cases.

| Metric | Team model | Competition-only baseline | Improvement |
|---|---:|---:|---:|
| 1X2 multiclass Brier | 0.619490 | 0.644660 | 0.025170 |
| 1X2 log loss | 1.031024 | 1.066311 | 0.035287 |
| Exact-score log loss | 3.014105 | 3.073452 | 0.059347 |
| BTTS Brier | 0.244262 | 0.244510 | 0.000249 |
| Over 2.5 Brier | 0.239571 | 0.240539 | 0.000968 |

The 1X2 and score improvements support continued paper testing. The BTTS and
total improvements are positive but small, so neither is treated as proof of a
profitable edge. The recorded 1X2 calibration error was 0.011387; home- and
away-goal MAE were 1.0067 and 0.9078. A six-hour result-availability lag keeps
matches that could still have been in progress out of every model fit.

## Cross-league control

Domestic attack/defense ratings are not automatically comparable in European
qualification matches. The production review therefore reweights every score
grid to a complete external 1X2 consensus observed before Torn's capture. This
preserves the model's conditional score shape without letting disconnected
domestic rating scales invent very large winner edges. A second same-contract
external price check is required for each selection.

## 2026-08-13 as-of replay

Run `score-review-2026-08-13-v5` used 54,564 earlier training matches and
reviewed 111 markets / 172 selections across four captured Torn games. It is a
`retrospective_asof_replay`, not a forward result.

- One game had no provider status observation by its Torn capture and failed
  the priority-1 kickoff gate.
- One game was unmapped.
- The remaining two had matching scheduled provider states.
- After validation, uncertainty, external 1X2 anchoring, and same-contract
  reference-price gates, one Asian-handicap selection remained as a simulated
  paper candidate. It is not a recommendation and no bet was placed.
- A manually initiated three-fixture settlement refresh at 18:35 UTC found all
  three games still live, so the sample remains unsettled.

Forward paper captures must accumulate before any live-betting graduation.
The settlement command can be run again only after a user-initiated check; it
does not poll on a timer.
