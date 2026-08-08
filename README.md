# torn-pda-scripts
Torn PDA scripts by TheQwan

## CAF Clean

`theqwan-caf-compliant.user.js` provides foreground-only Auction House compilation/history, a local snapshot watch bar, and Item Market bonus-equipment filtering. On both the Item Market equipment grid and individual seller-list views, it overlays parsed bonus percentages and a deal-status color dot on weapon/equipment thumbnails, filters the cards already loaded by bonus type and percentage, then manually compares visible asking prices with finished-sale history and colors the rows as STEAL, GOOD, FAIR, or HIGH.

Any parsed Auction House bid or Item Market asking price from $1 through **$25,000,000** receives a separate **BUY NOW** badge. This fixed price flag also appears in Market Picks and local watch snapshots; it does not replace or change the history-based STEAL/GOOD/FAIR/HIGH result.

The Auction House **Generate Filtered List** action uses the saved guided collection whenever captured pages exist, even if **Compile Loaded Items** was used afterward. Every newly generated list is expanded and brought into view, and its heading/status identify how many saved items and captured pages were used.

Guided Collection arms on touch/pointer-down before Torn changes pages, ignores hidden cards retained from the previous page, polls independently of ongoing DOM updates, and records a new page only after its visible auction-card data has remained stable. While a page is pending, **Capture Loaded Page Now** provides a manual fallback for Torn layouts that do not expose a reliable automatic page-change signal.

The Item Market panel includes a persistent **Double bonuses only** toggle. Turning it on clears the two bonus-name selectors so every currently loaded double-bonus listing is shown, while any minimum/maximum bonus-percentage range remains in effect. Bonus selectors can then be used again to narrow that double-bonus set.

Beside it, **Only GOOD/STEAL** filters the Item Market to listings whose strength-adjusted (bottom-rail) history result is GOOD or STEAL. If enabled before analysis, **Analyze Visible Deals** temporarily processes every listing matching the other filters, then leaves only the qualifying deals visible.

The **All / Yellow / Orange / Red** buttons filter loaded bonus equipment by its Torn color. Narrowed grid results briefly show one full scroll runway below the first filtered batch and compact markers below later batches. After three seconds, every runway collapses and CAF brings the first matching listing to the top; changing the filter opens a fresh three-second loading window. As the player manually scrolls and Torn renders more listings, CAF applies the active color, double-bonus, bonus-name, and percentage filters to those new cards automatically. CAF does not request another Torn batch itself.

Item Market cards also have a compact `+ Add` control. Added weapons appear in the collapsible **Market Picks** area at the top of the filter panel, where each pick has the same history summary and expandable previous-sales table used by CAF. After deal analysis, **Add All GOOD/STEAL** collects the visible strong-price results into that list. Market Picks remain only in the current page's memory; they are not a background tracker or persistent Torn-data store.

**Analyze Visible Deals** uses a bounded pool of up to six parallel history checks, prioritizes distinct lookups first, and shares identical in-flight lookups between equivalent listings. Duplicate cards then reuse the shared or cached sales instead of occupying the first request wave. Cards paint as their checks finish, while the button and status line show overall progress. This changes only requests to the disclosed external history service; CAF still makes no additional request to Torn.

The Item Market deal rail is split vertically. Its top half shows the original price result across the current same-item/bonus-type history pool. Its bottom half is strength-adjusted: it uses only sales whose corresponding bonus percentages are equal to or weaker than the listing. For a double-bonus item, every corresponding historical bonus must be equal to or weaker. **Add All GOOD/STEAL** uses this safer bottom result.

## Compliance

- [Torn scripting compliance notes](TORN-SCRIPTING-COMPLIANCE.md)
