# Bankroll policy v0.1

Starting betting bankroll: **$57,365,830**.

The goal is long-run growth without a plausible short run wiping out the project.
No staking system can make uncertain bets risk-free; edge and variance must be
measured separately.

## Provisional controls

| Control | Rule | Starting amount |
| --- | ---: | ---: |
| Untouchable reserve | 70% of bankroll | $40,156,081 |
| Deployable research bankroll | 30% | $17,209,749 |
| One option | min(2%, Torn $1B cap) | $1,147,316 |
| One event, all options | 3% | $1,720,974 |
| All open bets | 10% | $5,736,583 |
| Daily stop-loss | 3% | $1,720,974 |

Amounts are rounded down by the CLI and recomputed from the latest bankroll.

## Sizing rule after modeling begins

Use quarter Kelly only when a probability estimate is calibrated and has enough
out-of-sample evidence:

```text
full_kelly = (decimal_odds * probability - 1) / (decimal_odds - 1)
stake_fraction = max(0, full_kelly / 4)
```

Then cap the result by the one-option, event, open-exposure, daily-loss, deployable
bankroll, and Torn limits. A model estimate without uncertainty bounds gets no
Kelly stake.

## Non-negotiable rules

- Never increase a stake to recover a loss.
- Never count correlated bets as independent exposure.
- Never use unrealized stock value as instantly liquid without a haircut.
- Store stock market value in the asset total, but exclude it from the
  risk-eligible bankroll until it is sold or an explicit haircut is adopted.
- Never call a partial market a hedge or arbitrage.
- Stop when the daily loss boundary is reached; review the following day.
- Keep prediction timestamp, accepted odds, closing odds, and settlement rule.

The policy becomes looser only from measured calibration and drawdown evidence,
not because the last few bets won.
