// ==UserScript==
// @name         BMG Visible Bookie Capture
// @namespace    https://github.com/IAmTheQwan/torn-pda-scripts
// @version      0.1.0
// @description  Manually capture already-loaded Torn Bookie odds and My Bets outcomes for local BMG analysis
// @author       TheQwan
// @match        https://www.torn.com/page.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CAPTURE_SCHEMA = 'bmg.capture.v1';
    const DB_NAME = 'bmg_capture_outbox';
    const DB_VERSION = 1;
    const STORE_NAME = 'captures';
    const PANEL_ID = 'bmg-capture-panel';

    function isBookiePage() {
        try {
            if (location.hostname === '127.0.0.1'
                && document.documentElement.dataset.bmgTestFixture === 'true') return true;
            return location.pathname === '/page.php'
                && new URLSearchParams(location.search).get('sid') === 'bookie';
        } catch {
            return false;
        }
    }

    if (!isBookiePage()) return;

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function canonical(value) {
        return cleanText(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    function simpleHash(value) {
        let hash = 2166136261;
        for (const character of String(value || '')) {
            hash ^= character.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function newId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }

    function safePageUrl() {
        return `${location.origin}${location.pathname}?sid=bookie`;
    }

    function openOutbox() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'capture_id' });
                    store.createIndex('observed_at', 'observed_at', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function putCapture(capture) {
        const db = await openOutbox();
        try {
            await new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(capture);
                request.onsuccess = resolve;
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    }

    async function getCaptures() {
        const db = await openOutbox();
        try {
            return await new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
                request.onsuccess = () => resolve(request.result.sort((a, b) => a.observed_at.localeCompare(b.observed_at)));
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    }

    function parseScheduledAt(stateTitle) {
        const match = cleanText(stateTitle).match(
            /Due to start at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+-\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+TCT/i
        );
        if (!match) return '';
        return new Date(Date.UTC(
            Number(match[6]),
            Number(match[5]) - 1,
            Number(match[4]),
            Number(match[1]),
            Number(match[2]),
            Number(match[3] || 0)
        )).toISOString();
    }

    function parseFixtureTitle(value) {
        const title = cleanText(value);
        const versus = title.match(/\s+v\s+/i);
        if (!versus || versus.index === undefined) {
            return { title, home_team: '', away_team: '', league: '', participants: [] };
        }
        const home = title.slice(0, versus.index).trim();
        const remainder = title.slice(versus.index + versus[0].length).trim();
        const leagueIndex = remainder.lastIndexOf(' - ');
        const away = (leagueIndex >= 0 ? remainder.slice(0, leagueIndex) : remainder).trim();
        const league = (leagueIndex >= 0 ? remainder.slice(leagueIndex + 3) : '').trim();
        return { title, home_team: home, away_team: away, league, participants: [home, away].filter(Boolean) };
    }

    function routeDetails(card) {
        const hrefs = [
            card.classList.contains('active') ? location.hash : '',
            card.querySelector('a[href*="#/"]')?.getAttribute('href') || ''
        ];
        for (const href of hrefs) {
            const match = String(href).match(/#\/([^/]+)\/([^/?#]+)/i);
            if (match) return { sport: canonical(match[1]) || 'unknown', source_event_id: match[2], href };
        }
        const sport = canonical(card.querySelector('li.game')?.getAttribute('title')) || 'unknown';
        return { sport, source_event_id: '', href: '' };
    }

    function classifyMarket(name) {
        const value = canonical(name);
        if (/\b3 way\b/.test(value)) return 'three_way';
        if (/asian handicap/.test(value)) return 'asian_handicap';
        if (/handicap|spread/.test(value)) return 'spread';
        if (/over under|total goals|total points|total games|total sets/.test(value)) return 'total';
        if (/both teams.*score/.test(value)) return 'both_teams_to_score';
        if (/correct score/.test(value)) return 'correct_score';
        if (/moneyline|match winner|to win|winner/.test(value)) return 'moneyline';
        return 'other';
    }

    function marketPeriod(name) {
        const value = cleanText(name);
        return value.match(/\b(ordinary time|full time|full match|first half|second half|first period|second period|third period|first set|second set|third set)\b/i)?.[1] || '';
    }

    function parseOdds(value) {
        const match = cleanText(value).match(/x\s*([\d]+(?:[.,]\d+)?)/i);
        return match ? Number(match[1].replace(',', '.')) : 0;
    }

    function parseSelection(row, marketType) {
        const rawName = cleanText(row.querySelector('.bet-cell.result')?.textContent);
        const handicapMatch = rawName.match(/\(\s*([+-]?\d+(?:[.,]\d+)?)\s*\)\s*$/);
        const name = rawName.replace(/\s*\(\s*[+-]?\d+(?:[.,]\d+)?\s*\)\s*$/, '').trim();
        const lineMatch = /^(?:total|spread|asian_handicap)$/.test(marketType)
            ? rawName.match(/(?:over|under|[+-])\s*([+-]?\d+(?:[.,]\d+)?)/i)
            : null;
        const amount = row.querySelector('input.amount');
        const suspended = row.classList.contains('disabled')
            || row.querySelector('.input-money-group')?.classList.contains('disabled')
            || /suspended/i.test(String(amount?.value || ''));
        const odds = parseOdds(row.querySelector('.bet-cell.odds.decimal')?.textContent);
        const handicap = handicapMatch ? Number(handicapMatch[1].replace(',', '.')) : null;
        const line = lineMatch ? Number(lineMatch[1].replace(',', '.')) : null;
        return {
            selection_key: `${canonical(name)}|h:${handicap ?? ''}|l:${line ?? ''}`,
            name,
            raw_name: rawName,
            handicap,
            line,
            odds_decimal: odds || null,
            suspended,
            available: Boolean(odds) && !suspended
        };
    }

    function parseMarket(wrap, index) {
        const name = cleanText(wrap.querySelector('.market-name-cell .bold')?.textContent)
            || cleanText(wrap.querySelector('.market-name-cell')?.textContent)
            || `Unknown market ${index + 1}`;
        const type = classifyMarket(name);
        const rows = Array.from(wrap.querySelectorAll(':scope > li.bets')).filter(row => {
            return row.querySelector('.bet-cell.result') && row.querySelector('.bet-cell.odds.decimal');
        });
        return {
            market_key: `${canonical(name)}|${canonical(marketPeriod(name))}`,
            name,
            market_type: type,
            period: marketPeriod(name),
            captured_as_complete: rows.length > 0,
            selections: rows.map(row => parseSelection(row, type)).filter(selection => selection.name)
        };
    }

    function parseOutcome(card, stateText) {
        const scoreElement = card.querySelector('.score-wrap, .scores, .match-score, .result-score');
        const rawScore = cleanText(scoreElement?.textContent);
        const score = rawScore.match(/(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)/);
        const status = cleanText(stateText);
        if (!status && !rawScore) return null;
        return {
            status,
            home_score: score ? Number(score[1]) : null,
            away_score: score ? Number(score[2]) : null,
            winner: score && Number(score[1]) !== Number(score[2])
                ? (Number(score[1]) > Number(score[2]) ? 'home' : 'away')
                : score ? 'draw' : '',
            raw_score: rawScore
        };
    }

    function parseEventCard(card) {
        const route = routeDetails(card);
        const matchElement = card.querySelector('.matchName p, .pop-game .name p')
            || card.querySelector('.matchName, .team-names');
        const titleValue = matchElement?.getAttribute('title') || matchElement?.textContent || '';
        const fixture = parseFixtureTitle(titleValue);
        const state = card.querySelector('.state-wrap .state');
        const stateTitle = cleanText(state?.getAttribute('title'));
        const stateText = cleanText(state?.textContent || stateTitle);
        const markets = Array.from(card.querySelectorAll('.info-wrap ul.bets-wrap'))
            .map(parseMarket)
            .filter(market => market.selections.length);
        return {
            source_event_id: route.source_event_id,
            sport: route.sport,
            title: fixture.title,
            league: fixture.league,
            home_team: fixture.home_team,
            away_team: fixture.away_team,
            participants: fixture.participants,
            scheduled_at: parseScheduledAt(stateTitle),
            visible_status: stateText,
            raw_state_text: stateTitle,
            route_href: route.href,
            outcome: parseOutcome(card, stateText),
            markets
        };
    }

    function expandedEventCards() {
        return Array.from(document.querySelectorAll('li.c-pointer')).filter(card => {
            const info = card.querySelector('.info-wrap');
            if (!info || !card.querySelector('.matchName p, .pop-game .name p, .matchName, .team-names')) return false;
            const hasLoadedMarkets = Boolean(info.querySelector('ul.bets-wrap li.bets'));
            const expanded = card.classList.contains('active')
                || (info.style.display !== 'none' && getComputedStyle(info).display !== 'none');
            return hasLoadedMarkets && expanded;
        });
    }

    function titleValuesForMyBet(link) {
        const row = link.closest('li') || link.parentElement || link;
        const values = [];
        row.querySelectorAll('.stick .text, .stick [title], [title], [aria-label]').forEach(element => {
            [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent].forEach(value => {
                const preserved = String(value || '').replace(/\r/g, '').trim();
                if (preserved && /^(?:Pending|Won|Lost|Refunded)\b/i.test(preserved)) values.push(preserved);
            });
        });
        return [...new Set(values)];
    }

    function fixtureForMyBet(link) {
        const row = link.closest('li') || link.parentElement || link;
        const candidates = [
            row.querySelector('.matchName p, .pop-game .name p')
                || row.querySelector('.matchName, .team-names'),
            ...row.querySelectorAll('[title]')
        ].filter(Boolean);
        for (const candidate of candidates) {
            for (const value of [candidate.getAttribute?.('title'), candidate.getAttribute?.('aria-label'), candidate.textContent]) {
                const fixture = parseFixtureTitle(value);
                if (fixture.home_team && fixture.away_team) return fixture;
            }
        }
        return parseFixtureTitle('Unknown Torn Bookie event');
    }

    function parseMyBetPart(value) {
        const title = cleanText(value);
        let match = title.match(/^Pending\s+\$([\d,]+).*?\(x([\d.]+)\)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
        if (match) {
            return { status: 'pending', stake: Number(match[1].replace(/,/g, '')), odds_decimal: Number(match[2]), selection_name: match[3], market_name: match[4], payout: null, profit: null, raw_text: title };
        }
        match = title.match(/^Won\s+\$([\d,]+)\s+\(x([\d.]+)\)\s+from a\s+\$([\d,]+)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
        if (match) {
            const profit = Number(match[1].replace(/,/g, ''));
            const stake = Number(match[3].replace(/,/g, ''));
            return { status: 'win', stake, odds_decimal: Number(match[2]), selection_name: match[4], market_name: match[5], payout: stake + profit, profit, raw_text: title };
        }
        match = title.match(/^Lost\s+\$([\d,]+)\s+\(x([\d.]+)\)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
        if (match) {
            const stake = Number(match[1].replace(/,/g, ''));
            return { status: 'loss', stake, odds_decimal: Number(match[2]), selection_name: match[3], market_name: match[4], payout: 0, profit: -stake, raw_text: title };
        }
        match = title.match(/^Refunded\s+\$([\d,]+)\s+\(x([\d.]+)\)\s+bet on\s+(.+?)\s+\((.+)\)$/i);
        if (match) {
            const stake = Number(match[1].replace(/,/g, ''));
            return { status: 'refund', stake, odds_decimal: Number(match[2]), selection_name: match[3], market_name: match[4], payout: stake, profit: 0, raw_text: title };
        }
        return null;
    }

    function parseMyBets() {
        const links = Array.from(document.querySelectorAll('a[href*="#/your-bets/"]'));
        const occurrences = new Map();
        const bets = [];
        links.forEach(link => {
            const gameId = String(link.getAttribute('href') || '').match(/#\/your-bets\/([^/?#]+)/i)?.[1] || '';
            if (!gameId) return;
            const fixture = fixtureForMyBet(link);
            titleValuesForMyBet(link).forEach(value => {
                String(value).replace(/<br\s*\/?>/gi, '\n').split(/\n(?=(?:Pending|Won|Lost|Refunded)\s)/i).forEach(part => {
                    const bet = parseMyBetPart(part);
                    if (!bet) return;
                    const base = [gameId, canonical(bet.market_name), canonical(bet.selection_name), bet.stake, bet.odds_decimal].join('|');
                    const occurrence = Number(occurrences.get(base) || 0);
                    occurrences.set(base, occurrence + 1);
                    bets.push({
                        ...bet,
                        external_bet_id: `torn-mybets:${simpleHash(`${base}|${occurrence}`)}`,
                        source_event_id: gameId,
                        event_title: fixture.title,
                        league: fixture.league,
                        home_team: fixture.home_team,
                        away_team: fixture.away_team,
                        sport: canonical(link.closest('li')?.querySelector('li.game')?.getAttribute('title')) || 'unknown',
                        market_type: classifyMarket(bet.market_name),
                        period: marketPeriod(bet.market_name)
                    });
                });
            });
        });
        return bets;
    }

    function buildCapture() {
        if (document.visibilityState !== 'visible') {
            throw new Error('Bring Torn Bookie to the foreground before capturing.');
        }
        if (!isBookiePage()) throw new Error('Open Torn Bookie first.');
        const onMyBets = /^#\/your-bets(?:\/|$)/i.test(location.hash);
        const events = onMyBets ? [] : expandedEventCards().map(parseEventCard).filter(event => event.title && event.markets.length);
        const bets = onMyBets ? parseMyBets() : [];
        if (!events.length && !bets.length) {
            throw new Error(onMyBets
                ? 'No visible Pending/Won/Lost/Refunded My Bets rows were found.'
                : 'Manually expand a game (and any desired markets), then capture again.');
        }
        return {
            schema_version: CAPTURE_SCHEMA,
            capture_id: newId(),
            observed_at: new Date().toISOString(),
            source: onMyBets ? 'torn-visible-mybets-dom' : 'torn-visible-bookie-dom',
            page_url: safePageUrl(),
            page_hash: location.hash,
            events,
            bets
        };
    }

    function downloadJson(filename, value) {
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copyText(value) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }

    function mountPanel() {
        if (document.getElementById(PANEL_ID) || !document.body) return;
        const panel = document.createElement('section');
        panel.id = PANEL_ID;
        panel.style.cssText = 'position:fixed;right:12px;bottom:12px;width:250px;z-index:999999;background:#171717;color:#eee;border:1px solid #555;border-radius:8px;padding:10px;font:12px Segoe UI,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.75)';
        panel.innerHTML = `
            <div style="font-weight:800;font-size:13px;margin-bottom:5px">BMG Capture v0.1.0</div>
            <div style="color:#bbb;font-size:10px;line-height:1.35;margin-bottom:8px">Manual foreground capture only. Open a game/market yourself; BMG makes no Torn request and places no bet.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
                <button type="button" data-action="capture">Capture expanded</button>
                <button type="button" data-action="export">Export outbox</button>
                <button type="button" data-action="copy">Copy latest</button>
            </div>
            <div data-status style="margin-top:8px;color:#8ecbff;font-size:10px">Ready.</div>
        `;
        panel.querySelectorAll('button').forEach(button => {
            button.style.cssText = 'background:#2d5d7b;color:#fff;border:1px solid #4a8eb8;border-radius:4px;padding:6px;cursor:pointer;font-size:10px';
        });
        const status = panel.querySelector('[data-status]');
        const show = (message, error = false) => {
            status.textContent = message;
            status.style.color = error ? '#ff8b8b' : '#8ecbff';
        };

        panel.querySelector('[data-action="capture"]').addEventListener('click', async () => {
            try {
                const capture = buildCapture();
                await putCapture(capture);
                if (location.hostname === '127.0.0.1'
                    && document.documentElement.dataset.bmgTestFixture === 'true') {
                    panel.dataset.bmgLastCapture = JSON.stringify(capture);
                }
                show(`Saved ${capture.events.length} event(s), ${capture.events.reduce((sum, event) => sum + event.markets.length, 0)} market(s), and ${capture.bets.length} bet row(s).`);
            } catch (error) {
                show(error.message || String(error), true);
            }
        });

        panel.querySelector('[data-action="export"]').addEventListener('click', async () => {
            try {
                if (document.visibilityState !== 'visible') throw new Error('Bring this page to the foreground before exporting.');
                const captures = await getCaptures();
                if (!captures.length) throw new Error('The outbox is empty.');
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                downloadJson(`bmg-captures-${stamp}.json`, {
                    schema_version: 'bmg.export.v1',
                    generated_at: new Date().toISOString(),
                    captures
                });
                show(`Exported ${captures.length} capture(s). Imports are idempotent; the outbox was preserved.`);
            } catch (error) {
                show(error.message || String(error), true);
            }
        });

        panel.querySelector('[data-action="copy"]').addEventListener('click', async () => {
            try {
                const captures = await getCaptures();
                const latest = captures[captures.length - 1];
                if (!latest) throw new Error('The outbox is empty.');
                await copyText(JSON.stringify({ schema_version: 'bmg.export.v1', captures: [latest] }, null, 2));
                show('Copied the latest capture as JSON.');
            } catch (error) {
                show(error.message || String(error), true);
            }
        });

        document.body.appendChild(panel);
        getCaptures()
            .then(captures => show(`Ready. ${captures.length} capture(s) currently in the local outbox.`))
            .catch(error => show(`Outbox error: ${error.message || error}`, true));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
    } else {
        mountPanel();
    }
})();
