import {
  getTestCase,
  getProject,
  getAgentSettings,
  getStoredAgentTasks,
  upsertAgentTask,
  startAutomationSession,
  sendAutomationCommand,
  getAutomationSession,
  finalizeAutomationSession,
  runAutomationPlaywrightScript,
  reviewAutomationScriptWithAi,
  cancelAutomationSession,
  type AgentTask,
  type AgentTaskQueueSource,
  type AutomationSession,
  type BotReviewResult,
  type TestEnvironmentSetting,
} from "@/lib/api";

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isPassedStatus(value: unknown): boolean {
  const n = asText(value).toLowerCase();
  return n === "passed" || n === "success";
}

function parseProjectSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTestRunEnvironments(raw: unknown): TestEnvironmentSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const candidate = item as { name?: unknown; url?: unknown };
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
      if (!name || !url) return null;
      return { name, url };
    })
    .filter((item): item is TestEnvironmentSetting => item !== null);
}

function parseTestCaseSteps(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((step) => {
        const s = step as { action?: unknown; expectedResult?: unknown };
        const action = typeof s.action === "string" ? s.action.trim() : "";
        const expected = typeof s.expectedResult === "string" ? s.expectedResult.trim() : "";
        if (!action && !expected) return "";
        if (action && expected) return `${action} -> Expect: ${expected}`;
        return action || `Expect: ${expected}`;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractCredentialEntries(rawTestData: string): Array<{ key: string; value: string }> {
  const text = rawTestData.trim();
  if (!text) return [];
  const out: Array<{ key: string; value: string }> = [];
  const pushIfCredential = (keyRaw: unknown, valueRaw: unknown) => {
    const key = String(keyRaw ?? "").trim();
    const value = String(valueRaw ?? "").trim();
    if (!key || !value) return;
    if (!/(user(name)?|email|login|password|pass(word)?|otp|token|pin)/i.test(key)) return;
    if (/^(none|null|undefined)$/i.test(value)) return;
    out.push({ key, value });
  };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          pushIfCredential(k, v);
        }
      }
    }
  } catch {
    // Non-JSON test data is handled below.
  }

  if (out.length > 0) return out;

  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.split(/[:=]/);
    if (kv.length < 2) continue;
    const key = kv[0].trim();
    const value = kv.slice(1).join(":").trim();
    pushIfCredential(key, value);
  }

  const dedup = new Map<string, string>();
  for (const item of out) {
    dedup.set(item.key.toLowerCase(), item.value);
  }
  return Array.from(dedup.entries()).map(([k, v]) => ({ key: k, value: v }));
}

