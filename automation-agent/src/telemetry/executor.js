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
const LOGIN_INTENT_RE = /\b(login|log in|sign in|authenticate|credential|email|password|username)\b/i;

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

function hasScrollIntent(instruction) {
  return /\b(scroll|swipe)\b/i.test(String(instruction || ""));
}

function normalizeCredentialValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const cleaned = text.replace(/^["']|["']$/g, "").trim();
  if (/^<\s*unknown\s*>$/i.test(cleaned)) return "";
  if (/^(unknown|null|undefined|n\/a|na)$/i.test(cleaned)) return "";
  return cleaned;
}

function extractCredentialsFromScenario(scenario) {
  const text = String(scenario || "").replace(/\r/g, "");
  const out = { email: "", password: "", username: "" };
  if (!text.trim()) return out;

  const byLabel = (labelPattern) => {
    const m = text.match(labelPattern);
    return normalizeCredentialValue(m?.[1]);
  };

  out.email =
    byLabel(/(?:^|\n)\s*email\s*[:=]\s*([^\n,]+)/i) ||
    byLabel(/(?:^|\n)\s*(?:login\s*email|user\s*email)\s*[:=]\s*([^\n,]+)/i);
  out.password =
    byLabel(/(?:^|\n)\s*password\s*[:=]\s*([^\n,]+)/i) ||
    byLabel(/(?:^|\n)\s*pass(?:word)?\s*[:=]\s*([^\n,]+)/i);
  out.username =
    byLabel(/(?:^|\n)\s*username\s*[:=]\s*([^\n,]+)/i) ||
    byLabel(/(?:^|\n)\s*user\s*name\s*[:=]\s*([^\n,]+)/i);

  // Parse inline credential block such as: "Email: a@b.com, Password: secret"
  if (!out.email || !out.password) {
    const inline = text.match(/email\s*[:=]\s*([^,\n]+)\s*,\s*password\s*[:=]\s*([^\n]+)/i);
    if (inline) {
      if (!out.email) out.email = normalizeCredentialValue(inline[1]);
      if (!out.password) out.password = normalizeCredentialValue(inline[2]);
    }
  }

  return out;
}

function hasLoginIntent(instruction) {
  return LOGIN_INTENT_RE.test(String(instruction || ""));
}

function enrichInstructionWithCredentials(instruction, credentials = {}) {
  const base = String(instruction || "").trim();
  if (!base) return base;
  if (!hasLoginIntent(base)) return base;
  const email = normalizeCredentialValue(credentials.email);
  const password = normalizeCredentialValue(credentials.password);
  const username = normalizeCredentialValue(credentials.username);
  if (!email && !password && !username) return base;
  const parts = [];
  if (email) parts.push(`Email="${email}"`);
  if (username) parts.push(`Username="${username}"`);
  if (password) parts.push(`Password="${password}"`);
  return `${base}. Use exact credentials: ${parts.join(", ")}.`;
}

function sanitizeCandidateForAct(candidate, credentials = {}) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const method = String(candidate.method || "").toLowerCase();
  if (method !== "fill" && method !== "type") return candidate;
  const desc = String(candidate.description || "").toLowerCase();
  const args = Array.isArray(candidate.arguments) ? [...candidate.arguments] : [];
  const firstArg = normalizeCredentialValue(args[0]);
  if (firstArg) return candidate;

  const email = normalizeCredentialValue(credentials.email);
  const username = normalizeCredentialValue(credentials.username);
  const password = normalizeCredentialValue(credentials.password);

  let replacement = "";
  if (/\bpassword|passcode|otp|pin\b/i.test(desc)) replacement = password;
  else if (/\bemail|e-mail\b/i.test(desc)) replacement = email;
  else if (/\buser(name)?|login\b/i.test(desc)) replacement = username || email;

  if (!replacement) return candidate;
  return { ...candidate, arguments: [replacement] };
}

