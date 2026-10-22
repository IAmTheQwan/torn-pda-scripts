# Deployment checklist

## Cloudflare resources

- Worker name: `caf-auction-dev`
- D1 database: `caf-auction-dev`
- Production URL: `https://caf-auction-dev.fapsports.workers.dev`
- Cron: every five minutes; forward/new-sale checks are internally limited to hourly
- Access: require owner email for the Worker
- Access exception: bypass `/api/snapshots/ingest` only; application-level device-token authentication remains mandatory

## Required secrets

| Secret | Purpose |
| --- | --- |
| `TORN_API_KEY` | Custom Torn key restricted to the public `market -> auctionhouse` selection |
| `ADMIN_EMAIL` | Email Cloudflare Access must assert for dashboard/API access |
| `ADMIN_TOKEN` | Optional emergency/manual API bearer token; use a long random value |
| `CF_ACCESS_TEAM_DOMAIN` | Optional JWT fallback: Access team domain, for example `your-team.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Optional JWT fallback/audience pin for non-native hostname Access |

## Cloudflare Access

Protecting the entire Worker is the safe default. Native Worker Access supplies the authenticated identity directly to the runtime, and the Worker still compares it to `ADMIN_EMAIL`. The snapshot route needs a more-specific hostname/path bypass because PDA userscripts cannot reliably complete an interactive Access redirect. The Worker independently rejects snapshot requests without a valid revocable device token.

## Free-tier guardrails

- Keep `SYNC_PAGES_PER_RUN=5` and `BACKFILL_DAILY_INSERT_LIMIT=15000` during initial backfill. The UTC-day checkpoint resets automatically at midnight UTC, so the five-minute cron resumes historical ingestion within five minutes of Cloudflare's daily D1 reset.
- Review D1 row-write metrics before increasing it.
- Do not add redundant indexes without accounting for their row-write cost.
- If the D1 database approaches 400 MB, archive old raw records or split them by year before reaching the 500 MB free per-database limit.
- Keep snapshot retention short; the cleanup job removes snapshots older than seven days.
