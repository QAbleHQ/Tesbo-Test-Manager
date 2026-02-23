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

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

async function createSession(sessionId, startUrl) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  await ensureScreenshotDir();
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
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
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  sessions.set(sessionId, state);
  logInfo("session_created", { sessionId });
  return state;
}

async function takeScreenshot(session) {
  const fileName = `${session.id}-${Date.now()}.png`;
  const outputPath = path.join(config.screenshotDir, fileName);
  await session.page.screenshot({ path: outputPath, fullPage: true });
  session.lastScreenshotPath = outputPath;
  session.updatedAt = nowIso();
  return outputPath;
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

async function executeStep(session, commandId, step) {
  const startedAt = Date.now();
  const stepId = step.id || `step-${startedAt}`;
  pushEvent(session, {
    type: "step_started",
    commandId,
    stepId,
    action: step.action,
  });
  try {
    const timeout = Number.isFinite(step.timeoutMs) ? step.timeoutMs : 10000;
    if (step.action === "navigate") {
      await session.page.goto(step.url, { waitUntil: "domcontentloaded", timeout });
    } else if (step.action === "click") {
      await session.page.locator(step.selector).first().click({ timeout });
    } else if (step.action === "type") {
      await session.page.locator(step.selector).first().fill(step.value || "", { timeout });
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
      selectorUsed: step.selector || null,
      message: "Step executed successfully",
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
      selectorUsed: step.selector || null,
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

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
  logInfo("session_closed", { sessionId });
}

function sessionState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  return {
    id: session.id,
    currentUrl: session.currentUrl,
    lastScreenshotPath: session.lastScreenshotPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    events: session.events.slice(-100),
  };
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
  createSession,
  executeSteps,
  sessionState,
  closeSession,
  startCleanupWatchdog,
};