export function buildIntentObjective(tc: Record<string, unknown>, reviewerFeedback?: string[], previousScript?: string | null): string {
  const title = asText(tc.title).trim() || "Untitled test case";
  const description = asText(tc.description).trim();
  const preconditions = asText(tc.preconditions).trim();
  const testData = asText(tc.testData).trim();
  const credentialEntries = extractCredentialEntries(testData);
  const priority = asText(tc.priority).trim();
  const type = asText(tc.type).trim();
  const steps = parseTestCaseSteps(tc.steps);
  const lines: string[] = [];
  const isRevision = reviewerFeedback && reviewerFeedback.length > 0;

  lines.push(`## Test Case: "${title}"`);
  if (type || priority) {
    const meta: string[] = [];
    if (type) meta.push(`Type: ${type}`);
    if (priority) meta.push(`Priority: ${priority}`);
    if (isRevision) meta.push("REVISION RUN");
    lines.push(`[${meta.join(" | ")}]`);
  }
  lines.push("");

  if (isRevision) {
    lines.push("### REVISION REQUESTED");
    lines.push("A previous automation run for this test case was reviewed and the reviewer requested changes.");
    lines.push("You MUST address the feedback below. This is your top priority for this run.");
    lines.push("");
    lines.push("### Reviewer Feedback (address ALL of these)");
    reviewerFeedback.forEach((fb, idx) => lines.push(`${idx + 1}. ${fb}`));
    lines.push("");
    if (previousScript) {
      lines.push("### Previous Script (for reference — improve based on feedback above)");
      const scriptLines = previousScript.split("\n");
      const truncated = scriptLines.length > 30 ? scriptLines.slice(0, 30).join("\n") + "\n// ... (truncated)" : previousScript;
      lines.push("```");
      lines.push(truncated);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("### Objective");
  lines.push("You are a senior test automation engineer. Your goal is to understand the user's testing intent,");
  lines.push("explore the application like a real human would, and execute this test case end-to-end.");
  lines.push("You MUST complete ALL steps listed below — not just the first step (e.g., login).");
  lines.push("Login or authentication is only a prerequisite. The real test begins AFTER login.");
  if (isRevision) {
    lines.push("Pay special attention to the reviewer feedback above and make sure each point is addressed.");
  }
  lines.push("");

  if (description) {
    lines.push("### Intent & Description");
    lines.push(description);
    lines.push("");
  }

  if (preconditions) {
    lines.push("### Preconditions");
    lines.push(preconditions);
    lines.push("");
  }

  if (testData) {
    lines.push("### Test Data");
    lines.push(testData);
    lines.push("");
    if (credentialEntries.length > 0) {
      lines.push("### Credentials (EXACT VALUES ONLY)");
      for (const item of credentialEntries) {
        lines.push(`- ${item.key}: ${item.value}`);
      }
      lines.push("Use these exact credential values for authentication. Do NOT replace with placeholders.");
      lines.push("");
    }
    if (/@|credentials?|password|login/i.test(testData)) {
      lines.push("**CRITICAL:** For login forms, use the EXACT credentials from Test Data above. Never use placeholder values like user@example.com or password123.");
      lines.push("");
    }
  }

  if (steps.length > 0) {
    lines.push("### Steps to Execute (ALL steps are REQUIRED)");
    lines.push("You must complete every step below. Do NOT declare goal achieved until ALL steps are done.");
    steps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
    lines.push("");
    lines.push(`### Completion Checklist (${steps.length} steps total)`);
    lines.push("The goal is ONLY achieved when ALL of the following have been executed:");
    steps.forEach((step, idx) => lines.push(`- [ ] Step ${idx + 1}: ${step}`));
    lines.push("Do NOT set goalAchieved=true until every step above has been performed and verified.");
    lines.push("");
  }

  lines.push("### Execution Guidelines");
  lines.push("- Complete login FIRST with the exact credentials from Test Data. Only after login succeeds, proceed to post-login steps.");
  lines.push("- First, observe and understand the current page layout, navigation, and available controls.");
  lines.push("- Navigate the application naturally as a real user would — read labels, understand context, find the right elements.");
  lines.push("- If a step mentions a feature or page, explore the UI to locate it rather than guessing selectors.");
  lines.push("- Adapt to the actual DOM structure — if expected elements are not where anticipated, look for alternative paths.");
  lines.push("- Generate meaningful assertions that verify business outcomes, not just element presence.");
  lines.push("- When entering test data, use the EXACT values from the Test Data section above. Do NOT invent or substitute values.");
  lines.push("- Handle loading states, transitions, and dynamic content gracefully.");
  lines.push("");
  lines.push("### CRITICAL: Goal Completion Rules");
  lines.push("- Do NOT declare goalAchieved=true after only performing login/authentication.");
  lines.push("- Login is a prerequisite, NOT the objective. Continue with the remaining steps after login.");
  lines.push("- Cross-reference your execution history against the Steps list above.");
  lines.push("- Only set goalAchieved=true when you have evidence that ALL listed steps have been executed.");
  lines.push("- If the test case has N steps, you should have performed actions corresponding to all N steps.");
  if (steps.length > 0) {
    lines.push(`- This test case has ${steps.length} steps. All ${steps.length} must be completed.`);
  }

  return lines.join("\n");
}

export function extractGeneratedScript(session: AutomationSession): string | null {
  if (!session.events || session.events.length === 0) return null;
  const captures: Array<{
    step: Record<string, unknown>;
    status: string;
    source: string;
  }> = [];
  const normalizeStatus = (value: unknown): string => {
    const status = asText(value).toLowerCase();
    return status || "unknown";
  };
  const pushCapture = (step: unknown, status: unknown, source: string) => {
    const parsedStep = asRecord(step);
    if (Object.keys(parsedStep).length === 0) return;
    captures.push({ step: parsedStep, status: normalizeStatus(status), source });
  };
  const normalizeSelector = (value: unknown): string => {
    const selector = asText(value);
    if (!selector) return "";
    if (selector.startsWith("xpath:")) return `xpath=${selector.slice("xpath:".length)}`;
    return selector;
  };
  const pushStagehandCapture = (entryRaw: unknown, status: unknown, source: string) => {
    const entry = asRecord(entryRaw);
    if (Object.keys(entry).length === 0) return;
    const type = asText(entry.type).toLowerCase();
    if (type === "extract") {
      const success = entry.success;
      if (success === false) return;
      const result = asRecord(entry.result);
      for (const value of Object.values(result)) {
        if (typeof value === "string") {
          const text = value.trim();
          if (!text) continue;
          if (/^https?:\/\//i.test(text)) {
            pushCapture({ action: "assert_url", url: text }, status, source);
          } else {
            pushCapture({ action: "assert_text", expectedText: text }, status, source);
          }
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = asText(item);
            if (text) pushCapture({ action: "assert_text", expectedText: text }, status, source);
          }
        }
      }
      return;
    }
    if (type === "wait") {
      const durationMs = Number(entry.timeMs);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        pushCapture({ action: "wait", durationMs: Math.round(durationMs) }, status, source);
      }
      return;
    }
    const normalizedAction = asText(entry.action).toLowerCase();
    const playwrightCode = asText(entry.playwright);
    if (normalizedAction && playwrightCode) {
      const cap: Record<string, unknown> = {
        action: normalizedAction,
        playwright: playwrightCode,
      };
      const entryValue = asText(entry.value);
      const entryUrl = asText(entry.url);
      const entryKey = asText(entry.key);
      const entryExpected = asText(entry.expectedText);
      if (entryValue) cap.value = entryValue;
      if (entryUrl) cap.url = entryUrl;
      if (entryKey) cap.key = entryKey;
      if (entryExpected) cap.expectedText = entryExpected;
      if (entry.timeMs != null) cap.durationMs = Number(entry.timeMs);
      pushCapture(cap, status, source);
      return;
    }
    const nestedActions = Array.isArray(entry.actions) ? entry.actions : [];
    let emitted = false;
    for (const nestedRaw of nestedActions) {
      const nested = asRecord(nestedRaw);
      const method = asText(nested.method).toLowerCase();
      const selector = normalizeSelector(nested.selector);
      const args = Array.isArray(nested.arguments) ? nested.arguments : [];
      const firstArg = args.length > 0 ? asText(args[0]) : "";
      if ((method === "fill" || method === "type") && selector) {
        pushCapture({ action: "type", selector, value: firstArg }, status, source);
        emitted = true;
      } else if ((method === "click" || method === "dblclick" || method === "check" || method === "uncheck") && selector) {
        pushCapture({ action: "click", selector }, status, source);
        emitted = true;
      } else if ((method === "goto" || method === "navigate") && firstArg) {
        pushCapture({ action: "navigate", url: firstArg }, status, source);
        emitted = true;
      }
    }
    if (emitted) return;

    const topMethod = asText(entry.method).toLowerCase();
    const topSelector = normalizeSelector(entry.selector);
    const topArgs = Array.isArray(entry.arguments) ? entry.arguments : [];
    const topFirstArg = topArgs.length > 0 ? asText(topArgs[0]) : "";
    if ((topMethod === "fill" || topMethod === "type") && topSelector) {
      pushCapture({ action: "type", selector: topSelector, value: topFirstArg }, status, source);
      return;
    }
    if ((topMethod === "click" || topMethod === "dblclick" || topMethod === "check" || topMethod === "uncheck") && topSelector) {
      pushCapture({ action: "click", selector: topSelector }, status, source);
      return;
    }
    if ((topMethod === "goto" || topMethod === "navigate") && topFirstArg) {
      pushCapture({ action: "navigate", url: topFirstArg }, status, source);
      return;
    }
    const playwrightArgs = asRecord(entry.playwrightArguments);
    if (Object.keys(playwrightArgs).length > 0) {
      const method = asText(playwrightArgs.method).toLowerCase();
      const selector = normalizeSelector(playwrightArgs.selector);
      const args = Array.isArray(playwrightArgs.arguments) ? playwrightArgs.arguments : [];
      const firstArg = args.length > 0 ? asText(args[0]) : "";
      if ((method === "fill" || method === "type") && selector) {
        pushCapture({ action: "type", selector, value: firstArg }, status, source);
        return;
      }
      if ((method === "click" || method === "dblclick" || method === "check" || method === "uncheck") && selector) {
        pushCapture({ action: "click", selector }, status, source);
        return;
      }
      if ((method === "goto" || method === "navigate") && firstArg) {
        pushCapture({ action: "navigate", url: firstArg }, status, source);
      }
    }
  };
  const inferStagehandStatus = (parsed: Record<string, unknown>, execution: Record<string, unknown>): string => {
    const explicit = [parsed.status, execution.status].map((v) => asText(v).toLowerCase()).find(Boolean);
    if (explicit === "passed" || explicit === "success") return "passed";
    if (explicit === "failed" || explicit === "error") return "failed";
    const results = Array.isArray(execution.results) ? execution.results : [];
    let sawPassedResult = false;
    for (const resultRaw of results) {
      const status = asText(asRecord(resultRaw).status).toLowerCase();
      if (status === "failed" || status === "error") return "failed";
      if (status === "passed" || status === "success") sawPassedResult = true;
    }
    if (sawPassedResult) return "passed";
    const stagehandActions = Array.isArray(execution.stagehandActions) ? execution.stagehandActions : [];
    let sawSuccessfulAction = false;
    for (const actionRaw of stagehandActions) {
      const action = asRecord(actionRaw);
      if (action.success === false) return "failed";
      if (action.success === true) sawSuccessfulAction = true;
    }
    if (sawSuccessfulAction) return "passed";
    return "passed";
  };
  for (const event of session.events) {
    const parsed = asRecord(event.parsedAction);
    const execution = asRecord(event.executionResult);
    if (event.eventType === "autonomous_step_executed") {
      pushCapture(parsed.step, parsed.status, "autonomous_step_executed");
    } else if (event.eventType === "autonomous_turn_executed") {
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      if (results.length === 0) {
        for (const step of steps) pushCapture(step, parsed.status, "autonomous_turn_executed");
      } else {
        const bound = Math.min(steps.length, results.length);
        for (let i = 0; i < bound; i += 1) {
          pushCapture(steps[i], asRecord(results[i]).status, "autonomous_turn_executed");
        }
      }
    } else if (event.eventType === "command_executed") {
      const captureCountBefore = captures.length;
      const stagehandActions = Array.isArray(execution.stagehandActions) ? execution.stagehandActions : [];
      if (stagehandActions.length > 0) {
        const status = inferStagehandStatus(parsed, execution);
        for (const stagehandAction of stagehandActions) {
          pushStagehandCapture(stagehandAction, status, "command_executed_stagehand");
        }
        continue;
      }
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const results = Array.isArray(execution.results) ? execution.results : [];
      if (results.length === 0) {
        for (const step of steps) pushCapture(step, parsed.status, "command_executed");
      } else {
        const bound = Math.min(steps.length, results.length);
        for (let i = 0; i < bound; i += 1) {
          pushCapture(steps[i], asRecord(results[i]).status, "command_executed");
        }
      }
      if (captures.length === captureCountBefore) {
        // Fallback path: when Stagehand returns no normalized actions/replay steps,
        // derive coarse captures from raw result entries so script preview is still generated.
        const results = Array.isArray(execution.results) ? execution.results : [];
        const overallStatus = normalizeStatus(parsed.status || execution.status);
        for (const resultRaw of results) {
          const result = asRecord(resultRaw);
          const action = asText(result.action).toLowerCase();
          const status = normalizeStatus(result.status || overallStatus);
          const selectorUsed = normalizeSelector(result.selectorUsed);
          const currentUrl = asText(result.currentUrl || execution.currentUrl);
          const message = asText(result.message);

          if ((action === "navigate" || action === "goto") && currentUrl) {
            pushCapture({ action: "navigate", url: currentUrl }, status, "command_executed_result_fallback");
            continue;
          }
          if ((action === "click" || action === "dblclick" || action === "check" || action === "uncheck") && selectorUsed) {
            pushCapture({ action: "click", selector: selectorUsed }, status, "command_executed_result_fallback");
            continue;
          }
          if ((action === "type" || action === "fill") && selectorUsed) {
            pushCapture({ action: "type", selector: selectorUsed }, status, "command_executed_result_fallback");
            continue;
          }
          if (action === "assert_url" && currentUrl) {
            pushCapture({ action: "assert_url", url: currentUrl }, status, "command_executed_result_fallback");
            continue;
          }
          if (message) {
            pushCapture(
              {
                action: action || "act",
                targetDescription: message,
                ...(selectorUsed ? { selector: selectorUsed } : {}),
              },
              status,
              "command_executed_result_fallback"
            );
          }
        }
        if (captures.length === captureCountBefore) {
          const currentUrl = asText(execution.currentUrl);
          if (currentUrl) {
            pushCapture(
              { action: "navigate", url: currentUrl, targetDescription: "Execution completed; preserving final URL." },
              overallStatus,
              "command_executed_result_fallback"
            );
          }
        }
      }
    }
  }
  if (captures.length === 0) return null;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const compactStep = (step: Record<string, unknown>): string => {
    const action = asText(step.action) || "unknown_action";
    const selector = asText(step.selector);
    const value = asText(step.value);
    const url = asText(step.url);
    const expectedText = asText(step.expectedText);
    const parts = [`action=${action}`];
    if (selector) parts.push(`selector=${selector}`);
    if (url) parts.push(`url=${url}`);
    if (value) parts.push(`value=${value}`);
    if (expectedText) parts.push(`expectedText=${expectedText}`);
    return parts.join(" | ");
  };
  const lines = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test('generated automation test', async ({ page }) => {`,
  ];
  let executableCount = 0;
  for (const capture of captures) {
    const a = capture.step;
    const action = asText(a.action);
    const selector = asText(a.selector);
    const value = asText(a.value);
    const url = asText(a.url);
    const passed = isPassedStatus(capture.status);
    let emitted = false;
    if (passed && asText(a.playwright)) {
      lines.push(`  ${asText(a.playwright)}`);
      emitted = true;
    } else if (passed && action === "navigate" && url) {
      lines.push(`  await page.goto('${esc(url)}');`);
      emitted = true;
    } else if (passed && action === "click" && selector) {
      lines.push(`  await page.locator('${esc(selector)}').first().click();`);
      emitted = true;
    } else if (passed && action === "type" && selector && selector !== "activeElement") {
      lines.push(`  await page.locator('${esc(selector)}').first().fill('${esc(value)}');`);
      emitted = true;
    } else if (passed && action === "type" && value) {
      lines.push(`  await page.keyboard.type('${esc(value)}');`);
      emitted = true;
    } else if (passed && action === "wait") {
      const durationMs = Number(a.durationMs);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        lines.push(`  await page.waitForTimeout(${Math.round(durationMs)});`);
        emitted = true;
      }
    } else if (passed && action === "press") {
      lines.push(`  await page.keyboard.press('${esc(asText(a.key) || "Enter")}');`);
      emitted = true;
    } else if (passed && action === "assert_visible" && selector) {
      lines.push(`  await expect(page.locator('${esc(selector)}').first()).toBeVisible();`);
      emitted = true;
    } else if (passed && action === "assert_text" && asText(a.expectedText)) {
      lines.push(`  await expect(page.getByText('${esc(asText(a.expectedText))}', { exact: false })).toBeVisible();`);
      emitted = true;
    } else if (passed && action === "assert_url" && url) {
      lines.push(`  await expect(page).toHaveURL('${esc(url)}');`);
      emitted = true;
    } else if (passed && action === "scroll") {
      lines.push("  await page.mouse.wheel(0, 300);");
      emitted = true;
    }
    if (emitted) {
      executableCount += 1;
      continue;
    }
    lines.push(`  // ${capture.source} [${capture.status}]: ${esc(compactStep(a))}`);
  }
  if (executableCount > 0) {
    lines.push("  await expect(page).toHaveURL(/.*/);");
  } else {
    lines.push("  // No deterministic Playwright actions could be emitted from captured steps.");
  }
  lines.push("});");
  return lines.join("\n");
}

async function resolveEnvironmentUrl(projectId: string): Promise<string | null> {
  const settings = getAgentSettings(projectId, "aegis");
  if (settings.defaultEnvironmentUrl) return settings.defaultEnvironmentUrl;
  try {
    const p = await getProject(projectId);
    const parsed = parseProjectSettings(typeof p.settings === "string" ? p.settings : "");
    const automation = parsed.automation as Record<string, unknown> | undefined;
    const envs = normalizeTestRunEnvironments(automation?.testRunEnvironments);
    return envs.length > 0 ? envs[0].url : null;
  } catch {
    return null;
  }
}

export type AegisBackgroundStatus = "running" | "completed" | "failed";
export type AegisRunPhase = "queued" | "building" | "bot_reviewing" | "completed" | "failed";

export interface AegisRunLogEntry {
  ts: number;
  message: string;
  detail?: string;
  type: "thinking" | "action" | "info" | "success" | "error" | "bot_review";
}

export interface AegisBackgroundRun {
  testcaseId: string;
  taskId: string;
  status: AegisBackgroundStatus;
  phase: AegisRunPhase;
  title: string;
  sessionId: string | null;
  reviewSessionId: string | null;
  logs: AegisRunLogEntry[];
}

const activeRuns = new Map<string, AegisBackgroundRun>();
const listeners = new Set<() => void>();
const MAX_BOT_REVIEW_CYCLES = 1;

export function getActiveRuns(): AegisBackgroundRun[] {
  return Array.from(activeRuns.values());
}

export function getRunByTestcaseId(testcaseId: string): AegisBackgroundRun | null {
  return activeRuns.get(testcaseId) || null;
}

export function getRunByTaskId(taskId: string): AegisBackgroundRun | null {
  for (const run of activeRuns.values()) {
    if (run.taskId === taskId) return run;
  }
  return null;
}

export function onRunsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

function addRunLog(testcaseId: string, message: string, type: AegisRunLogEntry["type"]) {
  const run = activeRuns.get(testcaseId);
  if (!run) return;
  const previous = run.logs[run.logs.length - 1];
  if (previous && previous.type === type && previous.message === message) {
    return;
  }
  run.logs.push({ ts: Date.now(), message, type });
  notifyListeners();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateMiddle(value: string, max = 90): string {
  if (value.length <= max) return value;
  const keep = Math.max(8, Math.floor((max - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function toFriendlySentence(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.replace(/^now (i|we)'ll\s+/i, "").replace(/^let me\s+/i, "");
}

function addRunLogWithDetail(
  testcaseId: string,
  message: string,
  type: AegisRunLogEntry["type"],
  detail?: string
) {
  const run = activeRuns.get(testcaseId);
  if (!run) return;
  const previous = run.logs[run.logs.length - 1];
  if (previous && previous.type === type && previous.message === message && previous.detail === detail) {
    return;
  }
  run.logs.push({ ts: Date.now(), message, type, detail });
  notifyListeners();
}

function logStagehandActionEntry(
  testcaseId: string,
  action: Record<string, unknown>,
  index: number,
  total: number
) {
  const category = readString(action.category).toLowerCase();
  const message = readString(action.message);
  const reasoning = toFriendlySentence(readString(action.reasoning));
  const tool = readString(action.tool) || readString(action.name);
  const instruction = readString(action.instruction);
  const xpath = readString(action.xpath);
  const url = readString(action.url);
  const argumentsText = readString(action.arguments);

  if (reasoning) {
    addRunLogWithDetail(testcaseId, reasoning, "thinking");
    return;
  }

  if (category === "action" && message.toLowerCase().includes("checking for page navigation")) {
    addRunLogWithDetail(
      testcaseId,
      "Checking whether the page navigated after the last interaction.",
      "action",
      xpath ? `Target: ${truncateMiddle(xpath)}` : undefined
    );
    return;
  }

  if (category === "action" && message.toLowerCase().includes("no new (frame) url detected")) {
    addRunLogWithDetail(
      testcaseId,
      "No navigation detected; staying on the current page.",
      "info",
      url ? `URL: ${url}` : undefined
    );
    return;
  }

  if (tool) {
    addRunLogWithDetail(
      testcaseId,
      `Using tool: ${tool}.`,
      "action",
      argumentsText ? `Input: ${truncateMiddle(argumentsText, 140)}` : undefined
    );
    return;
  }

  if (instruction) {
    addRunLogWithDetail(
      testcaseId,
      "Planning next extraction/check.",
      "thinking",
      truncateMiddle(instruction, 160)
    );
    return;
  }

  const method = readString(action.method);
  const description = readString(action.description);
  if (method || description) {
    const head = method ? `Action: ${method}` : "Action performed";
    const suffix = description ? ` (${description})` : "";
    addRunLogWithDetail(
      testcaseId,
      `${head}${suffix}.`,
      "action",
      xpath ? `Target: ${truncateMiddle(xpath)}` : undefined
    );
    return;
  }

  if (message) {
    addRunLogWithDetail(
      testcaseId,
      message,
      category === "api" ? "error" : "info",
      `Stagehand step ${index + 1}/${total}`
    );
    return;
  }

  addRunLogWithDetail(
    testcaseId,
    `Stagehand step ${index + 1}/${total} completed.`,
    "info"
  );
}

function updateRunPhase(testcaseId: string, phase: AegisRunPhase) {
  const run = activeRuns.get(testcaseId);
  if (!run) return;
  run.phase = phase;
  notifyListeners();
}

function updateRunSessionId(testcaseId: string, sessionId: string | null, field: "sessionId" | "reviewSessionId" = "sessionId") {
  const run = activeRuns.get(testcaseId);
  if (!run) return;
  run[field] = sessionId;
  notifyListeners();
}

function findOrCreateTask(
  projectId: string,
  testcaseId: string,
  title: string,
  externalId: string,
  initialStatus: "queued" | "in_progress",
  queueSource?: AgentTaskQueueSource,
): AgentTask {
  const now = new Date().toISOString();
  const currentTasks = getStoredAgentTasks(projectId, "aegis");
  const existing = currentTasks.find(
    (t) => t.testcaseId === testcaseId && (t.status === "in_progress" || t.status === "needs_revision" || t.status === "queued")
  );
  if (existing) {
    const updated: AgentTask = { ...existing, status: initialStatus as AgentTask["status"], updatedAt: now };
    if (queueSource) updated.queueSource = queueSource;
    upsertAgentTask(projectId, "aegis", updated);
    return updated;
  }
  const task: AgentTask = {
    id: `task-${Date.now()}-${testcaseId}`,
    projectId,
    agentType: "aegis",
    testcaseId,
    testcaseTitle: title,
    testcaseExternalId: externalId,
    status: initialStatus,
    queueSource: queueSource || "manual",
    script: null,
    sessionId: null,
    tracePath: null,
    videoPath: null,
    screenshotPath: null,
    logs: [],
    feedback: [],
    createdAt: now,
    updatedAt: now,
  };
  upsertAgentTask(projectId, "aegis", task);
  return task;
}

function buildStepValidationList(tc: Record<string, unknown>): string[] {
  return parseTestCaseSteps(tc.steps);
}

async function runBotReview(
  projectId: string,
  testcaseId: string,
  script: string,
  tc: Record<string, unknown>,
  envUrl: string,
  reviewCycle: number,
): Promise<BotReviewResult> {
  const steps = buildStepValidationList(tc);
  const validatedSteps: BotReviewResult["validatedSteps"] = [];
  const assertionSuggestions: NonNullable<BotReviewResult["assertionSuggestions"]> = [];

  addRunLog(testcaseId, `Bot Reviewer [Cycle ${reviewCycle}/${MAX_BOT_REVIEW_CYCLES}]: Starting validation...`, "bot_review");
  addRunLog(testcaseId, "Bot Reviewer: Creating verification session for rerun validation...", "thinking");

  let scriptRanSuccessfully = false;
  let runError: string | null = null;

  try {
    const { id: reviewSessionId } = await startAutomationSession(projectId, testcaseId, { startUrl: envUrl });
    updateRunSessionId(testcaseId, reviewSessionId, "reviewSessionId");

    addRunLog(testcaseId, "Bot Reviewer: Executing generated script against application...", "action");

    const result = await runAutomationPlaywrightScript(projectId, reviewSessionId, {
      script,
      startUrl: envUrl,
      actionDelayMs: 500,
    });

    const status = typeof result.status === "string" ? result.status.toLowerCase() : "failed";
    scriptRanSuccessfully = status === "passed";

    if (scriptRanSuccessfully) {
      addRunLog(testcaseId, "Bot Reviewer: Script executed successfully.", "success");
    } else {
      runError = typeof result.errorMessage === "string" ? result.errorMessage : "Script execution failed";
      addRunLog(testcaseId, `Bot Reviewer: Script execution failed — ${runError}`, "error");
    }

    try { await cancelAutomationSession(projectId, reviewSessionId); } catch {}
    updateRunSessionId(testcaseId, null, "reviewSessionId");
  } catch (err) {
    runError = err instanceof Error ? err.message : "Failed to run review session";
    addRunLog(testcaseId, `Bot Reviewer: Could not start review session — ${runError}`, "error");
  }

  addRunLog(testcaseId, "Bot Reviewer: Validating script-to-goal and step alignment...", "thinking");

  const scriptLower = script.toLowerCase();
  const rawScriptLines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  const scriptLines = script.split("\n").map((l) => l.trim().toLowerCase());
  const robustAssertionCount = scriptLines.filter((line) =>
    line.includes("await expect(") &&
    !line.includes("tohaveurl(/.*/)") &&
    !line.includes("tohaveurl(/.*?/)")
  ).length;

  const escSingle = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const locatorAnchors = Array.from(new Set(
    rawScriptLines
      .map((line) => {
        const m = line.match(/page\.locator\((['"`])(.+?)\1\)/i);
        return m ? m[2] : "";
      })
      .filter(Boolean),
  ));
  const textAnchors = Array.from(new Set(
    rawScriptLines
      .map((line) => {
        const m = line.match(/getByText\((['"`])(.+?)\1/i);
        return m ? m[2] : "";
      })
      .filter(Boolean),
  ));
  const urlAnchors = Array.from(new Set(
    rawScriptLines
      .map((line) => {
        const m = line.match(/page\.goto\((['"`])(.+?)\1\)/i);
        return m ? m[2] : "";
      })
      .filter(Boolean),
  ));

  const pickBestLineForStep = (keywords: string[]): string | null => {
    if (rawScriptLines.length === 0) return null;
    let bestLine: string | null = null;
    let bestScore = -1;
    for (const line of rawScriptLines) {
      const lower = line.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (kw && lower.includes(kw)) score += 1;
      }
      if (/(locator|getbytext|goto|click|fill|type)/i.test(line)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestLine = line;
      }
    }
    return bestLine;
  };

  const suggestAssertionForStep = (step: string, keywords: string[]): { suggestion: string; reason: string } => {
    const lower = step.toLowerCase();
    const bestLine = pickBestLineForStep(keywords);
    const locatorFromLine = bestLine?.match(/page\.locator\((['"`])(.+?)\1\)/i)?.[2] || locatorAnchors[0];
    const textFromLine = bestLine?.match(/getByText\((['"`])(.+?)\1/i)?.[2] || textAnchors[0];
    const urlFromLine = bestLine?.match(/page\.goto\((['"`])(.+?)\1\)/i)?.[2] || urlAnchors[0];

    if (lower.includes("login") || lower.includes("sign in") || lower.includes("authenticate")) {
      return {
        suggestion: urlFromLine
          ? `Add: await expect(page).toHaveURL(/${escSingle(urlFromLine).replace(/https?:\/\//, "").split("/")[0]}/);`
          : locatorFromLine
            ? `Add: await expect(page.locator('${escSingle(locatorFromLine)}').first()).toBeVisible();`
            : "Add: await expect(page.getByRole('navigation')).toBeVisible();",
        reason: "Login completion should assert authenticated landing page state from actual screen anchors.",
      };
    }
    if (lower.includes("navigate") || lower.includes("open") || lower.includes("go to") || lower.includes("visit")) {
      return {
        suggestion: urlFromLine
          ? `Add: await expect(page).toHaveURL('${escSingle(urlFromLine)}');`
          : textFromLine
            ? `Add: await expect(page.getByText('${escSingle(textFromLine)}', { exact: false })).toBeVisible();`
            : "Add: await expect(page).toHaveURL(/.+/);",
        reason: "Navigation should be asserted using the destination URL/text observed in this run.",
      };
    }
    if (lower.includes("create") || lower.includes("add") || lower.includes("submit") || lower.includes("save")) {
      return {
        suggestion: textFromLine
          ? `Add: await expect(page.getByText('${escSingle(textFromLine)}', { exact: false })).toBeVisible();`
          : locatorFromLine
            ? `Add: await expect(page.locator('${escSingle(locatorFromLine)}').first()).toContainText(/saved|created|success/i);`
            : "Add: await expect(page.getByText(/success|saved|created/i)).toBeVisible();",
        reason: "Create/save flows should assert persisted success using concrete UI anchors.",
      };
    }
    if (lower.includes("delete") || lower.includes("remove")) {
      return {
        suggestion: locatorFromLine
          ? `Add: await expect(page.locator('${escSingle(locatorFromLine)}').first()).not.toBeVisible();`
          : "Add: await expect(page.getByText(/deleted|removed/i)).toBeVisible();",
        reason: "Delete/remove should assert absence/confirmation tied to the interacted element.",
      };
    }
    if (lower.includes("search") || lower.includes("filter")) {
      return {
        suggestion: locatorFromLine
          ? `Add: await expect(page.locator('${escSingle(locatorFromLine)}').first()).toBeVisible();`
          : textFromLine
            ? `Add: await expect(page.getByText('${escSingle(textFromLine)}', { exact: false })).toBeVisible();`
            : "Add: await expect(page.locator('table, [role=\"grid\"]').first()).toBeVisible();",
        reason: "Search/filter should assert the filtered result anchor visible on screen.",
      };
    }
    return {
      suggestion: locatorFromLine
        ? `Add: await expect(page.locator('${escSingle(locatorFromLine)}').first()).toBeVisible();`
        : textFromLine
          ? `Add: await expect(page.getByText('${escSingle(textFromLine)}', { exact: false })).toBeVisible();`
          : "Add: await expect(page.locator('main')).toBeVisible();",
      reason: "Suggestion is derived from concrete selectors/text used in this script execution.",
    };
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLower = step.toLowerCase();

    const hasNavigate = stepLower.includes("navigate") || stepLower.includes("go to") || stepLower.includes("open") || stepLower.includes("visit");
    const hasClick = stepLower.includes("click") || stepLower.includes("select") || stepLower.includes("press") || stepLower.includes("tap") || stepLower.includes("choose");
    const hasType = stepLower.includes("type") || stepLower.includes("enter") || stepLower.includes("fill") || stepLower.includes("input") || stepLower.includes("write") || stepLower.includes("provide");
    const hasAssert = stepLower.includes("expect") || stepLower.includes("verify") || stepLower.includes("should") || stepLower.includes("assert") || stepLower.includes("check") || stepLower.includes("confirm") || stepLower.includes("validate") || stepLower.includes("see") || stepLower.includes("display");
    const hasLogin = stepLower.includes("login") || stepLower.includes("log in") || stepLower.includes("sign in") || stepLower.includes("authenticate");

    const keywords = step.match(/\b[a-zA-Z]{3,}\b/g)?.map((w) => w.toLowerCase()) || [];
    const meaningfulKeywords = keywords.filter((w) => !["the", "and", "for", "with", "into", "from", "that", "this", "should", "must", "then", "step", "page", "click", "type", "enter", "verify", "expect", "navigate", "open", "fill", "input", "button", "field", "select", "check"].includes(w));

    let covered = false;
    let detail = "";

    if (hasNavigate) {
      const navigateActions = scriptLines.filter((l) => l.includes("goto") || l.includes("page.goto"));
      covered = navigateActions.length > 0;
      detail = covered ? "Navigation action found in script" : "No navigation action found in script";
    } else if (hasLogin) {
      const hasCredentialEntry = scriptLower.includes("fill") || scriptLower.includes("type");
      const hasSubmit = scriptLower.includes("click");
      covered = hasCredentialEntry && hasSubmit;
      detail = covered ? "Login flow (credential entry + submit) found" : "Login flow may be incomplete";
    } else if (hasClick) {
      const keywordMatchCount = meaningfulKeywords.filter((kw) => scriptLower.includes(kw)).length;
      covered = keywordMatchCount >= 1 && scriptLower.includes("click");
      detail = covered ? `Click action with matching context found (${keywordMatchCount} keyword matches)` : "Click action with matching context not found";
    } else if (hasType) {
      const keywordMatchCount = meaningfulKeywords.filter((kw) => scriptLower.includes(kw)).length;
      covered = keywordMatchCount >= 1 && (scriptLower.includes("fill") || scriptLower.includes("type"));
      detail = covered ? `Type/fill action with matching context found (${keywordMatchCount} keyword matches)` : "Type/fill action with matching context not found";
    } else if (hasAssert) {
      const keywordMatchCount = meaningfulKeywords.filter((kw) => scriptLower.includes(kw)).length;
      const hasExpect = scriptLower.includes("expect") || scriptLower.includes("tobevisible") || scriptLower.includes("tohaveurl") || scriptLower.includes("tocontaintext");
      covered = keywordMatchCount >= 1 && hasExpect;
      detail = covered ? `Assertion with matching context found (${keywordMatchCount} keyword matches)` : "Assertion with matching context not found";
    } else {
      const keywordMatchCount = meaningfulKeywords.filter((kw) => scriptLower.includes(kw)).length;
      covered = keywordMatchCount >= Math.max(1, Math.floor(meaningfulKeywords.length * 0.3));
      detail = covered ? `Step intent appears covered (${keywordMatchCount}/${meaningfulKeywords.length} keywords matched)` : `Step intent may not be covered (${keywordMatchCount}/${meaningfulKeywords.length} keywords matched)`;
    }

    const stepNeedsAssertion = hasAssert || hasLogin || hasNavigate || hasClick || hasType;
    const keywordEvidence = meaningfulKeywords.length === 0 || meaningfulKeywords.some((kw) => scriptLower.includes(kw));
    const stepHasAssertionEvidence =
      keywordEvidence &&
      (scriptLower.includes("expect(") ||
        scriptLower.includes("tobevisible") ||
        scriptLower.includes("tocontaintext") ||
        scriptLower.includes("tohavetext") ||
        scriptLower.includes("tohavevalue"));
    if (stepNeedsAssertion && !stepHasAssertionEvidence) {
      const suggestion = suggestAssertionForStep(step, meaningfulKeywords);
      assertionSuggestions.push({
        step,
        suggestion: suggestion.suggestion,
        reason: suggestion.reason,
      });
    }

    validatedSteps.push({
      step,
      passed: covered,
      detail,
    });

    const icon = covered ? "PASS" : "WARN";
    addRunLog(testcaseId, `Bot Reviewer: Step ${i + 1} [${icon}] — ${step} — ${detail}`, "bot_review");
  }

  const allStepsPassed = validatedSteps.every((s) => s.passed);
  const objective = asText(tc.description).trim().toLowerCase();
  const title = asText(tc.title).trim().toLowerCase();
  const objectiveTokens = `${title} ${objective}`.match(/\b[a-zA-Z]{4,}\b/g) || [];
  const meaningfulObjectiveTokens = objectiveTokens.filter((w) => !["test", "case", "verify", "check", "user", "should", "with", "when", "then", "step", "page", "button", "field"].includes(w));
  const objectiveMatchCount = meaningfulObjectiveTokens.filter((kw) => scriptLower.includes(kw)).length;
  const minimumGoalMatches = meaningfulObjectiveTokens.length > 0
    ? Math.max(1, Math.min(3, Math.floor(meaningfulObjectiveTokens.length * 0.3)))
    : 1;
  const goalValidationPassed = allStepsPassed && (meaningfulObjectiveTokens.length === 0 || objectiveMatchCount >= minimumGoalMatches);
  const rerunValidationPassed = scriptRanSuccessfully;
  const executableActionCount = scriptLines.filter((line) => line.startsWith("await page.") || line.startsWith("await expect(")).length;
  const planAlignmentPassed = allStepsPassed && executableActionCount >= Math.max(steps.length, 1);
  const assertionValidationPassed =
    robustAssertionCount >= Math.max(1, Math.floor(Math.max(steps.length, 1) / 2)) &&
    assertionSuggestions.length === 0;
  const overallPassed = goalValidationPassed && rerunValidationPassed && planAlignmentPassed && assertionValidationPassed;
  const feedback: string[] = [];

  if (!scriptRanSuccessfully) {
    feedback.push(`Script execution failed: ${runError || "Unknown error"}`);
  }
  validatedSteps.filter((s) => !s.passed).forEach((s) => {
    feedback.push(`Step not covered: "${s.step}"`);
  });
  if (!goalValidationPassed) {
    feedback.push(`Goal validation failed: matched ${objectiveMatchCount}/${meaningfulObjectiveTokens.length || 1} objective keywords with incomplete step coverage.`);
  }
  if (!planAlignmentPassed) {
    feedback.push(`Plan/steps alignment failed: only ${executableActionCount} executable script actions for ${steps.length} required test steps.`);
  }
  if (robustAssertionCount === 0) {
    feedback.push("Assertion validation failed: no robust assertions found. Generic URL checks are not sufficient.");
    if (locatorAnchors.length > 0) {
      assertionSuggestions.push({
        step: "Global",
        suggestion: `Add: await expect(page.locator('${escSingle(locatorAnchors[0])}').first()).toBeVisible();`,
        reason: "Derived from concrete selector used in this run.",
      });
    } else if (textAnchors.length > 0) {
      assertionSuggestions.push({
        step: "Global",
        suggestion: `Add: await expect(page.getByText('${escSingle(textAnchors[0])}', { exact: false })).toBeVisible();`,
        reason: "Derived from concrete text anchor found in this run.",
      });
    } else if (urlAnchors.length > 0) {
      assertionSuggestions.push({
        step: "Global",
        suggestion: `Add: await expect(page).toHaveURL('${escSingle(urlAnchors[0])}');`,
        reason: "Derived from concrete navigation URL used in this run.",
      });
    } else {
      assertionSuggestions.push({
        step: "Global",
        suggestion: "Add: await expect(page.locator('main')).toBeVisible();",
        reason: "No stronger anchor extracted from script; add concrete per-step assertions next.",
      });
    }
  } else if (robustAssertionCount < Math.max(1, Math.floor(Math.max(steps.length, 1) / 2))) {
    feedback.push(`Assertion coverage is weak: ${robustAssertionCount} robust assertion(s) for ${steps.length} step(s).`);
  }

  const categories: NonNullable<BotReviewResult["categories"]> = [
    {
      key: "goal_validation",
      passed: goalValidationPassed,
      detail: goalValidationPassed
        ? "Goal and required steps are covered by the generated script."
        : `Goal coverage is weak (${objectiveMatchCount}/${meaningfulObjectiveTokens.length || 1} objective keywords matched) or one/more required steps are missing.`,
    },
    {
      key: "rerun_validation",
      passed: rerunValidationPassed,
      detail: rerunValidationPassed
        ? "Rerun completed successfully without script execution errors."
        : `Rerun failed: ${runError || "unknown error"}`,
    },
    {
      key: "plan_steps_alignment",
      passed: planAlignmentPassed,
      detail: planAlignmentPassed
        ? `Script has sufficient executable actions (${executableActionCount}) for required steps (${steps.length}).`
        : `Script has insufficient executable actions (${executableActionCount}) for required steps (${steps.length}).`,
    },
    {
      key: "assertion_validation",
      passed: assertionValidationPassed,
      detail: assertionValidationPassed
        ? `Assertion quality is sufficient (${robustAssertionCount} robust assertion(s)).`
        : `Assertion quality is insufficient (${robustAssertionCount} robust assertion(s), ${assertionSuggestions.length} suggestion(s)).`,
    },
  ];
  let reviewResult: BotReviewResult = {
    status: overallPassed ? "passed" : "failed",
    feedback,
    validatedSteps,
    assertionSuggestions,
    categories,
    reviewCycle,
    maxReviewCycles: MAX_BOT_REVIEW_CYCLES,
    reviewedAt: new Date().toISOString(),
    scriptRanSuccessfully,
  };

  try {
    addRunLog(testcaseId, "Bot Reviewer: Requesting AI-based script review...", "thinking");
    const aiReview = await reviewAutomationScriptWithAi(projectId, {
      testcaseId,
      testcaseTitle: asText(tc.title).trim(),
      testcaseDescription: asText(tc.description).trim(),
      steps,
      script,
      rerunPassed: scriptRanSuccessfully,
      rerunError: runError,
    });
    const aiCategories = Array.isArray(aiReview.categories) ? aiReview.categories : [];
    const aiFeedback = Array.isArray(aiReview.feedback) ? aiReview.feedback.filter(Boolean) : [];
    const aiValidatedSteps = Array.isArray(aiReview.validatedSteps) ? aiReview.validatedSteps : [];
    const aiAssertions = Array.isArray(aiReview.assertionSuggestions) ? aiReview.assertionSuggestions : [];
    const aiStatus = aiReview.status === "passed" ? "passed" : "failed";
    reviewResult = {
      ...reviewResult,
      status: scriptRanSuccessfully && aiStatus === "passed" ? "passed" : "failed",
      feedback: aiFeedback.length > 0 ? aiFeedback : reviewResult.feedback,
      validatedSteps: aiValidatedSteps.length > 0 ? aiValidatedSteps : reviewResult.validatedSteps,
      categories: aiCategories.length > 0 ? aiCategories : reviewResult.categories,
      assertionSuggestions: aiAssertions.length > 0 ? aiAssertions : reviewResult.assertionSuggestions,
    };
    addRunLog(testcaseId, "Bot Reviewer: AI review completed and applied.", "bot_review");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown AI review error";
    addRunLog(testcaseId, `Bot Reviewer: AI review unavailable (${message}). Using fallback review.`, "error");
  }

  if (reviewResult.categories && reviewResult.categories.length > 0) {
    for (const category of reviewResult.categories) {
      const marker = category.passed ? "PASS" : "FAIL";
      addRunLog(testcaseId, `Bot Reviewer: ${category.key} [${marker}] — ${category.detail}`, "bot_review");
    }
  }
  for (const item of reviewResult.feedback) {
    addRunLog(testcaseId, `Bot Reviewer: Failure reason — ${item}`, "error");
  }
  if (reviewResult.assertionSuggestions && reviewResult.assertionSuggestions.length > 0) {
    addRunLog(testcaseId, `Bot Reviewer: ${reviewResult.assertionSuggestions.length} assertion suggestion(s) generated.`, "bot_review");
    for (const suggestion of reviewResult.assertionSuggestions) {
      addRunLog(
        testcaseId,
        `Bot Reviewer: Assertion suggestion for "${suggestion.step}" — ${suggestion.suggestion}`,
        "bot_review",
      );
    }
  }
  if (reviewResult.status === "passed") {
    addRunLog(testcaseId, "Bot Reviewer: All validations passed. Sending to human review.", "success");
  } else {
    addRunLog(testcaseId, `Bot Reviewer: Validation failed (${reviewResult.feedback.length} issue${reviewResult.feedback.length > 1 ? "s" : ""}). Will retry.`, "error");
  }

  return reviewResult;
}

// --- Sequential queue system ---
interface PendingQueueItem {
  projectId: string;
  testcaseId: string;
  title: string;
  externalId: string;
  queueSource: AgentTaskQueueSource;
  botReviewCycle: number;
  botFeedback: string[];
  previousScript?: string | null;
}

const pendingQueue: PendingQueueItem[] = [];
let isProcessingQueue = false;

async function processNextInQueue(): Promise<void> {
  if (isProcessingQueue) return;
  const next = pendingQueue.shift();
  if (!next) return;
  isProcessingQueue = true;
  try {
    await executeAegisRun(
      next.projectId,
      next.testcaseId,
      next.title,
      next.externalId,
      next.queueSource,
      1,
      next.botReviewCycle,
      next.botFeedback,
      next.previousScript ?? null,
    );
  } finally {
    isProcessingQueue = false;
    if (pendingQueue.length > 0) {
      processNextInQueue();
    }
  }
}

export function getQueueLength(): number {
  return pendingQueue.length;
}

export async function runAegisInBackground(
  projectId: string,
  testcaseId: string,
  title: string,
  externalId: string,
  queueSource: AgentTaskQueueSource = "manual",
  options?: {
    botReviewCycle?: number;
    botFeedback?: string[];
    previousScript?: string | null;
  },
): Promise<void> {
  if (activeRuns.has(testcaseId)) return;
  if (pendingQueue.some((q) => q.testcaseId === testcaseId)) return;

  findOrCreateTask(projectId, testcaseId, title, externalId, "queued", queueSource);
  notifyListeners();

  if (isProcessingQueue || activeRuns.size > 0) {
    pendingQueue.push({
      projectId,
      testcaseId,
      title,
      externalId,
      queueSource,
      botReviewCycle: Math.max(1, options?.botReviewCycle ?? 1),
      botFeedback: Array.isArray(options?.botFeedback) ? options.botFeedback : [],
      previousScript: typeof options?.previousScript === "string" ? options.previousScript : null,
    });
    return;
  }

  pendingQueue.push({
    projectId,
    testcaseId,
    title,
    externalId,
    queueSource,
    botReviewCycle: Math.max(1, options?.botReviewCycle ?? 1),
    botFeedback: Array.isArray(options?.botFeedback) ? options.botFeedback : [],
    previousScript: typeof options?.previousScript === "string" ? options.previousScript : null,
  });
  processNextInQueue();
}

export function recoverOrphanedTasks(projectId: string): number {
  const tasks = getStoredAgentTasks(projectId, "aegis");
  const stuckStatuses: Set<string> = new Set(["in_progress", "queued", "bot_reviewing"]);
  let recovered = 0;

  for (const task of tasks) {
    if (!stuckStatuses.has(task.status)) continue;
    if (activeRuns.has(task.testcaseId)) continue;
    if (pendingQueue.some((q) => q.testcaseId === task.testcaseId)) continue;
    const hasPersistedSession = typeof task.sessionId === "string" && task.sessionId.trim().length > 0;
    if ((task.status === "in_progress" || task.status === "bot_reviewing") && hasPersistedSession) {
      // A persisted session means we should reattach the UI, not start a new run.
      continue;
    }

    runAegisInBackground(projectId, task.testcaseId, task.testcaseTitle, task.testcaseExternalId, task.queueSource || "manual");
    recovered++;
  }
  return recovered;
}

const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 8000;

async function executeAegisRun(
  projectId: string,
  testcaseId: string,
  title: string,
  externalId: string,
  queueSource: AgentTaskQueueSource = "manual",
  attempt: number = 1,
  botReviewCycle: number = 1,
  botFeedback: string[] = [],
  forcedPreviousScript: string | null = null,
): Promise<void> {
  if (activeRuns.has(testcaseId)) return;

  const queuedTask = findOrCreateTask(projectId, testcaseId, title, externalId, "queued", queueSource);
  activeRuns.set(testcaseId, {
    testcaseId,
    taskId: queuedTask.id,
    status: "running",
    phase: "queued",
    title,
    sessionId: null,
    reviewSessionId: null,
    logs: attempt > 1
      ? [{ ts: Date.now(), message: `Retry attempt ${attempt}/${MAX_RETRIES}. Restarting from scratch...`, type: "info" }]
      : [{
          ts: Date.now(),
          message: botReviewCycle > 1
            ? `Task re-queued by Bot Review (cycle ${botReviewCycle}/${MAX_BOT_REVIEW_CYCLES}). Preparing environment...`
            : "Task queued. Preparing environment...",
          type: "info",
        }],
  });
  notifyListeners();

  const retryOrFail = async (reason: string) => {
    if (attempt < MAX_RETRIES) {
      addRunLog(testcaseId, `${reason} — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`, "error");
      updateRunPhase(testcaseId, "queued");
      activeRuns.delete(testcaseId);
      notifyListeners();
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return executeAegisRun(
        projectId,
        testcaseId,
        title,
        externalId,
        queueSource,
        attempt + 1,
        botReviewCycle,
        botFeedback,
        forcedPreviousScript
      );
    }
    addRunLog(testcaseId, `${reason} — all ${MAX_RETRIES} attempts exhausted.`, "error");
    updateRunPhase(testcaseId, "failed");

    const runObj = activeRuns.get(testcaseId);
    const taskLogs = (runObj?.logs || []).map((l) => ({ ts: new Date(l.ts).toISOString(), message: l.message, type: l.type }));
    const failedTask = getStoredAgentTasks(projectId, "aegis").find((t) => t.id === queuedTask.id) || queuedTask;
    upsertAgentTask(projectId, "aegis", {
      ...failedTask,
      status: "pending_review",
      script: null,
      logs: taskLogs,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    activeRuns.set(testcaseId, { ...activeRuns.get(testcaseId)!, status: "failed" });
    notifyListeners();
    setTimeout(() => { activeRuns.delete(testcaseId); notifyListeners(); }, 5000);
  };

  try {
    const envUrl = await resolveEnvironmentUrl(projectId);
    if (!envUrl) {
      addRunLog(testcaseId, "No environment URL configured. Go to Aegis Settings and set a default environment URL.", "error");
      upsertAgentTask(projectId, "aegis", {
        ...queuedTask,
        status: "pending_review",
        script: null,
        logs: [{ ts: new Date().toISOString(), message: "No environment URL configured.", type: "error" }],
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      activeRuns.set(testcaseId, { ...activeRuns.get(testcaseId)!, status: "failed" });
      notifyListeners();
      setTimeout(() => { activeRuns.delete(testcaseId); notifyListeners(); }, 5000);
      return;
    }

    addRunLog(testcaseId, `Environment resolved: ${envUrl}`, "info");

    const now1 = new Date().toISOString();
    upsertAgentTask(projectId, "aegis", { ...queuedTask, status: "in_progress", updatedAt: now1 });
    updateRunPhase(testcaseId, "building");

    let tc;
    try {
      tc = await getTestCase(projectId, testcaseId);
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      addRunLog(testcaseId, `Failed to fetch test case: ${msg}`, "error");
      throw fetchErr;
    }
    addRunLog(testcaseId, "Analyzing test case intent and steps...", "thinking");

    const currentTasks = getStoredAgentTasks(projectId, "aegis");
    const previousTask = currentTasks.find(
      (t) => t.testcaseId === testcaseId && t.feedback.length > 0 && (t.status === "in_progress" || t.status === "needs_revision")
    );
    const reviewerFeedback = [...(previousTask?.feedback.map((fb) => fb.message) || []), ...botFeedback];
    const previousScript = forcedPreviousScript || previousTask?.script || null;

    if (reviewerFeedback && reviewerFeedback.length > 0) {
      addRunLog(testcaseId, `Revision run — addressing ${reviewerFeedback.length} feedback item(s)`, "action");
    }

    const intent = buildIntentObjective(tc, reviewerFeedback, previousScript);
    addRunLog(testcaseId, "Creating browser session...", "action");

    let sessionId: string;
    try {
      const sessionResult = await startAutomationSession(projectId, testcaseId, { startUrl: envUrl });
      sessionId = sessionResult.id;
    } catch (sessErr) {
      const msg = sessErr instanceof Error ? sessErr.message : String(sessErr);
      addRunLog(testcaseId, `Failed to create session: ${msg}`, "error");
      throw sessErr;
    }
    updateRunSessionId(testcaseId, sessionId);

    const latestForSession = getStoredAgentTasks(projectId, "aegis").find((t) => t.id === queuedTask.id) || queuedTask;
    upsertAgentTask(projectId, "aegis", { ...latestForSession, sessionId, updatedAt: new Date().toISOString() });

    addRunLog(testcaseId, "Session created. Bot is exploring and automating...", "action");
    const autonomousCommand = `Autonomous mode objective: ${intent}`;
    try {
      await sendAutomationCommand(projectId, sessionId, autonomousCommand);
    } catch (cmdErr) {
      const msg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
      addRunLog(testcaseId, `Failed to send automation command: ${msg}`, "error");
      throw cmdErr;
    }
    addRunLog(testcaseId, "Autonomous command sent. Executing full test case...", "thinking");

    let finished = false;
    let pollCount = 0;
    const maxPolls = 300;
    let lastEventCount = 0;
    let consecutivePollErrors = 0;

    while (!finished && pollCount < maxPolls) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCount++;
      try {
        const session = await getAutomationSession(projectId, sessionId);
        consecutivePollErrors = 0;
        const runtime = session.runtime;

        if (session.events && session.events.length > lastEventCount) {
          for (let i = lastEventCount; i < session.events.length; i++) {
            const event = session.events[i];
            const parsed = event.parsedAction as Record<string, unknown> | null;
            if (event.eventType === "autonomous_step_evaluating") {
              addRunLog(testcaseId, "Thinking: Analyzing page state and planning next action...", "thinking");
            } else if (event.eventType === "autonomous_step_executed" || event.eventType === "autonomous_turn_executed") {
              const status = parsed ? asText(parsed.status) : "";
              const stepData = parsed?.step as Record<string, unknown> | undefined;
              const action = stepData ? asText(stepData.action) : "";
              const selector = stepData ? asText(stepData.selector) : "";
              const value = stepData ? asText(stepData.value) : "";
              let desc = action;
              if (selector) desc += ` on "${selector}"`;
              if (value) desc += ` with "${value}"`;
              const icon = isPassedStatus(status) ? "OK" : "FAIL";
              if (desc) addRunLog(testcaseId, `Action [${icon}]: ${desc}`, "action");
            } else if (event.eventType === "command_executed") {
              const executionResult = event.executionResult as Record<string, unknown> | null;
              const stagehandActionsRaw = executionResult?.stagehandActions;
              const stagehandActions = Array.isArray(stagehandActionsRaw)
                ? (stagehandActionsRaw as Array<Record<string, unknown>>)
                : [];
              if (stagehandActions.length > 0) {
                for (let j = 0; j < stagehandActions.length; j += 1) {
                  const action = stagehandActions[j] || {};
                  logStagehandActionEntry(testcaseId, action, j, stagehandActions.length);
                }
              } else {
                const resultsRaw = executionResult?.results;
                const results = Array.isArray(resultsRaw) ? (resultsRaw as Array<Record<string, unknown>>) : [];
                for (let j = 0; j < results.length; j += 1) {
                  const step = results[j] || {};
                  const actionName = asText(step.action) || "act";
                  const status = asText(step.status).toLowerCase();
                  const marker = status === "passed" || status === "success" ? "OK" : status ? status.toUpperCase() : "INFO";
                  const message = asText(step.message);
                  addRunLog(testcaseId, `Stagehand [${j + 1}/${results.length}] [${marker}] ${actionName}${message ? ` — ${message}` : ""}`, "action");
                }
              }
              addRunLog(testcaseId, "Command batch completed.", "info");
            }
          }
          lastEventCount = session.events.length;
        }

        if (!runtime?.isRunning && (runtime?.queuedCount ?? 0) === 0) {
          finished = true;
          const script = extractGeneratedScript(session);
          if (script) {
            try { await finalizeAutomationSession(projectId, sessionId, { script }); } catch {}
            addRunLog(testcaseId, "Script generated successfully.", "success");
          } else {
            addRunLog(testcaseId, "Execution completed but no script actions captured.", "error");
          }

          const now2 = new Date().toISOString();
          const finalTask = getStoredAgentTasks(projectId, "aegis").find((t) => t.id === queuedTask.id) || queuedTask;
          const runObj = activeRuns.get(testcaseId);
          const taskLogs = (runObj?.logs || []).map((l) => ({ ts: new Date(l.ts).toISOString(), message: l.message, type: l.type }));
          upsertAgentTask(projectId, "aegis", {
            ...finalTask,
            status: "pending_review",
            script: script ?? null,
            sessionId,
            logs: taskLogs,
            updatedAt: now2,
            completedAt: now2,
          });
          addRunLog(testcaseId, "Automation completed. Script queued for Review Bot / user review.", "info");
          updateRunPhase(testcaseId, "completed");
          activeRuns.set(testcaseId, { ...activeRuns.get(testcaseId)!, status: "completed" });
          notifyListeners();
          setTimeout(() => { activeRuns.delete(testcaseId); notifyListeners(); }, 5000);
        }
      } catch {
        consecutivePollErrors++;
        if (consecutivePollErrors >= 3) {
          finished = true;
          await retryOrFail("Session polling failed repeatedly");
        } else {
          addRunLog(testcaseId, `Session poll error (${consecutivePollErrors}/3), will retry...`, "error");
        }
      }
    }

    if (!finished) {
      addRunLog(testcaseId, "Timed out waiting for execution to complete.", "error");
      await retryOrFail("Timed out waiting for execution to complete");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Aegis] executeAegisRun error:", err);
    addRunLog(testcaseId, `Error detail: ${errMsg}`, "error");
    await retryOrFail(`Unexpected error: ${errMsg}`);
  }
}
