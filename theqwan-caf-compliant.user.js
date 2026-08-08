// ==UserScript==
// @name         TheQwan CAF Clean
// @namespace    theqwan.torn.auction-history.clean
// @version      1.4.0
// @description  Foreground-only Auction House history and price guidance for the actively viewed page
// @author       TheQwan [3485263]
// @match        https://www.torn.com/amarket.php*
// @grant        GM_xmlhttpRequest
// @connect      btrmmuuoofbonmuwrkzg.supabase.co
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/caf4-compliant/theqwan-caf-compliant.meta.js
// @downloadURL  https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/caf4-compliant/theqwan-caf-compliant.user.js
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "theqwan-caf-clean";
  const RESULTS_ID = "theqwan-caf-clean-results";
  const FILTERED_RESULTS_ID = "theqwan-caf-clean-filtered-results";
  const ANALYSIS_CLASS = "caf-clean-analysis";
  const SETTINGS_KEY = "cafCleanHistorySettings";
  const FILTER_SETTINGS_KEY = "cafCleanFilterSettings";
  const CACHE_KEY = "cafCleanHistoryCache";
  const COLLECTION_KEY = "cafCleanGuidedCollection";
  const COLLECTOR_COLLAPSED_KEY = "cafCleanCollectorCollapsed";
  const FILTER_COLLAPSED_KEY = "cafCleanFilterCollapsed";
  const SUPABASE_URL = "https://btrmmuuoofbonmuwrkzg.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0cm1tdXVvb2Zib25tdXdya3pnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NTEzMTgsImV4cCI6MjA4NDQyNzMxOH0.E-s0k46BORXLICAvxtEpqoM3Qmh4-TRLaJAwXO6wJTY";

  const BONUS_IDS = {
    "achilles": 50, "assassinate": 72, "backstab": 52, "berserk": 54,
    "bleed": 57, "blindside": 51, "bloodlust": 85, "comeback": 67,
    "conserve": 55, "crusher": 49, "deadeye": 63, "deadly": 62,
    "demoralize": 36, "disarm": 86, "double tap": 105, "double-edged": 74,
    "empower": 87, "eviscerate": 56, "execute": 75, "expose": 1,
    "finale": 82, "focus": 79, "frenzy": 80, "fury": 64,
    "grace": 53, "hazardous": 34, "irradiate": 102, "lacerate": 89,
    "motivation": 61, "parry": 84, "penetrate": 101, "plunder": 21,
    "powerful": 68, "proficience": 14, "quicken": 88, "rage": 65,
    "revitalize": 41, "slow": 44, "smash": 104, "specialist": 71,
    "spray": 35, "stun": 58, "sure shot": 78, "throttle": 48,
    "toxin": 103, "warlord": 81, "weaken": 46, "wind-up": 76,
    "wither": 42, "home run": 83, "homerun": 83
  };

  const BONUS_NAMES = {};
  Object.entries(BONUS_IDS).forEach(([name, id]) => {
    if (!BONUS_NAMES[id]) {
      BONUS_NAMES[id] = name.replace(/\b\w/g, character => character.toUpperCase());
    }
  });

  const itemById = new Map();
  const cardById = new Map();
  let collectionCaptureTimer = null;

  const style = document.createElement("style");
  style.textContent = `
    #${PANEL_ID} {
      margin: 10px 0;
      padding: 10px;
      color: #eee;
      background: #202020;
      border: 1px solid #555;
      border-radius: 8px;
      box-sizing: border-box;
      font-size: 12px;
    }
    #${PANEL_ID} .caf-clean-title {
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 5px;
    }
    #${PANEL_ID} .caf-clean-controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      margin-top: 8px;
    }
    #${PANEL_ID} button,
    #${PANEL_ID} select,
    #${PANEL_ID} a.caf-clean-button,
    .caf-clean-results button,
    .${ANALYSIS_CLASS} button {
      min-height: 34px;
      border: 1px solid #555;
      border-radius: 5px;
      background: #151515;
      color: #8ecbff;
      padding: 6px;
      box-sizing: border-box;
    }
    #${PANEL_ID} a.caf-clean-button {
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      text-decoration: none;
    }
    #${PANEL_ID} button:disabled,
    .caf-clean-results button:disabled,
    .${ANALYSIS_CLASS} button:disabled {
      color: #777;
      opacity: .75;
    }
    #${PANEL_ID} .caf-clean-settings {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
      margin-top: 8px;
      color: #bbb;
    }
    #${PANEL_ID} .caf-clean-collector {
      margin-top: 8px;
      padding: 7px;
      background: #181818;
      border: 1px solid #444;
      border-radius: 6px;
    }
    #${PANEL_ID} .caf-clean-collector-body {
      display: grid;
      grid-template-columns: minmax(90px, .65fr) minmax(0, 1.35fr);
      gap: 6px;
      align-items: center;
      margin-top: 6px;
    }
    #${PANEL_ID} .caf-clean-section-toggle {
      width: 100%;
      min-height: 28px;
    }
    #${PANEL_ID} .caf-clean-filter-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      margin-top: 6px;
    }
    #${PANEL_ID} .caf-clean-filter-grid input,
    #${PANEL_ID} .caf-clean-filter-grid select {
      width: 100%;
      min-width: 0;
      min-height: 32px;
      box-sizing: border-box;
    }
    #caf-clean-collection-progress {
      grid-column: 1 / -1;
      color: #ffcf70;
      line-height: 1.3;
    }
    #caf-clean-next-page { grid-column: 1 / -1; }
    #${PANEL_ID} .caf-clean-disclosure {
      margin-top: 8px;
      color: #999;
      line-height: 1.3;
    }
    #caf-clean-status {
      margin-top: 7px;
      color: #aaa;
    }
    .caf-clean-results {
      margin: 10px 0;
      color: #eee;
      background: #242424;
      border: 1px solid #555;
      border-radius: 8px;
      overflow: hidden;
      box-sizing: border-box;
    }
    .caf-clean-results .caf-clean-results-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      background: #303030;
      font-size: 13px;
      font-weight: 700;
    }
    .caf-clean-results .caf-clean-result {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 9px;
      padding: 10px;
      border-top: 1px solid #444;
      box-sizing: border-box;
    }
    .caf-clean-results .caf-clean-image {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 78px;
      min-width: 78px;
      height: 58px;
      background: #111;
      border: 3px solid #777;
      border-radius: 6px;
      box-sizing: border-box;
      overflow: hidden;
    }
    .caf-clean-results .caf-clean-image.yellow { border-color: #d8d800; box-shadow: 0 0 8px rgba(216,216,0,.7); }
    .caf-clean-results .caf-clean-image.orange { border-color: #ff8c00; box-shadow: 0 0 8px rgba(255,140,0,.7); }
    .caf-clean-results .caf-clean-image.red { border-color: #d94444; box-shadow: 0 0 8px rgba(217,68,68,.7); }
    .caf-clean-results .caf-clean-image img,
    .caf-clean-results .caf-clean-image canvas {
      max-width: 70px;
      max-height: 50px;
      object-fit: contain;
    }
    .caf-clean-results .caf-clean-item-name {
      color: #6eb6ff;
      font-size: 15px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .caf-clean-results .caf-clean-quality { color: #c967ff; font-weight: 700; }
    .caf-clean-results .caf-clean-item-line { color: #bbb; line-height: 1.3; }
    .caf-clean-results .caf-clean-item-bid { color: #fff; line-height: 1.4; }
    .caf-clean-results .caf-clean-source-page {
      display: inline-block;
      margin-top: 3px;
      padding: 2px 5px;
      color: #ffcf70;
      background: #171717;
      border: 1px solid #444;
      border-radius: 4px;
      font-size: 10px;
    }
    .caf-clean-results .caf-clean-item-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      margin-top: 7px;
    }
    .caf-clean-results .caf-clean-item-actions button { width: 100%; }
    .${ANALYSIS_CLASS} {
      flex-basis: 100%;
      grid-column: 1 / -1;
      width: 100%;
      min-width: 0;
      margin-top: 7px;
      padding-top: 7px;
      border-top: 1px solid #444;
      box-sizing: border-box;
    }
    .${ANALYSIS_CLASS} .caf-clean-history {
      width: 100%;
    }
    .caf-clean-history-box {
      display: none;
      margin-top: 6px;
      padding: 7px;
      min-width: 0;
      color: #ddd;
      background: #181818;
      border: 1px solid #444;
      border-radius: 5px;
      box-sizing: border-box;
    }
    .caf-clean-summary {
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .caf-clean-advice {
      margin-top: 4px;
      color: #aaa;
      font-size: 10px;
    }
    .caf-clean-steal { color: #00e676; font-weight: 700; }
    .caf-clean-good { color: #5ee27a; font-weight: 700; }
    .caf-clean-fair { color: #ffd166; font-weight: 700; }
    .caf-clean-high { color: #ff7b89; font-weight: 700; }
    .caf-clean-muted { color: #999; }
    .caf-clean-sales {
      display: none;
      margin-top: 6px;
      padding-top: 5px;
      border-top: 1px solid #333;
    }
    .caf-clean-grid {
      display: grid;
      grid-template-columns: minmax(58px, 1.05fr) minmax(31px, .55fr) minmax(31px, .55fr) minmax(34px, .6fr) minmax(82px, 1.55fr) minmax(30px, .5fr);
      gap: 4px;
      align-items: center;
      min-width: 0;
    }
    .caf-clean-grid-header {
      padding-bottom: 3px;
      color: #888;
      font-size: 10px;
    }
    .caf-clean-grid-row {
      padding: 4px 0;
      border-bottom: 1px solid #292929;
    }
    .caf-clean-bonus {
      min-width: 0;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
  `;
  document.head.appendChild(style);

  function isActiveView() {
    // Torn PDA webviews can report hasFocus() as false even while their page is
    // foregrounded. visibilityState follows the actual app/page lifecycle.
    return document.visibilityState === "visible";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[character]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function durationMilliseconds(value) {
    const text = String(value || "").toLowerCase();
    let total = 0;
    let matched = false;
    const units = /([\d.]+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
    let match;

    while ((match = units.exec(text))) {
      matched = true;
      const amount = Number(match[1]);
      const unit = match[2][0];
      if (unit === "d") total += amount * 86400000;
      if (unit === "h") total += amount * 3600000;
      if (unit === "m") total += amount * 60000;
      if (unit === "s") total += amount * 1000;
    }

    return matched ? total : 0;
  }

  function normalizedFutureTimestamp(value) {
    let timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    if (timestamp < 1e12) timestamp *= 1000;
    const now = Date.now();
    return timestamp > now - 60000 && timestamp < now + 31 * 86400000 ? timestamp : 0;
  }

  function cardEndTimestamp(card, source, timeText) {
    const html = card.outerHTML || "";
    const timestampMatches = [
      ...html.matchAll(/(?:endtime|end-time|ends-at|timestamp)["'=:\s]+(\d{10,13})/gi)
    ];

    for (const match of timestampMatches) {
      const timestamp = normalizedFutureTimestamp(match[1]);
      if (timestamp) return timestamp;
    }

    const duration = durationMilliseconds(timeText || source);
    return duration ? Date.now() + duration : 0;
  }

  function countdownText(endsAtMs) {
    let seconds = Math.max(0, Math.floor((Number(endsAtMs || 0) - Date.now()) / 1000));
    if (!seconds) return "Ended";
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    if (days) return `${days}d ${hours}h ${minutes}m`;
    if (hours) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  function tickCountdowns() {
    if (!isActiveView()) return;
    document.querySelectorAll(".caf-clean-countdown[data-ends-at]").forEach(element => {
      element.textContent = countdownText(element.getAttribute("data-ends-at"));
    });
  }

  function numberFrom(value) {
    const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function settings() {
    try {
      return {
        count: 25,
        matchBonuses: true,
        doubleOnly: false,
        ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
      };
    } catch {
      return { count: 25, matchBonuses: true, doubleOnly: false };
    }
  }

  function saveSettings() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      count: Number(panel.querySelector("#caf-clean-count")?.value || 25),
      matchBonuses: !!panel.querySelector("#caf-clean-match-bonuses")?.checked,
      doubleOnly: !!panel.querySelector("#caf-clean-double")?.checked
    }));
  }

  function setStatus(message, isError = false) {
    const status = document.getElementById("caf-clean-status");
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? "#ff7b89" : "#aaa";
  }

  function loadCollection() {
    try {
      const collection = JSON.parse(localStorage.getItem(COLLECTION_KEY) || "null");
      return collection && Array.isArray(collection.pages) && Array.isArray(collection.items)
        ? collection
        : null;
    } catch {
      return null;
    }
  }

  function saveCollection(collection) {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(collection));
  }

  function collectionItemKey(item) {
    return String(item.id || [
      item.name,
      Number(item.damage || 0).toFixed(2),
      Number(item.accuracy || 0).toFixed(2),
      itemBonusText(item)
    ].join("|"));
  }

  function collectionContentKey(items) {
    return items.map(collectionItemKey).slice(0, 12).join("~");
  }

  function collectionPageKey(items) {
    return `${location.pathname}${location.search}${location.hash}|${collectionContentKey(items)}`;
  }

  function updateCollectionControls() {
    const collection = loadCollection();
    const button = document.getElementById("caf-clean-collector-toggle");
    const target = document.getElementById("caf-clean-collector-target");
    const progress = document.getElementById("caf-clean-collection-progress");
    if (!button || !target || !progress) return;

    if (!collection) {
      button.textContent = "Start Guided Collection";
      target.disabled = false;
      progress.textContent = "No active collection. Every Torn page change must be manually clicked.";
      return;
    }

    const count = collection.pages.length;
    target.value = String(collection.target || 5);
    target.disabled = !!collection.active;
    button.textContent = collection.active ? "Stop & Keep Results" : "Start New Collection";
    progress.textContent = collection.active
      ? `${count}/${collection.target} page(s) collected — ${collection.pending ? "waiting for the manually selected page to finish loading" : "tap Torn's native Next or page-number control"}.`
      : `${count}/${collection.target} page(s) saved — ${collection.items.length} unique item(s).`;
  }

  function auctionCards() {
    if (!isActiveView()) return [];

    const labeled = [...document.querySelectorAll("[aria-label]")].filter(element => {
      const label = element.getAttribute("aria-label") || "";
      return /Damage:\s*[\d.]+/i.test(label) && /Accuracy:\s*[\d.]+/i.test(label);
    });

    const cards = labeled.map(element =>
      element.closest("li") ||
      element.closest("div[class*='auction']") ||
      element.closest("div[class*='item']") ||
      element.parentElement
    ).filter(Boolean);

    return [...new Set(cards)].filter(card => !card.closest(`#${PANEL_ID}`));
  }

  function cardName(card, rawLabel) {
    const explicit =
      card.querySelector("[data-item-name]")?.getAttribute("data-item-name") ||
      card.getAttribute("data-item-name") ||
      card.querySelector("img[alt]")?.getAttribute("alt") ||
      "";

    const cleanedExplicit = explicit
      .replace(/^(?:image|picture|thumbnail)\s+(?:of\s+)?/i, "")
      .replace(/\s+(?:image|picture|thumbnail)$/i, "")
      .trim();

    if (cleanedExplicit && cleanedExplicit.length <= 100 && !/^image$/i.test(cleanedExplicit)) {
      return cleanedExplicit;
    }

    const ariaPrefix = rawLabel.split(/Damage:/i)[0]
      .replace(/^(item|weapon|armor|armour)\s*[:,-]?\s*/i, "")
      .replace(/[|,:\s-]+$/, "")
      .trim();

    if (ariaPrefix && ariaPrefix.length <= 100) return ariaPrefix;

    const candidate = String(card.innerText || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line && line.length <= 100 && !/(damage|accuracy|quality|bonus|bid|time left|\$)/i.test(line));

    return candidate || "Unknown item";
  }

  function bonusDetails(source) {
    const normalized = String(source || "");
    const found = [];

    for (const name of Object.keys(BONUS_IDS)) {
      if (name === "home run" && /homerun/i.test(normalized)) continue;
      const displayName = name.replace(/\b\w/g, character => character.toUpperCase());
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      const match = normalized.match(new RegExp(`\\b${escaped}\\b`, "i"));
      if (!match) continue;

      const nearby = normalized.slice(match.index, match.index + 180);
      const percent = nearby.match(/(\d+(?:\.\d+)?)\s*%/);
      const value = percent ? Number(percent[1]) : null;
      const id = BONUS_IDS[name];
      if (!found.some(bonus => bonus.id === id)) {
        found.push({ id, name: displayName, value });
      }
    }

    return found.slice(0, 2);
  }

  function cardIdentifier(card, item, index) {
    const html = card.outerHTML || "";
    const match =
      html.match(/(?:armou?r?yID|auctionID|listingID|uid)["'=:\s]+(\d+)/i) ||
      html.match(/data-(?:armou?r?y|auction|listing|uid)-id=["']?(\d+)/i);

    const pageStart = (location.hash.match(/(?:#|&)start=(\d+)/i) || [])[1] || "0";
    const bonuses = (item.bonuses || []).map(bonus => `${bonus.id}:${bonus.value ?? ""}`).join(",");
    return match?.[1] || `${pageStart}|${index}|${item.name}|${item.damage}|${item.accuracy}|${bonuses}`;
  }

  function parseCard(card, index) {
    const ariaElement = card.matches("[aria-label*='Damage:']")
      ? card
      : card.querySelector("[aria-label*='Damage:']");
    const rawLabel = ariaElement?.getAttribute("aria-label") || "";
    const text = String(card.innerText || "");
    const source = `${rawLabel}\n${text}`;

    const damage = numberFrom((source.match(/Damage:\s*([\d.]+)/i) || [])[1]) || 0;
    const accuracy = numberFrom((source.match(/Accuracy:\s*([\d.]+)/i) || [])[1]) || 0;
    const quality = numberFrom((source.match(/Quality:\s*([\d.]+)/i) || [])[1]);
    const bidMatch = source.match(/(?:current\s+bid|top\s+bid|bid)\s*[:\-]?\s*\$?([\d,]+)/i) || source.match(/\$([\d,]+)/);
    const bid = bidMatch ? Number(bidMatch[1].replace(/,/g, "")) : 0;
    const bonuses = bonusDetails(`${source}\n${card.outerHTML || ""}`);
    const timeText = (source.match(/(?:time\s+left|ends?\s+in)\s*[:\-]?\s*([^\n]+)/i) || [])[1]?.trim() || "";
    const item = {
      name: cardName(card, rawLabel),
      damage,
      accuracy,
      quality,
      bid,
      bonuses,
      color: cardColor(card),
      timeText,
      endsAtMs: cardEndTimestamp(card, source, timeText)
    };

    item.id = cardIdentifier(card, item, index);
    return item;
  }

  function cardColor(card) {
    const source = `${card.className || ""} ${card.outerHTML || ""}`.toLowerCase();
    if (source.includes("red")) return "red";
    if (source.includes("orange") || source.includes("ff9f00")) return "orange";
    if (source.includes("yellow") || source.includes("ffff00")) return "yellow";
    return "";
  }

  function itemBonusText(item) {
    return item.bonuses.map(bonus => bonus.value === null
      ? bonus.name
      : `${bonus.name} ${bonus.value}%`
    ).join(" / ") || "No bonus";
  }

  function defaultFilterSettings() {
    return {
      name: "",
      minDamage: "",
      minAccuracy: "",
      maxBid: "",
      qualityMin: "",
      qualityMax: "",
      color: "",
      bonus1: "",
      bonus2: "",
      doubleOnly: false
    };
  }

  function loadFilterSettings() {
    try {
      return {
        ...defaultFilterSettings(),
        ...JSON.parse(localStorage.getItem(FILTER_SETTINGS_KEY) || "{}")
      };
    } catch {
      return defaultFilterSettings();
    }
  }

  function filterSettingsFromControls() {
    return {
      name: document.getElementById("caf-clean-filter-name")?.value.trim() || "",
      minDamage: document.getElementById("caf-clean-filter-damage")?.value || "",
      minAccuracy: document.getElementById("caf-clean-filter-accuracy")?.value || "",
      maxBid: document.getElementById("caf-clean-filter-bid")?.value || "",
      qualityMin: document.getElementById("caf-clean-filter-quality-min")?.value || "",
      qualityMax: document.getElementById("caf-clean-filter-quality-max")?.value || "",
      color: document.getElementById("caf-clean-filter-color")?.value || "",
      bonus1: document.getElementById("caf-clean-filter-bonus1")?.value || "",
      bonus2: document.getElementById("caf-clean-filter-bonus2")?.value || "",
      doubleOnly: !!document.getElementById("caf-clean-filter-double")?.checked
    };
  }

  function bonusFilterOptions(selectedValue = "") {
    const options = Object.entries(BONUS_NAMES)
      .map(([id, name]) => ({ id: String(id), name }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return `<option value="">Any bonus</option>${options.map(option =>
      `<option value="${option.id}" ${selectedValue === option.id ? "selected" : ""}>${escapeHtml(option.name)}</option>`
    ).join("")}`;
  }

  function itemMatchesGeneratedFilter(item, filter) {
    const itemBonusIds = (item.bonuses || []).map(bonus => String(bonus.id));
    const quality = item.quality === null || item.quality === undefined ? null : Number(item.quality);
    return (!filter.name || String(item.name || "").toLowerCase().includes(filter.name.toLowerCase()))
      && (!filter.minDamage || Number(item.damage || 0) >= Number(filter.minDamage))
      && (!filter.minAccuracy || Number(item.accuracy || 0) >= Number(filter.minAccuracy))
      && (!filter.maxBid || (Number(item.bid || 0) > 0 && Number(item.bid) <= Number(filter.maxBid)))
      && (!filter.qualityMin || (quality !== null && quality >= Number(filter.qualityMin)))
      && (!filter.qualityMax || (quality !== null && quality <= Number(filter.qualityMax)))
      && (!filter.color || (filter.color === "none" ? !item.color : item.color === filter.color))
      && (!filter.bonus1 || itemBonusIds.includes(filter.bonus1))
      && (!filter.bonus2 || itemBonusIds.includes(filter.bonus2))
      && (!filter.doubleOnly || itemBonusIds.length >= 2);
  }

  function generateFilteredResults() {
    if (!isActiveView()) {
      setStatus("Keep the Auction House visible while generating a filtered list.", true);
      return;
    }

    let source = [...itemById.values()];
    if (!source.length) {
      source = analyzeCurrentPage();
    }
    if (!source.length) return;

    const filter = filterSettingsFromControls();
    localStorage.setItem(FILTER_SETTINGS_KEY, JSON.stringify(filter));
    const filtered = source.filter(item => itemMatchesGeneratedFilter(item, filter));

    if (!filtered.length) {
      document.getElementById(FILTERED_RESULTS_ID)?.remove();
      setStatus(`Filter generated no matches from ${source.length} compiled item(s).`, true);
      return;
    }

    renderCompiledResults(
      filtered,
      `Filtered Results | ${filtered.length} of ${source.length} compiled item(s)`,
      FILTERED_RESULTS_ID
    );
    setStatus(`Generated a separate filtered list with ${filtered.length} item(s).`);
  }

  function clearGeneratedFilter() {
    const defaults = defaultFilterSettings();
    localStorage.removeItem(FILTER_SETTINGS_KEY);
    document.getElementById(FILTERED_RESULTS_ID)?.remove();
    document.getElementById("caf-clean-filter-name").value = defaults.name;
    document.getElementById("caf-clean-filter-damage").value = defaults.minDamage;
    document.getElementById("caf-clean-filter-accuracy").value = defaults.minAccuracy;
    document.getElementById("caf-clean-filter-bid").value = defaults.maxBid;
    document.getElementById("caf-clean-filter-quality-min").value = defaults.qualityMin;
    document.getElementById("caf-clean-filter-quality-max").value = defaults.qualityMax;
    document.getElementById("caf-clean-filter-color").value = defaults.color;
    document.getElementById("caf-clean-filter-bonus1").value = defaults.bonus1;
    document.getElementById("caf-clean-filter-bonus2").value = defaults.bonus2;
    document.getElementById("caf-clean-filter-double").checked = defaults.doubleOnly;
    setStatus("Filtered list cleared. Compiled results were kept.");
  }

  function readCurrentPageItems() {
    cardById.clear();
    return auctionCards().map((card, index) => {
      const item = parseCard(card, index);
      cardById.set(item.id, card);
      return item;
    });
  }

  function renderCompiledResults(
    items,
    heading = `Compiled Results | ${items.length} item(s) from this loaded page`,
    containerId = RESULTS_ID
  ) {
    document.getElementById(containerId)?.remove();
    if (!items.length) return;

    const collapsedKey = `${containerId}:collapsed`;
    const collapsed = localStorage.getItem(collapsedKey) === "true";
    const results = document.createElement("section");
    results.id = containerId;
    results.className = "caf-clean-results";
    results.innerHTML = `
      <div class="caf-clean-results-header">
        <span>${escapeHtml(heading)}</span>
        <button class="caf-clean-results-toggle">${collapsed ? "Show ▼" : "Hide ▲"}</button>
      </div>
      <div class="caf-clean-results-body" style="display:${collapsed ? "none" : "block"}"></div>
    `;
    document.getElementById(PANEL_ID).after(results);
    const body = results.querySelector(".caf-clean-results-body");

    items.forEach(item => {
      const sourceCard = cardById.get(item.id);
      const sourcePage = Number(item.collectedPage || 0);
      const result = document.createElement("article");
      result.className = "caf-clean-result";
      result.dataset.cafCleanId = item.id;
      result.innerHTML = `
        <div class="caf-clean-image ${escapeAttr(item.color)}"></div>
        <div>
          <div class="caf-clean-item-name">${escapeHtml(item.name)}</div>
          ${item.quality === null ? "" : `<div class="caf-clean-quality">Quality: ${item.quality.toFixed(2)}%</div>`}
          <div class="caf-clean-item-line">Damage: ${item.damage.toFixed(2)} | Accuracy: ${item.accuracy.toFixed(2)}</div>
          <div class="caf-clean-item-line">Bonus: ${escapeHtml(itemBonusText(item))}</div>
          <div class="caf-clean-item-line">Color: ${item.color ? item.color.toUpperCase() : "None"}</div>
          <div class="caf-clean-item-bid">Bid: ${money(item.bid)}</div>
          ${item.endsAtMs
            ? `<div class="caf-clean-item-line">Time left: <span class="caf-clean-countdown" data-ends-at="${Number(item.endsAtMs)}">${countdownText(item.endsAtMs)}</span></div>`
            : item.timeText ? `<div class="caf-clean-item-line">Time left: ${escapeHtml(item.timeText)}</div>` : ""}
          ${sourcePage ? `<span class="caf-clean-source-page">Collected page ${sourcePage}${sourceCard ? " — current" : " — saved"}</span>` : ""}
          <div class="caf-clean-item-actions">
            <button class="caf-clean-history">History + Price Check</button>
            <button class="caf-clean-locate" ${sourceCard ? "" : "disabled"}>${sourceCard ? "Show Original" : `Saved Page ${sourcePage || "?"}`}</button>
          </div>
        </div>
        <div class="${ANALYSIS_CLASS}">
          <div class="caf-clean-history-box"></div>
        </div>
      `;

      const sourceImage = sourceCard?.querySelector("img");
      if (sourceImage?.complete && sourceImage.naturalWidth) {
        const canvas = document.createElement("canvas");
        canvas.width = sourceImage.naturalWidth;
        canvas.height = sourceImage.naturalHeight;
        canvas.getContext("2d")?.drawImage(sourceImage, 0, 0);
        result.querySelector(".caf-clean-image").appendChild(canvas);
      }

      result.querySelector(".caf-clean-history").addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        await runHistory(item, result);
      });

      result.querySelector(".caf-clean-locate").addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (!isActiveView() || !sourceCard?.isConnected) {
          setStatus("The original item is no longer on this loaded page. Compile the page again.", true);
          return;
        }

        sourceCard.scrollIntoView({ behavior: "smooth", block: "center" });
        const oldOutline = sourceCard.style.outline;
        const oldShadow = sourceCard.style.boxShadow;
        sourceCard.style.outline = "4px solid #00ff6a";
        sourceCard.style.boxShadow = "0 0 18px #00ff6a";
        setTimeout(() => {
          if (!sourceCard.isConnected) return;
          sourceCard.style.outline = oldOutline;
          sourceCard.style.boxShadow = oldShadow;
        }, 2500);
      });

      body.appendChild(result);
    });

    results.querySelector(".caf-clean-results-toggle").addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const resultsBody = results.querySelector(".caf-clean-results-body");
      const willCollapse = resultsBody.style.display !== "none";
      resultsBody.style.display = willCollapse ? "none" : "block";
      event.currentTarget.textContent = willCollapse ? "Show ▼" : "Hide ▲";
      localStorage.setItem(collapsedKey, willCollapse ? "true" : "false");
    });
  }

  function analyzeCurrentPage() {
    if (!isActiveView()) {
      setStatus("Bring the Auction House page into focus, then try again.", true);
      return [];
    }

    itemById.clear();
    const items = readCurrentPageItems();
    items.forEach(item => {
      itemById.set(item.id, item);
    });
    renderCompiledResults(items);

    setStatus(items.length
      ? `Ready: ${items.length} currently loaded auction item(s). No additional Torn requests were made.`
      : "No weapon or armor cards are currently rendered. Open an Auction House category or page, then try again.",
      !items.length
    );
    return items;
  }

  function renderCollection(collection) {
    itemById.clear();
    collection.items.forEach(item => itemById.set(item.id, item));
    renderCompiledResults(
      collection.items,
      `Guided Collection | ${collection.pages.length}/${collection.target} page(s) | ${collection.items.length} unique item(s)`
    );
    updateCollectionControls();
  }

  function addPageToCollection(collection, items) {
    const contentKey = collectionContentKey(items);
    const pageKey = collectionPageKey(items);

    if (!items.length || collection.pages.some(page => page.key === pageKey)) {
      collection.pending = false;
      saveCollection(collection);
      updateCollectionControls();
      setStatus("That page is already in this collection. Manually choose a different Torn page.", true);
      return false;
    }

    const pageNumber = collection.pages.length + 1;
    const capturedAt = Date.now();
    const merged = new Map(collection.items.map(item => [collectionItemKey(item), item]));

    items.forEach(item => {
      const key = collectionItemKey(item);
      const existing = merged.get(key);
      merged.set(key, {
        ...(existing || {}),
        ...item,
        collectedPage: existing?.collectedPage || pageNumber,
        lastSeenPage: pageNumber,
        collectedAt: existing?.collectedAt || capturedAt,
        lastSeenAt: capturedAt
      });
    });

    collection.items = [...merged.values()];
    collection.pages.push({ key: pageKey, contentKey, number: pageNumber, capturedAt });
    collection.lastContentKey = contentKey;
    collection.pending = false;
    collection.pendingAt = 0;

    if (collection.pages.length >= collection.target) {
      collection.active = false;
      collection.completedAt = Date.now();
    }

    saveCollection(collection);
    renderCollection(collection);
    setStatus(collection.active
      ? `Collected page ${pageNumber}/${collection.target}. Manually tap Torn's native Next or a page number.`
      : `Collection complete: ${collection.pages.length} page(s), ${collection.items.length} unique item(s).`
    );
    return true;
  }

  function toggleGuidedCollection() {
    if (!isActiveView()) {
      setStatus("Bring the Auction House page into focus before starting collection.", true);
      return;
    }

    const existing = loadCollection();
    if (existing?.active) {
      existing.active = false;
      existing.pending = false;
      saveCollection(existing);
      renderCollection(existing);
      setStatus(`Collection stopped with ${existing.pages.length} saved page(s).`);
      return;
    }

    const items = readCurrentPageItems();
    if (!items.length) {
      setStatus("No auction items are rendered yet. Open a Torn Auction House results page first.", true);
      return;
    }

    const target = Math.max(2, Math.min(10, Number(document.getElementById("caf-clean-collector-target")?.value || 5)));
    const collection = {
      active: true,
      pending: false,
      target,
      startedAt: Date.now(),
      pages: [],
      items: [],
      lastContentKey: ""
    };
    addPageToCollection(collection, items);
  }

  function isNativePaginationClick(event) {
    if (!event.isTrusted) return false;
    const control = event.target.closest?.("a, button");
    if (!control || control.closest(`#${PANEL_ID}, .caf-clean-results`)) return false;

    const href = control.getAttribute("href") || "";
    const text = String(control.textContent || control.getAttribute("aria-label") || "").trim();
    const ancestry = [control, control.parentElement, control.parentElement?.parentElement]
      .map(element => `${element?.id || ""} ${element?.className || ""}`)
      .join(" ");

    return /(?:[?#&](?:start|page)=\d+)/i.test(href)
      || /pag(?:e|er|ination)|pagination|page-nav/i.test(ancestry)
      || /^(next|previous|prev|[›»‹«]|page\s+\d+)$/i.test(text);
  }

  function armCollectionForManualNavigation() {
    const collection = loadCollection();
    if (!collection?.active) return false;

    collection.pending = true;
    collection.pendingAt = Date.now();
    saveCollection(collection);
    updateCollectionControls();
    return true;
  }

  function markManualCollectionNavigation(event) {
    if (!isNativePaginationClick(event) || !armCollectionForManualNavigation()) return;
    setStatus("Manual Torn navigation recognized. Waiting for the newly selected page to finish rendering.");
    schedulePendingCollectionCapture();
  }

  function auctionStartFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname) return null;
      const start = new URLSearchParams(url.hash.replace(/^#/, "")).get("start");
      return start === null ? null : Number(start);
    } catch {
      return null;
    }
  }

  function nextTornPageUrl() {
    const currentStart = auctionStartFromUrl(location.href) || 0;
    const nativeCandidates = [...document.querySelectorAll("a[href]")]
      .filter(link => !link.closest(`#${PANEL_ID}, .caf-clean-results`))
      .map(link => ({ href: link.href, start: auctionStartFromUrl(link.href) }))
      .filter(candidate => Number.isFinite(candidate.start) && candidate.start > currentStart)
      .sort((left, right) => left.start - right.start);

    if (nativeCandidates.length) return nativeCandidates[0].href;

    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    hash.set("start", String(currentStart + 10));
    url.hash = hash.toString();
    return url.href;
  }

  function prepareTopNextPage(event) {
    if (!event.isTrusted || !isActiveView()) {
      event.preventDefault();
      setStatus("Keep the Auction House visible and tap Next Torn Page yourself.", true);
      return;
    }

    const link = event.currentTarget;
    link.href = nextTornPageUrl();
    const armed = armCollectionForManualNavigation();
    setStatus(armed
      ? "Opening one Torn page from your tap. CAF will collect it after it finishes rendering."
      : "Opening the next Torn page from your tap. Start Guided Collection first if you want it logged."
    );
  }

  function updateTopNextPageLink() {
    const link = document.getElementById("caf-clean-next-page");
    if (link) link.href = nextTornPageUrl();
  }

  function handleAuctionPageChange() {
    updateTopNextPageLink();
    schedulePendingCollectionCapture();
  }

  function schedulePendingCollectionCapture() {
    const collection = loadCollection();
    if (!collection?.active || !collection.pending) return;
    clearTimeout(collectionCaptureTimer);
    collectionCaptureTimer = setTimeout(capturePendingCollectionPage, 900);
  }

  function capturePendingCollectionPage() {
    const collection = loadCollection();
    if (!collection?.active || !collection.pending || !isActiveView()) return;

    const items = readCurrentPageItems();
    if (!items.length || collectionContentKey(items) === collection.lastContentKey) return;
    addPageToCollection(collection, items);
  }

  function restoreCollection() {
    const collection = loadCollection();
    if (!collection?.items.length) {
      updateCollectionControls();
      return;
    }

    renderCollection(collection);
    if (collection.pending) schedulePendingCollectionCapture();
  }

  function money(value) {
    const number = Number(value || 0);
    if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
    if (number >= 1e6) return `$${(number / 1e6).toFixed(1)}M`;
    if (number >= 1e3) return `$${(number / 1e3).toFixed(0)}K`;
    return `$${number.toLocaleString()}`;
  }

  function median(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function daysAgo(timestamp) {
    if (!timestamp) return "?";
    const days = Math.floor((Date.now() - Number(timestamp) * 1000) / 86400000);
    return days <= 0 ? "today" : `${days}d`;
  }

  function cacheGet(key) {
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      const hit = cache[key];
      return hit && Date.now() - hit.timestamp < 5 * 60 * 1000 ? hit.data : null;
    } catch {
      return null;
    }
  }

  function cacheSet(key, data) {
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      cache[key] = { timestamp: Date.now(), data };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {}
  }

  function cleanRequestBody(body) {
    const clean = { ...body };
    Object.keys(clean).forEach(key => {
      if (key.startsWith("__")) delete clean[key];
    });
    return clean;
  }

  function historyRequest(body) {
    return new Promise((resolve, reject) => {
      const clean = cleanRequestBody(body);
      const key = JSON.stringify(clean);
      const cached = cacheGet(key);
      if (cached) {
        resolve(cached);
        return;
      }

      GM_xmlhttpRequest({
        method: "POST",
        url: `${SUPABASE_URL}/functions/v1/search-auctions`,
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
        },
        data: JSON.stringify(clean),
        timeout: 30000,
        onload: response => {
          try {
            const data = JSON.parse(response.responseText);
            if (response.status >= 200 && response.status < 300) {
              cacheSet(key, data);
              resolve(data);
            } else {
              reject(new Error(data?.error || data?.message || `History service returned ${response.status}`));
            }
          } catch {
            reject(new Error("History service returned an unreadable response"));
          }
        },
        onerror: () => reject(new Error("History service network error")),
        ontimeout: () => reject(new Error("History service timed out"))
      });
    });
  }

  function historyBody(item) {
    const current = settings();
    const body = {
      limit: 100,
      offset: 0,
      sort_by: "timestamp",
      sort_order: "desc",
      item_name: item.name,
      quality_min: 0,
      quality_max: 200,
      __visibleLimit: current.count,
      __targetBonusIds: current.matchBonuses ? item.bonuses.map(bonus => bonus.id) : [],
      __forceDouble: current.doubleOnly
    };

    if (current.matchBonuses) {
      body.__targetBonusIds.slice(0, 2).forEach((id, index) => {
        body[`bonus${index + 1}_id`] = id;
      });
    }

    return body;
  }

  function saleBonusIds(sale) {
    const ids = new Set();
    if (Array.isArray(sale.bonus_ids)) sale.bonus_ids.forEach(id => ids.add(Number(id)));
    if (Array.isArray(sale.bonus_values)) sale.bonus_values.forEach(bonus => ids.add(Number(bonus.bonus_id)));
    return [...ids].filter(Boolean);
  }

  function postFilter(sales, body) {
    let result = sales.slice();
    const targets = body.__targetBonusIds || [];
    if (targets.length) {
      result = result.filter(sale => targets.every(id => saleBonusIds(sale).includes(Number(id))));
    }
    if (body.__forceDouble) {
      result = result.filter(sale => saleBonusIds(sale).length >= 2);
    }
    return result.slice(0, body.__visibleLimit || 25);
  }

  async function searchHistoryDeep(body) {
    const pageSize = 100;
    const maxScanned = 1000;
    let all = [];
    let total = null;

    for (let offset = 0; offset < maxScanned; offset += pageSize) {
      if (!isActiveView()) throw new Error("History stopped because the Auction House page lost focus");
      const result = await historyRequest({ ...body, limit: pageSize, offset });
      const sales = Array.isArray(result.auctions) ? result.auctions : [];
      all = all.concat(sales);
      total = result.total ?? total;

      const filtered = postFilter(all, { ...body, __visibleLimit: maxScanned });
      if (filtered.length >= body.__visibleLimit) return filtered.slice(0, body.__visibleLimit);
      if (!sales.length || (total !== null && offset + pageSize >= total)) break;
    }

    return postFilter(all, body);
  }

  function saleNumber(sale, ...keys) {
    for (const key of keys) {
      const value = numberFrom(sale[key]);
      if (value !== null) return value;
    }
    return null;
  }

  function shortBonusName(name) {
    const replacements = {
      "Assassinate": "Assass.", "Demoralize": "Demo", "Double Tap": "D.Tap",
      "Double-Edged": "D.Edge", "Eviscerate": "Evis.", "Motivation": "Motiv.",
      "Proficience": "Profic.", "Revitalize": "Revital.", "Specialist": "Spec.",
      "Sure Shot": "S.Shot"
    };
    return replacements[name] || name;
  }

  function saleBonuses(sale, abbreviated = false) {
    if (Array.isArray(sale.bonus_values) && sale.bonus_values.length) {
      return sale.bonus_values.map(bonus => {
        const fullName = BONUS_NAMES[bonus.bonus_id] || `Bonus ${bonus.bonus_id}`;
        const name = abbreviated ? shortBonusName(fullName) : fullName;
        return `${name} ${bonus.bonus_value ?? "?"}%`;
      }).join(" / ");
    }
    if (Array.isArray(sale.bonus_ids) && sale.bonus_ids.length) {
      return sale.bonus_ids.map(id => {
        const fullName = BONUS_NAMES[id] || `Bonus ${id}`;
        return abbreviated ? shortBonusName(fullName) : fullName;
      }).join(" / ");
    }
    return "No bonus";
  }

  function dealState(bid, low, middle, high) {
    if (!bid || !middle) return ["caf-clean-muted", "PRICE UNKNOWN"];
    if (bid < low) return ["caf-clean-steal", "STEAL"];
    if (bid < middle) return ["caf-clean-good", "GOOD"];
    if (bid <= high) return ["caf-clean-fair", "FAIR"];
    return ["caf-clean-high", "HIGH"];
  }

  function compareColor(value, current, minimum, maximum, lowerIsBetter = false) {
    if (value === null || current === null) return "#999";
    if (value === current) return "#ffd166";
    const favorable = lowerIsBetter ? value < current : value > current;
    if (favorable) return "#5ee27a";
    const span = Math.max(1, maximum - minimum);
    return Math.abs(value - current) / span < .12 ? "#ffd166" : "#ff7b89";
  }

  function renderHistory(item, sales, box, usedBroadFallback = false) {
    const prices = sales.map(sale => Number(sale.price || 0)).filter(Boolean);
    if (!prices.length) {
      box.innerHTML = `<span class="caf-clean-muted">No finished sales found for parsed item “${escapeHtml(item.name)}”.</span>`;
      return;
    }

    const low = Math.min(...prices);
    const middle = median(prices);
    const high = Math.max(...prices);
    const [dealClass, dealLabel] = dealState(item.bid, low, middle, high);
    const damageValues = sales.map(sale => saleNumber(sale, "stat_damage", "damage", "item_damage")).filter(value => value !== null);
    const accuracyValues = sales.map(sale => saleNumber(sale, "stat_accuracy", "accuracy", "item_accuracy")).filter(value => value !== null);
    const qualityValues = sales.map(sale => saleNumber(sale, "stat_quality", "quality")).filter(value => value !== null);
    const damageMin = damageValues.length ? Math.min(...damageValues, item.damage) : item.damage;
    const damageMax = damageValues.length ? Math.max(...damageValues, item.damage) : item.damage;
    const accuracyMin = accuracyValues.length ? Math.min(...accuracyValues, item.accuracy) : item.accuracy;
    const accuracyMax = accuracyValues.length ? Math.max(...accuracyValues, item.accuracy) : item.accuracy;
    const qualityMin = qualityValues.length ? Math.min(...qualityValues, item.quality ?? 0) : 0;
    const qualityMax = qualityValues.length ? Math.max(...qualityValues, item.quality ?? 0) : 1;

    box.innerHTML = `
      <div class="caf-clean-summary">
        <span class="${dealClass}">Bid ${money(item.bid)} — ${dealLabel}</span>
        <span class="caf-clean-muted"> | </span>
        <span style="color:#7ee787">L ${money(low)}</span>
        <span class="caf-clean-muted"> | </span>
        <span style="color:#b98cff">M ${money(middle)}</span>
        <span class="caf-clean-muted"> | </span>
        <span style="color:#ff8b8b">H ${money(high)}</span>
        <span class="caf-clean-muted"> | ${sales.length} sale(s)</span>
      </div>
      <div class="caf-clean-advice">Price comparison only. The current auction can still rise before it closes.</div>
      ${usedBroadFallback ? `<div class="caf-clean-advice">No exact bonus match was found, so this shows broader history for the same item.</div>` : ""}
      <button class="caf-clean-toggle" style="width:100%;margin-top:5px">Previous Sales ▼</button>
      <div class="caf-clean-sales">
        <div class="caf-clean-grid caf-clean-grid-header">
          <span>Sold</span><span>Dmg</span><span>Acc</span><span>Q</span><span>Bonus</span><span>Age</span>
        </div>
        ${sales.map(sale => {
          const price = Number(sale.price || 0);
          const damage = saleNumber(sale, "stat_damage", "damage", "item_damage");
          const accuracy = saleNumber(sale, "stat_accuracy", "accuracy", "item_accuracy");
          const quality = saleNumber(sale, "stat_quality", "quality");
          const fullBonuses = saleBonuses(sale, false);
          const shortBonuses = saleBonuses(sale, true);
          return `
            <div class="caf-clean-grid caf-clean-grid-row">
              <span style="color:${compareColor(price, item.bid, low, high, true)};font-weight:700">${money(price)}</span>
              <span style="color:${compareColor(damage, item.damage, damageMin, damageMax)};font-weight:700">${damage === null ? "?" : damage.toFixed(1)}</span>
              <span style="color:${compareColor(accuracy, item.accuracy, accuracyMin, accuracyMax)};font-weight:700">${accuracy === null ? "?" : accuracy.toFixed(1)}</span>
              <span style="color:${compareColor(quality, item.quality, qualityMin, qualityMax)};font-weight:700">${quality === null ? "?" : quality.toFixed(1)}</span>
              <span class="caf-clean-bonus" title="${escapeAttr(fullBonuses)}">${escapeHtml(shortBonuses)}</span>
              <span>${daysAgo(sale.timestamp)}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;

    const toggle = box.querySelector(".caf-clean-toggle");
    const salesBox = box.querySelector(".caf-clean-sales");
    toggle.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const open = salesBox.style.display === "block";
      salesBox.style.display = open ? "none" : "block";
      toggle.textContent = open ? "Previous Sales ▼" : "Previous Sales ▲";
    });
  }

  async function runHistory(item, scope) {
    const button = scope.querySelector(".caf-clean-history");
    const box = scope.querySelector(".caf-clean-history-box");
    if (!box) return;

    if (!isActiveView()) {
      box.innerHTML = `<span class="caf-clean-high">Keep this Auction House page visible and focused while checking history.</span>`;
      return;
    }

    button.disabled = true;
    button.textContent = "Checking...";
    box.style.display = "block";
    box.innerHTML = `<span class="caf-clean-muted">Checking history for ${escapeHtml(item.name)}...</span>`;

    try {
      const body = historyBody(item);
      let sales = await searchHistoryDeep(body);
      let usedBroadFallback = false;

      if (!sales.length && (body.__targetBonusIds.length || body.__forceDouble)) {
        const broadBody = {
          ...body,
          __targetBonusIds: [],
          __forceDouble: false
        };
        delete broadBody.bonus1_id;
        delete broadBody.bonus2_id;
        sales = await searchHistoryDeep(broadBody);
        usedBroadFallback = sales.length > 0;
      }

      if (!isActiveView()) throw new Error("History stopped because the Auction House page lost focus");
      renderHistory(item, sales, box, usedBroadFallback);
    } catch (error) {
      box.innerHTML = `<span class="caf-clean-high">History error: ${escapeHtml(error.message)}</span>`;
    } finally {
      button.disabled = false;
      button.textContent = "History + Price Check";
    }
  }

  async function analyzeAllVisibleHistory() {
    let resultCards = [...document.querySelectorAll(`#${RESULTS_ID} .caf-clean-result`)];
    if (!resultCards.length) {
      const items = analyzeCurrentPage();
      if (!items.length) return;
      resultCards = [...document.querySelectorAll(`#${RESULTS_ID} .caf-clean-result`)];
    }

    const analyzeAllButton = document.getElementById("caf-clean-all-history");
    analyzeAllButton.disabled = true;

    try {
      for (let index = 0; index < resultCards.length; index++) {
        if (!isActiveView()) {
          setStatus("Stopped because the Auction House page lost focus. Existing results were kept.", true);
          return;
        }

        const scope = resultCards[index];
        const id = scope.dataset.cafCleanId;
        const item = itemById.get(id);
        if (!scope || !item) continue;

        setStatus(`Checking history ${index + 1} of ${resultCards.length}: ${item.name}`);
        await runHistory(item, scope);
        await delay(150);
      }

      setStatus(`History ready for ${resultCards.length} compiled auction item(s).`);
    } finally {
      analyzeAllButton.disabled = false;
    }
  }

  function clearAnalysis() {
    document.querySelectorAll(`.${ANALYSIS_CLASS}`).forEach(element => element.remove());
    document.getElementById(RESULTS_ID)?.remove();
    document.getElementById(FILTERED_RESULTS_ID)?.remove();
    localStorage.removeItem(COLLECTION_KEY);
    itemById.clear();
    cardById.clear();
    updateCollectionControls();
    setStatus("Analysis cleared. Torn's original Auction House page was not changed or reloaded.");
  }

  function bindCollapsibleSection(buttonId, bodyId, storageKey, label) {
    const button = document.getElementById(buttonId);
    const body = document.getElementById(bodyId);
    if (!button || !body) return;

    button.addEventListener("click", event => {
      event.preventDefault();
      const willCollapse = body.style.display !== "none";
      body.style.display = willCollapse ? "none" : "grid";
      button.textContent = `${label} ${willCollapse ? "▶" : "▼"}`;
      localStorage.setItem(storageKey, willCollapse ? "true" : "false");
    });
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;
    const current = settings();
    const savedCollection = loadCollection();
    const collectionTarget = Number(savedCollection?.target || 5);
    const filter = loadFilterSettings();
    const collectorCollapsed = localStorage.getItem(COLLECTOR_COLLAPSED_KEY) === "true";
    const filterCollapsed = localStorage.getItem(FILTER_COLLAPSED_KEY) === "true";
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="caf-clean-title">CAF Clean — Active Page History</div>
      <div>Compile and analyze only the auction items Torn has already loaded on the page you are viewing.</div>
      <div class="caf-clean-settings">
        <label>Sales
          <select id="caf-clean-count">
            ${[
              [12, "12"], [25, "25"], [50, "50"], [100, "100"], [1000, "All found (max 1,000)"]
            ].map(([count, label]) => `<option value="${count}" ${current.count === count ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label><input id="caf-clean-match-bonuses" type="checkbox" ${current.matchBonuses ? "checked" : ""}> Match this item's bonuses</label>
        <label><input id="caf-clean-double" type="checkbox" ${current.doubleOnly ? "checked" : ""}> Double-bonus sales only</label>
      </div>
      <div class="caf-clean-collector">
        <button id="caf-clean-collector-collapse" class="caf-clean-section-toggle">Guided Collection ${collectorCollapsed ? "▶" : "▼"}</button>
        <div id="caf-clean-collector-body" class="caf-clean-collector-body" style="display:${collectorCollapsed ? "none" : "grid"}">
          <label>Guided pages
            <select id="caf-clean-collector-target">
              ${[2, 3, 4, 5, 6, 7, 8, 9, 10].map(count => `<option value="${count}" ${collectionTarget === count ? "selected" : ""}>${count}</option>`).join("")}
            </select>
          </label>
          <button id="caf-clean-collector-toggle">Start Guided Collection</button>
          <a id="caf-clean-next-page" class="caf-clean-button" href="#">Next Torn Page →</a>
          <div id="caf-clean-collection-progress"></div>
        </div>
      </div>
      <div class="caf-clean-collector">
        <button id="caf-clean-filter-collapse" class="caf-clean-section-toggle">Generate Filtered List ${filterCollapsed ? "▶" : "▼"}</button>
        <div id="caf-clean-filter-body" class="caf-clean-filter-grid" style="display:${filterCollapsed ? "none" : "grid"}">
          <input id="caf-clean-filter-name" placeholder="Item name" value="${escapeAttr(filter.name)}">
          <select id="caf-clean-filter-color">
            <option value="" ${!filter.color ? "selected" : ""}>Any color</option>
            <option value="none" ${filter.color === "none" ? "selected" : ""}>No color</option>
            <option value="yellow" ${filter.color === "yellow" ? "selected" : ""}>Yellow</option>
            <option value="orange" ${filter.color === "orange" ? "selected" : ""}>Orange</option>
            <option value="red" ${filter.color === "red" ? "selected" : ""}>Red</option>
          </select>
          <input id="caf-clean-filter-damage" type="number" step="0.01" placeholder="Minimum damage" value="${escapeAttr(filter.minDamage)}">
          <input id="caf-clean-filter-accuracy" type="number" step="0.01" placeholder="Minimum accuracy" value="${escapeAttr(filter.minAccuracy)}">
          <input id="caf-clean-filter-bid" type="number" step="1" placeholder="Maximum bid" value="${escapeAttr(filter.maxBid)}">
          <span></span>
          <input id="caf-clean-filter-quality-min" type="number" step="0.01" placeholder="Minimum quality" value="${escapeAttr(filter.qualityMin)}">
          <input id="caf-clean-filter-quality-max" type="number" step="0.01" placeholder="Maximum quality" value="${escapeAttr(filter.qualityMax)}">
          <select id="caf-clean-filter-bonus1">${bonusFilterOptions(String(filter.bonus1 || ""))}</select>
          <select id="caf-clean-filter-bonus2">${bonusFilterOptions(String(filter.bonus2 || ""))}</select>
          <label style="grid-column:1 / -1"><input id="caf-clean-filter-double" type="checkbox" ${filter.doubleOnly ? "checked" : ""}> Double-bonus items only</label>
          <button id="caf-clean-filter-generate">Generate New List</button>
          <button id="caf-clean-filter-clear">Clear Filtered List</button>
        </div>
      </div>
      <div class="caf-clean-controls">
        <button id="caf-clean-analyze">Compile Loaded Items</button>
        <button id="caf-clean-all-history">Load History for Results</button>
        <button id="caf-clean-clear">Clear Results</button>
        <button id="caf-clean-cache">Clear History Cache</button>
      </div>
      <div class="caf-clean-disclosure">
        Guided collection records each focused page only after you manually use Torn's native pagination; it never advances a page itself.
        History checks send the visible item's name, stats, quality range, and bonus filters to the external
        btrmmuuoofbonmuwrkzg Supabase history service. No Torn password, session cookie, or API key is sent.
        Results are cached in this browser for five minutes.
      </div>
      <div id="caf-clean-status">Ready. This build makes no scripted requests to Torn.</div>
    `;
    document.body.prepend(panel);

    panel.querySelector("#caf-clean-analyze").addEventListener("click", analyzeCurrentPage);
    panel.querySelector("#caf-clean-all-history").addEventListener("click", analyzeAllVisibleHistory);
    panel.querySelector("#caf-clean-collector-toggle").addEventListener("click", toggleGuidedCollection);
    panel.querySelector("#caf-clean-next-page").addEventListener("click", prepareTopNextPage);
    panel.querySelector("#caf-clean-filter-generate").addEventListener("click", generateFilteredResults);
    panel.querySelector("#caf-clean-filter-clear").addEventListener("click", clearGeneratedFilter);
    panel.querySelector("#caf-clean-clear").addEventListener("click", clearAnalysis);
    panel.querySelector("#caf-clean-cache").addEventListener("click", () => {
      localStorage.removeItem(CACHE_KEY);
      setStatus("History cache cleared.");
    });
    panel.querySelectorAll("select, input").forEach(element => element.addEventListener("change", saveSettings));
    bindCollapsibleSection("caf-clean-collector-collapse", "caf-clean-collector-body", COLLECTOR_COLLAPSED_KEY, "Guided Collection");
    bindCollapsibleSection("caf-clean-filter-collapse", "caf-clean-filter-body", FILTER_COLLAPSED_KEY, "Generate Filtered List");

    document.addEventListener("click", markManualCollectionNavigation, true);
    window.addEventListener("hashchange", handleAuctionPageChange);
    window.addEventListener("focus", schedulePendingCollectionCapture);
    document.addEventListener("visibilitychange", schedulePendingCollectionCapture);

    const observer = new MutationObserver(schedulePendingCollectionCapture);
    observer.observe(document.body, { childList: true, subtree: true });
    updateTopNextPageLink();
    restoreCollection();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectPanel, { once: true });
  } else {
    injectPanel();
  }
  setInterval(tickCountdowns, 1000);
})();
