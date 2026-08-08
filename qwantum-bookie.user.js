// ==UserScript==
// @name         Torn PDA Bookie Panel
// @version      1.9.6
// @description  Floating PDA panel for Torn bookie open bets, daily totals, net, and batch tracking
// @author       TheQwan
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      v3.football.api-sports.io
// @connect      www.thesportsdb.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/Bookie/qwantum-bookie.meta.js
// @downloadURL  https://github.com/IAmTheQwan/torn-pda-scripts/raw/refs/heads/Bookie/qwantum-bookie.user.js
// ==/UserScript==
(function () {
'use strict';
function defaultScanStartDate() {
const d = new Date();
d.setDate(d.getDate() - 60);
return localDateKey(d);
}
function defaultBatchStartDate() {
const d = new Date();
d.setDate(d.getDate() - 30);
return localDateKey(d);
}
let apiKey = localStorage.getItem('tbp_api_key') || '';
let scanMode = localStorage.getItem('tbp_scan_mode') || 'both';
let scanStartDate = localStorage.getItem('tbp_scan_start_date') || defaultScanStartDate();
let maxPages = Number(localStorage.getItem('tbp_max_pages') || 5);
let activeTab = localStorage.getItem('tbp_active_tab') || 'open';
let isMinimized = JSON.parse(localStorage.getItem('tbp_minimized') || 'false');
let showDebug = JSON.parse(localStorage.getItem('tbp_show_debug') || 'false');
let footballScanEnabled = JSON.parse(localStorage.getItem('tbp_football_scan_enabled') || 'false');
let footballOddsHistoryEnabled = JSON.parse(localStorage.getItem('tbp_football_odds_history_enabled') || 'false');
let guidedFootballReviewEnabled = JSON.parse(localStorage.getItem('tbp_guided_football_review_enabled') || 'false');
let footballScoreEnabled = JSON.parse(localStorage.getItem('tbp_football_score_enabled') || 'false');
let footballScoreApiKey = localStorage.getItem('tbp_football_score_api_key') || '';
let footballScoreProvider = localStorage.getItem('tbp_football_score_provider') || 'sportsdb';
let batchFeatureEnabled = JSON.parse(localStorage.getItem('tbp_batch_feature_enabled') || 'false');
let batches = JSON.parse(localStorage.getItem('tbp_batches') || '[]');
let selectedBatchId = localStorage.getItem('tbp_selected_batch_id') || '';
let rawLogs = [];
let openBets = [];
let dailyTotals = [];
let todaySummary = { bets: 0, wins: 0, losses: 0, refunds: 0, won: 0, lost: 0, net: 0 };
let overallBookieNet = 0;
let lastLoadStatus = 'Not loaded yet.';
const CACHE_DB_NAME = 'tbp_bookie_history';
const CACHE_DB_VERSION = 1;
const CACHE_STORE_NAME = 'logs';
const MAX_API_PAGES_PER_SCAN = 50;
const API_PAGE_DELAY_MS = 1100;
const FOOTBALL_HOME_YELLOW_MIN = 1.2;
const FOOTBALL_HOME_GREEN_MIN = 1.3;
const FOOTBALL_HOME_ODDS_MAX = 1.7;
const FOOTBALL_AWAY_ODDS_MIN = 1.2;
const FOOTBALL_AWAY_ODDS_MAX = 1.7;
const FOOTBALL_ODDS_HISTORY_KEY = 'tbp_football_odds_history';
const FOOTBALL_FIXTURE_RECORDS_KEY = 'tbp_football_fixture_records';
const MANUAL_BET_LINKS_KEY = 'tbp_manual_bet_fixture_links';
const PENDING_MANUAL_CAPTURE_KEY = 'tbp_pending_manual_bet_capture';
const MY_BETS_SNAPSHOT_KEY = 'tbp_my_bets_open_snapshot';
const MAX_ODDS_HISTORY_GAMES = 100;
const MAX_ODDS_OBSERVATIONS_PER_SELECTION = 20;
const MAX_GUIDED_FOOTBALL_GAMES = 20;
const MAX_FOOTBALL_FIXTURE_RECORDS = 200;
const FOOTBALL_FIXTURE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const FOOTBALL_BET_LINK_WINDOW_MS = 10 * 60 * 1000;
const FOOTBALL_PENDING_BET_VISIBLE_MS = 30 * 60 * 1000;
const MANUAL_CAPTURE_TTL_MS = 30 * 60 * 1000;
const MY_BETS_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CLUSTER_GAP_SECONDS = 8 * 60 * 60;
const FOOTBALL_SCORE_USAGE_KEY = 'tbp_football_score_usage';
const FOOTBALL_SCORE_CACHE_KEY = 'tbp_football_score_date_cache';
const FOOTBALL_SCORE_MATCHES_KEY = 'tbp_football_score_matches';
const FOOTBALL_SCORE_DAILY_LIMIT = 100;
const FOOTBALL_SCORE_CACHE_MS = 10 * 60 * 1000;
const SPORTSDB_REQUEST_TIMES_KEY = 'tbp_sportsdb_request_times';
const SPORTSDB_MIN_REQUEST_GAP_MS = 2100;
const SPORTSDB_MINUTE_LIMIT = 30;
const BET_STATS_LINKS_KEY = 'tbp_bet_stats_links';
const styles = `
#tbp-container { position:fixed; top:20px; right:20px; width:390px; background:#1a1a1a; color:#eee; border:1px solid #444; z-index:999999!important; font-family:'Segoe UI',sans-serif; border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,.8); overflow:hidden; }
#tbp-container.minimized { width:38px; height:38px; cursor:pointer; display:flex; align-items:center; justify-content:center; background:#007bff; border:1px solid #0056b3; border-radius:4px; font-weight:bold; font-size:20px; }
.tbp-header { background:#252525; padding:10px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; }
.tbp-header-title { display:flex; align-items:center; gap:8px; }
.tbp-scan-btn { padding:4px 7px; font-size:10px; background:#705b00; color:#fff; border:1px solid #a98a00; }
.tbp-guide-btn { padding:4px 7px; font-size:10px; background:#275a7a; color:#fff; border:1px solid #3b82a8; }
.tbp-tabs { display:flex; background:#222; border-bottom:1px solid #333; }
.tbp-tab { flex:1; padding:10px 3px; text-align:center; cursor:pointer; font-size:9px; text-transform:uppercase; color:#888; }
.tbp-tab.active { background:#333; border-bottom:2px solid #007bff; color:#fff; font-weight:bold; }
.tbp-content { padding:12px; max-height:460px; overflow-y:auto; scrollbar-width:thin; }
.tbp-card { background:#242424; border:1px solid #333; border-radius:6px; padding:10px; margin-bottom:8px; }
.tbp-row { display:flex; justify-content:space-between; gap:8px; font-size:12px; margin-top:4px; }
.tbp-daily-row { display:grid; grid-template-columns:80px 1fr 55px 55px; gap:6px; align-items:center; background:#242424; border:1px solid #333; border-radius:5px; padding:7px 8px; margin-bottom:5px; font-size:11px; }
.tbp-daily-head { background:#181818; color:#aaa; font-weight:bold; text-transform:uppercase; font-size:10px; }
.tbp-muted { color:#aaa; font-size:11px; }
.tbp-win { color:#28a745; font-weight:bold; }
.tbp-loss { color:#d9534f; font-weight:bold; }
.tbp-blue { color:#4da3ff; font-weight:bold; }
.tbp-input, .tbp-select { width:100%; padding:8px; margin-bottom:10px; background:#333; border:1px solid #444; color:white; border-radius:4px; box-sizing:border-box; font-size:12px; }
.tbp-btn { cursor:pointer; border:none; border-radius:4px; padding:7px 10px; font-size:12px; outline:none; }
.tbp-btn-primary { background:#007bff; color:white; }
.tbp-btn-success { background:#28a745; color:white; }
.tbp-btn-danger { background:#d9534f; color:white; }
.tbp-summary-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
.tbp-summary-box { background:#222; border:1px solid #333; border-radius:6px; padding:8px; text-align:center; }
.tbp-summary-label { color:#aaa; font-size:10px; text-transform:uppercase; }
.tbp-summary-value { font-size:16px; font-weight:bold; margin-top:3px; }
.tbp-debug { font-size:10px; color:#bbb; white-space:pre-wrap; word-break:break-word; background:#111; border:1px solid #333; padding:6px; border-radius:4px; margin-top:6px; }
.tbp-btn-row { display:flex; gap:6px; margin-top:8px; }
.tbp-btn-row .tbp-btn { flex:1; }
li.tbp-football-match > a > ul.pop-game {
position:relative;
outline-offset:-2px;
}
li.tbp-football-home-green > a > ul.pop-game {
background:linear-gradient(90deg, rgba(40,167,69,.48), rgba(40,167,69,.2))!important;
outline:2px solid #39d353;
box-shadow:inset 7px 0 0 #28a745, 0 0 9px rgba(57,211,83,.75)!important;
}
li.tbp-football-home-yellow > a > ul.pop-game {
background:linear-gradient(90deg, rgba(255,215,0,.56), rgba(255,215,0,.22))!important;
outline:2px solid #ffd700;
box-shadow:inset 7px 0 0 #d4ad00, 0 0 9px rgba(255,215,0,.72)!important;
}
li.tbp-football-away-orange > a > ul.pop-game {
background:linear-gradient(90deg, rgba(255,140,0,.58), rgba(255,140,0,.22))!important;
outline:2px solid #ff9800;
box-shadow:inset 7px 0 0 #e87800, 0 0 9px rgba(255,152,0,.72)!important;
}
li.tbp-football-match > a > ul.pop-game .matchName,
li.tbp-football-match > a > ul.pop-game .team-names { font-weight:700!important; }
.tbp-football-badge { display:inline-block; margin-left:7px; padding:2px 5px; border-radius:3px; background:#28a745; color:#fff; font-size:10px; font-weight:bold; vertical-align:middle; }
.tbp-football-badge-home-yellow { background:#d4ad00; color:#171300; }
.tbp-football-badge-away-orange { background:#e87800; color:#fff; }
.tbp-odds-delta { display:inline-block; margin-left:5px; padding:1px 4px; border-radius:3px; color:#fff; font-size:10px; font-weight:bold; }
.tbp-odds-delta-up { background:#28a745; }
.tbp-odds-delta-down { background:#d9534f; }
.tbp-capture-btn { padding:3px 8px; min-width:auto; font-size:10px; }
`;
const styleSheet = document.createElement('style');
styleSheet.innerText = styles;
if (document.head) document.head.appendChild(styleSheet);
const container = document.createElement('div');
container.id = 'tbp-container';
if (document.body) document.body.appendChild(container);
function ensurePanelMounted() {
if (!styleSheet.isConnected && document.head) document.head.appendChild(styleSheet);
if (!container.isConnected && document.body) document.body.appendChild(container);
}
let panelMountObserver = null;
function startPanelMountObserver() {
if (panelMountObserver || !document.documentElement) return;
panelMountObserver = new MutationObserver(() => {
if (!styleSheet.isConnected || !container.isConnected) ensurePanelMounted();
});
panelMountObserver.observe(document.documentElement, { childList: true, subtree: true });
}
function saveData() {
localStorage.setItem('tbp_api_key', apiKey);
localStorage.setItem('tbp_scan_mode', scanMode);
localStorage.setItem('tbp_scan_start_date', scanStartDate);
localStorage.setItem('tbp_max_pages', maxPages);
localStorage.setItem('tbp_active_tab', activeTab);
localStorage.setItem('tbp_minimized', JSON.stringify(isMinimized));
localStorage.setItem('tbp_show_debug', JSON.stringify(showDebug));
localStorage.setItem('tbp_football_scan_enabled', JSON.stringify(footballScanEnabled));
localStorage.setItem('tbp_football_odds_history_enabled', JSON.stringify(footballOddsHistoryEnabled));
localStorage.setItem('tbp_guided_football_review_enabled', JSON.stringify(guidedFootballReviewEnabled));
localStorage.setItem('tbp_football_score_enabled', JSON.stringify(footballScoreEnabled));
localStorage.setItem('tbp_football_score_api_key', footballScoreApiKey);
localStorage.setItem('tbp_football_score_provider', footballScoreProvider);
localStorage.setItem('tbp_batch_feature_enabled', JSON.stringify(batchFeatureEnabled));
localStorage.setItem('tbp_batches', JSON.stringify(batches));
localStorage.setItem('tbp_selected_batch_id', selectedBatchId);
}
function money(n) {
return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function num(n) {
return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function openCacheDb() {
return new Promise((resolve, reject) => {
const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
request.onupgradeneeded = () => {
const db = request.result;
const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'cacheId' });
store.createIndex('owner', 'owner', { unique: false });
};
request.onsuccess = () => resolve(request.result);
request.onerror = () => reject(request.error);
});
}
async function getCacheOwner() {
if (!apiKey) return '';
const bytes = new TextEncoder().encode(apiKey);
const digest = await crypto.subtle.digest('SHA-256', bytes);
return Array.from(new Uint8Array(digest))
.slice(0, 12)
.map(value => value.toString(16).padStart(2, '0'))
.join('');
}
async function loadCachedLogs() {
const owner = await getCacheOwner();
if (!owner) return [];
const db = await openCacheDb();
try {
return await new Promise((resolve, reject) => {
const request = db
.transaction(CACHE_STORE_NAME, 'readonly')
.objectStore(CACHE_STORE_NAME)
.index('owner')
.getAll(owner);
request.onsuccess = () => resolve(request.result.map(({ cacheId, owner: ignored, ...log }) => log));
request.onerror = () => reject(request.error);
});
} finally {
db.close();
}
}
async function storeCachedLogs(logs) {
if (!logs.length) return;
const owner = await getCacheOwner();
if (!owner) return;
const db = await openCacheDb();
try {
await new Promise((resolve, reject) => {
const transaction = db.transaction(CACHE_STORE_NAME, 'readwrite');
const store = transaction.objectStore(CACHE_STORE_NAME);
logs.forEach(log => store.put({ ...log, owner, cacheId: `${owner}:${log.id}` }));
transaction.oncomplete = () => resolve();
transaction.onerror = () => reject(transaction.error);
transaction.onabort = () => reject(transaction.error);
});
} finally {
db.close();
}
}
function delay(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}
function utcDateKey(value = Date.now()) {
return new Date(value).toISOString().slice(0, 10);
}
function loadFootballScoreUsage() {
const today = utcDateKey();
try {
const stored = JSON.parse(localStorage.getItem(FOOTBALL_SCORE_USAGE_KEY) || '{}');
if (stored.date === today) {
const limit = Math.max(1, Number(stored.limit || FOOTBALL_SCORE_DAILY_LIMIT));
const used = Math.max(0, Number(stored.used || 0));
return { ...stored, date: today, limit, used, remaining: Math.max(0, Number.isFinite(Number(stored.remaining)) ? Number(stored.remaining) : limit - used) };
}
} catch {
// Start a clean counter if local storage was incomplete.
}
return { date: today, limit: FOOTBALL_SCORE_DAILY_LIMIT, used: 0, remaining: FOOTBALL_SCORE_DAILY_LIMIT, lastRequestAt: 0 };
}
function saveFootballScoreUsage(usage) {
localStorage.setItem(FOOTBALL_SCORE_USAGE_KEY, JSON.stringify(usage));
return usage;
}
function parseResponseHeaders(rawHeaders) {
const headers = {};
String(rawHeaders || '').split(/\r?\n/).forEach(line => {
const separator = line.indexOf(':');
if (separator < 1) return;
headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
});
return headers;
}
function countFootballScoreRequest(rawHeaders = '') {
const usage = loadFootballScoreUsage();
const headers = parseResponseHeaders(rawHeaders);
const headerLimit = Number(headers['x-ratelimit-requests-limit']);
const headerRemaining = Number(headers['x-ratelimit-requests-remaining']);
if (Number.isFinite(headerLimit) && headerLimit > 0) usage.limit = headerLimit;
if (Number.isFinite(headerRemaining) && headerRemaining >= 0) {
usage.remaining = headerRemaining;
usage.used = Math.max(0, usage.limit - headerRemaining);
usage.source = 'provider';
} else {
usage.used += 1;
usage.remaining = Math.max(0, usage.limit - usage.used);
usage.source = 'local';
}
usage.lastRequestAt = Date.now();
return saveFootballScoreUsage(usage);
}
function loadFootballScoreCache() {
try {
const parsed = JSON.parse(localStorage.getItem(FOOTBALL_SCORE_CACHE_KEY) || '{}');
return parsed && typeof parsed === 'object' ? parsed : {};
} catch {
return {};
}
}
function saveFootballScoreCache(cache) {
const limited = Object.entries(cache)
.sort((a, b) => Number(b[1]?.cachedAt || 0) - Number(a[1]?.cachedAt || 0))
.slice(0, 30);
localStorage.setItem(FOOTBALL_SCORE_CACHE_KEY, JSON.stringify(Object.fromEntries(limited)));
}
function loadFootballScoreMatches() {
try {
const parsed = JSON.parse(localStorage.getItem(FOOTBALL_SCORE_MATCHES_KEY) || '{}');
return parsed && typeof parsed === 'object' ? parsed : {};
} catch {
return {};
}
}
function saveFootballScoreMatches(matches) {
const limited = Object.entries(matches)
.sort((a, b) => Number(b[1]?.checkedAt || 0) - Number(a[1]?.checkedAt || 0))
.slice(0, 300);
localStorage.setItem(FOOTBALL_SCORE_MATCHES_KEY, JSON.stringify(Object.fromEntries(limited)));
}
function normalizeScoreTeamName(value) {
return String(value || '')
.normalize('NFD')
.replace(/[\u0300-\u036f]/g, '')
.toLowerCase()
.replace(/\b(fc|cf|sc|afc|club|fk|bk|ac|cd)\b/g, ' ')
.replace(/[^a-z0-9]+/g, ' ')
.replace(/\s+/g, ' ')
.trim();
}
function scoreTeamSimilarity(left, right) {
const a = normalizeScoreTeamName(left);
const b = normalizeScoreTeamName(right);
if (!a || !b) return 0;
if (a === b) return 1;
if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
const aTokens = new Set(a.split(' '));
const bTokens = new Set(b.split(' '));
const intersection = [...aTokens].filter(token => bTokens.has(token)).length;
return intersection / Math.max(aTokens.size, bTokens.size);
}
function loadSportsDbRequestTimes(now = Date.now()) {
try {
const parsed = JSON.parse(localStorage.getItem(SPORTSDB_REQUEST_TIMES_KEY) || '[]');
return (Array.isArray(parsed) ? parsed : [])
.map(Number)
.filter(timestamp => now - timestamp < 60 * 1000)
.sort((a, b) => a - b);
} catch {
return [];
}
}
function getSportsDbUsage() {
const requests = loadSportsDbRequestTimes();
localStorage.setItem(SPORTSDB_REQUEST_TIMES_KEY, JSON.stringify(requests));
return {
used: requests.length,
remaining: Math.max(0, SPORTSDB_MINUTE_LIMIT - requests.length),
limit: SPORTSDB_MINUTE_LIMIT,
oldestAt: requests[0] || 0
};
}
function countSportsDbRequest() {
const requests = loadSportsDbRequestTimes();
requests.push(Date.now());
localStorage.setItem(SPORTSDB_REQUEST_TIMES_KEY, JSON.stringify(requests));
return getSportsDbUsage();
}
async function waitForSportsDbSlot() {
const usage = getSportsDbUsage();
if (usage.remaining <= 0 && usage.oldestAt) {
await delay(Math.max(100, 60 * 1000 - (Date.now() - usage.oldestAt) + 150));
}
}
function sportsDbFixtureCacheKey(fixture, dateKey) {
return `sportsdb:${dateKey}:${normalizeScoreTeamName(fixture.homeTeam)}:${normalizeScoreTeamName(fixture.awayTeam)}`;
}
function requestSportsDbFixture(fixture, dateKey) {
return new Promise(resolve => {
const eventName = `${fixture.homeTeam}_vs_${fixture.awayTeam}`.replace(/\s+/g, '_');
const url = `https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=${encodeURIComponent(eventName)}&d=${encodeURIComponent(dateKey)}`;
GM_xmlhttpRequest({
method: 'GET',
url,
onload: res => {
countSportsDbRequest();
try {
const data = JSON.parse(res.responseText);
resolve({ error: null, events: Array.isArray(data.event) ? data.event : Array.isArray(data.events) ? data.events : [] });
} catch {
resolve({ error: 'Could not read TheSportsDB response.', events: [] });
}
},
onerror: () => {
countSportsDbRequest();
resolve({ error: 'Could not reach TheSportsDB.', events: [] });
}
});
});
}
function sportsDbEventTimestamp(event) {
const raw = String(event.strTimestamp || '').trim();
const usTimestamp = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
if (usTimestamp) {
let hour = Number(usTimestamp[4]);
const meridiem = String(usTimestamp[7] || '').toUpperCase();
if (meridiem === 'PM' && hour < 12) hour += 12;
if (meridiem === 'AM' && hour === 12) hour = 0;
return Date.UTC(Number(usTimestamp[3]), Number(usTimestamp[1]) - 1, Number(usTimestamp[2]), hour, Number(usTimestamp[5]), Number(usTimestamp[6] || 0));
}
const combined = Date.parse(`${event.dateEvent || ''}T${event.strTime || '00:00:00'}Z`);
return Number.isFinite(combined) ? combined : 0;
}
function findSportsDbEvent(fixture, events) {
return events.map(event => {
const homeSimilarity = scoreTeamSimilarity(fixture.homeTeam, event.strHomeTeam);
const awaySimilarity = scoreTeamSimilarity(fixture.awayTeam, event.strAwayTeam);
return { event, homeSimilarity, awaySimilarity, confidence: (homeSimilarity + awaySimilarity) / 2 };
}).filter(candidate => candidate.homeSimilarity >= 0.72 && candidate.awaySimilarity >= 0.72 && candidate.confidence >= 0.82)
.sort((a, b) => b.confidence - a.confidence)[0] || null;
}
function isFinalFootballStatus(status) {
return ['FT', 'AET', 'AP', 'PEN', 'AW'].includes(String(status || '').toUpperCase());
}
async function getSportsDbEventForFixture(fixture, dateKey) {
const cache = loadFootballScoreCache();
const cacheKey = sportsDbFixtureCacheKey(fixture, dateKey);
const cached = cache[cacheKey];
const cachedFinal = isFinalFootballStatus(cached?.match?.event?.strStatus);
if (cached && (cachedFinal || Date.now() - Number(cached.cachedAt || 0) < FOOTBALL_SCORE_CACHE_MS)) {
return { ...cached.match, cached: true };
}
await waitForSportsDbSlot();
const result = await requestSportsDbFixture(fixture, dateKey);
if (result.error) return { error: result.error, event: null, cached: false };
const match = findSportsDbEvent(fixture, result.events);
const stored = { error: null, event: match?.event || null, confidence: Number(match?.confidence || 0), cached: false };
cache[cacheKey] = { cachedAt: Date.now(), match: stored };
saveFootballScoreCache(cache);
return stored;
}
async function checkOpenBetScoresSportsDb(namedBets) {
const reviewedByGameId = new Map(loadFootballFixtureRecords().map(fixture => [String(fixture.gameId), fixture]));
const today = utcDateKey();
const scoreMatches = loadFootballScoreMatches();
let matched = 0;
let requests = 0;
let cacheHits = 0;
let firstError = '';
for (let index = 0; index < namedBets.length; index++) {
const bet = namedBets[index];
const fixture = { ...(reviewedByGameId.get(String(bet.fixture.gameId)) || {}), ...bet.fixture };
const dateKey = fixture.startTimestamp ? utcDateKey(fixture.startTimestamp) : today;
const result = await getSportsDbEventForFixture(fixture, dateKey);
if (result.error) {
firstError ||= result.error;
continue;
}
if (result.cached) cacheHits++;
else requests++;
if (!result.event) continue;
const event = result.event;
scoreMatches[String(bet.id)] = {
provider: 'sportsdb',
providerFixtureId: event.idEvent,
homeTeam: event.strHomeTeam || fixture.homeTeam,
awayTeam: event.strAwayTeam || fixture.awayTeam,
homeGoals: event.intHomeScore === '' || event.intHomeScore === null || event.intHomeScore === undefined ? null : Number(event.intHomeScore),
awayGoals: event.intAwayScore === '' || event.intAwayScore === null || event.intAwayScore === undefined ? null : Number(event.intAwayScore),
statusShort: event.strStatus || '',
statusLong: event.strStatus || '',
elapsed: event.strProgress || '',
kickoff: sportsDbEventTimestamp(event),
confidence: result.confidence,
checkedAt: Date.now()
};
matched++;
if (index < namedBets.length - 1 && !result.cached) await delay(SPORTSDB_MIN_REQUEST_GAP_MS);
}
saveFootballScoreMatches(scoreMatches);
const usage = getSportsDbUsage();
lastLoadStatus = `TheSportsDB: matched ${matched} of ${namedBets.length}; ${requests} request${requests === 1 ? '' : 's'}, ${cacheHits} cached. ${usage.remaining}/${usage.limit} calls remain this minute.`;
if (firstError) alert(firstError);
}
function requestFootballFixtures(dateKey) {
return new Promise(resolve => {
GM_xmlhttpRequest({
method: 'GET',
url: `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(dateKey)}&timezone=UTC`,
headers: { 'x-apisports-key': footballScoreApiKey },
onload: res => {
const usage = countFootballScoreRequest(res.responseHeaders);
try {
const data = JSON.parse(res.responseText);
const providerError = data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length);
if (res.status < 200 || res.status >= 300 || providerError) {
resolve({ error: `Score API error (${res.status || 'response'}). Check the key and account quota.`, fixtures: [], usage });
return;
}
resolve({ error: null, fixtures: Array.isArray(data.response) ? data.response : [], usage });
} catch {
resolve({ error: 'Could not read the score API response.', fixtures: [], usage });
}
},
onerror: () => {
const usage = countFootballScoreRequest();
resolve({ error: 'Could not reach the score API.', fixtures: [], usage });
}
});
});
}
async function getFootballFixturesForDate(dateKey) {
const cache = loadFootballScoreCache();
const cached = cache[dateKey];
if (cached && Date.now() - Number(cached.cachedAt || 0) < FOOTBALL_SCORE_CACHE_MS) {
return { fixtures: cached.fixtures || [], cached: true, error: null };
}
if (loadFootballScoreUsage().remaining <= 0) {
return { fixtures: [], cached: false, error: 'The daily score request allowance is exhausted.' };
}
const result = await requestFootballFixtures(dateKey);
if (!result.error) {
cache[dateKey] = { cachedAt: Date.now(), fixtures: result.fixtures };
saveFootballScoreCache(cache);
}
return { ...result, cached: false };
}
function findProviderFixture(fixture, providerFixtures) {
const kickoff = Number(fixture.startTimestamp || 0);
const candidates = providerFixtures.map(provider => {
const homeSimilarity = scoreTeamSimilarity(fixture.homeTeam, provider.teams?.home?.name);
const awaySimilarity = scoreTeamSimilarity(fixture.awayTeam, provider.teams?.away?.name);
const providerKickoff = Number(provider.fixture?.timestamp || 0) * 1000;
const timeGap = kickoff && providerKickoff ? Math.abs(kickoff - providerKickoff) : 0;
return { provider, homeSimilarity, awaySimilarity, timeGap, confidence: (homeSimilarity + awaySimilarity) / 2 };
}).filter(candidate =>
candidate.homeSimilarity >= 0.72
&& candidate.awaySimilarity >= 0.72
&& candidate.confidence >= 0.82
&& (!kickoff || candidate.timeGap <= 6 * 60 * 60 * 1000)
).sort((a, b) => b.confidence - a.confidence || a.timeGap - b.timeGap);
if (!candidates.length) return null;
if (candidates.length > 1 && candidates[0].confidence - candidates[1].confidence < 0.08) return null;
return candidates[0];
}
async function checkOpenBetScoresApiFootball(namedBets) {
if (!footballScoreApiKey) {
alert('Add an API-Football key in Settings first.');
return;
}
const reviewedByGameId = new Map(loadFootballFixtureRecords().map(fixture => [String(fixture.gameId), fixture]));
const fixtures = namedBets.map(bet => ({
bet,
fixture: { ...(reviewedByGameId.get(String(bet.fixture.gameId)) || {}), ...bet.fixture }
}));
const today = utcDateKey();
const dates = [...new Set(fixtures.map(entry => entry.fixture.startTimestamp ? utcDateKey(entry.fixture.startTimestamp) : today))];
const fixturesByDate = {};
let requests = 0;
let cacheHits = 0;
for (const dateKey of dates) {
const result = await getFootballFixturesForDate(dateKey);
if (result.error) {
alert(result.error);
break;
}
fixturesByDate[dateKey] = result.fixtures;
if (result.cached) cacheHits++;
else requests++;
}
const scoreMatches = loadFootballScoreMatches();
let matched = 0;
fixtures.forEach(({ bet, fixture }) => {
const dateKey = fixture.startTimestamp ? utcDateKey(fixture.startTimestamp) : today;
const candidate = findProviderFixture(fixture, fixturesByDate[dateKey] || []);
if (!candidate) return;
const provider = candidate.provider;
scoreMatches[String(bet.id)] = {
providerFixtureId: provider.fixture?.id,
homeTeam: provider.teams?.home?.name || fixture.homeTeam,
awayTeam: provider.teams?.away?.name || fixture.awayTeam,
homeGoals: provider.goals?.home,
awayGoals: provider.goals?.away,
statusShort: provider.fixture?.status?.short || '',
statusLong: provider.fixture?.status?.long || '',
elapsed: provider.fixture?.status?.elapsed,
kickoff: Number(provider.fixture?.timestamp || 0) * 1000,
confidence: candidate.confidence,
checkedAt: Date.now()
};
matched++;
});
saveFootballScoreMatches(scoreMatches);
lastLoadStatus = `Scores: matched ${matched} of ${namedBets.length} named open bets; ${requests} request${requests === 1 ? '' : 's'}, ${cacheHits} cached date${cacheHits === 1 ? '' : 's'}.`;
}
async function checkOpenBetScores() {
if (!footballScoreEnabled) {
alert('Enable Football scores in Settings first.');
return;
}
const namedBets = openBets.filter(bet => bet.fixture?.homeTeam && bet.fixture?.awayTeam);
if (!namedBets.length) {
alert('No named open Football bets are available to match.');
return;
}
if (footballScoreProvider === 'sportsdb') {
await checkOpenBetScoresSportsDb(namedBets);
return;
}
await checkOpenBetScoresApiFootball(namedBets);
}
function formatFootballScore(score) {
if (!score) return '';
const status = score.statusShort || score.statusLong || 'Scheduled';
const hasScore = score.homeGoals !== null && score.homeGoals !== undefined
&& score.awayGoals !== null && score.awayGoals !== undefined;
const liveSuffix = score.elapsed && !['FT', 'AET', 'PEN'].includes(status) ? ` ${score.elapsed}'` : '';
return `${hasScore ? `${score.homeGoals}-${score.awayGoals} ` : ''}${status}${liveSuffix}`;
}
function safeJson(value) {
try {
if (value === null || value === undefined) return '';
if (typeof value === 'string') return value;
return JSON.stringify(value, null, 2);
} catch {
return String(value);
}
}
function deepText(value) {
if (value === null || value === undefined) return '';
if (typeof value === 'string') return value;
if (typeof value === 'number' || typeof value === 'boolean') return String(value);
if (Array.isArray(value)) return value.map(deepText).join(' ');
if (typeof value === 'object') return Object.keys(value).map(k => `${k}: ${deepText(value[k])}`).join(' ');
return String(value);
}
function localDateKey(date) {
const y = date.getFullYear();
const m = String(date.getMonth() + 1).padStart(2, '0');
const d = String(date.getDate()).padStart(2, '0');
return `${y}-${m}-${d}`;
}
function dateToUnixStart(dateString) {
const d = new Date(`${dateString}T00:00:00`);
return Math.floor(d.getTime() / 1000);
}
function unixToDateKey(ts) {
return localDateKey(new Date(ts * 1000));
}
function formatDate(ts) {
if (!ts) return 'n/a';
return new Date(ts * 1000).toLocaleDateString();
}
function getTodayStartUnix() {
const d = new Date();
d.setHours(0, 0, 0, 0);
return Math.floor(d.getTime() / 1000);
}
function getScanFromUnix() {
if (scanMode === 'pages') return 0;
return dateToUnixStart(scanStartDate || defaultScanStartDate());
}
function normalizeLog(raw) {
const timestamp = raw.timestamp || raw.time || raw.date || 0;
const title = raw.title || raw.event || raw.log || raw.message || '';
const text = [title, deepText(raw.data), deepText(raw.params)].filter(Boolean).join(' ');
return {
id: raw.id || `${timestamp}_${title}_${Math.random()}`,
timestamp,
title,
text,
raw
};
}
function getSelectionKey(log) {
const sel = log.raw?.data?.selection;
if (Array.isArray(sel) && sel.length > 0) return sel.join('/');
const match = log.text.match(/selection:\s*([\d\s]+)/i);
if (match) return match[1].trim().split(/\s+/).join('/');
return '';
}
function getBetAmount(log) {
const val = Number(log.raw?.data?.bet || 0);
return isNaN(val) ? 0 : val;
}
function getWinnings(log) {
const val = Number(log.raw?.data?.winnings || 0);
return isNaN(val) ? 0 : val;
}
function getOdds(log) {
const val = Number(log.raw?.data?.odds || 0);
return isNaN(val) ? 0 : val;
}
function classifyLog(log) {
const t = `${log.title} ${log.text}`.toLowerCase();
if (!t.includes('bookie')) return 'other';
if (t.includes('withdraw')) return 'withdraw';
if (t.includes('deposit')) return 'deposit';
if (t.includes('refund') || t.includes('refunded')) return 'refund';
if (t.includes('win') || t.includes('won')) return 'win';
if (t.includes('lose') || t.includes('loss') || t.includes('lost')) return 'loss';
if (t.includes('bookie bet') || t.includes('bet placed') || t.includes('placed')) return 'placed';
return 'other';
}
function betMatchesBatchAmount(amount, batch) {
const suffix = String(batch?.endsWith || '').trim();
if (!suffix) return true;
return String(amount || 0).endsWith(suffix);
}
function isOnOrAfterDate(log, dateString) {
if (!dateString) return true;
return log.timestamp >= dateToUnixStart(dateString);
}
function loadBetStatsLinks() {
try {
const parsed = JSON.parse(localStorage.getItem(BET_STATS_LINKS_KEY) || '{}');
return parsed && typeof parsed === 'object' ? parsed : {};
} catch {
return {};
}
}
function getFixtureStatsCategory(fixture, betOdds = 0) {
if (!fixture) return '';
const selection = normalizeScoreTeamName(fixture.placedSelection || fixture.recommendedSelection);
const home = normalizeScoreTeamName(fixture.homeTeam);
const away = normalizeScoreTeamName(fixture.awayTeam);
if (fixture.matchType === 'home-green' && selection && selection === home) return 'green';
if (fixture.matchType === 'home-yellow' && selection && selection === home) return 'yellow';
if (fixture.matchType === 'away-orange' && selection && selection === away) return 'orange';
const odds = Number(betOdds || fixture.myBetsOdds || fixture.odds || 0);
if (selection && selection === home) {
if (odds >= FOOTBALL_HOME_GREEN_MIN && odds <= FOOTBALL_HOME_ODDS_MAX) return 'green';
if (odds >= FOOTBALL_HOME_YELLOW_MIN && odds < FOOTBALL_HOME_GREEN_MIN) return 'yellow';
}
if (selection && selection === away && odds >= FOOTBALL_AWAY_ODDS_MIN && odds <= FOOTBALL_AWAY_ODDS_MAX) return 'orange';
return 'other';
}
function saveBetStatsLink(betId, fixture, placedAt = 0, betData = {}) {
if (!betId || !fixture) return;
const links = loadBetStatsLinks();
const existing = links[String(betId)] || {};
const nextCategory = getFixtureStatsCategory(fixture, betData.odds);
links[String(betId)] = {
...existing,
category: nextCategory !== 'other' || !existing.category ? nextCategory : existing.category,
gameId: fixture.gameId || existing.gameId || '',
homeTeam: fixture.homeTeam || existing.homeTeam || '',
awayTeam: fixture.awayTeam || existing.awayTeam || '',
placedSelection: fixture.placedSelection || fixture.recommendedSelection || existing.placedSelection || '',
startTimestamp: Number(fixture.startTimestamp || existing.startTimestamp || 0),
placedAt: Number(placedAt || existing.placedAt || 0),
stake: Number(betData.stake || existing.stake || 0),
odds: Number(betData.odds || fixture.myBetsOdds || existing.odds || 0),
sourceFingerprint: betData.sourceFingerprint || existing.sourceFingerprint || '',
capturedAt: Date.now()
};
const limited = Object.entries(links)
.sort((a, b) => Number(b[1]?.capturedAt || 0) - Number(a[1]?.capturedAt || 0))
.slice(0, 1000);
localStorage.setItem(BET_STATS_LINKS_KEY, JSON.stringify(Object.fromEntries(limited)));
}
function buildBookieData() {
const todayStart = getTodayStartUnix();
todaySummary = { bets: 0, wins: 0, losses: 0, refunds: 0, won: 0, lost: 0, net: 0 };
overallBookieNet = 0;
const logs = [...rawLogs].sort((a, b) => b.timestamp - a.timestamp);
logs.forEach(log => {
const type = classifyLog(log);
if (type === 'other' || type === 'withdraw' || type === 'deposit') return;
const bet = getBetAmount(log);
const winnings = getWinnings(log);
let net = 0;
if (type === 'win') net = (winnings || bet) - bet;
if (type === 'loss') net = -bet;
overallBookieNet += net;
if (log.timestamp >= todayStart) {
if (type === 'placed') todaySummary.bets++;
if (type === 'win') {
todaySummary.wins++;
todaySummary.won += net;
todaySummary.net += net;
}
if (type === 'loss') {
todaySummary.losses++;
todaySummary.lost += bet;
todaySummary.net += net;
}
if (type === 'refund') todaySummary.refunds++;
}
});
buildDailyTotals();
const unsettledResultCounts = new Map();
const seenOpenIds = new Set();
const foundOpen = [];
let clusterStarted = false;
let lastClusterTimestamp = 0;
for (const log of logs) {
const type = classifyLog(log);
const key = getSelectionKey(log);
if (type === 'other') continue;
if (type === 'withdraw' || type === 'deposit') break;
if (clusterStarted && lastClusterTimestamp > 0) {
const gap = lastClusterTimestamp - log.timestamp;
if (gap > MAX_CLUSTER_GAP_SECONDS) break;
}
if (type === 'win' || type === 'loss' || type === 'refund') {
if (key) unsettledResultCounts.set(key, Number(unsettledResultCounts.get(key) || 0) + 1);
if (clusterStarted) lastClusterTimestamp = log.timestamp;
continue;
}
if (type !== 'placed') continue;
const bet = getBetAmount(log);
const odds = getOdds(log);
if (!key) continue;
if (!bet || bet <= 0) continue;
if (!odds || odds <= 1) continue;
const settledCount = Number(unsettledResultCounts.get(key) || 0);
if (settledCount > 0) {
if (settledCount === 1) unsettledResultCounts.delete(key);
else unsettledResultCounts.set(key, settledCount - 1);
continue;
}
const uniqueId = `${log.id}|${key}|${bet}|${odds}|${log.timestamp}`;
if (seenOpenIds.has(uniqueId)) continue;
seenOpenIds.add(uniqueId);
clusterStarted = true;
lastClusterTimestamp = log.timestamp;
const fixture = findFixtureForOpenBet(log, bet, odds);
if (fixture) saveBetStatsLink(log.id, fixture, log.timestamp, { stake: bet, odds });
foundOpen.push({
id: log.id,
timestamp: log.timestamp,
key,
stake: bet,
odds,
potentialProfit: odds > 0 ? bet * (odds - 1) : 0,
potentialReturn: odds > 0 ? bet * odds : 0,
selection: key,
fixture
});
}
const fallbackOpen = foundOpen.sort((a, b) => b.timestamp - a.timestamp);
const myBetsSnapshot = loadMyBetsOpenSnapshot();
openBets = myBetsSnapshot
? buildOpenBetsFromMyBetsSnapshot(myBetsSnapshot, fallbackOpen)
: fallbackOpen;
}
function buildDailyTotals() {
const map = new Map();
rawLogs.forEach(log => {
const type = classifyLog(log);
if (type === 'other' || type === 'deposit' || type === 'withdraw') return;
const dateKey = unixToDateKey(log.timestamp);
const bet = getBetAmount(log);
const winnings = getWinnings(log);
if (!map.has(dateKey)) {
map.set(dateKey, {
dateKey,
bets: 0,
wins: 0,
losses: 0,
refunds: 0,
net: 0
});
}
const row = map.get(dateKey);
if (type === 'placed') row.bets++;
if (type === 'win') {
const netWin = (winnings || bet) - bet;
row.wins++;
row.net += netWin;
}
if (type === 'loss') {
row.losses++;
row.net -= bet;
}
if (type === 'refund') row.refunds++;
});
dailyTotals = [...map.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}
function getBatchStats(batch) {
const rows = [];
const batchFromDate = batch?.fromDate || defaultBatchStartDate();
rawLogs.forEach(log => {
if (!isOnOrAfterDate(log, batchFromDate)) return;
const type = classifyLog(log);
if (type === 'other' || type === 'deposit' || type === 'withdraw') return;
const bet = getBetAmount(log);
if (!bet) return;
if (!betMatchesBatchAmount(bet, batch)) return;
const winnings = getWinnings(log);
const odds = getOdds(log);
const key = getSelectionKey(log);
let net = 0;
if (type === 'win') net = (winnings || bet) - bet;
if (type === 'loss') net = -bet;
rows.push({ type, timestamp: log.timestamp, key, bet, odds, winnings, net });
});
const batchOpenBets = openBets
.filter(b => isOnOrAfterDate({ timestamp: b.timestamp }, batchFromDate))
.filter(b => betMatchesBatchAmount(b.stake, batch));
return {
rows,
placed: rows.filter(r => r.type === 'placed').length,
wins: rows.filter(r => r.type === 'win').length,
losses: rows.filter(r => r.type === 'loss').length,
refunds: rows.filter(r => r.type === 'refund').length,
stake: rows.filter(r => r.type === 'placed').reduce((s, r) => s + r.bet, 0),
won: rows.filter(r => r.type === 'win').reduce((s, r) => s + r.net, 0),
lost: rows.filter(r => r.type === 'loss').reduce((s, r) => s + r.bet, 0),
net: rows.reduce((s, r) => s + r.net, 0),
openBets: batchOpenBets,
openCount: batchOpenBets.length,
openStake: batchOpenBets.reduce((s, b) => s + b.stake, 0),
openProfit: batchOpenBets.reduce((s, b) => s + b.potentialProfit, 0),
openReturn: batchOpenBets.reduce((s, b) => s + b.potentialReturn, 0)
};
}
function requestLogPage(from, to) {
return new Promise(resolve => {
let url = `https://api.torn.com/user/?selections=log&cat=195&key=${encodeURIComponent(apiKey)}`;
if (from && from > 0) url += `&from=${from}`;
if (to) url += `&to=${to}`;
GM_xmlhttpRequest({
method: 'GET',
url,
onload: res => {
try {
const data = JSON.parse(res.responseText);
if (data.error) {
resolve({
error: data.error.error || data.error.code,
errorCode: Number(data.error.code || 0),
logs: []
});
return;
}
const logObj = data.log || data.logs || {};
const logs = Array.isArray(logObj)
? logObj.map(normalizeLog)
: Object.keys(logObj).map(k => normalizeLog({ id: k, ...logObj[k] }));
resolve({ error: null, logs });
} catch {
resolve({ error: 'Could not parse API response.', logs: [] });
}
},
onerror: () => resolve({ error: 'Could not reach Torn API.', logs: [] })
});
});
}
async function fetchLogs(fullRescan = false) {
if (!apiKey) {
alert('Add a Torn API key in Settings first.');
return false;
}
const cachedNewest = rawLogs.length ? Math.max(...rawLogs.map(log => log.timestamp)) : 0;
const configuredFrom = getScanFromUnix();
const from = fullRescan || !cachedNewest
? configuredFrom
: Math.max(configuredFrom, cachedNewest);
const configuredPageLimit = Math.max(1, Math.min(Number(maxPages) || 5, MAX_API_PAGES_PER_SCAN));
const pageLimit = scanMode === 'date' ? MAX_API_PAGES_PER_SCAN : configuredPageLimit;
const seen = new Set();
const fetched = [];
let to = null;
let stopReason = '';
for (let page = 1; page <= pageLimit; page++) {
const result = await requestLogPage(from, to);
if (result.error) {
stopReason = result.errorCode === 5
? 'Torn rate limit reached; the scan stopped and retained all completed pages.'
: `Torn API Error: ${result.error}`;
alert(stopReason);
break;
}
const pageLogs = result.logs
.filter(l => scanMode === 'pages' || l.timestamp >= from)
.sort((a, b) => b.timestamp - a.timestamp);
let added = 0;
pageLogs.forEach(log => {
const id = String(log.id);
if (!seen.has(id)) {
seen.add(id);
fetched.push(log);
added++;
}
});
if (pageLogs.length === 0 || added === 0) break;
const oldest = Math.min(...pageLogs.map(l => l.timestamp));
if (scanMode !== 'pages' && (!oldest || oldest <= from)) break;
to = oldest - 1;
if (page === pageLimit && scanMode === 'date') {
stopReason = `Stopped at the ${MAX_API_PAGES_PER_SCAN}-page emergency ceiling before reaching ${scanStartDate}.`;
}
if (page < pageLimit) await delay(API_PAGE_DELAY_MS);
}
if (!fetched.length && stopReason) return false;
const previousIds = new Set(rawLogs.map(log => String(log.id)));
const merged = new Map(rawLogs.map(log => [String(log.id), log]));
fetched.forEach(log => merged.set(String(log.id), log));
rawLogs = Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp);
await storeCachedLogs(fetched);
buildBookieData();
const oldest = rawLogs.length ? Math.min(...rawLogs.map(l => l.timestamp)) : 0;
const newest = rawLogs.length ? Math.max(...rawLogs.map(l => l.timestamp)) : 0;
const newCount = fetched.filter(log => !previousIds.has(String(log.id))).length;
lastLoadStatus = `${rawLogs.length} cached Bookie log entries, not bets (${newCount} new). Range: ${formatDate(oldest)} to ${formatDate(newest)}.`;
if (stopReason) lastLoadStatus += ` ${stopReason}`;
return true;
}
async function hydrateFromCache() {
if (!apiKey) {
lastLoadStatus = 'Add an API key in Settings, then run a manual scan.';
render();
return;
}
lastLoadStatus = 'Loading locally cached history...';
render();
try {
rawLogs = (await loadCachedLogs()).sort((a, b) => b.timestamp - a.timestamp);
buildBookieData();
if (rawLogs.length) {
const oldest = Math.min(...rawLogs.map(log => log.timestamp));
const newest = Math.max(...rawLogs.map(log => log.timestamp));
lastLoadStatus = `${rawLogs.length} cached Bookie log entries, not bets. Range: ${formatDate(oldest)} to ${formatDate(newest)}.`;
} else {
lastLoadStatus = 'No local history yet. Use Full Rescan once to build it.';
}
} catch (error) {
console.error('Could not load local bookie history.', error);
lastLoadStatus = 'Could not load local history. Check the console for details.';
}
if (/^#\/your-bets(?:\/|$)/i.test(location.hash)) {
captureVisibleMyBetsSnapshot();
} else {
render();
}
}
function isFootballBookiePage() {
try {
const params = new URLSearchParams(location.search);
return location.pathname === '/page.php'
&& params.get('sid') === 'bookie'
&& /^#\/football(?:\/|$)/i.test(location.hash);
} catch {
return false;
}
}
function clearFootballHighlights() {
document.querySelectorAll('li.tbp-football-match').forEach(item => {
item.classList.remove(
'tbp-football-match',
'tbp-football-home-green',
'tbp-football-home-yellow',
'tbp-football-away-orange'
);
});
document.querySelectorAll('.tbp-football-badge').forEach(badge => badge.remove());
}
function parseDecimalMultiplier(value) {
const match = String(value || '').match(/x\s*([\d.]+)/i);
return match ? Number(match[1]) : 0;
}
function parseFootballStartTimestamp(item) {
const value = String(item.querySelector('.state-wrap .state')?.title || '').trim();
const match = value.match(/Due to start at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+-\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+TCT/i);
if (!match) return 0;
return Date.UTC(
Number(match[6]),
Number(match[5]) - 1,
Number(match[4]),
Number(match[1]),
Number(match[2]),
Number(match[3] || 0)
);
}
function purgeExpiredFootballOddsHistory(history, now = Date.now()) {
let removed = 0;
Object.entries(history.games || {}).forEach(([gameId, game]) => {
const startTimestamp = Number(game?.startTimestamp || 0);
if (startTimestamp && startTimestamp <= now) {
delete history.games[gameId];
removed++;
}
});
return removed;
}
let footballHistoryExpiryTimer = null;
function scheduleFootballHistoryExpiry(history) {
if (footballHistoryExpiryTimer) clearTimeout(footballHistoryExpiryTimer);
footballHistoryExpiryTimer = null;
const now = Date.now();
const futureStarts = Object.values(history.games || {})
.map(game => Number(game?.startTimestamp || 0))
.filter(timestamp => timestamp > now)
.sort((a, b) => a - b);
if (!futureStarts.length) return;
const wait = Math.min(futureStarts[0] - now + 1000, 2147483647);
footballHistoryExpiryTimer = setTimeout(() => {
const current = loadFootballOddsHistory();
saveFootballOddsHistory(current);
}, wait);
}
function loadFootballOddsHistory() {
try {
const parsed = JSON.parse(localStorage.getItem(FOOTBALL_ODDS_HISTORY_KEY) || '{}');
const history = parsed && typeof parsed === 'object' && parsed.games
? parsed
: { version: 1, games: {} };
if (purgeExpiredFootballOddsHistory(history)) {
localStorage.setItem(FOOTBALL_ODDS_HISTORY_KEY, JSON.stringify(history));
}
return history;
} catch {
return { version: 1, games: {} };
}
}
function saveFootballOddsHistory(history) {
purgeExpiredFootballOddsHistory(history);
const games = Object.entries(history.games || {})
.sort((a, b) => Number(b[1]?.lastViewedAt || 0) - Number(a[1]?.lastViewedAt || 0))
.slice(0, MAX_ODDS_HISTORY_GAMES);
history.games = Object.fromEntries(games);
try {
localStorage.setItem(FOOTBALL_ODDS_HISTORY_KEY, JSON.stringify(history));
} catch (error) {
console.error('Could not save Football odds history.', error);
}
scheduleFootballHistoryExpiry(history);
}
function getThreeWayMarket(item) {
return Array.from(item.querySelectorAll('.info-wrap ul.bets-wrap')).find(wrap => {
const name = String(wrap.querySelector('.market-name-cell .bold')?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
const rows = wrap.querySelectorAll(':scope > li.bets .bet-cell.result');
return /^3-Way Ordinary time$/i.test(name) && rows.length === 3;
}) || null;
}
function escapeHtml(value) {
return String(value ?? '')
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#039;');
}
function findFootballItemForHref(href) {
if (location.hash === href) {
const activeItem = document.querySelector('li.c-pointer.active');
if (activeItem) return activeItem;
}
const link = Array.from(document.querySelectorAll('a[href*="#/football/"]'))
.find(candidate => candidate.getAttribute('href') === href);
return link?.closest('li.c-pointer') || null;
}
function getFootballGameId(item, href = '') {
const candidates = [
href,
item?.classList.contains('active') ? location.hash : '',
item?.querySelector('a[href*="#/football/"]')?.getAttribute('href') || ''
];
for (const candidate of candidates) {
const gameId = String(candidate || '').match(/#\/football\/(\d+)/i)?.[1];
if (gameId) return gameId;
}
return '';
}
function parseFootballFixtureTitle(matchTitle) {
const title = String(matchTitle || '').replace(/\s+/g, ' ').trim();
const versus = title.match(/\s+v\s+/i);
if (!versus || versus.index === undefined) {
return { homeTeam: '', awayTeam: '', competition: '' };
}
const homeTeam = title.slice(0, versus.index).trim();
const remainder = title.slice(versus.index + versus[0].length).trim();
const competitionIndex = remainder.indexOf(' - ');
return {
homeTeam,
awayTeam: (competitionIndex >= 0 ? remainder.slice(0, competitionIndex) : remainder).trim(),
competition: (competitionIndex >= 0 ? remainder.slice(competitionIndex + 3) : '').trim()
};
}
function createColorStatCategories() {
return {
green: { key: 'green', label: 'Green Home', rule: `Home Win Odds: ${FOOTBALL_HOME_GREEN_MIN.toFixed(2)}-${FOOTBALL_HOME_ODDS_MAX.toFixed(2)}`, wins: 0, losses: 0, net: 0 },
yellow: { key: 'yellow', label: 'Yellow Home', rule: `Home Win Odds: ${FOOTBALL_HOME_YELLOW_MIN.toFixed(2)}-${(FOOTBALL_HOME_GREEN_MIN - 0.01).toFixed(2)}`, wins: 0, losses: 0, net: 0 },
orange: { key: 'orange', label: 'Orange Away', rule: `Away Win Odds: ${FOOTBALL_AWAY_ODDS_MIN.toFixed(2)}-${FOOTBALL_AWAY_ODDS_MAX.toFixed(2)}`, wins: 0, losses: 0, net: 0 },
other: { key: 'other', label: 'All Others', rule: 'Captured 3-Way bets outside the colored ranges', wins: 0, losses: 0, net: 0 }
};
}
function hasColorStatsFixtureEvidence(link) {
return Boolean(link?.homeTeam && link?.awayTeam && link?.placedSelection);
}
function finishColorStatsScope(scope) {
const rows = Object.values(scope.categories).map(row => {
const settled = row.wins + row.losses;
return {
...row,
settled,
winPct: settled ? row.wins / settled * 100 : 0,
lossPct: settled ? row.losses / settled * 100 : 0
};
});
const total = rows.reduce((summary, row) => ({
wins: summary.wins + row.wins,
losses: summary.losses + row.losses,
net: summary.net + row.net
}), { wins: 0, losses: 0, net: 0 });
total.settled = total.wins + total.losses;
total.winPct = total.settled ? total.wins / total.settled * 100 : 0;
total.lossPct = total.settled ? total.losses / total.settled * 100 : 0;
total.refunds = scope.refunds;
total.open = Math.max(0, scope.classifiedPlaced - total.settled - scope.refunds);
return { ...scope, rows, total };
}
function getColorBetStats() {
const links = loadBetStatsLinks();
const pendingBySelection = new Map();
const fromTimestamp = dateToUnixStart(scanStartDate || defaultScanStartDate());
const logs = [...rawLogs].sort((a, b) => a.timestamp - b.timestamp);
const scopes = {
current: { categories: createColorStatCategories(), classifiedPlaced: 0, missingFixture: 0, refunds: 0 },
before: { categories: createColorStatCategories(), classifiedPlaced: 0, missingFixture: 0, refunds: 0 }
};
logs.forEach(log => {
const type = classifyLog(log);
const key = getSelectionKey(log);
if (!key) return;
if (type === 'placed') {
const scopeKey = Number(log.timestamp || 0) < fromTimestamp ? 'before' : 'current';
const scope = scopes[scopeKey];
const bet = getBetAmount(log);
const odds = getOdds(log);
let link = links[String(log.id)] || null;
let category = link ? getFixtureStatsCategory(link, odds) : '';
if (!link) {
const fixture = findFixtureForOpenBet(log, bet, odds);
category = getFixtureStatsCategory(fixture, odds);
if (fixture) {
saveBetStatsLink(log.id, fixture, log.timestamp, { stake: bet, odds });
link = loadBetStatsLinks()[String(log.id)] || fixture;
}
}
if (!hasColorStatsFixtureEvidence(link)) {
scope.missingFixture++;
return;
}
if (!scope.categories[category]) category = 'other';
scope.classifiedPlaced++;
if (!pendingBySelection.has(key)) pendingBySelection.set(key, []);
pendingBySelection.get(key).push({ log, bet, category, scopeKey });
return;
}
if (!['win', 'loss', 'refund'].includes(type)) return;
const pending = pendingBySelection.get(key) || [];
if (!pending.length) return;
const resultBet = getBetAmount(log);
let matchIndex = resultBet
? pending.findIndex(candidate => Math.abs(Number(candidate.bet || 0) - resultBet) < 1)
: -1;
if (matchIndex < 0) matchIndex = 0;
const [placed] = pending.splice(matchIndex, 1);
if (!pending.length) pendingBySelection.delete(key);
const scope = scopes[placed.scopeKey];
if (type === 'refund') {
scope.refunds++;
return;
}
const row = scope.categories[placed.category] || scope.categories.other;
if (type === 'win') {
row.wins++;
row.net += (getWinnings(log) || resultBet || placed.bet) - (resultBet || placed.bet);
} else {
row.losses++;
row.net -= resultBet || placed.bet;
}
});
pendingBySelection.forEach(pending => {
pending.forEach(placed => {
const providerResult = links[String(placed.log.id)] || {};
if (!['win', 'loss'].includes(providerResult.providerOutcome)) return;
const scope = scopes[placed.scopeKey];
const row = scope.categories[placed.category] || scope.categories.other;
if (providerResult.providerOutcome === 'win') row.wins++;
else row.losses++;
row.net += Number(providerResult.providerNet || 0);
});
});
const current = finishColorStatsScope(scopes.current);
const before = finishColorStatsScope(scopes.before);
return {
...current,
fromDate: scanStartDate || defaultScanStartDate(),
trackedPlaced: current.classifiedPlaced,
excludedUntracked: current.missingFixture,
before
};
}
function getSettledPlacedBetIds(fromTimestamp) {
const settled = new Set();
const pendingBySelection = new Map();
[...rawLogs].sort((a, b) => a.timestamp - b.timestamp).forEach(log => {
if (Number(log.timestamp || 0) < fromTimestamp) return;
const type = classifyLog(log);
const key = getSelectionKey(log);
if (!key) return;
if (type === 'placed') {
if (!pendingBySelection.has(key)) pendingBySelection.set(key, []);
pendingBySelection.get(key).push({ id: String(log.id), bet: getBetAmount(log) });
return;
}
if (!['win', 'loss', 'refund'].includes(type)) return;
const pending = pendingBySelection.get(key) || [];
if (!pending.length) return;
const resultBet = getBetAmount(log);
let index = resultBet ? pending.findIndex(entry => Math.abs(entry.bet - resultBet) < 1) : -1;
if (index < 0) index = 0;
const [placed] = pending.splice(index, 1);
settled.add(placed.id);
if (!pending.length) pendingBySelection.delete(key);
});
return settled;
}
function outcomeForTrackedSelection(link, homeGoals, awayGoals) {
const selection = normalizeScoreTeamName(link.placedSelection);
const home = normalizeScoreTeamName(link.homeTeam);
const away = normalizeScoreTeamName(link.awayTeam);
if (!selection || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return '';
if (selection === home) return homeGoals > awayGoals ? 'win' : 'loss';
if (selection === away) return awayGoals > homeGoals ? 'win' : 'loss';
if (/^(draw|tie)$/i.test(String(link.placedSelection || '').trim())) return homeGoals === awayGoals ? 'win' : 'loss';
return '';
}
function parseVisibleFootballResultMessages() {
const text = String(document.body?.innerText || '').replace(/\r/g, '');
if (!/3-Way Ordinary time/i.test(text)) return [];
const messages = [];
const patterns = [
{
type: 'win',
regex: /You won \$([\d,]+) on your \$([\d,]+)(?:\s+\(x([\d.]+)\)\s+bet in the Bookie on|\s+)(.+?)\s+\(3-Way Ordinary time\)\s+bet on\s+(.+?)\s+v\s+(.+?)(?=\s+\(Football\)|\.\s+You can|\.|\n|$)/gi
},
{
type: 'loss',
regex: /You lost your \$([\d,]+)(?:\s+\(x([\d.]+)\)\s+bet in the Bookie on|\s+)(.+?)\s+\(3-Way Ordinary time\)\s+bet on\s+(.+?)\s+v\s+(.+?)(?=\s+\(Football\)|\.|\n|$)/gi
}
];
patterns.forEach(({ type, regex }) => {
for (const match of text.matchAll(regex)) {
if (type === 'win') {
messages.push({
type,
winnings: Number(match[1].replace(/,/g, '')),
stake: Number(match[2].replace(/,/g, '')),
odds: Number(match[3] || 0),
selection: match[4].trim(),
homeTeam: match[5].trim(),
awayTeam: match[6].trim()
});
} else {
messages.push({
type,
winnings: 0,
stake: Number(match[1].replace(/,/g, '')),
odds: Number(match[2] || 0),
selection: match[3].trim(),
homeTeam: match[4].trim(),
awayTeam: match[5].trim()
});
}
}
});
return messages;
}
function captureVisibleFootballResultNames() {
const messages = parseVisibleFootballResultMessages();
if (!messages.length || !rawLogs.length) return { found: messages.length, captured: 0 };
const usedResultIds = new Set();
let links = loadBetStatsLinks();
let captured = 0;
messages.forEach(message => {
const resultCandidates = rawLogs
.filter(log => classifyLog(log) === message.type)
.filter(log => Math.abs(getBetAmount(log) - message.stake) < 1)
.filter(log => !usedResultIds.has(String(log.id)))
.filter(log => !message.odds || !getOdds(log) || Math.abs(getOdds(log) - message.odds) <= 0.011)
.filter(log => message.type !== 'win' || !message.winnings || Math.abs(getWinnings(log) - message.winnings) < 1)
.sort((a, b) => b.timestamp - a.timestamp);
const resultLog = resultCandidates[0];
if (!resultLog) return;
usedResultIds.add(String(resultLog.id));
const key = getSelectionKey(resultLog);
if (!key) return;
const placedLog = rawLogs
.filter(log => classifyLog(log) === 'placed')
.filter(log => getSelectionKey(log) === key)
.filter(log => Math.abs(getBetAmount(log) - message.stake) < 1)
.filter(log => !message.odds || !getOdds(log) || Math.abs(getOdds(log) - message.odds) <= 0.011)
.filter(log => Number(log.timestamp || 0) <= Number(resultLog.timestamp || 0))
.sort((a, b) => b.timestamp - a.timestamp)[0];
if (!placedLog) return;
const id = String(placedLog.id);
const odds = Number(message.odds || getOdds(placedLog) || 0);
const previous = links[id] || {};
const fingerprint = [message.type, message.stake, odds, message.selection, message.homeTeam, message.awayTeam]
.map(value => normalizeScoreTeamName(value))
.join('|');
if (previous.sourceFingerprint === fingerprint) return;
const fixture = {
...previous,
homeTeam: message.homeTeam,
awayTeam: message.awayTeam,
placedSelection: message.selection,
myBetsOdds: odds
};
saveBetStatsLink(id, fixture, placedLog.timestamp, { stake: message.stake, odds, sourceFingerprint: fingerprint });
links = loadBetStatsLinks();
captured++;
});
if (captured) {
buildBookieData();
lastLoadStatus = `Captured home/away names for ${captured} visible settled Football bet${captured === 1 ? '' : 's'} from Torn Events.`;
}
return { found: messages.length, captured };
}
async function measureTrackedStatsDatabase() {
captureCompletedMyBetsStats();
captureVisibleFootballResultNames();
buildBookieData();
const fromTimestamp = dateToUnixStart(scanStartDate || defaultScanStartDate());
const settledIds = getSettledPlacedBetIds(fromTimestamp);
let links = loadBetStatsLinks();
const placedLogs = rawLogs
.filter(log => classifyLog(log) === 'placed' && Number(log.timestamp || 0) >= fromTimestamp)
.sort((a, b) => a.timestamp - b.timestamp);
let measured = 0;
let alreadySettled = 0;
let unresolved = 0;
let requests = 0;
let cacheHits = 0;
for (const log of placedLogs) {
const id = String(log.id);
if (settledIds.has(id)) {
alreadySettled++;
continue;
}
let link = links[id];
if (!link) {
const fixture = findFixtureForOpenBet(log, getBetAmount(log), getOdds(log));
if (fixture) {
saveBetStatsLink(id, fixture, log.timestamp, { stake: getBetAmount(log), odds: getOdds(log) });
links = loadBetStatsLinks();
link = links[id];
}
}
if (!link?.homeTeam || !link?.awayTeam || !link?.placedSelection || !Number(link.startTimestamp || 0)) {
unresolved++;
continue;
}
if (['win', 'loss'].includes(link.providerOutcome)) {
measured++;
continue;
}
if (Number(link.startTimestamp) > Date.now()) continue;
const fixture = {
homeTeam: link.homeTeam,
awayTeam: link.awayTeam,
startTimestamp: Number(link.startTimestamp)
};
const result = await getSportsDbEventForFixture(fixture, utcDateKey(fixture.startTimestamp));
if (result.error || !result.event) {
unresolved++;
continue;
}
if (result.cached) cacheHits++;
else requests++;
const event = result.event;
if (!isFinalFootballStatus(event.strStatus)) continue;
const homeGoals = Number(event.intHomeScore);
const awayGoals = Number(event.intAwayScore);
const outcome = outcomeForTrackedSelection(link, homeGoals, awayGoals);
if (!outcome) {
unresolved++;
continue;
}
const stake = Number(link.stake || getBetAmount(log) || 0);
const odds = Number(link.odds || getOdds(log) || 0);
links[id] = {
...link,
providerOutcome: outcome,
providerNet: outcome === 'win' ? stake * Math.max(0, odds - 1) : -stake,
providerScore: `${homeGoals}-${awayGoals}`,
providerStatus: event.strStatus,
providerMeasuredAt: Date.now()
};
localStorage.setItem(BET_STATS_LINKS_KEY, JSON.stringify(links));
measured++;
if (!result.cached) await delay(SPORTSDB_MIN_REQUEST_GAP_MS);
}
const usage = getSportsDbUsage();
lastLoadStatus = `All-Bookie outcome audit: ${alreadySettled} bets settled by Torn logs, ${measured} resolved by TheSportsDB, ${unresolved} open or missing provider-ready fixture details. ${requests} requests, ${cacheHits} cached; ${usage.remaining}/${usage.limit} calls remain this minute.`;
}
function getFootballFixtureDetails(item, href = '') {
const matchElement = item?.querySelector('.matchName p, .pop-game .name p');
const matchTitle = String(matchElement?.title || matchElement?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
return {
gameId: getFootballGameId(item, href),
matchTitle,
...parseFootballFixtureTitle(matchTitle),
startTimestamp: parseFootballStartTimestamp(item)
};
}
function loadFootballFixtureRecords() {
try {
const parsed = JSON.parse(localStorage.getItem(FOOTBALL_FIXTURE_RECORDS_KEY) || '[]');
const records = Array.isArray(parsed) ? parsed : [];
const now = Date.now();
return records.filter(record => {
const expiryBase = Number(record.startTimestamp || record.updatedAt || record.reviewedAt || 0);
return expiryBase && expiryBase + FOOTBALL_FIXTURE_RETENTION_MS > now;
});
} catch {
return [];
}
}
function saveFootballFixtureRecord(record) {
if (!record?.gameId) return null;
const records = loadFootballFixtureRecords();
const index = records.findIndex(candidate => candidate.gameId === record.gameId);
const existing = index >= 0 ? records[index] : {};
const merged = {
...existing,
...record,
betClicks: Array.isArray(record.betClicks)
? record.betClicks.slice(-5)
: Array.isArray(existing.betClicks) ? existing.betClicks.slice(-5) : [],
updatedAt: Date.now()
};
if (index >= 0) records[index] = merged;
else records.push(merged);
const limited = records
.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
.slice(0, MAX_FOOTBALL_FIXTURE_RECORDS);
try {
localStorage.setItem(FOOTBALL_FIXTURE_RECORDS_KEY, JSON.stringify(limited));
} catch (error) {
console.error('Could not save Football fixture details.', error);
}
return merged;
}
function getThreeWayRows(market) {
return Array.from(market?.querySelectorAll(':scope > li.bets') || []).filter(row => {
return row.querySelector('.bet-cell.result') && row.querySelector('.bet-cell.odds.decimal');
}).map(row => ({
row,
selection: String(row.querySelector('.bet-cell.result')?.textContent || '').replace(/\s+/g, ' ').trim(),
odds: parseDecimalMultiplier(row.querySelector('.bet-cell.odds.decimal')?.textContent)
}));
}
function captureReviewedFootballFixture(item, href, market, matchType = null) {
const details = getFootballFixtureDetails(item, href);
if (!details.gameId || !details.homeTeam || !details.awayTeam) return null;
const rows = getThreeWayRows(market);
const home = rows.find(entry => entry.selection.toLowerCase() === details.homeTeam.toLowerCase());
const away = rows.find(entry => entry.selection.toLowerCase() === details.awayTeam.toLowerCase());
const draw = rows.find(entry => /^(draw|tie)$/i.test(entry.selection));
const recommendedSelection = matchType?.startsWith('home-')
? details.homeTeam
: matchType === 'away-orange' ? details.awayTeam : '';
const recommendedOdds = matchType?.startsWith('home-')
? Number(home?.odds || 0)
: matchType === 'away-orange' ? Number(away?.odds || 0) : 0;
const record = {
...details,
market: '3-Way Ordinary time',
homeOdds: Number(home?.odds || 0),
drawOdds: Number(draw?.odds || 0),
awayOdds: Number(away?.odds || 0),
reviewedAt: Date.now()
};
if (matchType) {
record.matchType = matchType;
record.recommendedSelection = recommendedSelection;
record.recommendedOdds = recommendedOdds;
}
return saveFootballFixtureRecord(record);
}
function parseVisibleStake(row) {
const value = String(row?.querySelector('input.amount[type="text"]')?.value || '');
const parsed = Number(value.replace(/[^\d.-]/g, ''));
return Number.isFinite(parsed) ? parsed : 0;
}
function captureManualFootballBet(item, row, market) {
const href = location.hash;
const fixture = captureReviewedFootballFixture(item, href, market, null);
if (!fixture) return;
const selection = String(row.querySelector('.bet-cell.result')?.textContent || '').replace(/\s+/g, ' ').trim();
const odds = parseDecimalMultiplier(row.querySelector('.bet-cell.odds.decimal')?.textContent);
const betClicks = Array.isArray(fixture.betClicks) ? [...fixture.betClicks] : [];
betClicks.push({ selection, odds, stake: parseVisibleStake(row), clickedAt: Date.now() });
return saveFootballFixtureRecord({ ...fixture, betClicks });
}
function loadManualBetLinks() {
try {
const parsed = JSON.parse(localStorage.getItem(MANUAL_BET_LINKS_KEY) || '{}');
return parsed && typeof parsed === 'object' ? parsed : {};
} catch {
return {};
}
}
function saveManualBetLink(betId, fixture, betData = {}) {
const links = loadManualBetLinks();
links[String(betId)] = { ...fixture, capturedAt: Date.now(), linkedBy: 'manual-my-bets' };
const limited = Object.entries(links)
.sort((a, b) => Number(b[1]?.capturedAt || 0) - Number(a[1]?.capturedAt || 0))
.slice(0, 200);
localStorage.setItem(MANUAL_BET_LINKS_KEY, JSON.stringify(Object.fromEntries(limited)));
saveBetStatsLink(betId, fixture, 0, betData);
}
function getPendingManualCapture() {
try {
const pending = JSON.parse(localStorage.getItem(PENDING_MANUAL_CAPTURE_KEY) || 'null');
if (!pending?.betId || Date.now() - Number(pending.armedAt || 0) > MANUAL_CAPTURE_TTL_MS) {
localStorage.removeItem(PENDING_MANUAL_CAPTURE_KEY);
return null;
}
return pending;
} catch {
localStorage.removeItem(PENDING_MANUAL_CAPTURE_KEY);
return null;
}
}
function setPendingManualCapture(bet) {
const current = getPendingManualCapture();
if (current?.betId === String(bet.id)) {
localStorage.removeItem(PENDING_MANUAL_CAPTURE_KEY);
return false;
}
localStorage.setItem(PENDING_MANUAL_CAPTURE_KEY, JSON.stringify({
betId: String(bet.id),
stake: Number(bet.stake || 0),
odds: Number(bet.odds || 0),
armedAt: Date.now()
}));
return true;
}
function parsePendingMyBetTitle(value) {
const title = String(value || '').replace(/\s+/g, ' ').trim();
const match = title.match(/^Pending\s+\$([\d,]+).*?\(x([\d.]+)\)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
if (!match) return null;
return {
stake: Number(match[1].replace(/,/g, '')),
odds: Number(match[2]),
selection: match[3].trim(),
market: match[4].trim()
};
}
function parseCompletedMyBetTitle(value) {
const title = String(value || '').replace(/\s+/g, ' ').trim();
let match = title.match(/^Won\s+\$([\d,]+)\s+\(x([\d.]+)\)\s+from a\s+\$([\d,]+)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
if (match) {
return {
type: 'win',
profit: Number(match[1].replace(/,/g, '')),
odds: Number(match[2]),
stake: Number(match[3].replace(/,/g, '')),
selection: match[4].trim(),
market: match[5].trim()
};
}
match = title.match(/^Lost\s+\$([\d,]+)\s+\(x([\d.]+)\)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
if (match) {
return {
type: 'loss',
profit: -Number(match[1].replace(/,/g, '')),
odds: Number(match[2]),
stake: Number(match[1].replace(/,/g, '')),
selection: match[3].trim(),
market: match[4].trim()
};
}
return null;
}
function selectionKeyGameId(log) {
return String(getSelectionKey(log) || '').split('/')[0] || '';
}
function captureCompletedMyBetsStats(links = null) {
if (!/^#\/your-bets(?:\/|$)/i.test(location.hash) || !rawLogs.length) return { found: 0, captured: 0 };
const rows = links || Array.from(document.querySelectorAll('a[href^="#/your-bets/"]'));
let statsLinks = loadBetStatsLinks();
let found = 0;
let captured = 0;
const usedResultIds = new Set();
const usedPlacedIds = new Set();
rows.forEach(link => {
const href = link.getAttribute('href') || '';
const gameId = href.match(/^#\/your-bets\/(\d+)$/i)?.[1] || '';
const matchTitle = String(link.querySelector('.matchName p, .pop-game .name p')?.title || '')
.replace(/\s+/g, ' ')
.trim();
const details = parseFootballFixtureTitle(matchTitle);
if (!gameId || !details.homeTeam || !details.awayTeam) return;
Array.from(link.querySelectorAll('.stick .text[title]')).forEach(element => {
const completed = parseCompletedMyBetTitle(element.title);
if (!completed || !/^3-Way Ordinary time$/i.test(completed.market)) return;
found++;
const resultCandidates = rawLogs
.filter(log => classifyLog(log) === completed.type)
.filter(log => !usedResultIds.has(String(log.id)))
.filter(log => selectionKeyGameId(log) === gameId)
.filter(log => Math.abs(getBetAmount(log) - completed.stake) < 1)
.filter(log => !getOdds(log) || Math.abs(getOdds(log) - completed.odds) <= 0.011)
.sort((a, b) => b.timestamp - a.timestamp);
const resultLog = resultCandidates[0] || null;
if (resultLog) usedResultIds.add(String(resultLog.id));
const selectionKey = resultLog ? getSelectionKey(resultLog) : '';
const placedCandidates = rawLogs
.filter(log => classifyLog(log) === 'placed')
.filter(log => !usedPlacedIds.has(String(log.id)))
.filter(log => selectionKeyGameId(log) === gameId)
.filter(log => !selectionKey || getSelectionKey(log) === selectionKey)
.filter(log => Math.abs(getBetAmount(log) - completed.stake) < 1)
.filter(log => Math.abs(getOdds(log) - completed.odds) <= 0.011)
.filter(log => !resultLog || Number(log.timestamp || 0) <= Number(resultLog.timestamp || 0))
.sort((a, b) => b.timestamp - a.timestamp);
const placedLog = placedCandidates[0] || null;
if (!placedLog) return;
const id = String(placedLog.id);
usedPlacedIds.add(id);
const fingerprint = `mybets|${gameId}|${String(resultLog?.id || '')}|${completed.type}|${completed.stake}|${completed.odds}|${normalizeScoreTeamName(completed.selection)}`;
if (statsLinks[id]?.sourceFingerprint === fingerprint) return;
saveBetStatsLink(id, {
...(statsLinks[id] || {}),
gameId,
matchTitle,
...details,
placedSelection: completed.selection,
myBetsOdds: completed.odds,
market: completed.market,
linkedBy: 'completed-my-bets'
}, placedLog.timestamp, { stake: completed.stake, odds: completed.odds, sourceFingerprint: fingerprint });
statsLinks = loadBetStatsLinks();
captured++;
});
});
if (captured) lastLoadStatus = `Captured ${captured} completed 3-Way Football bet${captured === 1 ? '' : 's'} from My Bets.`;
return { found, captured };
}
function loadMyBetsOpenSnapshot() {
try {
const snapshot = JSON.parse(localStorage.getItem(MY_BETS_SNAPSHOT_KEY) || 'null');
if (!snapshot || !Array.isArray(snapshot.entries)) return null;
if (Date.now() - Number(snapshot.capturedAt || 0) > MY_BETS_SNAPSHOT_TTL_MS) return null;
return snapshot;
} catch {
return null;
}
}
function buildOpenBetsFromMyBetsSnapshot(snapshot, fallbackOpen) {
const unusedFallback = new Set(fallbackOpen.map((_, index) => index));
return snapshot.entries.map((entry, snapshotIndex) => {
let matchedIndex = fallbackOpen.findIndex((bet, index) =>
unusedFallback.has(index)
&& Math.abs(Number(bet.stake || 0) - Number(entry.stake || 0)) < 1
&& Math.abs(Number(bet.odds || 0) - Number(entry.odds || 0)) <= 0.011
);
if (matchedIndex < 0) {
matchedIndex = fallbackOpen.findIndex((bet, index) =>
unusedFallback.has(index)
&& Math.abs(Number(bet.stake || 0) - Number(entry.stake || 0)) < 1
);
}
const apiBet = matchedIndex >= 0 ? fallbackOpen[matchedIndex] : null;
if (matchedIndex >= 0) unusedFallback.delete(matchedIndex);
const stake = Number(entry.stake || apiBet?.stake || 0);
const odds = Number(entry.odds || apiBet?.odds || 0);
const fixture = {
...(apiBet?.fixture || {}),
gameId: entry.gameId,
matchTitle: entry.matchTitle,
homeTeam: entry.homeTeam,
awayTeam: entry.awayTeam,
competition: entry.competition,
placedSelection: entry.selection,
market: entry.market,
myBetsOdds: odds,
linkedBy: 'my-bets-snapshot'
};
return {
id: apiBet?.id || `mybets_${entry.gameId}_${snapshotIndex}_${stake}_${odds}`,
timestamp: apiBet?.timestamp || Math.floor(Number(snapshot.capturedAt || Date.now()) / 1000),
key: apiBet?.key || `mybets/${entry.gameId}/${snapshotIndex}`,
stake,
odds,
potentialProfit: odds > 0 ? stake * (odds - 1) : 0,
potentialReturn: odds > 0 ? stake * odds : 0,
selection: entry.selection || apiBet?.selection || '',
fixture
};
}).sort((a, b) => b.timestamp - a.timestamp);
}
function captureVisibleMyBetsSnapshot() {
if (!/^#\/your-bets(?:\/|$)/i.test(location.hash)) return false;
const links = Array.from(document.querySelectorAll('a[href^="#/your-bets/"]'));
if (!links.length) return false;
const completedCapture = captureCompletedMyBetsStats(links);
const entries = [];
links.forEach(link => {
const href = link.getAttribute('href') || '';
const gameId = href.match(/^#\/your-bets\/(\d+)$/i)?.[1] || '';
const matchTitle = String(link.querySelector('.matchName p, .pop-game .name p')?.title || '')
.replace(/\s+/g, ' ')
.trim();
const details = parseFootballFixtureTitle(matchTitle);
if (!gameId || !details.homeTeam || !details.awayTeam) return;
Array.from(link.querySelectorAll('.stick .text[title]')).forEach(element => {
const pendingBet = parsePendingMyBetTitle(element.title);
if (!pendingBet) return;
entries.push({ gameId, matchTitle, ...details, ...pendingBet });
});
});
const previous = loadMyBetsOpenSnapshot();
const previousEntries = JSON.stringify(previous?.entries || []);
const nextEntries = JSON.stringify(entries);
localStorage.setItem(MY_BETS_SNAPSHOT_KEY, JSON.stringify({ capturedAt: Date.now(), entries }));
if (previousEntries === nextEntries && !completedCapture.captured) return false;
buildBookieData();
lastLoadStatus = completedCapture.captured
? `Synced ${entries.length} open and captured ${completedCapture.captured} completed 3-Way Football bet${completedCapture.captured === 1 ? '' : 's'} from My Bets.`
: `Synced ${entries.length} open bet${entries.length === 1 ? '' : 's'} from My Bets.`;
render();
return true;
}
function scheduleMyBetsSnapshotCapture() {
if (!/^#\/your-bets(?:\/|$)/i.test(location.hash)) return;
setTimeout(captureVisibleMyBetsSnapshot, 500);
setTimeout(captureVisibleMyBetsSnapshot, 1600);
}
function captureArmedBetFromMyBetsLink(link) {
const pending = getPendingManualCapture();
if (!pending || !link) return { captured: false, inactive: true };
const href = link.getAttribute('href') || '';
const gameId = href.match(/^#\/your-bets\/(\d+)$/i)?.[1] || '';
const matchTitle = String(link.querySelector('.matchName p, .pop-game .name p')?.title || '')
.replace(/\s+/g, ' ')
.trim();
const details = parseFootballFixtureTitle(matchTitle);
const pendingBets = Array.from(link.querySelectorAll('.stick .text[title]'))
.map(element => parsePendingMyBetTitle(element.title))
.filter(Boolean);
const exactMatch = pendingBets.find(candidate => {
const stakeMatches = Math.abs(candidate.stake - Number(pending.stake || 0)) < 1;
const oddsMatch = Math.abs(candidate.odds - Number(pending.odds || 0)) <= 0.011;
return stakeMatches && oddsMatch;
});
const stakeMatches = pendingBets.filter(candidate =>
Math.abs(candidate.stake - Number(pending.stake || 0)) < 1
);
const oddsRanked = [...pendingBets].sort((a, b) =>
Math.abs(a.odds - Number(pending.odds || 0)) - Math.abs(b.odds - Number(pending.odds || 0))
);
const closestIsUnique = oddsRanked.length === 1
|| (oddsRanked.length > 1
&& Math.abs(oddsRanked[0].odds - Number(pending.odds || 0))
< Math.abs(oddsRanked[1].odds - Number(pending.odds || 0)));
const match = exactMatch
|| (stakeMatches.length === 1 ? stakeMatches[0] : null)
|| (pendingBets.length === 1 ? pendingBets[0] : null)
|| (closestIsUnique ? oddsRanked[0] : null);
if (!gameId || !details.homeTeam || !details.awayTeam) {
return { captured: false, inactive: false, reason: 'Club names were not visible in that My Bets game row.' };
}
const reviewedFixture = loadFootballFixtureRecords()
.find(fixture => String(fixture.gameId) === String(gameId)) || {};
saveManualBetLink(pending.betId, {
...reviewedFixture,
gameId,
matchTitle,
...details,
placedSelection: match?.selection || '',
market: match?.market || '',
myBetsOdds: Number(match?.odds || 0),
apiOddsAtCapture: Number(pending.odds || 0),
captureMatch: exactMatch ? 'exact' : match ? 'manual-relaxed' : 'names-only'
}, { stake: pending.stake, odds: pending.odds });
localStorage.removeItem(PENDING_MANUAL_CAPTURE_KEY);
buildBookieData();
return { captured: true, fixture: details, selection: match?.selection || '' };
}
function showManualCaptureNotice(message, success = false) {
document.getElementById('tbp-manual-capture-notice')?.remove();
const notice = document.createElement('div');
notice.id = 'tbp-manual-capture-notice';
notice.style.cssText = `position:fixed; top:72px; right:20px; max-width:340px; padding:9px 12px; border-radius:6px; background:${success ? '#22623a' : '#6b4b18'}; border:1px solid ${success ? '#48ad6c' : '#d69a32'}; color:#fff; z-index:1000000; font:12px Segoe UI,sans-serif; box-shadow:0 5px 18px rgba(0,0,0,.65);`;
notice.textContent = message;
document.body.appendChild(notice);
setTimeout(() => notice.remove(), 6000);
}
function handleManualCaptureResult(result) {
if (result?.inactive) return;
if (!result?.captured) {
showManualCaptureNotice(result?.reason || 'Club names were not visible in that game row.');
return;
}
lastLoadStatus = `Captured ${result.fixture.homeTeam} v ${result.fixture.awayTeam} for the armed bet.`;
showManualCaptureNotice(result.selection
? `${lastLoadStatus} Pick: ${result.selection}.`
: `${lastLoadStatus} Club names saved; selection could not be identified uniquely.`, true);
setTimeout(render, 0);
}
function captureArmedBetFromCurrentMyBetsRoute() {
if (!getPendingManualCapture() || !/^#\/your-bets\/\d+$/i.test(location.hash)) return;
setTimeout(() => {
const link = document.querySelector(`a[href="${location.hash}"]`);
if (link) handleManualCaptureResult(captureArmedBetFromMyBetsLink(link));
}, 250);
}
function findFixtureForOpenBet(log, stake, odds) {
const manual = loadManualBetLinks()[String(log.id)];
if (manual) {
const reviewed = loadFootballFixtureRecords()
.find(fixture => String(fixture.gameId) === String(manual.gameId)) || {};
return { ...reviewed, ...manual };
}
const placedAt = Number(log.timestamp || 0) * 1000;
const fixtures = loadFootballFixtureRecords();
let best = null;
fixtures.forEach(fixture => {
(fixture.betClicks || []).forEach(click => {
const timeGap = Math.abs(placedAt - Number(click.clickedAt || 0));
const oddsMatch = Math.abs(Number(click.odds || 0) - Number(odds || 0)) <= 0.011;
const stakeMatch = !Number(click.stake || 0) || Math.abs(Number(click.stake) - Number(stake || 0)) < 1;
if (timeGap > FOOTBALL_BET_LINK_WINDOW_MS || !oddsMatch || !stakeMatch) return;
if (!best || timeGap < best.timeGap) best = { fixture, click, timeGap };
});
});
if (best) {
return {
...best.fixture,
placedSelection: best.click.selection,
linkedClickAt: best.click.clickedAt,
linkedBy: 'bet-click'
};
}
const retroCandidates = [];
fixtures.forEach(fixture => {
const kickoff = Number(fixture.startTimestamp || 0);
if (!kickoff || !placedAt || placedAt >= kickoff) return;
[
{ selection: fixture.homeTeam, odds: fixture.homeOdds },
{ selection: 'Draw', odds: fixture.drawOdds },
{ selection: fixture.awayTeam, odds: fixture.awayOdds }
].forEach(candidate => {
if (!candidate.selection || !Number(candidate.odds || 0)) return;
if (Math.abs(Number(candidate.odds) - Number(odds || 0)) > 0.011) return;
retroCandidates.push({ fixture, selection: candidate.selection });
});
});
const uniqueCandidates = Array.from(new Map(
retroCandidates.map(candidate => [
`${candidate.fixture.gameId}:${candidate.selection.toLowerCase()}`,
candidate
])
).values());
if (uniqueCandidates.length !== 1) return null;
const retro = uniqueCandidates[0];
return {
...retro.fixture,
placedSelection: retro.selection,
linkedBy: 'unique-reviewed-odds'
};
}
function getReviewedOddsForFixtureSelection(fixture) {
const selection = String(fixture?.placedSelection || '').trim().toLowerCase();
if (!selection) return 0;
if (selection === String(fixture.homeTeam || '').trim().toLowerCase()) return Number(fixture.homeOdds || 0);
if (selection === String(fixture.awayTeam || '').trim().toLowerCase()) return Number(fixture.awayOdds || 0);
if (/^(draw|tie)$/i.test(selection)) return Number(fixture.drawOdds || 0);
return 0;
}
function getPendingFootballBetCaptures() {
const now = Date.now();
const linkedClicks = new Set(openBets
.map(bet => Number(bet.fixture?.linkedClickAt || 0))
.filter(Boolean));
return loadFootballFixtureRecords().flatMap(fixture => {
return (fixture.betClicks || [])
.filter(click => now - Number(click.clickedAt || 0) <= FOOTBALL_PENDING_BET_VISIBLE_MS)
.filter(click => !linkedClicks.has(Number(click.clickedAt || 0)))
.map(click => ({ fixture, click }));
}).sort((a, b) => Number(b.click.clickedAt || 0) - Number(a.click.clickedAt || 0));
}
function showFootballBetCaptureNotice(fixture, selection, odds) {
document.getElementById('tbp-football-capture-notice')?.remove();
const notice = document.createElement('div');
notice.id = 'tbp-football-capture-notice';
notice.style.cssText = 'position:fixed; top:72px; right:20px; max-width:340px; padding:9px 12px; border-radius:6px; background:#275a7a; border:1px solid #59a7d3; color:#fff; z-index:1000000; font:12px Segoe UI,sans-serif; box-shadow:0 5px 18px rgba(0,0,0,.65);';
notice.textContent = `Bet click captured: ${fixture.homeTeam} v ${fixture.awayTeam} — ${selection} x${Number(odds || 0).toFixed(2)}. Refresh after Torn confirms the bet.`;
document.body.appendChild(notice);
setTimeout(() => notice.remove(), 5000);
}
function recordFootballOddsForItem(item, href = '') {
if (!footballOddsHistoryEnabled || document.visibilityState !== 'visible' || !isFootballBookiePage()) return 0;
const market = getThreeWayMarket(item);
if (!market) return 0;
const gameId = getFootballGameId(item, href);
if (!gameId) return 0;
const matchElement = item.querySelector('.matchName p, .pop-game .name p');
const matchTitle = String(matchElement?.title || matchElement?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
const observedAt = Date.now();
const startTimestamp = parseFootballStartTimestamp(item);
const history = loadFootballOddsHistory();
const game = history.games[gameId] || { matchTitle, lastViewedAt: 0, selections: {} };
game.matchTitle = matchTitle;
game.lastViewedAt = observedAt;
game.startTimestamp = startTimestamp || Number(game.startTimestamp || 0);
if (game.startTimestamp && game.startTimestamp <= observedAt) {
delete history.games[gameId];
saveFootballOddsHistory(history);
return 0;
}
let recorded = 0;
const rows = Array.from(market.querySelectorAll(':scope > li.bets')).filter(row => {
return row.querySelector('.bet-cell.result') && row.querySelector('.bet-cell.odds.decimal');
});
rows.forEach(row => {
const selection = String(row.querySelector('.bet-cell.result')?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
const oddsCell = row.querySelector('.bet-cell.odds.decimal');
const odds = parseDecimalMultiplier(oddsCell?.textContent);
if (!selection || !odds) return;
oddsCell.querySelector('.tbp-odds-delta')?.remove();
const selectionKey = selection.toLowerCase();
const observations = Array.isArray(game.selections[selectionKey])
? game.selections[selectionKey]
: [];
const previous = observations[observations.length - 1] || null;
const delta = previous ? odds - Number(previous.odds || 0) : 0;
if (!previous || Math.abs(delta) > 0.0001) {
observations.push({ odds, observedAt, firstObservedAt: observedAt });
if (observations.length > MAX_ODDS_OBSERVATIONS_PER_SELECTION) {
observations.splice(0, observations.length - MAX_ODDS_OBSERVATIONS_PER_SELECTION);
}
} else {
previous.observedAt = observedAt;
}
game.selections[selectionKey] = observations;
recorded++;
oddsCell.dataset.tbpObservedAt = String(observedAt);
if (previous && Math.abs(delta) > 0.0001) {
const badge = document.createElement('span');
const isUp = delta > 0;
badge.className = `tbp-odds-delta ${isUp ? 'tbp-odds-delta-up' : 'tbp-odds-delta-down'}`;
badge.textContent = `${isUp ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
badge.title = `Previous x${Number(previous.odds).toFixed(2)} at ${new Date(previous.observedAt).toLocaleString()}; viewed now at ${new Date(observedAt).toLocaleString()}.`;
oddsCell.appendChild(badge);
}
});
history.games[gameId] = game;
saveFootballOddsHistory(history);
return recorded;
}
let pendingFootballOddsObserver = null;
let pendingFootballOddsTimeout = null;
let pendingFootballOddsSettleTimeout = null;
function watchManuallyOpenedFootballGame(href) {
pendingFootballOddsObserver?.disconnect();
if (pendingFootballOddsTimeout) clearTimeout(pendingFootballOddsTimeout);
if (pendingFootballOddsSettleTimeout) clearTimeout(pendingFootballOddsSettleTimeout);
const tryRecord = () => {
const item = findFootballItemForHref(href);
const info = item?.querySelector('.info-wrap');
if (!item?.classList.contains('active') || info?.style?.display === 'none' || !getThreeWayMarket(item)) return false;
if (footballOddsHistoryEnabled) recordFootballOddsForItem(item, href);
if (footballScanEnabled || guidedFootballSession.active) {
const scanResult = scanFootballItem(item, href);
recordGuidedFootballResult(href, scanResult);
}
pendingFootballOddsObserver?.disconnect();
pendingFootballOddsObserver = null;
if (pendingFootballOddsTimeout) clearTimeout(pendingFootballOddsTimeout);
pendingFootballOddsTimeout = null;
if (pendingFootballOddsSettleTimeout) clearTimeout(pendingFootballOddsSettleTimeout);
pendingFootballOddsSettleTimeout = null;
return true;
};
const scheduleRecord = () => {
if (pendingFootballOddsSettleTimeout) clearTimeout(pendingFootballOddsSettleTimeout);
pendingFootballOddsSettleTimeout = setTimeout(() => tryRecord(), 400);
};
pendingFootballOddsObserver = new MutationObserver(scheduleRecord);
pendingFootballOddsObserver.observe(document.body, { childList: true, subtree: true });
scheduleRecord();
pendingFootballOddsTimeout = setTimeout(() => {
pendingFootballOddsObserver?.disconnect();
pendingFootballOddsObserver = null;
if (pendingFootballOddsSettleTimeout) clearTimeout(pendingFootballOddsSettleTimeout);
pendingFootballOddsSettleTimeout = null;
pendingFootballOddsTimeout = null;
}, 10000);
}
function scanFootballItem(item, href = '') {
if (item.classList.contains('disabled')) return { scanned: 0, matched: 0 };
const sport = String(item.querySelector('li.game')?.title || '').trim().toLowerCase();
if (sport && sport !== 'football') return { scanned: 0, matched: 0 };
const matchElement = item.querySelector('.matchName p, .pop-game .name p');
const matchTitle = String(matchElement?.title || matchElement?.textContent || '').replace(/\s+/g, ' ').trim();
if (!matchTitle) return { scanned: 0, matched: 0 };
const fixtureDetails = getFootballFixtureDetails(item, href);
const homeName = fixtureDetails.homeTeam || String(
matchElement.querySelector('b')?.textContent || matchTitle.split(/\s+v\s+/i)[0] || ''
).replace(/\s+/g, ' ').trim();
const market = getThreeWayMarket(item);
if (!market) return { scanned: 0, matched: 0 };
if (!market.querySelector('[data-tbp-observed-at]')) recordFootballOddsForItem(item, href);
const rows = Array.from(market.querySelectorAll(':scope > li.bets')).filter(row => {
return row.querySelector('.bet-cell.result') && row.querySelector('.bet-cell.odds.decimal');
});
if (rows.length !== 3) return { scanned: 0, matched: 0 };
const homeRow = rows.find(row => {
const result = String(row.querySelector('.bet-cell.result')?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
return result.toLowerCase() === homeName.toLowerCase();
}) || rows[0];
const awayName = fixtureDetails.awayTeam;
const awayRow = rows.find(row => {
const result = String(row.querySelector('.bet-cell.result')?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
return awayName && result.toLowerCase() === awayName.toLowerCase();
}) || rows.find(row => {
if (row === homeRow) return false;
const result = String(row.querySelector('.bet-cell.result')?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
return !/^(draw|tie)$/i.test(result);
}) || rows[2];
const rowIsSuspended = row => row.querySelector('.input-money-group')?.classList.contains('disabled')
|| row.querySelector('input.amount')?.value === 'Suspended';
const homeOdds = parseDecimalMultiplier(homeRow.querySelector('.bet-cell.odds.decimal')?.textContent);
const awayOdds = parseDecimalMultiplier(awayRow.querySelector('.bet-cell.odds.decimal')?.textContent);
const homeAvailable = Boolean(homeOdds) && !rowIsSuspended(homeRow);
const awayAvailable = Boolean(awayOdds) && !rowIsSuspended(awayRow);
if (!homeAvailable && !awayAvailable) return { scanned: 0, matched: 0, matchType: null };
item.classList.remove(
'tbp-football-match',
'tbp-football-home-green',
'tbp-football-home-yellow',
'tbp-football-away-orange'
);
matchElement.querySelector('.tbp-football-badge')?.remove();
let matchType = null;
let badgeText = '';
let badgeTitle = '';
if (homeAvailable && homeOdds >= FOOTBALL_HOME_GREEN_MIN && homeOdds <= FOOTBALL_HOME_ODDS_MAX) {
matchType = 'home-green';
badgeText = `HOME x${homeOdds.toFixed(2)}`;
badgeTitle = `${homeName} — 3-Way Ordinary time`;
} else if (homeAvailable && homeOdds >= FOOTBALL_HOME_YELLOW_MIN && homeOdds < FOOTBALL_HOME_GREEN_MIN) {
matchType = 'home-yellow';
badgeText = `HOME x${homeOdds.toFixed(2)}`;
badgeTitle = `${homeName} — 3-Way Ordinary time`;
} else if (awayAvailable && awayOdds >= FOOTBALL_AWAY_ODDS_MIN && awayOdds <= FOOTBALL_AWAY_ODDS_MAX) {
matchType = 'away-orange';
badgeText = `AWAY x${awayOdds.toFixed(2)}`;
badgeTitle = `${awayName || 'Away team'} — 3-Way Ordinary time`;
}
captureReviewedFootballFixture(item, href, market, matchType);
if (!matchType) return { scanned: 1, matched: 0, matchType: null };
item.classList.add('tbp-football-match', `tbp-football-${matchType}`);
const badge = document.createElement('span');
badge.className = `tbp-football-badge tbp-football-badge-${matchType}`;
badge.textContent = badgeText;
badge.title = badgeTitle;
matchElement.appendChild(badge);
return { scanned: 1, matched: 1, matchType };
}
function scanLoadedFootballGames() {
if (!guidedFootballSession.active) clearFootballHighlights();
if (!footballScanEnabled) {
return { error: 'Enable Football win-odds scanning in Settings first.' };
}
if (!isFootballBookiePage()) {
return { error: 'Open the Football section of Torn Bookie before scanning.' };
}
if (document.visibilityState !== 'visible') {
return { error: 'The Football page must be visible while scanning.' };
}
let scanned = 0;
let matched = 0;
document.querySelectorAll('li.c-pointer').forEach(item => {
const result = scanFootballItem(item);
scanned += result.scanned;
matched += result.matched;
});
return { scanned, matched };
}
let guidedFootballSession = { active: false, hrefs: [], index: -1, results: {} };
let guidedFootballHighlightObserver = null;
let guidedFootballHighlightTimer = null;
function stopGuidedFootballHighlightKeeper() {
guidedFootballHighlightObserver?.disconnect();
guidedFootballHighlightObserver = null;
if (guidedFootballHighlightTimer) clearTimeout(guidedFootballHighlightTimer);
guidedFootballHighlightTimer = null;
}
function resetGuidedFootballSession() {
stopGuidedFootballHighlightKeeper();
guidedFootballSession = { active: false, hrefs: [], index: -1, results: {} };
}
function guidedFootballFoundCount() {
return Object.values(guidedFootballSession.results).filter(Boolean).length;
}
function guidedFootballButtonText() {
if (!guidedFootballSession.active) return 'Game Review';
const position = Math.max(0, guidedFootballSession.index + 1);
const total = guidedFootballSession.hrefs.length;
const found = guidedFootballFoundCount();
return position >= total
? `Reviewed ${position}/${total} · ${found} found`
: `Next ${position}/${total} · ${found} found`;
}
function updateGuidedFootballControls() {
const reviewBtn = document.getElementById('tbp-football-guide-btn');
if (reviewBtn) {
reviewBtn.textContent = guidedFootballButtonText();
const complete = guidedFootballSession.active
&& guidedFootballSession.index >= guidedFootballSession.hrefs.length - 1;
reviewBtn.disabled = complete;
reviewBtn.title = complete
? `Review complete: ${guidedFootballFoundCount()} found. Press End to clear the review.`
: guidedFootballSession.active
? `Press once to open the next game; ${guidedFootballFoundCount()} found so far.`
: 'Start a review of up to 20 upcoming Football games.';
}
}
function restoreGuidedFootballHighlights() {
if (!guidedFootballSession.active || document.visibilityState !== 'visible' || !isFootballBookiePage()) return;
const colorClasses = [
'tbp-football-home-green',
'tbp-football-home-yellow',
'tbp-football-away-orange'
];
Object.entries(guidedFootballSession.results).forEach(([href, matchType]) => {
if (!matchType) return;
const item = findFootballItemForHref(href);
if (!item) return;
const desiredClass = `tbp-football-${matchType}`;
const hasWrongColor = colorClasses.some(className => className !== desiredClass && item.classList.contains(className));
if (item.classList.contains('tbp-football-match') && item.classList.contains(desiredClass) && !hasWrongColor) return;
item.classList.remove('tbp-football-match', ...colorClasses);
item.classList.add('tbp-football-match', desiredClass);
});
}
function scheduleGuidedFootballHighlightRestore() {
if (!guidedFootballSession.active || document.visibilityState !== 'visible' || !isFootballBookiePage()) return;
if (guidedFootballHighlightTimer) clearTimeout(guidedFootballHighlightTimer);
guidedFootballHighlightTimer = setTimeout(() => {
guidedFootballHighlightTimer = null;
restoreGuidedFootballHighlights();
}, 75);
}
function startGuidedFootballHighlightKeeper() {
stopGuidedFootballHighlightKeeper();
if (!guidedFootballSession.active || document.visibilityState !== 'visible' || !isFootballBookiePage()) return;
guidedFootballHighlightObserver = new MutationObserver(scheduleGuidedFootballHighlightRestore);
guidedFootballHighlightObserver.observe(document.body, {
childList: true,
subtree: true,
attributes: true,
attributeFilter: ['class']
});
restoreGuidedFootballHighlights();
}
function recordGuidedFootballResult(href, result) {
if (!guidedFootballSession.active
|| !guidedFootballSession.hrefs.includes(href)
|| Object.prototype.hasOwnProperty.call(guidedFootballSession.results, href)) return;
guidedFootballSession.results[href] = result.matchType || false;
restoreGuidedFootballHighlights();
updateGuidedFootballControls();
}
function endGuidedFootballReview({ leftFootball = false } = {}) {
const wasActive = guidedFootballSession.active;
resetGuidedFootballSession();
clearFootballHighlights();
if (wasActive && !leftFootball && isFootballBookiePage()) location.hash = '#/football/';
render();
}
function getGuidedFootballCandidates() {
const seen = new Set();
return Array.from(document.querySelectorAll('li.c-pointer'))
.filter(item => {
if (item.classList.contains('disabled')) return false;
const startTitle = String(item.querySelector('.state-wrap .state')?.title || '');
return /^Due to start at/i.test(startTitle);
})
.map(item => item.querySelector('a[href*="#/football/"]')?.getAttribute('href') || '')
.filter(href => {
if (!/^#\/football\/\d+$/i.test(href) || seen.has(href)) return false;
seen.add(href);
return true;
})
.slice(0, MAX_GUIDED_FOOTBALL_GAMES);
}
function advanceGuidedFootballReview() {
if (!guidedFootballReviewEnabled) {
return { error: 'Enable Guided Football review in Settings first.' };
}
if (!isFootballBookiePage() || document.visibilityState !== 'visible') {
return { error: 'Open and actively view the Football section before starting guided review.' };
}
let started = false;
if (!guidedFootballSession.active) {
const hrefs = getGuidedFootballCandidates();
if (!hrefs.length) return { error: 'No upcoming Football games are currently available in the loaded list.' };
guidedFootballSession = {
active: true,
hrefs,
index: -1,
results: {}
};
startGuidedFootballHighlightKeeper();
started = true;
}
if (guidedFootballSession.index >= guidedFootballSession.hrefs.length - 1) {
return {
complete: true,
total: guidedFootballSession.hrefs.length,
matched: guidedFootballFoundCount()
};
}
const nextIndex = guidedFootballSession.index + 1;
const href = guidedFootballSession.hrefs[nextIndex];
const link = Array.from(document.querySelectorAll('a[href*="#/football/"]'))
.find(candidate => candidate.getAttribute('href') === href);
if (!link) {
clearFootballHighlights();
resetGuidedFootballSession();
return { error: 'The Football list changed. Press Game Review again to start a fresh session.' };
}
guidedFootballSession.index = nextIndex;
link.click();
return {
complete: false,
started,
position: nextIndex + 1,
total: guidedFootballSession.hrefs.length,
matched: guidedFootballFoundCount()
};
}
function render() {
ensurePanelMounted();
if (isMinimized) {
container.className = 'minimized';
container.innerHTML = 'B';
container.onclick = () => {
isMinimized = false;
container.onclick = null;
saveData();
render();
};
return;
}
if (!showDebug && activeTab === 'debug') activeTab = 'open';
container.className = '';
container.innerHTML = `
<div class="tbp-header">
<div class="tbp-header-title">
<strong>Bookie Panel</strong>
${footballScanEnabled && !guidedFootballReviewEnabled ? '<button class="tbp-btn tbp-scan-btn" id="tbp-football-scan-btn">Scan Games</button>' : ''}
${guidedFootballReviewEnabled ? `<button class="tbp-btn tbp-guide-btn" id="tbp-football-guide-btn">${guidedFootballButtonText()}</button>` : ''}
${guidedFootballReviewEnabled && guidedFootballSession.active ? '<button class="tbp-btn tbp-btn-danger" id="tbp-football-end-guide-btn">End</button>' : ''}
</div>
<button class="tbp-btn" id="tbp-hide-btn" style="background:transparent; color:#888;">_</button>
</div>
<div class="tbp-tabs">
<div class="tbp-tab ${activeTab === 'open' ? 'active' : ''}" data-tab="open">Open</div>
<div class="tbp-tab ${activeTab === 'today' ? 'active' : ''}" data-tab="today">Today</div>
<div class="tbp-tab ${activeTab === 'daily' ? 'active' : ''}" data-tab="daily">Daily</div>
<div class="tbp-tab ${activeTab === 'batch' ? 'active' : ''}" data-tab="batch">${batchFeatureEnabled ? 'Batch' : 'Stats'}</div>
${showDebug ? `<div class="tbp-tab ${activeTab === 'debug' ? 'active' : ''}" data-tab="debug">Debug</div>` : ''}
<div class="tbp-tab ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</div>
</div>
<div class="tbp-content" id="tbp-body"></div>
<div class="tbp-btn-row" style="padding:10px; margin-top:0; border-top:1px solid #333;">
<button class="tbp-btn tbp-btn-primary" id="tbp-refresh-btn">Check for New Data</button>
<button class="tbp-btn" id="tbp-full-rescan-btn">Full Rescan</button>
</div>
`;
const body = document.getElementById('tbp-body');
if (activeTab === 'open') renderOpen(body);
if (activeTab === 'today') renderToday(body);
if (activeTab === 'daily') renderDaily(body);
if (activeTab === 'batch') {
if (batchFeatureEnabled) renderBatch(body);
else renderStats(body);
}
if (activeTab === 'debug') renderDebug(body);
if (activeTab === 'settings') renderSettings(body);
attachEvents();
}
function renderOpen(body) {
// Re-run local matching so fixtures reviewed after the API log was cached can
// retroactively supply names without making another Torn API request.
buildBookieData();
const totalStake = openBets.reduce((s, b) => s + b.stake, 0);
const totalProfit = openBets.reduce((s, b) => s + b.potentialProfit, 0);
const totalReturn = openBets.reduce((s, b) => s + b.potentialReturn, 0);
const pendingCaptures = getPendingFootballBetCaptures();
const pendingManual = getPendingManualCapture();
const footballScores = loadFootballScoreMatches();
const pendingManualBet = pendingManual
? openBets.find(bet => String(bet.id) === String(pendingManual.betId))
: null;
const pendingManualDetails = pendingManualBet ? `
<div class="tbp-card" style="border-color:#d69a32;">
<div style="font-weight:bold; color:#f2bd61;">Manual capture armed</div>
<div class="tbp-muted" style="margin-top:5px;">${money(pendingManualBet.stake)} at x${num(pendingManualBet.odds)} — go to My Bets and tap the matching game row. Tap Armed below to cancel.</div>
</div>
` : '';
const pendingCaptureDetails = pendingCaptures.length ? `
<div class="tbp-card" style="border-color:#3b82a8;">
<div style="font-weight:bold; color:#7fc8f1; margin-bottom:6px;">Captured — awaiting API refresh</div>
${pendingCaptures.map(({ fixture, click }) => `
<div style="margin-top:6px; padding-top:6px; border-top:1px solid #3a3a3a;">
<div style="font-weight:bold; font-size:12px;">${escapeHtml(fixture.homeTeam)} v ${escapeHtml(fixture.awayTeam)}</div>
${fixture.competition ? `<div class="tbp-muted">${escapeHtml(fixture.competition)}</div>` : ''}
<div class="tbp-row"><span>Pick</span><span>${escapeHtml(click.selection)} · x${num(click.odds)}</span></div>
<div class="tbp-row"><span>Captured</span><span>${escapeHtml(formatDate(Math.floor(Number(click.clickedAt || 0) / 1000)))}</span></div>
</div>
`).join('')}
<div class="tbp-muted" style="margin-top:7px;">After Torn confirms the bet, press Check for New Data to attach these names to its Open card.</div>
</div>
` : '';
body.innerHTML = `
<div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
<div class="tbp-summary-grid">
<div class="tbp-summary-box"><div class="tbp-summary-label">Open Bets</div><div class="tbp-summary-value">${openBets.length}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Stake</div><div class="tbp-summary-value">${money(totalStake)}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Profit</div><div class="tbp-summary-value tbp-win">${money(totalProfit)}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Return</div><div class="tbp-summary-value tbp-blue">${money(totalReturn)}</div></div>
</div>
${footballScoreEnabled ? `
<button class="tbp-btn tbp-btn-primary" id="tbp-check-scores-btn" style="width:100%; margin-bottom:8px;">Check Scores (${footballScoreProvider === 'sportsdb' ? 'TheSportsDB' : 'API-Football'})</button>
` : ''}
${pendingCaptureDetails}
${pendingManualDetails}
<div id="tbp-open-list"></div>
`;
const list = document.getElementById('tbp-open-list');
if (openBets.length === 0) {
list.innerHTML = `<div class="tbp-muted">No open bets found.</div>`;
return;
}
openBets.forEach(b => {
const row = document.createElement('div');
row.className = 'tbp-card';
const fixture = b.fixture;
const footballScore = footballScores[String(b.id)];
const isCaptureArmed = pendingManual?.betId === String(b.id);
const reviewedOdds = getReviewedOddsForFixtureSelection(fixture);
const reviewedOddsDelta = reviewedOdds ? reviewedOdds - Number(b.odds || 0) : 0;
const myBetsOdds = Number(fixture?.myBetsOdds || 0);
const myBetsOddsDelta = myBetsOdds ? myBetsOdds - Number(b.odds || 0) : 0;
const oddsComparison = reviewedOdds && Math.abs(reviewedOddsDelta) > 0.001 ? `
<div class="tbp-row"><span>Last reviewed odds</span><span>x${num(reviewedOdds)} (${reviewedOddsDelta > 0 ? '+' : ''}${reviewedOddsDelta.toFixed(2)})</span></div>
` : myBetsOdds && Math.abs(myBetsOddsDelta) > 0.001 ? `
<div class="tbp-row"><span>My Bets odds</span><span>x${num(myBetsOdds)} (${myBetsOddsDelta > 0 ? '+' : ''}${myBetsOddsDelta.toFixed(2)})</span></div>
` : '';
const fixtureDetails = fixture ? `
<div style="font-weight:bold; font-size:13px; margin-bottom:2px;">${escapeHtml(fixture.homeTeam)} v ${escapeHtml(fixture.awayTeam)}</div>
${fixture.competition ? `<div class="tbp-muted" style="margin-bottom:7px;">${escapeHtml(fixture.competition)}</div>` : ''}
<div class="tbp-row"><span>Pick</span><span>${escapeHtml(fixture.placedSelection || fixture.recommendedSelection || 'Names captured manually')}</span></div>
${fixture.linkedBy === 'unique-reviewed-odds' ? '<div class="tbp-muted" style="margin-bottom:5px;">Auto-matched from uniquely matching reviewed odds</div>' : ''}
${fixture.startTimestamp ? `<div class="tbp-row"><span>Kickoff</span><span>${escapeHtml(formatDate(Math.floor(fixture.startTimestamp / 1000)))}</span></div>` : ''}
${footballScore ? `<div class="tbp-row"><span>Score</span><span class="${['FT', 'AET', 'PEN'].includes(footballScore.statusShort) ? 'tbp-win' : 'tbp-blue'}">${escapeHtml(formatFootballScore(footballScore))}</span></div>` : ''}
` : `
<div style="font-weight:bold; font-size:12px;">Selection</div>
<div class="tbp-muted">${escapeHtml(b.selection)}</div>
`;
row.innerHTML = `
${fixtureDetails}
<div class="tbp-row"><span>Date</span><span>${formatDate(b.timestamp)}</span></div>
<div class="tbp-row"><span>Stake</span><span>${money(b.stake)}</span></div>
<div class="tbp-row"><span>Odds</span><span>x${num(b.odds)}</span></div>
${oddsComparison}
<div class="tbp-row"><span>Potential Profit</span><span class="tbp-win">${money(b.potentialProfit)}</span></div>
<div class="tbp-row"><span>Potential Return</span><span class="tbp-blue">${money(b.potentialReturn)}</span></div>
<div class="tbp-row"><span>Bet names</span><button class="tbp-btn ${isCaptureArmed ? 'tbp-btn-danger' : ''} tbp-capture-btn" data-tbp-capture-bet-id="${escapeHtml(String(b.id))}">${isCaptureArmed ? 'Armed' : fixture ? 'Recapture' : 'Capture'}</button></div>
`;
list.appendChild(row);
});
}
function renderToday(body) {
body.innerHTML = `
<div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
<div class="tbp-summary-grid">
<div class="tbp-summary-box"><div class="tbp-summary-label">Bets Today</div><div class="tbp-summary-value">${todaySummary.bets}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Wins / Losses</div><div class="tbp-summary-value">${todaySummary.wins} / ${todaySummary.losses}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Net Won</div><div class="tbp-summary-value tbp-win">${money(todaySummary.won)}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Lost</div><div class="tbp-summary-value tbp-loss">${money(todaySummary.lost)}</div></div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Daily Net</span>
<span class="${todaySummary.net >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(todaySummary.net)}</span>
</div>
<div class="tbp-row"><span>Refunds</span><span>${todaySummary.refunds}</span></div>
<div class="tbp-row"><span>Overall Bookie Net</span><span class="${overallBookieNet >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(overallBookieNet)}</span></div>
</div>
`;
}
function renderDaily(body) {
body.innerHTML = `
<div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
<div class="tbp-summary-grid">
<div class="tbp-summary-box"><div class="tbp-summary-label">From</div><div class="tbp-summary-value" style="font-size:13px;">${scanMode === 'pages' ? 'Page Limit' : scanStartDate}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Overall Net</div><div class="tbp-summary-value ${overallBookieNet >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(overallBookieNet)}</div></div>
</div>
<div class="tbp-daily-row tbp-daily-head">
<div>Date</div>
<div>Net</div>
<div>Bets</div>
<div>W/L</div>
</div>
<div id="tbp-daily-list"></div>
`;
const list = document.getElementById('tbp-daily-list');
if (dailyTotals.length === 0) {
list.innerHTML = `<div class="tbp-muted">No daily totals found.</div>`;
return;
}
dailyTotals.forEach(d => {
const row = document.createElement('div');
row.className = 'tbp-daily-row';
row.innerHTML = `
<div>${d.dateKey.slice(5)}</div>
<div class="${d.net >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(d.net)}</div>
<div>${d.bets}</div>
<div>${d.wins}/${d.losses}</div>
`;
list.appendChild(row);
});
}
function renderBatch(body) {
const selected = batches.find(b => b.id === selectedBatchId) || batches[0] || null;
if (selected && selectedBatchId !== selected.id) {
selectedBatchId = selected.id;
saveData();
}
const stats = selected ? getBatchStats(selected) : null;
const selectedBatchDate = selected?.fromDate || defaultBatchStartDate();
body.innerHTML = `
<div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
<div class="tbp-card">
<label class="tbp-muted">SELECT BATCH</label>
<select id="tbp-batch-select" class="tbp-select">
${batches.length === 0 ? `<option value="">No batches yet</option>` : ''}
${batches.map(b => `<option value="${b.id}" ${selected?.id === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
</select>
<label class="tbp-muted">BATCH NAME</label>
<input id="tbp-batch-name" class="tbp-input" value="${selected?.name || ''}" placeholder="Example: 999 bets">
<label class="tbp-muted">BATCH FROM DATE</label>
<input id="tbp-batch-from-date" type="date" class="tbp-input" value="${selectedBatchDate}">
<label class="tbp-muted">BET AMOUNT ENDS WITH</label>
<input id="tbp-batch-suffix" class="tbp-input" value="${selected?.endsWith || ''}" placeholder="Example: 999">
<div class="tbp-btn-row">
<button class="tbp-btn tbp-btn-success" id="tbp-create-batch">Create</button>
<button class="tbp-btn tbp-btn-primary" id="tbp-save-batch">Save</button>
<button class="tbp-btn tbp-btn-danger" id="tbp-delete-batch">Delete</button>
</div>
</div>
${stats ? `
<div class="tbp-summary-grid">
<div class="tbp-summary-box"><div class="tbp-summary-label">Placed</div><div class="tbp-summary-value">${stats.placed}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">W / L</div><div class="tbp-summary-value">${stats.wins} / ${stats.losses}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Stake</div><div class="tbp-summary-value">${money(stats.stake)}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Net</div><div class="tbp-summary-value ${stats.net >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(stats.net)}</div></div>
</div>
<div class="tbp-summary-grid">
<div class="tbp-summary-box"><div class="tbp-summary-label">Open</div><div class="tbp-summary-value">${stats.openCount}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Open Stake</div><div class="tbp-summary-value">${money(stats.openStake)}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Open Profit</div><div class="tbp-summary-value tbp-win">${money(stats.openProfit)}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Open Return</div><div class="tbp-summary-value tbp-blue">${money(stats.openReturn)}</div></div>
</div>
` : `<div class="tbp-muted">Create a batch to start tracking.</div>`}
`;
}
function renderDebug(body) {
body.innerHTML = `
<div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
<div class="tbp-card">
<div style="font-weight:bold; margin-bottom:8px;">Debug Logs</div>
<div class="tbp-muted">Showing first 30 loaded logs only.</div>
${rawLogs.slice(0, 30).map(log => `
<div class="tbp-debug">
TYPE: ${classifyLog(log)}
KEY: ${getSelectionKey(log)}
BET: ${getBetAmount(log)}
ODDS: ${getOdds(log)}
WINNINGS: ${getWinnings(log)}
DATE: ${formatDate(log.timestamp)}
RAW:
${safeJson(log.raw)}
</div>
`).join('')}
</div>
`;
}
function renderSettings(body) {
const scoreUsage = loadFootballScoreUsage();
const sportsDbUsage = getSportsDbUsage();
const resetDate = new Date(`${scoreUsage.date}T00:00:00Z`);
resetDate.setUTCDate(resetDate.getUTCDate() + 1);
body.innerHTML = `
<label class="tbp-muted">TORN API KEY</label>
<input type="password" id="tbp-api-key" class="tbp-input" value="${escapeHtml(apiKey)}" placeholder="Paste Torn API key">
<label class="tbp-muted">SCAN MODE</label>
<select id="tbp-scan-mode" class="tbp-select">
<option value="both" ${scanMode === 'both' ? 'selected' : ''}>Date + Page Limit</option>
<option value="date" ${scanMode === 'date' ? 'selected' : ''}>Date Only</option>
<option value="pages" ${scanMode === 'pages' ? 'selected' : ''}>Page Limit Only</option>
</select>
<label class="tbp-muted">SCAN FROM DATE</label>
<input type="date" id="tbp-scan-start-date" class="tbp-input" value="${scanStartDate}">
<label class="tbp-muted">MAX API PAGES TO LOAD</label>
<input type="number" id="tbp-max-pages" class="tbp-input" value="${maxPages}" min="1" max="${MAX_API_PAGES_PER_SCAN}">
<div class="tbp-card">
<div class="tbp-muted">
Date + Page Limit uses both and stops when either limit is reached.
Date Only continues to the configured date and ignores Max API Pages; a fixed ${MAX_API_PAGES_PER_SCAN}-page emergency ceiling still applies.
Page Limit Only ignores the configured scan date. Full Rescan always requires a separate confirmation.
</div>
</div>
<div class="tbp-card">
<div style="font-weight:bold; margin-bottom:6px;">API usage and privacy</div>
<div class="tbp-muted">
<strong>Data storage:</strong> Bookie logs in this browser's IndexedDB; viewed Football fixtures, manual bet clicks, and My Bets name links in local storage.<br>
<strong>Data sharing:</strong> Torn history stays local. When Football scores are enabled, only team names and fixture dates are sent to the selected score provider; captured bet amounts and Torn history are never sent.<br>
<strong>Purpose:</strong> Personal bookie history, totals, named open-bet estimates, Football review, and incremental refreshes.<br>
<strong>Key handling:</strong> Keys stay in this browser. The Torn key is sent only to api.torn.com, and the optional API-Football key only to v3.football.api-sports.io. TheSportsDB free mode uses its public key.<br>
<strong>Required access:</strong> Custom access to user → log, restricted to category 195 (Bookie), or Full Access.
</div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Enable Football win-odds scan</span>
<input type="checkbox" id="tbp-football-scan-enabled" ${footballScanEnabled ? 'checked' : ''}>
</div>
<div class="tbp-muted" style="margin-top:7px;">
Highlights 3-Way Ordinary time fixtures by straight-win odds: yellow for home x${FOOTBALL_HOME_YELLOW_MIN.toFixed(2)}–x${(FOOTBALL_HOME_GREEN_MIN - 0.01).toFixed(2)}, green for home x${FOOTBALL_HOME_GREEN_MIN.toFixed(2)}–x${FOOTBALL_HOME_ODDS_MAX.toFixed(2)}, and orange for away x${FOOTBALL_AWAY_ODDS_MIN.toFixed(2)}–x${FOOTBALL_AWAY_ODDS_MAX.toFixed(2)}.
</div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Track viewed 3-Way odds</span>
<input type="checkbox" id="tbp-football-odds-history-enabled" ${footballOddsHistoryEnabled ? 'checked' : ''}>
</div>
<div class="tbp-muted" style="margin-top:7px;">
Records home, draw, and away multipliers locally when you manually open a Football game. Changed odds receive a signed badge such as +0.12 or −0.08; tap or hover the badge to see the prior observation time. A game's records are deleted when its Torn start time is reached.
</div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Enable Football Game Review</span>
<input type="checkbox" id="tbp-guided-football-review-enabled" ${guidedFootballReviewEnabled ? 'checked' : ''}>
</div>
<div class="tbp-muted" style="margin-top:7px;">
Game Review opens the first upcoming game immediately, then advances one game per press through up to ${MAX_GUIDED_FOOTBALL_GAMES} games. It counts qualifying straight-win odds, keeps each matching fixture bar color until End, and captures club details when you manually press a 3-Way BET button so they can appear in Open after an API refresh.
</div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Enable Football scores</span>
<input type="checkbox" id="tbp-football-score-enabled" ${footballScoreEnabled ? 'checked' : ''}>
</div>
<div class="tbp-muted" style="margin-top:7px;">Checks only when you press Check Scores. Finished results remain cached.</div>
<label class="tbp-muted" style="display:block; margin-top:9px;">SCORE PROVIDER</label>
<select id="tbp-football-score-provider" class="tbp-select" style="margin-bottom:6px;">
<option value="sportsdb" ${footballScoreProvider === 'sportsdb' ? 'selected' : ''}>TheSportsDB Free (30/minute)</option>
<option value="api-football" ${footballScoreProvider === 'api-football' ? 'selected' : ''}>API-Football (100/day)</option>
</select>
<label class="tbp-muted" style="display:block; margin-top:9px;">API-FOOTBALL KEY</label>
<input type="password" id="tbp-football-score-api-key" class="tbp-input" value="${escapeHtml(footballScoreApiKey)}" placeholder="Optional unless API-Football is selected" style="margin-bottom:6px;">
<div class="tbp-summary-grid" style="margin-top:7px; margin-bottom:7px;">
<div class="tbp-summary-box"><div class="tbp-summary-label">${footballScoreProvider === 'sportsdb' ? 'Used This Minute' : 'Requests Used'}</div><div class="tbp-summary-value">${footballScoreProvider === 'sportsdb' ? sportsDbUsage.used : scoreUsage.used}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Remaining</div><div class="tbp-summary-value ${(footballScoreProvider === 'sportsdb' ? sportsDbUsage.remaining : scoreUsage.remaining) <= 10 ? 'tbp-loss' : 'tbp-win'}">${footballScoreProvider === 'sportsdb' ? `${sportsDbUsage.remaining} / ${sportsDbUsage.limit}` : `${scoreUsage.remaining} / ${scoreUsage.limit}`}</div></div>
</div>
<div class="tbp-muted">${footballScoreProvider === 'sportsdb'
? `The rolling counter clears each call 60 seconds after it was made. Calls are spaced ${Math.round(SPORTSDB_MIN_REQUEST_GAP_MS / 100) / 10} seconds apart, so the check duration adapts to the number of named games.`
: `Counter resets daily. Next reset: ${escapeHtml(resetDate.toLocaleString())}. ${scoreUsage.source === 'provider' ? 'Verified from API-Football.' : 'Locally counted until the provider returns quota headers.'}`} Cached checks do not use a request.</div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Use Batch tab instead of Stats</span>
<input type="checkbox" id="tbp-batch-feature-enabled" ${batchFeatureEnabled ? 'checked' : ''}>
</div>
<div class="tbp-muted" style="margin-top:7px;">Leave off to show green, yellow, orange, and all-other Football records from the configured scan date.</div>
</div>
<div class="tbp-card">
<div class="tbp-row">
<span>Show Debug Tab</span>
<input type="checkbox" id="tbp-show-debug" ${showDebug ? 'checked' : ''}>
</div>
</div>
<button class="tbp-btn tbp-btn-success" id="tbp-save-settings" style="width:100%;">Save Settings</button>
`;
}
function renderStats(body) {
const stats = getColorBetStats();
const total = stats.total;
const colorStyles = {
green: 'border-left:6px solid #28a745;',
yellow: 'border-left:6px solid #d4ad00;',
orange: 'border-left:6px solid #e87800;',
other: 'border-left:6px solid #777;'
};
body.innerHTML = `
<div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
<div class="tbp-muted" style="margin-bottom:8px;">Color Stats include classified 3-Way Football bets placed from ${escapeHtml(stats.fromDate)} through today. Other Bookie activity remains in Daily and is counted separately here.</div>
<button class="tbp-btn tbp-btn-primary" id="tbp-measure-stats-btn" style="width:100%; margin-bottom:8px;">Refresh Outcome Audit</button>
<div class="tbp-row" style="margin:0 2px 4px;"><span>Classified 3-Way Football</span><span>${stats.trackedPlaced}</span></div>
<div class="tbp-row" style="margin:0 2px 4px;"><span>Settled / Open / Refunded</span><span>${stats.total.settled} / ${stats.total.open} / ${stats.total.refunds}</span></div>
<div class="tbp-row" style="margin:0 2px 9px;"><span>Other/unclassified Bookie bets</span><span>${stats.excludedUntracked}</span></div>
${stats.excludedUntracked ? '<div class="tbp-muted" style="margin-bottom:9px;">Other/unclassified can include other sports, other markets, and older bets without captured fixture details. Their outcomes and money still count in Daily; they are only excluded from the colored Football records below.</div>' : ''}
<div class="tbp-summary-grid">
<div class="tbp-summary-box"><div class="tbp-summary-label">Total Record</div><div class="tbp-summary-value">${total.wins}-${total.losses}</div></div>
<div class="tbp-summary-box"><div class="tbp-summary-label">Win / Loss</div><div class="tbp-summary-value" style="font-size:13px;">${total.winPct.toFixed(1)}% / ${total.lossPct.toFixed(1)}%</div></div>
<div class="tbp-summary-box" style="grid-column:1 / -1;"><div class="tbp-summary-label">Total Net</div><div class="tbp-summary-value ${total.net >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(total.net)}</div></div>
</div>
${stats.rows.map(row => `
<div class="tbp-card" style="${colorStyles[row.key]}">
<div style="font-weight:bold; font-size:13px;">${row.label}</div>
<div class="tbp-muted" style="margin:2px 0 5px;">${escapeHtml(row.rule)}</div>
<div class="tbp-row"><span>Record</span><span>${row.wins}-${row.losses}</span></div>
<div class="tbp-row"><span>Win / Loss</span><span>${row.winPct.toFixed(1)}% / ${row.lossPct.toFixed(1)}%</span></div>
<div class="tbp-row"><span>Net</span><span class="${row.net >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(row.net)}</span></div>
</div>
`).join('')}
${(stats.before.classifiedPlaced || stats.before.missingFixture) ? `
<div class="tbp-card" style="border-left:6px solid #4da3ff;">
<div style="font-weight:bold; font-size:13px;">Before ${escapeHtml(stats.fromDate)}</div>
<div class="tbp-muted" style="margin:2px 0 5px;">Captured history outside the selected Stats date range; kept separate from the totals above.</div>
<div class="tbp-row"><span>Classified 3-Way Football</span><span>${stats.before.classifiedPlaced}</span></div>
<div class="tbp-row"><span>Other/unclassified Bookie bets</span><span>${stats.before.missingFixture}</span></div>
<div class="tbp-row"><span>Record</span><span>${stats.before.total.wins}-${stats.before.total.losses}</span></div>
<div class="tbp-row"><span>Open / Refunded</span><span>${stats.before.total.open} / ${stats.before.total.refunds}</span></div>
<div class="tbp-row"><span>Net</span><span class="${stats.before.total.net >= 0 ? 'tbp-win' : 'tbp-loss'}">${money(stats.before.total.net)}</span></div>
</div>
` : ''}
${total.settled === 0 ? '<div class="tbp-muted">No settled, tracked bets with captured home/away evidence were found in this date range yet.</div>' : ''}
`;
}
function captureVisibleScanSettings() {
const modeInput = document.getElementById('tbp-scan-mode');
const dateInput = document.getElementById('tbp-scan-start-date');
const pagesInput = document.getElementById('tbp-max-pages');
if (!modeInput && !dateInput && !pagesInput) return;
if (modeInput) scanMode = modeInput.value;
if (dateInput) scanStartDate = dateInput.value || defaultScanStartDate();
if (pagesInput) {
maxPages = Math.max(1, Math.min(
Number(pagesInput.value || 5),
MAX_API_PAGES_PER_SCAN
));
}
saveData();
}
function attachEvents() {
['tbp-scan-mode', 'tbp-scan-start-date', 'tbp-max-pages'].forEach(id => {
const input = document.getElementById(id);
if (input) input.onchange = captureVisibleScanSettings;
});
document.querySelectorAll('.tbp-tab').forEach(tab => {
tab.onclick = () => {
captureVisibleScanSettings();
activeTab = tab.dataset.tab;
saveData();
render();
};
});
document.getElementById('tbp-hide-btn').onclick = e => {
e.stopPropagation();
captureVisibleScanSettings();
isMinimized = true;
saveData();
render();
};
document.getElementById('tbp-refresh-btn').onclick = async () => {
captureVisibleScanSettings();
const btn = document.getElementById('tbp-refresh-btn');
const fullBtn = document.getElementById('tbp-full-rescan-btn');
btn.innerText = 'Checking...';
btn.disabled = true;
fullBtn.disabled = true;
await fetchLogs();
btn.disabled = false;
fullBtn.disabled = false;
btn.innerText = 'Check for New Data';
render();
};
document.querySelectorAll('[data-tbp-capture-bet-id]').forEach(button => {
button.onclick = event => {
event.stopPropagation();
const bet = openBets.find(candidate => String(candidate.id) === button.dataset.tbpCaptureBetId);
if (!bet) return;
const armed = setPendingManualCapture(bet);
lastLoadStatus = armed
? `Manual name capture armed for ${money(bet.stake)} at x${num(bet.odds)}. Open My Bets and tap the matching game.`
: 'Manual name capture cancelled.';
render();
};
});
const checkScoresBtn = document.getElementById('tbp-check-scores-btn');
if (checkScoresBtn) {
checkScoresBtn.onclick = async () => {
checkScoresBtn.disabled = true;
checkScoresBtn.textContent = 'Checking...';
await checkOpenBetScores();
render();
};
}
const measureStatsBtn = document.getElementById('tbp-measure-stats-btn');
if (measureStatsBtn) {
measureStatsBtn.onclick = async () => {
measureStatsBtn.disabled = true;
measureStatsBtn.textContent = 'Auditing...';
await measureTrackedStatsDatabase();
render();
};
}
const footballScanBtn = document.getElementById('tbp-football-scan-btn');
if (footballScanBtn) {
footballScanBtn.onclick = () => {
const result = scanLoadedFootballGames();
if (result.error) {
alert(result.error);
return;
}
footballScanBtn.textContent = `${result.matched} found`;
footballScanBtn.title = result.scanned
? `Scanned ${result.scanned} loaded 3-Way Football fixture${result.scanned === 1 ? '' : 's'}.`
: 'No loaded 3-Way markets found. Manually expand games, then scan again.';
if (!result.scanned) alert(footballScanBtn.title);
};
}
const footballGuideBtn = document.getElementById('tbp-football-guide-btn');
if (footballGuideBtn) {
footballGuideBtn.onclick = () => {
const result = advanceGuidedFootballReview();
if (result.error) {
alert(result.error);
return;
}
if (result.complete) {
updateGuidedFootballControls();
footballGuideBtn.title = `Reviewed ${result.total} games and found ${result.matched} qualifying straight-win odds. Press End to clear the review.`;
return;
}
if (result.started) render();
else updateGuidedFootballControls();
};
updateGuidedFootballControls();
}
const footballEndGuideBtn = document.getElementById('tbp-football-end-guide-btn');
if (footballEndGuideBtn) {
footballEndGuideBtn.onclick = () => endGuidedFootballReview();
}
document.getElementById('tbp-full-rescan-btn').onclick = async () => {
captureVisibleScanSettings();
const rescanPageLimit = scanMode === 'date'
? MAX_API_PAGES_PER_SCAN
: Math.min(maxPages, MAX_API_PAGES_PER_SCAN);
const rescanScope = scanMode === 'date'
? `reach ${scanStartDate}`
: `use up to ${rescanPageLimit} API pages`;
if (!confirm(`Full rescan will ${rescanScope} (maximum ${rescanPageLimit} pages this run). Continue?`)) return;
const btn = document.getElementById('tbp-full-rescan-btn');
const refreshBtn = document.getElementById('tbp-refresh-btn');
btn.innerText = 'Rescanning...';
btn.disabled = true;
refreshBtn.disabled = true;
await fetchLogs(true);
btn.disabled = false;
refreshBtn.disabled = false;
btn.innerText = 'Full Rescan';
render();
};
const saveSettingsBtn = document.getElementById('tbp-save-settings');
if (saveSettingsBtn) {
saveSettingsBtn.onclick = async () => {
apiKey = document.getElementById('tbp-api-key').value.trim();
scanMode = document.getElementById('tbp-scan-mode').value;
scanStartDate = document.getElementById('tbp-scan-start-date').value || defaultScanStartDate();
maxPages = Math.max(1, Math.min(
Number(document.getElementById('tbp-max-pages').value || 5),
MAX_API_PAGES_PER_SCAN
));
showDebug = document.getElementById('tbp-show-debug').checked;
footballScanEnabled = document.getElementById('tbp-football-scan-enabled').checked;
footballOddsHistoryEnabled = document.getElementById('tbp-football-odds-history-enabled').checked;
guidedFootballReviewEnabled = document.getElementById('tbp-guided-football-review-enabled').checked;
footballScoreEnabled = document.getElementById('tbp-football-score-enabled').checked;
footballScoreProvider = document.getElementById('tbp-football-score-provider').value;
footballScoreApiKey = document.getElementById('tbp-football-score-api-key').value.trim();
batchFeatureEnabled = document.getElementById('tbp-batch-feature-enabled').checked;
saveData();
if (!footballScanEnabled) clearFootballHighlights();
if (!footballOddsHistoryEnabled) {
pendingFootballOddsObserver?.disconnect();
pendingFootballOddsObserver = null;
if (pendingFootballOddsTimeout) clearTimeout(pendingFootballOddsTimeout);
pendingFootballOddsTimeout = null;
if (pendingFootballOddsSettleTimeout) clearTimeout(pendingFootballOddsSettleTimeout);
pendingFootballOddsSettleTimeout = null;
if (footballHistoryExpiryTimer) clearTimeout(footballHistoryExpiryTimer);
footballHistoryExpiryTimer = null;
} else {
scheduleFootballHistoryExpiry(loadFootballOddsHistory());
}
if (!guidedFootballReviewEnabled) {
resetGuidedFootballSession();
clearFootballHighlights();
}
await hydrateFromCache();
};
}
const batchSelect = document.getElementById('tbp-batch-select');
if (batchSelect) {
batchSelect.onchange = () => {
selectedBatchId = batchSelect.value;
saveData();
render();
};
}
const createBatchBtn = document.getElementById('tbp-create-batch');
if (createBatchBtn) {
createBatchBtn.onclick = () => {
const name = document.getElementById('tbp-batch-name').value.trim() || 'New Batch';
const endsWith = document.getElementById('tbp-batch-suffix').value.trim();
const fromDate = document.getElementById('tbp-batch-from-date').value || defaultBatchStartDate();
const batch = {
id: `batch_${Date.now()}`,
name,
endsWith,
fromDate,
createdAt: new Date().toISOString()
};
batches.push(batch);
selectedBatchId = batch.id;
saveData();
render();
};
}
const saveBatchBtn = document.getElementById('tbp-save-batch');
if (saveBatchBtn) {
saveBatchBtn.onclick = () => {
const batch = batches.find(b => b.id === selectedBatchId);
if (!batch) return;
batch.name = document.getElementById('tbp-batch-name').value.trim() || batch.name;
batch.endsWith = document.getElementById('tbp-batch-suffix').value.trim();
batch.fromDate = document.getElementById('tbp-batch-from-date').value || defaultBatchStartDate();
saveData();
render();
};
}
const deleteBatchBtn = document.getElementById('tbp-delete-batch');
if (deleteBatchBtn) {
deleteBatchBtn.onclick = () => {
if (!selectedBatchId) return;
if (!confirm('Delete this batch?')) return;
batches = batches.filter(b => b.id !== selectedBatchId);
selectedBatchId = batches[0]?.id || '';
saveData();
render();
};
}
}
// Also refresh panel when Torn/PDA refresh-style buttons are clicked.
document.addEventListener('click', async e => {
const btn = e.target.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
if (!btn) return;
const txt = (btn.innerText || btn.value || btn.title || btn.getAttribute('aria-label') || '').toLowerCase();
if (
txt.includes('refresh') ||
txt.includes('reload') ||
btn.className?.toString().toLowerCase().includes('refresh') ||
btn.id?.toLowerCase().includes('refresh')
) {
// Ignore our own button because it already has its own handler
if (btn.id === 'tbp-refresh-btn') return;
captureVisibleScanSettings();
setTimeout(async () => {
if (!apiKey) return;
lastLoadStatus = 'Refreshing after page button click...';
render();
await fetchLogs();
render();
}, 1500);
}
}, true);
document.addEventListener('click', event => {
if (document.visibilityState !== 'visible' || !getPendingManualCapture()) return;
const target = event.target instanceof Element ? event.target : null;
const link = target?.closest('a[href*="#/your-bets/"]');
if (!link) return;
handleManualCaptureResult(captureArmedBetFromMyBetsLink(link));
}, true);
document.addEventListener('click', event => {
if (!guidedFootballSession.active || document.visibilityState !== 'visible' || !isFootballBookiePage()) return;
const target = event.target instanceof Element ? event.target : null;
const button = target?.closest('button');
const row = button?.closest('li.bets');
const market = row?.closest('ul.bets-wrap');
const item = row?.closest('li.c-pointer.active');
if (!button || !row || !market || !item || button.disabled || button.classList.contains('disabled')) return;
const marketName = String(market.querySelector('.market-name-cell .bold')?.textContent || '')
.replace(/\s+/g, ' ')
.trim();
if (!/^3-Way Ordinary time$/i.test(marketName)) return;
if (!row.querySelector('.bet-cell.result') || !row.querySelector('.bet-cell.odds.decimal')) return;
const selection = String(row.querySelector('.bet-cell.result')?.textContent || '').replace(/\s+/g, ' ').trim();
const odds = parseDecimalMultiplier(row.querySelector('.bet-cell.odds.decimal')?.textContent);
const captured = captureManualFootballBet(item, row, market);
if (!captured) return;
showFootballBetCaptureNotice(captured, selection, odds);
if (activeTab === 'open') setTimeout(render, 0);
}, true);
document.addEventListener('click', event => {
if ((!footballOddsHistoryEnabled && !footballScanEnabled && !guidedFootballSession.active) || document.visibilityState !== 'visible' || !isFootballBookiePage()) return;
const target = event.target instanceof Element ? event.target : null;
const link = target?.closest('a[href*="#/football/"]');
const href = link?.getAttribute('href') || '';
if (!/^#\/football\/\d+$/i.test(href)) return;
watchManuallyOpenedFootballGame(href);
}, true);
function handleFootballReviewRouteChange() {
if (!guidedFootballSession.active) return;
if (!isFootballBookiePage()) {
endGuidedFootballReview({ leftFootball: true });
return;
}
scheduleGuidedFootballHighlightRestore();
}
window.addEventListener('hashchange', handleFootballReviewRouteChange);
window.addEventListener('hashchange', captureArmedBetFromCurrentMyBetsRoute);
window.addEventListener('hashchange', scheduleMyBetsSnapshotCapture);
window.addEventListener('popstate', handleFootballReviewRouteChange);
document.addEventListener('visibilitychange', () => {
if (!guidedFootballSession.active) return;
if (document.visibilityState !== 'visible') {
stopGuidedFootballHighlightKeeper();
return;
}
if (isFootballBookiePage()) startGuidedFootballHighlightKeeper();
});
let visibleFootballResultCaptureTimer = null;
let visibleFootballResultObserver = null;
function scheduleVisibleFootballResultCapture() {
if (visibleFootballResultCaptureTimer) clearTimeout(visibleFootballResultCaptureTimer);
visibleFootballResultCaptureTimer = setTimeout(() => {
visibleFootballResultCaptureTimer = null;
if (document.visibilityState !== 'visible') return;
if (/^#\/your-bets(?:\/|$)/i.test(location.hash)) {
captureVisibleMyBetsSnapshot();
}
const result = captureVisibleFootballResultNames();
if (result.captured && activeTab === 'batch' && !batchFeatureEnabled) render();
}, 700);
}
function startVisibleFootballResultCapture() {
if (visibleFootballResultObserver || !document.body) return;
visibleFootballResultObserver = new MutationObserver(scheduleVisibleFootballResultCapture);
visibleFootballResultObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
scheduleVisibleFootballResultCapture();
}
let panelStarted = false;
function startBookiePanel() {
if (panelStarted) return;
panelStarted = true;
ensurePanelMounted();
startPanelMountObserver();
try {
render();
hydrateFromCache();
scheduleMyBetsSnapshotCapture();
startVisibleFootballResultCapture();
if (footballOddsHistoryEnabled) scheduleFootballHistoryExpiry(loadFootballOddsHistory());
} catch (error) {
console.error('Bookie Panel failed to start.', error);
isMinimized = true;
container.className = 'minimized';
container.innerHTML = 'B';
container.title = 'Bookie Panel encountered a startup error. Tap to retry.';
container.onclick = () => {
try {
render();
hydrateFromCache();
} catch (retryError) {
console.error('Bookie Panel retry failed.', retryError);
}
};
}
}
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', startBookiePanel, { once: true });
} else {
startBookiePanel();
}
})();
