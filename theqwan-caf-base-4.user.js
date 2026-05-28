// ==UserScript==
// @name         TheQwan CAF Base 4.0 Beta
// @namespace    theqwan.torn.auction-filter.caf4
// @version      4.1.0.9
// @description  Global CAF watch banner with auction filter/history/watch system
// @author       TheQwan [3485263]
// @match        https://www.torn.com/*
// @match        https://www.torn.com/amarket.php*
// @match        https://www.torn.com/page.php*
// @grant        GM_xmlhttpRequest
// @connect      btrmmuuoofbonmuwrkzg.supabase.co
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/main/theqwan-caf-base-4.meta.js
// @downloadURL  https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/main/theqwan-caf-base-4.user.js
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "josh-condensed-auction-filter";
  const RESULTS_ID = "josh-condensed-auction-results";
  const STORAGE_KEY = "joshCondensedAuctionFilters";
  const AUTO_FILTER_KEY = "joshAuctionAutoFilterOriginal";
  const ALL_ITEMS_KEY = "joshCondensedAuctionAllItems";
  const FILTERED_ITEMS_KEY = "joshCondensedAuctionFilteredItems";
  const CURRENT_PAGE_KEY = "joshCondensedAuctionCurrentPage";
  const QUALITY_CACHE_KEY = "joshAuctionQualityCache";
  const FILTER_COLLAPSED_KEY = "joshCaf3AdvancedCollapsedV344";
const RESULTS_COLLAPSED_KEY = "joshAuctionResultsCollapsed";

  const TARGET_START_KEY = "joshAuctionTargetStart";
  const TARGET_NAME_KEY = "joshAuctionTargetName";
  const TARGET_DMG_KEY = "joshAuctionTargetDmg";
  const TARGET_ACC_KEY = "joshAuctionTargetAcc";
  const TARGET_BID_KEY = "joshAuctionTargetBid";

  const WATCHLIST_KEY = "joshAuctionWatchList";
  const WATCHLIST_COLLAPSED_KEY = "joshAuctionWatchCollapsed";
  const WATCH_REFRESH_MS = 5000;

  const GLOBAL_WATCH_BAR_ID = "theqwan-global-watch-bar";
  const GLOBAL_WATCH_COLLAPSED_KEY = "theqwanGlobalWatchCollapsed";

  const TARGET_ONLY_KEY = "joshAuctionTargetOnly";
  const TARGET_ID_KEY = "joshAuctionTargetId";

  const PAGE_SIZE = 10;

  let allItems = [];
  let filteredItems = [];
  let currentPage = 1;
  let loading = false;
  let qualityLoading = false;

  const bonuses = [
    "", "Achilles", "Assassinate", "Backstab", "Berserk", "Bleed", "Blindside",
    "Bloodlust", "Burn", "Comeback", "Conserve", "Crusher", "Deadeye",
    "Deadly", "Demoralize", "Disarm", "Double Tap", "Double-edged", "Empower",
    "Eviscerate", "Execute", "Expose", "Finale", "Focus", "Frenzy",
    "Fury", "Grace", "Homerun", "Hazardous", "Irradiate", "Lacerate", "Motivation",
    "Parry", "Penetrate", "Plunder", "Poison", "Powerful", "Proficience",
    "Quicken", "Rage", "Revitalize", "Slow", "Smash", "Specialist",
    "Spray", "Stun", "Sure Shot", "Throttle", "Toxin", "Weaken",
    "Wind-up", "Wither", "Warlord"
  ];

  const colors = ["", "None", "Yellow", "Orange", "Red"];

  const css = document.createElement("style");
  css.textContent = `
    .caf3-card {
      margin:10px 0;
      padding:10px;
      background:#222;
      color:#fff;
      border:1px solid #555;
      border-radius:8px;
      font-size:13px;
    }
    .caf3-header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
    }
    .caf3-collapse-btn {
      background:#111;
      color:#8ecbff;
      border:1px solid #444;
      border-radius:5px;
      padding:4px 8px;
      font-size:12px;
    }
    .caf3-advanced.collapsed {
      display:none;
    }
    .caf-img-wrap {
      width:78px;
      min-width:78px;
      height:58px;
      display:flex;
      align-items:center;
      justify-content:center;
      background:#111;
      border-radius:6px;
      border:3px solid #777;
      box-sizing:border-box;
    }
    .caf-img-wrap.yellow { border-color:#d8d800; box-shadow:0 0 8px rgba(216,216,0,.75); }
    .caf-img-wrap.orange { border-color:#ff8c00; box-shadow:0 0 8px rgba(255,140,0,.75); }
    .caf-img-wrap.red { border-color:#d94444; box-shadow:0 0 8px rgba(217,68,68,.75); }
    .caf-img-wrap img {
      width:70px;
      height:50px;
      object-fit:contain;
    }
    .caf-quality {
      color:#c967ff;
      font-weight:bold;
    }
    .caf3-slider-row {
      display:grid;
      grid-template-columns:58px 1fr 52px;
      gap:6px;
      align-items:center;
      margin-top:5px;
    }
    .caf3-slider-row span {
      font-size:11px;
      color:#ccc;
    }
    .caf3-slider-row input[type="range"] {
      width:100%;
    }
    .caf3-range-value {
      color:#8ecbff !important;
      font-size:11px;
      text-align:right;
    }
  `;
  document.head.appendChild(css);

  hookQualityResponses();

  function defaultFilters() {
    return {
      name: "",
      minDmg: 0,
      minAcc: 0,
      maxBid: 0,
      bonus1: "",
      bonus2: "",
      onlyDouble: false,
      color: "",
      qualityMin: 0,
      qualityMax: 200,
      bonusMin: 0,
      bonusMax: 150
    };
  }

  function isAuctionPage() {
    return document.body.innerText.includes("Auction House");
  }

  function options(label) {
    return bonuses.map(b =>
      b ? `<option value="${b}">${b}</option>` : `<option value="">${label}</option>`
    ).join("");
  }

  function colorOptions() {
    return colors.map(c =>
      c ? `<option value="${c}">${c}</option>` : `<option value="">Any Color</option>`
    ).join("");
  }

  function getFilters() {
    return {
      name: document.getElementById("caf-name")?.value.toLowerCase() || "",
      minDmg: Number(document.getElementById("caf-dmg")?.value || 0),
      minAcc: Number(document.getElementById("caf-acc")?.value || 0),
      maxBid: Number(document.getElementById("caf-bid")?.value || 0),
      bonus1: document.getElementById("caf-bonus1")?.value || "",
      bonus2: document.getElementById("caf-bonus2")?.value || "",
      onlyDouble: document.getElementById("caf-double")?.checked || false,
      color: document.getElementById("caf-color")?.value || "",
      qualityMin: Number(document.getElementById("caf-qmin")?.value || 0),
      qualityMax: Number(document.getElementById("caf-qmax")?.value || 200),
      bonusMin: Number(document.getElementById("caf-bmin")?.value || 0),
      bonusMax: Number(document.getElementById("caf-bmax")?.value || 150)
    };
  }

  function saveFilters() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getFilters()));
  }

  function loadFilters() {
    try {
      return {
        ...defaultFilters(),
        ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
      };
    } catch {
      return defaultFilters();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(ALL_ITEMS_KEY, JSON.stringify(allItems));
      localStorage.setItem(FILTERED_ITEMS_KEY, JSON.stringify(filteredItems));
      localStorage.setItem(CURRENT_PAGE_KEY, String(currentPage || 1));
    } catch {}
  }

  function restoreState() {
    try {
      allItems = JSON.parse(localStorage.getItem(ALL_ITEMS_KEY) || "[]");
      filteredItems = JSON.parse(localStorage.getItem(FILTERED_ITEMS_KEY) || "[]");
      currentPage = Number(localStorage.getItem(CURRENT_PAGE_KEY) || 1);
    } catch {
      allItems = [];
      filteredItems = [];
      currentPage = 1;
    }
  }

