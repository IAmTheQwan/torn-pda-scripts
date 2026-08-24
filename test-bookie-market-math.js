const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scriptPath = path.resolve(__dirname, 'qwantum-bookie.source.js');
const source = fs.readFileSync(scriptPath, 'utf8');
assert(source.includes("const GUIDED_FOOTBALL_LOAD_TIMEOUT_MS = 12000;"));
assert(source.includes("id=\"tbp-football-guide-loading\""));
assert(source.includes('reviewBtn.disabled = loading || complete;'));
assert(source.includes('finishGuidedFootballLoading(href);'));
const start = source.indexOf('    function footballMathCleanText');
const end = source.indexOf('    function analyzeFootballMarketMath(item', start);
assert(start >= 0 && end > start, 'Could not locate the pure football market-math functions.');

const context = {
    FOOTBALL_EQUIVALENT_ODDS_GAP: 0.01,
    FOOTBALL_LOGIC_ODDS_GAP: 0.02,
    FOOTBALL_IDENTITY_PROBABILITY_GAP: 0.04,
    FOOTBALL_NEAR_ARBITRAGE_SUM: 1.01,
    console
};
vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__marketMath = { analyzeFootballMarketEvent };`,
    context,
    { filename: scriptPath }
);
const { analyzeFootballMarketEvent } = context.__marketMath;

function selection(name, odds, { line = null, handicap = null } = {}) {
    return {
        name,
        selectionKey: `${name}|${line}|${handicap}`,
        line,
        handicap,
        oddsDecimal: odds,
        suspended: false,
        available: true
    };
}

function market(name, marketType, selections) {
    return {
        name,
        marketKey: name,
        marketType,
        period: 'Ordinary time',
        capturedAsComplete: true,
        selections
    };
}

function event(markets) {
    return {
        homeTeam: 'FK TransINVEST',
        awayTeam: 'FA Siauliai',
        capturedAsComplete: true,
        additionalMarketsRemaining: 0,
        markets
    };
}

const photographed = analyzeFootballMarketEvent(event([
    market('3-Way Ordinary time', 'three_way', [
        selection('FK TransINVEST', 1.55),
        selection('Draw', 3.8),
        selection('FA Siauliai', 5.0)
    ]),
    market('Double Chance Ordinary time', 'double_chance', [
        selection('FK TransINVEST or Draw', 1.14),
        selection('FK TransINVEST or FA Siauliai', 1.22),
        selection('FA Siauliai or Draw', 2.29)
    ]),
    market('Asian Handicap 0.5 Ordinary time', 'asian_handicap', [
        selection('FK TransINVEST', 1.57, { handicap: -0.5 }),
        selection('FA Siauliai', 2.25, { handicap: 0.5 })
    ]),
    market('Both Teams to Score Ordinary time', 'both_teams_to_score', [
        selection('Yes', 1.62),
        selection('No', 2.15)
    ])
]));

assert.strictEqual(photographed.guaranteedMoney, null);
assert.strictEqual(photographed.alerts.filter(alert => alert.code === 'EQUIV').length, 2);
assert.strictEqual(photographed.alerts.some(alert => alert.code === 'ARB'), false);

const guaranteed = analyzeFootballMarketEvent(event([
    market('Both Teams to Score Ordinary time', 'both_teams_to_score', [
        selection('Yes', 2.1),
        selection('No', 2.1)
    ])
]));

assert.strictEqual(guaranteed.status, 'guaranteed_candidate');
assert.strictEqual(guaranteed.guaranteedMoney.source, 'complete_market');
assert(Math.abs(guaranteed.guaranteedMoney.minimumProfitRate - 0.05) < 1e-9);
assert.strictEqual(guaranteed.alerts.some(alert => alert.code === 'ARB'), true);

const complement = analyzeFootballMarketEvent(event([
    market('3-Way Ordinary time', 'three_way', [
        selection('FK TransINVEST', 2.2),
        selection('Draw', 3.0),
        selection('FA Siauliai', 3.2)
    ]),
    market('Double Chance Ordinary time', 'double_chance', [
        selection('FA Siauliai or Draw', 2.0),
        selection('FK TransINVEST or Draw', 1.5),
        selection('FK TransINVEST or FA Siauliai', 1.4)
    ])
]));

assert.strictEqual(complement.guaranteedMoney.label, 'Home / not-home');
assert.strictEqual(complement.guaranteedMoney.source, 'equivalent_complements');

const brokenLadder = analyzeFootballMarketEvent(event([
    market('Over/Under 1.5 Total Goals Ordinary time', 'total', [
        selection('Over 1.5 Total Goals', 2.0, { line: 1.5 }),
        selection('Under 1.5 Total Goals', 2.0, { line: 1.5 })
    ]),
    market('Over/Under 2.5 Total Goals Ordinary time', 'total', [
        selection('Over 2.5 Total Goals', 1.5, { line: 2.5 }),
        selection('Under 2.5 Total Goals', 3.0, { line: 2.5 })
    ])
]));

assert.strictEqual(brokenLadder.alerts.some(alert => alert.code === 'LADDER'), true);
console.log('Qwantum Bookie market math tests passed.');
