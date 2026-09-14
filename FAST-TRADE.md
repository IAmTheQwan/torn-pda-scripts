# TheQwan Fast Trade

`theqwan-fast-trade.user.js` adds a fixed, colored control to the upper-left of
Torn in PDA and desktop userscript managers. A normal tap performs the single
action currently shown by the button. Holding it for three seconds opens local
settings.

## Install

Use this raw URL in Torn PDA:

`https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/fast-trade/theqwan-fast-trade.user.js`

No player ID is embedded in the published source. On first use, tap **SET** and
enter the trusted player's numeric Torn ID. The optional remembered trade ID is
learned automatically after that player's trade is visibly verified.

## Button states

- **GO** (green): open the configured player's trade. Once a verified trade ID
  is remembered, GO opens its Add Money page directly.
- **START** (yellow): manually initiate a new trade if Torn presents that form.
- **MONEY** (yellow): open the visible trade's native Add Money page.
- **ADD** (orange): fill the visible money form with wallet cash minus the
  configured reserve, then submit Torn's native Change control. This produces
  one Torn request from that tap.
- **LOCK** (blue): press Torn's first enabled Accept control.
- **FINAL** (green): press Torn's final enabled acceptance control.
- **WAIT** (gray): Torn is loading, processing, locked, or running its native
  confirmation period. The button becomes actionable as soon as the visible
  page exposes the next enabled control.
- **BLOCK/NEW** (red): the target could not be verified or the remembered trade
  expired. No money or acceptance action is performed.

## Safety and compliance design

- The script never makes its own background request to Torn.
- It reads only the page that the player manually loaded and is viewing.
- Every server-side trade action requires a separate deliberate tap.
- Route changes, field filling, button coloring, and DOM observation do not
  submit a server action by themselves.
- The target must match the configured numeric player ID or an already verified
  and remembered trade ID before cash or acceptance controls are enabled.
- Target, reserve, description, and remembered trade ID stay in local
  userscript storage. The script uses no API key and no third-party service.

Torn's public rules remain authoritative and can change. See
<https://www.torn.com/rules.php>.

## Updates

- **1.0.2:** Fill the configured player ID and trade description into Torn's
  visible New Trade form. The normal "no current trades" notice is no longer
  mistaken for an expired remembered trade.
- **1.0.1:** Store settings synchronously in Torn's local page storage first so
  Torn PDA cannot return an asynchronous `GM_getValue` result in place of the
  saved target. Compatible userscript storage is still mirrored as a fallback.
