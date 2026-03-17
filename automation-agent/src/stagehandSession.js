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
import { executeScenarioWithTelemetry, planScenario } from "./telemetry/executor.js";
import { compileTelemetryToActions } from "./telemetry/compiler.js";
import { ActionRecorder } from "./telemetry/recorder.js";
import { BrowserRecorder } from "./telemetry/browserRecorder.js";

let Stagehand;
try {
  Stagehand = (await import("@browserbasehq/stagehand")).Stagehand;
} catch {
  Stagehand = null;
}

const DEFAULT_STAGEHAND_AGENT_MODE = "hybrid";
const DEFAULT_LIVE_VIEWPORT = { width: 1600, height: 900 };

const ACTION_CONVERTER_SYSTEM_PROMPT = `You are a Playwright test automation expert.
Your job: convert raw browser automation agent actions into clean, executable Playwright code lines.

LOCATOR PRIORITY (use the FIRST that works):
1. page.getByRole('button', { name: '...' }) — for buttons, links, tabs
2. page.getByLabel('...') — for labeled form inputs (email, password, etc.)
3. page.getByPlaceholder('...') — for inputs with placeholder text
4. page.getByText('...', { exact: false }) — for visible text
5. page.locator('css-selector') — last resort; NEVER use XPath

CODE RULES:
- .fill('value') for text inputs, .click() for buttons/links
- Always add .first() before the final action
- page.goto('url') for navigation, page.waitForTimeout(ms) for waits
- Use { exact: false } where appropriate for fuzzy matching

RETURN: a JSON object { "steps": [ ... ] } — nothing else.`.trim();

const STABLE_LOCATOR_SYSTEM_PROMPT = `
When interacting with page elements, always prefer stable selectors in this order:
1) data-testid / data-test / id attributes
2) accessible role + accessible name
3) associated label text for form controls
4) placeholder or name attributes

Avoid absolute XPath selectors like /html/body/... unless there is no other workable option.
If multiple candidates match, choose the most semantically stable target.
`.trim();

function normalizeAgentMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "dom" || mode === "hybrid" || mode === "cua") return mode;
  return DEFAULT_STAGEHAND_AGENT_MODE;
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

