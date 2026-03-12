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
  const stagehandConfig = {
    env: useBrowserbase ? "BROWSERBASE" : "LOCAL",
    experimental: true,
    disableAPI: true,
    cacheDir,
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
      const describe = String(args?.describe || args?.instruction || "").trim();
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

  const plan = planScenario(objective);
  if (plan.length === 0) {
    return executeStagehandObjective(session, commandId, objective);
  }

  try {
    const { success, events, stagehandActions: rawActions, results } = await executeScenarioWithTelemetry(
      session,
      objective,
      { plan, continueOnFailure: true }
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

    logInfo("stagehand_telemetry_complete", {
      sessionId: session.id,
      eventCount: events.length,
      actionCount: compiledActions.length,
    });

    return {
      commandId,
      currentUrl: session.currentUrl,
      results: stepResults,
      stagehandActions: compiledActions,
      telemetryEvents: events,
      completed: success,
    };
  } catch (err) {
    logError("stagehand_telemetry_failed", { sessionId: session.id, error: String(err) });
    return executeStagehandObjective(session, commandId, objective);
  }
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
            const toolCalls = event.toolCalls || [];
            const toolResults = event.toolResults || [];
            for (const tc of toolCalls) {
              const matchingResult = toolResults.find(
                (tr) => tr.toolCallId === tc.toolCallId
              );
              capturedToolCalls.push({
                toolName: tc.toolName,
                args: tc.args || {},
                result: matchingResult?.result ?? null,
              });
            }
          } catch {
            // non-fatal: don't break agent execution
          }
        },
      },
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

    // Primary path: convert captured tool calls directly (most reliable)
    let normalizedActions = [];
    if (capturedToolCalls.length > 0) {
      normalizedActions = convertToolCallsToActions(capturedToolCalls, session.currentUrl);
      if (normalizedActions.length > 0) {
        logInfo("stagehand_actions_from_tool_calls", {
          sessionId: session.id,
          actionCount: normalizedActions.length,
          toolCallCount: capturedToolCalls.length,
        });
      }
    }

    // Fallback: LLM-based conversion from result.actions
    if (normalizedActions.length === 0) {
      const rawSteps = result?.steps ?? result?.actions ?? [];
      const rawStepsFiltered = Array.isArray(rawSteps)
        ? rawSteps.filter((s) => s && typeof s === "object")
        : [];
      logInfo("stagehand_fallback_to_ai_convert", {
        sessionId: session.id,
        rawStepCount: rawStepsFiltered.length,
        capturedToolCallCount: capturedToolCalls.length,
      });
      normalizedActions = await convertActionsWithAI(
        rawStepsFiltered,
        session.currentUrl,
        session.modelConfig,
        objective
      );
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
