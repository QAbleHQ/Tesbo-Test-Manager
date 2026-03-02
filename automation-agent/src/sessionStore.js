import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

async function ensureScreenshotDir() {
  await fs.mkdir(config.screenshotDir, { recursive: true });
}

async function ensureVideoDir() {
  if (!config.recordVideo) return;
  await fs.mkdir(config.videoDir, { recursive: true });
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

async function createSession(sessionId, startUrl) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  await ensureScreenshotDir();
  await ensureVideoDir();
  const browser = await chromium.launch({ headless: config.headless });
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
  };
  if (config.recordVideo) {
    contextOptions.recordVideo = {
      dir: config.videoDir,
      size: { width: 1366, height: 768 },
    };
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  if (startUrl) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  }
  const state = {
    id: sessionId,
    browser,
    context,
    page,
    currentUrl: page.url(),
    lastScreenshotPath: null,
    lastVideoPath: null,
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  sessions.set(sessionId, state);
  // Capture initial view so UI can render immediately after startup.
  await takeScreenshot(state).catch(() => {});
  state.currentUrl = page.url();
  logInfo("session_created", { sessionId });
  return state;
}

async function resetSession(sessionId, startUrl) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  const currentSession = session;
  try {
    await currentSession.page.close().catch(() => {});
    await currentSession.context.close().catch(() => {});
    await currentSession.browser.close().catch(() => {});
  } catch {
    // best-effort cleanup of previous browser context
  }
  const browser = await chromium.launch({ headless: config.headless });
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
  };
  if (config.recordVideo) {
    contextOptions.recordVideo = {
      dir: config.videoDir,
      size: { width: 1366, height: 768 },
    };
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  if (startUrl) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  }
  currentSession.browser = browser;
  currentSession.context = context;
  currentSession.page = page;
  currentSession.currentUrl = page.url();
  currentSession.lastScreenshotPath = null;
  currentSession.lastVideoPath = null;
  currentSession.updatedAt = nowIso();
  await takeScreenshot(currentSession).catch(() => {});
  pushEvent(currentSession, {
    type: "session_reset",
    startUrl: startUrl || "",
  });
  logInfo("session_reset", { sessionId, startUrl: startUrl || "" });
  return {
    sessionId,
    currentUrl: currentSession.currentUrl,
  };
}

async function takeScreenshot(session) {
  const fileName = `${session.id}-${Date.now()}.png`;
  const outputPath = path.join(config.screenshotDir, fileName);
  await session.page.screenshot({ path: outputPath, fullPage: true });
  session.lastScreenshotPath = outputPath;
  session.updatedAt = nowIso();
  return outputPath;
}

async function takeStandaloneScreenshot(page, id) {
  const fileName = `${id}-${Date.now()}.png`;
  const outputPath = path.join(config.screenshotDir, fileName);
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}

function createExpect(page, recordStep) {
  return function expect(actual) {
    const meta = actual && typeof actual === "object" ? actual.__meta || {} : {};
    return {
      async toBeVisible() {
        await recordStep("assert_visible", { selector: meta.selector || null }, async () => {
          await actual.waitFor({ state: "visible", timeout: 15000 });
        });
      },
      async toContainText(expectedText) {
        await recordStep(
          "assert_text",
          { selector: meta.selector || null, expectedText: String(expectedText || "") },
          async () => {
            const actualText = await actual.innerText({ timeout: 15000 });
            if (!String(actualText || "").toLowerCase().includes(String(expectedText || "").toLowerCase())) {
              throw new Error(`Expected text to contain "${expectedText}", but got "${actualText}"`);
            }
          }
        );
      },
      async toBeEnabled() {
        await recordStep("assert_clickable", { selector: meta.selector || null }, async () => {
          const enabled = await actual.isEnabled({ timeout: 15000 });
          if (!enabled) throw new Error("Expected element to be enabled");
        });
      },
      async toHaveURL(expected) {
        await recordStep("assert_url", { expected: String(expected) }, async () => {
          const current = page.url();
          if (expected instanceof RegExp) {
            if (!expected.test(current)) {
              throw new Error(`Expected URL ${expected}, got ${current}`);
            }
            return;
          }
          const expectedString = String(expected || "");
          if (current !== expectedString) {
            throw new Error(`Expected URL "${expectedString}", got "${current}"`);
          }
        });
      },
    };
  };
}

function createLocatorWrapper(locator, selector, recordStep) {
  const wrapped = {
    __meta: { selector },
    first() {
      return createLocatorWrapper(locator.first(), selector, recordStep);
    },
    async click(options) {
      return recordStep("click", { selector }, async () => locator.click(options));
    },
    async fill(value, options) {
      return recordStep("type", { selector, value }, async () => locator.fill(value, options));
    },
    waitFor(options) {
      return locator.waitFor(options);
    },
    innerText(options) {
      return locator.innerText(options);
    },
    isEnabled(options) {
      return locator.isEnabled(options);
    },
  };
  return wrapped;
}

