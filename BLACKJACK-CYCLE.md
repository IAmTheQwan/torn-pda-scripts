# TheQwan Blackjack Cycle

`theqwan-blackjack-cycle.user.js` is a local, PDA-friendly blackjack bet-cycle
tracker. It appears only on Torn's blackjack page.

## Install

Use this raw URL in Torn PDA:

`https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/blackjack-cycle/theqwan-blackjack-cycle.user.js`

## Default ladder

1. $1,000
2. $10,000
3. $100,000
4. $300,000
5. $1,000,000
6. $3,000,000
7. $9,000,000
8. $20,000,000
9. $45,000,000
10. $100,000,000

The ladder is editable in Settings. It supports up to 20 strictly increasing
amounts, with shortcuts such as `250k`, `3m`, and `100m`.

## Two-tap betting

- **LOAD** writes the displayed next amount into Torn's visible bet field. It
  does not click a Torn control or submit a request.
- **PLAY** is shown only after the visible bet field matches the recommendation
  and Torn exposes an enabled Start Game control. This deliberate tap clicks
  exactly that one native control.
- The script never plays a hand, automatically places another bet, clicks a
  confirmation, or makes its own Torn request.

## Cycle rules

- Win or blackjack: record the result and reset to step 1.
- Loss: record the full wager as lost and advance one step.
- Surrender: record half the wager as lost and advance one step.
- Push: record zero profit/loss and repeat the current step.
- A native Double Down click doubles the tracked wager. A detected split is
  flagged for manual verification.
- A loss or surrender on the final ladder step stops at **LIMIT** until the
  player deliberately resets or edits the cycle.

Flexing preserves each ladder step's intended cycle profit. For example, after
losing $1,000 and $10,000, then surrendering a $100,000 hand, the real cycle
deficit is $61,000. The normal $300,000 step targets $189,000 cycle profit, so
the flexed next wager is $250,000.

## Tracking and corrections

The compact bar shows Next Bet, Step, Record, Wins, Losses, Surrenders, and the
current cycle net. Visible result messages are recorded automatically while a
tracked hand is active. The W, L, S, and P buttons provide manual result entry,
and Undo restores the exact pre-result cycle state.

All settings, state, and history remain in namespaced local browser storage.
No API key or external service is used.

## Compliance design

The script operates only on the blackjack page the player is actively viewing.
It reads visible page data, edits a visible input locally, and assigns at most
one native Torn action to one deliberate PLAY tap. Torn's rules remain
authoritative and can change:

- <https://www.torn.com/rules.php>
- <https://www.torn.com/forums.php?a=0&b=0&f=3&p=threads&t=16585237>
