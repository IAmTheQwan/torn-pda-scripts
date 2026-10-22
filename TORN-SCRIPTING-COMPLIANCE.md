# Torn scripting compliance notes

Last reviewed: 2026-10-22

This document records the rules used when designing CAF Clean. It is a development reference, not official approval from Torn staff. Recheck the linked sources before changing any feature that reads Torn pages, sends requests, monitors live data, or produces alerts.

## Official sources

- [Torn game rules — Scripting Abuse](https://www.torn.com/rules.php)
- [Torn announcement — Updated Rules Page: Scripting & Scraping (2026-01-26)](https://www.torn.com/forums.php?p=threads&t=16534470)
- [Torn API documentation and API Terms of Service](https://www.torn.com/api.html)
- [Torn API v2 OpenAPI definition](https://www.torn.com/swagger/openapi.json)
- [Torn staff clarification introducing the finished-auction API](https://www.torn.com/forums.php?p=threads&t=16528580)

## Working interpretation

Torn permits software that uses either:

1. Data supplied through Torn's API; or
2. Data on a Torn page the player manually loaded and is actively viewing.

For non-API page data, “actively viewing” means the page is foregrounded, visible, and being directly used by the player. A background tab, minimized view, separate unattended window, or page left open without interaction is not treated as active viewing.

The current rules prohibit:

- Additional non-API Torn requests that were not directly and manually initiated by the player.
- Scraping or extracting information from an unfocused or background page.
- Using background-page data to send information elsewhere, generate alerts, or draw attention to another page or window.
- Automated page cycling, refreshing, buying, bidding, clicking, or other Torn actions.
- CAPTCHA bypassing.
- Malicious or undisclosed behavior.

WebSocket or live-DOM information follows the same foreground requirement. A script may process the currently viewed live page, but it must not monitor that feed from a hidden page or use hidden observations to notify the player elsewhere.

API-only automation is allowed subject to the API's access, rate, data-handling, key-security, and disclosure requirements. Tools that request an API key must clearly disclose what is stored, who receives it, why it is used, how the key is handled, and the required key access level.

Torn currently permits up to 100 API requests per minute across all keys owned by a user, but this is a ceiling rather than a polling target. CAF must use the least request volume needed, honor rate-limit/API errors without immediate retry loops, and keep historical imports resumable. Finished Auction House history must come from Torn's official `market -> auctionhouse` API. Another tool's archive may be imported only through an owner-published API/export whose terms permit reuse, or after obtaining the owner's explicit permission; public visibility alone is not permission to copy its database.

## CAF Clean guardrails

| Feature | Compliant implementation |
| --- | --- |
| Compile auction items | Read only the Auction House page currently visible to the player. |
| Guided collection | The player manually opens each Torn page. One tap causes at most one navigation. |
| Filtered results | Filter locally saved snapshots; make no Torn request. |
| History | Send disclosed visible item details to the configured external history service; never send Torn credentials, cookies, or API keys. |
| Inventory AH history | Only after the player opens a weapon inventory view and taps Load, read weapon cards already rendered on the visible `item.php` page. If the player manually opens Torn's native item details, observe that already-requested foreground response to enrich the local snapshot. Keep snapshots in page memory, request finished-sale history only after a player history tap, and never request additional inventory data or equip, move, sell, or otherwise act on an item. |
| Item Market bonus filter | Read and filter only seller listings already rendered on the visible Item Market page. A narrowed grid may retain a scroll runway so the player can manually continue through Torn's native list; if Torn renders more cards while the page remains visible, apply the same local filters to those cards. Do not request another batch, load another page, or read hidden listings. |
| Item Market grid matching | Observe the response from Torn's already-requested visible market load, keep it only in page memory, and use it only while that Item Market page is visible to match bonus data to rendered cards. Never create an additional Torn request or persist/repurpose the response. |
| Item Market deal check | Begin only after the player taps a history/deal button. Compare the visible asking price with finished-sale history from the disclosed external service; make no extra request to Torn. |
| Item Market deal colors | Treat colors as a price-only aid, not an appraisal or buying instruction. The top rail shows the existing history result; the bottom rail locally filters the returned finished-sale history to matching bonus percentages equal to or weaker than the visible listing. Do not highlight broader fallback history as an exact-match deal. |
| Item Market Market Picks | Add only a snapshot of a listing already visible on the current page. Keep picks in page memory, provide history only after a player tap, and do not poll, persist, revisit, or refresh Torn listings. |
| Add All GOOD/STEAL | Add only currently visible listings whose player-initiated, strength-adjusted history analysis already produced a GOOD or STEAL result. This is a local list operation and performs no Torn request or game action. |
| Watch list | Add an item only from data already collected on a foreground Auction House page and store the snapshot locally. |
| Watch countdown | Subtract the current device time from the saved ending timestamp. Label it as estimated/stale; do not refresh Torn in the background. |
| Open watched item | A direct player tap performs one navigation to the saved Auction House page. After that page is visibly loaded, CAF may locate and highlight the matching item in the DOM. |
| Update watched item | A direct player tap performs one navigation to the saved Auction House page, then refreshes the local snapshot only after matching the item and reading its fields from the foreground DOM. Missing image/color/quality fields preserve the prior snapshot, and an unreadable bid never overwrites the saved value. CAF does not make the legacy build's separate item-detail request to obtain missing quality. |
| Watched-item updates | Refresh a saved snapshot only when its auction page is visibly open. |
| Cloud history importer | Use only Torn API v2 `market -> auctionhouse`, with a custom key restricted to the public market selection. Never expose the key to CAF Clean, the browser UI, logs, or Git. Store finished-sale fields needed for analysis and omit buyer/seller identities. |
| Private dashboard snapshots | Upload only after the player taps the disclosed control while the Auction House is visible. Send the visible listing fields, source page, and capture time to the player's configured dashboard using a revocable device token. Label the result as a timestamped, incomplete snapshot—not a live or complete Auction House feed. |
| Dashboard access | Put the human dashboard behind Cloudflare Access. Exempt only the snapshot-ingest path from interactive Access and require a separate hashed/revocable device token there. |

CAF Clean must not add background polling, hidden-page DOM or WebSocket observation, automatic multi-page searches, automatic bid tracking, ending-soon notifications, or automatic game actions.

## Difference from the legacy CAF watch system

The legacy build periodically refreshed watched auction pages and searched nearby pages to relocate an item. Those behaviors make additional non-API Torn requests without a separate player action and are intentionally excluded from CAF Clean.

CAF Clean retains the safe portions of the experience:

- A persistent, collapsible watch bar.
- Locally stored item snapshots.
- Locally projected countdowns.
- Manual removal.
- One-tap, user-initiated navigation to the saved auction page.
- Foreground-only matching and highlighting after navigation.

Because CAF Clean does not search Torn automatically, a watched item may no longer be present on its saved page. In that case the player must manually browse or collect pages again to refresh its saved location.

## Review checklist

Before merging a change, confirm that:

- Every non-API Torn request corresponds to one immediate player action.
- No timer, observer, page lifecycle event, or stored task can initiate a Torn request.
- Page extraction stops when `document.visibilityState` is not `visible`.
- Saved data is clearly distinguished from live data.
- Cross-page UI uses only local snapshots or API data.
- No background notification or attention mechanism is based on scraped page data.
- External data sharing is disclosed in the UI and documentation.
- API use, if introduced, includes the required key and data-handling disclosure.
- Item Market picks do not become a persistent or background market monitor.
- Automated history collection uses only the official API, and its key is least-privilege and server-side.
- Foreground snapshot uploads require a direct player tap and are labeled with their capture time.
