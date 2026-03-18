/**
 * BrowserRecorder – actor-agnostic page-level recording layer.
 *
 * Injects a capture-phase event listener script into the page and bridges
 * events back to Node.js via console.log (compatible with Playwright's page
 * proxy which supports page.on("console") but NOT exposeBinding/exposeFunction).
 *
 * Coalesces raw DOM events into high-level Playwright action lines
 * (click, fill, press, navigate, select, scroll, etc.).
 *
 * Captures everything regardless of who is driving the browser (user,
 * or any other automation tool).
 */

const CONSOLE_PREFIX = "__BC_REC__:";

/**
 * JavaScript source injected into the browser. Uses capture-phase
 * listeners so page handlers can never suppress the events.
 *
 * Selector generator priority (mirrors Playwright):
 *   data-testid > role + name > label > placeholder > text > CSS
 */
function buildInjectedScript() {
  return `(function () {
  if (window.__bcRecorderInjected) return;
  window.__bcRecorderInjected = true;

  /* ── selector generation ────────────────────────────────────── */

  function escSel(s) {
    return String(s || "").replace(/'/g, "\\\\'");
  }

  function visibleText(el) {
    if (!el) return "";
    var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
    return t.length > 120 ? t.slice(0, 117) + "..." : t;
  }

  function ariaName(el) {
    if (!el) return "";
    var label = el.getAttribute("aria-label");
    if (label) return label.trim();
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = labelledBy.split(/\\s+/).map(function (id) {
        var ref = document.getElementById(id);
        return ref ? (ref.textContent || "").trim() : "";
      }).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    return "";
  }

  function inferRole(el) {
    var tag = (el.tagName || "").toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    var role = el.getAttribute("role");
    if (role) return role;
    if (tag === "button" || (tag === "input" && type === "submit") || (tag === "input" && type === "button")) return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input" && (type === "text" || type === "email" || type === "password" || type === "search" || type === "tel" || type === "url" || type === "number" || !type)) return "textbox";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (tag === "img") return "img";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "nav") return "navigation";
    if (tag === "li") return "listitem";
    if (tag === "ul" || tag === "ol") return "list";
    return "";
  }

  function associatedLabel(el) {
    if (el.id) {
      var lab = document.querySelector("label[for='" + CSS.escape(el.id) + "']");
      if (lab) return (lab.textContent || "").replace(/\\s+/g, " ").trim();
    }
    var parent = el.closest("label");
    if (parent) {
      var clone = parent.cloneNode(true);
      var inputs = clone.querySelectorAll("input,textarea,select");
      for (var i = 0; i < inputs.length; i++) inputs[i].remove();
      var text = (clone.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  }

  function generateSelector(el) {
    if (!el || !(el instanceof Element)) return { selector: "", method: "unknown", raw: "" };

    var testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-test-id");
    if (testId) return { selector: "page.getByTestId('" + escSel(testId) + "')", method: "testid", raw: testId };

    var role = inferRole(el);
    var name = ariaName(el) || visibleText(el);

    if (role && name) return { selector: "page.getByRole('" + escSel(role) + "', { name: '" + escSel(name) + "' })", method: "role", raw: name };

    var label = associatedLabel(el);
    if (label) return { selector: "page.getByLabel('" + escSel(label) + "')", method: "label", raw: label };

    var ph = el.getAttribute("placeholder");
    if (ph) return { selector: "page.getByPlaceholder('" + escSel(ph) + "')", method: "placeholder", raw: ph };

    var tag = (el.tagName || "").toLowerCase();
    if (name && tag !== "input" && tag !== "textarea" && tag !== "select") {
      var short = name.length > 60 ? name.slice(0, 57) + "..." : name;
      return { selector: "page.getByText('" + escSel(short) + "')", method: "text", raw: short };
    }

    var css = "";
    if (el.id) css = "#" + CSS.escape(el.id);
    else {
      css = tag;
      var cls = Array.from(el.classList).slice(0, 2).map(function (c) { return "." + CSS.escape(c); }).join("");
      if (cls) css += cls;
      var n = el.getAttribute("name");
      if (n) css = tag + "[name='" + CSS.escape(n) + "']";
    }
    return { selector: css ? "page.locator('" + escSel(css) + "')" : "page.locator('" + tag + "')", method: "css", raw: css || tag };
  }

  /* ── element metadata extraction ────────────────────────────── */

  function elementMeta(el) {
    if (!el || !(el instanceof Element)) return null;
    var tag = (el.tagName || "").toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    var sel = generateSelector(el);
    return {
      tag: tag,
      type: type,
      role: inferRole(el),
      name: ariaName(el) || associatedLabel(el) || el.getAttribute("name") || "",
      text: visibleText(el),
      placeholder: el.getAttribute("placeholder") || "",
      id: el.id || "",
      testId: el.getAttribute("data-testid") || "",
      selector: sel.selector,
      selectorMethod: sel.method,
      selectorRaw: sel.raw,
      value: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) ? el.value : null,
      checked: el instanceof HTMLInputElement ? el.checked : null,
      href: el instanceof HTMLAnchorElement ? el.href : null,
      isEditable: (tag === "input" || tag === "textarea" || tag === "select" || (el.isContentEditable === true)),
      boundingBox: (function () {
        try { var r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return null; }
      })(),
    };
  }

  /* ── event dispatch to Node.js via console.log ─────────────── */

  var _seq = 0;

  function emit(eventType, detail) {
    _seq++;
    var payload = {
      seq: _seq,
      eventType: eventType,
      ts: Date.now(),
      url: window.location.href,
      title: document.title || "",
      detail: detail || {},
    };
    try {
      console.log("${CONSOLE_PREFIX}" + JSON.stringify(payload));
    } catch (e) { /* serialization failure */ }
  }

  /* ── state for action coalescing ────────────────────────────── */

  var _pendingInput = null;
  var _lastClickTs = 0;
  var _lastClickEl = null;

  function flushPendingInput() {
    if (!_pendingInput) return;
    var p = _pendingInput;
    _pendingInput = null;
    clearTimeout(p.timer);
    var el = p.element;
    if (!el || !(el instanceof Element)) return;
    var endValue = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.value : (el.textContent || "");
    if (endValue === p.startValue) return;
    var meta = elementMeta(el);
    var type = (el.getAttribute("type") || "").toLowerCase();
    var isSensitive = (type === "password");
    emit("fill", {
      element: meta,
      value: isSensitive ? "••••••••" : endValue,
      isSensitive: isSensitive,
    });
  }

  /* ── capture-phase event handlers ───────────────────────────── */

  document.addEventListener("click", function (e) {
    flushPendingInput();
    var el = e.target;
    if (!el || !(el instanceof Element)) return;
    var now = Date.now();
    if (_lastClickEl === el && (now - _lastClickTs) < 80) return;
    _lastClickTs = now;
    _lastClickEl = el;

    var actionable = el.closest("button, a, [role='button'], input[type='submit'], input[type='button'], input[type='checkbox'], input[type='radio'], label, summary, [onclick], [tabindex]");
    var target = actionable || el;
    var meta = elementMeta(target);
    if (!meta) return;
    var tag = meta.tag;
    var type = meta.type;

    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      emit("check", { element: meta, checked: el.checked });
      return;
    }
    emit("click", { element: meta, position: { x: e.clientX, y: e.clientY } });
  }, { capture: true, passive: true });

  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!el) return;
    var isEditable = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el.isContentEditable === true));
    if (!isEditable) return;

    if (_pendingInput && _pendingInput.element === el) {
      clearTimeout(_pendingInput.timer);
      _pendingInput.timer = setTimeout(flushPendingInput, 600);
      return;
    }

    flushPendingInput();
    var startValue = "";
    _pendingInput = {
      element: el,
      startValue: startValue,
      timer: setTimeout(flushPendingInput, 600),
    };
  }, { capture: true, passive: true });

  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el) return;
    if (el instanceof HTMLSelectElement) {
      flushPendingInput();
      var meta = elementMeta(el);
      var selected = el.options[el.selectedIndex];
      emit("select", {
        element: meta,
        value: el.value,
        label: selected ? selected.text : el.value,
      });
      return;
    }
    if (_pendingInput && _pendingInput.element === el) {
      flushPendingInput();
    }
  }, { capture: true, passive: true });

  document.addEventListener("keydown", function (e) {
    var key = e.key;
    var special = ["Enter", "Tab", "Escape", "Backspace", "Delete",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "End", "PageUp", "PageDown",
      "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
    var isModified = e.ctrlKey || e.metaKey || e.altKey;
    if (!special.includes(key) && !isModified) return;

    if (key === "Enter") flushPendingInput();

    var combo = "";
    if (e.ctrlKey) combo += "Control+";
    if (e.metaKey) combo += "Meta+";
    if (e.altKey) combo += "Alt+";
    if (e.shiftKey && (isModified || special.includes(key))) combo += "Shift+";
    combo += key;
    emit("press", { key: combo, element: elementMeta(e.target) });
  }, { capture: true, passive: true });

  document.addEventListener("submit", function (e) {
    flushPendingInput();
    var form = e.target;
    if (form instanceof HTMLFormElement) {
      emit("submit", { element: elementMeta(form), action: form.action || "" });
    }
  }, { capture: true, passive: true });

  /* ── scroll tracking (throttled) ────────────────────────────── */

  var _scrollTimer = null;
  var _scrollStart = null;
  window.addEventListener("scroll", function () {
    if (!_scrollStart) _scrollStart = { x: window.scrollX, y: window.scrollY, ts: Date.now() };
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(function () {
      if (_scrollStart) {
        var dx = window.scrollX - _scrollStart.x;
        var dy = window.scrollY - _scrollStart.y;
        if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
          emit("scroll", { deltaX: dx, deltaY: dy, finalX: window.scrollX, finalY: window.scrollY });
        }
        _scrollStart = null;
      }
    }, 300);
  }, { capture: true, passive: true });

  /* ── navigation tracking ────────────────────────────────────── */

  var _lastUrl = window.location.href;

  function checkNavigation() {
    var current = window.location.href;
    if (current !== _lastUrl) {
      emit("navigate", { from: _lastUrl, to: current });
      _lastUrl = current;
    }
  }

  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;
  history.pushState = function () {
    var result = origPushState.apply(this, arguments);
    setTimeout(checkNavigation, 0);
    return result;
  };
  history.replaceState = function () {
    var result = origReplaceState.apply(this, arguments);
    setTimeout(checkNavigation, 0);
    return result;
  };
  window.addEventListener("popstate", function () { setTimeout(checkNavigation, 0); });
  window.addEventListener("hashchange", function () { setTimeout(checkNavigation, 0); });

  /* ── page lifecycle ─────────────────────────────────────────── */

  emit("pageload", {
    url: window.location.href,
    title: document.title,
    readyState: document.readyState,
  });

  if (document.readyState !== "complete") {
    window.addEventListener("load", function () {
      emit("pageready", { url: window.location.href, title: document.title });
    });
  }

  window.addEventListener("beforeunload", function () {
    flushPendingInput();
  });
})();`;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Node.js side: BrowserRecorder
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logInfo, logError } from "../logger.js";