function createInstrumentedPage(page, recordStep) {
  const keyboard = {
    async press(key, options) {
      return recordStep("press", { key: String(key || "") }, async () => page.keyboard.press(key, options));
    },
    async type(text, options) {
      return recordStep("type", { selector: "activeElement", value: String(text || "") }, async () =>
        page.keyboard.type(text, options)
      );
    },
  };
  const mouse = {
    async click(x, y, options) {
      return recordStep("mouse_click", { x, y }, async () => page.mouse.click(x, y, options));
    },
    async move(x, y, options) {
      return recordStep("mouse_move", { x, y }, async () => page.mouse.move(x, y, options));
    },
    async down(options) {
      return recordStep("mouse_down", {}, async () => page.mouse.down(options));
    },
    async up(options) {
      return recordStep("mouse_up", {}, async () => page.mouse.up(options));
    },
    async wheel(deltaX, deltaY) {
      return recordStep("scroll", { deltaX, deltaY }, async () => page.mouse.wheel(deltaX, deltaY));
    },
  };
  return new Proxy(page, {
    get(target, prop) {
      if (prop === "goto") {
        return async (url, options) =>
          recordStep("navigate", { url: String(url || "") }, async () => target.goto(url, options));
      }
      if (prop === "locator") {
        return (selector) => createLocatorWrapper(target.locator(selector), String(selector || ""), recordStep);
      }
      if (prop === "getByText") {
        return (text, options) =>
          createLocatorWrapper(target.getByText(text, options), `text=${String(text || "")}`, recordStep);
      }
      if (prop === "keyboard") return keyboard;
      if (prop === "mouse") return mouse;
      const value = target[prop];
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

function extractPlaywrightTestBody(script) {
  const source = String(script || "");
  const asyncTestIdx = source.search(/test\s*\([\s\S]*?async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{/m);
  if (asyncTestIdx < 0) {
    throw new Error("Unsupported script format: expected Playwright test(async ({ page }) => { ... })");
  }
  // Find the opening brace of the async function body, not the "{ page }" parameter brace.
  const arrowIdx = source.indexOf("=>", asyncTestIdx);
  if (arrowIdx < 0) throw new Error("Invalid script format: missing async test arrow");
  const braceStart = source.indexOf("{", arrowIdx);
  if (braceStart < 0) throw new Error("Invalid script format: missing test body");
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`") inTemplate = !inTemplate;
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart + 1, i);
      }
    }
  }
  throw new Error("Invalid script format: unterminated test body");
}

async function runPlaywrightScript(executionId, script, startUrl = null) {
  await ensureScreenshotDir();
  await ensureVideoDir();
  const startedAt = Date.now();
  const logs = [];
  const browser = await chromium.launch({ headless: config.headless });
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
  };
  if (config.recordVideo) {
    contextOptions.recordVideo = {
      dir: config.videoDir,
      size: { width: 1366, height: 768 },
    };
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on("console", (msg) => {
    logs.push({
      level: msg.type(),
      message: msg.text(),
      ts: new Date().toISOString(),
    });
  });
  page.on("pageerror", (err) => {
    logs.push({
      level: "pageerror",
      message: err?.message || "Unknown page error",
      ts: new Date().toISOString(),
    });
  });
  page.on("requestfailed", (req) => {
    logs.push({
      level: "requestfailed",
      message: `${req.method()} ${req.url()} => ${req.failure()?.errorText || "failed"}`,
      ts: new Date().toISOString(),
    });
  });

  const video = page.video();
  let status = "passed";
  let errorMessage = null;
  let screenshotPath = null;
  let videoPath = null;
  let currentUrl = "";
  let stepCounter = 0;
  const recordStep = async (action, detail, fn) => {
    const started = Date.now();
    const stepId = `step-${++stepCounter}`;
    try {
      const result = await fn();
      const stepScreenshotPath = await takeStandaloneScreenshot(page, `${executionId}-${stepId}`).catch(() => null);
      logs.push({
        kind: "step",
        stepId,
        action,
        status: "passed",
        detail: detail || {},
        screenshotPath: stepScreenshotPath,
        durationMs: Date.now() - started,
        ts: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const stepScreenshotPath = await takeStandaloneScreenshot(page, `${executionId}-${stepId}`).catch(() => null);
      const message = err instanceof Error ? err.message : String(err);
      logs.push({
        kind: "step",
        stepId,
        action,
        status: "failed",
        detail: detail || {},
        message,
        screenshotPath: stepScreenshotPath,
        durationMs: Date.now() - started,
        ts: new Date().toISOString(),
      });
      throw err;
    }
  };
  try {
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    }
    const body = extractPlaywrightTestBody(script);
    const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
    const fn = new AsyncFunction("page", "expect", body);
    const instrumentedPage = createInstrumentedPage(page, recordStep);
    const expect = createExpect(page, recordStep);
    await fn(instrumentedPage, expect);
    currentUrl = page.url();
    screenshotPath = await takeStandaloneScreenshot(page, executionId);
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    currentUrl = page.url();
    screenshotPath = await takeStandaloneScreenshot(page, executionId).catch(() => null);
    logs.push({
      level: "error",
      message: errorMessage,
      ts: new Date().toISOString(),
    });
  } finally {
    await page.close().catch(() => {});
    if (video) {
      videoPath = await video.path().catch(() => null);
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    status,
    currentUrl,
    logs,
    screenshotPath,
    videoPath,
    errorMessage,
    durationMs: Date.now() - startedAt,
  };
}

async function runPlaywrightScriptInSession(sessionId, executionId, script, startUrl = null) {
  await ensureScreenshotDir();
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  const startedAt = Date.now();
  const logs = [];
  let status = "passed";
  let errorMessage = null;
  let screenshotPath = null;
  let currentUrl = session.currentUrl || "";
  let stepCounter = 0;
  const recordStep = async (action, detail, fn) => {
    const stepStartedAt = Date.now();
    const stepId = `step-${++stepCounter}`;
    try {
      const result = await fn();
      const stepScreenshotPath = await takeScreenshot(session).catch(() => null);
      logs.push({
        kind: "step",
        stepId,
        action,
        status: "passed",
        detail: detail || {},
        screenshotPath: stepScreenshotPath,
        durationMs: Date.now() - stepStartedAt,
        ts: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const stepScreenshotPath = await takeScreenshot(session).catch(() => null);
      const message = err instanceof Error ? err.message : String(err);
      logs.push({
        kind: "step",
        stepId,
        action,
        status: "failed",
        detail: detail || {},
        message,
        screenshotPath: stepScreenshotPath,
        durationMs: Date.now() - stepStartedAt,
        ts: new Date().toISOString(),
      });
      throw err;
    }
  };

  try {
    if (startUrl) {
      await session.page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    }
    const body = extractPlaywrightTestBody(script);
    const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
    const fn = new AsyncFunction("page", "expect", body);
    const instrumentedPage = createInstrumentedPage(session.page, recordStep);
    const expect = createExpect(session.page, recordStep);
    await fn(instrumentedPage, expect);
    currentUrl = session.page.url();
    session.currentUrl = currentUrl;
    screenshotPath = await takeScreenshot(session);
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    currentUrl = session.page.url();
    session.currentUrl = currentUrl;
    screenshotPath = await takeScreenshot(session).catch(() => null);
    logs.push({
      level: "error",
      message: errorMessage,
      ts: new Date().toISOString(),
    });
  }

  pushEvent(session, {
    type: "playwright_script_finished",
    executionId,
    status,
    currentUrl,
    screenshotPath,
    durationMs: Date.now() - startedAt,
  });

  return {
    status,
    currentUrl,
    logs,
    screenshotPath,
    errorMessage,
    durationMs: Date.now() - startedAt,
  };
}

function pushEvent(session, event) {
  session.events.push({
    ...event,
    createdAt: nowIso(),
  });
  if (session.events.length > 2000) {
    session.events.splice(0, session.events.length - 2000);
  }
  session.updatedAt = nowIso();
}

async function selectorAtPoint(page, x, y) {
  return page.evaluate(({ px, py }) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return null;
    const target =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el && typeof el === "object" && "isContentEditable" in el && !!el.isContentEditable)
        ? el
        : el.closest?.("button, a, input, textarea, select, [contenteditable='true'], [role='button'], [aria-label], [data-testid], [name], [id], [class]");
    const node = target || el;
    if (!(node instanceof Element)) return null;
    if (node.id) return `#${node.id}`;
    const dataTestId = node.getAttribute("data-testid");
    if (dataTestId) return `[data-testid='${dataTestId}']`;
    const name = node.getAttribute("name");
    if (name) return `${node.tagName.toLowerCase()}[name='${name}']`;
    const ariaLabel = node.getAttribute("aria-label");
    if (ariaLabel) return `${node.tagName.toLowerCase()}[aria-label='${ariaLabel}']`;
    const role = node.getAttribute("role");
    if (role) return `${node.tagName.toLowerCase()}[role='${role}']`;
    const cls = Array.from(node.classList).slice(0, 2).join(".");
    if (cls) return `${node.tagName.toLowerCase()}.${cls}`;
    return node.tagName.toLowerCase();
  }, { px: x, py: y });
}

async function elementInfoAtPoint(page, x, y) {
  return page.evaluate(({ px, py }) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return { selector: null, text: null, html: null };
    const target =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el && typeof el === "object" && "isContentEditable" in el && !!el.isContentEditable)
        ? el
        : el.closest?.("button, a, input, textarea, select, [contenteditable='true'], [role='button'], [aria-label], [data-testid], [name], [id], [class]");
    const node = target || el;
    if (!(node instanceof Element)) return { selector: null, text: null, html: null };
    let selector = null;
    if (node.id) selector = `#${node.id}`;
    else {
      const dataTestId = node.getAttribute("data-testid");
      if (dataTestId) selector = `[data-testid='${dataTestId}']`;
      else {
        const name = node.getAttribute("name");
        if (name) selector = `${node.tagName.toLowerCase()}[name='${name}']`;
        else {
          const ariaLabel = node.getAttribute("aria-label");
          if (ariaLabel) selector = `${node.tagName.toLowerCase()}[aria-label='${ariaLabel}']`;
          else {
            const role = node.getAttribute("role");
            if (role) selector = `${node.tagName.toLowerCase()}[role='${role}']`;
            else {
              const cls = Array.from(node.classList).slice(0, 2).join(".");
              selector = cls ? `${node.tagName.toLowerCase()}.${cls}` : node.tagName.toLowerCase();
            }
          }
        }
      }
    }
    const text = (node.textContent || "").trim().slice(0, 140) || null;
    const html = (node.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 260) || null;
    return { selector, text, html };
  }, { px: x, py: y });
}

async function activeElementSelector(page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof Element)) return null;
    if (node.id) return `#${node.id}`;
    const dataTestId = node.getAttribute("data-testid");
    if (dataTestId) return `[data-testid='${dataTestId}']`;
    const name = node.getAttribute("name");
    if (name) return `${node.tagName.toLowerCase()}[name='${name}']`;
    const ariaLabel = node.getAttribute("aria-label");
    if (ariaLabel) return `${node.tagName.toLowerCase()}[aria-label='${ariaLabel}']`;
    const cls = Array.from(node.classList).slice(0, 2).join(".");
    if (cls) return `${node.tagName.toLowerCase()}.${cls}`;
    return node.tagName.toLowerCase();
  });
}

