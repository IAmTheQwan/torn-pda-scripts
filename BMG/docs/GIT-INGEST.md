# Private Git capture inbox

## Goal

Move player-initiated BMG capture sessions from Torn PDA into the private
`IAmTheQwan/bmg-capture-inbox` repository so Codex can pull and import them only
after a new user prompt. Git is the transport and audit trail; SQLite remains
the queryable source of truth.

## Active transport

```text
one direct press per Torn game -> local IndexedDB outbox
                                      |
                                      | separate Upload pending press
                                      v
api.github.com -> private bmg-capture-inbox Git repository
                                      |
                                      | later user prompt
                                      v
                 Codex pulls -> validates -> idempotent SQLite import
```

Version 0.11.0 uses `GM_xmlhttpRequest` from the userscript sandbox to avoid
exposing the Authorization header to Torn page JavaScript and to make the
external destination explicit in userscript metadata. The upload button makes
only GitHub API requests for already-saved JSON. It never requests Torn,
captures another game, advances the slate, scrolls, refreshes, retries on a
timer, or places a bet.

## Credential boundary

- Use a fine-grained GitHub token restricted to only
  `IAmTheQwan/bmg-capture-inbox`.
- Grant only repository **Contents: Read and write**. GitHub may add mandatory
  read-only metadata access.
- Enter the token only through **Bridge settings** or the first explicit upload
  prompt.
- The token stays in the userscript sandbox closure for the current page
  session. It is never written to source, localStorage, IndexedDB, capture JSON,
  an export, or the public repository.
- Reloading the page clears the token. Revoke or rotate it in GitHub settings at
  any time.

## Upload behavior

- One **Upload pending** press sends all currently pending saved captures in
  bounded groups of at most 30.
- Each group has deterministic JSON and a Git-blob content hash in its filename.
  Repeating an interrupted upload checks that exact private path and treats an
  identical file as already delivered.
- A delivery receipt is recorded locally only after GitHub confirms identical
  existing content or creates the file successfully.
- The local outbox is preserved after delivery. **Prepare export** and **Copy
  session** remain manual fallbacks.

Private repository paths use this form:

```text
incoming/2026/08/14/2026-08-14T13-17-16-494Z_<git-blob-sha>.json
processed/2026/08/14/2026-08-14T13-17-16-494Z_<git-blob-sha>.json
rejected/2026/08/14/<filename>.json
```

## Pull and import contract

After the player asks to retrieve new captures, Codex will:

1. pull the private inbox;
2. validate schema, capture IDs, timestamps, event counts, and secret scanning;
3. import idempotently with `src/capture_inbox.py` / `bmg.py`;
4. verify capture, market, selection, and odds counts;
5. move accepted files to `processed/` and push that bookkeeping change as part
   of the prompted retrieval.

The Cloudflare Worker under `gateway/` remains a tested optional alternative,
but it is not deployed or used by the active client.
