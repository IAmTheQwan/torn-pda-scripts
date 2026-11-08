const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scriptPath = path.resolve(__dirname, 'qwantum-bookie.source.js');
const source = fs.readFileSync(scriptPath, 'utf8');

assert(source.includes("let openTabEnabled = JSON.parse(localStorage.getItem('tbp_open_tab_enabled') || 'false');"));
assert(source.includes("let goalsFeatureEnabled = JSON.parse(localStorage.getItem('tbp_goals_feature_enabled') ?? 'true');"));
assert(source.includes("let goalsApiKey = localStorage.getItem('tbp_goals_api_key') || '';"));
assert(source.includes('const key = goalsApiKey || apiKey;'));
assert(source.includes("stat: 'xantaken,refills,totalstats,timeplayed'"));
assert(source.includes("requestGoalsPath('faction/rankedwars?limit=100')"));
assert(source.includes('/rankedwarreport`'));
assert(source.includes('No repeating poll.'));
assert(source.includes("activityHours: 20, warHitPercent: 5"));
assert(source.includes("let goalsMonthView = 'current';"));
assert(!source.includes('data-goals-month="rolling"'));
assert(source.includes('rankedWars: currentWars'));
assert(source.includes('rankedWars: previousWars'));
assert(source.includes('.filter(war => Number(war?.end || 0) >= earliestMonthTimestamp)'));
assert(source.includes('war reports unavailable') || source.includes('war report${'));
assert(source.includes("parsed?.version === 2"));
assert(source.includes('goalsWarReportCache.entries[cacheKey]'));
assert(!source.includes('goalsWarReportCache[warId] = { report'));
assert(source.includes("requestGoalsPath('user/profile')"));
assert(source.includes('String(faction.id) === String(factionId)'));
assert(source.includes('Number(member?.attacks || 0)'));
assert(source.includes('audit: { xanaxEnd: latest.xantaken, xanaxStart: currentStart.xantaken'));
assert(source.includes('API audit:'));

const start = source.indexOf('    function calculateGoalsDifference');
const end = source.indexOf('    async function requestGoalsPath', start);
assert(start >= 0 && end > start, 'Could not locate the monthly-goals calculation.');

const context = {};
vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__calculateGoalsDifference = calculateGoalsDifference;`,
    context,
    { filename: scriptPath }
);

const difference = context.__calculateGoalsDifference(
    { xantaken: 172, refills: 91, totalstats: 510000000, timeplayed: 72000 },
    { xantaken: 100, refills: 64, totalstats: 400000000, timeplayed: 0 }
);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(difference)),
    { xanax: 72, refills: 27, battleStats: 110000000, activityHours: 20 }
);

const clamped = context.__calculateGoalsDifference(
    { xantaken: 9, refills: 4, totalstats: 90, timeplayed: 99 },
    { xantaken: 10, refills: 5, totalstats: 100, timeplayed: 100 }
);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(clamped)),
    { xanax: 0, refills: 0, battleStats: 0, activityHours: 0 }
);

assert.strictEqual(context.calculateRankedWarPercent(5, 100), 5);
assert.strictEqual(context.calculateRankedWarPercent(1, 0), 0);

const pace = context.calculateMonthlyGoalPace(18, 72, '2026-11', true, 3, new Date('2026-11-09T12:00:00Z'));
assert.strictEqual(pace.daysInMonth, 30);
assert.strictEqual(pace.elapsedDays, 9);
assert.strictEqual(pace.requiredDaily, 2.4);
assert.strictEqual(pace.dailyAverage, 2);
assert.strictEqual(pace.projectedTotal, 60);
assert.strictEqual(pace.maximumPossible, 81);

const finalPace = context.calculateMonthlyGoalPace(27, 27, '2026-10', false, 1, new Date('2026-11-09T12:00:00Z'));
assert.strictEqual(finalPace.elapsedDays, 31);
assert.strictEqual(finalPace.projectedTotal, 27);
assert.strictEqual(finalPace.maximumPossible, 27);

console.log('Qwantum Bookie monthly goals tests passed.');
