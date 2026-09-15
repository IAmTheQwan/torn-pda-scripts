// ==UserScript==
// @name         TheQwan Blackjack Cycle
// @namespace    theqwan.torn.blackjack-cycle
// @version      1.0.0
// @description  Manual two-tap blackjack bet-cycle tracker with surrender-aware flexing
// @author       TheQwan [3485263]
// @match        https://www.torn.com/page.php?sid=blackjack*
// @match        https://www.torn.com/pda.php*step=blackjack*
// @grant        none
// @run-at       document-idle
// @noframes
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/blackjack-cycle/theqwan-blackjack-cycle.meta.js
// @downloadURL  https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/blackjack-cycle/theqwan-blackjack-cycle.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT = "TheQwan Blackjack Cycle";
  const ROOT_ID = "tqbj-root";
  const MODAL_ID = "tqbj-modal";
  const STYLE_ID = "tqbj-style";
  const STORAGE_KEY = "theqwanBlackjackCycle.v1";
  const MAX_HISTORY = 100;
  const DEFAULT_LADDER = [
    1_000,
    10_000,
    100_000,
    300_000,
    1_000_000,
    3_000_000,
    9_000_000,
    20_000_000,
    45_000_000,
    100_000_000,
  ];

  let root;
  let modal;
  let observer;
  let scanQueued = false;
  let state = loadState();

  function freshStats() {
    return { wins: 0, losses: 0, surrenders: 0, pushes: 0, blackjacks: 0 };
  }

  function cleanLadder(value) {
    if (!Array.isArray(value)) return [...DEFAULT_LADDER];
    const ladder = value
      .map((amount) => Math.max(0, Math.round(Number(amount) || 0)))
      .filter((amount) => amount > 0)
      .slice(0, 20);
    if (ladder.length < 2 || ladder.some((amount, index) => index > 0 && amount <= ladder[index - 1])) {
      return [...DEFAULT_LADDER];
    }
    return ladder;
  }

  function loadState() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (error) {
      console.warn(`[${SCRIPT}] Could not read saved state.`, error);
    }
    const ladder = cleanLadder(saved.ladder);
    const stats = { ...freshStats(), ...(saved.stats || {}) };
    Object.keys(stats).forEach((key) => {
      stats[key] = Math.max(0, Math.floor(Number(stats[key]) || 0));
    });
    return {
      ladder,
      step: Math.min(ladder.length - 1, Math.max(0, Math.floor(Number(saved.step) || 0))),
      cycleNet: Math.round(Number(saved.cycleNet) || 0),
      stats,
      activeRound: normalizeRound(saved.activeRound),
      loadedAmount: Math.max(0, Math.round(Number(saved.loadedAmount) || 0)),
      atEnd: Boolean(saved.atEnd),
      collapsed: Boolean(saved.collapsed),
      history: Array.isArray(saved.history) ? saved.history.slice(0, MAX_HISTORY) : [],
      status: String(saved.status || "Ready"),
    };
  }

  function normalizeRound(round) {
    if (!round || typeof round !== "object") return null;
    const wager = Math.max(0, Math.round(Number(round.wager) || 0));
    if (!wager) return null;
    return {
      wager,
      step: Math.max(0, Math.floor(Number(round.step) || 0)),
      startedAt: Number(round.startedAt) || Date.now(),
      doubled: Boolean(round.doubled),
      split: Boolean(round.split),
      sawClearResult: Boolean(round.sawClearResult),
      initialResults: Array.isArray(round.initialResults) ? round.initialResults.map(String) : [],
    };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn(`[${SCRIPT}] Could not save state.`, error);
    }
  }

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
    const text = String(value || "").trim().toLowerCase().replace(/[$,\s]/g, "");
    const match = text.match(/^(-?\d+(?:\.\d+)?)([kmbt])?$/i);
    if (!match) return 0;
    const multiplier = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]] || 1;
    return Math.max(0, Math.round(Number(match[1]) * multiplier));
  }

  function formatMoney(value) {
    const amount = Math.round(Number(value) || 0);
    const sign = amount < 0 ? "-" : "";
    const absolute = Math.abs(amount);
    const format = (divisor, suffix) => {
      const scaled = absolute / divisor;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      const rendered = scaled.toFixed(digits);
      const compact = digits > 0 ? rendered.replace(/\.?0+$/, "") : rendered;
      return `${sign}$${compact}${suffix}`;
    };
    if (absolute >= 1e12) return format(1e12, "T");
    if (absolute >= 1e9) return format(1e9, "B");
    if (absolute >= 1e6) return format(1e6, "M");
    if (absolute >= 1e3) return format(1e3, "K");
    return `${sign}$${absolute.toLocaleString("en-US")}`;
  }

  function baseLossBefore(step = state.step) {
    return state.ladder.slice(0, step).reduce((sum, amount) => sum + amount, 0);
  }

  function baseTargetProfit(step = state.step) {
    return state.ladder[step] - baseLossBefore(step);
  }

  function nextBet() {
    if (state.atEnd) return 0;
    return Math.max(1, Math.round(baseTargetProfit() - state.cycleNet));
  }

  function isVisible(element) {
    if (!element || element.closest(`#${ROOT_ID}, #${MODAL_ID}`)) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
  }

  function disabled(element) {
    return Boolean(
      !element ||
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled") ||
      element.closest(".disabled")
    );
  }

  function controlText(element) {
    return String(
      element?.value ||
      element?.textContent ||
      element?.getAttribute("aria-label") ||
      element?.getAttribute("title") ||
      ""
    ).replace(/\s+/g, " ").trim();
  }

  function blackjackScope() {
    return document.querySelector("#blackjack-wrap, #blackjack, .blackjack-wrap, [class*='blackjack']") || document;
  }

  function findBetInput() {
    const selectors = [
      ".input-money",
      "input.bet",
      "input[name*='bet' i]",
      "input[id*='bet' i]",
      "input[placeholder*='bet' i]",
    ];
    const candidates = [];
    selectors.forEach((selector) => {
      blackjackScope().querySelectorAll(selector).forEach((input) => {
        if (!candidates.includes(input)) candidates.push(input);
      });
    });
    return candidates.find((input) =>
      input instanceof HTMLInputElement &&
      input.type !== "hidden" &&
      !input.readOnly &&
      isVisible(input)
    ) || null;
  }

  function findStartButton() {
    const scope = blackjackScope();
    const direct = scope.querySelector('[data-step="startGame"]');
    if (direct && isVisible(direct)) return direct;
    return Array.from(scope.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"], [role="button"]'))
      .find((element) =>
        isVisible(element) &&
        /^(?:play|deal|start(?: game)?|place bet)$/i.test(controlText(element))
      ) || null;
  }

  function setNativeInputValue(input, value) {
    if (!input) return false;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const text = String(Math.round(value));
    input.focus();
    if (descriptor?.set) descriptor.set.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    return parseMoney(input.value) === Math.round(value);
  }

  function currentBet() {
    return parseMoney(findBetInput()?.value || 0);
  }

  function resultCandidates() {
    const matches = [];
    const seen = new Set();
    const elements = blackjackScope().querySelectorAll(
      "[role='alert'], [class*='result' i], [class*='outcome' i], [class*='message' i], h1, h2, h3, h4, p, span, strong"
    );
    elements.forEach((element) => {
      if (!isVisible(element) || element.matches("button, a, label") || element.closest("button, a")) return;
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 240 || seen.has(text)) return;
      const outcome = classifyOutcome(text);
      if (!outcome) return;
      seen.add(text);
      matches.push({ outcome, text, signature: `${outcome}:${text.toLowerCase()}` });
    });
    return matches;
  }

  function classifyOutcome(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (/\b(?:you\s+)?surrendered\b|\bhand surrendered\b/i.test(value)) return "surrender";
    if (/^(?:push|tie|draw)[!.\s]*$/i.test(value) || /\b(?:it(?:'s| is) a push|you push)\b/i.test(value)) return "push";
    if (
      /\b(?:you (?:have|got) blackjack|blackjack[! ]+(?:you )?(?:win|won)|(?:you )?(?:win|won)[^.!]{0,50}blackjack)\b/i.test(value)
    ) return "blackjack";
    if (/\byou (?:win|won)\b|\bdealer (?:busts?|busted)\b/i.test(value)) return "win";
    if (/\byou (?:lose|lost|bust|busted)\b|\bdealer (?:wins?|won)\b/i.test(value)) return "loss";
    return "";
  }

  function outcomeProfit(outcome, wager) {
    if (outcome === "win") return wager;
    if (outcome === "blackjack") return Math.round(wager * 1.5);
    if (outcome === "loss") return -wager;
    if (outcome === "surrender") return -Math.round(wager / 2);
    return 0;
  }

  function beforeSnapshot() {
    return {
      step: state.step,
      cycleNet: state.cycleNet,
      stats: { ...state.stats },
      activeRound: state.activeRound ? { ...state.activeRound, initialResults: [...state.activeRound.initialResults] } : null,
      loadedAmount: state.loadedAmount,
      atEnd: state.atEnd,
      status: state.status,
    };
  }

  function finishRound(outcome, source = "automatic", resultText = "") {
    if (!state.activeRound) return false;
    const before = beforeSnapshot();
    const wager = state.activeRound.wager;
    const profit = outcomeProfit(outcome, wager);

    if (outcome === "blackjack") {
      state.stats.blackjacks += 1;
      state.stats.wins += 1;
    } else if (outcome === "win") {
      state.stats.wins += 1;
    } else if (outcome === "loss") {
      state.stats.losses += 1;
    } else if (outcome === "surrender") {
      state.stats.surrenders += 1;
    } else if (outcome === "push") {
      state.stats.pushes += 1;
    } else {
      return false;
    }

    state.cycleNet += profit;
    if (outcome === "win" || outcome === "blackjack") {
      state.step = 0;
      state.cycleNet = 0;
      state.atEnd = false;
    } else if (outcome === "loss" || outcome === "surrender") {
      if (state.step >= state.ladder.length - 1) {
        state.atEnd = true;
      } else {
        state.step += 1;
      }
    }

    state.history.unshift({
      at: Date.now(),
      outcome,
      wager,
      profit,
      source,
      resultText: String(resultText || "").slice(0, 240),
      before,
    });
    state.history = state.history.slice(0, MAX_HISTORY);
    state.activeRound = null;
    state.loadedAmount = 0;
    state.status = `${outcomeLabel(outcome)} ${formatMoney(profit)}`;
    saveState();
    render();
    return true;
  }

  function outcomeLabel(outcome) {
    return {
      win: "Win",
      blackjack: "Blackjack",
      loss: "Loss",
      surrender: "Surrender",
      push: "Push",
    }[outcome] || outcome;
  }

  function scanOutcome() {
    scanQueued = false;
    if (!state.activeRound) {
      render();
      return;
    }
    const results = resultCandidates();
    if (!results.length) {
      if (!state.activeRound.sawClearResult) {
        state.activeRound.sawClearResult = true;
        saveState();
      }
      render();
      return;
    }
    const fresh = results.find((result) =>
      state.activeRound.sawClearResult || !state.activeRound.initialResults.includes(result.signature)
    );
    if (fresh) finishRound(fresh.outcome, "automatic", fresh.text);
    else render();
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(scanOutcome);
  }

  function primaryState() {
    if (state.atEnd) return { label: "END", sub: "reset cycle", color: "red", action: "settings" };
    if (state.activeRound) return { label: "HAND", sub: formatMoney(state.activeRound.wager), color: "gray", action: "" };
    const amount = nextBet();
    const input = findBetInput();
    if (!input) return { label: "WAIT", sub: "bet box", color: "gray", action: "" };
    const start = findStartButton();
    if (state.loadedAmount === amount && currentBet() === amount) {
      if (!start || disabled(start)) return { label: "WAIT", sub: "Torn ready", color: "gray", action: "" };
      return { label: "PLAY", sub: formatMoney(amount), color: "green", action: "play", control: start };
    }
    return { label: "LOAD", sub: formatMoney(amount), color: "gold", action: "load", input };
  }

  function performPrimary() {
    const primary = primaryState();
    if (primary.action === "settings") {
      openSettings();
      return;
    }
    if (primary.action === "load") {
      const amount = nextBet();
      if (!setNativeInputValue(primary.input, amount)) {
        state.status = "Could not fill Torn's bet box";
      } else {
        state.loadedAmount = amount;
        state.status = `Loaded ${formatMoney(amount)} — tap PLAY`;
      }
      saveState();
      render();
      return;
    }
    if (primary.action !== "play" || disabled(primary.control)) return;
    const wager = currentBet();
    if (!wager || wager !== nextBet()) {
      state.loadedAmount = 0;
      state.status = "Bet changed — load it again";
      saveState();
      render();
      return;
    }
    state.activeRound = {
      wager,
      step: state.step,
      startedAt: Date.now(),
      doubled: false,
      split: false,
      sawClearResult: false,
      initialResults: resultCandidates().map((result) => result.signature),
    };
    state.loadedAmount = 0;
    state.status = `Playing ${formatMoney(wager)}`;
    saveState();
    render();
    // This is the one native Torn action caused by this explicit user tap.
    primary.control.click();
  }

  function undoLast() {
    const last = state.history.shift();
    if (!last?.before) return;
    state.step = last.before.step;
    state.cycleNet = last.before.cycleNet;
    state.stats = { ...freshStats(), ...last.before.stats };
    state.activeRound = normalizeRound(last.before.activeRound);
    state.loadedAmount = last.before.loadedAmount;
    state.atEnd = last.before.atEnd;
    state.status = `Undid ${outcomeLabel(last.outcome)}`;
    saveState();
    render();
  }

  function resetCycle() {
    state.step = 0;
    state.cycleNet = 0;
    state.activeRound = null;
    state.loadedAmount = 0;
    state.atEnd = false;
    state.status = "Cycle reset";
    saveState();
    render();
  }

  function resetStats() {
    state.stats = freshStats();
    state.history = [];
    state.status = "Record reset";
    saveState();
    render();
  }

  function parseLadderText(text) {
    const amounts = String(text || "")
      .split(/[\n;]+/)
      .map(parseMoney)
      .filter((amount) => amount > 0);
    if (amounts.length < 2) throw new Error("Enter at least two bet amounts.");
    if (amounts.length > 20) throw new Error("Use no more than 20 bet amounts.");
    if (amounts.some((amount, index) => index > 0 && amount <= amounts[index - 1])) {
      throw new Error("Each bet amount must be larger than the one before it.");
    }
    return amounts;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        top: max(158px, calc(env(safe-area-inset-top, 0px) + 72px));
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483500;
        width: min(720px, calc(100vw - 10px));
        box-sizing: border-box;
        border: 1px solid #5a5130;
        border-radius: 8px;
        background: rgba(26, 26, 26, .97);
        color: #eee;
        box-shadow: 0 3px 12px rgba(0,0,0,.55);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 11px;
      }
      #${ROOT_ID} * { box-sizing: border-box; }
      #${ROOT_ID} .tqbj-top { display:flex; align-items:stretch; min-height:38px; }
      #${ROOT_ID} .tqbj-metrics { display:flex; flex:1; min-width:0; overflow-x:auto; scrollbar-width:none; }
      #${ROOT_ID} .tqbj-metric { min-width:72px; padding:5px 7px; border-right:1px solid #3d3d3d; white-space:nowrap; }
      #${ROOT_ID} .tqbj-label { display:block; color:#999; font-size:9px; text-transform:uppercase; }
      #${ROOT_ID} .tqbj-value { display:block; color:#fff; font-weight:800; font-size:12px; }
      #${ROOT_ID} .tqbj-next .tqbj-value { color:#ffd54a; }
      #${ROOT_ID} button { touch-action:manipulation; }
      #${ROOT_ID} .tqbj-icon { width:38px; border:0; border-left:1px solid #444; background:#292929; color:#ddd; font-size:16px; }
      #${ROOT_ID} .tqbj-body { border-top:1px solid #444; padding:5px; }
      #${ROOT_ID}.tqbj-collapsed .tqbj-body { display:none; }
      #${ROOT_ID} .tqbj-actions { display:grid; grid-template-columns:minmax(120px, 2fr) repeat(6, minmax(34px, .45fr)); gap:4px; }
      #${ROOT_ID} .tqbj-primary, #${ROOT_ID} .tqbj-mini {
        min-height:32px; border:1px solid #555; border-radius:5px; background:#303030; color:#eee; font-weight:800;
      }
      #${ROOT_ID} .tqbj-primary[data-color="gold"] { color:#171717; background:#e5bd37; border-color:#ffe16e; }
      #${ROOT_ID} .tqbj-primary[data-color="green"] { background:#078c45; border-color:#27c96d; color:#fff; }
      #${ROOT_ID} .tqbj-primary[data-color="red"] { background:#9d2632; border-color:#e45f6b; }
      #${ROOT_ID} .tqbj-primary[data-color="gray"] { color:#aaa; }
      #${ROOT_ID} .tqbj-mini:disabled { opacity:.35; }
      #${ROOT_ID} .tqbj-mini[data-outcome="win"] { color:#73dc8d; }
      #${ROOT_ID} .tqbj-mini[data-outcome="loss"] { color:#ff7885; }
      #${ROOT_ID} .tqbj-mini[data-outcome="surrender"] { color:#e8ad70; }
      #${ROOT_ID} .tqbj-mini[data-outcome="push"] { color:#77bfff; }
      #${ROOT_ID} .tqbj-status { margin-top:4px; padding:0 3px; color:#aaa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #${MODAL_ID} { position:fixed; inset:0; z-index:2147483600; display:none; align-items:center; justify-content:center; padding:14px; background:rgba(0,0,0,.76); }
      #${MODAL_ID}.tqbj-open { display:flex; }
      #${MODAL_ID} .tqbj-card { width:min(520px, 100%); max-height:92vh; overflow:auto; border:1px solid #666; border-radius:10px; background:#202326; color:#eee; padding:16px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      #${MODAL_ID} h2 { margin:0 0 5px; font-size:21px; }
      #${MODAL_ID} p { margin:0 0 12px; color:#aaa; font-size:12px; }
      #${MODAL_ID} label { display:block; margin:10px 0 4px; font-weight:700; }
      #${MODAL_ID} textarea, #${MODAL_ID} input { width:100%; border:1px solid #555; border-radius:6px; background:#121416; color:#fff; padding:9px; font:14px ui-monospace,SFMono-Regular,Consolas,monospace; }
      #${MODAL_ID} textarea { min-height:190px; resize:vertical; }
      #${MODAL_ID} .tqbj-help, #${MODAL_ID} .tqbj-error { margin-top:5px; color:#aaa; font-size:11px; }
      #${MODAL_ID} .tqbj-error { color:#ff7c87; min-height:15px; }
      #${MODAL_ID} .tqbj-modal-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:12px; }
      #${MODAL_ID} button { min-height:40px; border:1px solid #555; border-radius:6px; background:#34383c; color:#fff; font-weight:800; }
      #${MODAL_ID} .tqbj-save { background:#087f41; border-color:#25bd68; }
      #${MODAL_ID} .tqbj-danger { background:#70262e; border-color:#a84550; }
      @media (max-width:520px) {
        #${ROOT_ID} { top:max(158px, calc(env(safe-area-inset-top, 0px) + 68px)); font-size:10px; }
        #${ROOT_ID} .tqbj-actions { grid-template-columns:minmax(105px,2fr) repeat(6, 34px); overflow-x:auto; }
        #${ROOT_ID} .tqbj-metric { min-width:64px; padding:4px 5px; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildRoot() {
    if (document.getElementById(ROOT_ID)) return;
    root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="tqbj-top">
        <div class="tqbj-metrics">
          <div class="tqbj-metric tqbj-next"><span class="tqbj-label">Next Bet</span><span class="tqbj-value" data-field="next">—</span></div>
          <div class="tqbj-metric"><span class="tqbj-label">Step</span><span class="tqbj-value" data-field="step">—</span></div>
          <div class="tqbj-metric"><span class="tqbj-label">Record</span><span class="tqbj-value" data-field="record">—</span></div>
          <div class="tqbj-metric"><span class="tqbj-label">Wins</span><span class="tqbj-value" data-field="wins">—</span></div>
          <div class="tqbj-metric"><span class="tqbj-label">Losses</span><span class="tqbj-value" data-field="losses">—</span></div>
          <div class="tqbj-metric"><span class="tqbj-label">Surr.</span><span class="tqbj-value" data-field="surrenders">—</span></div>
          <div class="tqbj-metric"><span class="tqbj-label">Cycle</span><span class="tqbj-value" data-field="cycle">—</span></div>
        </div>
        <button type="button" class="tqbj-icon tqbj-collapse" title="Minimize">−</button>
        <button type="button" class="tqbj-icon tqbj-settings" title="Settings">⚙</button>
      </div>
      <div class="tqbj-body">
        <div class="tqbj-actions">
          <button type="button" class="tqbj-primary"><span data-field="action-main">WAIT</span> <span data-field="action-sub"></span></button>
          <button type="button" class="tqbj-mini" data-outcome="win" title="Record Win">W</button>
          <button type="button" class="tqbj-mini" data-outcome="loss" title="Record Loss">L</button>
          <button type="button" class="tqbj-mini" data-outcome="surrender" title="Record Surrender">S</button>
          <button type="button" class="tqbj-mini" data-outcome="push" title="Record Push">P</button>
          <button type="button" class="tqbj-mini tqbj-undo" title="Undo last result">↶</button>
          <button type="button" class="tqbj-mini tqbj-reset" title="Reset current cycle">R</button>
        </div>
        <div class="tqbj-status" data-field="status">Ready</div>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector(".tqbj-primary").addEventListener("click", performPrimary);
    root.querySelector(".tqbj-settings").addEventListener("click", openSettings);
    root.querySelector(".tqbj-collapse").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      saveState();
      render();
    });
    root.querySelector(".tqbj-undo").addEventListener("click", undoLast);
    root.querySelector(".tqbj-reset").addEventListener("click", resetCycle);
    root.querySelectorAll("[data-outcome]").forEach((button) => {
      button.addEventListener("click", () => finishRound(button.dataset.outcome, "manual", "Manual correction"));
    });
  }

  function buildModal() {
    if (document.getElementById(MODAL_ID)) return;
    modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <form class="tqbj-card">
        <h2>Blackjack Cycle Settings</h2>
        <p>One amount per line. A win resets the cycle, a loss advances, a push repeats, and surrender advances after recording half the wager as lost.</p>
        <label for="tqbj-ladder">Bet ladder</label>
        <textarea id="tqbj-ladder" name="ladder" spellcheck="false"></textarea>
        <div class="tqbj-help">Use full amounts or shortcuts such as 250k, 3m, or 100m. Maximum 20 steps.</div>
        <label for="tqbj-current-step">Current step</label>
        <input id="tqbj-current-step" name="currentStep" type="number" min="1" step="1">
        <div class="tqbj-help">Changing the ladder or step starts a clean cycle. Your lifetime record is preserved.</div>
        <div class="tqbj-error" role="alert"></div>
        <div class="tqbj-modal-actions">
          <button type="submit" class="tqbj-save">Save</button>
          <button type="button" class="tqbj-close">Cancel</button>
          <button type="button" class="tqbj-undo-modal">Undo Last Result</button>
          <button type="button" class="tqbj-reset-cycle">Reset Cycle</button>
          <button type="button" class="tqbj-danger tqbj-reset-stats">Reset Record</button>
          <button type="button" class="tqbj-defaults">Restore Default Ladder</button>
        </div>
      </form>
    `;
    document.body.appendChild(modal);
    const form = modal.querySelector("form");
    modal.addEventListener("pointerdown", (event) => {
      if (event.target === modal) closeSettings();
    });
    form.querySelector(".tqbj-close").addEventListener("click", closeSettings);
    form.querySelector(".tqbj-undo-modal").addEventListener("click", () => {
      undoLast();
      openSettings();
    });
    form.querySelector(".tqbj-reset-cycle").addEventListener("click", () => {
      resetCycle();
      openSettings();
    });
    form.querySelector(".tqbj-reset-stats").addEventListener("click", () => {
      if (confirm("Reset the blackjack win/loss record and history?")) {
        resetStats();
        openSettings();
      }
    });
    form.querySelector(".tqbj-defaults").addEventListener("click", () => {
      form.elements.ladder.value = DEFAULT_LADDER.join("\n");
      form.elements.currentStep.value = "1";
      form.querySelector(".tqbj-error").textContent = "Defaults loaded. Tap Save to apply.";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const error = form.querySelector(".tqbj-error");
      try {
        const ladder = parseLadderText(form.elements.ladder.value);
        const step = Math.floor(Number(form.elements.currentStep.value) || 1) - 1;
        if (step < 0 || step >= ladder.length) throw new Error(`Current step must be between 1 and ${ladder.length}.`);
        const ladderChanged = JSON.stringify(ladder) !== JSON.stringify(state.ladder);
        const stepChanged = step !== state.step;
        state.ladder = ladder;
        if (ladderChanged || stepChanged) {
          state.step = step;
          state.cycleNet = 0;
          state.activeRound = null;
          state.loadedAmount = 0;
          state.atEnd = false;
          state.status = "Cycle updated";
        }
        saveState();
        closeSettings();
        render();
      } catch (problem) {
        error.textContent = problem.message;
      }
    });
  }

  function openSettings() {
    if (!modal) buildModal();
    const form = modal.querySelector("form");
    form.elements.ladder.value = state.ladder.join("\n");
    form.elements.currentStep.max = String(state.ladder.length);
    form.elements.currentStep.value = String(state.step + 1);
    form.querySelector(".tqbj-error").textContent = "";
    form.querySelector(".tqbj-undo-modal").disabled = !state.history.length;
    modal.classList.add("tqbj-open");
  }

  function closeSettings() {
    modal?.classList.remove("tqbj-open");
  }

  function setField(name, value) {
    const element = root?.querySelector(`[data-field="${name}"]`);
    if (element && element.textContent !== String(value)) element.textContent = String(value);
  }

  function render() {
    if (!root) return;
    const stats = state.stats;
    const recordLosses = stats.losses + stats.surrenders;
    setField("next", state.atEnd ? "LIMIT" : formatMoney(nextBet()));
    setField("step", `${state.step + 1}/${state.ladder.length}`);
    setField("record", `${stats.wins}-${recordLosses}`);
    setField("wins", stats.wins);
    setField("losses", stats.losses);
    setField("surrenders", stats.surrenders);
    setField("cycle", formatMoney(state.cycleNet));
    setField("status", state.status);
    const primary = primaryState();
    setField("action-main", primary.label);
    setField("action-sub", primary.sub ? ` ${primary.sub}` : "");
    const primaryButton = root.querySelector(".tqbj-primary");
    primaryButton.dataset.color = primary.color;
    primaryButton.disabled = !primary.action;
    const roundActive = Boolean(state.activeRound);
    root.querySelectorAll("[data-outcome]").forEach((button) => { button.disabled = !roundActive; });
    root.querySelector(".tqbj-undo").disabled = !state.history.length;
    root.classList.toggle("tqbj-collapsed", state.collapsed);
    root.querySelector(".tqbj-collapse").textContent = state.collapsed ? "+" : "−";
  }

  function mutationIsOurs(mutation) {
    const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
    return Boolean(element?.closest?.(`#${ROOT_ID}, #${MODAL_ID}`));
  }

  function observePage() {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      if (mutations.every(mutationIsOurs)) return;
      scheduleScan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "aria-disabled", "style", "value"],
    });
  }

  function trackNativeGameActions(event) {
    if (!state.activeRound) return;
    const control = event.target.closest?.("button, input, a, [role='button']");
    if (!control || control.closest(`#${ROOT_ID}, #${MODAL_ID}`)) return;
    const text = `${controlText(control)} ${control.getAttribute("data-action") || ""} ${control.getAttribute("data-step") || ""}`;
    if (/\bdouble(?: down)?\b/i.test(text) && !state.activeRound.doubled) {
      state.activeRound.wager *= 2;
      state.activeRound.doubled = true;
      state.status = `Double tracked: ${formatMoney(state.activeRound.wager)}`;
      saveState();
      render();
    } else if (/\bsplit\b/i.test(text) && !state.activeRound.split) {
      state.activeRound.split = true;
      state.status = "Split detected — verify result manually";
      saveState();
      render();
    }
  }

  function isBlackjackLocation() {
    const url = new URL(location.href);
    return (
      (url.pathname.toLowerCase() === "/page.php" && url.searchParams.get("sid")?.toLowerCase() === "blackjack") ||
      (url.pathname.toLowerCase() === "/pda.php" && url.searchParams.get("step")?.toLowerCase() === "blackjack")
    );
  }

  function mount() {
    if (!document.body || !isBlackjackLocation()) return;
    injectStyles();
    buildRoot();
    buildModal();
    observePage();
    document.addEventListener("click", trackNativeGameActions, true);
    render();
    scheduleScan();
  }

  mount();
})();