async function activeElementInfo(page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof Element)) return { selector: null, text: null, html: null };
    let selector = null;
    if (node.id) selector = `#${node.id}`;
    else {
      const dataTestId = node.getAttribute("data-testid");
      if (dataTestId) selector = `[data-testid='${dataTestId}']`;
      else {
        const name = node.getAttribute("name");
        if (name) selector = `${node.tagName.toLowerCase()}[name='${name}']`;
        else {
          const ariaLabel = node.getAttribute("aria-label");
          if (ariaLabel) selector = `${node.tagName.toLowerCase()}[aria-label='${ariaLabel}']`;
          else {
            const cls = Array.from(node.classList).slice(0, 2).join(".");
            selector = cls ? `${node.tagName.toLowerCase()}.${cls}` : node.tagName.toLowerCase();
          }
        }
      }
    }
    const text = (node.textContent || "").trim().slice(0, 140) || null;
    const html = (node.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 260) || null;
    return { selector, text, html };
  });
}

function escapeForRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTargetText(value) {
  return String(value || "").replace(/^text=/i, "").trim();
}

function looksLikeSelector(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  return (
    v.startsWith("#") ||
    v.startsWith(".") ||
    v.startsWith("[") ||
    v.startsWith("//") ||
    v.includes(">>") ||
    /^[a-zA-Z][a-zA-Z0-9:_-]*(\[.+\])?$/.test(v)
  );
}