function loadWatchList() {
  try {
    return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveWatchList(list) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

function watchId(item) {
  return String(
    item.armouryID ||
    item.armoryID ||
    item.ID ||
    `${item.name}_${itemDamage(item)}_${itemAccuracy(item)}_${item.__auctionStart || 0}`
  );
}

function isWatched(item) {
  return loadWatchList().some(x => x.id === watchId(item));
}

function toggleWatch(item) {
  const list = loadWatchList();
  const id = watchId(item);
  const existing = list.findIndex(x => x.id === id);

  if (existing >= 0) {
    list.splice(existing, 1);
  } else {
    list.push({
      id,
      auctionStart: item.__auctionStart || 0,
      item
    });
  }

saveWatchList(list);
renderWatchList();
renderGlobalWatchBar();
renderPage(currentPage || 1);
}

function watchedPageStarts() {
  return [...new Set(loadWatchList().map(x => Number(x.auctionStart || 0)))];
}

  function isSoldItem(item) {
  return !!item?.__sold;
}
  
function renderGlobalWatchBar() {

  markExpiredWatchedItems();
  
  let bar = document.getElementById(GLOBAL_WATCH_BAR_ID);

  if (!bar) {
    bar = document.createElement("div");
    bar.id = GLOBAL_WATCH_BAR_ID;
   bar.style.cssText = `
      position:sticky;
      bottom:0;
      z-index:20;
      margin-top:10px;
      background:#181818;
      border:1px solid #555;
      border-radius:9px 9px 0 0;
      box-shadow:0 -2px 10px rgba(0,0,0,.45);
      color:#fff;
      font-size:10px;
      overflow:hidden;
    `;
      const appRoot =
  document.querySelector("#mainContainer") ||
  document.querySelector("#mainContainerWrap") ||
  document.querySelector(".content-wrapper") ||
  document.querySelector("#body") ||
  document.body;

appRoot.appendChild(bar);
  }

  const list = loadWatchList();
  const collapsed = localStorage.getItem(GLOBAL_WATCH_COLLAPSED_KEY) === "true";

  const closest = list
  .map(w => w.item)
  .filter(Boolean)
  .filter(item => !isSoldItem(item))
  .sort((a, b) => Number(a.__endsAtMs || 0) - Number(b.__endsAtMs || 0))[0];
  
  bar.innerHTML = `
    <div id="theqwan-global-watch-header"
      style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 7px;background:#252525;cursor:pointer;">
      <b>${collapsed ? "CAF ▶" : "CAF Watch ▼"}</b>
        <span style="flex:1;text-align:center;color:#ffcf70;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${
            closest
              ? `${escapeHtml(closest.name || closest.itemName || "Item")} | Bid $${Number(itemBid(closest) || 0).toLocaleString()} | <span class="caf-countdown" data-ends-at="${closest.__endsAtMs || 0}">${formatCountdownShort(closest.__endsAtMs || Date.now())}</span>`
              : "No watched items"
          }
        </span>
      <button id="theqwan-global-watch-go"
        style="padding:3px 8px;border:1px solid #555;border-radius:5px;background:#111;color:#8ecbff;">
        Go
      </button>
    </div>

    <div style="display:${collapsed ? "none" : "flex"};align-items:center;gap:6px;padding:6px;overflow-x:auto;">
      ${
        list.length
          ? list.map(w => renderGlobalWatchIcon(w.item)).join("")
          : `<span style="color:#aaa;">No watched items.</span>`
      }
    </div>
  `;

  document.getElementById("theqwan-global-watch-header").onclick = e => {
    if (e.target.id === "theqwan-global-watch-go") return;
    localStorage.setItem(GLOBAL_WATCH_COLLAPSED_KEY, collapsed ? "false" : "true");
    renderGlobalWatchBar();
  };

  document.getElementById("theqwan-global-watch-go").onclick = e => {
    e.preventDefault();
    e.stopPropagation();

    if (closest) jumpToWatchedItem(closest);
    else window.location.assign("https://www.torn.com/amarket.php#itemtab=weapons");
  };

  bar.querySelectorAll(".theqwan-watch-jump").forEach(btn => {
    btn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();

      const id = btn.getAttribute("data-watch-id");
      const watched = loadWatchList().find(w => w.id === id);

      if (watched?.item) jumpToWatchedItem(watched.item);
    };
  });
}

function renderGlobalWatchIcon(item) {
  const name = item.name || item.itemName || "Unknown";
  const glow = itemGlowClass(item);
  const dmg = itemDamage(item);
  const acc = itemAccuracy(item);
  const bid = itemBid(item);
  const deal = item.__dealState || estimateDealState(item);
  
  return `
    <button class="theqwan-watch-jump"
      title="${escapeAttr(name)}"
      data-watch-id="${watchId(item)}"
      style="border:none;background:transparent;padding:0;">
      <div class="caf-img-wrap ${glow}"
        style="width:32px;min-width:32px;height:26px;border-width:2px;outline:${dealOutline(deal)};">
        <img src="${item.image || item.itemImg || item.itemSrc || ""}" style="width:28px;height:20px;">
      </div>
        <div style="font-size:8px;color:#ffcf70;text-align:center;margin-top:1px;">
        ${
          isSoldItem(item)
            ? `<span style="color:#ff6b6b;font-weight:bold;">
                SOLD $${Number(item.__soldPrice || itemBid(item) || 0).toLocaleString()}
              </span>`
            : `
              <span class="caf-countdown" data-ends-at="${item.__endsAtMs || 0}">
                ${formatCountdownShort(item.__endsAtMs || Date.now())}
              </span>
            `
        }
        </div>
    </button>
  `;
}

async function jumpToWatchedItem(item) {
  const freshItem = await findCurrentAuctionStartForWatchedItem(item);

  const name = freshItem.name || freshItem.itemName || "Unknown";
  const dmg = itemDamage(freshItem);
  const acc = itemAccuracy(freshItem);
  const bid = itemBid(freshItem);
  const start = freshItem.__auctionStart || 0;

  const list = loadWatchList();
  const id = watchId(item);
  const row = list.find(w => w.id === id);

  if (row) {
    row.auctionStart = start;
    row.item = freshItem;
    saveWatchList(list);
  }

  localStorage.removeItem("joshAuctionTargetScrolled");
  localStorage.setItem(AUTO_FILTER_KEY, "1");
  localStorage.setItem(TARGET_START_KEY, String(start));
  localStorage.setItem(TARGET_NAME_KEY, name.toLowerCase());
  localStorage.setItem(TARGET_DMG_KEY, dmg.toFixed(2));
  localStorage.setItem(TARGET_ACC_KEY, acc.toFixed(2));
  localStorage.setItem(TARGET_BID_KEY, String(bid));
  localStorage.setItem(TARGET_ONLY_KEY, "1");
  localStorage.setItem(TARGET_ID_KEY, watchId(freshItem));
  localStorage.setItem("joshAuctionPendingJump", "1");

  const targetUrl = `https://www.torn.com/amarket.php#itemtab=weapons&start=${start}`;

window.location.href = targetUrl;

setTimeout(() => {
  window.location.reload();
}, 250);
}

function dealOutline(deal) {
  if (deal === "steal") return "2px solid #00ff7f";
  if (deal === "good") return "2px solid #30d158";
  if (deal === "fair") return "2px solid #ffd166";
  if (deal === "bad") return "2px solid #ff5c5c";
  return "none";
}
  
  function estimateDealState(item) {
  const bid = itemBid(item);
  const f = loadFilters();

  if (!bid || !f.maxBid) return "unknown";

  const max = Number(f.maxBid);

  if (bid <= max * 0.60) return "steal";
  if (bid <= max * 0.85) return "good";
  if (bid <= max) return "fair";

  return "bad";
}

async function findCurrentAuctionStartForWatchedItem(item) {

  const targetName = (item.name || item.itemName || "").toLowerCase();
  const targetDmg = itemDamage(item);
  const targetAcc = itemAccuracy(item);

  const savedStart = Number(item.__auctionStart || 0);

  const candidates = [
    savedStart,
    savedStart - 10,
    savedStart - 20,
    savedStart + 10,
    savedStart + 20,
    savedStart - 30,
    savedStart + 30,
    savedStart - 40,
    savedStart + 40
  ]
    .filter(x => x >= 0)
    .filter((x, i, arr) => arr.indexOf(x) === i);

  for (const start of candidates) {

    try {

      const data = await fetchAuctionPage(start);

      if (!data?.success || !Array.isArray(data.list)) {
        continue;
      }

      const found = data.list.find(x => {

        const name = (x.name || x.itemName || "").toLowerCase();

        return (
          name === targetName &&
          Math.abs(itemDamage(x) - targetDmg) < 0.15 &&
          Math.abs(itemAccuracy(x) - targetAcc) < 0.15
        );

      });

      if (found) {
        found.__auctionStart = start;
        return found;
      }

    } catch {}

  }

  return item;
}

  async function refreshWatchListPages() {

  const list = loadWatchList();

  if (!list.length) return;

  let changed = false;

  for (const row of list) {

    if (!row.item) continue;

    // skip sold items
    if (row.item.__sold) continue;

    try {

      const refreshed = await findCurrentAuctionStartForWatchedItem(row.item);

      if (!refreshed) continue;

      const oldStart = Number(row.item.__auctionStart || 0);
      const newStart = Number(refreshed.__auctionStart || 0);

      const refreshedEnd = Number(refreshed.__endsAtMs || 0);
      const existingEnd = Number(row.item.__endsAtMs || 0);
      
      if (!refreshedEnd && existingEnd) {
        refreshed.__endsAtMs = existingEnd;
      }
      else if (refreshedEnd && existingEnd) {
      
        // preserve the EARLIEST known ending
        refreshed.__endsAtMs = Math.min(refreshedEnd, existingEnd);
      }

      // preserve sold state
      refreshed.__sold = row.item.__sold;
      refreshed.__soldPrice = row.item.__soldPrice;

      row.item = refreshed;
      row.auctionStart = newStart;

      if (oldStart !== newStart) {
        changed = true;
      }

      // mark sold
      if (
        refreshed.__endsAtMs &&
        refreshed.__endsAtMs <= Date.now()
      ) {
        refreshed.__sold = true;
        refreshed.__soldPrice = itemBid(refreshed);
        changed = true;
      }

    } catch {}

  }

if (changed) {
  saveWatchList(list);
  renderWatchList();
  renderGlobalWatchBar();
}

  }

function renderWatchList() {
  let box = document.getElementById("caf-watchlist");

  if (!box) {
    box = document.createElement("div");
    box.id = "caf-watchlist";
    box.style.marginTop = "10px";

    const target = document.getElementById(RESULTS_ID) || document.getElementById(PANEL_ID);
    if (target) target.after(box);
  }

  const list = loadWatchList();
  const collapsed = localStorage.getItem(WATCHLIST_COLLAPSED_KEY) !== "false";

  let closest = null;
  list.forEach(w => {
    const end = Number(w.item?.__endsAtMs || 0);
    if (end && (!closest || end < closest)) closest = end;
  });

  box.innerHTML = `
    <div style="background:#222;border:1px solid #555;border-radius:8px;overflow:hidden;">
      <div id="caf-watch-header"
        style="padding:8px;background:#333;color:#fff;font-weight:bold;cursor:pointer;">
        Watch List ${collapsed ? "▶" : "▼"} | ${list.length} items | Closest:
        <span class="caf-countdown" data-ends-at="${closest || 0}">
          ${closest ? formatCountdown(closest) : "--"}
        </span>
      </div>

      <div id="caf-watch-body" style="display:${collapsed ? "none" : "block"};">
        ${
          list.length
            ? list.map(w => renderWatchItem(w.item)).join("")
            : `<div style="padding:10px;color:#aaa;">No watched items.</div>`
        }
      </div>
    </div>
  `;

  document.getElementById("caf-watch-header").onclick = () => {
    localStorage.setItem(WATCHLIST_COLLAPSED_KEY, collapsed ? "false" : "true");
    renderWatchList();
  };

  bindWatchListButtons();
}

function renderWatchItem(item) {
  const id = watchId(item);
  const name = item.name || item.itemName || "Unknown";
  const dmg = itemDamage(item);
  const acc = itemAccuracy(item);
  const bid = itemBid(item);
  const bonusesText = itemBonusDetails(item).join(" / ") || "None";
  const glow = itemGlowClass(item);
  const q = itemQuality(item);
  const deal = item.__dealState || "unknown";

  return `
    <div style="display:flex;gap:10px;padding:10px;border-top:1px solid #444;color:#fff;">
      <div class="caf-img-wrap ${glow}">
        <img src="${item.image || item.itemImg || item.itemSrc || ""}">
      </div>

      <div style="flex:1;">
        <div style="color:#6eb6ff;font-weight:bold;">${escapeHtml(name)}</div>
              <div style="margin-top:4px;font-weight:bold;color:
              ${deal === "steal" ? "#00ff7f" :
                deal === "good" ? "#30d158" :
                deal === "fair" ? "#ffd166" :
                deal === "bad" ? "#ff5c5c" :
                "#888"};">
              ${deal.toUpperCase()}
            </div>
        ${q ? `<div class="caf-quality">Quality: ${escapeHtml(q.value)}</div>` : ""}
        <div style="color:#ccc;">Damage: ${dmg.toFixed(2)} | Accuracy: ${acc.toFixed(2)}</div>
        <div style="color:#aaa;">Bonus: ${escapeHtml(bonusesText)}</div>
        <div>Bid: $${Number(bid || 0).toLocaleString()}</div>
        <div style="color:#ffcf70;">
          Time left:
          <span class="caf-countdown" data-ends-at="${item.__endsAtMs || 0}">
            ${formatCountdown(item.__endsAtMs || Date.now())}
          </span>
        </div>

      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
          <button class="caf-open"
            data-watch-id="${id}"
            data-start="${item.__auctionStart || 0}"
            data-name="${escapeAttr(name.toLowerCase())}"
            data-dmg="${dmg.toFixed(2)}"
            data-acc="${acc.toFixed(2)}"
            data-bid="${bid}"
            style="width:100%;padding:6px;">
            Open Original Page
          </button>

          <button class="caf-watch-history"
            data-watch-id="${id}"
            style="width:100%;padding:6px;background:#202020;color:#8ecbff;border:1px solid #444;border-radius:4px;">
            History
          </button>
          
          <div class="caf-history-box caf35-line"
            data-watch-id="${id}"
            style="display:none;margin-top:6px;font-size:12px;background:#181818;border:1px solid #444;border-radius:5px;padding:6px;color:#ddd;">
          </div>

        <button class="caf-unwatch"
          data-watch-id="${watchId(item)}"
          style="width:100%;padding:6px;background:#3a1d1d;color:#ff9b9b;">
          Remove
        </button>
        </div>
      </div>
    </div>
  `;
}

function updateWatchListOnly() {
  const list = loadWatchList();
  const header = document.getElementById("caf-watch-header");
  const body = document.getElementById("caf-watch-body");

  let closest = null;

  list.forEach(w => {
    const end = Number(w.item?.__endsAtMs || 0);
    if (end && (!closest || end < closest)) closest = end;
  });

  if (header) {
    const collapsed = localStorage.getItem(WATCHLIST_COLLAPSED_KEY) !== "false";

    header.innerHTML = `
      Watch List ${collapsed ? "▶" : "▼"} | ${list.length} items | Closest:
      <span class="caf-countdown" data-ends-at="${closest || 0}">
        ${closest ? formatCountdown(closest) : "--"}
      </span>
    `;
  }

  if (!body) return;

  body.querySelectorAll(".caf-countdown").forEach(el => {
    const endMs = Number(el.getAttribute("data-ends-at") || 0);
    if (endMs) el.textContent = formatCountdown(endMs);
  });
}

function bindWatchListButtons() {
  const body = document.getElementById("caf-watch-body");
  if (!body) return;

body.querySelectorAll(".caf-open").forEach(btn => {
  btn.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();

    const id = btn.getAttribute("data-watch-id");

    const watched = loadWatchList().find(x => x.id === id);

    if (!watched?.item) return;

    await jumpToWatchedItem(watched.item);
  };
});

  body.querySelectorAll(".caf-watch-history").forEach(btn => {
  btn.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();

    const id = btn.getAttribute("data-watch-id");
    const watched = loadWatchList().find(x => x.id === id);

    if (!watched?.item) return;

    const historyBox = body.querySelector(
      `.caf-history-box[data-watch-id="${CSS.escape(id)}"]`
    );

    if (historyBox) {
      historyBox.style.display =
        historyBox.style.display === "none" ? "block" : "none";
    }

    await cafHistoryRun(watched.item, body);
  };
});

  body.querySelectorAll(".caf-unwatch").forEach(btn => {
    btn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();

      const id = btn.getAttribute("data-watch-id");
      saveWatchList(loadWatchList().filter(x => x.id !== id));
      
      renderWatchList();
      renderGlobalWatchBar();
    };
  });
}
  function restoreFilters() {
    const f = loadFilters();

    document.getElementById("caf-name").value = f.name || "";
    document.getElementById("caf-dmg").value = f.minDmg || "";
    document.getElementById("caf-acc").value = f.minAcc || "";
    document.getElementById("caf-bid").value = f.maxBid || "";
    document.getElementById("caf-bonus1").value = f.bonus1 || "";
    document.getElementById("caf-bonus2").value = f.bonus2 || "";
    document.getElementById("caf-double").checked = !!f.onlyDouble;
    document.getElementById("caf-color").value = f.color || "";

    document.getElementById("caf-qmin").value = Number(f.qualityMin ?? 0);
    document.getElementById("caf-qmax").value = Number(f.qualityMax ?? 200);
    document.getElementById("caf-bmin").value = Number(f.bonusMin ?? 0);
    document.getElementById("caf-bmax").value = Number(f.bonusMax ?? 150);

    normalizeSliders();
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    if (!isAuctionPage()) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const collapsed = localStorage.getItem(FILTER_COLLAPSED_KEY) !== "false";
    const f = loadFilters();

    panel.innerHTML = `
      <div class="caf3-card">
        <div class="caf3-header">
          <b>CAF3 Condensed Auction Filter</b>
          <button id="caf3-collapse" class="caf3-collapse-btn">
            ${collapsed ? "Show More" : "Hide Extra"}
          </button>
        </div>

        <div id="caf3-filter-body" class="caf3-body">

          <div id="caf3-advanced" class="caf3-advanced ${collapsed ? "collapsed" : ""}">
            <input id="caf-name" placeholder="Item name"
              style="width:100%;box-sizing:border-box;margin-top:8px;padding:6px;">

            <div style="display:flex;gap:6px;margin-top:6px;">
              <input id="caf-dmg" type="number" placeholder="Min dmg" style="width:33%;padding:6px;">
              <input id="caf-acc" type="number" placeholder="Min acc" style="width:33%;padding:6px;">
              <input id="caf-bid" type="number" placeholder="Max bid" style="width:34%;padding:6px;">
            </div>

            <div style="display:flex;gap:6px;margin-top:6px;">
              <select id="caf-color" style="width:100%;padding:6px;">${colorOptions()}</select>
            </div>

            <div style="margin-top:8px;color:#aaa;font-size:11px;text-transform:uppercase;">Quality Range</div>
            <div class="caf3-slider-row">
              <span>Min</span>
              <input id="caf-qmin" type="range" min="0" max="200" step="1" value="${Number(f.qualityMin ?? 0)}">
              <span id="caf-qmin-val" class="caf3-range-value">${Number(f.qualityMin ?? 0)}</span>
            </div>
            <div class="caf3-slider-row">
              <span>Max</span>
              <input id="caf-qmax" type="range" min="0" max="200" step="1" value="${Number(f.qualityMax ?? 200)}">
              <span id="caf-qmax-val" class="caf3-range-value">${Number(f.qualityMax ?? 200)}</span>
            </div>

            <div style="margin-top:8px;color:#aaa;font-size:11px;text-transform:uppercase;">Bonus % Range</div>
            <div class="caf3-slider-row">
              <span>Min</span>
              <input id="caf-bmin" type="range" min="0" max="150" step="1" value="${Number(f.bonusMin ?? 0)}">
              <span id="caf-bmin-val" class="caf3-range-value">${Number(f.bonusMin ?? 0)}%</span>
            </div>
            <div class="caf3-slider-row">
              <span>Max</span>
              <input id="caf-bmax" type="range" min="0" max="150" step="1" value="${Number(f.bonusMax ?? 150)}">
              <span id="caf-bmax-val" class="caf3-range-value">${Number(f.bonusMax ?? 150)}%</span>
            </div>
          </div>

          <div style="display:flex;gap:6px;margin-top:6px;">
            <select id="caf-bonus1" style="width:50%;padding:6px;">${options("Bonus 1")}</select>
            <select id="caf-bonus2" style="width:50%;padding:6px;">${options("Bonus 2")}</select>
          </div>

          <label style="display:block;margin-top:8px;">
            <input id="caf-double" type="checkbox">
            Only double-bonus weapons
          </label>

          <div id="caf-slider-summary" style="margin-top:6px;color:#aaa;font-size:11px;text-align:center;"></div>

          <div style="display:flex;gap:6px;margin-top:8px;">
            <button id="caf-load" style="width:50%;padding:8px;">Load + Filter</button>
            <button id="caf-clear" style="width:50%;padding:8px;">Clear</button>
          </div>
        </div>

        <div id="caf-status" style="margin-top:8px;color:#aaa;font-size:12px;"></div>
      </div>
    `;

    document.body.prepend(panel);
    restoreFilters();

    ["caf-qmin", "caf-qmax", "caf-bmin", "caf-bmax"].forEach(id => {
      const el = document.getElementById(id);
      el.oninput = () => {
        normalizeSliders();
        saveFilters();
      };
      el.onchange = () => {
        normalizeSliders();
        saveFilters();
      };
    });

    document.getElementById("caf3-collapse").onclick = () => {
      const advanced = document.getElementById("caf3-advanced");
      const isCollapsed = advanced.classList.toggle("collapsed");

      localStorage.setItem(FILTER_COLLAPSED_KEY, isCollapsed ? "true" : "false");

      document.getElementById("caf3-collapse").textContent =
        isCollapsed ? "Show More" : "Hide Extra";
    };

    document.getElementById("caf-load").onclick = async () => {
      saveFilters();

      if (!allItems.length) {
        await loadAllPages();
      }

      applyGlobalFilter();
      renderPage(1);
      saveState();

      fetchQualityForFilteredItems();
    };

    document.getElementById("caf-clear").onclick = clearAll;
  }

  function normalizeSliders() {
    const qMin = document.getElementById("caf-qmin");
    const qMax = document.getElementById("caf-qmax");
    const bMin = document.getElementById("caf-bmin");
    const bMax = document.getElementById("caf-bmax");

    if (qMin && qMax && Number(qMin.value) > Number(qMax.value)) {
      qMax.value = qMin.value;
    }

    if (bMin && bMax && Number(bMin.value) > Number(bMax.value)) {
      bMax.value = bMin.value;
    }

    const qMinVal = document.getElementById("caf-qmin-val");
    const qMaxVal = document.getElementById("caf-qmax-val");
    const bMinVal = document.getElementById("caf-bmin-val");
    const bMaxVal = document.getElementById("caf-bmax-val");

    if (qMinVal) qMinVal.textContent = qMin?.value ?? "0";
    if (qMaxVal) qMaxVal.textContent = qMax?.value ?? "200";
    if (bMinVal) bMinVal.textContent = `${bMin?.value ?? "0"}%`;
    if (bMaxVal) bMaxVal.textContent = `${bMax?.value ?? "150"}%`;

    const summary = document.getElementById("caf-slider-summary");
    if (summary) {
      const color = document.getElementById("caf-color")?.value || "Any";
      summary.textContent =
        `Color ${color || "Any"} | Q ${qMin?.value ?? 0}-${qMax?.value ?? 200} | B ${bMin?.value ?? 0}-${bMax?.value ?? 150}%`;
    }
  }

  async function fetchAuctionPage(start) {
    const body = new URLSearchParams();
    body.set("step", "getAuctionItemsList");
    body.set("start", String(start));
    body.set("itemtype", "weapons");

    const res = await fetch(`/amarket.php?rfcv=${Date.now()}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body
    });

    const data = await res.json();

    if (data?.success && Array.isArray(data.list)) {
      data.list.forEach(item => {
        item.__auctionStart = start;
        setItemEndTime(item);
      });
    }

    return data;
  }

  async function loadAllPages() {
    if (loading) return;

    loading = true;
    allItems = [];

    const status = document.getElementById("caf-status");
    const starts = [];

    for (let i = 0; i <= 590; i += 10) starts.push(i);

    const batchSize = 5;

    for (let i = 0; i < starts.length; i += batchSize) {
      const batch = starts.slice(i, i + batchSize);

      status.textContent =
        `Loading ${Math.min(i + batchSize, starts.length)} of ${starts.length} pages...`;

      const results = await Promise.all(batch.map(start => fetchAuctionPage(start)));

      for (const data of results) {
        if (data?.success && Array.isArray(data.list)) {
          allItems.push(...data.list);
        }
      }
    }

    loading = false;
    status.textContent = `Loaded ${allItems.length} auction items`;
  }

  function itemBonuses(item) {
  const text = `${item.bonuses || ""} ${item.item_image_icons || ""} ${item.arialabel || ""}`.toLowerCase();

  return bonuses.filter(b => {
    if (!b) return false;

    const aliases = b === "Homerun"
      ? ["homerun", "home run"]
      : [b.toLowerCase()];

    return aliases.some(key => {
      const classKey = key.replace(/\s+/g, "-");

      return text.includes(`<b>${key}</b>`)
        || text.includes(`${key}:`)
        || text.includes(`bonus-attachment-${classKey}`);
    });
  });
}
function itemBonusDetails(item) {
  const source = `${item.bonuses || ""} ${item.item_image_icons || ""} ${item.arialabel || ""}`;
  const details = [];

  for (const bonus of itemBonuses(item)) {

    const bonusAliases =
      bonus === "Homerun"
        ? ["Homerun", "Home Run"]
        : [bonus];

    let percent = "";

    for (const alias of bonusAliases) {

      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const htmlMatch = source.match(
        new RegExp(
          `<b>\\s*${escaped}\\s*<\\/b>\\s*<br\\s*\\/?>\\s*([^<"]+)`,
          "i"
        )
      );

      if (htmlMatch) {
        const pct = htmlMatch[1].match(/(\d+(?:\.\d+)?)%/);

        if (pct) {
          percent = `${pct[1]}%`;
          break;
        }
      }

      const ariaMatch = source.match(
        new RegExp(`${escaped}:\\s*([^\\.\\n]+)`, "i")
      );

      if (ariaMatch) {
        const pct = ariaMatch[1].match(/(\d+(?:\.\d+)?)%/);

        if (pct) {
          percent = `${pct[1]}%`;
          break;
        }
      }
    }

    details.push(percent ? `${bonus} ${percent}` : bonus);
  }

  return details.slice(0, 2);
}

  function itemBonusPercents(item) {
    return itemBonusDetails(item)
      .map(x => Number((String(x).match(/(\\d+(?:\\.\\d+)?)%/) || [])[1]))
      .filter(x => !Number.isNaN(x));
  }

  function getStatNumbers(item) {
    const text = item.item_image_icons || "";

    const nums = [...text.matchAll(/label-value[^>]*>\s*([\d.]+)\s*</gi)]
      .map(x => Number(x[1]))
      .filter(x => !Number.isNaN(x));

    if (nums.length >= 2) return nums;

    const aria = item.arialabel || "";

    return [
      Number((aria.match(/Damage:\s*([\d.]+)/i) || [])[1] || 0),
      Number((aria.match(/Accuracy:\s*([\d.]+)/i) || [])[1] || 0)
    ];
  }

  function itemDamage(item) {
    return getStatNumbers(item)[0] || 0;
  }

  function itemAccuracy(item) {
    return getStatNumbers(item)[1] || 0;
  }

  function itemBid(item) {
    const text = item.topbid || item.arialabel || "";
    const m = String(text).match(/\$([\d,]+)/);
    return m ? Number(m[1].replaceAll(",", "")) : 0;
  }

  function itemGlowClass(item) {
    const g = `${item.glowClass || ""} ${item.glowcolor || ""} ${item.glow || ""}`.toLowerCase();

    if (g.includes("red")) return "red";
    if (g.includes("orange") || g.includes("ff9f00")) return "orange";
    if (g.includes("yellow") || g.includes("ffff00")) return "yellow";

    return "";
  }

  function itemMatchesColor(item, color) {
    if (!color) return true;

    const glow = itemGlowClass(item);
    if (color === "None") return !glow;

    return glow === color.toLowerCase();
  }

  function qualityKey(item) {
    return String(item.armouryID || item.armoryID || item.ID || "");
  }

  function itemQuality(item) {
    const cache = loadQualityCache();
    const key = qualityKey(item);
    return key && cache[key] ? cache[key] : null;
  }

  function itemQualityNumber(item) {
    const q = itemQuality(item);
    if (!q) return null;

    const n = Number(String(q.value || "").match(/[\d.]+/)?.[0] || NaN);
    return Number.isNaN(n) ? null : n;
  }

  function itemMatchesQualityRange(item, min, max) {
    const q = itemQualityNumber(item);

    if (q === null) {
      return Number(min || 0) <= 0 && Number(max || 200) >= 200;
    }

    return q >= Number(min || 0) && q <= Number(max || 200);
  }

  function itemMatchesBonusRange(item, min, max) {
    const values = itemBonusPercents(item);

    if (!values.length) {
      return Number(min || 0) <= 0 && Number(max || 150) >= 150;
    }

    return values.some(v => v >= Number(min || 0) && v <= Number(max || 150));
  }

  function loadQualityCache() {
    try {
      return JSON.parse(localStorage.getItem(QUALITY_CACHE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveQualityCache(cache) {
    localStorage.setItem(QUALITY_CACHE_KEY, JSON.stringify(cache));
  }

  function cacheQualityFromDetail(data, fallbackKey) {
    const quality = (data.extras || []).find(x => x.title === "Quality");
    if (!quality) return false;

    const key = String(data.armoryID || data.armouryID || fallbackKey || "");
    if (!key) return false;

    const cache = loadQualityCache();

    cache[key] = {
      value: quality.value || "",
      color: quality.colorOverlay || "",
      glowClass: data.glowClass || ""
    };

    saveQualityCache(cache);
    return true;
  }

  function hookQualityResponses() {
    const oldOpen = XMLHttpRequest.prototype.open;
    const oldSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__cafUrl = url;
      return oldOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const text = this.responseText || "";
          if (!text.includes('"extras"') || !text.includes('"Quality"')) return;

          const data = JSON.parse(text);
          if (cacheQualityFromDetail(data)) {
            applyGlobalFilter();
            renderPage(currentPage || 1);
          }
        } catch {}
      });

      return oldSend.apply(this, arguments);
    };
  }

  async function fetchQualityForFilteredItems() {
    if (qualityLoading) return;

    qualityLoading = true;

    const status = document.getElementById("caf-status");
    const cache = loadQualityCache();

    const items = filteredItems
      .filter(item => qualityKey(item))
      .filter(item => !cache[qualityKey(item)])
      .slice(0, 40);

    if (!items.length) {
      qualityLoading = false;
      return;
    }

    for (let i = 0; i < items.length; i++) {
      if (status) {
        status.textContent = `Fetching quality ${i + 1} / ${items.length}...`;
      }

      await tryFetchQuality(items[i]);

      if ((i + 1) % 3 === 0) {
        applyGlobalFilter();
        renderPage(currentPage || 1);
        await delay(150);
      }
    }

    applyGlobalFilter();
    renderPage(currentPage || 1);

    if (status) {
      status.textContent = `Quality fetch complete. Showing ${filteredItems.length} filtered item(s).`;
    }

    qualityLoading = false;
  }

  async function tryFetchQuality(item) {
    const key = qualityKey(item);
    const itemId = item.itemID || item.itemId || item.id || "";
    const armoryId = item.armouryID || item.armoryID || item.ID || "";

    const candidates = [
      { step: "getItemDetails", ID: armoryId },
      { step: "getItemDetails", id: armoryId },
      { step: "getItemDetails", armoryID: armoryId },
      { step: "getItemDetails", armouryID: armoryId },
      { step: "getItemDetails", itemID: itemId, armoryID: armoryId },
      { step: "getItemDetails", itemID: itemId, ID: armoryId },
      { step: "details", ID: armoryId },
      { step: "details", armoryID: armoryId }
    ];

    for (const params of candidates) {
      try {
        const body = new URLSearchParams();

        Object.keys(params).forEach(k => {
          if (params[k]) body.set(k, String(params[k]));
        });

        const res = await fetch(`/page.php?sid=inventory&rfcv=${Date.now()}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
          },
          body
        });

        const text = await res.text();

        if (!text.includes('"extras"') || !text.includes('"Quality"')) {
          continue;
        }

        const data = JSON.parse(text);

        if (cacheQualityFromDetail(data, key)) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setItemEndTime(item) {
    if (item.endtime) item.__endsAtMs = Number(item.endtime) * 1000;
    else if (item.timer?.value) item.__endsAtMs = Date.now() + Number(item.timer.value) * 1000;
    else item.__endsAtMs = Date.now();
  }

  function formatCountdown(endMs) {
    let diff = Math.max(0, Math.floor((endMs - Date.now()) / 1000));

    const d = Math.floor(diff / 86400);
    diff %= 86400;
    const h = Math.floor(diff / 3600);
    diff %= 3600;
    const m = Math.floor(diff / 60);
    const s = diff % 60;

    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${h}h`);
    if (m || h || d) parts.push(`${m}m`);
    parts.push(`${s}s`);

    return parts.join(" ");
  }

  function formatCountdownShort(endMs) {
  let diff = Math.max(0, Math.floor((endMs - Date.now()) / 1000));

  const d = Math.floor(diff / 86400);
  diff %= 86400;

  const h = Math.floor(diff / 3600);
  diff %= 3600;

  const m = Math.floor(diff / 60);
  const s = diff % 60;

  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

setInterval(() => {
  document.querySelectorAll(".caf-countdown").forEach(el => {
    const endMs = Number(el.getAttribute("data-ends-at") || 0);
    if (!endMs) return;

    if (el.closest("#theqwan-global-watch-bar")) {
      el.textContent = formatCountdownShort(endMs);
    } else {
      el.textContent = formatCountdown(endMs);
    }
  });
}, 1000);

  function applyGlobalFilter() {
    const f = getFilters();

    filteredItems = allItems.filter(item => {
      const label = `${item.name || ""} ${item.itemName || ""} ${item.arialabel || ""}`.toLowerCase();
      const ib = itemBonuses(item);

      return (!f.name || label.includes(f.name))
        && (!f.minDmg || itemDamage(item) >= f.minDmg)
        && (!f.minAcc || itemAccuracy(item) >= f.minAcc)
        && (!f.maxBid || itemBid(item) <= f.maxBid)
        && (!f.bonus1 || ib.includes(f.bonus1))
        && (!f.bonus2 || ib.includes(f.bonus2))
        && (!f.onlyDouble || ib.length >= 2)
        && itemMatchesColor(item, f.color)
        && itemMatchesQualityRange(item, f.qualityMin, f.qualityMax)
        && itemMatchesBonusRange(item, f.bonusMin, f.bonusMax);
    });
  }

  function renderPage(page) {
    currentPage = page;

    let box = document.getElementById(RESULTS_ID);

    if (!box) {
      box = document.createElement("div");
      box.id = RESULTS_ID;
      document.getElementById(PANEL_ID).after(box);
    }

    const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
    const startIndex = (page - 1) * PAGE_SIZE;
    const pageItems = filteredItems.slice(startIndex, startIndex + PAGE_SIZE);
    const resultsCollapsed = localStorage.getItem(RESULTS_COLLAPSED_KEY) === "true";
box.innerHTML = `
  <div style="margin-top:10px;background:#2b2b2b;border:1px solid #555;border-radius:8px;overflow:hidden;">

    <div id="caf-results-header"
      style="padding:8px;font-weight:bold;background:#333;color:#fff;cursor:pointer;">
      Filtered Results ${resultsCollapsed ? "▶" : "▼"} |
      ${filteredItems.length} item(s) |
      Page ${page}/${totalPages}
    </div>

    <div id="caf-results-body"
      style="display:${resultsCollapsed ? "none" : "block"};">

      ${pageItems.map(renderItem).join("") || `<div style="padding:10px;color:#fff;">No matching items.</div>`}

      <div style="display:flex;gap:6px;padding:8px;background:#222;">
        <button id="caf-prev" style="width:50%;padding:8px;" ${page <= 1 ? "disabled" : ""}>Prev</button>

        <button id="caf-next" style="width:50%;padding:8px;" ${page >= totalPages ? "disabled" : ""}>Next</button>
      </div>

    </div>
  </div>
`;

document.getElementById("caf-results-header").onclick = () => {
  const collapsed = localStorage.getItem(RESULTS_COLLAPSED_KEY) === "true";

  localStorage.setItem(
    RESULTS_COLLAPSED_KEY,
    collapsed ? "false" : "true"
  );

  renderPage(currentPage || 1);
};

document.getElementById("caf-prev").onclick = () => {
  renderPage(Math.max(1, currentPage - 1));
  saveState();
};

document.getElementById("caf-next").onclick = () => {
  renderPage(Math.min(totalPages, currentPage + 1));
  saveState();
};

box.querySelectorAll(".caf-open").forEach(btn => {
  btn.addEventListener("click", async function (e) {
    e.preventDefault();
    e.stopPropagation();

    saveFilters();
    saveState();

    const id = this.getAttribute("data-watch-id");

    const item =
      filteredItems.find(x => watchId(x) === id) ||
      filteredItems.find(x =>
        String(itemDamage(x).toFixed(2)) === this.getAttribute("data-dmg") &&
        String(itemAccuracy(x).toFixed(2)) === this.getAttribute("data-acc") &&
        String(itemBid(x)) === this.getAttribute("data-bid")
      );

    if (!item) return;

    await jumpToWatchedItem(item);
  });
});

    box.querySelectorAll(".caf-history").forEach(btn => {
  btn.addEventListener("click", async function (e) {
    e.preventDefault();
    e.stopPropagation();

    const id = this.getAttribute("data-watch-id");

    const item = filteredItems.find(x => watchId(x) === id);

    if (!item) return;

    const historyBox = document.querySelector(
      `.caf-history-box[data-watch-id="${CSS.escape(id)}"]`
    );

    if (historyBox) {
      historyBox.style.display =
        historyBox.style.display === "none" ? "block" : "none";
    }

    await cafHistoryRun(item);
  });
});

box.querySelectorAll(".caf-watch").forEach(btn => {
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();

    const id = this.getAttribute("data-watch-id");

    const item = filteredItems.find(x => watchId(x) === id);

    if (item) {
      toggleWatch(item);
    }
  });
});

box.querySelectorAll(".caf-unwatch").forEach(btn => {
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();

    const id = this.getAttribute("data-watch-id");

    const list = loadWatchList().filter(x => x.id !== id);

    saveWatchList(list);

renderWatchList();
    
  });
});

  }

