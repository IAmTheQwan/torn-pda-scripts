// ==UserScript==
// @name         TheQwan Fast Trade
// @namespace    theqwan.torn.fast-trade
// @version      1.0.3
// @description  PDA-friendly, manual-tap quick access, cash deposit, and trade acceptance
// @author       TheQwan [3485263]
// @match        https://www.torn.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/fast-trade/theqwan-fast-trade.meta.js
// @downloadURL  https://raw.githubusercontent.com/IAmTheQwan/torn-pda-scripts/fast-trade/theqwan-fast-trade.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT = "TheQwan Fast Trade";
  const ROOT_ID = "tqft-root";
  const MODAL_ID = "tqft-modal";
  const STORAGE_PREFIX = "theqwanFastTrade.";
  const HOLD_MS = 3000;
  const MOVE_CANCEL_PX = 14;
  const BUSY_FAILSAFE_MS = 12000;

  const KEYS = {
    targetId: `${STORAGE_PREFIX}targetId`,
    targetName: `${STORAGE_PREFIX}targetName`,
    description: `${STORAGE_PREFIX}description`,
    reserve: `${STORAGE_PREFIX}reserve`,
    tradeId: `${STORAGE_PREFIX}tradeId`,
  };

  const COLORS = {
    setup: "purple",
    go: "green",
    start: "yellow",
    money: "yellow",
    add: "orange",
    accept: "blue",
    final: "green",
    wait: "gray",
    busy: "gray",
    done: "purple",
    error: "red",
  };

  let launcher;
  let actionButton;
  let actionMain;
  let actionSub;
  let modal;
  let currentState = null;
  let evaluationQueued = false;
  let observer = null;
  let busy = null;
  let busyFailsafe = null;
  let pendingTargetId = "";

  function getStored(key, fallback = "") {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) return value;
    } catch (error) {
      console.warn(`[${SCRIPT}] Could not read local storage.`, error);
    }
    try {
      if (typeof GM_getValue === "function") {
        const value = GM_getValue(key, fallback);
        // Torn PDA may implement GM storage asynchronously. The state machine is
        // intentionally synchronous, so a Promise cannot be treated as a value.
        if (!value || typeof value.then !== "function") return value;
      }
    } catch (error) {
      console.warn(`[${SCRIPT}] Could not read userscript storage fallback.`, error);
    }
    return fallback;
  }

  function setStored(key, value) {
    let localSaved = false;
    try {
      localStorage.setItem(key, String(value));
      localSaved = true;
    } catch (error) {
      console.warn(`[${SCRIPT}] Could not write local storage.`, error);
    }
    try {
      if (typeof GM_setValue === "function") {
        const pending = GM_setValue(key, value);
        if (pending && typeof pending.catch === "function") {
          pending.catch((error) => console.warn(`[${SCRIPT}] Could not mirror userscript storage.`, error));
        }
        return;
      }
    } catch (error) {
      if (!localSaved) console.warn(`[${SCRIPT}] Could not write userscript storage fallback.`, error);
    }
  }

  function settings() {
    return {
      targetId: String(getStored(KEYS.targetId, "")).replace(/\D/g, ""),
      targetName: String(getStored(KEYS.targetName, "")).trim(),
      description: String(getStored(KEYS.description, "Storage")).trim() || "Storage",
      reserve: Math.max(0, parseMoney(getStored(KEYS.reserve, "0"))),
      tradeId: String(getStored(KEYS.tradeId, "")).replace(/\D/g, ""),
    };
  }

  function addStyles(css) {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
      return;
    }
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectStyles() {
    addStyles(`
      #${ROOT_ID} {
        position: fixed;
        top: max(168px, calc(env(safe-area-inset-top, 0px) + 72px));
        left: 8px;
        z-index: 2147483600;
        width: 64px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-tap-highlight-color: transparent;
      }
      #${ROOT_ID} .tqft-action {
        --tqft-color: #6d7780;
        --tqft-dark: #4d555c;
        appearance: none;
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 64px;
        height: 64px;
        margin: 0;
        padding: 4px;
        overflow: hidden;
        border: 2px solid rgba(255,255,255,.7);
        border-radius: 15px;
        background: linear-gradient(145deg, var(--tqft-color), var(--tqft-dark));
        box-shadow: 0 3px 10px rgba(0,0,0,.55), inset 0 1px rgba(255,255,255,.18);
        color: #fff;
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
      }
      #${ROOT_ID} .tqft-action:active { transform: scale(.96); }
      #${ROOT_ID} .tqft-action[data-color="green"]  { --tqft-color:#13a554; --tqft-dark:#087436; }
      #${ROOT_ID} .tqft-action[data-color="yellow"] { --tqft-color:#d6a810; --tqft-dark:#8c6a00; }
      #${ROOT_ID} .tqft-action[data-color="orange"] { --tqft-color:#f07822; --tqft-dark:#a7440b; }
      #${ROOT_ID} .tqft-action[data-color="blue"]   { --tqft-color:#1688e8; --tqft-dark:#075ba5; }
      #${ROOT_ID} .tqft-action[data-color="purple"] { --tqft-color:#8f55d7; --tqft-dark:#5d2b9c; }
      #${ROOT_ID} .tqft-action[data-color="red"]    { --tqft-color:#d9384e; --tqft-dark:#8f1425; }
      #${ROOT_ID} .tqft-action[data-color="gray"]   { --tqft-color:#687078; --tqft-dark:#41474d; }
      #${ROOT_ID} .tqft-action[aria-disabled="true"] { cursor: default; filter: saturate(.65); }
      #${ROOT_ID} .tqft-main {
        display: block;
        font-size: 14px;
        font-weight: 800;
        line-height: 16px;
        letter-spacing: .2px;
        text-shadow: 0 1px 2px rgba(0,0,0,.7);
      }
      #${ROOT_ID} .tqft-sub {
        display: block;
        max-width: 57px;
        overflow: hidden;
        font-size: 9px;
        font-weight: 700;
        line-height: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: .95;
      }
      #${ROOT_ID} .tqft-action.tqft-holding::after {
        content: "";
        position: absolute;
        inset: 2px;
        border: 3px solid transparent;
        border-top-color: #fff;
        border-radius: 13px;
        animation: tqft-hold ${HOLD_MS}ms linear forwards;
        pointer-events: none;
      }
      @keyframes tqft-hold { to { transform: rotate(360deg); } }
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483640;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 18px;
        background: rgba(0,0,0,.72);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${MODAL_ID}.tqft-open { display: flex; }
      #${MODAL_ID} .tqft-card {
        width: min(420px, 100%);
        max-height: calc(100vh - 36px);
        overflow: auto;
        box-sizing: border-box;
        padding: 16px;
        border: 1px solid #50555a;
        border-radius: 12px;
        background: #202326;
        box-shadow: 0 10px 35px rgba(0,0,0,.7);
        color: #eceff1;
      }
      #${MODAL_ID} h2 { margin: 0 0 5px; font-size: 20px; }
      #${MODAL_ID} p { margin: 0 0 13px; color: #bbc1c6; font-size: 12px; line-height: 1.4; }
      #${MODAL_ID} label { display:block; margin:10px 0 4px; font-size:12px; font-weight:700; }
      #${MODAL_ID} input {
        width: 100%;
        min-height: 40px;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid #555b60;
        border-radius: 7px;
        background: #121416;
        color: #fff;
        font-size: 16px;
      }
      #${MODAL_ID} .tqft-help { margin-top:4px; color:#929aa1; font-size:10px; }
      #${MODAL_ID} .tqft-error { min-height:17px; margin-top:8px; color:#ff7788; font-size:12px; }
      #${MODAL_ID} .tqft-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
      #${MODAL_ID} button {
        min-height: 40px;
        flex: 1 1 100px;
        padding: 8px 10px;
        border: 1px solid #5b6268;
        border-radius: 7px;
        background: #343a40;
        color: #fff;
        font-weight: 700;
      }
      #${MODAL_ID} button.tqft-save { background:#087c3b; border-color:#18a859; }
      #${MODAL_ID} button.tqft-clear { background:#542a2e; border-color:#865059; }
      @media (min-width: 720px) {
        #${ROOT_ID} { top: max(72px, calc(env(safe-area-inset-top, 0px) + 54px)); }
      }
      @media (prefers-reduced-motion: reduce) {
        #${ROOT_ID} .tqft-action.tqft-holding::after { animation: none; border-color:#fff; }
      }
    `);
  }

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : 0;
    const text = String(value || "").trim().toLowerCase().replace(/,/g, "");
    const match = text.match(/(-?\d+(?:\.\d+)?)\s*([kmbt])?/i);
    if (!match) return 0;
    const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
    const amount = Number(match[1]) * (multipliers[match[2]] || 1);
    return Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  }

  function formatMoney(amount) {
    const value = Math.max(0, Number(amount) || 0);
    if (value >= 1e12) return `$${trimDecimal(value / 1e12)}T`;
    if (value >= 1e9) return `$${trimDecimal(value / 1e9)}B`;
    if (value >= 1e6) return `$${trimDecimal(value / 1e6)}M`;
    if (value >= 1e3) return `$${trimDecimal(value / 1e3)}K`;
    return `$${Math.floor(value)}`;
  }

  function trimDecimal(value) {
    return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.?0+$/, "");
  }

  function hashParams() {
    return new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  }

  function route() {
    const params = hashParams();
    return {
      isTrade: location.pathname.toLowerCase() === "/trade.php",
      step: String(params.get("step") || "").toLowerCase(),
      tradeId: String(params.get("ID") || params.get("id") || "").replace(/\D/g, ""),
      targetId: String(params.get("userID") || params.get("userid") || "").replace(/\D/g, ""),
    };
  }

  function routeSignature() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function visible(element) {
    if (!element || element.closest(`#${ROOT_ID}, #${MODAL_ID}`)) return false;
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
  }

  function controlText(element) {
    return String(
      element?.value ||
      element?.textContent ||
      element?.getAttribute("aria-label") ||
      element?.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  function controlsWithin(root = document) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('button, input[type="button"], input[type="submit"], a.torn-btn, span.btn'));
  }

  function findControl(root, pattern, selectors = []) {
    for (const selector of selectors) {
      const element = root?.querySelector(selector);
      if (visible(element)) return element;
    }
    return controlsWithin(root).find((element) => visible(element) && pattern.test(controlText(element))) || null;
  }

  function nativeDisabled(element) {
    if (!element) return true;
    return Boolean(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled") ||
      element.closest(".disabled")
    );
  }

  function tradeRoot() {
    return document.querySelector("#trade-container") || document.querySelector(".trade-cont") || null;
  }

  function exactProfileLink(root, targetId) {
    if (!root || !targetId) return null;
    return Array.from(root.querySelectorAll('a[href*="profiles.php"]')).find((anchor) => {
      try {
        const url = new URL(anchor.href, location.origin);
        return String(url.searchParams.get("XID") || "") === String(targetId);
      } catch {
        return false;
      }
    }) || null;
  }

  function targetVerified(config, currentRoute) {
    if (!config.targetId) return false;
    if (currentRoute.step === "start") return currentRoute.targetId === config.targetId;
    if (currentRoute.tradeId && config.tradeId === currentRoute.tradeId) return true;
    return Boolean(exactProfileLink(tradeRoot(), config.targetId));
  }

  function rememberVisibleTrade(config, currentRoute) {
    if (!currentRoute.tradeId || config.tradeId === currentRoute.tradeId) return;
    const verifiedByProfile = Boolean(exactProfileLink(tradeRoot(), config.targetId));
    const verifiedFromStart = pendingTargetId === config.targetId;
    if (!verifiedByProfile && !verifiedFromStart) return;
    setStored(KEYS.tradeId, currentRoute.tradeId);
    pendingTargetId = "";
  }

  function formRoot() {
    const input = moneyInputs().visible;
    return input?.form || document.querySelector(".init-trade.add-money") || tradeRoot() || document;
  }

  function moneyInputs() {
    const all = Array.from(document.querySelectorAll("input.input-money, input.user-id"));
    const visibleInput = all.find((input) => input.type !== "hidden" && visible(input)) ||
      all.find((input) => input.type !== "hidden") || null;
    const hidden = all.filter((input) => input !== visibleInput && input.type === "hidden");
    if (visibleInput?.parentElement) {
      visibleInput.parentElement.querySelectorAll('input[type="hidden"].input-money').forEach((input) => {
        if (!hidden.includes(input)) hidden.push(input);
      });
    }
    return { visible: visibleInput, hidden };
  }

  function setNativeInputValue(input, value) {
    if (!input) return;
    const prototype = typeof HTMLTextAreaElement !== "undefined" && input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function readWalletCash() {
    const direct = Array.from(document.querySelectorAll(".money-value"))
      .map((element) => parseMoney(element.textContent))
      .find((amount) => amount > 0);
    if (direct) return direct;

    const scope = document.querySelector(".init-trade.add-money") || tradeRoot() || document;
    const nodes = Array.from(scope.querySelectorAll("p, span, div, li"));
    for (const element of nodes) {
      if (element.children.length > 4) continue;
      const text = String(element.textContent || "").replace(/\s+/g, " ");
      const match = text.match(/(?:you have|money:)\s*\$\s*([\d,.]+)\s*([kmbt])?/i);
      if (match) {
        const amount = parseMoney(`${match[1]}${match[2] || ""}`);
        if (amount > 0) return amount;
      }
    }
    return 0;
  }

  function currentInputAmount() {
    return parseMoney(moneyInputs().visible?.value || "0");
  }

  function writeMoneyAmount(amount) {
    const inputs = moneyInputs();
    if (!inputs.visible || amount <= 0) return false;
    const formatted = Math.floor(amount).toLocaleString("en-US");
    if (parseMoney(inputs.visible.value) !== amount) setNativeInputValue(inputs.visible, formatted);
    inputs.hidden.forEach((input) => {
      if (parseMoney(input.value) !== amount) setNativeInputValue(input, String(Math.floor(amount)));
    });
    return true;
  }

  function prepareMoney(config, allowNativeMax = false) {
    const wallet = readWalletCash();
    if (wallet > config.reserve) {
      const amount = wallet - config.reserve;
      writeMoneyAmount(amount);
      return amount;
    }

    if (allowNativeMax) {
      const root = formRoot();
      const maxButton = findControl(root, /^(?:max|all|\$)$/i, [
        ".input-money-symbol input.wai-btn",
        'input.wai-btn[type="button"]',
      ]);
      if (maxButton) {
        maxButton.click();
        const amount = Math.max(0, currentInputAmount() - config.reserve);
        if (amount > 0) writeMoneyAmount(amount);
        return amount;
      }
    }

    const existing = currentInputAmount();
    return existing > 0 ? existing : 0;
  }

  function submitMoneyButton() {
    const root = formRoot();
    return findControl(root, /^(?:change|add money|deposit|confirm)$/i, [
      'input.torn-btn[type="submit"][value="Change"]',
      'input[type="submit"].torn-btn',
      'button[type="submit"].torn-btn',
    ]);
  }

  function ownMoneyInTrade() {
    const root = tradeRoot();
    if (!root) return 0;
    const candidates = [
      ".user.left .cont li.color1 .name.left",
      ".user-left-wrapper .money-cont .money-value",
      ".user.left .money-cont .money-value",
    ];
    for (const selector of candidates) {
      const element = root.querySelector(selector);
      const amount = parseMoney(element?.textContent);
      if (amount > 0) return amount;
    }
    return 0;
  }

  function startButton() {
    const root = document.querySelector(".init-trade") || tradeRoot();
    return findControl(root, /(?:initiate|start|create)\s+(?:the\s+)?trade/i, [
      'input[type="submit"].torn-btn',
      'button[type="submit"].torn-btn',
    ]);
  }

  function newTradeUserField(root) {
    if (!root) return null;
    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'))
      .filter((input) => !input.closest(`#${MODAL_ID}`));
    if (!inputs.length) return null;

    const scored = inputs.map((input, index) => {
      const identity = `${input.name} ${input.id} ${input.className} ${input.placeholder} ${input.getAttribute("aria-label") || ""}`;
      const surrounding = String(input.closest("li, .row, .input-wrap, .cont")?.textContent || "");
      let score = 0;
      if (/user.?id|player|recipient|person|user.?search/i.test(identity)) score += 20;
      if (/user\s*id\s*:/i.test(surrounding)) score += 12;
      if (input.type === "search") score += 8;
      if (/desc|message|reason/i.test(identity)) score -= 30;
      score -= index;
      return { input, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].score >= 0 ? scored[0].input : null;
  }

  function newTradeDescriptionField(root, userField) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('textarea, input[type="text"]'))
      .filter((input) => input !== userField && !input.closest(`#${MODAL_ID}`));
    return candidates.find((input) => {
      const identity = `${input.name} ${input.id} ${input.className} ${input.placeholder} ${input.getAttribute("aria-label") || ""}`;
      const surrounding = String(input.closest("li, .row, .input-wrap, .cont")?.textContent || "");
      return /desc|message|reason/i.test(identity) || /description\s*:/i.test(surrounding);
    }) || candidates[0] || null;
  }

  function newTradeSearchControl(root, userField) {
    if (!root || !userField) return null;
    let scope = userField.parentElement;
    for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
      const candidates = Array.from(scope.querySelectorAll(
        'button, input[type="button"], a, [role="button"], [class*="search"], [class*="magnif"]'
      ));
      const control = candidates.find((element) => {
        if (element === userField || element.closest(`#${ROOT_ID}, #${MODAL_ID}`) || !visible(element)) return false;
        const identity = `${controlText(element)} ${element.className || ""}`;
        return /search|find|magnif/i.test(identity);
      });
      if (control) {
        return control.closest('button, a, [role="button"], .btn') || control;
      }
    }
    return null;
  }

  function prepareStartForm(config) {
    const root = document.querySelector(".init-trade") || tradeRoot();
    if (!root) return;
    const userInput = newTradeUserField(root);
    if (userInput && String(userInput.value || "").trim() !== config.targetName) {
      setNativeInputValue(userInput, config.targetName);
    }
    const description = newTradeDescriptionField(root, userInput);
    if (description && !String(description.value || "").trim()) {
      setNativeInputValue(description, config.description);
    }
  }

  function viewAcceptButton() {
    const root = tradeRoot();
    if (!root) return null;
    return findControl(root, /^accept(?: trade)?$/i, [
      ".btn.accept.torn-btn.green",
      "button.btn.accept.torn-btn",
      "input.btn.accept.torn-btn",
    ]);
  }

  function finalAcceptButton() {
    const root = tradeRoot();
    if (!root) return null;
    const candidates = controlsWithin(root).filter((element) => {
      const text = controlText(element);
      return /^(?:confirm|accept|accept trade|finalize|complete)(?: trade)?$/i.test(text);
    });
    return candidates.find((element) => !nativeDisabled(element) && visible(element)) || candidates[0] || null;
  }

  function pageMessage() {
    const root = tradeRoot();
    if (!root) return "";
    return Array.from(root.querySelectorAll(".info-msg-cont .msg, .info-msg, [role='alert']"))
      .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
  }

  function state(key, main, sub, color, action = "", control = null) {
    return { key, main, sub, color: COLORS[color] || color, action, control };
  }

  function calculateState() {
    const config = settings();
    const currentRoute = route();

    if (!config.targetId) {
      return state("setup", "SET", "hold 3s", "setup", "settings");
    }

    if (!config.targetName) {
      return state("username-setup", "NAME", "set username", "error", "settings");
    }

    if (!currentRoute.isTrade) {
      return state("go", "GO", config.targetName || `ID ${config.targetId}`, "go", "go");
    }

    rememberVisibleTrade(config, currentRoute);
    const refreshedConfig = settings();
    const verified = targetVerified(refreshedConfig, currentRoute);
    const message = pageMessage();

    if (currentRoute.tradeId && /expired|does not exist|no longer exists|no current trade|invalid trade/i.test(message)) {
      return state("stale", "NEW", "trade expired", "error", "restart");
    }

    if (currentRoute.step === "start") {
      if (currentRoute.targetId !== refreshedConfig.targetId) {
        return state("wrong-start", "WRONG", "hold to fix", "error", "settings");
      }
      prepareStartForm(refreshedConfig);
      const control = startButton();
      if (!control) return state("start-loading", "WAIT", "start page", "wait");
      return state("start-ready", "START", "trade", "start", "start", control);
    }

    if (currentRoute.step === "addmoney") {
      if (!verified) return state("wrong-money", "BLOCK", "wrong trade", "error", "settings");
      const amount = prepareMoney(refreshedConfig, false);
      const control = submitMoneyButton();
      if (!moneyInputs().visible || !control) return state("money-loading", "WAIT", "cash form", "wait");
      if (nativeDisabled(control)) return state("money-disabled", "WAIT", "Torn busy", "wait");
      if (amount <= 0) return state("no-cash", "NO $", "nothing to add", "error", "settings");
      return state(`add-ready:${amount}`, "ADD", formatMoney(amount), "add", "add", control);
    }

    const isView = currentRoute.step === "view" || (!currentRoute.step && currentRoute.tradeId);
    if (isView) {
      if (!verified) return state("wrong-view", "BLOCK", "wrong trade", "error", "settings");
      const cash = ownMoneyInTrade();
      const accept = viewAcceptButton();
      if (cash <= 0) {
        return state("open-money", "MONEY", "open form", "money", "money");
      }
      if (accept && !nativeDisabled(accept)) {
        return state(`accept-ready:${cash}`, "LOCK", formatMoney(cash), "accept", "accept", accept);
      }
      if (/complete|completed|successfully accepted|trade has been accepted/i.test(message)) {
        return state("done", "DONE", "cash stored", "done");
      }
      return state(`waiting:${cash}`, "WAIT", "accept locked", "wait");
    }

    if (currentRoute.tradeId && verified) {
      const finalControl = finalAcceptButton();
      if (finalControl && !nativeDisabled(finalControl) && visible(finalControl)) {
        return state("final-ready", "FINAL", "accept", "final", "final", finalControl);
      }
      if (/complete|completed|successfully accepted|trade has been accepted/i.test(message) || currentRoute.step === "accept2") {
        return state("done", "DONE", "trade accepted", "done");
      }
      const countdown = message.match(/(\d+)\s*seconds?/i)?.[1];
      return state(`final-wait:${countdown || ""}`, "WAIT", countdown ? `${countdown}s` : "Torn confirmation", "wait");
    }

    if (!currentRoute.step) {
      const root = document.querySelector(".init-trade") || tradeRoot();
      prepareStartForm(refreshedConfig);
      const initiate = startButton();
      if (initiate && !nativeDisabled(initiate)) {
        return state("home-start-ready", "START", "trade", "start", "start", initiate);
      }
      const userField = newTradeUserField(root);
      const search = newTradeSearchControl(root, userField);
      if (userField && search) {
        return state("home-search-ready", "FIND", refreshedConfig.targetName || `ID ${refreshedConfig.targetId}`, "start", "search", search);
      }
      if (userField) {
        return state("home-filled", "READY", "target filled", "wait");
      }
      return state("trade-home", "GO", refreshedConfig.targetName || `ID ${refreshedConfig.targetId}`, "go", "go");
    }

    return state("unverified", "BLOCK", "wrong trade", "error", "settings");
  }

  function applyState(nextState) {
    if (!actionButton) return;
    currentState = nextState;
    if (actionMain.textContent !== nextState.main) actionMain.textContent = nextState.main;
    if (actionSub.textContent !== nextState.sub) actionSub.textContent = nextState.sub;
    if (actionButton.dataset.color !== nextState.color) actionButton.dataset.color = nextState.color;
    const disabled = !nextState.action;
    if (actionButton.getAttribute("aria-disabled") !== String(disabled)) {
      actionButton.setAttribute("aria-disabled", String(disabled));
    }
    const title = `${nextState.main}${nextState.sub ? ` — ${nextState.sub}` : ""}. Hold 3 seconds for settings.`;
    if (actionButton.title !== title) actionButton.title = title;
    if (actionButton.getAttribute("aria-label") !== title) actionButton.setAttribute("aria-label", title);
  }

  function evaluate() {
    evaluationQueued = false;
    if (!actionButton || modal?.classList.contains("tqft-open")) return;
    const nextState = calculateState();
    if (busy) {
      const routeChanged = busy.route !== routeSignature();
      const stateChanged = busy.originKey !== nextState.key;
      if (routeChanged || stateChanged) clearBusy();
      else {
        applyState(state("busy", "WAIT", busy.label, "busy"));
        return;
      }
    }
    applyState(nextState);
  }

  function scheduleEvaluate() {
    if (evaluationQueued) return;
    evaluationQueued = true;
    queueMicrotask(evaluate);
  }

  function setBusy(originState, label = "Torn processing") {
    clearBusy();
    busy = {
      route: routeSignature(),
      originKey: originState.key,
      label,
    };
    applyState(state("busy", "WAIT", label, "busy"));
    busyFailsafe = setTimeout(() => {
      busy = null;
      busyFailsafe = null;
      scheduleEvaluate();
    }, BUSY_FAILSAFE_MS);
  }

  function clearBusy() {
    busy = null;
    if (busyFailsafe) clearTimeout(busyFailsafe);
    busyFailsafe = null;
  }

  function goUrl(config) {
    if (config.tradeId) return `https://www.torn.com/trade.php#step=addmoney&ID=${encodeURIComponent(config.tradeId)}`;
    return `https://www.torn.com/trade.php#step=start&userID=${encodeURIComponent(config.targetId)}`;
  }

  function clickNative(control) {
    if (!control || nativeDisabled(control) || !visible(control)) return false;
    control.click();
    return true;
  }

  function performAction() {
    if (modal?.classList.contains("tqft-open")) return;
    const fresh = calculateState();
    applyState(fresh);
    const config = settings();
    const currentRoute = route();

    switch (fresh.action) {
      case "settings":
        openSettings();
        return;
      case "go":
        pendingTargetId = config.targetId;
        setBusy(fresh, "opening trade");
        location.assign(goUrl(config));
        return;
      case "restart":
        setStored(KEYS.tradeId, "");
        pendingTargetId = config.targetId;
        setBusy(fresh, "opening new trade");
        location.assign(`https://www.torn.com/trade.php#step=start&userID=${encodeURIComponent(config.targetId)}`);
        return;
      case "start":
        prepareStartForm(config);
        pendingTargetId = config.targetId;
        setBusy(fresh, "starting trade");
        if (!clickNative(fresh.control)) clearBusy();
        return;
      case "search":
        prepareStartForm(config);
        setBusy(fresh, "finding user");
        if (!clickNative(fresh.control)) clearBusy();
        return;
      case "money":
        if (!currentRoute.tradeId) return;
        setStored(KEYS.tradeId, currentRoute.tradeId);
        setBusy(fresh, "opening cash");
        location.hash = `#step=addmoney&ID=${encodeURIComponent(currentRoute.tradeId)}`;
        return;
      case "add": {
        const amount = prepareMoney(config, true);
        const submit = submitMoneyButton();
        if (amount <= 0 || !submit) {
          clearBusy();
          scheduleEvaluate();
          return;
        }
        setBusy(fresh, `adding ${formatMoney(amount)}`);
        queueMicrotask(() => {
          if (!clickNative(submit)) {
            clearBusy();
            scheduleEvaluate();
          }
        });
        return;
      }
      case "accept":
        setBusy(fresh, "locking trade");
        if (!clickNative(fresh.control)) clearBusy();
        return;
      case "final":
        setBusy(fresh, "accepting trade");
        if (!clickNative(fresh.control)) clearBusy();
        return;
      default:
        return;
    }
  }

  function buildLauncher() {
    if (document.getElementById(ROOT_ID)) return;
    launcher = document.createElement("div");
    launcher.id = ROOT_ID;

    actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "tqft-action";
    actionButton.dataset.color = "gray";
    actionButton.setAttribute("aria-live", "polite");

    actionMain = document.createElement("span");
    actionMain.className = "tqft-main";
    actionMain.textContent = "WAIT";
    actionSub = document.createElement("span");
    actionSub.className = "tqft-sub";
    actionSub.textContent = "loading";
    actionButton.append(actionMain, actionSub);
    launcher.appendChild(actionButton);
    document.body.appendChild(launcher);

    installPressHandlers(actionButton);
    scheduleEvaluate();
  }

  function installPressHandlers(button) {
    let holdTimer = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let held = false;

    const cancelHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      button.classList.remove("tqft-holding");
    };

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      moved = false;
      held = false;
      cancelHold();
      button.classList.add("tqft-holding");
      holdTimer = setTimeout(() => {
        holdTimer = null;
        held = true;
        button.classList.remove("tqft-holding");
        if (navigator.vibrate) navigator.vibrate(35);
        openSettings();
      }, HOLD_MS);
    });

    button.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_CANCEL_PX) {
        moved = true;
        cancelHold();
      }
    });

    button.addEventListener("pointerup", (event) => {
      event.preventDefault();
      cancelHold();
      if (!moved && !held) performAction();
    });

    button.addEventListener("pointercancel", cancelHold);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
    button.addEventListener("click", (event) => event.preventDefault());
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      performAction();
    });
  }

  function buildSettings() {
    if (document.getElementById(MODAL_ID)) return;
    modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "tqft-settings-title");

    const card = document.createElement("form");
    card.className = "tqft-card";
    card.innerHTML = `
      <h2 id="tqft-settings-title">Fast Trade</h2>
      <p>Every colored tap performs at most one Torn request. Your target and settings stay only in this userscript's local storage.</p>
      <label for="tqft-target-id">Target player ID</label>
      <input id="tqft-target-id" name="targetId" inputmode="numeric" pattern="[0-9]+" autocomplete="off" required>
      <div class="tqft-help">The numeric ID from the player's profile link.</div>
      <label for="tqft-target-name">Target username</label>
      <input id="tqft-target-name" name="targetName" maxlength="24" autocomplete="off" required>
      <div class="tqft-help">The player's exact current Torn username; this is entered into Torn's New Trade search bar.</div>
      <label for="tqft-description">New-trade description</label>
      <input id="tqft-description" name="description" maxlength="64" autocomplete="off">
      <label for="tqft-reserve">Keep in wallet</label>
      <input id="tqft-reserve" name="reserve" inputmode="decimal" autocomplete="off" value="0">
      <div class="tqft-help">Use 0 to add everything. Values such as 250k or 2.5m are accepted.</div>
      <label for="tqft-trade-id">Remembered trade ID (optional)</label>
      <input id="tqft-trade-id" name="tradeId" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
      <div class="tqft-help">Filled automatically after the script verifies the target's trade.</div>
      <div class="tqft-error" role="alert"></div>
      <div class="tqft-actions">
        <button type="submit" class="tqft-save">Save</button>
        <button type="button" class="tqft-clear">Forget trade</button>
        <button type="button" class="tqft-cancel">Cancel</button>
      </div>
    `;
    modal.appendChild(card);
    document.body.appendChild(modal);

    modal.addEventListener("pointerdown", (event) => {
      if (event.target === modal) closeSettings();
    });
    card.querySelector(".tqft-cancel").addEventListener("click", closeSettings);
    card.querySelector(".tqft-clear").addEventListener("click", () => {
      setStored(KEYS.tradeId, "");
      card.elements.tradeId.value = "";
      card.querySelector(".tqft-error").textContent = "Remembered trade cleared.";
    });
    card.addEventListener("submit", (event) => {
      event.preventDefault();
      const targetId = String(card.elements.targetId.value || "").replace(/\D/g, "");
      const targetName = String(card.elements.targetName.value || "").trim();
      const tradeId = String(card.elements.tradeId.value || "").replace(/\D/g, "");
      const reserveText = String(card.elements.reserve.value || "0").trim();
      const reserve = parseMoney(reserveText);
      const error = card.querySelector(".tqft-error");
      if (!targetId) {
        error.textContent = "Enter the target player's numeric Torn ID.";
        return;
      }
      if (!targetName) {
        error.textContent = "Enter the target player's exact Torn username.";
        return;
      }
      if (reserveText && reserve === 0 && !/^\$?0+(?:\.0+)?$/i.test(reserveText.replace(/,/g, ""))) {
        error.textContent = "The wallet reserve is not a valid amount.";
        return;
      }
      setStored(KEYS.targetId, targetId);
      setStored(KEYS.targetName, targetName);
      setStored(KEYS.description, String(card.elements.description.value || "").trim() || "Storage");
      setStored(KEYS.reserve, String(reserve));
      setStored(KEYS.tradeId, tradeId);
      closeSettings();
    });
  }

  function openSettings() {
    if (!modal) buildSettings();
    clearBusy();
    const config = settings();
    const form = modal.querySelector("form");
    form.elements.targetId.value = config.targetId;
    form.elements.targetName.value = config.targetName;
    form.elements.description.value = config.description;
    form.elements.reserve.value = config.reserve ? String(config.reserve) : "0";
    form.elements.tradeId.value = config.tradeId;
    form.querySelector(".tqft-error").textContent = "";
    modal.classList.add("tqft-open");
    form.elements.targetId.focus();
  }

  function closeSettings() {
    modal?.classList.remove("tqft-open");
    scheduleEvaluate();
  }

  function mutationIsOnlyOurs(mutation) {
    const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
    return Boolean(element?.closest?.(`#${ROOT_ID}, #${MODAL_ID}`));
  }

  function observePage() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      if (mutations.every(mutationIsOnlyOurs)) return;
      scheduleEvaluate();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "aria-disabled", "value"],
    });
  }

  function mount() {
    if (!document.body) return;
    injectStyles();
    buildLauncher();
    buildSettings();
    observePage();
    window.addEventListener("hashchange", scheduleEvaluate);
    window.addEventListener("popstate", scheduleEvaluate);
    document.addEventListener("visibilitychange", scheduleEvaluate);
    scheduleEvaluate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
