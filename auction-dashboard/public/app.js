const state = {
  selectedItemId: null,
  selectedItemName: "",
  selectedTraitKey: null,
  traitData: null,
  traitsLoaded: false,
  status: null
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const number = new Intl.NumberFormat("en-US");

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindActions();
  refreshStatus();
  refreshOverview();
});

function bindTabs() {
  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => openTab(button.dataset.tab));
  });
}

function openTab(name) {
  document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `tab-${name}`));
  if (name === "current") refreshSnapshots();
  if (name === "traits" && !state.traitsLoaded) refreshTraits();
  if (name === "setup") refreshTokens();
}

function bindActions() {
  document.getElementById("overview-days").addEventListener("change", refreshOverview);
  document.getElementById("overview-volume").addEventListener("change", refreshOverview);
  document.getElementById("trait-days").addEventListener("change", refreshTraits);
  document.getElementById("trait-volume").addEventListener("change", refreshTraits);
  document.getElementById("trait-bonus-count").addEventListener("change", refreshTraits);
  document.getElementById("sync-now").addEventListener("click", runSync);
  document.getElementById("refresh-snapshots").addEventListener("click", refreshSnapshots);
  document.getElementById("refresh-item").addEventListener("click", refreshSelectedItem);
  document.getElementById("item-days").addEventListener("change", refreshSelectedItem);
  document.getElementById("item-search-form").addEventListener("submit", searchItems);
  document.getElementById("token-form").addEventListener("submit", generateToken);
  document.getElementById("copy-token").addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("new-token-value").textContent);
    showNotice("Device token copied.", "success");
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      document.getElementById("health-pill").className = "pill bad";
      document.getElementById("health-pill").textContent = "Access required";
    }
    throw new Error(body.error || `Request failed with ${response.status}.`);
  }
  return body;
}

