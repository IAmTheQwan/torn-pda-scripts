// ==UserScript==
// @name         TheQwan CAF History Helper
// @namespace    theqwan.torn.auction-history.caf35
// @version      3.5.6
// @description  Historical comp pricing helper for TheQwan CAF Base
// @author       TheQwan
// @match        https://www.torn.com/amarket.php*
// @match        https://www.torn.com/page.php*
// @grant        GM_xmlhttpRequest
// @connect      btrmmuuoofbonmuwrkzg.supabase.co
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/main/theqwan-caf-helper.meta.js
// @downloadURL  https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/main/theqwan-caf-helper.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SUPABASE_URL = "https://btrmmuuoofbonmuwrkzg.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJIUzI1NiIsInJlZiI6ImJ0cm1tdXVvb2Zib25tdXdya3pnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NTEzMTgsImV4cCI6MjA4NDQyNzMxOH0.E-s0k46BORXLICAvxtEpqoM3Qmh4-TRLaJAwXO6wJTY";

  const SETTINGS_KEY = "caf35HistorySettings";
  const CACHE_KEY = "caf35HistoryCache";

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
    "toxin": 103, "warlord": 81, "weaken": 46, "wind-up": 76, "wither": 42
  };

  const BONUS_IDS_REVERSE = {};
  Object.entries(BONUS_IDS).forEach(([name, id]) => {
    BONUS_IDS_REVERSE[id] = name.replace(/\b\w/g, c => c.toUpperCase());
  });

  const css = document.createElement("style");
  css.textContent = `
    .caf35-btn { margin-top:6px; padding:6px 10px; width:100%; border:none; background:#202020; color:#8ecbff; border-radius:4px; }
    .caf35-line { margin-top:6px; font-size:12px; background:#181818; border:1px solid #444; border-radius:5px; padding:6px; color:#ddd; }
    .caf35-good { color:#30d158; font-weight:bold; }
    .caf35-steal { color:#00ff7f; font-weight:bold; }
    .caf35-fair { color:#ffd166; font-weight:bold; }
    .caf35-high { color:#ff5c5c; font-weight:bold; }
    .caf35-muted { color:#aaa; }
    .caf35-sales { display:none; margin-top:5px; padding-top:5px; border-top:1px solid #333; font-size:11px; color:#bbb; }
    .caf35-sale-row { display:grid; grid-template-columns:70px 55px 1fr 38px; gap:5px; border-bottom:1px solid #292929; padding:3px 0; align-items:center; }
    .caf35-sale-bonus { color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .caf35-setting-label { color:#aaa; font-size:10px; text-transform:uppercase; margin-top:7px; }
    .caf35-mini-row { display:flex; gap:6px; margin-top:4px; align-items:center; }
    .caf35-mini-row input, .caf35-mini-row select { padding:5px; box-sizing:border-box; }

    .caf35-slider-row {
      display:grid;
      grid-template-columns:42px 1fr 48px;
      gap:6px;
      align-items:center;
      margin-top:5px;
    }

    .caf35-slider-row span {
      font-size:11px;
      color:#ccc;
    }

    .caf35-slider-row input[type="range"] {
      width:100%;
    }

    .caf35-range-value {
      color:#8ecbff !important;
      font-size:11px;
      text-align:right;
    }
  `;
  document.head.appendChild(css);

  function prettyBonusName(name) {
    return String(name || "").replace(/\b\w/g, c => c.toUpperCase());
  }

  function bonusOptions() {
    return Object.keys(BONUS_IDS)
      .sort()
      .map(name => `<option value="${name}">${prettyBonusName(name)}</option>`)
      .join("");
  }

  function defaultSettings() {
    return {
      count: 12,

      qualityTolerance: 10,
      bonusTolerance: 10,

      qualityAuto: false,
      qualityMin: 0,
      qualityMax: 200,

      bonusAuto: false,
      bonusMin: 0,
      bonusMax: 150,

      historyBonusMode: "any",
      historySpecificBonus: "",
      historyDoubleOnly: false
    };
  }

  function settings() {
    try {
      return {
        ...defaultSettings(),
        ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
      };
    } catch {
      return defaultSettings();
    }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function cafFilters() {
    return {
      bonus1: document.getElementById("caf-bonus1")?.value || "",
      bonus2: document.getElementById("caf-bonus2")?.value || "",
      onlyDouble: document.getElementById("caf-double")?.checked || false
    };
  }

  function money(n) {
    n = Number(n || 0);
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
    return "$" + n.toLocaleString();
  }

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function daysAgo(ts) {
    if (!ts) return "?d";
    const d = Math.floor((Date.now() - ts * 1000) / 86400000);
    if (d <= 0) return "today";
    return `${d}d`;
  }

  function saleBonuses(a) {
    if (Array.isArray(a.bonus_values) && a.bonus_values.length) {
      return a.bonus_values.map(x => {
        const name = BONUS_IDS_REVERSE[x.bonus_id] || `Bonus ${x.bonus_id}`;
        const value = x.bonus_value ?? "?";
        return `${name} ${value}%`;
      }).join(" / ");
    }

    if (Array.isArray(a.bonus_ids) && a.bonus_ids.length) {
      return a.bonus_ids.map(id => BONUS_IDS_REVERSE[id] || `Bonus ${id}`).join(" / ");
    }

    return "No bonus";
  }

  function saleBonusIds(a) {
    const ids = new Set();

    if (Array.isArray(a.bonus_ids)) {
      a.bonus_ids.forEach(id => ids.add(Number(id)));
    }

    if (Array.isArray(a.bonus_values)) {
      a.bonus_values.forEach(x => ids.add(Number(x.bonus_id)));
    }

    return [...ids].filter(Boolean);
  }

  function saleHasBonus(a, bonusId) {
    return saleBonusIds(a).includes(Number(bonusId));
  }

  function saleIsDouble(a) {
    return saleBonusIds(a).length >= 2;
  }

  function saleBonusValues(a) {
    if (!Array.isArray(a.bonus_values)) return [];
    return a.bonus_values
      .map(x => Number(x.bonus_value))
      .filter(x => !Number.isNaN(x));
  }

  function parseCard(card) {
    const text = card.innerText || "";

    const name = (card.querySelector("div[style*='color:#6eb6ff']")?.textContent || "").trim();
    const dmg = Number((text.match(/Damage:\s*([\d.]+)/i) || [])[1] || 0);
    const acc = Number((text.match(/Accuracy:\s*([\d.]+)/i) || [])[1] || 0);
    const bid = Number((text.match(/Bid:\s*\$([\d,]+)/i) || [])[1]?.replaceAll(",", "") || 0);
    const quality = Number((text.match(/Quality:\s*([\d.]+)/i) || [])[1] || 0);

    const bonusLine = (text.match(/Bonus:\s*(.+)/i) || [])[1] || "";
    const bonuses = bonusLine
      .split("/")
      .map(x => x.trim())
      .filter(x => x && x.toLowerCase() !== "none")
      .map(x => {
        const m = x.match(/^(.+?)\s+([\d.]+)%$/);
        if (!m) return null;
        const name = m[1].trim();
        return { name, id: BONUS_IDS[name.toLowerCase()], value: Number(m[2]) };
      })
      .filter(x => x && x.id);

    return { name, dmg, acc, bid, quality, bonuses };
  }

  function buildSearchBody(data) {
    const s = settings();
    const cf = cafFilters();

    const body = {
      limit: Math.max(Number(s.count || 12), 75),
      offset: 0,
      sort_by: "timestamp",
      sort_order: "desc"
    };

    if (data.name) body.item_name = data.name;

    if (s.qualityAuto) {
      if (data.quality) {
        const qTol = Number(s.qualityTolerance || 10) / 100;
        body.quality_min = Math.max(0, data.quality * (1 - qTol));
        body.quality_max = data.quality * (1 + qTol);
      }
    } else {
      body.quality_min = Number(s.qualityMin ?? 0);
      body.quality_max = Number(s.qualityMax ?? 200);
    }

    let forcedBonusNames = [];
    let forceDouble = !!s.historyDoubleOnly;

    if (s.historyBonusMode === "caf") {
      forcedBonusNames = [cf.bonus1, cf.bonus2].filter(Boolean).map(x => x.toLowerCase());
      forceDouble = forceDouble || !!cf.onlyDouble;
    } else if (s.historyBonusMode === "specific") {
      forcedBonusNames = [String(s.historySpecificBonus || "").toLowerCase()].filter(Boolean);
    } else if (s.historyBonusMode === "item") {
      forcedBonusNames = [];
    } else if (s.historyBonusMode === "any") {
      forcedBonusNames = [];
    }

    const forcedIds = forcedBonusNames
      .map(name => BONUS_IDS[name])
      .filter(Boolean);

    if (s.historyBonusMode === "any") {
      // no bonus restrictions
    } else if (forcedIds.length) {
      forcedIds.slice(0, 2).forEach((id, i) => {
        body[`bonus${i + 1}_id`] = id;
      });
    } else {
      data.bonuses.slice(0, 2).forEach((b, i) => {
        body[`bonus${i + 1}_id`] = b.id;
      });
    }

    if (s.bonusAuto) {
      const sourceBonuses = forcedIds.length
        ? data.bonuses.filter(b => forcedIds.includes(b.id))
        : data.bonuses;

      sourceBonuses.slice(0, 2).forEach((b, i) => {
        if (b.value) {
          const bTol = Number(s.bonusTolerance || 10) / 100;
          body[`bonus${i + 1}_value_min`] = Math.max(0, b.value * (1 - bTol));
          body[`bonus${i + 1}_value_max`] = b.value * (1 + bTol);
        }
      });
    }

    body.__forceDouble = forceDouble;
    body.__forcedBonusIds = forcedIds;
    body.__visibleLimit = Number(s.count || 12);
    body.__manualBonusMin = s.bonusAuto ? null : Number(s.bonusMin ?? 0);
    body.__manualBonusMax = s.bonusAuto ? null : Number(s.bonusMax ?? 150);

    return body;
  }

  function cleanApiBody(body) {
    const clean = { ...body };
    Object.keys(clean).forEach(k => {
      if (k.startsWith("__")) delete clean[k];
    });
    return clean;
  }

  function cacheKey(body) {
    return JSON.stringify(cleanApiBody(body));
  }

  function getCache(key) {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      const hit = all[key];
      if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;
    } catch {}
    return null;
  }

  function setCache(key, data) {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      all[key] = { ts: Date.now(), data };
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch {}
  }

  function apiSearch(body) {
    return new Promise((resolve, reject) => {
      const key = cacheKey(body);
      const cached = getCache(key);
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
          "Authorization": "Bearer " + SUPABASE_ANON_KEY
        },
        data: JSON.stringify(cleanApiBody(body)),
        timeout: 15000,
        onload: res => {
          try {
            const data = JSON.parse(res.responseText);
            if (res.status >= 200 && res.status < 300) {
              setCache(key, data);
              resolve(data);
            } else {
              reject(new Error(data.error || "API error"));
            }
          } catch {
            reject(new Error("Parse error"));
          }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Timeout"))
      });
    });
  }

  function applyHistoryPostFilters(auctions, body) {
    let result = auctions || [];

    const forcedIds = body.__forcedBonusIds || [];

    if (forcedIds.length) {
      result = result.filter(a =>
        forcedIds.every(id => saleHasBonus(a, id))
      );
    }

    if (body.__forceDouble) {
      result = result.filter(saleIsDouble);
    }

    if (body.__manualBonusMin !== null || body.__manualBonusMax !== null) {
      result = result.filter(a => {
        const values = saleBonusValues(a);

        if (!values.length) {
          return Number(body.__manualBonusMin || 0) <= 0;
        }

        return values.some(v =>
          (body.__manualBonusMin === null || v >= body.__manualBonusMin) &&
          (body.__manualBonusMax === null || v <= body.__manualBonusMax)
        );
      });
    }

    return result.slice(0, body.__visibleLimit || settings().count || 12);
  }

  function dealClass(bid, low, med, high) {
    if (!bid || !med) return ["caf35-muted", "?"];
    if (bid < low) return ["caf35-steal", "STEAL"];
    if (bid < med) return ["caf35-good", "GOOD"];
    if (bid <= high) return ["caf35-fair", "FAIR"];
    return ["caf35-high", "HIGH"];
  }

  function renderHistory(card, auctions, bid) {
    const prices = auctions.map(a => Number(a.price || 0)).filter(Boolean);
    let box = card.querySelector(".caf35-line");

    if (!box) {
      box = document.createElement("div");
      box.className = "caf35-line";
      card.querySelector(".caf35-btn")?.after(box);
    }

    if (!prices.length) {
      box.innerHTML = `<span class="caf35-muted">No comparable sales found.</span>`;
      return;
    }

    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const med = median(prices);
    const [cls, label] = dealClass(bid, low, med, high);

    box.innerHTML = `
      <div>
        <span class="${cls}">Bid ${money(bid)} ${label}</span>
        <span class="caf35-muted"> | </span>
        <span style="color:#7ee787;">L ${money(low)}</span>
        <span class="caf35-muted"> | </span>
        <span style="color:#b98cff;">M ${money(med)}</span>
        <span class="caf35-muted"> | </span>
        <span style="color:#ff8b8b;">H ${money(high)}</span>
        <span class="caf35-muted"> | ${auctions.length}x</span>
      </div>

      <button class="caf35-toggle" style="margin-top:4px;width:100%;background:#222;color:#ccc;border:1px solid #444;border-radius:4px;">
        Previous Sales ▼
      </button>

      <div class="caf35-sales">
        ${auctions.map(a => {
          const q = a.stat_quality ? `${Number(a.stat_quality).toFixed(1)}Q` : "?Q";
          const b = saleBonuses(a);
          return `
            <div class="caf35-sale-row">
              <span>${money(a.price)}</span>
              <span>${q}</span>
              <span class="caf35-sale-bonus" title="${escapeHtml(b)}">${escapeHtml(b)}</span>
              <span>${daysAgo(a.timestamp)}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;

    box.querySelector(".caf35-toggle").onclick = () => {
      const sales = box.querySelector(".caf35-sales");
      sales.style.display = sales.style.display === "block" ? "none" : "block";
    };
  }

  async function runHistory(card, btn) {
    const data = parseCard(card);
    const body = buildSearchBody(data);

    btn.textContent = "Checking...";
    btn.disabled = true;

    try {
      const result = await apiSearch(body);
      const auctions = applyHistoryPostFilters(result.auctions || [], body);

      const s = settings();
      const cf = cafFilters();

      if (
        s.historyBonusMode === "caf" &&
        !cf.bonus1 &&
        !cf.bonus2
      ) {
        let box = card.querySelector(".caf35-line");

        if (!box) {
          box = document.createElement("div");
          box.className = "caf35-line";
          btn.after(box);
        }

        box.innerHTML = `<span class="caf35-muted">No CAF Bonuses set.</span>`;
      } else {
        renderHistory(card, auctions, data.bid);
      }
    } catch (e) {
      let box = card.querySelector(".caf35-line");
      if (!box) {
        box = document.createElement("div");
        box.className = "caf35-line";
        btn.after(box);
      }
      box.innerHTML = `<span class="caf35-high">History error: ${e.message}</span>`;
    }

    btn.textContent = "History";
    btn.disabled = false;
  }

  function modeLabel(mode) {
    if (mode === "caf") return "CAF";
    if (mode === "item") return "ITEM";
    if (mode === "specific") return "SPECIFIC";
    return "ANY";
  }

  function updateSettingsSummary() {
    const s = settings();
    const el = document.getElementById("caf35-settings-summary");
    if (!el) return;

    el.innerHTML = `
      Q ${Number(s.qualityMin ?? 0)}-${Number(s.qualityMax ?? 200)} |
      B ${Number(s.bonusMin ?? 0)}-${Number(s.bonusMax ?? 150)}% |
      Mode ${modeLabel(s.historyBonusMode || "any")} |
      Sales ${s.count}
    `;
  }

  function injectSettings() {
    const panel = document.getElementById("josh-condensed-auction-filter");
    if (!panel || panel.querySelector("#caf35-settings")) return;

    const s = settings();

    const div = document.createElement("div");
    div.id = "caf35-settings";
    div.style.cssText = "margin-top:8px;padding:8px;background:#181818;border:1px solid #444;border-radius:6px;color:#ccc;font-size:12px;";
    div.innerHTML = `
      <button id="caf35-settings-toggle" style="width:100%;background:#202020;color:#8ecbff;border:1px solid #444;border-radius:5px;padding:6px;">
        History Settings ▶
      </button>

      <div id="caf35-settings-summary" style="margin-top:5px;color:#aaa;font-size:11px;text-align:center;">
        Q ${Number(s.qualityMin ?? 0)}-${Number(s.qualityMax ?? 200)} |
        B ${Number(s.bonusMin ?? 0)}-${Number(s.bonusMax ?? 150)}% |
        Mode ${modeLabel(s.historyBonusMode || "any")} |
        Sales ${s.count}
      </div>

      <div id="caf35-settings-body" style="display:none;margin-top:8px;">
        <div class="caf35-setting-label">Sales Used</div>
        <div class="caf35-mini-row">
          <input id="caf35-count" type="number" min="1" max="50" value="${s.count}" style="width:100%;">
        </div>

        <div class="caf35-setting-label">Quality Range</div>
        <div class="caf35-slider-row">
          <span>Min</span>
          <input id="caf35-qmin" type="range" min="0" max="200" step="1" value="${Number(s.qualityMin ?? 0)}">
          <span id="caf35-qmin-val" class="caf35-range-value">${Number(s.qualityMin ?? 0)}</span>
        </div>
        <div class="caf35-slider-row">
          <span>Max</span>
          <input id="caf35-qmax" type="range" min="0" max="200" step="1" value="${Number(s.qualityMax ?? 200)}">
          <span id="caf35-qmax-val" class="caf35-range-value">${Number(s.qualityMax ?? 200)}</span>
        </div>

        <div class="caf35-setting-label">Bonus % Range</div>
        <div class="caf35-slider-row">
          <span>Min</span>
          <input id="caf35-bmin" type="range" min="0" max="150" step="1" value="${Number(s.bonusMin ?? 0)}">
          <span id="caf35-bmin-val" class="caf35-range-value">${Number(s.bonusMin ?? 0)}%</span>
        </div>
        <div class="caf35-slider-row">
          <span>Max</span>
          <input id="caf35-bmax" type="range" min="0" max="150" step="1" value="${Number(s.bonusMax ?? 150)}">
          <span id="caf35-bmax-val" class="caf35-range-value">${Number(s.bonusMax ?? 150)}%</span>
        </div>

        <div class="caf35-setting-label">History Bonus Match</div>
        <select id="caf35-bonus-mode" style="width:100%;padding:5px;margin-top:4px;">
          <option value="item">Use item bonuses</option>
          <option value="caf">Use CAF filter bonus/double</option>
          <option value="specific">Use specific bonus below</option>
          <option value="any">Any bonus history</option>
        </select>

        <select id="caf35-specific-bonus" style="width:100%;padding:5px;margin-top:6px;">
          <option value="">Specific bonus...</option>
          ${bonusOptions()}
        </select>

        <label style="display:block;margin-top:6px;">
          <input id="caf35-double-only" type="checkbox">
          History double-bonus sales only
        </label>
      </div>
    `;

    panel.appendChild(div);

    document.getElementById("caf35-settings-toggle").onclick = () => {
      const body = document.getElementById("caf35-settings-body");
      const toggle = document.getElementById("caf35-settings-toggle");

      const open = body.style.display === "block";
      body.style.display = open ? "none" : "block";
      toggle.textContent = open ? "History Settings ▶" : "History Settings ▼";
    };

    document.getElementById("caf35-bonus-mode").value = s.historyBonusMode || "any";
    document.getElementById("caf35-specific-bonus").value = s.historySpecificBonus || "";
    document.getElementById("caf35-double-only").checked = !!s.historyDoubleOnly;

    [
      "caf35-count",
      "caf35-qmin", "caf35-qmax",
      "caf35-bmin", "caf35-bmax",
      "caf35-bonus-mode", "caf35-specific-bonus", "caf35-double-only"
    ].forEach(id => {
      const el = document.getElementById(id);
      el.oninput = () => {
        normalizeSliders();
        saveSettingsFromInputs();
        updateSettingsSummary();
      };
      el.onchange = () => {
        normalizeSliders();
        saveSettingsFromInputs();
        updateSettingsSummary();
      };
    });

    normalizeSliders();
    saveSettingsFromInputs();
    updateSettingsSummary();
  }

  function normalizeSliders() {
    const qMin = document.getElementById("caf35-qmin");
    const qMax = document.getElementById("caf35-qmax");
    const bMin = document.getElementById("caf35-bmin");
    const bMax = document.getElementById("caf35-bmax");

    if (qMin && qMax && Number(qMin.value) > Number(qMax.value)) {
      qMax.value = qMin.value;
    }

    if (bMin && bMax && Number(bMin.value) > Number(bMax.value)) {
      bMax.value = bMin.value;
    }

    const qMinVal = document.getElementById("caf35-qmin-val");
    const qMaxVal = document.getElementById("caf35-qmax-val");
    const bMinVal = document.getElementById("caf35-bmin-val");
    const bMaxVal = document.getElementById("caf35-bmax-val");

    if (qMinVal) qMinVal.textContent = qMin?.value ?? "0";
    if (qMaxVal) qMaxVal.textContent = qMax?.value ?? "200";
    if (bMinVal) bMinVal.textContent = `${bMin?.value ?? "0"}%`;
    if (bMaxVal) bMaxVal.textContent = `${bMax?.value ?? "150"}%`;
  }

  function saveSettingsFromInputs() {
    saveSettings({
      count: Number(document.getElementById("caf35-count").value || 12),

      qualityAuto: false,
      qualityTolerance: 10,
      qualityMin: Number(document.getElementById("caf35-qmin").value || 0),
      qualityMax: Number(document.getElementById("caf35-qmax").value || 200),

      bonusAuto: false,
      bonusTolerance: 10,
      bonusMin: Number(document.getElementById("caf35-bmin").value || 0),
      bonusMax: Number(document.getElementById("caf35-bmax").value || 150),

      historyBonusMode: document.getElementById("caf35-bonus-mode").value || "any",
      historySpecificBonus: document.getElementById("caf35-specific-bonus").value || "",
      historyDoubleOnly: document.getElementById("caf35-double-only").checked || false
    });
  }

  function injectButtons() {
    injectSettings();

    document.querySelectorAll(".caf-open").forEach(openBtn => {
      const card = openBtn.closest("div[style*='display:flex']");
      if (!card || card.querySelector(".caf35-btn")) return;

      const btn = document.createElement("button");
      btn.className = "caf35-btn";
      btn.textContent = "History";

      btn.onclick = e => {
        e.preventDefault();
        e.stopPropagation();
        runHistory(card, btn);
      };

      openBtn.after(btn);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c]));
  }

  setInterval(injectButtons, 1000);
})();