function buildLocatorCandidates(page, rawTarget, actionType = "click") {
  const raw = String(rawTarget || "").trim();
  if (!raw) return [];
  const textTarget = normalizeTargetText(raw);
  const regex = new RegExp(escapeForRegex(textTarget), "i");
  const candidates = [];

  if (raw.startsWith("//")) {
    candidates.push({ label: `xpath:${raw}`, locator: page.locator(`xpath=${raw}`).first() });
  }
  if (raw.toLowerCase().startsWith("text=")) {
    candidates.push({ label: `text:${textTarget}`, locator: page.getByText(textTarget, { exact: false }).first() });
  }
  if (looksLikeSelector(raw)) {
    candidates.push({ label: `selector:${raw}`, locator: page.locator(raw).first() });
  }

  // Natural-language candidates for unknown layouts/frameworks.
  candidates.push({ label: `label:${textTarget}`, locator: page.getByLabel(regex).first() });
  candidates.push({ label: `placeholder:${textTarget}`, locator: page.getByPlaceholder(regex).first() });
  candidates.push({ label: `testid:${textTarget}`, locator: page.getByTestId(regex).first() });
  if (actionType === "type") {
    candidates.push({ label: `role:textbox:${textTarget}`, locator: page.getByRole("textbox", { name: regex }).first() });
    candidates.push({ label: `role:combobox:${textTarget}`, locator: page.getByRole("combobox", { name: regex }).first() });
    candidates.push({ label: `name:${textTarget}`, locator: page.locator(`input[name*="${textTarget}" i], textarea[name*="${textTarget}" i], select[name*="${textTarget}" i]`).first() });
  } else {
    candidates.push({ label: `role:button:${textTarget}`, locator: page.getByRole("button", { name: regex }).first() });
    candidates.push({ label: `role:link:${textTarget}`, locator: page.getByRole("link", { name: regex }).first() });
  }
  candidates.push({ label: `text:${textTarget}`, locator: page.getByText(regex).first() });

  return candidates;
}

