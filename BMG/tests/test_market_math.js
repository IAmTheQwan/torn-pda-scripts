const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scriptPath = path.resolve(__dirname, '..', 'userscripts', 'bmg-capture.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const context = {
    __BMG_TEST_MODE__: true,
    location: { hostname: '127.0.0.1', pathname: '/page.php', search: '?sid=bookie' },
    document: {
        documentElement: { dataset: { bmgTestFixture: 'true' } },
        readyState: 'loading',
        addEventListener() {}
    },
    URLSearchParams,
    console
};
vm.runInNewContext(source, context, { filename: scriptPath });
const { analyzeEventMarketMath } = context.__BMG_TEST_EXPORTS__;

function selection(name, odds, { line = null, handicap = null } = {}) {
    return {
        name,
        selection_key: `${name}|${line}|${handicap}`,
        line,
        handicap,
        odds_decimal: odds,
        suspended: false,
        available: true
    };
}

function market(name, marketType, selections) {
    return {
        name,
        market_key: name,
        market_type: marketType,
        period: 'Ordinary time',
        captured_as_complete: true,
        selections
    };
}

function event(markets) {
    return {
        home_team: 'FK TransINVEST',
        away_team: 'FA Siauliai',
        captured_as_complete: true,
        additional_markets_remaining: 0,
        markets
    };
}

const photographed = analyzeEventMarketMath(event([
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

assert.strictEqual(photographed.guaranteed_money, null);
assert.strictEqual(photographed.alerts.filter(alert => alert.code === 'EQUIV').length, 2);
assert.strictEqual(photographed.alerts.some(alert => alert.code === 'ARB'), false);

const guaranteed = analyzeEventMarketMath(event([
    market('Both Teams to Score Ordinary time', 'both_teams_to_score', [
        selection('Yes', 2.1),
        selection('No', 2.1)
    ])
]));

assert.strictEqual(guaranteed.status, 'guaranteed_candidate');
assert.strictEqual(guaranteed.guaranteed_money.source, 'complete_market');
assert(Math.abs(guaranteed.guaranteed_money.minimum_profit_rate - 0.05) < 1e-9);
assert.strictEqual(guaranteed.alerts.some(alert => alert.code === 'ARB'), true);

const brokenLadder = analyzeEventMarketMath(event([
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
console.log('BMG market math tests passed.');
