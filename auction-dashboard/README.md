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

1. Install dependencies: `npm install`.
2. Authenticate Wrangler: `npx wrangler login`.
3. Create D1: `npm run db:create`.
4. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml` with the returned ID.
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

The importer follows Torn's API-provided pagination link and checkpoints it in D1. `SYNC_PAGES_PER_RUN` defaults to five pages per hourly run to respect the D1 free-tier row-write allowance. A manual sync button invokes the same resumable process. Once caught up, each run requests only records at or after the newest saved ending timestamp; duplicate listing IDs are ignored.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill the local values.
2. Create a local D1 database via Wrangler and apply migrations:
   - `npm run db:migrate:local`
3. Run `npm run dev`.

When `REQUIRE_ACCESS` is `true`, local API requests need either the configured `ADMIN_TOKEN` bearer token or a simulated `Cf-Access-Authenticated-User-Email` header.
