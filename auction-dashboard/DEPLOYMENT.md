# Deployment checklist

## Cloudflare resources

- Worker name: `caf-auction-dev`
- D1 database: `caf-auction-dev`
- Production URL: the generated `*.workers.dev` URL
- Cron: hourly at minute zero
- Access: require owner email for the Worker
- Access exception: bypass `/api/snapshots/ingest` only; application-level device-token authentication remains mandatory

## Required secrets

| Secret | Purpose |
| --- | --- |
| `TORN_API_KEY` | Custom Torn key restricted to the public `market -> auctionhouse` selection |
| `ADMIN_EMAIL` | Email Cloudflare Access must assert for dashboard/API access |
| `ADMIN_TOKEN` | Optional emergency/manual API bearer token; use a long random value |

## Cloudflare Access

Protecting the entire Worker is the safe default. The snapshot route needs a path-specific bypass because PDA userscripts cannot reliably complete an interactive Access redirect. The Worker independently rejects snapshot requests without a valid revocable device token.

## Free-tier guardrails

- Keep `SYNC_PAGES_PER_RUN=5` during initial backfill.
- Review D1 row-write metrics before increasing it.
- Do not add redundant indexes without accounting for their row-write cost.
- If the D1 database approaches 400 MB, archive old raw records or split them by year before reaching the 500 MB free per-database limit.
- Keep snapshot retention short; the cleanup job removes snapshots older than seven days.