function renderItem(item) {
  const bonusesText = itemBonusDetails(item).join(" / ") || "None";
  const name = item.name || item.itemName || "Unknown";
  const sourceStart = item.__auctionStart || 0;
  const dmg = itemDamage(item);
  const acc = itemAccuracy(item);
  const bid = itemBid(item);
  const glow = itemGlowClass(item);
  const q = itemQuality(item);
  const id = watchId(item);

  return `
    <div style="display:flex;gap:10px;padding:10px;border-top:1px solid #444;color:#fff;">
      <div class="caf-img-wrap ${glow}">
        <img src="${item.image || item.itemImg || item.itemSrc || ""}">
      </div>

      <div style="flex:1;">
        <div style="color:#6eb6ff;font-weight:bold;font-size:15px;">${escapeHtml(name)}</div>
        ${q ? `<div class="caf-quality">Quality: ${escapeHtml(q.value)} ${escapeHtml(q.color || "")}</div>` : ""}
        <div style="color:#ccc;">Damage: ${dmg.toFixed(2)} | Accuracy: ${acc.toFixed(2)}</div>
        <div style="color:#aaa;">Bonus: ${escapeHtml(bonusesText)}</div>
        <div style="color:#aaa;">Color: ${glow ? glow.toUpperCase() : "None"}</div>
        <div>Bid: $${Number(bid || 0).toLocaleString()}</div>

        <div style="color:#ffcf70;">
          Time left:
          <span class="caf-countdown" data-ends-at="${item.__endsAtMs || 0}">
            ${formatCountdown(item.__endsAtMs || Date.now())}
          </span>
        </div>

        <button class="caf-open"
          data-watch-id="${id}"
          data-start="${sourceStart}"
          data-name="${escapeAttr(name.toLowerCase())}"
          data-dmg="${dmg.toFixed(2)}"
          data-acc="${acc.toFixed(2)}"
          data-bid="${bid}"
          style="margin-top:6px;padding:6px 10px;width:100%;">
          Open Original Page
        </button>

        <button class="caf-history"
          data-watch-id="${id}"
          style="margin-top:6px;padding:6px 10px;width:100%;background:#202020;color:#8ecbff;border:1px solid #444;border-radius:4px;">
          History
        </button>

        <div class="caf-history-box caf35-line"
          data-watch-id="${id}"
          style="display:none;margin-top:6px;font-size:12px;background:#181818;border:1px solid #444;border-radius:5px;padding:6px;color:#ddd;">
        </div>

        <button class="caf-watch"
          data-watch-id="${id}"
          style="margin-top:6px;padding:6px 10px;width:100%;
          background:${isWatched(item) ? "#1f4d2e" : "#222"};
          color:${isWatched(item) ? "#8cffb0" : "#fff"};">
          ${isWatched(item) ? "Watching ✓" : "Watch"}
        </button>
      </div>
    </div>
  `;
}

  function restoreRenderedResultsIfAvailable() {
    restoreState();

    if (filteredItems.length > 0) {
      renderPage(currentPage || 1);

      const status = document.getElementById("caf-status");
      if (status) status.textContent = `Restored ${filteredItems.length} filtered item(s)`;
    }
  }

  function getOriginalCards() {
    const labeled = [...document.querySelectorAll("[aria-label]")]
      .filter(el => {
        const a = el.getAttribute("aria-label") || "";
        return a.includes("Damage:") && a.includes("Accuracy:");
      });

    const wrappers = labeled.map(el =>
      el.closest("li") ||
      el.closest("div[class*=auction]") ||
      el.closest("div[class*=item]") ||
      el.parentElement
    ).filter(Boolean);

    return [...new Set(wrappers)];
  }

