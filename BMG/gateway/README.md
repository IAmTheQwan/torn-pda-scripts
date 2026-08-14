# BMG capture-inbox gateway

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
add the exact Worker URL to the userscript metadata and enable its separate
**Upload session** action. Capturing a game must never call this Worker.
