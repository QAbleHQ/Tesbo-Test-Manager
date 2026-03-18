/**
 * Telemetry executor.
 * Provides scenario planning and step execution utilities.
 * The LLM-based execution (DOM snapshot + LLM reasoning + Playwright action)
 * is handled by langchainAgent.js; this module provides planScenario() and
 * supporting helpers.
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
    byLabel(/(?:^|\n)\s*-?\s*email\s*[:=]\s*([^\n,]+)/i) ||
    byLabel(/(?:^|\n)\s*-?\s*(?:login\s*email|user\s*email)\s*[:=]\s*([^\n,]+)/i);
  out.password =
    byLabel(/(?:^|\n)\s*-?\s*password\s*[:=]\s*([^\n,]+)/i) ||
    byLabel(/(?:^|\n)\s*-?\s*pass(?:word)?\s*[:=]\s*([^\n,]+)/i);
  out.username =
    byLabel(/(?:^|\n)\s*-?\s*username\s*[:=]\s*([^\n,]+)/i) ||
    byLabel(/(?:^|\n)\s*-?\s*user\s*name\s*[:=]\s*([^\n,]+)/i);

  // Parse inline credential block such as: "Email: a@b.com, Password: secret"
  if (!out.email || !out.password) {
    const inline = text.match(/email\s*[:=]\s*([^,\n]+)\s*,\s*password\s*[:=]\s*([^\n]+)/i);
    if (inline) {
      if (!out.email) out.email = normalizeCredentialValue(inline[1]);
      if (!out.password) out.password = normalizeCredentialValue(inline[2]);
    }
  }

  // Try JSON blocks in the text: {"email": "x", "password": "y"}
  if (!out.email && !out.password) {
    const jsonMatch = text.match(/\{[^{}]*"(?:email|password|username)"[^{}]*\}/i);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const [key, value] of Object.entries(parsed)) {
          const k = String(key).toLowerCase();
          const v = normalizeCredentialValue(value);
          if (!v) continue;
          if (k.includes("password") || k === "pass") { if (!out.password) out.password = v; }
          else if (k.includes("email") || k === "login") { if (!out.email) out.email = v; }
          else if (k.includes("username") || k === "user") { if (!out.username) out.username = v; }
        }
      } catch {
        // not valid JSON
      }
    }
  }

  // Slash-separated fallback: email@domain / password
  if (!out.email && !out.password) {
    const slashMatch = text.match(/([^\s/]+@[^\s/]+)\s*\/\s*([^\s\n]+)/);
    if (slashMatch) {
      out.email = normalizeCredentialValue(slashMatch[1]);
      out.password = normalizeCredentialValue(slashMatch[2]);
    }
  }

  return out;
}

function hasLoginIntent(instruction) {
  return LOGIN_INTENT_RE.test(String(instruction || ""));
}

/** True only when the step is a full login submission (fill + submit), not just filling one field. */
function isLoginSubmitStep(instruction) {
  const text = String(instruction || "").toLowerCase();
  // Must have login intent AND a submission/click verb
  const hasSubmit = /\b(click|press|submit|log in|sign in|tap)\b/.test(text);
  const hasCredentialFill = /\b(login|log in|sign in|authenticate|credential)\b/.test(text) ||
    (/\b(email|username)\b/.test(text) && /\bpassword\b/.test(text));
  return hasSubmit && hasCredentialFill;
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
 * Returns { index: -1 } when direct LLM-driven action is more appropriate.
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

// Note: Step execution (observe → act → extract) is now handled by langchainAgent.js
// using DOM snapshots + LLM reasoning + direct Playwright actions.
// The executeStep / executeExtractStep functions have been removed.

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
    /^\s{0,3}(?:#{1,6}\s*)?(?:completion\s+checklist|execution\s+guidelines|critical\b|goal\s+completion|test\s+data|execution\s+requirements|critical\s*-\s*login|user\s+feedback)\b/i;
  const looksLikeGuideline = (value) =>
    /^(do not|don't|never|always|first[, ]|then[, ]|adapt to|cross-reference|only set|login is|generate meaningful|handle loading|perform multi.?step|complete login|use provided|validate outcomes|avoid unnecessary)/i.test(value);

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

  // If an explicit step section was found but yielded 0 steps, try parsing
  // JSON arrays that might be inline (e.g., [{"action":"Enter email",...}])
  if (steps.length === 0 && hasExplicitStepSection) {
    const jsonMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (jsonMatch) {
      try {
        const arr = JSON.parse(jsonMatch[0]);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const action = String(item?.action || item?.instruction || item?.step || "").trim();
            if (action && action.length > 3) {
              steps.push({ stepId: `step-${steps.length + 1}`, instruction: action });
            }
          }
        }
      } catch {
        // not valid JSON, ignore
      }
    }
  }

  if (steps.length === 0 && !hasExplicitStepSection && text.length > 15) {
    steps.push({ stepId: "step-1", instruction: text.slice(0, 500) });
  }

  return steps;
}

// Note: executeScenarioWithTelemetry has been replaced by
// executeAgentWithTelemetry in langchainAgent.js.
