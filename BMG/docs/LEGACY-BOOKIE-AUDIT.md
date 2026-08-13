# Legacy Bookie branch audit

Source reviewed: `origin/Bookie` at commit `4915311` (`qwantum-bookie.source.js`,
version 1.14.7).

## Reusable findings

The branch confirms Torn's current Bookie DOM vocabulary:

- event cards: `li.c-pointer`;
- event title: `.matchName p` or `.pop-game .name p`;
- sport: `li.game[title]`;
- scheduled state: `.state-wrap .state[title]`;
- market container: `.info-wrap ul.bets-wrap`;
- market name: `.market-name-cell .bold`;
- selection: `.bet-cell.result`;
- decimal odds: `.bet-cell.odds.decimal` with `xN.NN` text;
- bet amount: `input.amount`;
- My Bets links: `a[href*="#/your-bets/"]`;
- My Bets state text uses Pending/Won/Lost/Refunded titles.

Useful concepts carried forward include normalized log records, timestamped odds
observations, fixture IDs, bet-to-fixture reconciliation, IndexedDB caching, API
rate accounting, and explicit credential disclosure.

## Limitations corrected in BMG

- Most fixture and odds logic is football-only.
- The persisted model is several browser storage objects rather than a relational,
  queryable source of truth.
- Three-way and -0.5 handicap logic is hard-coded instead of retaining every
  market/selection generically.
- Some versions include automatic score polling, timers, observers, additional
  market clicks, or guided navigation. BMG does not copy those behaviors.
- External score matching relies heavily on normalized names and time windows;
  BMG will retain provider IDs and reconciliation confidence explicitly.
- Result-message regular expressions focus on football three-way bets; BMG stores
  generic My Bets states and raw source text.

## Migration decision

The legacy branch remains source evidence. BMG is a new folder and data contract,
not a rename of the monolithic panel. This avoids inheriting compliance debt and
lets the legacy script continue independently while BMG builds a complete history.
