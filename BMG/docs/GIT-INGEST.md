# Private Git capture inbox design

## Goal

Move player-initiated BMG capture sessions from Torn PDA into a private Git
inbox so Codex can pull and import them after a new user prompt. Git remains a
transport and audit trail; SQLite remains the queryable source of truth.

## Security boundary

- Do not commit captures to the public `torn-pda-scripts` repository.
- Do not place a GitHub personal access token, API key, Torn token, or cookie in
  the userscript, its source, localStorage, IndexedDB, or an export.
- Keep the GitHub App/private-repository credential in a server-side secret.
- Give the gateway permission only to create files in one private inbox repo.
- Upload only after the player presses a clearly labeled **Upload session**
  button. Capturing a game never uploads it.

## Proposed path

```text
one press per Torn game -> local IndexedDB session
                              |
                              | separate Upload session press
                              v
authenticated write-only gateway -> private bmg-capture-inbox Git repo
                                              |
                                              | later user prompt
                                              v
                         Codex pulls -> validates -> idempotent SQLite import
```

The gateway can be a small Cloudflare Worker or equivalent service. It holds a
GitHub App installation token or narrowly scoped repository token as a secret,
validates `bmg.export.v1`, enforces a payload-size limit, generates the path,
and writes through the GitHub Contents API. The phone receives only the inbox
commit SHA. A short-lived or revocable upload credential may authorize the
gateway, but it must not grant GitHub access.

Suggested private-repository paths:

```text
incoming/2026/08/14/2026-08-14T13-17-16Z_4e7dc3f6.json
processed/2026/08/14/2026-08-14T13-17-16Z_4e7dc3f6.json
rejected/2026/08/14/<filename>.json
```

## Pull and import contract

After the player says to retrieve new captures, Codex will:

1. pull the private inbox;
2. validate schema, capture IDs, timestamps, event counts, and secret scanning;
3. import with `bmg.py import` (capture IDs make repeats harmless);
4. verify capture/market/selection/odds counts;
5. move accepted files to `processed/` and push that bookkeeping change only
   after the user-authorized retrieval command.

## Implemented locally

- `gateway/src/worker.mjs` validates authenticated uploads and writes
  content-addressed files through the GitHub Contents API.
- `gateway/test/worker.test.mjs` covers authorization, credential rejection,
  Git creation, and idempotent retry behavior.
- `src/capture_inbox.py` validates a prompted pull, imports it idempotently,
  and moves accepted files from `incoming/` to `processed/`.

## External setup still required

1. Create or select a private inbox repository.
2. Deploy and connect the write-only gateway.
3. Add its URL and public disclosure text to BMG settings.
4. Add the explicit **Upload session** button and test it with sanitized data.
5. Connect the private inbox as a separate local checkout or approved GitHub
   integration for prompted retrieval.

Until those steps are complete, **Copy session** and **Export outbox** remain
local-only and the userscript performs no network request.
