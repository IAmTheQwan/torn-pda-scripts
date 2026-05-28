// ==UserScript==
// @name         Torn PDA Bookie Panel
// @version      1.2.3
// @description  Floating PDA panel for Torn bookie open bets, daily totals, net, and batch tracking
// @author       TheQwan
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      toqggxqintcityrvfxuc.supabase.co
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/Bookie/qwantum-bookie.meta.js
// @downloadURL  https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/Bookie/qwantum-bookie.user.js
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

    let batches = JSON.parse(localStorage.getItem('tbp_batches') || '[]');
    let selectedBatchId = localStorage.getItem('tbp_selected_batch_id') || '';

    let rawLogs = [];
    let openBets = [];
    let dailyTotals = [];
    let todaySummary = { bets: 0, wins: 0, losses: 0, refunds: 0, won: 0, lost: 0, net: 0 };
    let overallBookieNet = 0;
    let lastLoadStatus = 'Not loaded yet.';

    const MAX_REASONABLE_OPEN_STAKE = 50000000;
    const MAX_CLUSTER_GAP_SECONDS = 8 * 60 * 60;

    const SUPABASE_URL = "https://toqggxqintcityrvfxuc.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_WunM8ONFcASsy57QkrD1_w_YTl_wFx-";

    const styles = `
        #tbp-container { position:fixed; top:20px; right:20px; width:390px; background:#1a1a1a; color:#eee; border:1px solid #444; z-index:999999!important; font-family:'Segoe UI',sans-serif; border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,.8); overflow:hidden; }
        #tbp-container.minimized { width:38px; height:38px; cursor:pointer; display:flex; align-items:center; justify-content:center; background:#007bff; border:1px solid #0056b3; border-radius:4px; font-weight:bold; font-size:20px; }
        .tbp-header { background:#252525; padding:10px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; }
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
    `;

    const styleSheet = document.createElement('style');
    styleSheet.innerText = styles;
    document.head.appendChild(styleSheet);

    const container = document.createElement('div');
    container.id = 'tbp-container';
    document.body.appendChild(container);

    function saveData() {
        localStorage.setItem('tbp_api_key', apiKey);
        localStorage.setItem('tbp_scan_mode', scanMode);
        localStorage.setItem('tbp_scan_start_date', scanStartDate);
        localStorage.setItem('tbp_max_pages', maxPages);
        localStorage.setItem('tbp_active_tab', activeTab);
        localStorage.setItem('tbp_minimized', JSON.stringify(isMinimized));
        localStorage.setItem('tbp_show_debug', JSON.stringify(showDebug));
        localStorage.setItem('tbp_batches', JSON.stringify(batches));
        localStorage.setItem('tbp_selected_batch_id', selectedBatchId);
    }

    function money(n) {
        return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    }

    function num(n) {
        return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

function supabaseUpsert(table, rows, onConflict) {
    if (!rows || rows.length === 0) return Promise.resolve(true);

    return new Promise(resolve => {
        GM_xmlhttpRequest({
            method: "POST",
            url: `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
            headers: {
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal"
            },
            data: JSON.stringify(rows),
            onload: res => {
                if (res.status < 200 || res.status >= 300) {
                    console.error("SUPABASE UPSERT FAILED", {
                        table,
                        status: res.status,
                        response: res.responseText,
                        sampleRow: rows[0]
                    });
                    alert(`Supabase upload failed for ${table}. Status ${res.status}. Check console.`);
                    resolve(false);
                    return;
                }

                console.log(`Supabase upsert OK: ${table}`, rows.length);
                resolve(true);
            },
            onerror: err => {
                console.error("SUPABASE NETWORK ERROR", err);
                alert(`Supabase network error for ${table}. Check console.`);
                resolve(false);
            }
        });
    });
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

        const settledKeysSeenNewer = new Set();
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
                if (key) settledKeysSeenNewer.add(key);
                if (clusterStarted) lastClusterTimestamp = log.timestamp;
                continue;
            }

            if (type !== 'placed') continue;

            const bet = getBetAmount(log);
            const odds = getOdds(log);

            if (!key) continue;
            if (!bet || bet <= 0) continue;
            if (!odds || odds <= 1) continue;
            if (bet > MAX_REASONABLE_OPEN_STAKE) continue;
            if (settledKeysSeenNewer.has(key)) continue;

            const uniqueId = `${log.id}|${key}|${bet}|${odds}|${log.timestamp}`;
            if (seenOpenIds.has(uniqueId)) continue;
            seenOpenIds.add(uniqueId);

            clusterStarted = true;
            lastClusterTimestamp = log.timestamp;

            foundOpen.push({
                id: log.id,
                timestamp: log.timestamp,
                key,
                stake: bet,
                odds,
                potentialProfit: odds > 0 ? bet * (odds - 1) : 0,
                potentialReturn: odds > 0 ? bet * odds : 0,
                selection: key
            });
        }

        openBets = foundOpen.sort((a, b) => b.timestamp - a.timestamp);
    }

    async function pushBetLogsToSupabase() {
    const rows = rawLogs
        .map(log => {
            const type = classifyLog(log);
            if (type === "other" || type === "deposit" || type === "withdraw") return null;

            const key = getSelectionKey(log);
            const parts = key ? key.split("/") : [];

            const stake = getBetAmount(log);
            const odds = getOdds(log);
            const winnings = getWinnings(log);

            let net = 0;
            if (type === "win") net = (winnings || stake) - stake;
            if (type === "loss") net = -stake;

            return {
                log_id: String(log.id),
                timestamp_unix: log.timestamp,
                log_type: type,
                event_id: parts[0] || null,
                outcome_id: parts[1] || null,
                betting_offer_id: parts[2] || null,
                stake,
                odds,
                winnings,
                net,
                raw_json: log.raw
            };
        })
        .filter(Boolean);

    console.log("Bookie rows prepared for Supabase:", rows.length);

    const chunkSize = 250;

    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const ok = await supabaseUpsert("bookie_bet_logs", chunk, "log_id");

        if (!ok) {
            console.error("Stopped upload at chunk", i, chunk);
            return false;
        }
    }

    console.log("Bookie bet log upload complete:", rows.length);
    return true;
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
                            resolve({ error: data.error.error || data.error.code, logs: [] });
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

    async function fetchLogs() {
        if (!apiKey) return false;

        const from = getScanFromUnix();
        const pageLimit = scanMode === 'date' ? 999 : maxPages;
        const seen = new Set();
        const all = [];
        let to = null;

        for (let page = 1; page <= pageLimit; page++) {
            const result = await requestLogPage(from, to);

            if (result.error) {
                alert(`Torn API Error: ${result.error}`);
                return false;
            }

            const pageLogs = result.logs
                .filter(l => scanMode === 'pages' || l.timestamp >= from)
                .sort((a, b) => b.timestamp - a.timestamp);

            let added = 0;

            pageLogs.forEach(log => {
                if (!seen.has(log.id)) {
                    seen.add(log.id);
                    all.push(log);
                    added++;
                }
            });

            if (pageLogs.length === 0 || added === 0) break;

            const oldest = Math.min(...pageLogs.map(l => l.timestamp));

            if (scanMode !== 'pages' && (!oldest || oldest <= from)) break;

            to = oldest - 1;
        }

        rawLogs = all.sort((a, b) => b.timestamp - a.timestamp);
        buildBookieData();
        await pushBetLogsToSupabase();

        const oldest = rawLogs.length ? Math.min(...rawLogs.map(l => l.timestamp)) : 0;
        const newest = rawLogs.length ? Math.max(...rawLogs.map(l => l.timestamp)) : 0;

        lastLoadStatus = `${rawLogs.length} logs loaded. Range: ${formatDate(oldest)} to ${formatDate(newest)}.`;

        return true;
    }

    function render() {
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
                <strong>Bookie Panel</strong>
                <button class="tbp-btn" id="tbp-hide-btn" style="background:transparent; color:#888;">_</button>
            </div>

            <div class="tbp-tabs">
                <div class="tbp-tab ${activeTab === 'open' ? 'active' : ''}" data-tab="open">Open</div>
                <div class="tbp-tab ${activeTab === 'today' ? 'active' : ''}" data-tab="today">Today</div>
                <div class="tbp-tab ${activeTab === 'daily' ? 'active' : ''}" data-tab="daily">Daily</div>
                <div class="tbp-tab ${activeTab === 'batch' ? 'active' : ''}" data-tab="batch">Batch</div>
                ${showDebug ? `<div class="tbp-tab ${activeTab === 'debug' ? 'active' : ''}" data-tab="debug">Debug</div>` : ''}
                <div class="tbp-tab ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</div>
            </div>

            <div class="tbp-content" id="tbp-body"></div>

            <div style="padding:10px; border-top:1px solid #333;">
                <button class="tbp-btn tbp-btn-primary" id="tbp-refresh-btn" style="width:100%;">Refresh Bookie Data</button>
            </div>
        `;

        const body = document.getElementById('tbp-body');

        if (activeTab === 'open') renderOpen(body);
        if (activeTab === 'today') renderToday(body);
        if (activeTab === 'daily') renderDaily(body);
        if (activeTab === 'batch') renderBatch(body);
        if (activeTab === 'debug') renderDebug(body);
        if (activeTab === 'settings') renderSettings(body);

        attachEvents();
    }

    function renderOpen(body) {
        const totalStake = openBets.reduce((s, b) => s + b.stake, 0);
        const totalProfit = openBets.reduce((s, b) => s + b.potentialProfit, 0);
        const totalReturn = openBets.reduce((s, b) => s + b.potentialReturn, 0);

        body.innerHTML = `
            <div class="tbp-muted" style="margin-bottom:8px;">${lastLoadStatus}</div>
            <div class="tbp-summary-grid">
                <div class="tbp-summary-box"><div class="tbp-summary-label">Open Bets</div><div class="tbp-summary-value">${openBets.length}</div></div>
                <div class="tbp-summary-box"><div class="tbp-summary-label">Stake</div><div class="tbp-summary-value">${money(totalStake)}</div></div>
                <div class="tbp-summary-box"><div class="tbp-summary-label">Profit</div><div class="tbp-summary-value tbp-win">${money(totalProfit)}</div></div>
                <div class="tbp-summary-box"><div class="tbp-summary-label">Return</div><div class="tbp-summary-value tbp-blue">${money(totalReturn)}</div></div>
            </div>
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
            row.innerHTML = `
                <div style="font-weight:bold; font-size:12px;">Selection</div>
                <div class="tbp-muted">${b.selection}</div>
                <div class="tbp-row"><span>Date</span><span>${formatDate(b.timestamp)}</span></div>
                <div class="tbp-row"><span>Stake</span><span>${money(b.stake)}</span></div>
                <div class="tbp-row"><span>Odds</span><span>x${num(b.odds)}</span></div>
                <div class="tbp-row"><span>Potential Profit</span><span class="tbp-win">${money(b.potentialProfit)}</span></div>
                <div class="tbp-row"><span>Potential Return</span><span class="tbp-blue">${money(b.potentialReturn)}</span></div>
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
        body.innerHTML = `
            <label class="tbp-muted">API KEY</label>
            <input type="password" id="tbp-api-key" class="tbp-input" value="${apiKey}" placeholder="Paste Torn API key">

            <label class="tbp-muted">SCAN MODE</label>
            <select id="tbp-scan-mode" class="tbp-select">
                <option value="both" ${scanMode === 'both' ? 'selected' : ''}>Date + Page Limit</option>
                <option value="date" ${scanMode === 'date' ? 'selected' : ''}>Date Only</option>
                <option value="pages" ${scanMode === 'pages' ? 'selected' : ''}>Page Limit Only</option>
            </select>

            <label class="tbp-muted">SCAN FROM DATE</label>
            <input type="date" id="tbp-scan-start-date" class="tbp-input" value="${scanStartDate}">

            <label class="tbp-muted">MAX API PAGES TO LOAD</label>
            <input type="number" id="tbp-max-pages" class="tbp-input" value="${maxPages}" min="1" max="999">

            <div class="tbp-card">
                <div class="tbp-muted">
                    Date + Page Limit uses both and stops when either limit is reached.
                    Date Only ignores max pages.
                    Page Limit Only ignores the scan date.
                </div>
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

    function attachEvents() {
        document.querySelectorAll('.tbp-tab').forEach(tab => {
            tab.onclick = () => {
                activeTab = tab.dataset.tab;
                saveData();
                render();
            };
        });

        document.getElementById('tbp-hide-btn').onclick = e => {
            e.stopPropagation();
            isMinimized = true;
            saveData();
            render();
        };

        document.getElementById('tbp-refresh-btn').onclick = async () => {
            const btn = document.getElementById('tbp-refresh-btn');
            btn.innerText = 'Loading pages...';
            btn.disabled = true;
            await fetchLogs();
            btn.disabled = false;
            btn.innerText = 'Refresh Bookie Data';
            render();
        };

        const saveSettingsBtn = document.getElementById('tbp-save-settings');
        if (saveSettingsBtn) {
            saveSettingsBtn.onclick = () => {
                apiKey = document.getElementById('tbp-api-key').value.trim();
                scanMode = document.getElementById('tbp-scan-mode').value;
                scanStartDate = document.getElementById('tbp-scan-start-date').value || defaultScanStartDate();
                maxPages = Number(document.getElementById('tbp-max-pages').value || 20);
                showDebug = document.getElementById('tbp-show-debug').checked;
                saveData();
                render();
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

    render();

    if (apiKey) fetchLogs().then(render);

// Auto-refresh disabled to avoid Torn API rate limits.
// Use the Refresh Bookie Data button manually.

})();
