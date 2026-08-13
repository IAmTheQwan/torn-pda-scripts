import fs from 'node:fs/promises';
import path from 'node:path';

export async function createBrowserHistoryCapture({
    browser,
    cwd,
    tabIds = ['11', '12'],
    readyPollAttempts = 60,
    archiveDir: suppliedArchiveDir = null,
    summaryFile: suppliedSummaryFile = null
}) {
    const exportsDir = path.join(cwd, 'BMG', 'exports');
    const archiveName = suppliedArchiveDir ? null : (await fs.readdir(exportsDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^history-/i.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .at(-1);
    const archiveDir = suppliedArchiveDir || (archiveName ? path.join(exportsDir, archiveName) : null);
    if (!archiveDir) throw new Error(`No history archive found in ${exportsDir}`);
    const summaryFile = suppliedSummaryFile || (await fs.readdir(archiveDir))
        .filter(name => /^torn-mybets-complete-summary-.*\.json$/i.test(name))
        .sort()
        .at(-1);
    if (!summaryFile) throw new Error(`No complete My Bets summary found in ${archiveDir}`);
    const manifestPath = path.join(archiveDir, 'detail-manifest.json');
    const detailsPath = path.join(archiveDir, 'expanded-events.ndjson');
    const failuresPath = path.join(archiveDir, 'expanded-event-failures.ndjson');
    const summary = JSON.parse(await fs.readFile(path.join(archiveDir, summaryFile), 'utf8'));
    const rows = summary.captures[0].history_rows;
    const rowById = new Map(rows.map(row => [String(row.source_event_id), row]));
    let manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const tabs = await Promise.all(tabIds.map(id => browser.tabs.get(id)));

    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

    async function extract(card, row, meta) {
        return card.evaluate((element, args) => {
            const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim();
            const attributes = node => Object.fromEntries(
                Array.from(node?.attributes || []).map(attribute => [attribute.name, attribute.value])
            );
            const titles = node => [node, ...Array.from(node?.querySelectorAll?.('[title]') || [])]
                .map(item => item?.getAttribute?.('title'))
                .filter(Boolean);
            const markets = Array.from(element.querySelectorAll('.info-wrap ul.bets-wrap'))
                .map((wrap, marketIndex) => {
                    const name = tidy(wrap.querySelector('.market-name-cell .bold')?.innerText)
                        || tidy(wrap.querySelector('.market-name-cell')?.innerText)
                        || `Unknown market ${marketIndex + 1}`;
                    const selections = Array.from(wrap.querySelectorAll(':scope > li.bets'))
                        .filter(bet => bet.querySelector('.bet-cell.result')
                            && bet.querySelector('.bet-cell.odds.decimal'))
                        .map((bet, selectionIndex) => {
                            const rawResult = tidy(bet.querySelector('.bet-cell.result')?.innerText);
                            const decimalCell = bet.querySelector('.bet-cell.odds.decimal');
                            const oddsCells = Array.from(bet.querySelectorAll('.bet-cell.odds'));
                            const fractionalCell = oddsCells.find(cell => !cell.classList.contains('decimal'));
                            const decimalText = tidy(decimalCell?.textContent);
                            const decimalMatch = decimalText.match(/x\s*([\d]+(?:[.,]\d+)?)/i);
                            const oddsDecimal = decimalMatch
                                ? Number(decimalMatch[1].replace(',', '.'))
                                : null;
                            const amount = bet.querySelector('input.amount');
                            const suspended = bet.classList.contains('disabled')
                                || bet.querySelector('.input-money-group')?.classList.contains('disabled')
                                || /suspended/i.test(String(amount?.value || ''));
                            return {
                                attributes: attributes(bet),
                                available: Boolean(oddsDecimal) && !suspended,
                                classes: String(bet.className || ''),
                                name: rawResult.replace(/\s*[+-]\s*\$[\d,.]+\s*[kmb]?\s*$/i, '').trim(),
                                odds_decimal: oddsDecimal,
                                odds_decimal_text: decimalText,
                                odds_fractional_text: tidy(fractionalCell?.textContent),
                                raw_result_text: rawResult,
                                raw_text: tidy(bet.innerText),
                                selection_index: selectionIndex,
                                suspended,
                                titles: titles(bet)
                            };
                        });
                    return {
                        attributes: attributes(wrap),
                        classes: String(wrap.className || ''),
                        market_index: marketIndex + 1,
                        name,
                        raw_text: tidy(wrap.innerText),
                        selection_count: selections.length,
                        selections
                    };
                })
                .filter(market => market.selections.length);
            const match = element.querySelector('.matchName p, .pop-game .name p, .matchName, .team-names');
            const controls = Array.from(element.querySelectorAll('a, button'))
                .map(control => tidy(control.innerText))
                .filter(text => /additional betting options/i.test(text));
            return {
                schema_version: 'bmg.history-event-detail.v1',
                source_event_id: String(args.row.source_event_id),
                row_index: args.row.row_index,
                sport: args.row.sport,
                title: args.row.title,
                league: args.row.league,
                home_team: args.row.home_team,
                away_team: args.row.away_team,
                finished_text: args.row.finished_text,
                settled_at: args.row.settled_at,
                bet_ids: args.row.bet_ids || [],
                additional_options_requested: Boolean(args.meta.additional_options_requested),
                additional_options_label: args.meta.additional_options_label || '',
                market_wraps_before: args.meta.market_wraps_before ?? markets.length,
                market_wraps_after: markets.length,
                elapsed_ms: args.meta.elapsed_ms ?? null,
                additional_controls: controls,
                attributes: attributes(element),
                captured_at: new Date().toISOString(),
                classes: String(element.className || ''),
                display_title: tidy(match?.getAttribute('title') || match?.innerText || args.row.title),
                markets,
                raw_text: tidy(element.innerText),
                titles: titles(element)
            };
        }, { row, meta });
    }

    async function capture(tab, row) {
        const started = Date.now();
        const target = `https://www.torn.com/page.php?sid=bookie#/your-bets/${row.source_event_id}`;
        await tab.goto('about:blank');
        await tab.goto(target);
        const search = tab.playwright.getByRole('textbox', { name: 'search...' }).first();
        await search.waitFor({ state: 'visible', timeoutMs: 15000 });
        await search.fill(`${row.home_team} v ${row.away_team}`, { timeoutMs: 5000 });

        let state = { found: false, markets: 0, blocked: false };
        for (let poll = 0; poll < readyPollAttempts; poll += 1) {
            state = await tab.playwright.evaluate(({ home, away }) => {
                const body = String(document.body?.innerText || '');
                const active = Array.from(document.querySelectorAll('li.c-pointer.active')).find(element => {
                    const text = String(element.innerText || '').toLowerCase();
                    return text.includes(home.toLowerCase()) && text.includes(away.toLowerCase());
                });
                return {
                    found: Boolean(active),
                    markets: active ? active.querySelectorAll('.info-wrap ul.bets-wrap li.bets').length : 0,
                    blocked: /TEMPORARY BLOCK|too many requests/i.test(body)
                };
            }, { home: row.home_team, away: row.away_team }, { timeoutMs: 3000 });
            if (state.blocked) throw new Error('Torn temporary request block');
            if (state.found && state.markets > 0) break;
            await tab.playwright.waitForTimeout(300);
        }
        if (!state.found || !state.markets) {
            throw new Error(`Exact game did not become ready for ${row.source_event_id}`);
        }

        await tab.playwright.waitForTimeout(350);
        const card = tab.playwright.locator('li.c-pointer.active').first();
        const before = await card.locator('.info-wrap ul.bets-wrap', {}).count();
        let requested = false;
        let firstLabel = '';
        for (let pass = 0; pass < 10; pass += 1) {
            const controls = await card.locator('a, button', {})
                .filter({ hasText: /^Show\s+\d+\s+additional betting options$/i })
                .all();
            let control = null;
            for (const candidate of controls) {
                if (await candidate.isVisible()) {
                    control = candidate;
                    break;
                }
            }
            if (!control) break;
            const label = await control.innerText({ timeoutMs: 5000 });
            if (!firstLabel) firstLabel = label;
            requested = true;
            const countBefore = await card.locator('.info-wrap ul.bets-wrap', {}).count();
            await control.click({ timeoutMs: 10000 });
            for (let poll = 0; poll < 40; poll += 1) {
                await tab.playwright.waitForTimeout(250);
                const countAfter = await card.locator('.info-wrap ul.bets-wrap', {}).count();
                if (countAfter > countBefore || !(await control.isVisible())) break;
            }
        }

        const detail = await extract(card, row, {
            additional_options_requested: requested,
            additional_options_label: firstLabel,
            market_wraps_before: before,
            elapsed_ms: Date.now() - started
        });
        const raw = detail.raw_text.toLowerCase();
        if (!detail.markets.length
            || !raw.includes(row.home_team.toLowerCase())
            || !raw.includes(row.away_team.toLowerCase())) {
            throw new Error(`Exact game validation failed for ${row.source_event_id}`);
        }
        return detail;
    }

    async function persist(done, failed) {
        manifest.completed_event_ids = [...done];
        manifest.failed_event_ids = [...failed];
        manifest.updated_at = new Date().toISOString();
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }

    async function retryChunk(limit = 20, { newestFirst = true, skip = 0 } = {}) {
        const startedAt = new Date().toISOString();
        const done = new Set(manifest.completed_event_ids.map(String));
        const failedSet = new Set(manifest.failed_event_ids.map(String));
        let ids = [...failedSet].filter(id => !done.has(id));
        if (newestFirst) ids.reverse();
        ids = ids.slice(skip, skip + limit);
        let attempted = 0;
        let succeeded = 0;
        let failed = 0;
        for (let offset = 0; offset < ids.length; offset += tabs.length) {
            const work = ids.slice(offset, offset + tabs.length).map(id => rowById.get(id)).filter(Boolean);
            attempted += work.length;
            const results = await Promise.allSettled(work.map((row, index) => capture(tabs[index], row)));
            for (let index = 0; index < results.length; index += 1) {
                const result = results[index];
                const row = work[index];
                const id = String(row.source_event_id);
                if (result.status === 'fulfilled') {
                    await fs.appendFile(detailsPath, `${JSON.stringify(result.value)}\n`, 'utf8');
                    done.add(id);
                    failedSet.delete(id);
                    succeeded += 1;
                } else {
                    await fs.appendFile(failuresPath, `${JSON.stringify({
                        captured_at: new Date().toISOString(),
                        source_event_id: id,
                        row_index: row.row_index,
                        fixture: row.title,
                        retry: true,
                        error: String(result.reason?.stack || result.reason)
                    })}\n`, 'utf8');
                    failed += 1;
                }
            }
            await persist(done, failedSet);
            await tabs[0].playwright.waitForTimeout(1500);
        }
        manifest.chunks.push({
            kind: newestFirst ? 'two-tab-exact-retry-newest' : 'two-tab-exact-retry-oldest',
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            attempted,
            succeeded,
            failed,
            retry_remaining: failedSet.size
        });
        await persist(done, failedSet);
        return { attempted, succeeded, failed, completed: done.size, retryRemaining: failedSet.size };
    }

    return {
        get manifest() { return manifest; },
        retryChunk,
        clean
    };
}
