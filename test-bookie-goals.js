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
assert(source.includes("stat: 'xantaken,refills,totalstats'"));
assert(source.includes('A refresh uses 3 Torn API requests. No repeating poll.'));

const start = source.indexOf('    function calculateGoalsDifference');
const end = source.indexOf('    async function requestGoalsTornV2', start);
assert(start >= 0 && end > start, 'Could not locate the monthly-goals calculation.');

const context = {};
vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__calculateGoalsDifference = calculateGoalsDifference;`,
    context,
    { filename: scriptPath }
);

const difference = context.__calculateGoalsDifference(
    { xantaken: 172, refills: 91, totalstats: 510000000 },
    { xantaken: 100, refills: 64, totalstats: 400000000 }
);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(difference)),
    { xanax: 72, refills: 27, battleStats: 110000000 }
);

const clamped = context.__calculateGoalsDifference(
    { xantaken: 9, refills: 4, totalstats: 90 },
    { xantaken: 10, refills: 5, totalstats: 100 }
);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(clamped)),
    { xanax: 0, refills: 0, battleStats: 0 }
);

console.log('Qwantum Bookie monthly goals tests passed.');
