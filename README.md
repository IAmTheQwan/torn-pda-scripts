# torn-pda-scripts
Torn PDA scripts by TheQwan

## CAF Clean

`theqwan-caf-compliant.user.js` provides foreground-only Auction House compilation/history, a local snapshot watch bar, and Item Market bonus-equipment filtering. On both the Item Market equipment grid and individual seller-list views, it overlays parsed bonus percentages and a deal-status color dot on weapon/equipment thumbnails, filters the cards already loaded by bonus type and percentage, then manually compares visible asking prices with finished-sale history and colors the rows as STEAL, GOOD, FAIR, or HIGH.

The Auction House **Generate Filtered List** action uses the saved guided collection whenever captured pages exist, even if **Compile Loaded Items** was used afterward. Every newly generated list is expanded and brought into view, and its heading/status identify how many saved items and captured pages were used.

Guided Collection arms on touch/pointer-down before Torn changes pages, polls independently of the page's ongoing DOM updates, and records a new page only after its visible auction-card data has remained stable. This lets it recognize a page that is already rendered without getting stuck waiting for one more mutation.

The Item Market panel includes a persistent **Double bonuses only** toggle. Turning it on clears the two bonus-name selectors so every currently loaded double-bonus listing is shown, while any minimum/maximum bonus-percentage range remains in effect. Bonus selectors can then be used again to narrow that double-bonus set.

Beside it, **Only GOOD/STEAL** filters the Item Market to listings whose strength-adjusted (bottom-rail) history result is GOOD or STEAL. If enabled before analysis, **Analyze Visible Deals** temporarily processes every listing matching the other filters, then leaves only the qualifying deals visible.

The **All / Yellow / Orange / Red** buttons filter loaded bonus equipment by its Torn color. Narrowed grid results keep one full scroll runway below the first filtered batch; later filtered batches use only a compact one-line marker so repeated loading does not create large empty gaps. As the player manually scrolls and Torn renders more listings, CAF applies the active color, double-bonus, bonus-name, and percentage filters to those new cards automatically. CAF does not request another Torn batch itself.

Item Market cards also have a compact `+ Add` control. Added weapons appear in the collapsible **Market Picks** area at the top of the filter panel, where each pick has the same history summary and expandable previous-sales table used by CAF. After deal analysis, **Add All GOOD/STEAL** collects the visible strong-price results into that list. Market Picks remain only in the current page's memory; they are not a background tracker or persistent Torn-data store.

**Analyze Visible Deals** uses a bounded pool of up to six parallel history checks, prioritizes distinct lookups first, and shares identical in-flight lookups between equivalent listings. Duplicate cards then reuse the shared or cached sales instead of occupying the first request wave. Cards paint as their checks finish, while the button and status line show overall progress. This changes only requests to the disclosed external history service; CAF still makes no additional request to Torn.

The Item Market deal rail is split vertically. Its top half shows the original price result across the current same-item/bonus-type history pool. Its bottom half is strength-adjusted: it uses only sales whose corresponding bonus percentages are equal to or weaker than the listing. For a double-bonus item, every corresponding historical bonus must be equal to or weaker. **Add All GOOD/STEAL** uses this safer bottom result.

## Compliance

- [Torn scripting compliance notes](TORN-SCRIPTING-COMPLIANCE.md)
