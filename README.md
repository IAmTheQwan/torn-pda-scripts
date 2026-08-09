# torn-pda-scripts
Torn PDA scripts by TheQwan

## CAF Clean

`theqwan-caf-compliant.user.js` provides foreground-only Auction House compilation/history, a local snapshot watch bar, and Item Market bonus-equipment filtering. On both the Item Market equipment grid and individual seller-list views, it overlays parsed bonus percentages and a deal-status color dot on weapon/equipment thumbnails, filters the cards already loaded by bonus type and percentage, then manually compares visible asking prices with finished-sale history and colors the rows as STEAL, GOOD, FAIR, or HIGH.

Any parsed Auction House bid or Item Market asking price from $1 through **$25,000,000** receives a separate **BUY NOW** badge. This fixed price flag also appears in Market Picks and local watch snapshots; it does not replace or change the history-based STEAL/GOOD/FAIR/HIGH result.

The Auction House **Generate Filtered List** action uses the saved guided collection whenever captured pages exist, even if **Compile Loaded Items** was used afterward. Every newly generated list is expanded and brought into view, and its heading/status identify how many saved items and captured pages were used.

Guided Collection arms from a direct PDA tap on **Next Torn Page** and fully loads the next `start=` page so PDA cannot leave the old React cards in place; a trusted tap directly on Torn's native pagination also arms it. Each tap advances only one visible page and makes no background request to Torn. CAF separates the newest complete ten-card batch when Torn retains older page batches, and records a page only after its card content has changed, remained stable, and includes Damage/Accuracy stats. A different page URL can no longer make stale cards count as new items. **Fallback Capture (after Next)** is not the normal next step; use it only when the newly selected Torn page is visibly loaded but automatic capture is still waiting. It applies the same duplicate, completeness, and stat checks. Previously saved collections with identical page-content captures are repaired automatically and display a warning; an old collection whose cards lack stats should be replaced with **Start New Collection**.

Each watched Auction House item shows its saved bid, saved quality, picture/color, and a separate **Update** control. One tap fully loads that item's saved Torn page, matches the visible listing by identity/stats/bonuses, briefly waits for Torn's foreground card to finish rendering, and refreshes the local watch snapshot. CAF reports whether the bid changed, was confirmed unchanged, or could not be read; an unreadable live bid never overwrites the saved bid. A fresh visible picture/color replaces the saved version when available. Quality is refreshed only when Torn exposes it on that visible auction card; otherwise CAF preserves the previously saved value because CAF Clean does not make the legacy build's extra hidden item-detail request.

The Item Market panel includes a persistent **Double bonuses only** toggle. Turning it on clears the two bonus-name selectors so every currently loaded double-bonus listing is shown, while any minimum/maximum bonus-percentage range remains in effect. Bonus selectors can then be used again to narrow that double-bonus set.

Beside it, **Only GOOD/STEAL** filters the Item Market to listings whose strength-adjusted (bottom-rail) history result is GOOD or STEAL. If enabled before analysis, **Analyze Visible Deals** temporarily processes every listing matching the other filters, then leaves only the qualifying deals visible.

The **All / Yellow / Orange / Red** buttons filter loaded bonus equipment by its Torn color. Narrowed grid results briefly show one full scroll runway below the first filtered batch and compact markers below later batches. After three seconds, every runway collapses and CAF brings the first matching listing to the top; changing the filter opens a fresh three-second loading window. As the player manually scrolls and Torn renders more listings, CAF applies the active color, double-bonus, bonus-name, and percentage filters to those new cards automatically. CAF does not request another Torn batch itself.

**Auto Catch matches** is the compact alternative for Torn's virtualized equipment grid. While it is on, CAF leaves every native Torn card visible so the page retains its full manual scrolling range, then deduplicates each newly rendered listing that matches the active filters into **Filtered Catch** at the top of the panel. Changing a filter while Auto Catch is active starts a fresh catch, and turning Auto Catch on again clears the prior catch. Filtered Catch provides image, stats, bonuses, price, Market Picks add/remove, source-card location, and history/deal controls. It exists only in page memory and makes no additional Torn request.

Item Market cards also have a compact `+ Add` control. Added weapons appear in the collapsible **Market Picks** area at the top of the filter panel, where each pick has the same history summary and expandable previous-sales table used by CAF. After deal analysis, **Add All GOOD/STEAL** collects the visible strong-price results into that list. Market Picks remain only in the current page's memory; they are not a background tracker or persistent Torn-data store.

**Analyze Visible Deals** uses a bounded pool of up to six parallel history checks, prioritizes distinct lookups first, and shares identical in-flight lookups between equivalent listings. Duplicate cards then reuse the shared or cached sales instead of occupying the first request wave. Cards paint as their checks finish, while the button and status line show overall progress. This changes only requests to the disclosed external history service; CAF still makes no additional request to Torn.

The Item Market deal rail is split vertically. Its top half shows the original price result across the current same-item/bonus-type history pool. Its bottom half is strength-adjusted: it uses only sales whose corresponding bonus percentages are equal to or weaker than the listing. For a double-bonus item, every corresponding historical bonus must be equal to or weaker. **Add All GOOD/STEAL** uses this safer bottom result.

## Compliance

- [Torn scripting compliance notes](TORN-SCRIPTING-COMPLIANCE.md)
