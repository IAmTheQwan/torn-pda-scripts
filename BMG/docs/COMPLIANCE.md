# BMG compliance and fair-play boundary

This is a development policy, not approval from Torn staff. Recheck the official
Torn rules, API documentation, and API terms before enabling any automated data
source. The repository-wide `TORN-SCRIPTING-COMPLIANCE.md` is the baseline.

Last verified against official sources: 2026-08-13.

Operational note: after account scrutiny was reported on 2026-08-13, BMG
removed Torn-page pick delivery, highlighting, scrolling, refreshes, and
background capture. Version 0.9.0 requires one direct foreground press per
football game. A press opens at most one row, expands its markets, captures it,
and stops. A separate later press is required before BMG may move to the next
row. That design choice is not a claim of permission; disable the userscript entirely if Torn
staff instructs the player to stop using page readers or userscripts.

- [Torn game rules](https://www.torn.com/rules.php)
- [Scripting and scraping clarification](https://www.torn.com/forums.php?p=threads&t=16534470)
- [Torn API documentation and acceptable usage](https://www.torn.com/api.html)

## Allowed by BMG design

- Process Torn API data through documented endpoints and access levels.
- Parse data already loaded on the Torn page the player is actively viewing.
- From one direct foreground Capture action, process exactly one already-
  rendered football row: open, expand, capture, and stop.
- Save and analyze local snapshots after a direct Capture action.
- Query independent sports data providers under their terms.
- Perform a finite, visible in-app-browser league check after the player directly
  asks for that batch; record the resulting public page observations locally.
- Calculate implied probabilities, expected value, exposure, and dutching stakes.

## Out of scope

- Additional non-API Torn requests initiated by a timer or script.
- Timer-driven, recurring, hidden, or self-restarting page checks; unattended bet
  placement.
- Reading or monitoring Torn from hidden/background pages.
- CAPTCHA bypass, rate-limit evasion, credential sharing, or undisclosed export.
- Acting on a game known to be underway while Torn incorrectly presents it as not
  started, or otherwise exploiting stale/misleading state.

A stale-state discrepancy may be recorded as a data-quality incident and used to
exclude the market. It is not a betting signal.

## Credential and data rules

- Never commit API keys, cookies, Torn tokens, live exports, or the SQLite file.
- Request the minimum Torn API access required.
- Disclose each destination, purpose, retention rule, and access level in the UI.
- Keep raw provider responses only as long as needed for audit/reconciliation.
- Use explicit rate limits and backoff; cache immutable results.

The current API documentation states a shared limit of 100 individual requests
per minute across a user's keys, but also warns that limits can change. BMG will
therefore configure below the published ceiling, honor API errors/backoff, and
avoid cache-bypass parameters unless fresh data is genuinely required.

## Release checklist

- Every non-API Torn read is tied to the visible page and a direct user action.
- Every rendered-football row requires a new direct player click; one click can
  never advance through two rows or start another capture automatically.
- Every Flashscore browser batch is tied to a new direct user instruction, remains
  visible, and ends after its stated finite scope. A prior run never schedules the next one.
- Capture aborts when `document.visibilityState !== "visible"`.
- No timer, observer, or page lifecycle event starts a capture. A temporary
  observer may wait only for the explicitly requested expansion to finish.
- The Torn userscript makes no direct network request and performs no pick
  highlighting, scrolling, refresh, background capture, stake entry, or bet
  placement. Its only page navigation is the foreground open/close sequence.
- Local export occurs only after a direct user action. Any future remote inbox
  upload must use a separate explicit button, disclose its destination, and
  keep GitHub credentials outside the Torn userscript.
- Saved observations are labeled with source and timestamp.
- Analysis never claims certainty from incomplete market coverage.
- Bet and exposure limits are enforced independently of model confidence.
