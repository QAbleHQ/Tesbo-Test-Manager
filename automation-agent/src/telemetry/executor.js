/**
 * Stagehand executor wrapper.
 * For each step: observe() → act() or extract()
 * Records structured telemetry for every decision and action.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";
import { logError, logInfo } from "../logger.js";

const ASSERTION_INTENT_RE = /\b(verify|assert|check|confirm|ensure|validate|extract|get|read)\b/i;

/** True when act() failed due to schema validation (LLM returned "element not found" with empty elementId/method). */
function isSchemaValidationError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /elementId|element\s*id/i.test(msg) ||
    /ZodError|AI_TypeValidationError|TypeValidationError/i.test(msg) ||
    /must match|required|regex|format/i.test(msg)
  );
}

function isAssertionStep(instruction) {
  return ASSERTION_INTENT_RE.test(instruction);
}

function nowIso() {
  return new Date().toISOString();
}

async function takeScreenshot(page, runId, prefix) {
  const dir = path.join(config.screenshotDir, "telemetry");
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${runId}-${prefix}-${Date.now()}.png`;
  const outputPath = path.join(dir, fileName);
  try {
    await page.screenshot({ path: outputPath, fullPage: false });
    return outputPath;
  } catch (err) {
    logError("telemetry_screenshot_failed", { runId, prefix, error: String(err) });
    return null;
  }
}

/**
 * Execute a single atomic step using observe → act or extract.
 * @param {object} ctx - { stagehand, page, runId, modelConfig }
 * @param {string} stepId - Step identifier
 * @param {string} instruction - Atomic instruction
 * @param {object} events - Array to push telemetry events
 * @returns {Promise<{ success: boolean, result?: object, error?: string }>}
 */
export async function executeStep(ctx, stepId, instruction, events) {
  const { stagehand, page, runId, modelConfig } = ctx;
  const url = page.url();
  const modelOpt = modelConfig?.apiKey
    ? { model: { modelName: modelConfig.model || "openai/gpt-4o", apiKey: modelConfig.apiKey } }
    : {};

  if (isAssertionStep(instruction)) {
    return executeExtractStep(ctx, stepId, instruction, events);
  }

  // Action step: observe first, then act
  const observeStart = Date.now();
  let candidates = [];
  try {
    candidates = await stagehand.observe(instruction, { ...modelOpt, timeout: 15000 });
  } catch (err) {
    logError("telemetry_observe_failed", { runId, stepId, instruction, error: String(err) });
    events.push({
      runId,
      stepId,
      timestamp: nowIso(),
      url,
      eventType: "observe",
      instruction,
      candidates: [],
      chosenIndex: -1,
      chosenReason: "observe_failed",
      elapsedMs: Date.now() - observeStart,
    });
    // Fallback: try act directly
  }

  const chosenIndex = candidates.length > 0 ? 0 : -1;
  const chosenReason = candidates.length > 0 ? "first_candidate" : "observe_returned_empty";

  events.push({
    runId,
    stepId,
    timestamp: nowIso(),
    url,
    eventType: "observe",
    instruction,
    candidates: candidates.map((c) => ({
      selector: c.selector || "",
      description: c.description || "",
      method: c.method,
      arguments: c.arguments || [],
    })),
    chosenIndex,
    chosenReason,
    elapsedMs: Date.now() - observeStart,
  });

  const screenshotBefore = await takeScreenshot(page, runId, `step-${stepId}-before`);
  const urlBefore = page.url();
  const titleBefore = await page.title().catch(() => "");

  let actResult;
  let retryCount = 0;
  const maxRetries = 2;

  while (retryCount <= maxRetries) {
    try {
      if (candidates.length > 0 && chosenIndex >= 0) {
        const chosen = candidates[chosenIndex];
        actResult = await stagehand.act(chosen, { ...modelOpt, timeout: 20000 });
      } else {
        actResult = await stagehand.act(instruction, { ...modelOpt, timeout: 20000 });
      }
      break;
    } catch (err) {
      retryCount++;
      const isSchemaErr = isSchemaValidationError(err);
      if (isSchemaErr || retryCount > maxRetries) {
        if (isSchemaErr) {
          logInfo("telemetry_act_schema_validation_skip", {
            runId,
            stepId,
            instruction,
            reason: "element not found or invalid format; skipping retries",
          });
        }
        const elapsedMs = Date.now() - observeStart;
        events.push({
          runId,
          stepId,
          timestamp: nowIso(),
          url,
          eventType: "act",
          instruction,
          success: false,
          message: err instanceof Error ? err.message : String(err),
          actions: [],
          urlBefore,
          urlAfter: page.url(),
          titleBefore,
          titleAfter: await page.title().catch(() => ""),
          screenshotBefore,
          screenshotAfter: await takeScreenshot(page, runId, `step-${stepId}-after-fail`),
          elapsedMs,
          retryCount,
          failureReason: err instanceof Error ? err.message : String(err),
        });
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      await new Promise((r) => setTimeout(r, 1000 * retryCount));
    }
  }

  const screenshotAfter = await takeScreenshot(page, runId, `step-${stepId}-after`);
  const urlAfter = page.url();
  const titleAfter = await page.title().catch(() => "");

  const actions = Array.isArray(actResult?.actions)
    ? actResult.actions.map((a) => ({
        selector: a.selector || "",
        description: a.description || "",
        method: a.method,
        arguments: a.arguments || [],
      }))
    : [];

  events.push({
    runId,
    stepId,
    timestamp: nowIso(),
    url,
    eventType: "act",
    instruction,
    success: Boolean(actResult?.success),
    message: actResult?.message,
    actionDescription: actResult?.actionDescription,
    actions,
    urlBefore,
    urlAfter,
    titleBefore,
    titleAfter,
    screenshotBefore,
    screenshotAfter,
    elapsedMs: Date.now() - observeStart,
    cacheStatus: actResult?.cacheStatus,
    retryCount,
  });

  return {
    success: Boolean(actResult?.success),
    result: actResult,
    actions,
  };
}

/**
 * Execute an assertion/verification step using extract.
 */
async function executeExtractStep(ctx, stepId, instruction, events) {
  const { stagehand, page, runId, modelConfig } = ctx;
  const url = page.url();
  const modelOpt = modelConfig?.apiKey
    ? { model: { modelName: modelConfig.model || "openai/gpt-4o", apiKey: modelConfig.apiKey } }
    : {};

  const start = Date.now();
  let result = {};
  let success = false;

  try {
    const extracted = await stagehand.extract(instruction, { ...modelOpt, timeout: 15000 });
    result = typeof extracted === "object" && extracted !== null ? extracted : { extraction: String(extracted) };
    success = true;
  } catch (err) {
    logError("telemetry_extract_failed", { runId, stepId, instruction, error: String(err) });
  }

  events.push({
    runId,
    stepId,
    timestamp: nowIso(),
    url,
    eventType: "extract",
    instruction,
    result,
    usage: "assertion",
    elapsedMs: Date.now() - start,
  });

  return {
    success,
    result,
  };
}

/**
 * Break a scenario into atomic steps.
 * Parses "### Steps to Execute" format and numbered/bulleted lists.
 */
export function planScenario(scenario) {
  const text = String(scenario || "").trim();
  if (!text) return [];

  const steps = [];
  const lines = text.split(/\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    const bulleted = line.match(/^[-*•]\s+\[.\]\s*(.+)$/) || line.match(/^[-*•]\s+(.+)$/);
    const extracted = numbered?.[1] || bulleted?.[1] || (line.length > 5 ? line : null);

    if (extracted && extracted.length > 3) {
      let cleaned = extracted
        .replace(/\s*->\s*Expect:.*$/i, "")
        .replace(/\s*\(.*\)\s*$/, "")
        .replace(/^Step\s+\d+:\s*/i, "")
        .trim();
      if (cleaned && !/^(and|then|also)\s+/i.test(cleaned) && cleaned.length > 4) {
        steps.push({ stepId: `step-${steps.length + 1}`, instruction: cleaned });
      }
    }
  }

  if (steps.length === 0 && text.length > 15) {
    steps.push({ stepId: "step-1", instruction: text.slice(0, 500) });
  }

  return steps;
}

/**
 * Execute a full scenario using observe → act → extract per step.
 * @param {object} session - Stagehand session from createStagehandSession
 * @param {string} scenario - Natural language scenario
 * @param {object} options - { runId, usePlanner }
 * @returns {Promise<{ success: boolean, events: object[], results: object[], stagehandActions: object[] }>}
 */
export async function executeScenarioWithTelemetry(session, scenario, options = {}) {
  const runId = options.runId || randomUUID();
  const { stagehand, page, modelConfig } = session;

  const plan = options.plan || planScenario(scenario);
  const events = [];
  const results = [];
  const stagehandActions = [];

  logInfo("telemetry_executor_start", { runId, stepCount: plan.length });

  for (const { stepId, instruction } of plan) {
    const stepResult = await executeStep(
      { stagehand, page, runId, modelConfig },
      stepId,
      instruction,
      events
    );

    results.push({ stepId, instruction, ...stepResult });

    if (stepResult.actions?.length) {
      for (const a of stepResult.actions) {
        stagehandActions.push({
          type: "act",
          action: (a.method || "click").toLowerCase(),
          selector: a.selector,
          targetDescription: a.description,
          description: a.description,
          playwright: null,
        });
      }
    }

    if (!stepResult.success && !options.continueOnFailure) {
      break;
    }
  }

  logInfo("telemetry_executor_complete", {
    runId,
    eventCount: events.length,
    actionCount: stagehandActions.length,
  });

  return {
    success: results.every((r) => r.success),
    events,
    results,
    stagehandActions,
    runId,
  };
}