function scoreCandidateForInstruction(candidate, instruction) {
  const method = String(candidate?.method || "").toLowerCase();
  const explicitScroll = hasScrollIntent(instruction);
  let score = 0;

  if (!method) return -1;
  if (method === "scroll" || method === "scrollto") {
    return explicitScroll ? 3 : -5;
  }

  if (/\b(type|fill|enter|input|write)\b/i.test(instruction) && (method === "fill" || method === "type")) {
    score += 8;
  }
  if (/\b(click|tap|press|select|choose|open)\b/i.test(instruction) && (method === "click" || method === "dblclick" || method === "check" || method === "uncheck")) {
    score += 7;
  }
  if (/\b(navigate|go to|visit|open url)\b/i.test(instruction) && (method === "goto" || method === "navigate")) {
    score += 8;
  }
  if (/\b(wait)\b/i.test(instruction) && method === "wait") {
    score += 6;
  }

  // Generic positive baseline for non-scroll actionable methods.
  score += 2;
  return score;
}

/**
 * Pick the best observe() candidate for the current instruction.
 * Returns { index: -1 } when direct stagehand.act(instruction) is safer.
 */
export function selectObservedCandidate(candidates, instruction) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { index: -1, reason: "observe_returned_empty" };
  }

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const score = scoreCandidateForInstruction(candidates[i], instruction);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex < 0 || bestScore <= 0) {
    return { index: -1, reason: "only_non_actionable_candidates" };
  }
  return { index: bestIndex, reason: bestIndex === 0 ? "best_candidate_first" : "best_candidate_ranked" };
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
  const { stagehand, page, runId, modelConfig, credentials } = ctx;
  const effectiveInstruction = enrichInstructionWithCredentials(instruction, credentials);
  const url = page.url();
  const modelOpt = modelConfig?.apiKey
    ? { model: { modelName: modelConfig.model || "openai/gpt-4o", apiKey: modelConfig.apiKey } }
    : {};

  if (isAssertionStep(effectiveInstruction)) {
    return executeExtractStep(ctx, stepId, effectiveInstruction, events);
  }

  // Action step: observe first, then act
  const observeStart = Date.now();
  let candidates = [];
  try {
    candidates = await stagehand.observe(effectiveInstruction, { ...modelOpt, timeout: 15000 });
  } catch (err) {
    logError("telemetry_observe_failed", { runId, stepId, instruction: effectiveInstruction, error: String(err) });
    events.push({
      runId,
      stepId,
      timestamp: nowIso(),
      url,
      eventType: "observe",
      instruction: effectiveInstruction,
      candidates: [],
      chosenIndex: -1,
      chosenReason: "observe_failed",
      elapsedMs: Date.now() - observeStart,
    });
    // Fallback: try act directly
  }

  const candidateChoice = selectObservedCandidate(candidates, effectiveInstruction);
  const chosenIndex = candidateChoice.index;
  const chosenReason = candidateChoice.reason;

  events.push({
    runId,
    stepId,
    timestamp: nowIso(),
    url,
    eventType: "observe",
    instruction: effectiveInstruction,
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
  const actAttempts = [];

  while (retryCount <= maxRetries) {
    try {
      if (candidates.length > 0 && chosenIndex >= 0) {
        const chosen = sanitizeCandidateForAct(candidates[chosenIndex], credentials);
        actAttempts.push({
          attempt: retryCount + 1,
          inputType: "candidate",
          input: {
            selector: chosen?.selector || "",
            description: chosen?.description || "",
            method: chosen?.method || "",
            arguments: Array.isArray(chosen?.arguments) ? chosen.arguments : [],
          },
        });
        actResult = await stagehand.act(chosen, { ...modelOpt, timeout: 20000 });
      } else {
        actAttempts.push({
          attempt: retryCount + 1,
          inputType: "instruction",
          input: String(effectiveInstruction || ""),
        });
        actResult = await stagehand.act(effectiveInstruction, { ...modelOpt, timeout: 20000 });
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
            instruction: effectiveInstruction,
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
          instruction: effectiveInstruction,
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
          actAttempts,
        });
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      await new Promise((r) => setTimeout(r, 1000 * retryCount));
    }
  }

  // Brief pause after act to let the page settle (especially after form submissions / navigation).
  await new Promise((r) => setTimeout(r, 600));

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

  // Post-login guard: if the instruction was login-related and the URL did not
  // change after the action, treat this as a login failure so subsequent steps
  // don't run against the login page.
  const isLoginStep = hasLoginIntent(effectiveInstruction);
  if (isLoginStep && urlAfter === urlBefore) {
    const loginFailMsg = "Login step did not navigate away from login page — credentials may not have been applied correctly.";
    logError("telemetry_login_no_navigation", { runId, stepId, url: urlBefore, instruction: effectiveInstruction });
    events.push({
      runId,
      stepId,
      timestamp: nowIso(),
      url,
      eventType: "act",
      instruction: effectiveInstruction,
      success: false,
      message: loginFailMsg,
      actionDescription: loginFailMsg,
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
      actAttempts,
    });
    return { success: false, error: loginFailMsg };
  }

  events.push({
    runId,
    stepId,
    timestamp: nowIso(),
    url,
    eventType: "act",
    instruction: effectiveInstruction,
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
    actAttempts,
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
  const sectionHeaderRe = /^\s{0,3}(?:#{1,6}\s+.+|[A-Za-z][A-Za-z0-9 _-]{1,80}:\s*)$/;
  const stepSectionStartRe =
    /^\s{0,3}(?:#{1,6}\s*)?(?:steps?\s+to\s+execute|expected\s+steps?|test\s+steps?)\b/i;
  const stepSectionStopRe =
    /^\s{0,3}(?:#{1,6}\s*)?(?:completion\s+checklist|execution\s+guidelines|critical\b|goal\s+completion|objective|intent|description|preconditions|test\s+data|credentials)\b/i;
  const looksLikeGuideline = (value) =>
    /^(do not|don't|never|always|first[, ]|then[, ]|adapt to|cross-reference|only set|login is|generate meaningful|handle loading)/i.test(value);

  let inStepSection = false;
  let hasExplicitStepSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("```")) continue;
    if (stepSectionStartRe.test(line)) {
      hasExplicitStepSection = true;
      inStepSection = true;
      continue;
    }
    if (inStepSection && stepSectionStopRe.test(line)) {
      inStepSection = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("```")) continue;

    if (hasExplicitStepSection) {
      if (stepSectionStartRe.test(line)) {
        inStepSection = true;
        continue;
      }
      if (inStepSection && stepSectionStopRe.test(line)) {
        inStepSection = false;
        continue;
      }
      if (!inStepSection) continue;
    } else if (line.startsWith("#")) {
      // Without a dedicated step section, skip markdown headers and rely on list-like items.
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    const bulleted = line.match(/^[-*•]\s+\[.\]\s*(.+)$/) || line.match(/^[-*•]\s+(.+)$/);
    const extracted = numbered?.[1] || bulleted?.[1] || (!hasExplicitStepSection && line.length > 5 ? line : null);

    if (extracted && extracted.length > 3) {
      let cleaned = extracted
        .replace(/\s*->\s*Expect:.*$/i, "")
        .replace(/\s*\(.*\)\s*$/, "")
        .replace(/^Step\s+\d+:\s*/i, "")
        .trim();
      if (
        cleaned &&
        !/^(and|then|also)\s+/i.test(cleaned) &&
        cleaned.length > 4 &&
        !looksLikeGuideline(cleaned) &&
        !sectionHeaderRe.test(cleaned)
      ) {
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
  const credentials = extractCredentialsFromScenario(scenario);

  const plan = options.plan || planScenario(scenario);
  const events = [];
  const results = [];
  const stagehandActions = [];

  logInfo("telemetry_executor_start", { runId, stepCount: plan.length });

  for (const { stepId, instruction } of plan) {
    const stepResult = await executeStep(
      { stagehand, page, runId, modelConfig, credentials },
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