function originalCardData(card) {
  const ariaEl = card.matches("[aria-label]")
    ? card
    : card.querySelector("[aria-label*='Damage:']");

  const rawLabel = ariaEl?.getAttribute("aria-label") || card.innerText || "";
  const label = rawLabel.toLowerCase();
  const html = card.outerHTML || "";

  const idMatch =
    html.match(/armou?r?yID["'=:\s]+(\d+)/i) ||
    html.match(/data-(?:armou?r?y|item|auction)-id=["']?(\d+)/i) ||
    html.match(/ID["'=:\s]+(\d+)/i);

  return {
    label,
    html,
    possibleId: idMatch ? String(idMatch[1]) : "",
    damage: Number((rawLabel.match(/Damage:\s*([\d.]+)/i) || [])[1] || 0),
    accuracy: Number((rawLabel.match(/Accuracy:\s*([\d.]+)/i) || [])[1] || 0),
    bid: itemBid({ topbid: rawLabel }),
    bonuses: bonuses.filter(b => b && label.includes(`${b.toLowerCase()}:`)),
    bonusPercents: [...rawLabel.matchAll(/(\d+(?:\.\d+)?)%/g)].map(x => Number(x[1])),
    color: originalCardGlow(card)
  };
}

  function originalCardGlow(card) {
    const html = card.outerHTML.toLowerCase();

    if (html.includes("red")) return "red";
    if (html.includes("orange") || html.includes("ff9f00")) return "orange";
    if (html.includes("yellow") || html.includes("ffff00")) return "yellow";

    return "";
  }

  function originalMatchesColor(d, color) {
    if (!color) return true;
    if (color === "None") return !d.color;
    return d.color === color.toLowerCase();
  }

  function originalMatchesBonusRange(d, min, max) {
    if (!d.bonusPercents.length) {
      return Number(min || 0) <= 0 && Number(max || 150) >= 150;
    }

    return d.bonusPercents.some(v => v >= Number(min || 0) && v <= Number(max || 150));
  }

function applyOriginalPageFilter() {
  if (localStorage.getItem(AUTO_FILTER_KEY) !== "1") return;

  const targetStart = localStorage.getItem(TARGET_START_KEY) || "0";
  const currentStart = (location.hash.match(/start=(\d+)/) || [])[1] || "0";

  if (targetStart !== currentStart) return;

  const f = loadFilters();
  const cards = getOriginalCards();

  const targetOnly = localStorage.getItem(TARGET_ONLY_KEY) === "1";
  const targetName = localStorage.getItem(TARGET_NAME_KEY) || "";
  const targetDmg = Number(localStorage.getItem(TARGET_DMG_KEY) || 0);
  const targetAcc = Number(localStorage.getItem(TARGET_ACC_KEY) || 0);
  const targetId = localStorage.getItem(TARGET_ID_KEY) || "";

  let shown = 0;
  let highlighted = false;

  for (const card of cards) {
    const d = originalCardData(card);

    const normalFilterOk =
      (!f.name || d.label.includes(String(f.name).toLowerCase())) &&
      (!f.minDmg || d.damage >= Number(f.minDmg)) &&
      (!f.minAcc || d.accuracy >= Number(f.minAcc)) &&
      (!f.maxBid || d.bid <= Number(f.maxBid)) &&
      (!f.bonus1 || d.bonuses.includes(f.bonus1)) &&
      (!f.bonus2 || d.bonuses.includes(f.bonus2)) &&
      (!f.onlyDouble || d.bonuses.length >= 2) &&
      originalMatchesColor(d, f.color) &&
      originalMatchesBonusRange(d, f.bonusMin, f.bonusMax);

    const idMatch =
      targetId &&
      (
        d.possibleId === targetId ||
        d.html.includes(targetId)
      );

    const statMatch =
      targetName &&
      d.label.includes(targetName) &&
      Math.abs(d.damage - targetDmg) < 0.15 &&
      Math.abs(d.accuracy - targetAcc) < 0.15;

    const isTarget = idMatch || statMatch;
    const ok = targetOnly ? isTarget : normalFilterOk;

    card.style.display = ok ? "" : "none";

    if (ok) shown++;

    if (isTarget) {
      card.style.display = "";
      card.style.outline = "4px solid #00ff6a";
      card.style.boxShadow = "0 0 18px #00ff6a";

      highlighted = true;

      if (localStorage.getItem("joshAuctionTargetScrolled") !== "1") {
        setTimeout(() => {
          if (!document.body.contains(card)) return;

          requestAnimationFrame(() => {
            card.scrollIntoView({
              behavior: "smooth",
              block: "center"
            });

            localStorage.setItem("joshAuctionTargetScrolled", "1");
          });
        }, 1200);
      }
    }
  }

  let note = document.getElementById("josh-original-page-filter-note");

  if (!note) {
    note = document.createElement("div");
    note.id = "josh-original-page-filter-note";
    note.style.cssText = "margin:8px 0;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;";

    const target = document.querySelector("#auction-house-tabs") || document.body;

    if (target?.parentElement) {
      target.parentElement.insertBefore(note, target);
    } else {
      document.body.prepend(note);
    }
  }

  note.textContent = targetOnly
    ? highlighted
      ? "Target item isolated and highlighted."
      : "Target item filter active, but target was not found on this page."
    : highlighted
      ? `Original page filtered and target highlighted: showing ${shown} of ${cards.length}`
      : `Original page filtered: showing ${shown} of ${cards.length}`;
}

  function startTargetSearchLoop() {

  let tries = 0;

  const timer = setInterval(() => {

    tries++;

    applyOriginalPageFilter();

    const found = [...getOriginalCards()].some(card => {
      return card.style.outline.includes("00ff6a");
    });

    if (found || tries >= 25) {
      clearInterval(timer);
    }

  }, 700);
}

function completePendingAuctionJump() {

  if (localStorage.getItem("joshAuctionPendingJump") !== "1") return;
  if (!location.pathname.includes("amarket.php")) return;

  const start = localStorage.getItem(TARGET_START_KEY) || "0";
  const wantedHash = `#itemtab=weapons&start=${start}`;

  const finish = () => {
    startTargetSearchLoop();
    setTimeout(startTargetSearchLoop, 1200);
    setTimeout(startTargetSearchLoop, 2500);
  };

if (!location.hash.includes(`start=${start}`)) {

    location.hash = wantedHash;

    setTimeout(() => {
      window.location.reload();
    }, 300);

    return;
  }

  // wait for auction cards to actually exist
  let tries = 0;

  const waitForCards = setInterval(() => {

    tries++;

    const cards = getOriginalCards();

    if (cards.length > 0) {

      clearInterval(waitForCards);

      localStorage.removeItem("joshAuctionPendingJump");

      finish();
    }

    if (tries >= 30) {

      clearInterval(waitForCards);

      localStorage.removeItem("joshAuctionPendingJump");

      finish();
    }

  }, 350);
}

function markExpiredWatchedItems() {
  const list = loadWatchList();
  let changed = false;

  list.forEach(w => {
    const item = w.item;
    if (!item || item.__sold) return;

    const end = Number(item.__endsAtMs || 0);

    if (end && end <= Date.now()) {
      item.__sold = true;
      item.__soldPrice = itemBid(item);
      item.__soldAt = Date.now();
      changed = true;
    }
  });

  if (changed) {
    saveWatchList(list);
  }

  return changed;
}

  /* =========================
   CAF 4 HISTORY / COMPS
========================= */

const CAF_HISTORY_SUPABASE_URL = "https://btrmmuuoofbonmuwrkzg.supabase.co";
const CAF_HISTORY_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJIUzI1NiIsInJlZiI6ImJ0cm1tdXVvb2Zib25tdXdya3pnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NTEzMTgsImV4cCI6MjA4NDQyNzMxOH0.E-s0k46BORXLICAvxtEpqoM3Qmh4-TRLaJAwXO6wJTY";

const CAF_HISTORY_SETTINGS_KEY = "caf4HistorySettings";
const CAF_HISTORY_CACHE_KEY = "caf4HistoryCache";

const CAF_HISTORY_BONUS_IDS = {
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
  "toxin": 103, "warlord": 81, "weaken": 46, "wind-up": 76, "wither": 42,
  "home run": 83, "homerun": 83
};

const CAF_HISTORY_BONUS_NAMES = {};
Object.entries(CAF_HISTORY_BONUS_IDS).forEach(([name, id]) => {
  if (!CAF_HISTORY_BONUS_NAMES[id]) {
    CAF_HISTORY_BONUS_NAMES[id] = name.replace(/\b\w/g, c => c.toUpperCase());
  }
});

function cafHistoryDefaultSettings() {
  return {
    count: 12,
    qualityMin: 0,
    qualityMax: 200,
    bonusMin: 0,
    bonusMax: 150,
    bonusMode: "item",
    doubleOnly: false
  };
}

function cafHistorySettings() {
  try {
    return {
      ...cafHistoryDefaultSettings(),
      ...JSON.parse(localStorage.getItem(CAF_HISTORY_SETTINGS_KEY) || "{}")
    };
  } catch {
    return cafHistoryDefaultSettings();
  }
}

function cafHistorySaveSettings(s) {
  localStorage.setItem(CAF_HISTORY_SETTINGS_KEY, JSON.stringify(s));
}

function cafHistoryMoney(n) {
  n = Number(n || 0);
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + n.toLocaleString();
}

function cafHistoryMedian(values) {
  const a = values.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function cafHistoryDaysAgo(ts) {
  if (!ts) return "?d";
  const d = Math.floor((Date.now() - Number(ts) * 1000) / 86400000);
  if (d <= 0) return "today";
  return `${d}d`;
}

function cafHistorySaleBonusIds(a) {
  const ids = new Set();

  if (Array.isArray(a.bonus_ids)) {
    a.bonus_ids.forEach(id => ids.add(Number(id)));
  }

  if (Array.isArray(a.bonus_values)) {
    a.bonus_values.forEach(x => ids.add(Number(x.bonus_id)));
  }

  return [...ids].filter(Boolean);
}

function cafHistorySaleIsDouble(a) {
  return cafHistorySaleBonusIds(a).length >= 2;
}

function cafHistorySaleHasBonus(a, bonusId) {
  return cafHistorySaleBonusIds(a).includes(Number(bonusId));
}

function cafHistorySaleBonusValues(a, targetIds = []) {
  if (!Array.isArray(a.bonus_values)) return [];

  const targets = new Set((targetIds || []).map(Number).filter(Boolean));

  return a.bonus_values
    .filter(x => !targets.size || targets.has(Number(x.bonus_id)))
    .map(x => Number(x.bonus_value))
    .filter(x => !Number.isNaN(x));
}

function cafHistorySaleBonuses(a) {
  if (Array.isArray(a.bonus_values) && a.bonus_values.length) {
    return a.bonus_values.map(x => {
      const name = CAF_HISTORY_BONUS_NAMES[x.bonus_id] || `Bonus ${x.bonus_id}`;
      const value = x.bonus_value ?? "?";
      return `${name} ${value}%`;
    }).join(" / ");
  }

  if (Array.isArray(a.bonus_ids) && a.bonus_ids.length) {
    return a.bonus_ids
      .map(id => CAF_HISTORY_BONUS_NAMES[id] || `Bonus ${id}`)
      .join(" / ");
  }

  return "No bonus";
}

function cafHistoryItemData(item) {
  const bonusDetails = itemBonusDetails(item);

  const parsedBonuses = bonusDetails.map(x => {
    const m = String(x).match(/^(.+?)\s+([\d.]+)%$/);
    const rawName = m ? m[1].trim() : String(x).trim();
    const key = rawName.toLowerCase() === "homerun" ? "home run" : rawName.toLowerCase();

    return {
      name: rawName,
      id: CAF_HISTORY_BONUS_IDS[key],
      value: m ? Number(m[2]) : null
    };
  }).filter(x => x.id);

  return {
    name: item.name || item.itemName || "",
    dmg: itemDamage(item),
    acc: itemAccuracy(item),
    bid: itemBid(item),
    quality: itemQualityNumber(item) || 0,
    bonuses: parsedBonuses
  };
}

function cafHistoryBuildBody(item) {
  const s = cafHistorySettings();
  const data = cafHistoryItemData(item);

  const body = {
    limit: 100,
    offset: 0,
    sort_by: "timestamp",
    sort_order: "desc",
    item_name: data.name,
    quality_min: Number(s.qualityMin ?? 0),
    quality_max: Number(s.qualityMax ?? 200),
    __visibleLimit: Number(s.count || 12),
    __forceDouble: !!s.doubleOnly,
    __manualBonusMin: Number(s.bonusMin ?? 0),
    __manualBonusMax: Number(s.bonusMax ?? 150),
    __targetBonusIds: []
  };

  if (s.bonusMode === "item") {
    data.bonuses.slice(0, 2).forEach((b, i) => {
      body[`bonus${i + 1}_id`] = b.id;
      body.__targetBonusIds.push(b.id);
    });
  } else if (s.bonusMode === "caf") {
    const f = loadFilters();
    const wanted = [f.bonus1, f.bonus2]
      .filter(Boolean)
      .map(x => CAF_HISTORY_BONUS_IDS[String(x).toLowerCase() === "homerun" ? "home run" : String(x).toLowerCase()])
      .filter(Boolean);

    wanted.slice(0, 2).forEach((id, i) => {
      body[`bonus${i + 1}_id`] = id;
      body.__targetBonusIds.push(id);
    });

    if (f.onlyDouble) body.__forceDouble = true;
  }

  return body;
}

function cafHistoryCleanBody(body) {
  const clean = { ...body };
  Object.keys(clean).forEach(k => {
    if (k.startsWith("__")) delete clean[k];
  });
  return clean;
}

function cafHistoryCacheKey(body) {
  return JSON.stringify(cafHistoryCleanBody(body));
}

function cafHistoryGetCache(key) {
  try {
    const all = JSON.parse(localStorage.getItem(CAF_HISTORY_CACHE_KEY) || "{}");
    const hit = all[key];

    if (hit && Date.now() - hit.ts < 5 * 60 * 1000) {
      return hit.data;
    }
  } catch {}

  return null;
}

function cafHistorySetCache(key, data) {
  try {
    const all = JSON.parse(localStorage.getItem(CAF_HISTORY_CACHE_KEY) || "{}");
    all[key] = { ts: Date.now(), data };
    localStorage.setItem(CAF_HISTORY_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

function cafHistoryApiSearch(body) {
  return new Promise((resolve, reject) => {
    const key = cafHistoryCacheKey(body);
    const cached = cafHistoryGetCache(key);

    if (cached) {
      resolve(cached);
      return;
    }

    GM_xmlhttpRequest({
      method: "POST",
      url: `${CAF_HISTORY_SUPABASE_URL}/functions/v1/search-auctions`,
      headers: {
        "Content-Type": "application/json",
        "apikey": CAF_HISTORY_SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + CAF_HISTORY_SUPABASE_ANON_KEY
      },
      data: JSON.stringify(cafHistoryCleanBody(body)),
      timeout: 30000,
      onload: res => {
        try {
          const data = JSON.parse(res.responseText);

          if (res.status >= 200 && res.status < 300) {
            cafHistorySetCache(key, data);
            resolve(data);
          } else {
  const message =
    typeof data === "string"
      ? data
      : data?.error || data?.message || "API error";

  reject(new Error(message));
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

function cafHistoryPostFilter(auctions, body) {
  let result = auctions || [];

  const targetIds = body.__targetBonusIds || [];

  if (targetIds.length) {
    result = result.filter(a => targetIds.every(id => cafHistorySaleHasBonus(a, id)));
  }

  if (body.__forceDouble) {
    result = result.filter(cafHistorySaleIsDouble);
  }

  result = result.filter(a => {
    const values = cafHistorySaleBonusValues(a, targetIds);

    if (!values.length) {
      return Number(body.__manualBonusMin || 0) <= 0;
    }

    return values.some(v =>
      v >= Number(body.__manualBonusMin || 0) &&
      v <= Number(body.__manualBonusMax || 150)
    );
  });

  return result.slice(0, body.__visibleLimit || 12);
}

async function cafHistoryApiSearchDeep(body) {
  const visibleLimit = body.__visibleLimit || 12;
  const pageLimit = 100;
  const maxScanned = 1000;

  let all = [];
  let offset = 0;
  let total = null;

  while (offset < maxScanned) {
    const pageBody = {
      ...body,
      limit: pageLimit,
      offset
    };

    const result = await cafHistoryApiSearch(pageBody);
    const auctions = result.auctions || [];

    all = all.concat(auctions);

    const filtered = cafHistoryPostFilter(all, {
      ...body,
      __visibleLimit: maxScanned
    });

    if (filtered.length >= visibleLimit) {
      return {
        ...result,
        auctions: filtered.slice(0, visibleLimit)
      };
    }

    total = result.total ?? total;

    if (!auctions.length) break;
    if (total !== null && offset + pageLimit >= total) break;

    offset += pageLimit;
  }

  return {
    auctions: cafHistoryPostFilter(all, body),
    total: total ?? all.length
  };
}

function cafHistoryDealState(bid, low, med, high) {
  if (!bid || !med) return "unknown";
  if (bid < low) return "steal";
  if (bid < med) return "good";
  if (bid <= high) return "fair";
  return "bad";
}

function cafHistoryDealLabel(state) {
  if (state === "steal") return ["caf35-steal", "STEAL"];
  if (state === "good") return ["caf35-good", "GOOD"];
  if (state === "fair") return ["caf35-fair", "FAIR"];
  if (state === "bad") return ["caf35-high", "HIGH"];
  return ["caf35-muted", "?"];
}

function cafHistoryRenderResult(item, auctions, targetBox = null) {
  const id = watchId(item);
  const box = targetBox || document.querySelector(`.caf-history-box[data-watch-id="${CSS.escape(id)}"]`);
  if (!box) return;

  const prices = auctions.map(a => Number(a.price || 0)).filter(Boolean);

  if (!prices.length) {
    box.innerHTML = `<span class="caf35-muted">No comparable sales found.</span>`;
    return;
  }

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const med = cafHistoryMedian(prices);
  const bid = itemBid(item);
  const state = cafHistoryDealState(bid, low, med, high);
  const [cls, label] = cafHistoryDealLabel(state);

  item.__dealState = state;
  item.__historyLow = low;
  item.__historyMedian = med;
  item.__historyHigh = high;

  const watchList = loadWatchList();
const row = watchList.find(x => x.id === id);

if (row?.item) {
  row.item.__dealState = state;
  row.item.__historyLow = low;
  row.item.__historyMedian = med;
  row.item.__historyHigh = high;

  saveWatchList(watchList);
}

  box.innerHTML = `
    <div>
      <span class="${cls}">Bid ${cafHistoryMoney(bid)} ${label}</span>
      <span class="caf35-muted"> | </span>
      <span style="color:#7ee787;">L ${cafHistoryMoney(low)}</span>
      <span class="caf35-muted"> | </span>
      <span style="color:#b98cff;">M ${cafHistoryMoney(med)}</span>
      <span class="caf35-muted"> | </span>
      <span style="color:#ff8b8b;">H ${cafHistoryMoney(high)}</span>
      <span class="caf35-muted"> | ${auctions.length}x</span>
    </div>

    <button class="caf-history-toggle"
      style="margin-top:4px;width:100%;background:#222;color:#ccc;border:1px solid #444;border-radius:4px;">
      Previous Sales ▼
    </button>

    <div class="caf-history-sales" style="display:none;margin-top:5px;padding-top:5px;border-top:1px solid #333;">
      ${auctions.map(a => {
        const q = a.stat_quality ? `${Number(a.stat_quality).toFixed(1)}Q` : "?Q";
        const b = cafHistorySaleBonuses(a);

        return `
          <div style="display:grid;grid-template-columns:70px 55px 1fr 38px;gap:5px;border-bottom:1px solid #292929;padding:3px 0;align-items:center;">
            <span>${cafHistoryMoney(a.price)}</span>
            <span>${q}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAttr(b)}">${escapeHtml(b)}</span>
            <span>${cafHistoryDaysAgo(a.timestamp)}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;

  const toggle = box.querySelector(".caf-history-toggle");
  const sales = box.querySelector(".caf-history-sales");

  if (toggle && sales) {
    toggle.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      sales.style.display = sales.style.display === "block" ? "none" : "block";
    };
  }

  renderGlobalWatchBar();
}

async function cafHistoryRun(item, scope = document) {
  const id = watchId(item);

  const btn =
    scope.querySelector(`.caf-history[data-watch-id="${CSS.escape(id)}"]`) ||
    scope.querySelector(`.caf-watch-history[data-watch-id="${CSS.escape(id)}"]`) ||
    document.querySelector(`.caf-history[data-watch-id="${CSS.escape(id)}"]`) ||
    document.querySelector(`.caf-watch-history[data-watch-id="${CSS.escape(id)}"]`);

  const box =
    scope.querySelector(`.caf-history-box[data-watch-id="${CSS.escape(id)}"]`) ||
    document.querySelector(`.caf-history-box[data-watch-id="${CSS.escape(id)}"]`);

  if (!box) return;

  if (btn) {
    btn.textContent = "Checking...";
    btn.disabled = true;
  }

  box.innerHTML = `<span class="caf35-muted">Checking history...</span>`;

  try {
    const body = cafHistoryBuildBody(item);
    const result = await cafHistoryApiSearchDeep(body);
    cafHistoryRenderResult(item, result.auctions || [], box);
  } catch (e) {
    box.innerHTML = `<span class="caf35-high">History error: ${escapeHtml(e.message)}</span>`;
  }

  if (btn) {
    btn.textContent = "History";
    btn.disabled = false;
  }
}

  function clearAll() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(AUTO_FILTER_KEY);
    localStorage.removeItem(ALL_ITEMS_KEY);
    localStorage.removeItem(FILTERED_ITEMS_KEY);
    localStorage.removeItem(CURRENT_PAGE_KEY);
    localStorage.removeItem(TARGET_START_KEY);
    localStorage.removeItem(TARGET_NAME_KEY);
    localStorage.removeItem(TARGET_DMG_KEY);
    localStorage.removeItem(TARGET_ACC_KEY);
    localStorage.removeItem(TARGET_BID_KEY);
    localStorage.removeItem(FILTER_COLLAPSED_KEY);

    allItems = [];
    filteredItems = [];

    const box = document.getElementById(RESULTS_ID);
    if (box) box.remove();

    document.getElementById("caf-name").value = "";
    document.getElementById("caf-dmg").value = "";
    document.getElementById("caf-acc").value = "";
    document.getElementById("caf-bid").value = "";
    document.getElementById("caf-bonus1").value = "";
    document.getElementById("caf-bonus2").value = "";
    document.getElementById("caf-double").checked = false;
    document.getElementById("caf-color").value = "";
    document.getElementById("caf-qmin").value = "0";
    document.getElementById("caf-qmax").value = "200";
    document.getElementById("caf-bmin").value = "0";
    document.getElementById("caf-bmax").value = "150";
    document.getElementById("caf-status").textContent = "";

    normalizeSliders();

    const advanced = document.getElementById("caf3-advanced");
    if (advanced) advanced.classList.add("collapsed");

    const collapseBtn = document.getElementById("caf3-collapse");
    if (collapseBtn) collapseBtn.textContent = "Show More";

    const note = document.getElementById("josh-original-page-filter-note");
    if (note) note.remove();

    for (const card of getOriginalCards()) {
      card.style.display = "";
      card.style.outline = "";
      card.style.boxShadow = "";
    }
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

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function cafDebugBottomLayers() {
  const candidates = [...document.querySelectorAll("body *")]
    .map(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);

      return {
        el,
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        cls: String(el.className || "").slice(0, 80),
        position: s.position,
        z: s.zIndex,
        bottom: s.bottom,
        top: s.top,
        height: Math.round(r.height),
        y: Math.round(r.y),
        text: (el.innerText || "").trim().slice(0, 40)
      };
    })
    .filter(x =>
      x.height > 20 &&
      x.y > window.innerHeight - 180 &&
      (x.position === "fixed" || x.position === "sticky")
    );

  console.table(candidates);
  return candidates;
}

renderGlobalWatchBar();
completePendingAuctionJump();

setTimeout(() => {
  injectPanel();
  restoreRenderedResultsIfAvailable();
  renderWatchList();
  renderGlobalWatchBar();
  completePendingAuctionJump();

  startTargetSearchLoop();
}, 1500);

setInterval(async () => {
  await refreshWatchListPages();
}, WATCH_REFRESH_MS);


})();