async function resolveUsableLocator(page, candidates, timeout = 3000) {
  for (const candidate of candidates) {
    try {
      const count = await candidate.locator.count();
      if (!count || count < 1) continue;
      await candidate.locator.first().waitFor({ state: "attached", timeout });
      return { label: candidate.label, locator: candidate.locator.first() };
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function readTargetValue(page, targetSelector) {
  const selector = String(targetSelector || "").trim();
  if (!selector) return null;
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value ?? "";
      if (el instanceof HTMLSelectElement) return el.value ?? "";
      if ("isContentEditable" in el && el.isContentEditable) return el.textContent ?? "";
      return null;
    }, selector)
    .catch(() => null);
}

async function locatorHighlightBox(locator, page, label = null) {
  try {
    const box = await locator.boundingBox();
    if (!box) return null;
    const viewport = page.viewportSize() || { width: 1366, height: 768 };
    if (!viewport.width || !viewport.height) return null;
    const clamp = (value) => Math.max(0, Math.min(1, value));
    return {
      xRatio: clamp(box.x / viewport.width),
      yRatio: clamp(box.y / viewport.height),
      widthRatio: clamp(box.width / viewport.width),
      heightRatio: clamp(box.height / viewport.height),
      label: label || undefined,
    };
  } catch {
    return null;
  }
}

async function executeStep(session, commandId, step) {
  const startedAt = Date.now();
  const stepId = step.id || `step-${startedAt}`;
  let selectorUsed = step.selector || step.targetDescription || null;
  let successMessage = "Step executed successfully";
  let highlight = null;
  pushEvent(session, {
    type: "step_started",
    commandId,
    stepId,
    action: step.action,
  });
  try {
    const timeout = Number.isFinite(step.timeoutMs) ? step.timeoutMs : 10000;
    const snapshotState = async () =>
      session.page.evaluate(() => {
        const body = document.body;
        const text = (body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500);
        const active = document.activeElement;
        let activeDescriptor = "";
        if (active instanceof Element) {
          const id = active.getAttribute("id");
          const name = active.getAttribute("name");
          const role = active.getAttribute("role");
          activeDescriptor = [active.tagName.toLowerCase(), id ? `#${id}` : "", name ? `[name='${name}']` : "", role ? `[role='${role}']` : ""]
            .filter(Boolean)
            .join("");
        }
        return {
          url: window.location.href,
          title: document.title || "",
          text,
          activeDescriptor,
        };
      });

    const hasImpact = (before, after) => {
      if (!before || !after) return true;
      return (
        before.url !== after.url ||
        before.title !== after.title ||
        before.text !== after.text ||
        before.activeDescriptor !== after.activeDescriptor
      );
    };

    if (step.action === "navigate") {
      await session.page.goto(step.url, { waitUntil: "domcontentloaded", timeout });
    } else if (step.action === "click") {
      const target = step.selector || step.targetDescription || step.expectedText || "";
      const resolved = await resolveUsableLocator(session.page, buildLocatorCandidates(session.page, target, "click"), timeout);
      if (!resolved) {
        throw new Error(`Unable to locate clickable target: ${target}`);
      }
      selectorUsed = resolved.label;
      highlight = await locatorHighlightBox(resolved.locator, session.page, target || resolved.label);
      const before = await snapshotState().catch(() => null);
      await resolved.locator.click({ timeout }).catch(async () => {
        await resolved.locator.scrollIntoViewIfNeeded().catch(() => {});
        await resolved.locator.click({ timeout });
      });
      await session.page.waitForTimeout(180).catch(() => {});
      let after = await snapshotState().catch(() => null);
      if (!hasImpact(before, after)) {
        await resolved.locator.click({ timeout, force: true });
        await session.page.waitForTimeout(220).catch(() => {});
        after = await snapshotState().catch(() => null);
      }
      if (!hasImpact(before, after)) {
        await resolved.locator.evaluate((node) => {
          if (node instanceof HTMLElement) {
            node.focus();
            node.click();
            node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
        });
        await session.page.waitForTimeout(260).catch(() => {});
        after = await snapshotState().catch(() => null);
      }
      if (!hasImpact(before, after)) {
        successMessage = `Click executed on "${target}" but no clear page delta was observed`;
      }
    } else if (step.action === "type") {
      const value = step.value || "";
      const target = step.selector || step.targetDescription || step.expectedText || "";
      const resolved = await resolveUsableLocator(session.page, buildLocatorCandidates(session.page, target, "type"), timeout);
      if (!resolved) {
        throw new Error(`Unable to locate input target: ${target}`);
      }
      selectorUsed = resolved.label;
      highlight = await locatorHighlightBox(resolved.locator, session.page, target || resolved.label);
      const beforeValue = await readTargetValue(session.page, step.selector);
      let typed = false;
      let afterValue = null;
      const tagName = await resolved.locator
        .evaluate((node) => (node instanceof Element ? node.tagName.toLowerCase() : ""))
        .catch(() => "");
      if (tagName === "select") {
        await resolved.locator.selectOption({ label: value }).catch(async () => {
          await resolved.locator.selectOption({ value }).catch(() => {});
        });
      } else {
        await resolved.locator.fill(value, { timeout }).catch(() => {});
      }
      afterValue = await resolved.locator.inputValue().catch(() => null);
      if (afterValue != null && String(afterValue).toLowerCase().includes(String(value).toLowerCase())) {
        typed = true;
      }
      if (!typed) {
        await resolved.locator.click({ timeout }).catch(() => {});
        await session.page.keyboard.type(value).catch(() => {});
        afterValue = await resolved.locator.inputValue().catch(() => null);
        if (afterValue != null && String(afterValue).toLowerCase().includes(String(value).toLowerCase())) {
          typed = true;
        }
      }
      if (!typed) {
        await resolved.locator.evaluate((node, text) => {
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
            node.focus();
            node.value = text;
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
          if (node instanceof HTMLSelectElement) {
            const options = Array.from(node.options || []);
            const pick = options.find((opt) => opt.label === text || opt.value === text);
            if (pick) {
              node.value = pick.value;
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return;
          }
          if (node && typeof node === "object" && "isContentEditable" in node && node.isContentEditable) {
            node.textContent = text;
            node.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, value);
        afterValue = await resolved.locator.inputValue().catch(() => null);
        if (afterValue != null && String(afterValue).toLowerCase().includes(String(value).toLowerCase())) {
          typed = true;
        }
      }
      if (!typed) {
        throw new Error(
          `Type action did not update target field after fallback attempts for target: ${target} (before=${beforeValue}, after=${afterValue})`
        );
      }
    } else if (step.action === "assert_visible") {
      const selector = step.selector || (step.targetDescription ? `text=${step.targetDescription}` : null) || (step.expectedText ? `text=${step.expectedText}` : null);
      if (!selector) throw new Error("assert_visible requires selector or expectedText");
      const locator = session.page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      highlight = await locatorHighlightBox(locator, session.page, step.targetDescription || step.expectedText || selector);
    } else if (step.action === "assert_text") {
      const expected = (step.expectedText || "").trim();
      if (!expected) throw new Error("assert_text requires expectedText");
      if (step.selector) {
        const locator = session.page.locator(step.selector).first();
        highlight = await locatorHighlightBox(locator, session.page, step.selector);
        const text = await locator.innerText({ timeout });
        if (!text.toLowerCase().includes(expected.toLowerCase())) {
          throw new Error(`Text mismatch. Expected contains "${expected}", got "${text}"`);
        }
      } else {
        const body = await session.page.locator("body").innerText({ timeout });
        if (!body.toLowerCase().includes(expected.toLowerCase())) {
          throw new Error(`Text "${expected}" not found on page`);
        }
      }
    } else if (step.action === "assert_clickable") {
      const target = step.selector || step.targetDescription || step.expectedText || "";
      const resolved = await resolveUsableLocator(session.page, buildLocatorCandidates(session.page, target, "click"), timeout);
      if (!resolved) throw new Error("assert_clickable requires selector, targetDescription, or expectedText");
      selectorUsed = resolved.label;
      const locator = resolved.locator;
      await locator.waitFor({ state: "visible", timeout });
      const enabled = await locator.isEnabled({ timeout });
      highlight = await locatorHighlightBox(locator, session.page, target || resolved.label);
      if (!enabled) throw new Error(`Element is not clickable: ${target}`);
    } else {
      throw new Error(`Unsupported action: ${step.action}`);
    }
    const screenshotPath = await takeScreenshot(session);
    session.currentUrl = session.page.url();
    const result = {
      commandId,
      stepId,
      action: step.action,
      status: "passed",
      currentUrl: session.currentUrl,
      selectorUsed,
      highlight,
      message: successMessage,
      screenshotPath,
      durationMs: Date.now() - startedAt,
    };
    pushEvent(session, { type: "step_finished", ...result });
    return result;
  } catch (error) {
    const screenshotPath = await takeScreenshot(session).catch(() => null);
    session.currentUrl = session.page.url();
    const result = {
      commandId,
      stepId,
      action: step.action,
      status: "failed",
      currentUrl: session.currentUrl,
      selectorUsed,
      highlight,
      message: error instanceof Error ? error.message : "Step failed",
      screenshotPath,
      durationMs: Date.now() - startedAt,
    };
    pushEvent(session, { type: "step_failed", ...result });
    return result;
  }
}

async function executeSteps(sessionId, commandId, steps) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  const results = [];
  for (const step of steps) {
    const result = await executeStep(session, commandId, step);
    results.push(result);
    if (result.status !== "passed") break;
  }
  return {
    sessionId,
    commandId,
    currentUrl: session.currentUrl,
    results,
  };
}

async function manualAction(sessionId, action) {
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");
  const startedAt = Date.now();
  const viewport = session.page.viewportSize() || { width: 1366, height: 768 };
  let targetSelector = null;
  let targetText = null;
  let targetHtml = null;
  let startSelector = null;
  let endSelector = null;
  try {
    if (action.actionType === "click") {
      const xRatio = typeof action.xRatio === "number" ? action.xRatio : 0.5;
      const yRatio = typeof action.yRatio === "number" ? action.yRatio : 0.5;
      const x = Math.max(1, Math.min(viewport.width - 1, Math.round(xRatio * viewport.width)));
      const y = Math.max(1, Math.min(viewport.height - 1, Math.round(yRatio * viewport.height)));
      const info = await elementInfoAtPoint(session.page, x, y).catch(() => null);
      targetSelector = info?.selector ?? null;
      targetText = info?.text ?? null;
      targetHtml = info?.html ?? null;
      await session.page.mouse.click(x, y);
      pushEvent(session, {
        type: "manual_step_finished",
        action: "click",
        selector: targetSelector,
        coordinates: { x, y, xRatio, yRatio },
      });
    } else if (action.actionType === "drag") {
      const xRatio = typeof action.xRatio === "number" ? action.xRatio : 0.5;
      const yRatio = typeof action.yRatio === "number" ? action.yRatio : 0.5;
      const toXRatio = typeof action.toXRatio === "number" ? action.toXRatio : xRatio;
      const toYRatio = typeof action.toYRatio === "number" ? action.toYRatio : yRatio;
      const x = Math.max(1, Math.min(viewport.width - 1, Math.round(xRatio * viewport.width)));
      const y = Math.max(1, Math.min(viewport.height - 1, Math.round(yRatio * viewport.height)));
      const toX = Math.max(1, Math.min(viewport.width - 1, Math.round(toXRatio * viewport.width)));
      const toY = Math.max(1, Math.min(viewport.height - 1, Math.round(toYRatio * viewport.height)));
      startSelector = await selectorAtPoint(session.page, x, y).catch(() => null);
      endSelector = await selectorAtPoint(session.page, toX, toY).catch(() => null);
      await session.page.mouse.move(x, y);
      await session.page.mouse.down();
      await session.page.mouse.move(toX, toY, { steps: 12 });
      await session.page.mouse.up();
      pushEvent(session, {
        type: "manual_step_finished",
        action: "drag",
        startSelector,
        endSelector,
        coordinates: { x, y, toX, toY, xRatio, yRatio, toXRatio, toYRatio },
      });
    } else if (action.actionType === "scroll") {
      const deltaX = typeof action.deltaX === "number" ? action.deltaX : 0;
      const deltaY = typeof action.deltaY === "number" ? action.deltaY : 0;
      await session.page.mouse.wheel(deltaX, deltaY);
      pushEvent(session, {
        type: "manual_step_finished",
        action: "scroll",
        deltaX,
        deltaY,
      });
    } else if (action.actionType === "type") {
      const text = action.text || "";
      if (typeof action.xRatio === "number" && typeof action.yRatio === "number") {
        const x = Math.max(1, Math.min(viewport.width - 1, Math.round(action.xRatio * viewport.width)));
        const y = Math.max(1, Math.min(viewport.height - 1, Math.round(action.yRatio * viewport.height)));
        const info = await elementInfoAtPoint(session.page, x, y).catch(() => null);
        targetSelector = info?.selector ?? null;
        targetText = info?.text ?? null;
        targetHtml = info?.html ?? null;
        await session.page.mouse.click(x, y);
        await session.page.evaluate(({ px, py }) => {
          const el = document.elementFromPoint(px, py);
          const editable =
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            (el && typeof el === "object" && "isContentEditable" in el && !!el.isContentEditable)
              ? el
              : el?.closest?.("input,textarea,[contenteditable='true']");
          if (editable && "focus" in editable) {
            editable.focus();
          }
        }, { px: x, py: y });
      }
      const activeIsEditable = await session.page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
        return typeof el === "object" && "isContentEditable" in el ? !!el.isContentEditable : false;
      });
      if (!activeIsEditable) {
        const fallback = session.page.locator("input, textarea, [contenteditable='true']").first();
        if ((await fallback.count()) > 0) {
          await fallback.click({ timeout: 2000 }).catch(() => {});
        }
      }
      if (!targetSelector) {
        const info = await activeElementInfo(session.page).catch(() => null);
        targetSelector = info?.selector ?? null;
        targetText = info?.text ?? null;
        targetHtml = info?.html ?? null;
      }
      let typed = false;
      try {
        await session.page.keyboard.type(text);
        typed = true;
      } catch {
        typed = false;
      }
      if (!typed) {
        await session.page.evaluate((value) => {
          const el = document.activeElement;
          if (!el) return;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const prev = el.value ?? "";
            el.value = `${prev}${value}`;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
          if (typeof el === "object" && "isContentEditable" in el && !!el.isContentEditable) {
            el.textContent = `${el.textContent ?? ""}${value}`;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, text);
      }
      pushEvent(session, {
        type: "manual_step_finished",
        action: "type",
        selector: targetSelector,
        value: text,
      });
    } else if (action.actionType === "press") {
      const key = action.key || "Enter";
      if (typeof action.xRatio === "number" && typeof action.yRatio === "number") {
        const x = Math.max(1, Math.min(viewport.width - 1, Math.round(action.xRatio * viewport.width)));
        const y = Math.max(1, Math.min(viewport.height - 1, Math.round(action.yRatio * viewport.height)));
        const info = await elementInfoAtPoint(session.page, x, y).catch(() => null);
        targetSelector = info?.selector ?? null;
        targetText = info?.text ?? null;
        targetHtml = info?.html ?? null;
        await session.page.mouse.click(x, y);
      }
      if (!targetSelector) {
        const info = await activeElementInfo(session.page).catch(() => null);
        targetSelector = info?.selector ?? null;
        targetText = info?.text ?? null;
        targetHtml = info?.html ?? null;
      }
      await session.page.keyboard.press(key);
      pushEvent(session, {
        type: "manual_step_finished",
        action: "press",
        selector: targetSelector,
        key,
      });
    } else {
      throw new Error(`Unsupported manual action: ${action.actionType}`);
    }
    const screenshotPath = await takeScreenshot(session);
    session.currentUrl = session.page.url();
    return {
      status: "passed",
      actionType: action.actionType,
      selector: targetSelector,
      targetText,
      targetHtml,
      startSelector,
      endSelector,
      currentUrl: session.currentUrl,
      screenshotPath,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const screenshotPath = await takeScreenshot(session).catch(() => null);
    return {
      status: "failed",
      actionType: action.actionType,
      currentUrl: session.page.url(),
      screenshotPath,
      message: error instanceof Error ? error.message : "Manual action failed",
      durationMs: Date.now() - startedAt,
    };
  }
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { videoPath: null };
  sessions.delete(sessionId);
  let videoPath = null;
  try {
    const video = session.page.video();
    await session.page.close().catch(() => {});
    if (video) {
      videoPath = await video.path().catch(() => null);
    }
  } catch {
    // no-op
  }
  session.lastVideoPath = videoPath;
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
  logInfo("session_closed", { sessionId });
  return { videoPath };
}

function sessionState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  const pageTitlePromise = session.page.title().catch(() => "");
  const pageTextPromise = session.page
    .locator("body")
    .innerText()
    .then((v) => (v || "").slice(0, 4000))
    .catch(() => "");
  return Promise.all([pageTitlePromise, pageTextPromise]).then(([pageTitle, pageText]) => ({
    id: session.id,
    currentUrl: session.currentUrl,
    pageTitle,
    pageText,
    lastScreenshotPath: session.lastScreenshotPath,
    lastVideoPath: session.lastVideoPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    events: session.events.slice(-100),
  }));
}

function startCleanupWatchdog() {
  setInterval(async () => {
    const cutoff = Date.now() - config.sessionTtlMs;
    for (const [sessionId, session] of sessions.entries()) {
      const updatedAtMs = new Date(session.updatedAt).getTime();
      if (updatedAtMs < cutoff) {
        logInfo("session_expired", { sessionId });
        await closeSession(sessionId).catch((err) => {
          logError("session_close_failed", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }, 30000);
}

export {
  getSession,
  createSession,
  resetSession,
  executeSteps,
  manualAction,
  runPlaywrightScript,
  runPlaywrightScriptInSession,
  sessionState,
  closeSession,
  startCleanupWatchdog,
};
