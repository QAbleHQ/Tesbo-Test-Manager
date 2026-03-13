"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  authMe,
  getProject,
  getTestCase,
  startAutomationSession,
  sendAutomationCommand,
  getAutomationSession,
  finalizeAutomationSession,
  cancelAutomationSession,
  getAgentSettings,
  getAegisAutoQueue,
  clearAegisAutoQueue,
  getStoredAgentTasks,
  upsertAgentTask,
  type AutomationSession,
  type TestEnvironmentSetting,
  type AgentTask,
} from "@/lib/api";
import { AegisBackgroundIndicator } from "@/components/aegis-background-indicator";
import { onRunsChanged, getActiveRuns, runAegisInBackground, recoverOrphanedTasks, type AegisBackgroundRun } from "@/lib/aegis-runner";

type PagePhase = "select" | "running" | "results";

type QueueItemStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

type QueueItem = {
  testcaseId: string;
  externalId: string;
  title: string;
  status: QueueItemStatus;
  sessionId?: string;
  script?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

type LogEntry = {
  ts: number;
  testcaseId: string;
  message: string;
  type: "info" | "success" | "error" | "action";
};

function ShieldIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4" />
    </svg>
  );
}

function StatusIcon({ status }: { status: QueueItemStatus }) {
  switch (status) {
    case "pending":
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-zinc-300 dark:border-zinc-600" />
      );
    case "in_progress":
      return (
        <span className="flex h-5 w-5 items-center justify-center">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
        </span>
      );
    case "completed":
      return (
        <svg className="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "failed":
      return (
        <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "cancelled":
      return (
        <svg className="h-5 w-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      );
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function buildIntentObjective(tc: Record<string, unknown>, reviewerFeedback?: string[], previousScript?: string | null): string {
  const title = asText(tc.title).trim() || "Untitled test case";
  const description = asText(tc.description).trim();
  const preconditions = asText(tc.preconditions).trim();
  const testData = asText(tc.testData).trim();
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
    if (/@|credentials?|password|login/i.test(testData)) {
      lines.push("**CRITICAL:** For login forms, use the EXACT credentials from Test Data above. Never use placeholder values like user@example.com or password123.");
      lines.push("");
    }
  }

  if (steps.length > 0) {
    lines.push("### Steps to Execute");
    steps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
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

  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item) => Object.keys(item).length > 0);
}

function isPassedStatus(value: unknown): boolean {
  const n = asText(value).toLowerCase();
  return n === "passed" || n === "success";
}

function extractGeneratedScript(session: AutomationSession): string | null {
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
    let playwrightCode = asText(entry.playwright);
    if (!playwrightCode && normalizedAction) {
      const targetDesc = asText(entry.targetDescription || entry.description).trim();
      const val = asText(entry.value).trim();
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      if (targetDesc && (normalizedAction === "click" || normalizedAction === "type")) {
        if (normalizedAction === "type" && val) {
          playwrightCode = `await page.getByLabel('${esc(targetDesc)}', { exact: false }).or(page.getByPlaceholder('${esc(targetDesc)}', { exact: false })).first().fill('${esc(val)}');`;
        } else if (normalizedAction === "click") {
          playwrightCode = `await page.getByRole('button', { name: '${esc(targetDesc)}', exact: false }).or(page.getByText('${esc(targetDesc)}', { exact: false })).first().click();`;
        }
      }
    }
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
    }
  }
  if (captures.length === 0) return null;
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
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let executableCount = 0;
  for (const capture of captures) {
    const a = capture.step;
    const action = asText(a.action);
    const selector = asText(a.selector);
    const value = asText(a.value);
    const url = asText(a.url);
    const passed = isPassedStatus(capture.status);
    let emitted = false;
    if (passed && action === "navigate" && url) {
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

export default function AegisAgentPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

  const [phase, setPhase] = useState<PagePhase>("select");
  const [defaultEnvUrl, setDefaultEnvUrl] = useState("");
  const [defaultEnvName, setDefaultEnvName] = useState("");
  const [noEnvConfigured, setNoEnvConfigured] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTestcaseId, setActiveTestcaseId] = useState<string | null>(null);
  const [liveStreamFailed, setLiveStreamFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [chatPaneRatio, setChatPaneRatio] = useState(35);
  const [resizingPanes, setResizingPanes] = useState(false);
  const [pastTasks, setPastTasks] = useState<AgentTask[]>([]);
  const [backgroundRuns, setBackgroundRuns] = useState<AegisBackgroundRun[]>([]);
  const [activeTab, setActiveTab] = useState<"queue" | "in_progress" | "in_review" | "completed">("queue");
  const autoStartTriggered = useRef(false);

  const cancelledRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const logEntriesRef = useRef<LogEntry[]>([]);

  const completedCount = queue.filter((q) => q.status === "completed").length;
  const failedCount = queue.filter((q) => q.status === "failed").length;
  const runFinished = phase === "running" && queue.length > 0 && queue.every((q) => q.status !== "pending" && q.status !== "in_progress");

  const queuedTasks = pastTasks.filter((t) => t.status === "queued");
  const inProgressTasks = pastTasks.filter((t) => t.status === "in_progress" || t.status === "bot_reviewing");
  const inReviewTasks = pastTasks.filter((t) => t.status === "pending_review" || t.status === "needs_revision");
  const completedTasks = pastTasks.filter((t) => t.status === "approved" || t.status === "rejected");
  const runningBackgroundIds = new Set(backgroundRuns.filter((r) => r.status === "running").map((r) => r.testcaseId));
  const inProgressCount = runningBackgroundIds.size + inProgressTasks.filter((t) => !runningBackgroundIds.has(t.testcaseId)).length;
  const queuedCount = queuedTasks.filter((t) => !runningBackgroundIds.has(t.testcaseId)).length;
  const inReviewCount = inReviewTasks.length;
  const doneCount = completedTasks.length;

  const addLog = useCallback((testcaseId: string, message: string, type: LogEntry["type"] = "info") => {
    const entry: LogEntry = { ts: Date.now(), testcaseId, message, type };
    logEntriesRef.current = [...logEntriesRef.current, entry];
    setLog((prev) => [...prev, entry]);
  }, []);

  const logStagehandSessionEvent = useCallback(
    (testcaseId: string, event: AutomationSession["events"][number]) => {
      const parsed = asRecord(event?.parsedAction);
      const execution = asRecord(event?.executionResult);
      const eventType = asText(event?.eventType);

      if (eventType === "stagehand_plan_sent" || eventType === "stagehand_plan_compiled") {
        const plan = asRecordArray(parsed.stagehandPlan);
        if (plan.length > 0) {
          addLog(testcaseId, `Plan sent to Aegis (${plan.length} steps).`, "info");
          for (let i = 0; i < Math.min(plan.length, 10); i += 1) {
            const instruction = asText(plan[i].instruction);
            if (instruction) addLog(testcaseId, `Plan ${i + 1}: ${instruction}`, "info");
          }
        } else if (eventType === "stagehand_plan_sent") {
          addLog(testcaseId, "Plan sent to Aegis.", "info");
        }
        return;
      }

      if (eventType === "stagehand_execution_started") {
        addLog(testcaseId, "Aegis started Stagehand execution.", "action");
        return;
      }

      if (eventType === "stagehand_step_observed") {
        const stepId = asText(parsed.stepId) || "step";
        const instruction = asText(parsed.instruction);
        const chosenReason = asText(parsed.chosenReason);
        const message = instruction
          ? `Stagehand observing ${stepId}: ${instruction}`
          : `Stagehand observing ${stepId}.`;
        addLog(testcaseId, chosenReason ? `${message} (${chosenReason})` : message, "action");
        return;
      }

      if (eventType === "stagehand_step_acted") {
        const stepId = asText(parsed.stepId) || "step";
        const instruction = asText(parsed.instruction);
        const success = parsed.success === true;
        const cacheStatus = asText(parsed.cacheStatus);
        const message = asText(parsed.message);
        let text = instruction
          ? `Stagehand acting ${stepId}: ${instruction}`
          : `Stagehand acting ${stepId}.`;
        if (message) text += ` (${message})`;
        if (cacheStatus) text += ` [cache: ${cacheStatus}]`;
        addLog(testcaseId, text, success ? "success" : "error");
        return;
      }

      if (eventType === "stagehand_step_extracted") {
        const stepId = asText(parsed.stepId) || "step";
        const instruction = asText(parsed.instruction);
        const text = instruction
          ? `Stagehand verifying ${stepId}: ${instruction}`
          : `Stagehand verifying ${stepId}.`;
        addLog(testcaseId, text, "action");
        return;
      }

      if (eventType === "command_executed") {
        const mode = asText(parsed.mode);
        if (mode !== "stagehand") return;
        const telemetryEvents = asRecordArray(execution.telemetryEvents);
        if (telemetryEvents.length > 0) {
          addLog(testcaseId, `Stagehand logs captured: ${telemetryEvents.length} events.`, "info");
        }
      }
    },
    [addLog]
  );

  useEffect(() => {
    authMe().then((me) => {
      if (!me) { router.replace("/login"); return; }
      const settings = getAgentSettings(projectId, "aegis");
      if (settings.defaultEnvironmentUrl) {
        setDefaultEnvUrl(settings.defaultEnvironmentUrl);
        setDefaultEnvName(settings.defaultEnvironmentName || "");
      } else {
        getProject(projectId).then((p) => {
          const parsed = parseProjectSettings(asText(p.settings));
          const envs = normalizeTestRunEnvironments(parsed.testRunEnvironments);
          if (envs.length > 0) {
            setDefaultEnvUrl(envs[0].url);
            setDefaultEnvName(envs[0].name);
          } else {
            setNoEnvConfigured(true);
          }
        }).catch(() => {});
      }
    });
  }, [projectId, router]);

  useEffect(() => {
    const stored = getStoredAgentTasks(projectId, "aegis");
    setPastTasks(stored);
    setBackgroundRuns(getActiveRuns());

    const recovered = recoverOrphanedTasks(projectId);
    if (recovered > 0) {
      setPastTasks(getStoredAgentTasks(projectId, "aegis"));
      setBackgroundRuns(getActiveRuns());
      setActiveTab("in_progress");
    }

    return onRunsChanged(() => {
      setPastTasks(getStoredAgentTasks(projectId, "aegis"));
      setBackgroundRuns(getActiveRuns());
    });
  }, [projectId]);

  useEffect(() => {
    if (autoStartTriggered.current) return;
    const queued = getAegisAutoQueue(projectId);
    if (queued.length > 0) {
      clearAegisAutoQueue(projectId);
      autoStartTriggered.current = true;
      (async () => {
        for (const tcId of queued) {
          try {
            const tc = await getTestCase(projectId, tcId);
            const tcTitle = typeof tc.title === "string" ? tc.title : "Untitled";
            const tcExtId = typeof tc.externalId === "string" ? tc.externalId : tcId.slice(0, 8);
            runAegisInBackground(projectId, tcId, tcTitle, tcExtId, "ready_for_automation");
          } catch {}
        }
      })();
      setActiveTab("in_progress");
    }
  }, [projectId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  useEffect(() => {
    if (runFinished) setPhase("results");
  }, [runFinished]);

  const createReviewTask = (item: QueueItem, script: string | null, taskLogs: LogEntry[]) => {
    const now = new Date().toISOString();
    const currentTasks = getStoredAgentTasks(projectId, "aegis");
    const existingTask = currentTasks.find(
      (t) => t.testcaseId === item.testcaseId && (t.status === "in_progress" || t.status === "needs_revision")
    );

    const newLogs = taskLogs
      .filter((l) => l.testcaseId === item.testcaseId)
      .map((l) => ({ ts: new Date(l.ts).toISOString(), message: l.message, type: l.type }));

    const task: AgentTask = existingTask
      ? {
          ...existingTask,
          status: "pending_review",
          script: script || null,
          sessionId: item.sessionId || null,
          logs: newLogs,
          updatedAt: now,
          completedAt: now,
          duration: item.startedAt && item.endedAt ? item.endedAt - item.startedAt : undefined,
        }
      : {
          id: `task-${Date.now()}-${item.testcaseId}`,
          projectId,
          agentType: "aegis",
          testcaseId: item.testcaseId,
          testcaseTitle: item.title,
          testcaseExternalId: item.externalId,
          status: "pending_review",
          script: script || null,
          sessionId: item.sessionId || null,
          tracePath: null,
          videoPath: null,
          screenshotPath: null,
          logs: newLogs,
          feedback: [],
          createdAt: now,
          updatedAt: now,
          completedAt: now,
          duration: item.startedAt && item.endedAt ? item.endedAt - item.startedAt : undefined,
        };
    upsertAgentTask(projectId, "aegis", task);
    setPastTasks(getStoredAgentTasks(projectId, "aegis"));
    return task;
  };

  const processQueue = async (items: QueueItem[]) => {
    const mutableQueue = [...items];
    const updateItem = (idx: number, patch: Partial<QueueItem>) => {
      mutableQueue[idx] = { ...mutableQueue[idx], ...patch };
      setQueue([...mutableQueue]);
    };

    for (let i = 0; i < mutableQueue.length; i++) {
      if (cancelledRef.current) {
        for (let j = i; j < mutableQueue.length; j++) updateItem(j, { status: "cancelled" });
        break;
      }

      updateItem(i, { status: "in_progress", startedAt: Date.now() });
      const item = mutableQueue[i];
      addLog(item.testcaseId, `Starting automation for "${item.title}"...`, "info");

      try {
        const tc = await getTestCase(projectId, item.testcaseId);
        const currentTasks = getStoredAgentTasks(projectId, "aegis");
        const previousTask = currentTasks.find(
          (t) => t.testcaseId === item.testcaseId && t.feedback.length > 0 && (t.status === "in_progress" || t.status === "needs_revision")
        );
        const reviewerFeedback = previousTask?.feedback.map((fb) => fb.message);
        const previousScript = previousTask?.script ?? null;
        if (reviewerFeedback && reviewerFeedback.length > 0) {
          addLog(item.testcaseId, `Revision run — applying ${reviewerFeedback.length} feedback item${reviewerFeedback.length > 1 ? "s" : ""} from reviewer.`, "action");
        }
        const intent = buildIntentObjective(tc, reviewerFeedback, previousScript);
        addLog(item.testcaseId, "Creating browser session...", "info");

        const { id: sessionId } = await startAutomationSession(projectId, item.testcaseId, { startUrl: defaultEnvUrl });
        updateItem(i, { sessionId });
        setActiveSessionId(sessionId);
        setActiveTestcaseId(item.testcaseId);
        setLiveStreamFailed(false);

        addLog(item.testcaseId, "Session created. Sending autonomous command...", "info");
        await sendAutomationCommand(projectId, sessionId, intent);
        addLog(item.testcaseId, "Agent is executing the test case...", "action");
        const handledEventIds = new Set<string>();

        let finished = false;
        let pollCount = 0;
        const maxPolls = 300;
        while (!finished && pollCount < maxPolls && !cancelledRef.current) {
          await new Promise((r) => setTimeout(r, 2000));
          pollCount++;
          try {
            const session = await getAutomationSession(projectId, sessionId);
            if (Array.isArray(session.events) && session.events.length > 0) {
              for (const event of session.events) {
                const eventId = asText(event?.id);
                if (!eventId || handledEventIds.has(eventId)) continue;
                handledEventIds.add(eventId);
                logStagehandSessionEvent(item.testcaseId, event);
              }
            }
            const runtime = session.runtime;
            if (!runtime?.isRunning && (runtime?.queuedCount ?? 0) === 0) {
              finished = true;
              const script = extractGeneratedScript(session);
              if (script) {
                try {
                  await finalizeAutomationSession(projectId, sessionId, { script });
                  addLog(item.testcaseId, "Script generated and saved.", "success");
                } catch {
                  addLog(item.testcaseId, "Script generated but save to test case failed.", "error");
                }
                updateItem(i, { status: "completed", script, endedAt: Date.now() });
                addLog(item.testcaseId, `Completed "${item.title}".`, "success");
              } else {
                updateItem(i, { status: "completed", endedAt: Date.now() });
                addLog(item.testcaseId, `Completed "${item.title}" (no script actions captured).`, "success");
              }
              addLog(item.testcaseId, "Creating review task...", "info");
              createReviewTask(mutableQueue[i], script ?? null, logEntriesRef.current);
              addLog(item.testcaseId, "Review task created. Awaiting your review.", "success");
            }
          } catch (err) {
            finished = true;
            const msg = err instanceof Error ? err.message : "Session polling failed";
            updateItem(i, { status: "failed", error: msg, endedAt: Date.now() });
            addLog(item.testcaseId, `Failed: ${msg}`, "error");
          }
        }

        if (!finished && !cancelledRef.current) {
          updateItem(i, { status: "failed", error: "Timed out waiting for completion", endedAt: Date.now() });
          addLog(item.testcaseId, "Timed out waiting for completion.", "error");
        }

        if (cancelledRef.current && !finished) {
          try { await cancelAutomationSession(projectId, sessionId); } catch {}
          updateItem(i, { status: "cancelled", endedAt: Date.now() });
          addLog(item.testcaseId, "Cancelled.", "info");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to start session";
        updateItem(i, { status: "failed", error: msg, endedAt: Date.now() });
        addLog(item.testcaseId, `Failed: ${msg}`, "error");
      }
    }

    setActiveSessionId(null);
    setActiveTestcaseId(null);
  };

  const handleStop = () => {
    setStopping(true);
    cancelledRef.current = true;
  };

  const liveStreamUrl = activeSessionId
    ? `${apiBase}/api/projects/${projectId}/automation/sessions/${activeSessionId}/live`
    : null;

  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizingPanes(true);
    const startX = e.clientX;
    const startRatio = chatPaneRatio;
    const container = splitPaneRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newRatio = Math.max(20, Math.min(60, startRatio + (delta / containerWidth) * 100));
      setChatPaneRatio(newRatio);
    };
    const onUp = () => {
      setResizingPanes(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // --- RENDER ---

  if (phase === "select") {
    const tabs = [
      { id: "queue" as const, label: "Queue", count: queuedCount, pulse: false },
      { id: "in_progress" as const, label: "In Progress", count: inProgressCount, pulse: runningBackgroundIds.size > 0 },
      { id: "in_review" as const, label: "In Review", count: inReviewCount, pulse: false },
      { id: "completed" as const, label: "Completed", count: doneCount, pulse: false },
    ];

    return (
      <div className="flex-1 p-6 md:p-10 max-w-6xl mx-auto w-full">
        <AegisBackgroundIndicator />
        {/* Header */}
        <div className="mb-6">
          <Link href={`/projects/${projectId}/agents`} className="text-sm text-[var(--muted)] hover:text-[var(--primary)] mb-2 inline-flex items-center gap-1">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Agents
          </Link>
          <div className="flex items-center justify-between mt-1">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)]">
                <ShieldIcon className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-[var(--foreground)]">Aegis</h1>
                <p className="text-sm text-[var(--muted)]">Test Automation Architect</p>
              </div>
            </div>
            <Link
              href={`/projects/${projectId}/agents/aegis/settings`}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-1.5"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 border-b border-[var(--border)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                activeTab === tab.id
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)] hover:border-zinc-300"
              }`}
            >
              {tab.id === "in_progress" && tab.pulse && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                </span>
              )}
              {tab.label}
              {tab.count > 0 && (
                <span className={`ml-1 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs ${
                  activeTab === tab.id
                    ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                    : tab.id === "in_progress" && tab.count > 0
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                      : tab.id === "in_review" && tab.count > 0
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                        : "bg-zinc-100 dark:bg-zinc-800 text-[var(--muted)]"
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ========== QUEUE TAB ========== */}
        {activeTab === "queue" && (
          <>
            {noEnvConfigured && (
              <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
                <div className="flex items-start gap-2">
                  <svg className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">No default environment configured</p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                      Configure an environment in{" "}
                      <Link href={`/projects/${projectId}/agents/aegis/settings`} className="underline font-medium">
                        Aegis Settings
                      </Link>{" "}
                      or{" "}
                      <Link href={`/projects/${projectId}/settings`} className="underline font-medium">
                        Project Settings
                      </Link>{" "}
                      to start automating.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {queuedTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 mx-auto mb-3">
                  <svg className="h-6 w-6 text-[var(--muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[var(--foreground)] mb-1">No tasks in queue</p>
                <p className="text-xs text-[var(--muted)] max-w-md mx-auto">
                  Tasks enter the queue automatically when test cases are marked &quot;Ready for Automation&quot;,
                  when you send revision feedback, or when you click &quot;Add to Aegis Queue&quot; from the test case repository.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {queuedTasks.map((task) => {
                  const sourceConfig: Record<string, { label: string; cls: string; icon: string }> = {
                    ready_for_automation: { label: "Ready for Automation", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
                    revision: { label: "Revision", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", icon: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" },
                    manual: { label: "Manually Queued", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", icon: "M12 6v6m0 0v6m0-6h6m-6 0H6" },
                    failed_fix: { label: "Failed — Fix Script", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400", icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" },
                  };
                  const source = sourceConfig[task.queueSource || "manual"] || sourceConfig.manual;
                  return (
                    <div
                      key={task.id}
                      className="flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
                    >
                      <div className="shrink-0">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <svg className="h-5 w-5 text-zinc-500 dark:text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${source.cls}`}>
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={source.icon} />
                            </svg>
                            {source.label}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-[var(--foreground)] truncate">
                          {task.testcaseTitle}
                        </div>
                        <div className="text-xs text-[var(--muted)] mt-0.5">
                          Added {new Date(task.createdAt).toLocaleString()}
                          {task.feedback.length > 0 && ` · ${task.feedback.length} prior feedback${task.feedback.length > 1 ? "s" : ""}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ========== IN PROGRESS TAB ========== */}
        {activeTab === "in_progress" && (
          <>
            {inProgressCount === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 mx-auto mb-3">
                  <svg className="h-6 w-6 text-[var(--muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[var(--foreground)] mb-1">No tasks in progress</p>
                <p className="text-xs text-[var(--muted)]">
                  When Aegis is working on test cases, they will appear here with real-time status.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Background runs (actively executing right now) */}
                {backgroundRuns.filter((r) => r.status === "running").map((run) => (
                  <Link
                    key={`bg-${run.testcaseId}`}
                    href={`/projects/${projectId}/agents/aegis/reviews/${run.taskId}`}
                    className="flex items-center gap-4 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 p-4 transition-all hover:border-blue-400 hover:shadow-sm group cursor-pointer"
                  >
                    <div className="shrink-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                        <span className="h-5 w-5 flex items-center justify-center">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                          </span>
                          {run.phase === "bot_reviewing" ? "Bot Reviewing" : "Running"}
                        </span>
                      </div>
                      <div className="text-sm font-medium text-[var(--foreground)] group-hover:text-[var(--primary)] truncate">
                        {run.title}
                      </div>
                      <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                        Click to observe bot activity and live preview
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/30 px-2.5 py-1 text-xs text-blue-600 dark:text-blue-400 font-medium">
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        Observe
                      </span>
                      <svg className="h-5 w-5 text-[var(--muted)] group-hover:text-[var(--primary)] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </Link>
                ))}

                {/* Stored in_progress tasks not covered by background runs */}
                {inProgressTasks
                  .filter((t) => !runningBackgroundIds.has(t.testcaseId))
                  .map((task) => (
                    <Link
                      key={task.id}
                      href={`/projects/${projectId}/agents/aegis/reviews/${task.id}`}
                      className="flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-all hover:border-[var(--primary)] hover:shadow-sm group"
                    >
                      <div className="shrink-0">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                          <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            {task.status === "queued" ? "Queued" : task.status === "bot_reviewing" ? "Bot Reviewing" : "In Progress"}
                          </span>
                          {task.feedback.length > 0 && (
                            <span className="text-xs text-[var(--muted)]">
                              Revision #{task.feedback.length}
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium text-[var(--foreground)] group-hover:text-[var(--primary)] truncate">
                          {task.testcaseTitle}
                        </div>
                        <div className="text-xs text-[var(--muted)] mt-0.5">
                          Started {new Date(task.updatedAt || task.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <svg className="h-5 w-5 text-[var(--muted)] group-hover:text-[var(--primary)] transition-colors shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  ))}
              </div>
            )}
          </>
        )}

        {/* ========== IN REVIEW TAB ========== */}
        {activeTab === "in_review" && (
          <>
            {inReviewTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 mx-auto mb-3">
                  <svg className="h-6 w-6 text-[var(--muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[var(--foreground)] mb-1">No tasks pending review</p>
                <p className="text-xs text-[var(--muted)]">
                  Run Aegis on test cases to generate scripts. They will appear here for your review.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {inReviewTasks.map((task) => (
                  <Link
                    key={task.id}
                    href={`/projects/${projectId}/agents/aegis/reviews/${task.id}`}
                    className="flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-all hover:border-[var(--primary)] hover:shadow-sm group"
                  >
                    <div className="shrink-0">
                      {task.status === "pending_review" ? (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                          <svg className="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                          <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          task.status === "pending_review"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        }`}>
                          {task.status === "pending_review" ? "Pending Review" : "Needs Revision"}
                        </span>
                        {task.feedback.length > 0 && (
                          <span className="text-xs text-[var(--muted)]">
                            {task.feedback.length} feedback{task.feedback.length > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-medium text-[var(--foreground)] group-hover:text-[var(--primary)] truncate">
                        {task.testcaseTitle}
                      </div>
                      <div className="text-xs text-[var(--muted)] mt-0.5">
                        {task.completedAt
                          ? `Completed ${new Date(task.completedAt).toLocaleString()}`
                          : `Created ${new Date(task.createdAt).toLocaleString()}`}
                        {task.duration ? ` · ${(task.duration / 1000).toFixed(1)}s` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {task.script && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 text-xs text-[var(--muted)]">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                          </svg>
                          Script
                        </span>
                      )}
                      <svg className="h-5 w-5 text-[var(--muted)] group-hover:text-[var(--primary)] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}

        {/* ========== COMPLETED TAB ========== */}
        {activeTab === "completed" && (
          <>
            {completedTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 mx-auto mb-3">
                  <svg className="h-6 w-6 text-[var(--muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[var(--foreground)] mb-1">No completed tasks yet</p>
                <p className="text-xs text-[var(--muted)]">
                  Tasks move here after you approve the generated scripts in the review tab.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {completedTasks.map((task) => (
                  <Link
                    key={task.id}
                    href={`/projects/${projectId}/agents/aegis/reviews/${task.id}`}
                    className="flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-all hover:border-[var(--primary)] hover:shadow-sm group"
                  >
                    <div className="shrink-0">
                      {task.status === "approved" ? (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                          <svg className="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                          <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          task.status === "approved"
                            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        }`}>
                          {task.status === "approved" ? "Approved" : "Rejected"}
                        </span>
                      </div>
                      <div className="text-sm font-medium text-[var(--foreground)] group-hover:text-[var(--primary)] truncate">
                        {task.testcaseTitle}
                      </div>
                      <div className="text-xs text-[var(--muted)] mt-0.5">
                        {task.completedAt
                          ? `Completed ${new Date(task.completedAt).toLocaleString()}`
                          : `Created ${new Date(task.createdAt).toLocaleString()}`}
                        {task.duration ? ` · ${(task.duration / 1000).toFixed(1)}s` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {task.status === "approved" && task.script && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/20 px-2.5 py-1 text-xs text-green-700 dark:text-green-400">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                          </svg>
                          Script Saved
                        </span>
                      )}
                      {task.status === "rejected" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-900/20 px-2.5 py-1 text-xs text-red-700 dark:text-red-400">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Discarded
                        </span>
                      )}
                      <svg className="h-5 w-5 text-[var(--muted)] group-hover:text-[var(--primary)] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // --- RUN SCREEN / RESULTS ---

  const activeItem = queue.find((q) => q.testcaseId === activeTestcaseId);
  const progressPercent = queue.length > 0 ? Math.round(((completedCount + failedCount) / queue.length) * 100) : 0;

  return (
    <div className="flex flex-col h-screen">
      {/* Top Bar */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)]">
            <ShieldIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--foreground)]">Aegis</h1>
            <p className="text-xs text-[var(--muted)]">
              {phase === "results"
                ? `Completed — ${completedCount}/${queue.length} passed`
                : activeItem
                  ? `Processing: ${activeItem.title}`
                  : "Starting..."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {phase === "running" && !runFinished && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="rounded-lg border border-red-300 dark:border-red-700 px-4 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              {stopping ? "Stopping..." : "Stop Agent"}
            </button>
          )}
          {phase === "results" && (
            <>
              <button
                onClick={() => { setPhase("select"); setQueue([]); setLog([]); setActiveTab("in_review"); setPastTasks(getStoredAgentTasks(projectId, "aegis")); }}
                className="rounded-lg bg-[var(--primary)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 transition-opacity"
              >
                Review Tasks ({inReviewCount})
              </button>
              <button
                onClick={() => { setPhase("select"); setQueue([]); setLog([]); setActiveTab("queue"); }}
                className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                New Run
              </button>
            </>
          )}
          <Link
            href={`/projects/${projectId}/agents`}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Close
          </Link>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="h-1 bg-zinc-100 dark:bg-zinc-800 shrink-0">
        <div
          className={`h-full transition-all duration-500 ${failedCount > 0 && completedCount === 0 ? "bg-red-500" : "bg-[var(--primary)]"}`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Split pane */}
      <div ref={splitPaneRef} className="flex flex-1 min-h-0 overflow-hidden" style={{ userSelect: resizingPanes ? "none" : undefined }}>
        {/* Left Panel */}
        <div className="flex flex-col border-r border-[var(--border)] overflow-hidden" style={{ width: `${chatPaneRatio}%` }}>
          {/* Queue List */}
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] px-1 mb-2">
              Test Cases ({completedCount + failedCount}/{queue.length})
            </p>
            {queue.map((item) => (
              <div
                key={item.testcaseId}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  item.testcaseId === activeTestcaseId
                    ? "bg-[#e8f5eb] dark:bg-zinc-800 ring-1 ring-[var(--primary)]/30"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
                }`}
              >
                <StatusIcon status={item.status} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[var(--foreground)] truncate">{item.title}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {item.status === "completed" && item.script ? "Script generated → Review" : ""}
                    {item.status === "completed" && !item.script ? "No script → Review" : ""}
                    {item.status === "failed" ? item.error || "Failed" : ""}
                    {item.status === "in_progress" ? "Running..." : ""}
                    {item.status === "pending" ? "Waiting" : ""}
                    {item.status === "cancelled" ? "Cancelled" : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Log */}
          <div className="border-t border-[var(--border)] flex flex-col" style={{ height: "40%" }}>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] px-4 py-2 shrink-0">
              Activity Log
            </p>
            <div ref={logRef} className="flex-1 overflow-y-auto px-4 pb-3 space-y-1">
              {log.map((entry, i) => (
                <div key={i} className="text-xs leading-relaxed">
                  <span className="text-[var(--muted)]">{new Date(entry.ts).toLocaleTimeString()} </span>
                  <span className={
                    entry.type === "success" ? "text-green-600 dark:text-green-400" :
                    entry.type === "error" ? "text-red-600 dark:text-red-400" :
                    entry.type === "action" ? "text-[var(--primary)]" :
                    "text-[var(--foreground)]"
                  }>
                    {entry.message}
                  </span>
                </div>
              ))}
              {log.length === 0 && (
                <p className="text-xs text-[var(--muted)] italic">Waiting for activity...</p>
              )}
            </div>
          </div>
        </div>

        {/* Resize Handle */}
        <div
          onMouseDown={handleSplitMouseDown}
          className="w-1.5 cursor-col-resize bg-[var(--border)] hover:bg-[var(--primary)]/40 transition-colors shrink-0"
        />

        {/* Right Panel - Browser Preview */}
        <div className="flex-1 flex flex-col bg-zinc-100 dark:bg-zinc-900 min-w-0">
          {phase === "results" ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-lg w-full text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)] mx-auto mb-4">
                  <ShieldIcon className="h-9 w-9" />
                </div>
                <h2 className="text-xl font-bold text-[var(--foreground)] mb-1">Run Complete</h2>
                <p className="text-sm text-[var(--muted)] mb-2">
                  {completedCount} of {queue.length} test case{queue.length > 1 ? "s" : ""} automated
                  {failedCount > 0 ? ` (${failedCount} failed)` : ""}.
                </p>
                <p className="text-sm text-amber-600 dark:text-amber-400 font-medium mb-6">
                  {completedCount > 0 ? `${completedCount} review task${completedCount > 1 ? "s" : ""} created. Please review the generated scripts.` : ""}
                </p>
                <div className="space-y-2 text-left mb-6">
                  {queue.map((item) => (
                    <div key={item.testcaseId} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                      <StatusIcon status={item.status} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[var(--foreground)]">{item.title}</div>
                        <div className="text-xs text-[var(--muted)] mt-0.5">
                          {item.externalId}
                          {item.endedAt && item.startedAt ? ` · ${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s` : ""}
                        </div>
                        {item.status === "failed" && item.error && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1">{item.error}</div>
                        )}
                        {item.status === "completed" && (
                          <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">Pending review</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { setPhase("select"); setQueue([]); setLog([]); setActiveTab("in_review"); setPastTasks(getStoredAgentTasks(projectId, "aegis")); }}
                  className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 transition-opacity"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                  Go to Review Queue
                </button>
              </div>
            </div>
          ) : liveStreamUrl && !liveStreamFailed ? (
            <div className="flex-1 flex items-center justify-center p-2 overflow-hidden">
              <img
                src={liveStreamUrl}
                alt="Live browser preview"
                className="max-w-full max-h-full object-contain rounded-lg shadow-lg border border-[var(--border)]"
                onError={() => setLiveStreamFailed(true)}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent mx-auto mb-3" />
                <p className="text-sm text-[var(--muted)]">
                  {liveStreamFailed ? "Browser preview unavailable" : "Connecting to browser..."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