async function refreshStatus() {
  try {
    const data = await api("/api/status");
    state.status = data;
    const total = Number(data.sales?.total_sales || 0);
    setText("metric-sales", number.format(total));
    setText("metric-items", number.format(Number(data.sales?.item_count || 0)));
    setText("metric-range", total ? `${formatDate(data.sales.oldest_sale)} → ${formatDate(data.sales.newest_sale)}` : "Waiting for the first sync");
    setText("metric-sync", data.sync?.last_run_at ? timeAgo(data.sync.last_run_at) : "Not run");
    const backfillStatus = data.sync?.history_caught_up_at
      ? "All API-available history stored; checking hourly for new sales"
      : total
        ? `Backfilling older sales from ${formatDate(data.sales.oldest_sale)}; progress is saved`
        : "Backfill is resumable";
    setText("metric-sync-detail", data.sync?.last_error || backfillStatus);
    setText("metric-snapshot", data.latestSnapshot ? timeAgo(data.latestSnapshot.captured_at) : "None yet");
    setText("metric-snapshot-detail", data.latestSnapshot ? `${data.latestSnapshot.item_count} listings from foreground capture` : "No foreground capture uploaded");
    document.getElementById("health-pill").className = `pill ${data.sync?.last_error ? "bad" : "good"}`;
    document.getElementById("health-pill").textContent = data.sync?.last_error ? "Sync needs attention" : "Private service online";
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshOverview() {
  const days = document.getElementById("overview-days").value;
  const minSales = document.getElementById("overview-volume").value;
  try {
    const data = await api(`/api/overview?days=${days}&minSales=${minSales}`);
    renderRankList("rising-list", data.rising, "change");
    renderRankList("falling-list", data.falling, "change");
    renderRankList("lower-list", data.lowerPriced, "price");
    renderRankList("higher-list", data.higherPriced, "price");
  } catch (error) {
    ["rising-list", "falling-list", "lower-list", "higher-list"].forEach(id => {
      document.getElementById(id).innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    });
  }
}

async function refreshTraits() {
  const days = document.getElementById("trait-days").value;
  const minSales = document.getElementById("trait-volume").value;
  const bonusCount = document.getElementById("trait-bonus-count").value;
  const listIds = ["trait-high-list", "trait-low-list", "trait-rising-list", "trait-falling-list"];
  listIds.forEach(id => { document.getElementById(id).innerHTML = '<div class="empty">Analyzing like-for-like sales…</div>'; });
  document.getElementById("trait-table").innerHTML = '<tr><td colspan="7" class="empty">Loading trait intelligence…</td></tr>';
  document.getElementById("trait-pair-table").innerHTML = '<tr><td colspan="6" class="empty">Loading combinations…</td></tr>';

  try {
    const data = await api(`/api/traits?days=${days}&minSales=${minSales}&bonusCount=${bonusCount}`);
    state.traitData = data;
    state.traitsLoaded = true;
    renderTraitStats(data);
    renderTraitRankList("trait-high-list", data.valuable, "premium");
    renderTraitRankList("trait-low-list", data.discounted, "premium");
    renderTraitRankList("trait-rising-list", data.rising, "trend");
    renderTraitRankList("trait-falling-list", data.falling, "trend");
    renderTraitTable(data);
    renderTraitPairs(data);
    if (state.selectedTraitKey) {
      const selected = data.traits.find(row => row.key === state.selectedTraitKey);
      if (selected) renderTraitDetail(selected);
      else document.getElementById("trait-detail").classList.add("hidden");
    }
  } catch (error) {
    state.traitsLoaded = false;
    listIds.forEach(id => { document.getElementById(id).innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; });
    document.getElementById("trait-table").innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(error.message)}</td></tr>`;
    document.getElementById("trait-pair-table").innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderTraitStats(data) {
  const sampledWindow = data.sampled.recentLimitReached
    ? `${number.format(data.sampled.recent)} of ${number.format(data.sampled.recentAvailable)} uniformly sampled`
    : "complete window sample";
  const stats = [
    ["Qualifying traits", number.format(data.traits.length), `${number.format(data.sampled.eligibleRecentSales)} bonus sales analyzed`],
    ["Comparable coverage", `${Number(data.sampled.coveragePercent).toFixed(1)}%`, `${number.format(data.sampled.comparableRecentSales)} sales with like-for-like baselines`],
    ["Analysis window", `${data.days} days`, `Compared with the prior ${data.days} days`],
    ["Sample status", number.format(data.sampled.recent), sampledWindow]
  ];
  document.getElementById("trait-stat-grid").innerHTML = stats.map(([label, value, note], index) => `
    <article class="metric-card ${["accent-purple", "accent-green", "accent-blue", "accent-gold"][index]}">
      <span>${label}</span><strong>${value}</strong><small>${note}</small>
    </article>
  `).join("");
}

function renderTraitRankList(id, rows, mode) {
  const root = document.getElementById(id);
  if (!rows?.length) {
    root.innerHTML = '<div class="empty">No traits meet this confidence and volume threshold.</div>';
    return;
  }
  root.innerHTML = rows.map(row => {
    const metric = mode === "trend" ? row.trendChange : row.adjustedPremium;
    const value = mode === "trend" ? signedPoints(metric) : signedPercent(metric);
    return `<div class="rank-row trait-rank-row">
      <button type="button" data-trait-key="${escapeAttr(row.key)}">${escapeHtml(row.title)}</button>
      <span>${number.format(row.sales)} sales · ${escapeHtml(row.confidence)}</span>
      <strong class="${Number(metric) >= 0 ? "positive" : "negative"}">${value}</strong>
    </div>`;
  }).join("");
  root.querySelectorAll("button[data-trait-key]").forEach(button => button.addEventListener("click", () => selectTrait(button.dataset.traitKey)));
}

function renderTraitTable(data) {
  const rows = data.traits.slice().sort((left, right) => (right.adjustedPremium ?? -Infinity) - (left.adjustedPremium ?? -Infinity) || right.sales - left.sales);
  setText("trait-table-caption", `${rows.length} traits · minimum ${data.minSales} sales`);
  document.getElementById("trait-table").innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td><button class="table-link" type="button" data-trait-key="${escapeAttr(row.key)}"><strong>${escapeHtml(row.title)}</strong></button><small>${number.format(row.itemCount)} item types · ${Number(row.coveragePercent).toFixed(0)}% coverage</small></td>
      <td>${number.format(row.sales)}</td>
      <td>${formatMoney(row.medianPrice)}</td>
      <td class="${Number(row.adjustedPremium) >= 0 ? "positive" : "negative"}"><strong>${signedPercent(row.adjustedPremium)}</strong><small>${formatPremiumRange(row)}</small></td>
      <td>${formatTraitStrength(row)}</td>
      <td class="${row.trendChange === null ? "" : Number(row.trendChange) >= 0 ? "positive" : "negative"}">${signedPoints(row.trendChange)}</td>
      <td><span class="confidence ${escapeAttr(row.confidence)}">${escapeHtml(row.confidence)}</span></td>
    </tr>
  `).join("") : '<tr><td colspan="7" class="empty">No traits meet this sales threshold.</td></tr>';
  document.querySelectorAll("#trait-table button[data-trait-key]").forEach(button => button.addEventListener("click", () => selectTrait(button.dataset.traitKey)));
}

function renderTraitPairs(data) {
  const rows = (data.pairs || []).slice(0, 30);
  setText("trait-pair-caption", `Minimum ${data.pairMinimum} sales · double-bonus listings only`);
  document.getElementById("trait-pair-table").innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td>${row.titles.map(title => `<span class="bonus-chip">${escapeHtml(title)}</span>`).join("")}</td>
      <td>${number.format(row.sales)}</td>
      <td>${number.format(row.itemCount)}</td>
      <td>${formatMoney(row.medianPrice)}</td>
      <td class="${Number(row.adjustedPremium) >= 0 ? "positive" : "negative"}"><strong>${signedPercent(row.adjustedPremium)}</strong><small>${formatPremiumRange(row)}</small></td>
      <td><span class="confidence ${escapeAttr(row.confidence)}">${escapeHtml(row.confidence)}</span></td>
    </tr>
  `).join("") : '<tr><td colspan="6" class="empty">No double-bonus combinations meet this threshold.</td></tr>';
}

function selectTrait(key) {
  const trait = state.traitData?.traits?.find(row => row.key === key);
  if (!trait) return;
  state.selectedTraitKey = key;
  renderTraitDetail(trait);
  document.getElementById("trait-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTraitDetail(trait) {
  setText("trait-detail-name", trait.title);
  document.getElementById("trait-detail").classList.remove("hidden");
  const stats = [
    ["Finished sales", number.format(trait.sales), `${number.format(trait.itemCount)} item types`],
    ["Median sale", formatMoney(trait.medianPrice), formatTraitStrength(trait)],
    ["Adjusted premium", signedPercent(trait.adjustedPremium), formatPremiumRange(trait)],
    ["Confidence", trait.confidence, `${Number(trait.coveragePercent).toFixed(0)}% comparable coverage`]
  ];
  document.getElementById("trait-detail-stats").innerHTML = stats.map(([label, value, note], index) => `
    <article class="metric-card ${["accent-blue", "accent-gold", "accent-green", "accent-purple"][index]}"><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>
  `).join("");
  document.getElementById("trait-strength-table").innerHTML = trait.valueBands?.length ? trait.valueBands.map(band => `
    <tr><td>${band.start.toFixed(0)}–${band.end.toFixed(0)}%</td><td>${number.format(band.sales)}</td><td>${formatMoney(band.medianPrice)}</td><td class="${Number(band.adjustedPremium) >= 0 ? "positive" : "negative"}">${signedPercent(band.adjustedPremium)}</td></tr>
  `).join("") : '<tr><td colspan="4" class="empty">No numeric trait-strength values in this sample.</td></tr>';
  document.getElementById("trait-items-table").innerHTML = trait.topItems?.length ? trait.topItems.map(item => `
    <tr><td><button class="table-link" type="button" data-item-id="${item.itemId}" data-item-name="${escapeAttr(item.itemName)}">${escapeHtml(item.itemName)}</button></td><td>${number.format(item.sales)}</td><td>${formatMoney(item.medianPrice)}</td><td class="${Number(item.adjustedPremium) >= 0 ? "positive" : "negative"}">${signedPercent(item.adjustedPremium)}</td></tr>
  `).join("") : '<tr><td colspan="4" class="empty">No item breakdown is available.</td></tr>';
  document.querySelectorAll("#trait-items-table button[data-item-id]").forEach(button => button.addEventListener("click", () => selectItem(button.dataset.itemId, button.dataset.itemName)));
}

function formatTraitStrength(row) {
  if (row.typicalValue === null || row.typicalValue === undefined) return "—";
  const range = row.minimumValue !== null && row.maximumValue !== null && row.minimumValue !== row.maximumValue
    ? ` (${Number(row.minimumValue).toFixed(0)}–${Number(row.maximumValue).toFixed(0)}%)`
    : "";
  return `${Number(row.typicalValue).toFixed(1)}%${range}`;
}

function formatPremiumRange(row) {
  if (row.premiumP25 === null || row.premiumP75 === null) return "No reliable spread";
  return `middle 50%: ${signedPercent(row.premiumP25)} to ${signedPercent(row.premiumP75)}`;
}

function renderRankList(id, rows, mode) {
  const root = document.getElementById(id);
  if (!rows?.length) {
    root.innerHTML = '<div class="empty">No qualifying history yet.</div>';
    return;
  }
  root.innerHTML = rows.map(row => {
    const value = mode === "change"
      ? `<strong class="${row.changePercent >= 0 ? "positive" : "negative"}">${signedPercent(row.changePercent)}</strong>`
      : `<strong>${formatMoney(row.recentAverage)}</strong>`;
    return `<div class="rank-row">
      <button type="button" data-item-id="${row.itemId}" data-item-name="${escapeAttr(row.itemName)}">${escapeHtml(row.itemName)}</button>
      <span>${number.format(row.recentCount)} sales</span>
      ${value}
    </div>`;
  }).join("");
  root.querySelectorAll("button[data-item-id]").forEach(button => button.addEventListener("click", () => selectItem(button.dataset.itemId, button.dataset.itemName)));
}

async function searchItems(event) {
  event.preventDefault();
  const query = document.getElementById("item-search").value.trim();
  const root = document.getElementById("search-results");
  if (query.length < 2) return;
  root.innerHTML = '<div class="empty">Searching…</div>';
  try {
    const data = await api(`/api/items?q=${encodeURIComponent(query)}`);
    root.innerHTML = data.items?.length ? data.items.map(item => `
      <button type="button" class="search-result" data-item-id="${item.item_id}" data-item-name="${escapeAttr(item.item_name)}">
        <strong>${escapeHtml(item.item_name)}</strong>
        <span>${number.format(item.sale_count)} sales · avg ${formatMoney(item.average_price)} · last ${formatDate(item.last_sale)}</span>
      </button>
    `).join("") : '<div class="empty">No matching finished-auction history.</div>';
    root.querySelectorAll("button").forEach(button => button.addEventListener("click", () => selectItem(button.dataset.itemId, button.dataset.itemName)));
  } catch (error) {
    root.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function selectItem(id, name) {
  state.selectedItemId = Number(id);
  state.selectedItemName = name;
  setText("item-detail-name", name);
  document.getElementById("item-detail").classList.remove("hidden");
  openTab("explorer");
  refreshSelectedItem();
}

async function refreshSelectedItem() {
  if (!state.selectedItemId) return;
  const days = document.getElementById("item-days").value;
  const bonus = document.getElementById("item-bonus").value.trim();
  try {
    const data = await api(`/api/items/${state.selectedItemId}/trends?days=${days}${bonus ? `&bonus=${encodeURIComponent(bonus)}` : ""}`);
    renderItemStats(data.summary);
    renderChart(data.daily);
    renderSales(data);
    setText("chart-caption", `${data.sampled.toLocaleString()} finished sales${data.bonusId ? ` · bonus ${data.bonusId}` : ""}`);
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function renderItemStats(summary) {
  const stats = [
    ["Sales", number.format(summary.count || 0)],
    ["Low / P10", `${formatMoney(summary.min)} / ${formatMoney(summary.p10)}`],
    ["Median", formatMoney(summary.median)],
    ["P90 / High", `${formatMoney(summary.p90)} / ${formatMoney(summary.max)}`]
  ];
  document.getElementById("item-stat-grid").innerHTML = stats.map(([label, value], index) => `
    <article class="metric-card ${["accent-blue","accent-green","accent-purple","accent-gold"][index]}">
      <span>${label}</span><strong>${value}</strong>
    </article>
  `).join("");
}

function renderChart(rows) {
  const root = document.getElementById("trend-chart");
  if (!rows?.length) {
    root.innerHTML = '<div class="empty">No history in this range.</div>';
    return;
  }
  const width = 1000;
  const height = 280;
  const padding = { left: 72, right: 18, top: 18, bottom: 34 };
  const values = rows.map(row => Number(row.average));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min *= .95; max *= 1.05; }
  const x = index => padding.left + (index / Math.max(1, rows.length - 1)) * (width - padding.left - padding.right);
  const y = value => padding.top + ((max - value) / (max - min)) * (height - padding.top - padding.bottom);
  const line = rows.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(Number(row.average)).toFixed(1)}`).join(" ");
  const area = `${line} L${x(rows.length - 1)},${height - padding.bottom} L${x(0)},${height - padding.bottom} Z`;
  const grid = [0, .25, .5, .75, 1].map(fraction => {
    const yy = padding.top + fraction * (height - padding.top - padding.bottom);
    const value = max - fraction * (max - min);
    return `<line class="chart-grid" x1="${padding.left}" y1="${yy}" x2="${width - padding.right}" y2="${yy}" />
      <text class="chart-label" x="4" y="${yy + 4}">${compactMoney(value)}</text>`;
  }).join("");
  const first = rows[0].day;
  const last = rows.at(-1).day;
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Price history from ${first} to ${last}">
    <defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4ea1ff" stop-opacity=".32"/><stop offset="1" stop-color="#4ea1ff" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>
    <text class="chart-label" x="${padding.left}" y="${height - 8}">${first}</text>
    <text class="chart-label" text-anchor="end" x="${width - padding.right}" y="${height - 8}">${last}</text>
  </svg>`;
}

function renderSales(data) {
  setText("sales-sample-label", `Showing ${data.recentSales.length} of ${data.sampled}${data.sampled >= data.sampleLimit ? "+ sampled" : ""}`);
  document.getElementById("sales-table").innerHTML = data.recentSales.map(sale => `
    <tr>
      <td>${formatDateTime(sale.endedAt)}</td>
      <td><strong>${formatMoney(sale.price)}</strong></td>
      <td>${formatStats(sale)}</td>
      <td>${sale.bonuses.length ? sale.bonuses.map(bonus => `<span class="bonus-chip">${escapeHtml(bonus.title || `Bonus ${bonus.id}`)}${bonus.value === null ? "" : ` ${bonus.value}%`}</span>`).join("") : "—"}</td>
      <td>${number.format(sale.bids)}</td>
    </tr>
  `).join("");
}

async function refreshSnapshots() {
  const root = document.getElementById("snapshot-items");
  root.innerHTML = '<div class="empty">Loading snapshots…</div>';
  try {
    const data = await api("/api/snapshots");
    const batch = data.batches?.[0];
    document.getElementById("snapshot-summary").innerHTML = batch
      ? `<div class="panel"><strong>${number.format(batch.item_count)} listings</strong> · captured ${timeAgo(batch.captured_at)} · page ${batch.source_page ?? "unknown"}</div>`
      : "";
    root.innerHTML = data.latestItems?.length ? data.latestItems.map(item => `
      <article class="snapshot-card">
        <h3>${escapeHtml(item.item_name)}</h3>
        <div>${(item.bonuses || []).map(bonus => `<span class="bonus-chip">${escapeHtml(bonus.title || bonus.name || `Bonus ${bonus.id}`)}${bonus.value === null ? "" : ` ${bonus.value}%`}</span>`).join("")}</div>
        <div class="snapshot-price">${formatMoney(item.current_bid)}</div>
        <div class="snapshot-meta"><span>${formatSnapshotStats(item)}</span><span>${escapeHtml(item.time_text || "No remaining-time text")}</span></div>
        ${item.source_url ? `<a href="${escapeAttr(item.source_url)}" rel="noreferrer">Open captured Torn page</a>` : ""}
      </article>
    `).join("") : '<div class="empty">No foreground Auction House snapshot has been uploaded.</div>';
  } catch (error) {
    root.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function generateToken(event) {
  event.preventDefault();
  const label = document.getElementById("token-label").value.trim();
  try {
    const data = await api("/api/admin/device-tokens", { method: "POST", body: JSON.stringify({ label }) });
    setText("new-token-value", data.token);
    document.getElementById("new-token").classList.remove("hidden");
    showNotice("Device token generated. It will not be shown again after this page is closed.", "success");
    refreshTokens();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshTokens() {
  const root = document.getElementById("token-list");
  root.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await api("/api/admin/device-tokens");
    root.innerHTML = data.tokens?.length ? data.tokens.map(token => `
      <div class="token-row">
        <div><strong>${escapeHtml(token.label)}</strong><span>Created ${formatDateTime(token.created_at)} · ${token.revoked_at ? "revoked" : token.last_used_at ? `last used ${timeAgo(token.last_used_at)}` : "never used"}</span></div>
        ${token.revoked_at ? '<span class="negative">Revoked</span>' : `<button class="button danger" data-revoke="${token.id}" type="button">Revoke</button>`}
      </div>
    `).join("") : '<div class="empty">No device tokens yet.</div>';
    root.querySelectorAll("button[data-revoke]").forEach(button => button.addEventListener("click", () => revokeToken(button.dataset.revoke)));
  } catch (error) {
    root.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function revokeToken(id) {
  if (!confirm("Revoke this device's upload access?")) return;
  try {
    await api(`/api/admin/device-tokens/${id}`, { method: "DELETE" });
    refreshTokens();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function runSync() {
  const button = document.getElementById("sync-now");
  button.disabled = true;
  button.textContent = "Syncing…";
  try {
    const result = await api("/api/admin/sync", { method: "POST", body: JSON.stringify({}) });
    const budgetNote = result.budgetReached ? " Daily storage guardrail reached; it will resume tomorrow." : "";
    showNotice(result.skipped ? result.reason : `Processed ${result.processedPages} page(s); stored ${number.format(result.inserted)} new sales.${budgetNote}`, result.skipped ? "" : "success");
    await Promise.all([refreshStatus(), refreshOverview()]);
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Sync history";
  }
}

function showNotice(message, kind = "") {
  const notice = document.getElementById("notice");
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add("hidden"), 8000);
}

function formatMoney(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : money.format(Number(value));
}

function compactMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(0)}K`;
  return `$${Math.round(amount)}`;
}

function formatDate(epoch) {
  if (!epoch) return "—";
  return new Date(Number(epoch) * 1000).toLocaleDateString();
}

function formatDateTime(epoch) {
  if (!epoch) return "—";
  return new Date(Number(epoch) * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function timeAgo(epoch) {
  if (!epoch) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(epoch));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function signedPercent(value) {
  if (value === null || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(1)}%`;
}

function signedPoints(value) {
  if (value === null || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(1)} pp`;
}

function formatStats(sale) {
  const parts = [];
  if (sale.damage !== null) parts.push(`D ${Number(sale.damage).toFixed(2)}`);
  if (sale.accuracy !== null) parts.push(`A ${Number(sale.accuracy).toFixed(2)}`);
  if (sale.armor !== null) parts.push(`AR ${Number(sale.armor).toFixed(2)}`);
  if (sale.quality !== null) parts.push(`Q ${Number(sale.quality).toFixed(1)}%`);
  return parts.join(" · ") || "—";
}

function formatSnapshotStats(item) {
  return formatStats({ damage: item.damage, accuracy: item.accuracy, armor: item.armor, quality: item.quality });
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
