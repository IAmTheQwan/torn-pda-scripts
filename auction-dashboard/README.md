# CAF Auction Dashboard

Private Cloudflare Worker dashboard for Torn Auction House history, trends, and user-initiated foreground snapshots from CAF Clean.

## Compliance boundary

- Automated collection uses only Torn API v2 `market -> auctionhouse` and retains equipment sales with weapon/armor stats rather than unrelated stackable auction items.
- The API currently exposes finished auctions, not active listings.
- Active listings are accepted only as snapshots explicitly captured from the foreground Auction House page by CAF Clean.
- The service does not request Torn pages, cycle pages, observe background tabs, or create off-page alerts.
- Seller and buyer identities are intentionally not retained because they are unnecessary for pricing analysis.

See [`../TORN-SCRIPTING-COMPLIANCE.md`](../TORN-SCRIPTING-COMPLIANCE.md) for the repository-wide rules reference.

## Architecture

- Cloudflare Worker: UI, authenticated API, scheduled importer.
- D1: normalized finished sales, daily rollups, snapshot batches, device-token hashes, and resumable sync state.
- Cloudflare Access: dashboard authentication restricted to the owner's email.
- Device token: separate revocable credential used only by CAF Clean's snapshot upload endpoint.

## First deployment

The repository is currently bound to the provisioned `caf-auction-dev` D1 database and deployed at `https://caf-auction-dev.fapsports.workers.dev`. For a fresh Cloudflare account or a replacement database:

1. Install dependencies: `npm install`.
2. Authenticate Wrangler: `npx wrangler login`.
3. Create D1: `npm run db:create`.
4. Replace the existing `database_id` in `wrangler.toml` with the returned ID.
5. Apply migrations: `npm run db:migrate:remote`.
6. Add encrypted secrets:
   - `npx wrangler secret put TORN_API_KEY`
   - `npx wrangler secret put ADMIN_EMAIL`
   - optionally `npx wrangler secret put ADMIN_TOKEN` for CLI/manual API access.
7. Deploy: `npm run deploy`.
8. Protect the Worker with Cloudflare Access and allow only the owner's email.
9. Configure a more-specific Access bypass policy for `/api/snapshots/ingest`; the Worker still requires a valid device token on that route.
10. Open the dashboard, generate a device token, and save the dashboard URL and token in CAF Clean.

Do not put a Torn key, Access service token, or device token in Git.

## Backfill behavior

The importer begins with Torn's newest finished-auction page; it never starts from Unix time zero or treats the newest response's missing `next` link as proof that history is complete. Older pages use Torn's documented inclusive `to` parameter, moving the boundary to one second before the oldest raw timestamp returned. The only completion signal is an empty, explicitly bounded response.

The importer keeps independent forward and backward checkpoints in D1. Forward requests rewind one second from the newest stored ending timestamp so auctions sharing that boundary are not lost; duplicate listing IDs are ignored. The five-minute schedule uses at most `SYNC_PAGES_PER_RUN` requests per invocation, checks forward history hourly, and spends the remaining request budget on older records. `BACKFILL_DAILY_INSERT_LIMIT` defaults to 40,000 newly stored sales so the one-time fill cannot silently consume the D1 free-tier row-write allowance. When the daily guardrail is reached, forward checks continue and the historical fill resumes the next UTC day.

A manual sync button invokes the same resumable process and the same storage guardrail. Status records include raw, normalized, dropped, newly inserted, oldest stored, and completion values so an upstream API or normalization problem is visible instead of appearing to be a successful empty sync.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill the local values.
2. Create a local D1 database via Wrangler and apply migrations:
   - `npm run db:migrate:local`
3. Run `npm run dev`.

When `REQUIRE_ACCESS` is `true`, requests need either the native, unforgeable Worker Access identity, a cryptographically verified Cloudflare Access JWT, or the configured `ADMIN_TOKEN` bearer token. In every Access case, the authenticated identity must exactly match `ADMIN_EMAIL`; an email header by itself is never trusted. Worker-level Access needs no extra identity secrets. Hostname-based deployments using the JWT fallback must also configure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`.
