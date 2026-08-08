// ==UserScript==
// @name         TheQwan CAF Clean
// @namespace    theqwan.torn.auction-history.clean
// @version      1.1.0
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
  const ANALYSIS_CLASS = "caf-clean-analysis";
  const SETTINGS_KEY = "cafCleanHistorySettings";
  const CACHE_KEY = "cafCleanHistoryCache";
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
    #${RESULTS_ID} button,
    .${ANALYSIS_CLASS} button {
      min-height: 34px;
      border: 1px solid #555;
      border-radius: 5px;
      background: #151515;
      color: #8ecbff;
      padding: 6px;
      box-sizing: border-box;
    }
    #${PANEL_ID} button:disabled,
    #${RESULTS_ID} button:disabled,
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
    #${PANEL_ID} .caf-clean-disclosure {
      margin-top: 8px;
      color: #999;
      line-height: 1.3;
    }
    #caf-clean-status {
      margin-top: 7px;
      color: #aaa;
    }
    #${RESULTS_ID} {
      margin: 10px 0;
      color: #eee;
      background: #242424;
      border: 1px solid #555;
      border-radius: 8px;
      overflow: hidden;
      box-sizing: border-box;
    }
    #${RESULTS_ID} .caf-clean-results-header {
      padding: 8px 10px;
      background: #303030;
      font-size: 13px;
      font-weight: 700;
    }
    #${RESULTS_ID} .caf-clean-result {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 9px;
      padding: 10px;
      border-top: 1px solid #444;
      box-sizing: border-box;
    }
    #${RESULTS_ID} .caf-clean-image {
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
    #${RESULTS_ID} .caf-clean-image.yellow { border-color: #d8d800; box-shadow: 0 0 8px rgba(216,216,0,.7); }
    #${RESULTS_ID} .caf-clean-image.orange { border-color: #ff8c00; box-shadow: 0 0 8px rgba(255,140,0,.7); }
    #${RESULTS_ID} .caf-clean-image.red { border-color: #d94444; box-shadow: 0 0 8px rgba(217,68,68,.7); }
    #${RESULTS_ID} .caf-clean-image img,
    #${RESULTS_ID} .caf-clean-image canvas {
      max-width: 70px;
      max-height: 50px;
      object-fit: contain;
    }
    #${RESULTS_ID} .caf-clean-item-name {
      color: #6eb6ff;
      font-size: 15px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    #${RESULTS_ID} .caf-clean-quality { color: #c967ff; font-weight: 700; }
    #${RESULTS_ID} .caf-clean-item-line { color: #bbb; line-height: 1.3; }
    #${RESULTS_ID} .caf-clean-item-bid { color: #fff; line-height: 1.4; }
    #${RESULTS_ID} .caf-clean-item-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      margin-top: 7px;
    }
    #${RESULTS_ID} .caf-clean-item-actions button { width: 100%; }
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
    return document.visibilityState === "visible" && document.hasFocus();
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

    if (explicit && explicit.length <= 100 && !/^image$/i.test(explicit)) {
      return explicit.trim();
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
      html.match(/armou?r?yID["'=:\s]+(\d+)/i) ||
      html.match(/data-(?:armou?r?y|item|auction)-id=["']?(\d+)/i) ||
      html.match(/ID["'=:\s]+(\d+)/i);

    return match?.[1] || `${item.name}|${item.damage}|${item.accuracy}|${item.bid}|${index}`;
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
    const item = {
      name: cardName(card, rawLabel),
      damage,
      accuracy,
      quality,
      bid,
      bonuses,
      color: cardColor(card),
      timeText: (source.match(/(?:time\s+left|ends?\s+in)\s*[:\-]?\s*([^\n]+)/i) || [])[1]?.trim() || ""
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

  function renderCompiledResults(items) {
    document.getElementById(RESULTS_ID)?.remove();
    if (!items.length) return;

    const results = document.createElement("section");
    results.id = RESULTS_ID;
    results.innerHTML = `
      <div class="caf-clean-results-header">Compiled Results | ${items.length} item(s) from this loaded page</div>
      <div class="caf-clean-results-body"></div>
    `;
    document.getElementById(PANEL_ID).after(results);
    const body = results.querySelector(".caf-clean-results-body");

    items.forEach(item => {
      const sourceCard = cardById.get(item.id);
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
          ${item.timeText ? `<div class="caf-clean-item-line">Time left: ${escapeHtml(item.timeText)}</div>` : ""}
          <div class="caf-clean-item-actions">
            <button class="caf-clean-history">History + Price Check</button>
            <button class="caf-clean-locate">Show Original</button>
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
  }

  function analyzeCurrentPage() {
    if (!isActiveView()) {
      setStatus("Bring the Auction House page into focus, then try again.", true);
      return [];
    }

    itemById.clear();
    cardById.clear();
    const cards = auctionCards();
    const items = cards.map((card, index) => {
      const item = parseCard(card, index);
      itemById.set(item.id, item);
      cardById.set(item.id, card);
      return item;
    });
    renderCompiledResults(items);

    setStatus(cards.length
      ? `Ready: ${cards.length} currently loaded auction item(s). No additional Torn requests were made.`
      : "No weapon or armor cards are currently rendered. Open an Auction House category or page, then try again.",
      !cards.length
    );
    return items;
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

  function renderHistory(item, sales, box) {
    const prices = sales.map(sale => Number(sale.price || 0)).filter(Boolean);
    if (!prices.length) {
      box.innerHTML = `<span class="caf-clean-muted">No comparable finished sales were found.</span>`;
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
      const sales = await searchHistoryDeep(historyBody(item));
      if (!isActiveView()) throw new Error("History stopped because the Auction House page lost focus");
      renderHistory(item, sales, box);
    } catch (error) {
      box.innerHTML = `<span class="caf-clean-high">History error: ${escapeHtml(error.message)}</span>`;
    } finally {
      button.disabled = false;
      button.textContent = "History + Price Check";
    }
  }

  async function analyzeAllVisibleHistory() {
    const items = analyzeCurrentPage();
    if (!items.length) return;

    const analyzeAllButton = document.getElementById("caf-clean-all-history");
    const resultCards = [...document.querySelectorAll(`#${RESULTS_ID} .caf-clean-result`)];
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
    itemById.clear();
    cardById.clear();
    setStatus("Analysis cleared. Torn's original Auction House page was not changed or reloaded.");
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID) || !document.body) return;
    const current = settings();
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
      <div class="caf-clean-controls">
        <button id="caf-clean-analyze">Compile Loaded Items</button>
        <button id="caf-clean-all-history">Compile + Load History</button>
        <button id="caf-clean-clear">Clear Results</button>
        <button id="caf-clean-cache">Clear History Cache</button>
      </div>
      <div class="caf-clean-disclosure">
        History checks send the visible item's name, stats, quality range, and bonus filters to the external
        btrmmuuoofbonmuwrkzg Supabase history service. No Torn password, session cookie, or API key is sent.
        Results are cached in this browser for five minutes.
      </div>
      <div id="caf-clean-status">Ready. This build makes no scripted requests to Torn.</div>
    `;
    document.body.prepend(panel);

    panel.querySelector("#caf-clean-analyze").addEventListener("click", analyzeCurrentPage);
    panel.querySelector("#caf-clean-all-history").addEventListener("click", analyzeAllVisibleHistory);
    panel.querySelector("#caf-clean-clear").addEventListener("click", clearAnalysis);
    panel.querySelector("#caf-clean-cache").addEventListener("click", () => {
      localStorage.removeItem(CACHE_KEY);
      setStatus("History cache cleared.");
    });
    panel.querySelectorAll("select, input").forEach(element => element.addEventListener("change", saveSettings));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectPanel, { once: true });
  } else {
    injectPanel();
  }
})();