async function enforceLiveViewport(page) {
  if (!page) return;
  try {
    await page.setViewportSize?.(DEFAULT_LIVE_VIEWPORT);
  } catch {
    // best effort
  }

  // Try maximizing browser window when CDP is available (local Chromium).
  try {
    const context = page.context?.();
    if (context?.newCDPSession) {
      const cdp = await context.newCDPSession(page);
      const windowInfo = await cdp.send("Browser.getWindowForTarget").catch(() => null);
      const windowId = windowInfo?.windowId;
      if (windowId != null) {
        await cdp
          .send("Browser.setWindowBounds", {
            windowId,
            bounds: {
              width: DEFAULT_LIVE_VIEWPORT.width,
              height: DEFAULT_LIVE_VIEWPORT.height,
            },
          })
          .catch(() => {});
      }
    }
  } catch {
    // best effort
  }
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
  const agentMode = normalizeAgentMode(runtimeConfig?.agentMode || config.stagehandAgentMode);
  const agentSystemPrompt =
    typeof runtimeConfig?.agentSystemPrompt === "string" && runtimeConfig.agentSystemPrompt.trim()
      ? runtimeConfig.agentSystemPrompt.trim()
      : STABLE_LOCATOR_SYSTEM_PROMPT;
  const useBrowserbase = Boolean(browserbaseApiKey && browserbaseProjectId);
  const stagehandLogs = [];
  const stagehandLogger = (line) => {
    const msg = line.message || "";
    const cat = line.category || "";
    const level = line.level ?? 1;
    stagehandLogs.push({ ts: Date.now(), message: msg, category: cat, level });
    if (stagehandLogs.length > 500) stagehandLogs.shift();
    logInfo("stagehand_sdk_log", { sessionId, category: cat, level, message: msg.slice(0, 300) });
  };

  const stagehandConfig = {
    env: useBrowserbase ? "BROWSERBASE" : "LOCAL",
    experimental: true,
    disableAPI: true,
    cacheDir,
    verbose: 1,
    logger: stagehandLogger,
    model: {
      modelName: resolvedModelName,
      apiKey: modelApiKey,
    },
    localBrowserLaunchOptions: {
      headless: config.headless,
      args: [`--window-size=${DEFAULT_LIVE_VIEWPORT.width},${DEFAULT_LIVE_VIEWPORT.height}`],
    },
    browserbaseSessionCreateParams: {
      browserSettings: {
        viewport: {
          width: DEFAULT_LIVE_VIEWPORT.width,
          height: DEFAULT_LIVE_VIEWPORT.height,
        },
      },
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

  // Keep live preview geometry stable across sessions and providers.
  await enforceLiveViewport(page);

  if (startUrl && startUrl.trim()) {
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await enforceLiveViewport(page);
    } catch (err) {
      logError("stagehand_start_url_failed", { sessionId, startUrl, error: String(err) });
      try {
        await page.goto(startUrl, { waitUntil: "load", timeout: 60000 });
        await enforceLiveViewport(page);
      } catch {
        // Continue with whatever page we have
      }
    }
  }

  const context = stagehand.context;
  const state = {
    id: sessionId,
    type: "stagehand",
    stagehand,
    context,
    page,
    currentUrl: page.url(),
    lastScreenshotPath: null,
    lastVideoPath: null,
    lastTracePath: null,
    events: [],
    stagehandLogs,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cacheScope,
    cacheDir,
    agentMode,
    agentSystemPrompt,
    mode: useBrowserbase ? "browserbase" : "local",
    modelConfig: {
      provider,
      apiKey: modelApiKey,
      model: resolvedModelName,
    },
  };

  if (typeof context.on === "function") {
    context.on("page", (newPage) => {
      logInfo("stagehand_popup_detected", { sessionId, url: newPage.url() });
      state.page = newPage;
      state.currentUrl = newPage.url();
      state.updatedAt = nowIso();
    });
  }
  state._popupListenerAttached = true;

  try {
    state.lastScreenshotPath = await takeScreenshot(page, sessionId);
  } catch {
    // Non-fatal
  }

  // Attach browser-level recorder (actor-agnostic DOM event capture).
  // Uses console.log bridge — compatible with Stagehand's page proxy.
  const browserRecorder = new BrowserRecorder({ sessionId });
  try {
    await browserRecorder.attach(page);
    state.browserRecorder = browserRecorder;
  } catch (err) {
    logError("browser_recorder_attach_failed", { sessionId, error: String(err) });
    state.browserRecorder = null;
  }

  logInfo("stagehand_session_created", {
    sessionId,
    mode: state.mode,
    cacheScope,
    cacheDir,
  });
  return state;
}

const ASSERTION_INTENT_RE = /\b(verify|assert|check|confirm|ensure|validate)\b/i;
const ASSERTION_CONDITION_RE = /\b(visible|displayed|present|shows?|contains?|exists?|appear|seen)\b/i;

function isAssertionCommand(text) {
  return ASSERTION_INTENT_RE.test(text) && ASSERTION_CONDITION_RE.test(text);
}

function extractAssertionTargets(text) {
  const cleaned = text
    .replace(/^user\s+instruction:\s*/i, "")
    .replace(/\nexecution\s+rules:[\s\S]*/i, "")
    .trim();

  const patterns = [
    /(?:verify|assert|check|confirm|ensure|validate)\s+(?:that\s+)?(?:the\s+)?["']?(.+?)["']?\s+(?:text\s+)?(?:is|are)\s+(?:visible|displayed|present|shown)/i,
    /(?:verify|assert|check|confirm|ensure|validate)\s+(?:that\s+)?["']?(.+?)["']?\s+(?:appears?|exists?|shows?|contains?)/i,
    /(?:verify|assert|check|confirm|ensure|validate)\s+(?:that\s+)?(?:the\s+)?(?:text\s+)?["'](.+?)["']/i,
    /(?:verify|assert|check|confirm|ensure|validate)\s+(?:that\s+)?(?:the\s+)?(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      const raw = match[1]
        .replace(/\b(text|is|are|visible|displayed|present|on the page)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (raw.length > 0 && raw.length < 200) return [raw];
    }
  }
  return [];
}

/**
 * Run Playwright-level assertion checks on the live page.
 * Returns concrete assertion action objects with playwright code.
 */
async function runPageAssertions(page, targets) {
  const assertionSteps = [];
  for (const target of targets) {
    const escaped = target.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    try {
      const locator = page.getByText(target, { exact: false }).first();
      const visible = await locator.isVisible().catch(() => false);
      assertionSteps.push({
        type: "act",
        action: "assert_visible",
        targetDescription: target,
        expectedText: target,
        description: `Verify "${target}" is visible on the page`,
        playwright: `await expect(page.getByText('${escaped}', { exact: false }).first()).toBeVisible();`,
        _verificationResult: visible ? "passed" : "failed",
      });
    } catch {
      assertionSteps.push({
        type: "act",
        action: "assert_visible",
        targetDescription: target,
        expectedText: target,
        description: `Verify "${target}" is visible on the page`,
        playwright: `await expect(page.getByText('${escaped}', { exact: false }).first()).toBeVisible();`,
        _verificationResult: "failed",
      });
    }
  }
  return assertionSteps;
}

/**
 * Convert captured onStepFinish tool calls into normalized Playwright-compatible
 * action objects. This is the most reliable conversion path because it uses the
 * actual tool names and arguments from the Stagehand agent execution.
 */
function convertToolCallsToActions(toolCalls, currentUrl) {
  const actions = [];
  for (const tc of toolCalls) {
    const { toolName, args, result: toolResult } = tc;
    const name = String(toolName || "").toLowerCase();

    if (["screenshot", "done", "think", "ariatree"].includes(name)) continue;

    if (name === "click") {
      let describe = String(
        args?.describe || args?.instruction || args?.element || args?.text ||
        args?.target || args?.selector || args?.description || ""
      ).trim();
      if (!describe) {
        describe = extractDescriptionFromResult(toolResult);
      }
      if (!describe) continue;
      const escaped = describe.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      actions.push({
        type: "act",
        action: "click",
        targetDescription: describe,
        description: `Click on ${describe}`,
        playwright: `await page.getByRole('button', { name: '${escaped}', exact: false }).or(page.getByText('${escaped}', { exact: false })).first().click();`,
      });
      continue;
    }

    if (name === "type") {
      const describe = String(args?.describe || args?.instruction || "").trim();
      const text = String(args?.text || args?.value || "").trim();
      if (!text) continue;
      const escapedDesc = (describe || "text field").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const escapedValue = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      actions.push({
        type: "act",
        action: "type",
        targetDescription: describe || "text field",
        value: text,
        description: `Type "${text}" into ${describe || "text field"}`,
        playwright: `await page.getByLabel('${escapedDesc}', { exact: false }).first().fill('${escapedValue}');`,
      });
      continue;
    }

    if (name === "act") {
      const instruction = String(args?.instruction || args?.action || "").trim();
      if (!instruction) continue;
      const escaped = instruction.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const isType = /\b(type|fill|enter|input|write)\b/i.test(instruction);
      if (isType) {
        const valueMatch =
          instruction.match(/(?:type|fill|enter|input|write)\s+["'](.+?)["']\s/i) ||
          instruction.match(/["'](.+?)["']/);
        const value = valueMatch?.[1] || "";
        const targetMatch = instruction.match(/(?:into?|on)\s+(?:the\s+)?["']?(.+?)["']?\s*$/i);
        const target = targetMatch?.[1] || instruction;
        const escapedTarget = target.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        actions.push({
          type: "act",
          action: "type",
          targetDescription: target,
          value,
          description: instruction,
          playwright:
            target && value
              ? `await page.getByLabel('${escapedTarget}', { exact: false }).first().fill('${escapedValue}');`
              : `// act: ${escaped}`,
        });
      } else {
        actions.push({
          type: "act",
          action: "click",
          targetDescription: instruction,
          description: instruction,
          playwright: `await page.getByText('${escaped}', { exact: false }).first().click();`,
        });
      }
      continue;
    }

    if (name === "goto" || name === "navigate") {
      const url = String(args?.url || "").trim();
      if (!url) continue;
      const escaped = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      actions.push({
        type: "act",
        action: "navigate",
        url,
        description: `Navigate to ${url}`,
        playwright: `await page.goto('${escaped}');`,
      });
      continue;
    }

    if (name === "keys" || name === "press") {
      const key = String(args?.keys || args?.key || "").trim();
      if (!key) continue;
      const escaped = key.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      actions.push({
        type: "act",
        action: "press",
        key,
        description: `Press ${key}`,
        playwright: `await page.keyboard.press('${escaped}');`,
      });
      continue;
    }

    if (name === "scroll") {
      const direction = String(args?.direction || "down").trim().toLowerCase();
      const pixels = Number(args?.pixels || args?.scrolledPixels || 300);
      const deltaX = direction.includes("left") ? -pixels : direction.includes("right") ? pixels : 0;
      const deltaY = direction.includes("up") ? -pixels : pixels;
      actions.push({
        type: "act",
        action: "scroll",
        description: `Scroll ${direction}`,
        playwright: `await page.mouse.wheel(${deltaX}, ${deltaY});`,
      });
      continue;
    }

    if (name === "wait") {
      const waited = Number(args?.timeMs || toolResult?.waited || 2000);
      actions.push({
        type: "wait",
        action: "wait",
        timeMs: waited,
        description: `Wait for ${waited}ms`,
        playwright: `await page.waitForTimeout(${waited});`,
      });
      continue;
    }

    if (name === "fillform" || name === "fillformvision") {
      const fields = Array.isArray(toolResult?.playwrightArguments)
        ? toolResult.playwrightArguments
        : Array.isArray(args?.fields)
          ? args.fields
          : Array.isArray(toolResult?.fields)
            ? toolResult.fields
            : Array.isArray(args?.formFields)
              ? args.formFields
              : [];
      for (const field of fields) {
        if (!field || typeof field !== "object") continue;
        const desc = String(field.action || field.description || "").trim();
        const val = String(field.value || field.originalValue || "").trim();
        if (!val && !desc) continue;
        const escapedDesc = (desc || "field").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const escapedValue = val.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        actions.push({
          type: "act",
          action: "type",
          targetDescription: desc,
          value: val,
          description: desc,
          playwright: `await page.getByLabel('${escapedDesc}', { exact: false }).first().fill('${escapedValue}');`,
        });
      }
      continue;
    }

    if (name === "navback") {
      actions.push({
        type: "act",
        action: "navigate",
        description: "Navigate back",
        playwright: "await page.goBack();",
      });
      continue;
    }

    if (name === "extract") {
      if (toolResult && typeof toolResult === "object") {
        for (const value of Object.values(toolResult)) {
          if (typeof value === "string" && value.trim()) {
            const escaped = value.trim().replace(/\\/g, "\\\\").replace(/'/g, "\\'");
            actions.push({
              type: "act",
              action: "assert_text",
              expectedText: value.trim(),
              description: `Verify "${value.trim()}" is present`,
              playwright: `await expect(page.getByText('${escaped}', { exact: false }).first()).toBeVisible();`,
            });
          }
        }
      }
      continue;
    }

    if (name === "draganddrop" || name === "drag") {
      const startDesc = String(args?.startDescribe || args?.startDescription || "source").trim();
      const endDesc = String(args?.endDescribe || args?.endDescription || "target").trim();
      const escapedStart = startDesc.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const escapedEnd = endDesc.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      actions.push({
        type: "act",
        action: "drag",
        startSelector: startDesc,
        endSelector: endDesc,
        description: `Drag ${startDesc} to ${endDesc}`,
        playwright: `await page.getByText('${escapedStart}', { exact: false }).first().dragTo(page.getByText('${escapedEnd}', { exact: false }).first());`,
      });
      continue;
    }
  }
  return actions;
}

/**
 * Execute using telemetry-driven observe→act→extract flow.
 * Produces reliable Playwright scripts from structured telemetry.
 */
export async function executeStagehandWithTelemetry(session, commandId, objective) {
  if (session.type !== "stagehand" || !session.stagehand) {
    throw new Error("Session is not a Stagehand session");
  }

  // Clear the local act-cache before every run so stale cached actions from a
  // previous run (e.g. ones that used <UNKNOWN> values) are never replayed.
  if (session.cacheDir) {
    try {
      await fs.rm(session.cacheDir, { recursive: true, force: true });
      await fs.mkdir(session.cacheDir, { recursive: true });
      logInfo("stagehand_act_cache_cleared", { sessionId: session.id, cacheDir: session.cacheDir });
    } catch (err) {
      logError("stagehand_act_cache_clear_failed", { sessionId: session.id, error: String(err) });
    }
  }

  const recorder = new ActionRecorder({
    runId: commandId,
    scenarioName: objective.slice(0, 200),
  });
  recorder.start();
  session.recorder = recorder;

  const pushSessionEvent = (eventData) => {
    if (!session.events) session.events = [];
    session.events.push({ ...eventData, createdAt: nowIso() });
    if (session.events.length > 2000) {
      session.events.splice(0, session.events.length - 2000);
    }
    session.updatedAt = nowIso();
  };

  const plan = planScenario(objective);
  if (plan.length === 0) {
    return executeStagehandObjective(session, commandId, objective, recorder);
  }

  pushSessionEvent({
    type: "stagehand_agent_reasoning",
    commandId,
    stepIndex: 0,
    reasoning: `Planned ${plan.length} steps for execution`,
    url: session.page.url(),
    plan: plan.map((s, i) => ({ index: i + 1, instruction: s.instruction })),
  });

  try {
    const { success, events, stagehandActions: rawActions, results } = await executeScenarioWithTelemetry(
      session,
      objective,
      {
        plan,
        continueOnFailure: true,
        recorder,
        onStepStart: (stepId, instruction, index) => {
          pushSessionEvent({
            type: "stagehand_agent_reasoning",
            commandId,
            stepIndex: index + 1,
            reasoning: `Step ${index + 1}/${plan.length}: ${instruction}`,
            url: session.page.url(),
          });
        },
        onStepComplete: (stepId, instruction, index, stepResult) => {
          pushSessionEvent({
            type: "stagehand_agent_action",
            commandId,
            stepIndex: index + 1,
            toolName: stepResult.success ? "act" : "act_failed",
            args: { instruction },
            reasoning: stepResult.success ? `Completed: ${instruction}` : `Failed: ${stepResult.error || instruction}`,
            url: session.page.url(),
            success: stepResult.success,
          });
        },
      }
    );

    session.currentUrl = session.page.url();
    session.updatedAt = nowIso();

    let screenshotPath = session.lastScreenshotPath;
    try {
      screenshotPath = await takeScreenshot(session.page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      // keep existing
    }

    const compiledActions = events.length > 0 ? compileTelemetryToActions(events) : rawActions;

    const stepResults = results.map((r, i) => ({
      commandId,
      stepId: r.stepId || `step-${i + 1}`,
      action: r.success ? "act" : "agent_execute",
      status: r.success ? "passed" : "failed",
      currentUrl: session.currentUrl,
      selectorUsed: null,
      message: r.instruction || (r.success ? "Executed" : r.error),
      screenshotPath: i === results.length - 1 ? screenshotPath : null,
      durationMs: 0,
    }));

    if (stepResults.length === 0) {
      stepResults.push({
        commandId,
        stepId: "step-1",
        action: "agent_execute",
        status: success ? "passed" : "failed",
        currentUrl: session.currentUrl,
        message: "Telemetry execution completed",
        screenshotPath,
        durationMs: 0,
      });
    }

    recorder.stop();
    const browserRecTelemetry = session.browserRecorder;
    if (browserRecTelemetry) browserRecTelemetry.stop();

    logInfo("stagehand_telemetry_complete", {
      sessionId: session.id,
      eventCount: events.length,
      actionCount: compiledActions.length,
      recorderEntryCount: recorder.entryCount,
      browserRecordedActions: browserRecTelemetry ? browserRecTelemetry.actionCount : 0,
    });

    const browserPlaywrightActions = browserRecTelemetry ? browserRecTelemetry.getPlaywrightActions() : [];

    // Script + actions come exclusively from BrowserRecorder (actor-agnostic layer).
    // ActionRecorder/Stagehand data kept only as metadata.
    const returnTelemetry = {
      commandId,
      currentUrl: session.currentUrl,
      results: stepResults,
      stagehandActions: browserPlaywrightActions.length > 0
        ? browserPlaywrightActions.map((ba) => ({
            type: ba.action === "scroll" ? "scroll" : ba.action === "navigate" ? "navigate" : "act",
            action: ba.action || "act",
            instruction: ba.target || "",
            targetDescription: ba.target || "",
            value: ba.value || "",
            description: ba.target ? `${ba.action}: ${ba.target}` : ba.action,
            playwright: ba.playwright || "",
            selector: ba.selector || "",
            selectorMethod: ba.selectorMethod || "unknown",
          }))
        : [],
      telemetryEvents: events,
      telemetryPlan: plan,
      completed: success,
      recording: recorder.toJSON(),
      recordedScript: browserRecTelemetry
        ? browserRecTelemetry.toPlaywrightScript()
        : "// No browser recording available",
    };
    if (browserRecTelemetry) {
      returnTelemetry.browserRecording = browserRecTelemetry.toJSON();
    }
    return returnTelemetry;
  } catch (err) {
    recorder.stop();
    const browserRecTelErr = session.browserRecorder;
    if (browserRecTelErr) browserRecTelErr.stop();
    logError("stagehand_telemetry_failed", { sessionId: session.id, error: String(err) });
    return executeStagehandObjective(session, commandId, objective, recorder);
  }
}

/**
 * Extract a human-readable description of a click target from the AI reasoning text.
 * Returns the best short label found, or "" if nothing useful.
 */
function extractClickTargetFromReasoning(reasoning) {
  if (!reasoning || typeof reasoning !== "string") return "";
  const patterns = [
    /(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?["'](.+?)["']\s*(?:button|link|tab|option|menu|icon)?/i,
    /(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?["'](.+?)["']/i,
    /(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:button|link|tab|option|menu|icon)/i,
    /(?:clicking|tapping|pressing)\s+(?:on\s+)?(?:the\s+)?["'](.+?)["']/i,
    /(?:clicking|tapping|pressing)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:button|link|tab|option|menu|icon)/i,
  ];
  for (const pat of patterns) {
    const m = reasoning.match(pat);
    if (m?.[1]) {
      const label = m[1].trim();
      if (label.length > 2 && label.length < 120) return label;
    }
  }
  return "";
}

/**
 * Extract fill-field info from AI reasoning text for fillFormVision calls.
 * Returns an array of { label, value } objects.
 */
function extractFieldsFromReasoning(reasoning) {
  if (!reasoning || typeof reasoning !== "string") return [];
  const fields = [];
  const patterns = [
    /(?:Email|email)\s*(?:field\s+)?(?:shows?|with|=|:)\s*["']?([^\n"',]+)/i,
    /(?:Password|password)\s*(?:field\s+)?(?:shows?|with|=|:)\s*["']?([^\n"',]+)/i,
    /(?:Username|username)\s*(?:field\s+)?(?:shows?|with|=|:)\s*["']?([^\n"',]+)/i,
  ];
  const labels = ["Email", "Password", "Username"];
  for (let i = 0; i < patterns.length; i++) {
    const m = reasoning.match(patterns[i]);
    if (m?.[1]) {
      const val = m[1].trim().replace(/["']+$/, "").trim();
      if (val && val.length > 1 && !/^•+$/.test(val)) {
        fields.push({ label: labels[i], value: val });
      }
    }
  }
  return fields;
}

/**
 * Extract a description for a tool result or toolResult from Stagehand.
 * Tries various known property patterns for the resolved element.
 */
function extractDescriptionFromResult(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return "";
  const candidates = [
    toolResult.description,
    toolResult.elementDescription,
    toolResult.resolvedElement,
    toolResult.message,
    toolResult.selector,
    toolResult.text,
    toolResult.label,
    toolResult.ariaLabel,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 1 && c.trim().length < 200) {
      return c.trim();
    }
  }
  return "";
}

/**
 * Record a single agent tool call directly to the recorder's unified timeline.
 * Handles every Stagehand V3 tool type with robust arg/result extraction.
 *
 * @param {ActionRecorder} recorder
 * @param {string} toolName - Lowercased tool name
 * @param {object} args - Tool call arguments from the agent
 * @param {*} toolResult - Matched tool result
 * @param {string} stepId
 * @param {string} currentUrl
 * @param {string} [reasoningText] - AI reasoning from the same onStepFinish event
 */
function recordToolCallToTimeline(recorder, toolName, args, toolResult, stepId, currentUrl, reasoningText) {
  if (!recorder) return;

  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'stagehandSession.js:recordToolCallToTimeline',message:'tool_call_raw_data',data:{toolName,argKeys:Object.keys(args||{}),args:JSON.parse(JSON.stringify(args||{},(_k,v)=>typeof v==='string'&&v.length>200?v.slice(0,200)+'…':v)),resultType:typeof toolResult,resultKeys:toolResult&&typeof toolResult==='object'?Object.keys(toolResult):[],resultPreview:toolResult&&typeof toolResult==='object'?JSON.parse(JSON.stringify(toolResult,(_k,v)=>typeof v==='string'&&v.length>200?v.slice(0,200)+'…':v)):String(toolResult).slice(0,200),reasoningSnippet:String(reasoningText||'').slice(0,300),stepId},timestamp:Date.now(),hypothesisId:'H1-H4'})}).catch(()=>{});
  // #endregion

  if (toolName === "fillform" || toolName === "fillformvision") {
    const fields =
      (Array.isArray(toolResult?.playwrightArguments) && toolResult.playwrightArguments) ||
      (Array.isArray(args?.fields) && args.fields) ||
      (Array.isArray(toolResult?.fields) && toolResult.fields) ||
      (Array.isArray(args?.formFields) && args.formFields) ||
      (Array.isArray(toolResult?.formFields) && toolResult.formFields) ||
      [];

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'stagehandSession.js:fillform_handler',message:'fillform_data',data:{stepId,fieldsFound:fields.length,fieldsPreview:fields.slice(0,5),reasoningFields:extractFieldsFromReasoning(reasoningText),argsKeys:Object.keys(args||{}),resultKeys:toolResult&&typeof toolResult==='object'?Object.keys(toolResult):[],hasPlaywrightArgs:Array.isArray(toolResult?.playwrightArguments),hasArgsFields:Array.isArray(args?.fields),hasResultFields:Array.isArray(toolResult?.fields)},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    if (fields.length > 0) {
      for (const field of fields) {
        if (!field || typeof field !== "object") continue;
        const label = String(
          field.label || field.action || field.description || field.name || field.selector || "field"
        ).trim();
        const val = String(field.value || field.originalValue || field.text || field.fillValue || "").trim();
        if (!val && !label) continue;
        recorder.recordAction({
          tool: toolName,
          action: "type",
          target: label,
          value: val,
          playwright: `await page.getByLabel('${escPw(label)}', { exact: false }).first().fill('${escPw(val)}');`,
          description: `Fill "${label}" with "${val}"`,
          stepId,
          url: currentUrl,
        });
      }
      return;
    }

    // Try to reconstruct fields from the reasoning text
    const reasoningFields = extractFieldsFromReasoning(reasoningText);
    if (reasoningFields.length > 0) {
      for (const rf of reasoningFields) {
        recorder.recordAction({
          tool: toolName,
          action: "type",
          target: rf.label,
          value: rf.value,
          playwright: `await page.getByLabel('${escPw(rf.label)}', { exact: false }).first().fill('${escPw(rf.value)}');`,
          description: `Fill "${rf.label}" with "${rf.value}"`,
          stepId,
          url: currentUrl,
        });
      }
      return;
    }

    const instruction = String(args?.instruction || args?.describe || args?.description || "").trim();
    if (instruction) {
      recorder.recordAction({
        tool: toolName,
        action: "type",
        target: instruction,
        playwright: `// fillFormVision: ${escPw(instruction)}`,
        description: instruction,
        stepId,
        url: currentUrl,
      });
    } else {
      logInfo("recorder_fillform_no_fields", {
        stepId,
        toolName,
        argKeys: Object.keys(args || {}),
        resultKeys: Object.keys(toolResult || {}),
        reasoningSnippet: String(reasoningText || "").slice(0, 200),
      });
    }
    return;
  }

  if (toolName === "click") {
    let describe = String(
      args?.describe || args?.instruction || args?.element || args?.text ||
      args?.target || args?.selector || args?.description ||
      ""
    ).trim();

    const fromArgs = describe;

    if (!describe) {
      describe = extractDescriptionFromResult(toolResult);
    }

    const fromResult = !fromArgs ? describe : "";

    if (!describe) {
      describe = extractClickTargetFromReasoning(reasoningText);
    }

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'stagehandSession.js:click_handler',message:'click_resolution',data:{stepId,fromArgs,fromResult,fromReasoning:!fromArgs&&!fromResult?describe:'',finalDescribe:describe,reasoningFull:String(reasoningText||'').slice(0,500)},timestamp:Date.now(),hypothesisId:'H2-H4'})}).catch(()=>{});
    // #endregion

    if (!describe) {
      logInfo("recorder_click_no_describe", {
        stepId,
        argKeys: Object.keys(args || {}),
        resultType: typeof toolResult,
        resultKeys: toolResult && typeof toolResult === "object" ? Object.keys(toolResult) : [],
        reasoningSnippet: String(reasoningText || "").slice(0, 200),
      });
      return;
    }
    recorder.recordAction({
      tool: "click",
      action: "click",
      target: describe,
      playwright: `await page.getByRole('button', { name: '${escPw(describe)}', exact: false }).or(page.getByText('${escPw(describe)}', { exact: false })).first().click();`,
      description: `Click on "${describe}"`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "type" || toolName === "fill") {
    const describe = String(args?.describe || args?.instruction || args?.element || args?.description || "text field").trim();
    const text = String(args?.text || args?.value || "").trim();
    if (!text) return;
    recorder.recordAction({
      tool: toolName,
      action: "type",
      target: describe,
      value: text,
      playwright: `await page.getByLabel('${escPw(describe)}', { exact: false }).first().fill('${escPw(text)}');`,
      description: `Type "${text}" into "${describe}"`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "goto" || toolName === "navigate") {
    const url = String(args?.url || "").trim();
    if (!url) return;
    recorder.recordAction({
      tool: toolName,
      action: "navigate",
      target: url,
      playwright: `await page.goto('${escPw(url)}');`,
      description: `Navigate to ${url}`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "wait") {
    const ms = Number(args?.timeMs || toolResult?.waited || 2000);
    recorder.recordAction({
      tool: "wait",
      action: "wait",
      playwright: `await page.waitForTimeout(${ms});`,
      description: `Wait for ${ms}ms`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "keys" || toolName === "press") {
    const key = String(args?.keys || args?.key || "").trim();
    if (!key) return;
    recorder.recordAction({
      tool: toolName,
      action: "press",
      target: key,
      playwright: `await page.keyboard.press('${escPw(key)}');`,
      description: `Press ${key}`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "scroll") {
    const direction = String(args?.direction || "down").trim().toLowerCase();
    const pixels = Number(args?.pixels || args?.scrolledPixels || 300);
    const deltaX = direction.includes("left") ? -pixels : direction.includes("right") ? pixels : 0;
    const deltaY = direction.includes("up") ? -pixels : pixels;
    recorder.recordAction({
      tool: "scroll",
      action: "scroll",
      target: direction,
      playwright: `await page.mouse.wheel(${deltaX}, ${deltaY});`,
      description: `Scroll ${direction}`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "extract") {
    if (toolResult && typeof toolResult === "object") {
      const assertions = [];
      for (const [, value] of Object.entries(toolResult)) {
        if (typeof value === "string" && value.trim() && value.trim().length < 200) {
          const escaped = escPw(value.trim());
          assertions.push({
            playwright: `await expect(page.getByText('${escaped}', { exact: false }).first()).toBeVisible();`,
            description: `Verify "${value.trim()}" is present`,
          });
        }
      }
      for (const a of assertions) {
        recorder.recordAction({
          tool: "extract",
          action: "assert_visible",
          target: a.description,
          playwright: a.playwright,
          description: a.description,
          stepId,
          url: currentUrl,
        });
      }
      recorder.recordResult({
        tool: "extract",
        data: toolResult,
        assertions: assertions.map((a) => a.playwright),
        stepId,
        url: currentUrl,
      });
    }
    return;
  }

  if (toolName === "navback") {
    recorder.recordAction({
      tool: "navback",
      action: "navigate",
      playwright: "await page.goBack();",
      description: "Navigate back",
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "draganddrop" || toolName === "drag") {
    const startDesc = String(args?.startDescribe || args?.startDescription || "source").trim();
    const endDesc = String(args?.endDescribe || args?.endDescription || "target").trim();
    recorder.recordAction({
      tool: toolName,
      action: "drag",
      target: `${startDesc} → ${endDesc}`,
      playwright: `await page.getByText('${escPw(startDesc)}', { exact: false }).first().dragTo(page.getByText('${escPw(endDesc)}', { exact: false }).first());`,
      description: `Drag ${startDesc} to ${endDesc}`,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (toolName === "done") {
    const message = typeof args?.message === "string"
      ? args.message
      : typeof toolResult === "string" ? toolResult : null;
    recorder.recordResult({
      tool: "done",
      data: toolResult,
      message,
      stepId,
      url: currentUrl,
    });
    return;
  }

  if (!["screenshot", "ariatree", "think"].includes(toolName)) {
    logInfo("recorder_unhandled_tool", {
      stepId,
      toolName,
      argKeys: Object.keys(args || {}),
      resultType: typeof toolResult,
    });
  }
}

function escPw(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Execute an autonomous objective using Stagehand's agent.
 * @param {object} session - Stagehand session state
 * @param {string} commandId - Command ID for tracking
 * @param {string} objective - Natural language objective (e.g. from buildIntentObjective)
 * @returns {Promise<object>} Result with steps, screenshot, currentUrl, etc.
 */
export async function executeStagehandObjective(session, commandId, objective, recorder = null) {
  if (session.type !== "stagehand" || !session.stagehand) {
    throw new Error("Session is not a Stagehand session");
  }

  if (recorder && !recorder.isRecording) {
    recorder.start();
  }

  const { stagehand, page } = session;
  const results = [];
  const maxSteps = 30;
  let stepCounter = 0;

  const pushSessionEvent = (eventData) => {
    if (!session.events) session.events = [];
    session.events.push({ ...eventData, createdAt: nowIso() });
    if (session.events.length > 2000) {
      session.events.splice(0, session.events.length - 2000);
    }
    session.updatedAt = nowIso();
  };

  try {
    const capturedToolCalls = [];
    const agent = stagehand.agent({
      mode: session.agentMode || DEFAULT_STAGEHAND_AGENT_MODE,
      systemPrompt: session.agentSystemPrompt || STABLE_LOCATOR_SYSTEM_PROMPT,
    });
    const result = await agent.execute({
      instruction: objective,
      maxSteps,
      callbacks: {
        onStepFinish: async (event) => {
          try {
            const reasoningText = event.text || "";
            const currentUrl = page.url();

            if (reasoningText.trim()) {
              if (recorder) {
                recorder.recordReasoning(reasoningText, {
                  stepId: `agent-step-${stepCounter + 1}`,
                  url: currentUrl,
                });
              }

              pushSessionEvent({
                type: "stagehand_agent_reasoning",
                commandId,
                stepIndex: stepCounter,
                reasoning: reasoningText.trim(),
                url: currentUrl,
              });
            }

            const toolCalls = event.toolCalls || [];
            const toolResults = event.toolResults || [];

            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'stagehandSession.js:onStepFinish_raw',message:'raw_event_structure',data:{eventKeys:Object.keys(event||{}),toolCallCount:toolCalls.length,toolResultCount:toolResults.length,firstTC:toolCalls[0]?{allKeys:Object.keys(toolCalls[0]),toolName:toolCalls[0].toolName,hasArgs:toolCalls[0].args!==undefined,hasInput:toolCalls[0].input!==undefined,hasParameters:toolCalls[0].parameters!==undefined,hasArguments:toolCalls[0].arguments!==undefined,toolCallId:toolCalls[0].toolCallId,rawPreview:JSON.stringify(toolCalls[0],(_k,v)=>typeof v==='string'&&v.length>100?v.slice(0,100)+'…':v).slice(0,600)}:null,firstTR:toolResults[0]?{allKeys:Object.keys(toolResults[0]),hasResult:toolResults[0].result!==undefined,hasOutput:toolResults[0].output!==undefined,hasContent:toolResults[0].content!==undefined,rawPreview:JSON.stringify(toolResults[0],(_k,v)=>typeof v==='string'&&v.length>100?v.slice(0,100)+'…':v).slice(0,600)}:null},timestamp:Date.now(),hypothesisId:'RAW_STRUCTURE'})}).catch(()=>{});
            // #endregion

            for (const tc of toolCalls) {
              const matchingResult = toolResults.find(
                (tr) => tr.toolCallId === tc.toolCallId
              );
              const captured = {
                toolName: tc.toolName,
                args: tc.args || {},
                result: matchingResult?.result ?? null,
              };
              capturedToolCalls.push(captured);

              stepCounter++;
              const stepId = `agent-step-${stepCounter}`;

              const toolName = String(tc.toolName || "").toLowerCase();
              const args = tc.args || {};
              const toolResult = captured.result;
              const safeArgs = {};
              for (const [key, value] of Object.entries(args)) {
                if (key === "screenshot" || key === "data") continue;
                if (typeof value === "string" && value.length > 300) {
                  safeArgs[key] = value.slice(0, 250) + "…";
                } else {
                  safeArgs[key] = value;
                }
              }

              pushSessionEvent({
                type: "stagehand_agent_action",
                commandId,
                stepIndex: stepCounter,
                toolName: tc.toolName,
                args: safeArgs,
                reasoning: event.reasoning || event.text || null,
                url: currentUrl,
                success: matchingResult?.result !== undefined,
              });

              if (recorder) {
                recordToolCallToTimeline(recorder, toolName, args, toolResult, stepId, currentUrl, reasoningText);
              }
            }
          } catch {
            // non-fatal: don't break agent execution
          }
        },
      },
    });

    if (recorder && result?.actions) {
      const existingCount = recorder.getReasoningLog().length;
      if (existingCount === 0) {
        for (const action of result.actions) {
          if (action?.reasoning && typeof action.reasoning === "string" && action.reasoning.trim()) {
            recorder.recordReasoning(action.reasoning, {
              stepId: action.type || null,
              url: action.pageUrl || page.url(),
            });
          }
        }
      }
    }

    session.currentUrl = page.url();
    session.updatedAt = nowIso();

    let screenshotPath = null;
    try {
      screenshotPath = await takeScreenshot(page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      screenshotPath = session.lastScreenshotPath;
    }

    // --- Browser-level recording (actor-agnostic, page-side DOM events) ---
    const browserRecorder = session.browserRecorder;
    let browserActions = [];
    if (browserRecorder) {
      browserRecorder.stop();
      browserActions = browserRecorder.getPlaywrightActions();
      logInfo("browser_recorder_results", {
        sessionId: session.id,
        browserActionCount: browserActions.length,
        summary: browserRecorder.getSummary(),
      });
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'stagehandSession.js:browser_recorder_final',message:'browser_recorder_output',data:{browserActionCount:browserActions.length,summary:browserRecorder.getSummary(),actions:browserActions.map(a=>({seq:a.seq,action:a.action,target:a.target,selector:a.selector?.slice(0,100),selectorMethod:a.selectorMethod,value:a.value?.slice(0,50)}))},timestamp:Date.now(),hypothesisId:'BROWSER'})}).catch(()=>{});
      // #endregion
    }

    // normalizedActions come exclusively from the BrowserRecorder (actor-agnostic
    // DOM event capture). The ActionRecorder (Stagehand tool calls) is kept only
    // as debug metadata — it never feeds into the generated Playwright script.
    let normalizedActions = [];

    if (browserActions.length > 0) {
      logInfo("using_browser_recorder_as_primary", {
        sessionId: session.id,
        browserActionCount: browserActions.length,
      });
      normalizedActions = browserActions.map((ba) => ({
        type: ba.action === "scroll" ? "scroll" : ba.action === "navigate" ? "navigate" : "act",
        action: ba.action || "act",
        instruction: ba.target || "",
        targetDescription: ba.target || "",
        value: ba.value || "",
        description: ba.target ? `${ba.action}: ${ba.target}` : ba.action,
        playwright: ba.playwright || "",
        selector: ba.selector || "",
        selectorMethod: ba.selectorMethod || "unknown",
      }));
    } else {
      logInfo("browser_recorder_no_actions", {
        sessionId: session.id,
        reason: "BrowserRecorder captured 0 actions — script will be empty",
      });
    }

    // Detect assertion/verification commands and add concrete assertion steps
    const assertionTargets = isAssertionCommand(objective)
      ? extractAssertionTargets(objective)
      : [];
    const hasAssertionSteps = normalizedActions.some(
      (a) => a && typeof a.action === "string" && a.action.startsWith("assert")
    );
    if (assertionTargets.length > 0 && !hasAssertionSteps) {
      const assertionSteps = await runPageAssertions(page, assertionTargets);
      for (const step of assertionSteps) {
        normalizedActions.push(step);
      }
    }

    for (let i = 0; i < normalizedActions.length; i++) {
      const step = normalizedActions[i];
      const xpath = typeof step === "object" && step ? String(step.xpath || "") : "";
      const selectorUsed = xpath ? `xpath:${xpath}` : null;
      const verificationResult = step?._verificationResult;
      results.push({
        commandId,
        stepId: `step-${i + 1}`,
        action: step?.action || step?.type || "act",
        status: verificationResult || "passed",
        currentUrl: session.currentUrl,
        selectorUsed,
        message: step?.description || step?.instruction || "Executed",
        screenshotPath: i === normalizedActions.length - 1 ? screenshotPath : null,
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

    if (recorder) recorder.stop();

    logInfo("stagehand_recording_complete", {
      sessionId: session.id,
      timelineEntries: recorder ? recorder.entryCount : 0,
      actionsRecorded: recorder ? recorder.getActions().length : 0,
      normalizedActions: normalizedActions.length,
      browserRecordedActions: browserActions.length,
      scriptSource: "BrowserRecorder",
    });

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/9f1cf82a-d9d3-4642-adad-ef6b5f27edfa',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d01865'},body:JSON.stringify({sessionId:'d01865',location:'stagehandSession.js:final_output',message:'final_normalized_actions',data:{normalizedCount:normalizedActions.length,scriptSource:'BrowserRecorder',browserActionCount:browserActions.length,actions:normalizedActions.map((a,i)=>({idx:i,action:a.action,target:a.targetDescription?.slice(0,80),playwright:a.playwright?.slice(0,120),selectorMethod:a.selectorMethod}))},timestamp:Date.now(),hypothesisId:'FINAL'})}).catch(()=>{});
    // #endregion

    const returnObj = {
      commandId,
      currentUrl: session.currentUrl,
      results,
      stagehandActions: normalizedActions,
      completed: true,
    };

    // Script comes exclusively from the BrowserRecorder (actor-agnostic layer).
    // ActionRecorder data is kept as debug metadata only.
    if (browserRecorder) {
      returnObj.recordedScript = browserRecorder.toPlaywrightScript({
        testName: recorder?.scenarioName || "recorded browser test",
      });
      returnObj.browserRecording = browserRecorder.toJSON();
    }
    if (recorder) {
      returnObj.recording = recorder.toJSON();
    }
    return returnObj;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("stagehand_execute_failed", { sessionId: session.id, commandId, error: msg });

    if (recorder) recorder.stop();
    const browserRecorderErr = session.browserRecorder;
    if (browserRecorderErr) browserRecorderErr.stop();

    let screenshotPath = session.lastScreenshotPath;
    try {
      screenshotPath = await takeScreenshot(page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      // keep existing
    }
    session.currentUrl = page.url();
    session.updatedAt = nowIso();

    // Even on failure, browser recorder may have captured useful actions
    let failActions = [];
    if (browserRecorderErr) {
      failActions = browserRecorderErr.getPlaywrightActions().map((ba) => ({
        type: ba.action === "scroll" ? "scroll" : ba.action === "navigate" ? "navigate" : "act",
        action: ba.action || "act",
        instruction: ba.target || "",
        targetDescription: ba.target || "",
        value: ba.value || "",
        description: ba.target ? `${ba.action}: ${ba.target}` : ba.action,
        playwright: ba.playwright || "",
        selector: ba.selector || "",
        selectorMethod: ba.selectorMethod || "unknown",
      }));
    }

    const returnObj = {
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
      stagehandActions: failActions,
      completed: false,
    };

    // Script comes exclusively from the BrowserRecorder.
    if (browserRecorderErr) {
      returnObj.recordedScript = browserRecorderErr.toPlaywrightScript({
        testName: recorder?.scenarioName || "recorded browser test",
      });
      returnObj.browserRecording = browserRecorderErr.toJSON();
    }
    if (recorder) {
      returnObj.recording = recorder.toJSON();
    }
    return returnObj;
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

/**
 * Strip large/binary fields from actions before sending to the LLM.
 */
function sanitizeActionsForPrompt(actions) {
  return actions.map((action) => {
    const clean = {};
    for (const [key, value] of Object.entries(action)) {
      if (key === "data" || key === "screenshot") continue;
      if (key === "messages" || key === "usage") continue;
      if (typeof value === "string" && value.length > 600) {
        clean[key] = value.slice(0, 400) + "…(truncated)";
      } else {
        clean[key] = value;
      }
    }
    return clean;
  });
}

/**
 * Call the configured LLM (OpenAI or Anthropic) to intelligently convert
 * raw Stagehand agent actions into clean Playwright code.
 * Falls back to the static flattenStagehandAgentActions on failure.
 */
async function convertActionsWithAI(rawActions, currentUrl, modelConfig, objective = "") {
  if (!rawActions || rawActions.length === 0) return [];
  if (!modelConfig?.apiKey) return flattenStagehandAgentActions(rawActions);

  const sanitized = sanitizeActionsForPrompt(rawActions);

  const assertionHint = isAssertionCommand(objective)
    ? `\n\nIMPORTANT: The user's original objective was a VERIFICATION/ASSERTION command: "${objective}"
If the actions list is empty or only contains screenshot/done, you MUST still generate assertion steps.
Use: await expect(page.getByText('...', { exact: false }).first()).toBeVisible();
Set action to "assert_visible" for these steps.`
    : "";

  const userPrompt = `Convert these browser automation actions to Playwright code.
Current URL: ${currentUrl || "unknown"}
${objective ? `Original user objective: ${objective}` : ""}

Actions:
${JSON.stringify(sanitized, null, 2)}

Return ONLY a JSON object with this structure:
{
  "steps": [
    {
      "action": "type",
      "playwright": "await page.getByLabel('Email', { exact: false }).first().fill('user@example.com');",
      "description": "Enter email address into the Email field",
      "targetDescription": "Email",
      "value": "user@example.com"
    }
  ]
}

Rules:
- Skip "screenshot", "done", "think", and "ariaTree" actions entirely
- For "fillFormVision"/"fillForm" actions, create one step per field using the fields/playwrightArguments array
- For "click" actions, use the describe/description for the role/text locator
- For "act" actions (DOM mode semantic actions), determine if it's a click or type from the instruction text:
  -- If the instruction mentions typing/filling/entering, create a "type" action
  -- Otherwise create a "click" action using the instruction as targetDescription
- For "goto"/"navigate" actions, create a navigate step with page.goto(url)
- For "keys"/"press" actions, create a press step with page.keyboard.press(key)
- For "scroll" actions, create a scroll step with page.mouse.wheel(deltaX, deltaY)
- For "wait" actions, use page.waitForTimeout(ms)
- For "extract" actions, create assert_text steps for any extracted text values
- action must be one of: navigate, click, type, wait, press, scroll, assert_visible, assert_text
- For verification/assertion objectives, use: await expect(page.getByText('...', { exact: false }).first()).toBeVisible();
- targetDescription should be a short element label (e.g. "Email", "Password", "Log in")
- playwright must be a single executable Playwright code line${assertionHint}`;

  try {
    const provider = (modelConfig.provider || "openai").toLowerCase();
    const apiKey = modelConfig.apiKey;
    let modelName = modelConfig.model || "";
    if (modelName.includes("/")) {
      modelName = modelName.split("/").slice(1).join("/");
    }

    let responseText;

    if (provider === "anthropic") {
      modelName = modelName || "claude-sonnet-4-5-20250929";
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 4096,
          temperature: 0,
          system: ACTION_CONVERTER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      responseText = data.content?.[0]?.text || "";
    } else {
      modelName = modelName || "gpt-4o";
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: ACTION_CONVERTER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`OpenAI API ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      responseText = data.choices?.[0]?.message?.content || "";
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in LLM response");
    const parsed = JSON.parse(jsonMatch[0]);
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (steps.length === 0) throw new Error("LLM returned empty steps");

    logInfo("ai_action_convert_success", { stepCount: steps.length });

    return steps.map((step) => ({
      type: step.action === "wait" ? "wait" : "act",
      action: step.action || "act",
      instruction: step.description || "",
      targetDescription: step.targetDescription || "",
      value: step.value || "",
      description: step.description || "",
      playwright: step.playwright || "",
      ...(step.action === "wait"
        ? { timeMs: parseInt(String(step.playwright || "").match(/\d+/)?.[0]) || 2000 }
        : {}),
    }));
  } catch (err) {
    logError("ai_action_convert_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return flattenStagehandAgentActions(rawActions);
  }
}

/**
 * Convert high-level Stagehand agent actions into concrete playwright-compatible
 * action objects. Handles all Stagehand v3 tool types:
 * DOM mode: act, fillForm, extract, goto, scroll, keys, screenshot, wait, done, think
 * Hybrid mode: click, type, dragAndDrop, clickAndHold, fillFormVision + DOM tools
 */
function flattenStagehandAgentActions(rawActions) {
  if (!Array.isArray(rawActions) || rawActions.length === 0) return rawActions;

  const hasConcrete = rawActions.some(
    (a) =>
      a &&
      typeof a === "object" &&
      Array.isArray(a.actions) &&
      a.actions.some((n) => n && (n.method || n.selector))
  );
  if (hasConcrete) return rawActions;

  const concrete = [];
  for (const action of rawActions) {
    if (!action || typeof action !== "object") continue;
    const type = String(action.type || "").toLowerCase();

    if (type === "screenshot" || type === "done" || type === "think" || type === "ariatree") continue;

    if (type === "fillformvision" || type === "fillform") {
      const pwArgs = Array.isArray(action.playwrightArguments)
        ? action.playwrightArguments
        : [];
      const fields = pwArgs.length > 0 ? pwArgs : Array.isArray(action.fields) ? action.fields : [];
      for (const field of fields) {
        if (!field || typeof field !== "object") continue;
        const desc = String(field.action || field.description || "").trim();
        const val = String(field.value || field.originalValue || "").trim();
        if (!val && !desc) continue;
        const escapedDesc = (desc || "field").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const escapedValue = val.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        concrete.push({
          type: "act",
          action: "type",
          instruction: desc,
          targetDescription: desc,
          value: val,
          description: desc,
          playwright: `await page.getByLabel('${escapedDesc}', { exact: false }).first().fill('${escapedValue}');`,
        });
      }
      continue;
    }

    if (type === "click") {
      const desc = String(
        action.describe || action.description || action.instruction || ""
      ).trim();
      if (!desc) continue;
      const escaped = desc.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      concrete.push({
        type: "act",
        action: "click",
        instruction: desc,
        targetDescription: desc,
        description: desc,
        playwright: `await page.getByRole('button', { name: '${escaped}', exact: false }).or(page.getByText('${escaped}', { exact: false })).first().click();`,
      });
      continue;
    }

    if (type === "act") {
      const instruction = String(action.instruction || action.action || action.describe || action.description || "").trim();
      if (!instruction) continue;
      const escaped = instruction.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const isType = /\b(type|fill|enter|input|write)\b/i.test(instruction);
      if (isType) {
        const valueMatch =
          instruction.match(/(?:type|fill|enter|input|write)\s+["'](.+?)["']\s/i) ||
          instruction.match(/["'](.+?)["']/);
        const value = valueMatch?.[1] || "";
        const targetMatch = instruction.match(/(?:into?|on)\s+(?:the\s+)?["']?(.+?)["']?\s*$/i);
        const target = targetMatch?.[1] || instruction;
        const escapedTarget = target.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        concrete.push({
          type: "act",
          action: "type",
          instruction,
          targetDescription: target,
          value,
          description: instruction,
          playwright:
            target && value
              ? `await page.getByLabel('${escapedTarget}', { exact: false }).first().fill('${escapedValue}');`
              : `// act: ${escaped}`,
        });
      } else {
        concrete.push({
          type: "act",
          action: "click",
          instruction,
          targetDescription: instruction,
          description: instruction,
          playwright: `await page.getByText('${escaped}', { exact: false }).first().click();`,
        });
      }
      continue;
    }

    if (type === "goto" || type === "navigate") {
      const url = String(action.url || action.instruction || "").trim();
      if (!url) continue;
      const escaped = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      concrete.push({
        type: "act",
        action: "navigate",
        url,
        description: `Navigate to ${url}`,
        playwright: `await page.goto('${escaped}');`,
      });
      continue;
    }

    if (type === "navback") {
      concrete.push({
        type: "act",
        action: "navigate",
        description: "Navigate back",
        playwright: "await page.goBack();",
      });
      continue;
    }

    if (type === "keys" || type === "press") {
      const key = String(action.keys || action.key || action.instruction || "").trim();
      if (!key) continue;
      const escaped = key.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      concrete.push({
        type: "act",
        action: "press",
        key,
        description: `Press ${key}`,
        playwright: `await page.keyboard.press('${escaped}');`,
      });
      continue;
    }

    if (type === "scroll") {
      const direction = String(action.direction || "down").trim().toLowerCase();
      const pixels = Number(action.pixels || action.scrolledPixels || 300);
      const deltaX = direction.includes("left") ? -pixels : direction.includes("right") ? pixels : 0;
      const deltaY = direction.includes("up") ? -pixels : pixels;
      concrete.push({
        type: "act",
        action: "scroll",
        description: `Scroll ${direction}`,
        playwright: `await page.mouse.wheel(${deltaX}, ${deltaY});`,
      });
      continue;
    }

    if (type === "wait") {
      const ms = Number(action.timeMs || action.waited || 0);
      if (ms > 0) {
        concrete.push({
          type: "wait",
          action: "wait",
          timeMs: ms,
          playwright: `await page.waitForTimeout(${ms});`,
        });
      }
      continue;
    }

    if (type === "type" || type === "fill") {
      const val = String(action.value || action.text || "").trim();
      const sel = String(action.selector || "").trim();
      const desc = String(
        action.describe || action.description || action.instruction || ""
      ).trim();
      const escapedDesc = (desc || "field").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const escapedValue = val.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      concrete.push({
        type: "act",
        action: "type",
        instruction: desc,
        targetDescription: desc,
        selector: sel,
        value: val,
        description: desc,
        playwright: sel
          ? `await page.locator('${sel.replace(/'/g, "\\'")}').first().fill('${escapedValue}');`
          : `await page.getByLabel('${escapedDesc}', { exact: false }).first().fill('${escapedValue}');`,
      });
      continue;
    }

    if (type === "extract") {
      continue;
    }

    if (type === "draganddrop" || type === "drag") {
      const startDesc = String(action.startDescribe || action.startDescription || "source").trim();
      const endDesc = String(action.endDescribe || action.endDescription || "target").trim();
      const escapedStart = startDesc.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const escapedEnd = endDesc.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      concrete.push({
        type: "act",
        action: "drag",
        startSelector: startDesc,
        endSelector: endDesc,
        description: `Drag ${startDesc} to ${endDesc}`,
        playwright: `await page.getByText('${escapedStart}', { exact: false }).first().dragTo(page.getByText('${escapedEnd}', { exact: false }).first());`,
      });
      continue;
    }

    if (action.type || action.action) {
      const desc = String(action.describe || action.description || action.instruction || "").trim();
      const val = String(action.value || action.text || "").trim();
      if (desc || val) {
        concrete.push({
          ...action,
          targetDescription: desc || action.targetDescription,
          value: val || action.value,
        });
      }
    }
  }
  return concrete.length > 0 ? concrete : rawActions;
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

function createResilientAgent(agent, logs) {
  if (!agent || typeof agent !== "object") return agent;
  const originalAct = typeof agent.act === "function" ? agent.act.bind(agent) : null;
  if (!originalAct) return agent;

  return new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop !== "act") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args) => {
        try {
          return await originalAct(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const firstArg = args[0];
          const canRetryWithoutXPath =
            firstArg &&
            typeof firstArg === "object" &&
            (Object.prototype.hasOwnProperty.call(firstArg, "xPath") ||
              Object.prototype.hasOwnProperty.call(firstArg, "xpath")) &&
            /xPath|xpath/i.test(message);
          if (!canRetryWithoutXPath) throw err;

          const payload = { ...firstArg };
          delete payload.xPath;
          delete payload.xpath;
          delete payload.targetXPath;
          delete payload.targetXpath;

          logs.push({
            level: "warn",
            message: "Stagehand act selector failed; retrying without xPath hint.",
            ts: new Date().toISOString(),
          });
          return originalAct(payload, ...args.slice(1));
        }
      };
    },
  });
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
    const agent = session.stagehand.agent({
      mode: session.agentMode || DEFAULT_STAGEHAND_AGENT_MODE,
      systemPrompt: session.agentSystemPrompt || STABLE_LOCATOR_SYSTEM_PROMPT,
    });
    const resilientAgent = createResilientAgent(agent, logs);
    const assert = (condition, message = "Assertion failed") => {
      if (!condition) throw new Error(message);
    };
    const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
    const fn = new AsyncFunction("stagehand", "page", "agent", "z", "assert", sanitizedScript);
    await fn(session.stagehand, page, resilientAgent, z, assert);

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