/**
 * @typedef {object} RecordedAction
 * @property {number}  seq
 * @property {string}  action       - click, fill, press, navigate, select, scroll, check
 * @property {string}  playwright   - Executable Playwright code line
 * @property {string}  selector
 * @property {string}  selectorMethod
 * @property {string}  [target]
 * @property {string}  [value]
 * @property {number}  ts
 * @property {string}  url
 */

export class BrowserRecorder {
  constructor({ sessionId, maxActions } = {}) {
    this.sessionId = sessionId || "";
    this.maxActions = maxActions || 2000;

    /** @type {RecordedAction[]} */
    this._actions = [];
    /** @type {object[]} */
    this._rawEvents = [];
    this._maxRawEvents = 5000;
    this._seq = 0;
    this._attached = false;
    this._startedAt = null;
    this._stoppedAt = null;
    this._running = false;
    this._lastNavigateUrl = "";
    this._consoleHandler = null;
  }

  get isRunning() { return this._running; }
  get actionCount() { return this._actions.length; }

  /**
   * Attach to a Playwright Page.
   * Uses console.log as the communication bridge.
   * @param {import('playwright').Page} page
   */
  async attach(page) {
    if (this._attached) return;
    this._attached = true;
    this._running = true;
    this._startedAt = new Date().toISOString();

    // 1. Listen for console messages with our prefix
    this._consoleHandler = (msg) => {
      try {
        const text = typeof msg.text === "function" ? msg.text() : String(msg);
        if (text.startsWith(CONSOLE_PREFIX)) {
          const jsonStr = text.slice(CONSOLE_PREFIX.length);
          this._onBrowserEvent(jsonStr);
        }
      } catch { /* non-fatal */ }
    };

    try {
      page.on("console", this._consoleHandler);
    } catch (err) {
      logError("browser_recorder_console_listen_failed", { error: String(err) });
    }

    // 2. Inject the script for future navigations
    const script = buildInjectedScript();
    let initScriptOk = false;
    try {
      await page.addInitScript({ content: script });
      initScriptOk = true;
    } catch {
      // Some page proxies may use addInitScript with different signature
      try {
        await page.addInitScript(script);
        initScriptOk = true;
      } catch (err) {
        logError("browser_recorder_initscript_failed", { error: String(err) });
      }
    }

    // 3. Also inject into the current page immediately
    let evalOk = false;
    try {
      await page.evaluate(script);
      evalOk = true;
    } catch {
      // page may not be ready yet — script will run on next navigation via addInitScript
    }

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'browserRecorder.js:attach',message:'attach_result',data:{initScriptOk,evalOk,pageHasAddInitScript:typeof page.addInitScript==='function',pageHasEvaluate:typeof page.evaluate==='function',pageHasOn:typeof page.on==='function'},timestamp:Date.now(),hypothesisId:'BROWSER_ATTACH'})}).catch(()=>{});
    // #endregion

    logInfo("browser_recorder_attached", {
      sessionId: this.sessionId,
      initScriptOk,
      evalOk,
    });
  }

  stop() {
    this._running = false;
    this._stoppedAt = new Date().toISOString();
  }

  /** @private Handle a JSON event string from the browser. */
  _onBrowserEvent(jsonStr) {
    if (!this._running) return;
    let event;
    try {
      event = JSON.parse(jsonStr);
    } catch {
      return;
    }

    if (this._rawEvents.length < this._maxRawEvents) {
      this._rawEvents.push(event);
    }

    const type = event.eventType;
    const d = event.detail || {};
    const url = event.url || "";

    // #region agent log
    if (type === "click" || type === "fill" || type === "navigate" || type === "press" || type === "select" || type === "check") {
      fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'browserRecorder.js:_onBrowserEvent',message:'browser_event_received',data:{type,url:url?.slice(0,100),elementSelector:d.element?.selector?.slice(0,120),elementName:d.element?.name?.slice(0,60),value:d.value?.slice?.(0,50),totalRawEvents:this._rawEvents.length,totalActions:this._actions.length},timestamp:Date.now(),hypothesisId:'BROWSER_EVENTS'})}).catch(()=>{});
    }
    // #endregion

    if (type === "click") this._handleClick(d, url);
    else if (type === "fill") this._handleFill(d, url);
    else if (type === "press") this._handlePress(d, url);
    else if (type === "select") this._handleSelect(d, url);
    else if (type === "check") this._handleCheck(d, url);
    else if (type === "scroll") this._handleScroll(d, url);
    else if (type === "navigate") this._handleNavigate(d, url);
    else if (type === "submit") this._handleSubmit(d, url);
  }

  /** @private */
  _handleClick(d, url) {
    const el = d.element;
    if (!el) return;
    const sel = el.selector || "";
    const desc = el.selectorRaw || el.text || el.name || "";
    this._pushAction({
      action: "click",
      playwright: `await ${sel}.first().click();`,
      selector: sel,
      selectorMethod: el.selectorMethod || "unknown",
      target: desc,
      url,
      _element: el,
    });
  }

  /** @private */
  _handleFill(d, url) {
    const el = d.element;
    if (!el) return;
    const sel = el.selector || "";
    const value = d.value || "";
    const desc = el.selectorRaw || el.name || el.placeholder || "";
    this._pushAction({
      action: "fill",
      playwright: d.isSensitive
        ? `await ${sel}.first().fill(process.env.TEST_PASSWORD || '••••••••');`
        : `await ${sel}.first().fill('${escPw(value)}');`,
      selector: sel,
      selectorMethod: el.selectorMethod || "unknown",
      target: desc,
      value: d.isSensitive ? "••••••••" : value,
      url,
      _element: el,
    });
  }

  /** @private */
  _handlePress(d, url) {
    const key = d.key || "";
    if (!key) return;
    this._pushAction({
      action: "press",
      playwright: `await page.keyboard.press('${escPw(key)}');`,
      selector: "",
      selectorMethod: "keyboard",
      target: key,
      url,
    });
  }

  /** @private */
  _handleSelect(d, url) {
    const el = d.element;
    if (!el) return;
    const sel = el.selector || "";
    const value = d.value || "";
    const label = d.label || value;
    this._pushAction({
      action: "select",
      playwright: `await ${sel}.first().selectOption('${escPw(value)}');`,
      selector: sel,
      selectorMethod: el.selectorMethod || "unknown",
      target: el.selectorRaw || el.name || "",
      value: label,
      url,
      _element: el,
    });
  }

  /** @private */
  _handleCheck(d, url) {
    const el = d.element;
    if (!el) return;
    const sel = el.selector || "";
    const method = d.checked ? "check" : "uncheck";
    this._pushAction({
      action: method,
      playwright: `await ${sel}.first().${method}();`,
      selector: sel,
      selectorMethod: el.selectorMethod || "unknown",
      target: el.selectorRaw || el.name || "",
      url,
      _element: el,
    });
  }

  /** @private */
  _handleScroll(d, url) {
    const dx = d.deltaX || 0;
    const dy = d.deltaY || 0;
    this._pushAction({
      action: "scroll",
      playwright: `await page.mouse.wheel(${dx}, ${dy});`,
      selector: "",
      selectorMethod: "viewport",
      target: dy > 0 ? "down" : dy < 0 ? "up" : dx > 0 ? "right" : "left",
      url,
    });
  }

  /** @private */
  _handleNavigate(d, url) {
    const to = d.to || url;
    if (!to || to === "about:blank") return;
    if (to === this._lastNavigateUrl) return;
    this._lastNavigateUrl = to;
    this._pushAction({
      action: "navigate",
      playwright: `await page.goto('${escPw(to)}');`,
      selector: "",
      selectorMethod: "url",
      target: to,
      url: to,
    });
  }

  /** @private */
  _handleSubmit(d, url) {
    const lastAction = this._actions[this._actions.length - 1];
    if (lastAction) {
      const timeDiff = Date.now() - (lastAction.ts || 0);
      if (timeDiff < 500 && (lastAction.action === "click" || lastAction.action === "press")) {
        return;
      }
    }
    const el = d.element;
    this._pushAction({
      action: "submit",
      playwright: "// form submitted",
      selector: el?.selector || "",
      selectorMethod: el?.selectorMethod || "unknown",
      target: "form",
      url,
    });
  }

  /** @private */
  _pushAction(actionData) {
    if (!this._running) return;
    if (this._actions.length >= this.maxActions) return;
    this._seq++;
    this._actions.push({
      seq: this._seq,
      ts: Date.now(),
      ...actionData,
    });
  }

  getActions() {
    return [...this._actions];
  }

  getPlaywrightActions() {
    return this._actions.filter(
      (a) => a.playwright && !a.playwright.startsWith("//")
    );
  }

  toPlaywrightScript(options = {}) {
    const testName = options.testName || "recorded browser test";
    const addHeader = options.addHeader !== false;
    const actions = this.getPlaywrightActions();

    const lines = actions.map((a) => `  ${a.playwright}`);

    if (lines.length === 0) {
      lines.push("  // No browser actions were recorded.");
    }

    const header = addHeader
      ? `import { test, expect } from '@playwright/test';\n\ntest('${escPw(testName)}', async ({ page }) => {\n`
      : "";
    const footer = `\n});`;
    return header + lines.join("\n") + footer;
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      startedAt: this._startedAt,
      stoppedAt: this._stoppedAt,
      running: this._running,
      actionCount: this._actions.length,
      rawEventCount: this._rawEvents.length,
      actions: this._actions,
    };
  }

  getSummary() {
    const counts = {};
    for (const a of this._actions) {
      counts[a.action] = (counts[a.action] || 0) + 1;
    }
    return {
      totalActions: this._actions.length,
      ...counts,
    };
  }
}

function escPw(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
