/**
 * Stagehand session management for AI-powered autonomous automation.
 * Supports:
 * - LOCAL mode (no Browserbase required; uses local browser)
 * - BROWSERBASE mode (when Browserbase credentials are provided)
 */
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";

let Stagehand;
try {
  Stagehand = (await import("@browserbasehq/stagehand")).Stagehand;
} catch {
  Stagehand = null;
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureScreenshotDir() {
  await fs.mkdir(config.screenshotDir, { recursive: true });
}

async function takeScreenshot(page, sessionId) {
  const fileName = `${sessionId}-${Date.now()}.png`;
  const outputPath = path.join(config.screenshotDir, fileName);
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}

/**
 * Create a Stagehand session.
 * @param {string} sessionId - TesboX session ID
 * @param {string|null} startUrl - Initial URL to navigate to
 * @param {object} credentials - Optional Browserbase credentials { apiKey, projectId }
 * @param {object} modelConfig - { provider, apiKey, model } for LLM (OpenAI/Anthropic)
 * @param {object} runtimeConfig - Optional runtime config { cacheScope }
 * @returns {Promise<object>} Session state with stagehand, page, etc.
 */
export async function createStagehandSession(sessionId, startUrl, credentials, modelConfig, runtimeConfig = {}) {
  if (!Stagehand) {
    throw new Error("Stagehand is not installed. Run: npm install @browserbasehq/stagehand");
  }
  const { apiKey: browserbaseApiKey, projectId: browserbaseProjectId } = credentials || {};

  await ensureScreenshotDir();

  const provider = (modelConfig?.provider || "openai").toLowerCase();
  const modelApiKey = modelConfig?.apiKey || "";
  const modelName = modelConfig?.model || (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o");

  if (!modelApiKey) {
    throw new Error("LLM API key is required for Stagehand. Set project AI settings (OpenAI or Anthropic API key).");
  }

  // Stagehand v3 expects model config under `model: { modelName, apiKey }`
  // (not top-level modelName/modelClientOptions).
  const resolvedModelName = String(modelName || "").includes("/")
    ? String(modelName)
    : `${provider === "anthropic" ? "anthropic" : "openai"}/${modelName}`;
  const cacheScope = String(runtimeConfig?.cacheScope || sessionId).replace(/[^a-zA-Z0-9._-]/g, "_");
  const cacheDir = path.join(config.stagehandCacheDir, cacheScope);
  await fs.mkdir(cacheDir, { recursive: true });
  const useBrowserbase = Boolean(browserbaseApiKey && browserbaseProjectId);
  const stagehandConfig = {
    env: useBrowserbase ? "BROWSERBASE" : "LOCAL",
    cacheDir,
    model: {
      modelName: resolvedModelName,
      apiKey: modelApiKey,
    },
  };
  if (useBrowserbase) {
    stagehandConfig.apiKey = browserbaseApiKey;
    stagehandConfig.projectId = browserbaseProjectId;
  }

  const stagehand = new Stagehand(stagehandConfig);
  await stagehand.init();

  const page = stagehand.context.pages()[0];
  if (!page) {
    await stagehand.close?.().catch(() => {});
    throw new Error("Stagehand did not create a page");
  }

  if (startUrl && startUrl.trim()) {
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (err) {
      logError("stagehand_start_url_failed", { sessionId, startUrl, error: String(err) });
      try {
        await page.goto(startUrl, { waitUntil: "load", timeout: 60000 });
      } catch {
        // Continue with whatever page we have
      }
    }
  }

  const state = {
    id: sessionId,
    type: "stagehand",
    stagehand,
    page,
    currentUrl: page.url(),
    lastScreenshotPath: null,
    lastVideoPath: null,
    lastTracePath: null,
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cacheScope,
    cacheDir,
    mode: useBrowserbase ? "browserbase" : "local",
  };

  try {
    state.lastScreenshotPath = await takeScreenshot(page, sessionId);
  } catch {
    // Non-fatal
  }

  logInfo("stagehand_session_created", {
    sessionId,
    mode: state.mode,
    cacheScope,
    cacheDir,
  });
  return state;
}

/**
 * Execute an autonomous objective using Stagehand's agent.
 * @param {object} session - Stagehand session state
 * @param {string} commandId - Command ID for tracking
 * @param {string} objective - Natural language objective (e.g. from buildIntentObjective)
 * @returns {Promise<object>} Result with steps, screenshot, currentUrl, etc.
 */
export async function executeStagehandObjective(session, commandId, objective) {
  if (session.type !== "stagehand" || !session.stagehand) {
    throw new Error("Session is not a Stagehand session");
  }

  const { stagehand, page } = session;
  const results = [];
  const maxSteps = 30;

  try {
    const agent = stagehand.agent();
    const result = await agent.execute({
      instruction: objective,
      maxSteps,
    });

    session.currentUrl = page.url();
    session.updatedAt = nowIso();

    let screenshotPath = null;
    try {
      screenshotPath = await takeScreenshot(page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      screenshotPath = session.lastScreenshotPath;
    }

    const steps = result?.steps ?? result?.actions ?? [];
    const normalizedActions = Array.isArray(steps)
      ? steps.map((step, index) => {
          if (step && typeof step === "object") return step;
          return {
            index: index + 1,
            action: "act",
            description: String(step || ""),
          };
        })
      : [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const xpath = typeof step === "object" && step ? String(step.xpath || "") : "";
      const selectorUsed = xpath ? `xpath:${xpath}` : null;
      results.push({
        commandId,
        stepId: `step-${i + 1}`,
        action: typeof step === "string" ? step : step?.action ?? "act",
        status: "passed",
        currentUrl: session.currentUrl,
        selectorUsed,
        message: typeof step === "string" ? step : step?.description ?? "Executed",
        screenshotPath: i === steps.length - 1 ? screenshotPath : null,
        durationMs: 0,
      });
    }

    if (results.length === 0) {
      results.push({
        commandId,
        stepId: "step-1",
        action: "agent_execute",
        status: "passed",
        currentUrl: session.currentUrl,
        selectorUsed: null,
        message: "Stagehand agent completed objective",
        screenshotPath,
        durationMs: 0,
      });
    }

    return {
      commandId,
      currentUrl: session.currentUrl,
      results,
      stagehandActions: normalizedActions,
      completed: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("stagehand_execute_failed", { sessionId: session.id, commandId, error: msg });

    let screenshotPath = session.lastScreenshotPath;
    try {
      screenshotPath = await takeScreenshot(page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      // keep existing
    }
    session.currentUrl = page.url();
    session.updatedAt = nowIso();

    return {
      commandId,
      currentUrl: session.currentUrl,
      results: [
        {
          commandId,
          stepId: "step-1",
          action: "agent_execute",
          status: "failed",
          currentUrl: session.currentUrl,
          message: msg,
          screenshotPath,
          durationMs: 0,
        },
      ],
      stagehandActions: [],
      completed: false,
    };
  }
}

/**
 * Get session state for Stagehand sessions (currentUrl, pageText, domSummary).
 */
export async function getStagehandSessionState(session) {
  if (session.type !== "stagehand" || !session.page) {
    return { currentUrl: "", pageText: "", domSummary: "" };
  }
  const page = session.page;
  let currentUrl = "";
  let pageText = "";
  let domSummary = "";

  try {
    currentUrl = page.url();
    pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? "");
    const headings = await page.evaluate(() => {
      const els = document.querySelectorAll("h1, h2, h3, button, a[href], input, [role='button']");
      return Array.from(els)
        .slice(0, 80)
        .map((el) => {
          const tag = el.tagName?.toLowerCase() ?? "";
          const text = (el.textContent ?? "").trim().slice(0, 80);
          const role = el.getAttribute?.("role") ?? "";
          const placeholder = el.getAttribute?.("placeholder") ?? "";
          return { tag, text, role, placeholder };
        });
    });
    domSummary = JSON.stringify(headings);
  } catch {
    // best effort
  }

  return { currentUrl, pageText, domSummary };
}

/**
 * Close a Stagehand session and release resources.
 */
export async function closeStagehandSession(session) {
  if (session.type !== "stagehand" || !session.stagehand) return;
  try {
    await session.stagehand.close?.();
  } catch (err) {
    logError("stagehand_close_failed", { sessionId: session.id, error: String(err) });
  }
}

function sanitizeStagehandScript(script) {
  if (!script || typeof script !== "string") return "";
  let body = script;
  body = body.replace(/^```[a-zA-Z0-9_-]*\n?/gm, "");
  body = body.replace(/^```\n?/gm, "");
  body = body.replace(/^\s*import\s+.+?;?\s*$/gm, "");
  body = body.replace(/^\s*export\s+default\s+/gm, "");
  body = body.replace(/^\s*export\s+/gm, "");
  return body.trim();
}

export async function runStagehandScript(executionId, script, startUrl = null, options = {}) {
  const startedAt = Date.now();
  const logs = [];
  let session = null;
  let status = "passed";
  let errorMessage = null;
  let screenshotPath = null;
  let currentUrl = "";

  try {
    const { z } = await import("zod");
    session = await createStagehandSession(
      String(executionId),
      startUrl,
      {
        apiKey: options.browserbaseApiKey || "",
        projectId: options.browserbaseProjectId || "",
      },
      {
        provider: options.modelProvider || "openai",
        apiKey: options.modelApiKey || "",
        model: options.model || "",
      },
      {
        cacheScope: options.cacheScope || `run_${executionId}`,
      }
    );
    const page = session.page;
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

    const sanitizedScript = sanitizeStagehandScript(script);
    if (!sanitizedScript) {
      throw new Error("Stagehand script is empty");
    }
    const agent = session.stagehand.agent();
    const assert = (condition, message = "Assertion failed") => {
      if (!condition) throw new Error(message);
    };
    const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
    const fn = new AsyncFunction("stagehand", "page", "agent", "z", "assert", sanitizedScript);
    await fn(session.stagehand, page, agent, z, assert);

    currentUrl = page.url();
    screenshotPath = await takeScreenshot(page, String(executionId)).catch(() => null);
    session.lastScreenshotPath = screenshotPath;
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    currentUrl = session?.page?.url?.() || "";
    screenshotPath = session?.page ? await takeScreenshot(session.page, String(executionId)).catch(() => null) : null;
    logs.push({
      level: "error",
      message: errorMessage,
      ts: new Date().toISOString(),
    });
  } finally {
    if (session) {
      await closeStagehandSession(session).catch(() => {});
    }
  }

  return {
    status,
    currentUrl,
    logs,
    screenshotPath,
    videoPath: null,
    tracePath: null,
    errorMessage,
    durationMs: Date.now() - startedAt,
  };
}
