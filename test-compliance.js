const assert = require('assert');
const fs = require('fs');

const bookie = fs.readFileSync('qwantum-bookie.source.js', 'utf8');
const auction = fs.readFileSync('theqwan-caf-base.user.js', 'utf8');
const history = fs.readFileSync('theqwan-caf-helper.user.js', 'utf8');

// Torn page requests must be produced by the page itself after a direct user
// action. CAF may observe loaded responses, but must not batch-fetch listings
// or item details itself.
assert(!auction.includes('fetch(`/amarket.php'));
assert(!auction.includes('fetch(`/page.php?sid=inventory'));
assert(!auction.includes('loadAllPages'));
assert(!auction.includes('fetchQualityForFilteredItems'));
assert(!auction.includes('location.reload()'));
assert(auction.includes('Filter Current Page'));
assert(auction.includes("document.visibilityState !== \"visible\""));

// The external history lookup is one explicit History-button action and does
// not receive a Torn API key or cookies.
assert(history.includes('btn.onclick'));
assert(history.includes('runHistory(card, btn)'));
assert(history.includes('No Torn API key, account ID, bid, or page cookies are sent.'));

// All Torn API call families share a conservative rolling-minute ledger.
assert(bookie.includes('const TORN_API_SAFE_REQUEST_LIMIT = 80'));
assert(bookie.includes('async function acquireTornApiRequestSlot()'));
assert(bookie.includes('async function requestLogPage(from, to)'));
assert(bookie.includes('async function requestGoalsPath(path)'));
assert(bookie.includes('async function requestTornV2(path, key)'));
assert(bookie.includes('async function requestTrainingTornV2(path, key)'));
assert((bookie.match(/await acquireTornApiRequestSlot\(\);/g) || []).length >= 4);
assert(!bookie.includes('additionalMarketsControl.click()'));

console.log('Torn scripting/API compliance checks passed.');
