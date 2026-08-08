# torn-pda-scripts
Torn PDA scripts by TheQwan

## CAF Clean

`theqwan-caf-compliant.user.js` provides foreground-only Auction House compilation/history, a local snapshot watch bar, and Item Market bonus-equipment filtering. On both the Item Market equipment grid and individual seller-list views, it overlays parsed bonus percentages and a deal-status color dot on weapon/equipment thumbnails, filters the cards already loaded by bonus type and percentage, then manually compares visible asking prices with finished-sale history and colors the rows as STEAL, GOOD, FAIR, or HIGH.

Item Market cards also have a compact `+ Add` control. Added weapons appear in the collapsible **Market Picks** area at the top of the filter panel, where each pick has the same history summary and expandable previous-sales table used by CAF. After deal analysis, **Add All GOOD/STEAL** collects the visible strong-price results into that list. Market Picks remain only in the current page's memory; they are not a background tracker or persistent Torn-data store.

## Compliance

- [Torn scripting compliance notes](TORN-SCRIPTING-COMPLIANCE.md)
