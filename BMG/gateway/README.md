# BMG capture-inbox gateway

> Optional fallback, not the active transport. Version 0.11.0 writes directly
> to the one private inbox with a runtime-only fine-grained token because the
> standard Cloudflare Wrangler OAuth grant was broader than this deployment
> required.

This Cloudflare Worker accepts only direct, authenticated `bmg.export.v1`
uploads from the Torn origin and writes content-addressed JSON files into the
private `IAmTheQwan/bmg-capture-inbox` repository.

The client never receives or stores `GITHUB_TOKEN`. Configure both secrets in
Cloudflare rather than `wrangler.toml`:

```powershell
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put UPLOAD_SECRET
```

Run deterministic tests with:

```powershell
npm test
```

Deployment is intentionally incomplete until the private repository exists and
the Cloudflare and GitHub account connections are confirmed. After deployment,
add the exact Worker `/upload` URL as `DEFAULT_GATEWAY_URL` in the userscript.
The player enters the revocable `UPLOAD_SECRET` into **Bridge settings**; it is
held only in page memory. **Upload pending** splits saved captures into groups
of 30, records receipts locally, and never clears the outbox. Capturing a game
must never call this Worker.

The public `GET /health` route exposes no repository details or credentials.
Every upload requires the secret, an allowed Torn origin, valid capture schema,
and a body below four MiB. `GITHUB_TOKEN` should be a fine-grained token limited
to Contents read/write on the single private inbox repository.
