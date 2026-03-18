"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  authMe,
  getProject,
  getTestCase,
  startAutomationSession,
  sendAutomationCommand,
  getAutomationSession,
  getAutomationStreamState,
  resetAutomationSession,
  finalizeAutomationSession,
  cancelAutomationSession,
  stopAutomationCommand,
  sendAutomationManualAction,
  getAutomationRecording,
  type AutomationSession,
  type TestEnvironmentSetting,
  type RecordingAction,
  type RecordingSummary,
  type ReasoningEntry,
} from "@/lib/api";

type ChatMessage = {
  role: "user" | "assistant" | "recording" | "reasoning";
  content: string;
  recordingMeta?: {
    action: string;
    playwright: string;
    target?: string;
    value?: string;
    status?: "success" | "failed" | "assertion";
  };
  reasoningMeta?: {
    stepId: string | null;
    url: string | null;
    timestamp: string;
  };
};

type AutomationMode = "autonomous" | "live";

type TimelineItem = {
  timeLabel: string;
  actionLabel: string;
  primary?: string;
  secondary?: string;
  tertiary?: string;
};

type ReviewStep = {
  id: string;
  action: string;
  expectedResult: string;
  playwright: string;
  status?: string;
};

type SessionStartupState = "select-environment" | "starting" | "waiting-stream" | "ready";
type BotHighlight = {
  xRatio: number;
  yRatio: number;
  widthRatio?: number;
  heightRatio?: number;
  label?: string;
};
type AutomateEntryMode = "smart" | "autonomous" | "assisted" | "manual";

type TestCaseIntentDetails = {
  title: string;
  description: string;
  preconditions: string;
  testData: string;
  stepsSummary: string[];
};

export default function AutomateTestCasePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const testcaseId = params.tcId as string;
  const bootstrap = useMemo(
    () => ({
      sessionId: searchParams.get("sessionId"),
      openInLivePreview: searchParams.get("livePreview") === "1",
      entry: (() => {
        const raw = (searchParams.get("entry") || "").toLowerCase();
        if (raw === "autonomous" || raw === "assisted" || raw === "manual") {
          return raw as AutomateEntryMode;
        }
        if (raw === "smart") {
          return "assisted";
        }
        return "assisted" as AutomateEntryMode;
      })(),
    }),
    [searchParams]
  );
  const bootstrapSessionId = bootstrap.sessionId;
  const openInLivePreview = bootstrap.openInLivePreview;
  const bootstrapEntryMode = bootstrap.entry;

  const [testcaseTitle, setTestcaseTitle] = useState("Test Case");
  const [testcaseIntentDetails, setTestcaseIntentDetails] = useState<TestCaseIntentDetails>({
    title: "Test Case",
    description: "",
    preconditions: "",
    testData: "",
    stepsSummary: [],
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [stoppingCommand, setStoppingCommand] = useState(false);
  const [chatPaneRatio, setChatPaneRatio] = useState(26);
  const [resizingPanes, setResizingPanes] = useState(false);
  const [desktopSplitEnabled, setDesktopSplitEnabled] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [confirmFinalizeOpen, setConfirmFinalizeOpen] = useState(false);
  const [reviewSteps, setReviewSteps] = useState<ReviewStep[]>([]);
  const [streamState, setStreamState] = useState<"Connecting" | "Live" | "Lagging" | "Disconnected">("Connecting");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<AutomationMode>("live");
  const [sessionStartupState, setSessionStartupState] = useState<SessionStartupState>("select-environment");
  const [sessionStartupError, setSessionStartupError] = useState<string | null>(null);
  const [liveStreamFailed, setLiveStreamFailed] = useState(false);
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [sessionStartUrl, setSessionStartUrl] = useState("");
  const [selectedEnvironmentUrl, setSelectedEnvironmentUrl] = useState("");
  const [customEnvironmentUrl, setCustomEnvironmentUrl] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [quickActionBusy, setQuickActionBusy] = useState<"run" | null>(null);
  const [reviewScriptOpen, setReviewScriptOpen] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [aiProvider, setAiProvider] = useState<"openai" | "anthropic">("openai");
  const [lastClickTarget, setLastClickTarget] = useState<{ xRatio: number; yRatio: number } | null>(null);
  const [cursorPulse, setCursorPulse] = useState(false);
  const [botHighlight, setBotHighlight] = useState<BotHighlight | null>(null);
  const dragStartRef = useRef<{ xRatio: number; yRatio: number } | null>(null);
  const suppressClickRef = useRef(false);
  const lastScrollAtRef = useRef(0);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const liveViewportRef = useRef<HTMLDivElement | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const keyQueueRef = useRef<Array<{ actionType: "press" | "type"; key?: string; text?: string }>>([]);
  const processingKeyQueueRef = useRef(false);
  const streamedAutonomousEventIdsRef = useRef<Set<string>>(new Set());
  const streamedTimelineEntriesRef = useRef<Set<string>>(new Set());
  const lastRecordingActionCountRef = useRef(0);
  const lastReasoningCountRef = useRef(0);
  const [recordingSummary, setRecordingSummary] = useState<RecordingSummary | null>(null);
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";
  const verboseAutonomousEvents = process.env.NEXT_PUBLIC_AUTONOMOUS_VERBOSE_EVENTS === "true";
  const showAutonomousDebugTrace = verboseAutonomousEvents;
  const isLiveMode = mode === "live";
  const isAutonomousMode = mode === "autonomous";
  const startupReady = sessionStartupState === "ready";
  const selectedStartUrl = (selectedEnvironmentUrl || customEnvironmentUrl).trim();
  const runtimeInfo = session?.runtime;
  const commandInProgress = Boolean(runtimeInfo?.isRunning);

  function asText(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  function isDropdownStep(step: Record<string, unknown>): boolean {
    const selector = asText(step.selector).toLowerCase();
    const target = asText(step.targetDescription).toLowerCase();
    return (
      selector.includes("select") ||
      selector.includes("combobox") ||
      target.includes("dropdown") ||
      target.includes("select")
    );
  }

  function stepTarget(step: Record<string, unknown>): string {
    const targetDescription = asText(step.targetDescription).trim();
    const expectedText = asText(step.expectedText).trim();
    const selector = asText(step.selector).trim();
    if (targetDescription) return `"${targetDescription}"`;
    if (expectedText) return `"${expectedText}"`;
    if (selector) return `"${selector}"`;
    return "the target element";
  }

  function describeStepLine(step: Record<string, unknown>, index: number): string {
    const action = asText(step.action).trim().toLowerCase();
    const target = stepTarget(step);
    const value = asText(step.value).trim();
    const expectedText = asText(step.expectedText).trim();
    const url = asText(step.url).trim();
    switch (action) {
      case "navigate":
        return `${index}. Open ${url || "the target URL"}.`;
      case "click":
        return `${index}. Click ${target}.`;
      case "type":
        if (isDropdownStep(step)) {
          return `${index}. This is a dropdown, so select ${value ? `"${value}"` : "the right option"} from ${target}.`;
        }
        return `${index}. Enter ${value ? `"${value}"` : "the required value"} into ${target}.`;
      case "assert_visible":
        return `${index}. Verify ${target} is visible.`;
      case "assert_text":
        return `${index}. Verify text ${expectedText ? `"${expectedText}"` : "matches expected output"}.`;
      case "assert_clickable":
        return `${index}. Verify ${target} is clickable.`;
      default:
        return `${index}. Perform ${action || "the planned"} action.`;
    }
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

  function parseTestCaseSteps(raw: unknown): string[] {
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((step) => {
          const candidate = step as { action?: unknown; expectedResult?: unknown };
          const action = typeof candidate.action === "string" ? candidate.action.trim() : "";
          const expectedResult =
            typeof candidate.expectedResult === "string" ? candidate.expectedResult.trim() : "";
          if (!action && !expectedResult) return "";
          if (action && expectedResult) return `${action} -> Expect: ${expectedResult}`;
          return action || `Expect: ${expectedResult}`;
        })
        .filter((line): line is string => Boolean(line));
    } catch {
      return [];
    }
  }

  function buildIntentObjective(details: TestCaseIntentDetails): string {
    const lines: string[] = [];
    const title = details.title.trim() || "Untitled test case";
    lines.push(`Run and automate this test case: "${title}".`);
    if (details.description.trim()) {
      lines.push(`Intent/Description: ${details.description.trim()}`);
    }
    if (details.preconditions.trim()) {
      lines.push(`Preconditions: ${details.preconditions.trim()}`);
    }
    if (details.testData.trim()) {
      lines.push(`Test data: ${details.testData.trim()}`);
    }
    if (details.stepsSummary.length > 0) {
      lines.push("Steps to follow:");
      details.stepsSummary.forEach((step, idx) => {
        lines.push(`${idx + 1}. ${step}`);
      });
    }
    lines.push(
      "Use this intent to execute the flow end-to-end, adapt to current DOM when needed, and generate robust assertions for expected outcomes."
    );
    return lines.join("\n");
  }

  function bootstrapMessageForEntry(entry: AutomateEntryMode): string {
    if (entry === "autonomous") {
      return "AI Assisted mode selected. Chat guidance is active with live preview.";
    }
    if (entry === "assisted") {
      return "AI Assisted mode selected. Use guided commands while watching live browser, and intervene whenever needed.";
    }
    if (entry === "manual") {
      return "Manual Live mode selected. Interact directly on the browser and use assistant suggestions for assertions.";
    }
    return "AI Assisted mode selected. Provide guidance in chat and watch execution in live preview.";
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

  function resolveAiConfiguration(parsedSettings: Record<string, unknown>): {
    configured: boolean;
    provider: "openai" | "anthropic";
  } {
    const aiRaw = parsedSettings.ai as Record<string, unknown> | undefined;
    const provider = aiRaw?.provider === "anthropic" ? "anthropic" : "openai";
    const openAiApiKey = typeof aiRaw?.openAiApiKey === "string" ? aiRaw.openAiApiKey.trim() : "";
    const anthropicApiKey = typeof aiRaw?.anthropicApiKey === "string" ? aiRaw.anthropicApiKey.trim() : "";
    const configured = provider === "anthropic" ? anthropicApiKey.length > 0 : openAiApiKey.length > 0;
    return { configured, provider };
  }

  function buildPlaywrightScriptFromReviewSteps(testName: string, steps: ReviewStep[]): string {
    const lines: string[] = [
      "import { test, expect } from '@playwright/test';",
      "",
      `test('${testName.replace(/\\/g, "\\\\").replace(/'/g, "\\'") || "generated automation test"}', async ({ page }) => {`,
    ];
    if (steps.length === 0) {
      lines.push("  // No recorded actions were available. Add steps manually.");
    } else {
      for (const step of steps) {
        const parts = step.playwright.split("\n");
        for (const part of parts) {
          lines.push(`  ${part}`);
        }
      }
    }
    lines.push("  await expect(page).toHaveURL(/.*/);");
    lines.push("});");
    return lines.join("\n");
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  function isPassedStatus(value: unknown): boolean {
    const normalized = asText(value).toLowerCase();
    return normalized === "passed" || normalized === "success";
  }

  function isTextInputLike(step: Record<string, unknown>): boolean {
    const selector = asText(step.selector).toLowerCase();
    const targetHtml = asText(step.targetHtml).toLowerCase();
    return (
      selector.startsWith("input") ||
      selector.startsWith("textarea") ||
      selector.includes("input[") ||
      selector.includes("textarea") ||
      targetHtml.includes("<input") ||
      targetHtml.includes("<textarea")
    );
  }

  function humanizeToken(raw: string): string {
    const normalized = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return "";
    return normalized
      .split(" ")
      .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : ""))
      .join(" ");
  }

  function extractFriendlyName(selectorRaw: string): string {
    const selector = selectorRaw.trim();
    if (!selector) return "";
    const attrs = ["name", "aria-label", "placeholder"];
    for (const attr of attrs) {
      const quoted = new RegExp(`${attr}=['"]([^'"]+)['"]`, "i").exec(selector);
      if (quoted?.[1]) return humanizeToken(quoted[1]);
      const bare = new RegExp(`${attr}=([^\\],\\s]+)`, "i").exec(selector);
      if (bare?.[1]) return humanizeToken(bare[1]);
    }
    if (selector.startsWith("#")) return humanizeToken(selector.slice(1));
    if (selector.startsWith(".")) return humanizeToken(selector.slice(1));
    return "";
  }

  function friendlyClickTarget(parsed: Record<string, unknown>): string {
    const targetText = humanizeToken(asText(parsed.targetText));
    if (targetText) return targetText;
    const selector = asText(parsed.selector);
    const fromSelector = extractFriendlyName(selector);
    if (!fromSelector) return "";
    return isTextInputLike(parsed) ? `${fromSelector} text box` : fromSelector;
  }

  function friendlyInputTarget(parsed: Record<string, unknown>): string {
    const targetText = humanizeToken(asText(parsed.targetText));
    if (targetText) return `${targetText} text box`;
    const selector = asText(parsed.selector);
    const fromSelector = extractFriendlyName(selector);
    return fromSelector ? `${fromSelector} text box` : "";
  }

  function normalizeSelector(value: unknown): string {
    const selector = asText(value).trim();
    if (!selector) return "";
    if (selector.startsWith("xpath:")) return `xpath=${selector.slice("xpath:".length)}`;
    return selector;
  }

  function runtimeSelectorToSelector(runtimeSelectorUsed: string): string {
    if (runtimeSelectorUsed.startsWith("selector:")) return runtimeSelectorUsed.slice("selector:".length).trim();
    if (runtimeSelectorUsed.startsWith("xpath:")) return `xpath=${runtimeSelectorUsed.slice("xpath:".length).trim()}`;
    return "";
  }

  function runtimeSelectorToTarget(runtimeSelectorUsed: string): string {
    const idx = runtimeSelectorUsed.lastIndexOf(":");
    if (idx < 0 || idx + 1 >= runtimeSelectorUsed.length) return "";
    return runtimeSelectorUsed.slice(idx + 1).trim();
  }

  function mergeStepWithResult(
    stepRaw: Record<string, unknown>,
    resultRaw: Record<string, unknown>
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...stepRaw };
    const runtimeSelectorUsed = asText(resultRaw.selectorUsed);
    if (runtimeSelectorUsed) {
      merged.runtimeSelectorUsed = runtimeSelectorUsed;
      if (!asText(merged.selector)) {
        const derivedSelector = runtimeSelectorToSelector(runtimeSelectorUsed);
        if (derivedSelector) merged.selector = derivedSelector;
      }
      if (!asText(merged.targetDescription)) {
        const derivedTarget = runtimeSelectorToTarget(runtimeSelectorUsed);
        if (derivedTarget) merged.targetDescription = derivedTarget;
      }
      if (asText(merged.action) === "assert_text" && !asText(merged.expectedText)) {
        const derivedExpected = runtimeSelectorToTarget(runtimeSelectorUsed);
        if (derivedExpected) merged.expectedText = derivedExpected;
      }
    }
    const status = asText(resultRaw.status);
    if (status) merged.__status = status;
    const message = asText(resultRaw.message);
    if (message) merged.__message = message;
    return merged;
  }

  function cleanLocatorLabel(raw: string): string {
    let label = raw;
    const intoMatch = label.match(/(?:type|enter|fill)\s+.+?\s+into\s+(?:the\s+)?(.+)/i);
    if (intoMatch) label = intoMatch[1];
    return label
      .replace(/\s*[-–—]\s*.+$/, "")
      .replace(/\b(field|input|textbox|text\s*box)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() || raw.trim();
  }

  function playwrightLineForAction(parsed: Record<string, unknown>): string {
    const actionRaw = asText(parsed.action).toLowerCase();
    const action =
      actionRaw === "act"
        ? (() => {
            const value = asText(parsed.value);
            const target = `${asText(parsed.targetDescription)} ${asText(parsed.selector)}`.toLowerCase();
            if (value) return "type";
            if (target.includes("password") || target.includes("email") || target.includes("input")) return "type";
            return "click";
          })()
        : actionRaw;
    if (action === "navigate") {
      const url = asText(parsed.url);
      return url ? `await page.goto('${url.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');` : "// navigate step unavailable";
    }
    if (action === "click") {
      const selector = asText(parsed.selector);
      const targetDescription = asText(parsed.targetDescription);
      if (selector) {
        return `await page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first().click();`;
      }
      if (targetDescription) {
        const label = cleanLocatorLabel(targetDescription);
        const escaped = label.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return `await page.getByRole('button', { name: '${escaped}', exact: false }).or(page.getByText('${escaped}', { exact: false })).first().click();`;
      }
      return "// click target unavailable";
    }
    if (action === "type") {
      const selector = asText(parsed.selector);
      const value = asText(parsed.value);
      const targetDescription = asText(parsed.targetDescription);
      const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      if (selector && selector !== "activeElement") {
        return `await page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first().fill('${escapedValue}');`;
      }
      if (targetDescription && value) {
        const label = cleanLocatorLabel(targetDescription);
        const escaped = label.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return `await page.getByLabel('${escaped}', { exact: false }).first().fill('${escapedValue}');`;
      }
      return value ? `await page.keyboard.type('${escapedValue}');` : "// type value unavailable";
    }
    if (action === "press") {
      const key = asText(parsed.key) || "Enter";
      return `await page.keyboard.press('${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');`;
    }
    if (action === "wait") {
      const durationMs = Number(parsed.durationMs);
      return Number.isFinite(durationMs) && durationMs > 0
        ? `await page.waitForTimeout(${Math.round(durationMs)});`
        : "// wait duration unavailable";
    }
    if (action === "assert_visible") {
      const selector = asText(parsed.selector);
      const expectedText = asText(parsed.expectedText);
      if (selector) return `await expect(page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first()).toBeVisible();`;
      if (expectedText) {
        return `await expect(page.getByText('${expectedText.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', { exact: false })).toBeVisible();`;
      }
      return "// visible assertion target unavailable";
    }
    if (action === "assert_text") {
      const selector = asText(parsed.selector);
      const expectedText = asText(parsed.expectedText);
      if (selector && expectedText) {
        return `await expect(page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first()).toContainText('${expectedText.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');`;
      }
      if (expectedText) {
        return `await expect(page.getByText('${expectedText.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', { exact: false })).toBeVisible();`;
      }
      return "// text assertion unavailable";
    }
    if (action === "assert_clickable") {
      const selector = asText(parsed.selector);
      return selector
        ? `await expect(page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first()).toBeEnabled();`
        : "// clickable assertion target unavailable";
    }
    if (action === "assert_url") {
      const url = asText(parsed.url);
      return url ? `await expect(page).toHaveURL('${url.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');` : "// url assertion unavailable";
    }
    if (actionRaw === "act") {
      const targetDescription = asText(parsed.targetDescription);
      const value = asText(parsed.value);
      if (targetDescription && value) {
        const label = cleanLocatorLabel(targetDescription);
        const escaped = label.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return `await page.getByLabel('${escaped}', { exact: false }).first().fill('${escapedValue}');`;
      }
      if (targetDescription) {
        const label = cleanLocatorLabel(targetDescription);
        const escaped = label.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return `await page.getByText('${escaped}', { exact: false }).first().click();`;
      }
      return "// unsupported agent act: missing target details";
    }
    return `// unsupported action: ${action || "unknown"}`;
  }

  function reviewStepFromAction(parsed: Record<string, unknown>, index: number): ReviewStep | null {
    const action = asText(parsed.action).toLowerCase();
    if (!action || action === "scroll") return null;
    let actionText = "";
    let expectedResult = "";
    if (action === "navigate") {
      const url = asText(parsed.url);
      if (!url) return null;
      actionText = `Open ${url}.`;
      expectedResult = `The page loads successfully at ${url}.`;
    } else if (action === "click") {
      const target = friendlyClickTarget(parsed);
      actionText = target ? `Click on ${target}.` : "Click on the target element.";
      expectedResult = "The click action is performed and the UI responds correctly.";
    } else if (action === "type") {
      const target = friendlyInputTarget(parsed);
      const value = asText(parsed.value);
      actionText = target ? (value ? `Enter "${value}" into ${target}.` : `Type into ${target}.`) : value ? `Type "${value}".` : "Type the required input.";
      expectedResult = value ? `The field displays "${value}".` : "The input is accepted by the active field.";
    } else if (action === "press") {
      const key = asText(parsed.key) || "Enter";
      actionText = `Press ${key}.`;
      expectedResult = `The application handles the ${key} key action successfully.`;
    } else if (action === "wait") {
      const durationMs = Number(parsed.durationMs);
      const waitMs = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
      actionText = waitMs > 0 ? `Wait for ${waitMs} ms.` : "Wait for the page to stabilize.";
      expectedResult = "The UI has enough time to finish async updates before the next step.";
    } else if (action === "drag") {
      const start = asText(parsed.startSelector);
      const end = asText(parsed.endSelector);
      actionText = start && end ? `Drag ${start} to ${end}.` : "Drag and drop the target element.";
      expectedResult = "The element is moved to the intended location.";
    } else if (action === "assert_visible") {
      const target = asText(parsed.expectedText) || friendlyClickTarget(parsed);
      actionText = target ? `Verify ${target} is visible.` : "Verify the required element is visible.";
      expectedResult = target ? `${target} is visible on the page.` : "The required UI element is visible to the user.";
    } else if (action === "assert_text") {
      const expectedText = asText(parsed.expectedText);
      const target = friendlyClickTarget(parsed);
      if (target && expectedText) {
        actionText = `Verify ${target} contains "${expectedText}".`;
        expectedResult = `${target} contains "${expectedText}".`;
      } else if (expectedText) {
        actionText = `Verify the page contains "${expectedText}".`;
        expectedResult = `The text "${expectedText}" is visible on the page.`;
      } else {
        actionText = "Verify the expected text is shown.";
        expectedResult = "The required text is visible on the page.";
      }
    } else if (action === "assert_clickable") {
      const target = friendlyClickTarget(parsed);
      actionText = target ? `Verify ${target} is clickable.` : "Verify the target control is clickable.";
      expectedResult = target ? `${target} is enabled for interaction.` : "The target control is enabled for interaction.";
    } else {
      actionText = `Perform action: ${action}.`;
      expectedResult = "The action completes successfully.";
    }
    const status = asText(parsed.__status || parsed.status);
    const statusSuffix = status && status.toLowerCase() !== "passed" ? ` [${status}]` : "";
    const aiPlaywright = asText(parsed.playwright);
    return {
      id: `review-step-${index + 1}-${action}`,
      action: `${actionText}${statusSuffix}`,
      expectedResult,
      playwright: aiPlaywright || playwrightLineForAction(parsed),
      status,
    };
  }

  function parseAgentActionsForReplay(
    execution: Record<string, unknown>,
    rawCommand: string
  ): Record<string, unknown>[] {
    const actions = Array.isArray(execution.agentActions)
      ? (execution.agentActions as Array<Record<string, unknown>>)
      : [];
    const mapped: Record<string, unknown>[] = [];
    const mapMethodAction = (methodRaw: unknown, selectorRaw: unknown, firstArgRaw: unknown): boolean => {
      const method = asText(methodRaw).toLowerCase();
      const selector = normalizeSelector(selectorRaw);
      const firstArg = asText(firstArgRaw);
      if ((method === "fill" || method === "type") && selector) {
        mapped.push({ action: "type", selector, value: firstArg });
        return true;
      }
      if ((method === "click" || method === "dblclick" || method === "check" || method === "uncheck") && selector) {
        mapped.push({ action: "click", selector });
        return true;
      }
      if (method === "press") {
        mapped.push({ action: "press", key: firstArg || "Enter" });
        return true;
      }
      if ((method === "goto" || method === "navigate") && firstArg) {
        mapped.push({ action: "navigate", url: firstArg });
        return true;
      }
      return false;
    };
    const mapInstructionAction = (sourceRaw: unknown): boolean => {
      const source = asRecord(sourceRaw);
      if (Object.keys(source).length === 0) return false;
      const argumentsMap = asRecord(source.arguments);
      const actionName = (
        asText(source.action) ||
        asText(source.type) ||
        asText(source.tool) ||
        asText(source.name)
      ).toLowerCase();
      const instruction = asText(source.instruction);
      const describe = asText(source.describe);
      const aiPlaywright = asText(source.playwright);
      const targetDescription =
        asText(source.targetDescription) ||
        asText(argumentsMap.describe) || describe || instruction;
      const value =
        asText(argumentsMap.value) ||
        asText(argumentsMap.text) ||
        asText(source.value) ||
        asText(source.text);
      const url = asText(argumentsMap.url) || asText(source.url);

      if (actionName.includes("click")) {
        mapped.push({
          action: "click",
          ...(targetDescription ? { targetDescription } : {}),
          ...(aiPlaywright ? { playwright: aiPlaywright } : {}),
        });
        return true;
      }
      if (actionName.includes("type") || actionName.includes("fill")) {
        mapped.push({
          action: "type",
          ...(targetDescription ? { targetDescription } : {}),
          ...(value ? { value } : {}),
          ...(aiPlaywright ? { playwright: aiPlaywright } : {}),
        });
        return true;
      }
      if (actionName.includes("press") || actionName.includes("key")) {
        mapped.push({
          action: "press",
          key: asText(source.key) || "Enter",
          ...(aiPlaywright ? { playwright: aiPlaywright } : {}),
        });
        return true;
      }
      if ((actionName.includes("goto") || actionName.includes("navigate")) && url) {
        mapped.push({
          action: "navigate",
          url,
          ...(aiPlaywright ? { playwright: aiPlaywright } : {}),
        });
        return true;
      }
      if (actionName.startsWith("assert")) {
        mapped.push({
          action: asText(source.action) || actionName,
          ...(targetDescription ? { targetDescription } : {}),
          ...(asText(source.expectedText) ? { expectedText: asText(source.expectedText) } : {}),
          ...(asText(source.selector) ? { selector: asText(source.selector) } : {}),
          ...(aiPlaywright ? { playwright: aiPlaywright } : {}),
          ...(asText(source._verificationResult) ? { __status: asText(source._verificationResult) } : {}),
        });
        return true;
      }
      return false;
    };

    for (const item of actions) {
      const actionName = asText(item.type || item.action || item.tool || item.name).toLowerCase();

      if (actionName === "wait") {
        const durationMs = Number(item.timeMs);
        if (Number.isFinite(durationMs) && durationMs > 0) {
          mapped.push({
            action: "wait",
            durationMs: Math.round(durationMs),
            ...(asText(item.playwright) ? { playwright: asText(item.playwright) } : {}),
          });
        }
        continue;
      }

      if (actionName === "extract") {
        const result = asRecord(item.result);
        for (const value of Object.values(result)) {
          if (typeof value === "string") {
            const text = value.trim();
            if (!text) continue;
            if (/^https?:\/\//i.test(text)) {
              mapped.push({ action: "assert_url", url: text });
            } else {
              mapped.push({ action: "assert_text", expectedText: text });
            }
            continue;
          }
          if (Array.isArray(value)) {
            for (const child of value) {
              const text = asText(child).trim();
              if (!text) continue;
              mapped.push({ action: "assert_text", expectedText: text });
            }
          }
        }
        continue;
      }

      if (actionName === "fillformvision") {
        const pwArgs = Array.isArray(item.playwrightArguments) ? item.playwrightArguments : [];
        const fields = pwArgs.length > 0 ? pwArgs : (Array.isArray(item.fields) ? item.fields : []);
        for (const field of fields) {
          const f = asRecord(field);
          const desc = asText(f.action || f.description).trim();
          const val = asText(f.value || f.originalValue).trim();
          if (val || desc) {
            mapped.push({ action: "type", targetDescription: desc, value: val });
          }
        }
        continue;
      }

      if (actionName.startsWith("assert")) {
        const aiPlaywright = asText(item.playwright);
        mapped.push({
          action: asText(item.action) || actionName,
          ...(asText(item.targetDescription) ? { targetDescription: asText(item.targetDescription) } : {}),
          ...(asText(item.expectedText) ? { expectedText: asText(item.expectedText) } : {}),
          ...(asText(item.selector) ? { selector: asText(item.selector) } : {}),
          ...(asText(item.url) ? { url: asText(item.url) } : {}),
          ...(aiPlaywright ? { playwright: aiPlaywright } : {}),
          ...(asText(item._verificationResult) ? { __status: asText(item._verificationResult) } : {}),
        });
        continue;
      }

      let emitted = false;
      const nestedActions = Array.isArray(item.actions) ? item.actions : [];
      for (const nested of nestedActions) {
        const action = asRecord(nested);
        const args = Array.isArray(action.arguments) ? action.arguments : [];
        const firstArg = args.length > 0 ? args[0] : "";
        if (mapMethodAction(action.method, action.selector, firstArg)) {
          emitted = true;
        }
      }
      if (emitted) {
        continue;
      }

      const topArgs = Array.isArray(item.arguments) ? item.arguments : [];
      const topFirstArg = topArgs.length > 0 ? topArgs[0] : item.value;
      if (mapMethodAction(item.method, item.selector, topFirstArg)) {
        continue;
      }
      if (mapInstructionAction(item)) {
        continue;
      }

      if (Array.isArray(item.playwrightArguments)) {
        let pwEmitted = false;
        for (const pwa of item.playwrightArguments) {
          const pwArg = asRecord(pwa);
          const val = asText(pwArg.value || pwArg.originalValue);
          const desc = asText(pwArg.action || pwArg.description);
          if (val || desc) {
            mapped.push({ action: "type", targetDescription: desc, value: val });
            pwEmitted = true;
          }
        }
        if (pwEmitted) continue;
      }
      const playwrightArguments = asRecord(item.playwrightArguments);
      if (Object.keys(playwrightArguments).length > 0) {
        const pwArgs = Array.isArray(playwrightArguments.arguments) ? playwrightArguments.arguments : [];
        const pwFirstArg = pwArgs.length > 0 ? pwArgs[0] : "";
        if (mapMethodAction(playwrightArguments.method, playwrightArguments.selector, pwFirstArg)) {
          continue;
        }
      }

      const fallbackSelector = normalizeSelector(item.selector);
      if (actionName.includes("click") && fallbackSelector) {
        mapped.push({ action: "click", selector: fallbackSelector });
        continue;
      }
      if ((actionName.includes("type") || actionName.includes("fill")) && fallbackSelector) {
        mapped.push({
          action: "type",
          selector: fallbackSelector,
          value: asText(item.text || item.value),
        });
        continue;
      }
      if (actionName.includes("press") || actionName.includes("key")) {
        mapped.push({ action: "press", key: asText(item.key || item.value || "Enter") });
        continue;
      }
      if (actionName.includes("goto") || actionName.includes("navigate")) {
        const url = asText(item.url || execution.currentUrl);
        if (url) mapped.push({ action: "navigate", url });
      }
    }
    if (mapped.length > 0) return mapped;

    const command = rawCommand.trim().toLowerCase();
    if (command.startsWith("click ")) {
      return [{ action: "click", targetDescription: rawCommand.replace(/^click\s+/i, "").trim() }];
    }
    if (command.startsWith("enter ") || command.startsWith("type ")) {
      return [{ action: "type", targetDescription: rawCommand }];
    }
    return [];
  }

  function collectStepsForFinalize(events: AutomationSession["events"]): ReviewStep[] {
    if (!events || events.length === 0) return [];
    const actions: Record<string, unknown>[] = [];
    const hasAutonomousStepEvents = events.some((event) => event.eventType === "autonomous_step_executed");
    const successfulAutonomousTurns = new Set<number>();
    for (const event of events) {
      if (event.eventType !== "autonomous_turn_executed") continue;
      const parsed = asRecord(event.parsedAction);
      if (!isPassedStatus(parsed.status)) continue;
      const turn = typeof parsed.turn === "number" ? parsed.turn : null;
      if (turn != null) successfulAutonomousTurns.add(turn);
    }
    for (const event of events) {
      const parsed = asRecord(event.parsedAction);
      const execution = asRecord(event.executionResult);
      if (event.eventType === "autonomous_step_executed") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        if (turn != null && successfulAutonomousTurns.size > 0 && !successfulAutonomousTurns.has(turn)) continue;
        const step = asRecord(parsed.step);
        const result = asRecord(execution.result);
        if (Object.keys(step).length > 0) actions.push(mergeStepWithResult(step, result));
        continue;
      }
      if (event.eventType === "autonomous_turn_executed" && !hasAutonomousStepEvents) {
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        const results = Array.isArray(parsed.results) ? parsed.results : [];
        if (results.length === 0) {
          for (const step of steps) actions.push(asRecord(step));
        } else {
          const bound = Math.min(steps.length, results.length);
          for (let i = 0; i < bound; i += 1) {
            const step = asRecord(steps[i]);
            const result = asRecord(results[i]);
            actions.push(mergeStepWithResult(step, result));
          }
        }
        continue;
      }
      if (event.eventType === "command_executed") {
        const parsedMode = asText(parsed.mode).toLowerCase();
        const executionMode = asText(execution.mode).toLowerCase();
        if (parsedMode === "autonomous" || executionMode === "autonomous") continue;
        if (executionMode === "agent" || parsedMode === "agent") {
          const agentMapped = parseAgentActionsForReplay(execution, asText(event.rawCommand));
          if (agentMapped.length > 0) {
            for (const item of agentMapped) actions.push(asRecord(item));
            continue;
          }
        }
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        const results = Array.isArray(execution.results) ? execution.results : [];
        if (results.length === 0) {
          for (const step of steps) actions.push(asRecord(step));
        } else {
          const bound = Math.min(steps.length, results.length);
          for (let i = 0; i < bound; i += 1) {
            const step = asRecord(steps[i]);
            const result = asRecord(results[i]);
            actions.push(mergeStepWithResult(step, result));
          }
        }
        continue;
      }
      if (event.eventType === "manual_action_executed" || event.eventType === "step_finished") {
        const merged = {
          ...parsed,
          ...(asText(execution.status) ? { __status: asText(execution.status) } : {}),
          ...(asText(execution.message) ? { __message: asText(execution.message) } : {}),
        };
        if (Object.keys(parsed).length > 0) actions.push(merged);
      }
    }
    const steps: ReviewStep[] = [];
    for (let i = 0; i < actions.length; i += 1) {
      const step = reviewStepFromAction(actions[i], i);
      if (step) steps.push(step);
    }
    return steps;
  }

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getTestCase(projectId, testcaseId)
        .then((tc) => {
          const title = (tc.title as string) || "Generated Test";
          const description = typeof tc.description === "string" ? tc.description : "";
          const preconditions = typeof tc.preconditions === "string" ? tc.preconditions : "";
          const testData = typeof tc.testData === "string" ? tc.testData : "";
          const stepsSummary = parseTestCaseSteps(tc.steps);
          setTestcaseTitle(title);
          setTestcaseIntentDetails({
            title,
            description,
            preconditions,
            testData,
            stepsSummary,
          });
        })
        .catch(() => {});
      if (bootstrapSessionId) {
        setMode("live");
        setSessionId(bootstrapSessionId);
        setSessionStartupState("waiting-stream");
        setMessages([
          {
            role: "assistant",
            content: `Automation session started. ${bootstrapMessageForEntry(bootstrapEntryMode)}`,
          },
        ]);
        return;
      }
      getProject(projectId)
        .then((project) => {
          const parsedSettings = parseProjectSettings(project.settings);
          const environments = normalizeTestRunEnvironments(parsedSettings.testRunEnvironments);
          const aiState = resolveAiConfiguration(parsedSettings);
          setTestRunEnvironments(environments);
          setAiConfigured(aiState.configured);
          setAiProvider(aiState.provider);
          if (environments.length > 0) {
            setSelectedEnvironmentUrl(environments[0].url);
          }
          setMode("live");
          setSessionStartupState("select-environment");
        })
        .catch(() => {
          setSessionStartupState("select-environment");
        });
    });
  }, [projectId, testcaseId, router, bootstrap, openInLivePreview, bootstrapSessionId, bootstrapEntryMode]);

  const testcaseIntentObjective = useMemo(() => buildIntentObjective(testcaseIntentDetails), [testcaseIntentDetails]);

  async function onStartSessionWithEnvironment() {
    if (sessionStartupState === "starting") return;
    setSessionStartupError(null);
    setSessionStartupState("starting");
    try {
      const created = await startAutomationSession(projectId, testcaseId, selectedStartUrl ? { startUrl: selectedStartUrl } : undefined);
      setSessionId(created.id);
      setSessionStartUrl(selectedStartUrl);
      setStreamState("Connecting");
      setSessionStartupState("waiting-stream");
      setMessages([
        {
          role: "assistant",
          content: `Automation session started. ${bootstrapMessageForEntry(
            bootstrapEntryMode
          )} Waiting for browser stream to become ready.`,
        },
      ]);
    } catch (error: unknown) {
      setSessionStartupError(error instanceof Error ? error.message : "Failed to start automation session.");
      setSessionStartupState("select-environment");
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [sessionResponse, streamResponse] = await Promise.all([
          getAutomationSession(projectId, sessionId),
          getAutomationStreamState(projectId, sessionId),
        ]);
        if (cancelled) return;
        setSession(sessionResponse);
        const encodedScreenshot = typeof streamResponse.screenshotDataUrl === "string" ? streamResponse.screenshotDataUrl : null;
        const rawStatus = typeof streamResponse.status === "string" ? streamResponse.status.toLowerCase() : "";
        const currentUrl = typeof streamResponse.currentUrl === "string" ? streamResponse.currentUrl.trim() : "";
        const streamDisconnected = rawStatus === "disconnected";
        const hasLiveUrl = currentUrl.length > 0 && currentUrl !== "about:blank";
        setScreenshotDataUrl(encodedScreenshot);
        if (streamDisconnected) {
          setStreamState("Disconnected");
        } else if (hasLiveUrl || encodedScreenshot) {
          setStreamState("Live");
          if (sessionStartupState === "waiting-stream") {
            setSessionStartupState("ready");
          }
        } else {
          setStreamState("Connecting");
        }
      } catch {
        if (!cancelled) {
          setStreamState((prev) => (prev === "Disconnected" ? "Disconnected" : "Lagging"));
        }
      }
    };
    void tick();
    const intervalMs = isLiveMode ? 400 : 800;
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, sessionId, isLiveMode, isAutonomousMode, sessionStartupState]);

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!session?.events) return [];
    const rawItems: Array<{
      at: number;
      actionLabel: string;
      primary?: string;
      secondary?: string;
      tertiary?: string;
    }> = [];
    const toText = (value: unknown): string => (typeof value === "string" ? value : "");
    const safeSnippet = (value: string, max = 180) => (value.length > max ? `${value.slice(0, max)}...` : value);

    for (const event of session.events) {
      const at = new Date(event.createdAt).getTime();
      const parsed = (event.parsedAction || {}) as Record<string, unknown>;
      const execution = (event.executionResult || {}) as Record<string, unknown>;

      if (event.eventType === "manual_action_executed") {
        const action = toText(parsed.action);
        if (action === "click") {
          const targetText = toText(parsed.targetText);
          const targetHtml = toText(parsed.targetHtml);
          const selector = toText(parsed.selector);
          rawItems.push({
            at,
            actionLabel: "Clicked on",
            primary: targetText ? `"${safeSnippet(targetText)}"` : selector || "(unknown target)",
            secondary: safeSnippet(targetHtml || selector),
          });
        } else if (action === "type") {
          const value = toText(parsed.value);
          const targetHtml = toText(parsed.targetHtml);
          const selector = toText(parsed.selector);
          rawItems.push({
            at,
            actionLabel: "Typed",
            primary: value || "(empty)",
            secondary: selector ? `at ${selector}` : undefined,
            tertiary: safeSnippet(targetHtml),
          });
        } else if (action === "press") {
          const key = toText(parsed.key) || "Enter";
          const targetHtml = toText(parsed.targetHtml);
          const selector = toText(parsed.selector);
          rawItems.push({
            at,
            actionLabel: "Pressed",
            primary: key,
            secondary: selector ? `at ${selector}` : undefined,
            tertiary: safeSnippet(targetHtml),
          });
        } else if (action === "scroll") {
          rawItems.push({
            at,
            actionLabel: "Scrolled",
            primary: `dx=${String(parsed.deltaX ?? 0)}, dy=${String(parsed.deltaY ?? 0)}`,
          });
        } else if (action === "drag") {
          rawItems.push({
            at,
            actionLabel: "Dragged",
            primary: `${toText(parsed.startSelector) || "(start)"} -> ${toText(parsed.endSelector) || "(end)"}`,
          });
        }
        continue;
      }

      if (event.eventType === "command_executed") {
        const agentActions = Array.isArray(execution.agentActions)
          ? (execution.agentActions as Array<Record<string, unknown>>)
          : [];
        for (const action of agentActions) {
          const reasoning = toText(action.reasoning);
          const instruction = toText(action.instruction);
          const message = toText(action.message || action.description);
          const actionName = toText(action.action);
          if (reasoning) {
            rawItems.push({
              at,
              actionLabel: "Thinking",
              primary: safeSnippet(reasoning, 220),
            });
          }
          if (instruction) {
            rawItems.push({
              at,
              actionLabel: "Plan",
              primary: safeSnippet(instruction, 220),
            });
          }
          if (actionName || message) {
            rawItems.push({
              at,
              actionLabel: actionName ? `Action: ${actionName}` : "Action",
              primary: safeSnippet(message || actionName, 220),
            });
          }
        }
        const results = Array.isArray(execution.results) ? execution.results : [];
        if (results.length > 0) {
          for (const step of results as Array<Record<string, unknown>>) {
            const action = toText(step.action);
            const status = toText(step.status);
            const currentUrl = toText(step.currentUrl);
            const selectorUsed = toText(step.selectorUsed);
            if (action === "navigate") {
              rawItems.push({
                at,
                actionLabel: "Navigated to",
                primary: currentUrl ? `"${safeSnippet(currentUrl, 120)}"` : "(unknown URL)",
              });
            } else if (action === "click") {
              rawItems.push({
                at,
                actionLabel: "Clicked on",
                primary: selectorUsed || "(target)",
                secondary: status ? `status: ${status}` : undefined,
              });
            } else if (action === "type") {
              rawItems.push({
                at,
                actionLabel: "Typed",
                primary: selectorUsed || "(input)",
                secondary: status ? `status: ${status}` : undefined,
              });
            } else {
              rawItems.push({
                at,
                actionLabel: action || "Step",
                primary: status || undefined,
              });
            }
          }
        }
        continue;
      }

      if (event.eventType === "autonomous_turn_planned") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const intentLabel = toText(parsed.intentLabel) || "Autonomous plan";
        const stepList = Array.isArray(parsed.steps) ? (parsed.steps as Array<Record<string, unknown>>) : [];
        const actionChain = stepList
          .map((step) => (typeof step.action === "string" ? step.action : "step"))
          .filter(Boolean)
          .join(" -> ");
        rawItems.push({
          at,
          actionLabel: "Autonomous Planning",
          primary: turn ? `Turn ${turn}: ${intentLabel}` : intentLabel,
          secondary: actionChain || "(no planned actions)",
        });
        continue;
      }

      if (event.eventType === "autonomous_step_evaluating") {
        if (!showAutonomousDebugTrace) continue;
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const stepIndex = typeof parsed.stepIndex === "number" ? parsed.stepIndex : null;
        const stepCount = typeof parsed.stepCount === "number" ? parsed.stepCount : null;
        const evaluateText = toText(parsed.evaluateText);
        const actionText = toText(parsed.actionText);
        rawItems.push({
          at,
          actionLabel: "Evaluate",
          primary: `${turn ? `Turn ${turn}` : "Turn"}${stepIndex ? ` - Step ${stepIndex}${stepCount ? `/${stepCount}` : ""}` : ""}`,
          secondary: evaluateText || undefined,
          tertiary: actionText ? `Next: ${actionText}` : undefined,
        });
        continue;
      }

      if (event.eventType === "autonomous_step_executed") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const stepIndex = typeof parsed.stepIndex === "number" ? parsed.stepIndex : null;
        const stepCount = typeof parsed.stepCount === "number" ? parsed.stepCount : null;
        const actionText = toText(parsed.actionText);
        const result = (execution.result || {}) as Record<string, unknown>;
        const status = toText(result.status) || toText(parsed.status) || "completed";
        rawItems.push({
          at,
          actionLabel: "Perform",
          primary: `${turn ? `Turn ${turn}` : "Turn"}${stepIndex ? ` - Step ${stepIndex}${stepCount ? `/${stepCount}` : ""}` : ""}`,
          secondary: actionText || undefined,
          tertiary: status ? `status: ${status}` : undefined,
        });
        continue;
      }

      if (event.eventType === "autonomous_turn_executed") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const intentLabel = toText(parsed.intentLabel) || "Autonomous execution";
        const status = toText(parsed.status) || "completed";
        const passedCount = typeof parsed.passedCount === "number" ? parsed.passedCount : null;
        const failedCount = typeof parsed.failedCount === "number" ? parsed.failedCount : null;
        const screenshotPath = toText(event.screenshotPath || "");
        rawItems.push({
          at,
          actionLabel: "Autonomous Turn",
          primary: turn ? `Turn ${turn}: ${intentLabel}` : intentLabel,
          secondary:
            passedCount != null && failedCount != null
              ? `status: ${status}, passed: ${passedCount}, failed: ${failedCount}`
              : `status: ${status}`,
          tertiary: screenshotPath ? `screenshot: ${screenshotPath}` : toText(parsed.currentUrl) || undefined,
        });
        continue;
      }

      if (event.eventType === "autonomous_turn_replanned") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const reason = toText(parsed.reason) || "Replanning with alternative strategy";
        const expectedOutcome = toText(parsed.expectedOutcome);
        const observedOutcome = toText(parsed.observedOutcome);
        rawItems.push({
          at,
          actionLabel: "Autonomous Replan",
          primary: turn ? `After turn ${turn}` : "After previous turn",
          secondary: reason,
          tertiary:
            expectedOutcome || observedOutcome
              ? `Expected: ${expectedOutcome || "-"} | Observed: ${observedOutcome || "-"}`
              : undefined,
        });
        continue;
      }

      if (event.eventType === "command_received" && event.rawCommand) {
        rawItems.push({
          at,
          actionLabel: "Command",
          primary: event.rawCommand,
        });
      }
    }

    const ordered = rawItems
      .filter((item) => Number.isFinite(item.at))
      .sort((a, b) => a.at - b.at)
      .slice(-30);
    if (ordered.length === 0) return [];
    const startAt = ordered[0].at;
    return ordered.map((item) => {
      const seconds = Math.max(0, Math.floor((item.at - startAt) / 1000));
      const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
      const ss = String(seconds % 60).padStart(2, "0");
      return {
        timeLabel: `${mm}:${ss}`,
        actionLabel: item.actionLabel,
        primary: item.primary,
        secondary: item.secondary,
        tertiary: item.tertiary,
      };
    });
  }, [session?.events, showAutonomousDebugTrace]);

  const liveImageSrc = useMemo(() => {
    if (!sessionId) return "";
    return `${apiBase}/api/projects/${projectId}/automation/sessions/${sessionId}/live`;
  }, [apiBase, projectId, sessionId]);
  const shouldShowLiveStream = Boolean(liveImageSrc);

  useEffect(() => {
    setLiveStreamFailed(false);
  }, [sessionId]);

  useEffect(() => {
    streamedAutonomousEventIdsRef.current = new Set();
    streamedTimelineEntriesRef.current = new Set();
    setBotHighlight(null);
  }, [sessionId]);

  useEffect(() => {
    if (!chatLogRef.current) return;
    chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!resizingPanes) return;
    const handleMove = (event: MouseEvent) => {
      const container = splitPaneRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      if (!bounds.width) return;
      const rawRatio = ((event.clientX - bounds.left) / bounds.width) * 100;
      const boundedRatio = Math.max(25, Math.min(75, rawRatio));
      setChatPaneRatio(boundedRatio);
    };
    const handleUp = () => {
      setResizingPanes(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingPanes]);

  useEffect(() => {
    const updateLayoutMode = () => {
      setDesktopSplitEnabled(window.innerWidth >= 1024);
    };
    updateLayoutMode();
    window.addEventListener("resize", updateLayoutMode);
    return () => window.removeEventListener("resize", updateLayoutMode);
  }, []);

  useEffect(() => {
    if (!isAutonomousMode || !session?.events || session.events.length === 0) return;
    const newChatLines: string[] = [];
    for (const event of session.events) {
      if (!event?.id || streamedAutonomousEventIdsRef.current.has(event.id)) continue;
      streamedAutonomousEventIdsRef.current.add(event.id);
      const parsed = (event.parsedAction || {}) as Record<string, unknown>;
      if (event.eventType === "autonomous_turn_planned") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const intent = typeof parsed.intentLabel === "string" ? parsed.intentLabel : "Autonomous plan";
        const steps = Array.isArray(parsed.steps) ? (parsed.steps as Array<Record<string, unknown>>) : [];
        const stepCount = steps.length;
        const planIntro = `${turn ? `Turn ${turn}` : "Next turn"} plan: ${intent}. I will run ${stepCount} step${
          stepCount === 1 ? "" : "s"
        } now.`;
        const planLines = steps.map((step, idx) => describeStepLine(step, idx + 1));
        newChatLines.push([planIntro, ...planLines].join("\n"));
      } else if (event.eventType === "autonomous_step_evaluating") {
        if (!showAutonomousDebugTrace) continue;
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const stepIndex = typeof parsed.stepIndex === "number" ? parsed.stepIndex : null;
        const stepCount = typeof parsed.stepCount === "number" ? parsed.stepCount : null;
        const evaluateText = asText(parsed.evaluateText);
        const actionText = asText(parsed.actionText);
        const prefix = `${turn ? `Turn ${turn}` : "Turn"}${stepIndex ? ` · Step ${stepIndex}${stepCount ? `/${stepCount}` : ""}` : ""}`;
        newChatLines.push(
          `${prefix}\n${evaluateText || "Thinking: I am checking DOM and UI state first."}\n${
            actionText || "Action: I will perform the planned interaction next."
          }`
        );
      } else if (event.eventType === "autonomous_step_executed") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const stepIndex = typeof parsed.stepIndex === "number" ? parsed.stepIndex : null;
        const execution = (event.executionResult || {}) as Record<string, unknown>;
        const result = (execution.result || {}) as Record<string, unknown>;
        const status = asText(result.status) || asText(execution.status) || "completed";
        const message = asText(result.message);
        const normalizedStatus = status.toLowerCase() === "passed" ? "completed successfully" : `finished with status "${status}"`;
        newChatLines.push(
          `${turn ? `Turn ${turn}` : "Turn"}${stepIndex ? ` · Step ${stepIndex}` : ""} ${normalizedStatus}.${message ? ` ${message}` : ""}`
        );
        const highlight = result.highlight as Record<string, unknown> | undefined;
        const xRatio = typeof highlight?.xRatio === "number" ? highlight.xRatio : null;
        const yRatio = typeof highlight?.yRatio === "number" ? highlight.yRatio : null;
        if (xRatio != null && yRatio != null) {
          setBotHighlight({
            xRatio,
            yRatio,
            widthRatio: typeof highlight?.widthRatio === "number" ? highlight.widthRatio : undefined,
            heightRatio: typeof highlight?.heightRatio === "number" ? highlight.heightRatio : undefined,
            label: typeof highlight?.label === "string" ? highlight.label : undefined,
          });
          setTimeout(() => {
            setBotHighlight((prev) => {
              if (!prev) return prev;
              if (prev.xRatio !== xRatio || prev.yRatio !== yRatio) return prev;
              return null;
            });
          }, 2200);
        }
      } else if (event.eventType === "autonomous_turn_replanned") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const reason = typeof parsed.reason === "string" ? parsed.reason : "Trying an alternative strategy.";
        const failedAction = asText(parsed.failedAction);
        const expectedOutcome = asText(parsed.expectedOutcome);
        const observedOutcome = asText(parsed.observedOutcome);
        const detailParts = [
          failedAction ? `Failed action: ${failedAction}.` : "",
          expectedOutcome ? `Expected: ${expectedOutcome}` : "",
          observedOutcome ? `Observed: ${observedOutcome}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        newChatLines.push(
          `${turn ? `After turn ${turn}` : "After the previous turn"}, I did not get the expected outcome. I am replanning with an alternative approach. ${reason}${detailParts ? ` ${detailParts}` : ""}`
        );
      } else if (event.eventType === "autonomous_turn_executed") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const status = typeof parsed.status === "string" ? parsed.status : "completed";
        const passedCount = typeof parsed.passedCount === "number" ? parsed.passedCount : null;
        const failedCount = typeof parsed.failedCount === "number" ? parsed.failedCount : null;
        const stepCount = typeof parsed.stepCount === "number" ? parsed.stepCount : null;
        const metrics =
          passedCount != null && failedCount != null
            ? `${passedCount} passed, ${failedCount} failed`
            : "execution finished";
        const normalizedStatus =
          status === "passed"
            ? "completed successfully"
            : status === "partial_failed"
              ? "completed with some failures"
              : status;
        newChatLines.push(
          `${turn ? `Turn ${turn}` : "This turn"} ${normalizedStatus}. ${stepCount != null ? `I executed ${stepCount} step${stepCount === 1 ? "" : "s"} with ${metrics}.` : `Result: ${metrics}.`}`
        );
      }
    }
    if (newChatLines.length > 0) {
      setMessages((prev) => [...prev, ...newChatLines.map((line) => ({ role: "assistant" as const, content: line }))]);
    }
  }, [isAutonomousMode, session?.events, showAutonomousDebugTrace]);

  useEffect(() => {
    if (timeline.length === 0) return;
    const fresh: ChatMessage[] = [];
    for (const item of timeline) {
      const key = `${item.timeLabel}|${item.actionLabel}|${item.primary || ""}|${item.secondary || ""}|${item.tertiary || ""}`;
      if (streamedTimelineEntriesRef.current.has(key)) continue;
      streamedTimelineEntriesRef.current.add(key);
      const lines = [`[${item.timeLabel}] ${item.actionLabel}${item.primary ? ` - ${item.primary}` : ""}`];
      if (item.secondary) lines.push(item.secondary);
      if (item.tertiary) lines.push(item.tertiary);
      fresh.push({ role: "assistant", content: lines.join("\n") });
    }
    if (fresh.length > 0) {
      setMessages((prev) => [...prev, ...fresh]);
    }
  }, [timeline]);

  const prevCommandInProgressRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    const processRecordingData = (actions: RecordingAction[], reasoningLog: ReasoningEntry[], summary: RecordingSummary) => {
      setRecordingSummary(summary);
      const prevActionCount = lastRecordingActionCountRef.current;
      const prevReasoningCount = lastReasoningCountRef.current;
      const hasNewActions = actions.length > prevActionCount;
      const hasNewReasoning = reasoningLog.length > prevReasoningCount;
      if (!hasNewActions && !hasNewReasoning) return;

      const newMessages: ChatMessage[] = [];

      const newReasonings = reasoningLog.slice(prevReasoningCount);
      lastReasoningCountRef.current = reasoningLog.length;
      for (const r of newReasonings) {
        newMessages.push({
          role: "reasoning" as const,
          content: r.text,
          reasoningMeta: {
            stepId: r.stepId,
            url: r.url,
            timestamp: r.timestamp,
          },
        });
      }

      const newActions = actions.slice(prevActionCount);
      lastRecordingActionCountRef.current = actions.length;
      for (const a of newActions) {
        const actionType = (a.action || "act").toLowerCase();
        const isAssertion = actionType.startsWith("assert");
        const actionLabel =
          actionType === "click" ? "Click" :
          actionType === "type" || actionType === "fill" ? "Fill" :
          actionType === "navigate" ? "Navigate" :
          actionType === "press" ? "Key Press" :
          actionType === "scroll" ? "Scroll" :
          actionType === "hover" ? "Hover" :
          actionType === "select" ? "Select" :
          isAssertion ? "Assert" :
          actionType.charAt(0).toUpperCase() + actionType.slice(1);
        const targetLine = a.targetDescription ? ` on "${a.targetDescription}"` : "";
        const valueLine = a.value ? ` with value "${a.value}"` : "";
        const content = `${actionLabel}${targetLine}${valueLine}`;
        newMessages.push({
          role: "recording" as const,
          content,
          recordingMeta: {
            action: actionType,
            playwright: a.playwright,
            target: a.targetDescription,
            value: a.value,
            status: isAssertion ? "assertion" : "success",
          },
        });
      }

      if (newMessages.length > 0) {
        setMessages((prev) => [...prev, ...newMessages]);
      }
    };

    if (!commandInProgress && prevCommandInProgressRef.current) {
      prevCommandInProgressRef.current = false;
      (async () => {
        try {
          const rec = await getAutomationRecording(projectId, sessionId);
          const summary = rec.summary;
          if (rec.hasRecording && rec.actions && summary) {
            processRecordingData(rec.actions, rec.reasoningLog || [], summary);
            if (summary.compiledActionCount > 0) {
              setMessages((prev) => [...prev, {
                role: "assistant",
                content: `Recording complete: ${summary.compiledActionCount} action${summary.compiledActionCount === 1 ? "" : "s"} captured (${summary.successfulActCount} successful, ${summary.extractCount} assertion${summary.extractCount === 1 ? "" : "s"}).`,
              }]);
            }
          }
        } catch { /* ignore */ }
      })();
      return;
    }
    prevCommandInProgressRef.current = commandInProgress;

    if (!commandInProgress) return;

    let cancelled = false;
    const pollRecording = async () => {
      try {
        const rec = await getAutomationRecording(projectId, sessionId);
        if (cancelled) return;
        if (!rec.hasRecording || !rec.actions || !rec.summary) return;
        processRecordingData(rec.actions, rec.reasoningLog || [], rec.summary);
      } catch {
        // Recording endpoint may not be available yet
      }
    };
    void pollRecording();
    const id = setInterval(() => void pollRecording(), 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, sessionId, commandInProgress]);

  async function executeCommand(
    input: string,
    options?: { forceAutonomous?: boolean }
  ) {
    if (!sessionId || !startupReady || !input.trim() || sending) return;
    const shouldUseAutonomousMode = options?.forceAutonomous === true || isAutonomousMode;
    if (shouldUseAutonomousMode && !aiConfigured) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "Add your AI API key in Project Settings to use Autonomous mode commands. Live mode works without AI for recording.",
        },
      ]);
      return;
    }
    const value = input.trim();
    const outboundCommand = shouldUseAutonomousMode
      ? `Autonomous mode objective: ${value}. Before any action, analyze the current DOM and identify stable locator candidates (role/label/testid/text) for each target. Use concise DOM-grounded target descriptions, then execute the full flow and include meaningful validation assertions in the plan.`
      : value;
    setSending(true);
    lastRecordingActionCountRef.current = 0;
    lastReasoningCountRef.current = 0;
    setRecordingSummary(null);
    setMessages((prev) => [...prev, { role: "user", content: value }]);
    try {
      const response = await sendAutomationCommand(projectId, sessionId, outboundCommand);
      if (response.requiresClarification) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: response.clarificationQuestion || "Please clarify your command." },
        ]);
      } else {
        const depth = Number(response.queueDepth ?? 0);
        if (response.queued && depth > 1) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Command queued. Queue depth is ${depth}. I will run it automatically after current command completes.`,
            },
          ]);
        }
      }
      setStreamState("Live");
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Failed to execute command." },
      ]);
      setStreamState("Lagging");
    } finally {
      setSending(false);
    }
  }

  async function resetSessionForFreshRun() {
    if (!sessionId) return;
    const startUrl = sessionStartUrl || selectedStartUrl || undefined;
    setStreamState("Connecting");
    setLiveStreamFailed(false);
    await resetAutomationSession(projectId, sessionId, startUrl ? { startUrl } : undefined);
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "Browser session restarted from scratch for a clean run.",
      },
    ]);
  }

  async function onSendCommand() {
    const value = command.trim();
    if (!value) return;
    setCommand("");
    await executeCommand(value);
  }

  async function onRunIndividualTest() {
    if (!sessionId || !startupReady || sending || quickActionBusy) return;
    const individualRunPrompt = `Run this test case individually now: "${testcaseTitle}". 
Execute the full flow end-to-end and validate with strong assertions for expected outcomes. 
Stop when pass/fail outcome is clear and summarize results.`;
    setQuickActionBusy("run");
    try {
      await resetSessionForFreshRun();
      await executeCommand(individualRunPrompt, { forceAutonomous: true });
    } finally {
      setQuickActionBusy(null);
    }
  }

  function onOpenReviewCurrentScript() {
    const nextReviewSteps = collectStepsForFinalize(session?.events || []);
    setReviewSteps(nextReviewSteps);
    setReviewScriptOpen(true);
  }

  function onOpenFinalizeReview() {
    const nextReviewSteps = collectStepsForFinalize(session?.events || []);
    setReviewSteps(nextReviewSteps);
    setConfirmFinalizeOpen(true);
  }

  function onDeleteReviewStep(stepId: string) {
    setReviewSteps((prev) => prev.filter((step) => step.id !== stepId));
  }

  async function onFinalize() {
    if (!sessionId || finalizing) return;
    setFinalizing(true);
    try {
      const scriptForSave = buildPlaywrightScriptFromReviewSteps(testcaseTitle, reviewSteps);
      await finalizeAutomationSession(projectId, sessionId, {
        framework: "Playwright",
        testName: testcaseTitle,
        script: scriptForSave,
        steps: reviewSteps.map((step, index) => ({
          stepNumber: index + 1,
          action: step.action,
          expectedResult: step.expectedResult,
        })),
      });
      router.push(`/projects/${projectId}/testcases/${testcaseId}`);
      router.refresh();
    } finally {
      setFinalizing(false);
      setConfirmFinalizeOpen(false);
    }
  }

  async function onLiveImageClick(event: React.MouseEvent<HTMLImageElement>) {
    if (!sessionId || !startupReady || !isLiveMode || manualBusy) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const ratioPoint = getPointerRatio(event.currentTarget, event.clientX, event.clientY);
    if (!ratioPoint) return;
    const { xRatio, yRatio } = ratioPoint;
    setLastClickTarget({ xRatio, yRatio });
    setCursorPulse(true);
    setTimeout(() => setCursorPulse(false), 180);
    liveViewportRef.current?.focus();
    setManualBusy(true);
    try {
      if (commandInProgress) {
        const stopResult = await stopAutomationCommand(projectId, sessionId);
        if (stopResult.stopRequested) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "User control acquired. Stopped active agent command so your manual actions take priority.",
            },
          ]);
        }
      }
      const result = await sendAutomationManualAction(projectId, sessionId, {
        actionType: "click",
        xRatio,
        yRatio,
      });
      if (result.status === "failed") {
        const failMsg = typeof result.message === "string" ? result.message : "Click did not reach the target element.";
        setMessages((prev) => [...prev, { role: "assistant", content: `Click failed: ${failMsg}` }]);
        setStreamState("Live");
        return;
      }
      const targetText = typeof result.targetText === "string" ? result.targetText.trim() : "";
      const selector = typeof result.selector === "string" ? result.selector.trim() : "";
      const clickTarget = targetText || selector || "";
      const suggestion = clickTarget
        ? `Clicked "${clickTarget}". Assertion suggestion: verify the next state after this click.`
        : "Assertion suggestion: verify the next state (URL, heading, or CTA visibility) after this click.";
      const combinedMessage = `Manual click recorded in live mode. ${suggestion}`;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === combinedMessage) {
          return prev;
        }
        return [...prev, { role: "assistant", content: combinedMessage }];
      });
      setStreamState("Live");
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Manual click failed." },
      ]);
    } finally {
      setManualBusy(false);
    }
  }

  function onLiveImageMouseDown(event: React.MouseEvent<HTMLImageElement>) {
    if (!isLiveMode) return;
    const ratioPoint = getPointerRatio(event.currentTarget, event.clientX, event.clientY);
    if (!ratioPoint) return;
    dragStartRef.current = ratioPoint;
  }

  async function onLiveImageMouseUp(event: React.MouseEvent<HTMLImageElement>) {
    if (!sessionId || !startupReady || !isLiveMode || manualBusy || !dragStartRef.current) return;
    const ratioPoint = getPointerRatio(event.currentTarget, event.clientX, event.clientY);
    if (!ratioPoint) return;
    const { toXRatio, toYRatio } = { toXRatio: ratioPoint.xRatio, toYRatio: ratioPoint.yRatio };
    const start = dragStartRef.current;
    dragStartRef.current = null;
    const moved = Math.abs(toXRatio - start.xRatio) + Math.abs(toYRatio - start.yRatio);
    if (moved < 0.03) return;
    suppressClickRef.current = true;
    setManualBusy(true);
    try {
      if (commandInProgress) {
        const stopResult = await stopAutomationCommand(projectId, sessionId);
        if (stopResult.stopRequested) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "User control acquired. Stopped active agent command so your manual actions take priority.",
            },
          ]);
        }
      }
      await sendAutomationManualAction(projectId, sessionId, {
        actionType: "drag",
        xRatio: start.xRatio,
        yRatio: start.yRatio,
        toXRatio,
        toYRatio,
      });
      setMessages((prev) => [...prev, { role: "assistant", content: "Manual drag-and-drop recorded in live mode." }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Manual drag failed." },
      ]);
    } finally {
      setManualBusy(false);
    }
  }

  async function onLiveImageWheel(event: React.WheelEvent<HTMLImageElement>) {
    if (!sessionId || !startupReady || !isLiveMode || manualBusy) return;
    const now = Date.now();
    if (now - lastScrollAtRef.current < 120) return;
    lastScrollAtRef.current = now;
    try {
      await sendAutomationManualAction(projectId, sessionId, {
        actionType: "scroll",
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
      });
    } catch {
      // keep UX smooth; avoid noisy chat for scroll failures
    }
  }

  async function processKeyboardQueue() {
    if (processingKeyQueueRef.current || !sessionId || !startupReady) return;
    processingKeyQueueRef.current = true;
    try {
      while (keyQueueRef.current.length > 0) {
        const item = keyQueueRef.current.shift();
        if (!item) continue;
        await sendAutomationManualAction(projectId, sessionId, {
          actionType: item.actionType,
          key: item.key,
          text: item.text,
          xRatio: lastClickTarget?.xRatio,
          yRatio: lastClickTarget?.yRatio,
        });
      }
    } catch {
      // keep chat clean during rapid typing bursts
    } finally {
      processingKeyQueueRef.current = false;
    }
  }

  function enqueueKeyboardAction(item: { actionType: "press" | "type"; key?: string; text?: string }) {
    keyQueueRef.current.push(item);
    void processKeyboardQueue();
  }

  function onLiveViewportKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!startupReady || !isLiveMode || !sessionId) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    event.preventDefault();
    const key = event.key;
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      enqueueKeyboardAction({ actionType: "type", text: key });
      return;
    }
    const allowed = new Set([
      "Enter",
      "Backspace",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]);
    if (allowed.has(key)) {
      enqueueKeyboardAction({ actionType: "press", key });
    }
  }

  function getPointerRatio(img: HTMLImageElement, clientX: number, clientY: number): { xRatio: number; yRatio: number } | null {
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) {
      return null;
    }
    return {
      xRatio: localX / rect.width,
      yRatio: localY / rect.height,
    };
  }

  async function onCancelSession() {
    if (!sessionId) {
      router.push(`/projects/${projectId}/testcases/${testcaseId}`);
      return;
    }
    await cancelAutomationSession(projectId, sessionId);
    router.push(`/projects/${projectId}/testcases/${testcaseId}`);
  }

  async function onStopCurrentCommand() {
    if (!sessionId || !startupReady || stoppingCommand) return;
    setStoppingCommand(true);
    try {
      const result = await stopAutomationCommand(projectId, sessionId);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.stopRequested
            ? `Stop requested for command ${result.activeCommandId || ""}. Remaining queued commands: ${result.queuedCount}.`
            : "No active command is running right now.",
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Failed to stop current command." },
      ]);
    } finally {
      setStoppingCommand(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/projects/${projectId}/testcases/${testcaseId}`} className="text-sm text-blue-600 hover:underline">
            Back to Test Case
          </Link>
          <span className="text-zinc-400">/</span>
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Automate: {testcaseTitle}</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">{streamState}</span>
          {recordingSummary && recordingSummary.state === "recording" && (
            <span className="flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-600" />
              </span>
              REC {recordingSummary.compiledActionCount}
            </span>
          )}
          {recordingSummary && recordingSummary.state === "stopped" && (
            <span className="rounded border border-zinc-400 bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              REC Done ({recordingSummary.compiledActionCount})
            </span>
          )}
          <div className="flex items-center rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
            AI Assisted Chat
          </div>
          <button
            type="button"
            onClick={onOpenFinalizeReview}
            disabled={!sessionId || finalizing || streamState === "Disconnected"}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {finalizing ? "Saving..." : "Save Script"}
          </button>
          <button
            type="button"
            onClick={onCancelSession}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
        </div>
      </header>

      <main className="p-3 lg:p-2">
        <div
          ref={splitPaneRef}
          className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white lg:h-[calc(100vh-96px)] lg:flex-row-reverse lg:[direction:ltr] dark:border-zinc-700 dark:bg-zinc-900"
        >
        <section
          className="flex min-h-[320px] flex-col p-2.5"
          style={desktopSplitEnabled ? { width: `${chatPaneRatio}%` } : undefined}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Automation Assistant</h2>
          </div>
          {!aiConfigured && (
            <p className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              {`AI key missing for ${aiProvider === "anthropic" ? "Anthropic" : "OpenAI"} provider. Configure it in Project Settings to enable chat-driven AI commands.`}
            </p>
          )}
          <div
            ref={chatLogRef}
            className="mb-2 h-[420px] min-h-[220px] overflow-auto rounded-xl border border-zinc-200 bg-zinc-50/80 p-2 dark:border-zinc-700 dark:bg-zinc-950/60 lg:h-auto lg:flex-1"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              {messages.length === 0 && (
                <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                  Start by sending a goal. Example: run login flow and verify dashboard is visible.
                </div>
              )}
              {messages.map((message, idx) => {
                const isUser = message.role === "user";
                const isRecording = message.role === "recording";
                const isReasoning = message.role === "reasoning";

                if (isReasoning) {
                  return (
                    <div key={idx} className="flex justify-start">
                      <div className="max-w-[92%] rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-xs">🧠</span>
                          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                            Bot Reasoning
                          </span>
                          {message.reasoningMeta?.url && (
                            <span className="ml-auto text-[10px] text-amber-500 dark:text-amber-500 truncate max-w-[200px]" title={message.reasoningMeta.url}>
                              {message.reasoningMeta.url.replace(/^https?:\/\//, "").split("/").slice(0, 2).join("/")}
                            </span>
                          )}
                        </div>
                        <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100 whitespace-pre-wrap">
                          {message.content}
                        </p>
                      </div>
                    </div>
                  );
                }

                if (isRecording && message.recordingMeta) {
                  const meta = message.recordingMeta;
                  const actionIcon =
                    meta.action === "click" ? "🖱" :
                    meta.action === "type" || meta.action === "fill" ? "⌨" :
                    meta.action === "navigate" ? "🔗" :
                    meta.action === "press" ? "⎋" :
                    meta.action === "scroll" ? "↕" :
                    meta.action === "hover" ? "👆" :
                    meta.action.startsWith("assert") ? "✓" : "●";
                  const borderColor =
                    meta.status === "assertion"
                      ? "border-purple-300 dark:border-purple-700"
                      : meta.status === "failed"
                        ? "border-red-300 dark:border-red-700"
                        : "border-emerald-300 dark:border-emerald-700";
                  const bgColor =
                    meta.status === "assertion"
                      ? "bg-purple-50 dark:bg-purple-950/30"
                      : meta.status === "failed"
                        ? "bg-red-50 dark:bg-red-950/30"
                        : "bg-emerald-50 dark:bg-emerald-950/30";
                  const labelColor =
                    meta.status === "assertion"
                      ? "text-purple-700 dark:text-purple-300"
                      : meta.status === "failed"
                        ? "text-red-700 dark:text-red-300"
                        : "text-emerald-700 dark:text-emerald-300";
                  return (
                    <div key={idx} className="flex justify-start">
                      <div className={`max-w-[92%] rounded-xl border ${borderColor} ${bgColor} px-3 py-2 text-sm`}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-xs">{actionIcon}</span>
                          <span className={`text-xs font-semibold uppercase tracking-wide ${labelColor}`}>
                            Recorded
                          </span>
                          <span className={`text-xs font-medium ${labelColor}`}>
                            {message.content}
                          </span>
                        </div>
                        <div className="mt-1 rounded-md bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-emerald-400 dark:bg-zinc-950">
                          {meta.playwright}
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={idx} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                        isUser
                          ? "bg-blue-600 text-white"
                          : "border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      }`}
                    >
                      {message.content}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
            <div className="relative">
              <textarea
                value={command}
                disabled={!startupReady || !aiConfigured}
                rows={2}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void onSendCommand();
                  }
                }}
                placeholder={
                  !aiConfigured
                    ? "Add AI API key in Project Settings to use this mode"
                    : "Tell the agent exactly what to do. Example: Click the Log in button."
                }
                className="w-full resize-none rounded-2xl border border-zinc-300 px-3 py-2 pr-12 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => void onSendCommand()}
                disabled={sending || !sessionId || !startupReady || !aiConfigured || !command.trim()}
                title={
                  sending
                    ? "Queueing command"
                    : "Send (Enter)"
                }
                aria-label={
                  sending
                    ? "Queueing command"
                    : "Send"
                }
                className={`absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white disabled:opacity-50 ${
                  "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {sending ? "…" : "↑"}
              </button>
            </div>
            {commandInProgress && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void onStopCurrentCommand()}
                  disabled={stoppingCommand || !sessionId || !startupReady}
                  className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/20 dark:text-red-300 disabled:opacity-50"
                >
                  {stoppingCommand ? "Stopping..." : "Stop Current Command"}
                </button>
              </div>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void onRunIndividualTest()}
              disabled={!startupReady || sending || Boolean(quickActionBusy) || !aiConfigured}
              className="rounded-full border border-blue-300 bg-blue-50 px-2.5 py-1 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300 disabled:opacity-50"
            >
              {quickActionBusy === "run" ? "Running test..." : "Run Current Test"}
            </button>
            <button
              type="button"
              onClick={onOpenReviewCurrentScript}
              disabled={!sessionId}
              className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 disabled:opacity-50"
            >
              Review Current Script
            </button>
          </div>
        </section>
        <div
          className="hidden lg:flex lg:w-3 lg:cursor-col-resize lg:items-center lg:justify-center"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and browser panels"
          onMouseDown={() => setResizingPanes(true)}
        >
          <div className={`h-16 w-1 rounded ${resizingPanes ? "bg-blue-500" : "bg-zinc-300 dark:bg-zinc-700"}`} />
        </div>
        <section
          className="flex min-h-[320px] flex-col border-t border-zinc-200 p-3 dark:border-zinc-700 lg:border-t-0"
          style={desktopSplitEnabled ? { width: `${100 - chatPaneRatio}%` } : undefined}
        >
          <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Live Browser</h2>
          <div
            ref={liveViewportRef}
            tabIndex={0}
            onKeyDown={onLiveViewportKeyDown}
            className={`mb-2 relative flex items-center justify-center rounded border border-zinc-200 bg-black outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 ${isLiveMode ? "h-[84vh] lg:h-auto lg:flex-1" : "h-[320px] lg:h-auto lg:flex-1"}`}
          >
            {shouldShowLiveStream && !liveStreamFailed ? (
              <img
                src={liveImageSrc}
                alt="Live browser stream"
                className={`h-full w-full object-fill ${isLiveMode ? "cursor-crosshair" : "cursor-default"}`}
                onLoad={() => setLiveStreamFailed(false)}
                onError={() => setLiveStreamFailed(true)}
                onClick={onLiveImageClick}
                onMouseDown={onLiveImageMouseDown}
                onMouseUp={onLiveImageMouseUp}
                onWheel={onLiveImageWheel}
              />
            ) : liveStreamFailed ? (
              <p className="text-sm text-red-400">Live stream unavailable. Retrying...</p>
            ) : screenshotDataUrl ? (
              <img
                src={screenshotDataUrl}
                alt="Live browser snapshot"
                className="h-full w-full object-fill"
              />
            ) : (
              <p className="text-sm text-zinc-500">Waiting for browser stream...</p>
            )}
            {isLiveMode && lastClickTarget && (
              <div
                className={`pointer-events-none absolute z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-blue-500 bg-blue-300/40 ${cursorPulse ? "scale-125" : "scale-100"} transition-transform duration-150`}
                style={{
                  left: `${Math.max(0, Math.min(100, lastClickTarget.xRatio * 100))}%`,
                  top: `${Math.max(0, Math.min(100, lastClickTarget.yRatio * 100))}%`,
                }}
              />
            )}
            {botHighlight && (
              <div
                className="pointer-events-none absolute z-30 rounded border-2 border-emerald-400 bg-emerald-300/20 shadow-[0_0_0_2px_rgba(16,185,129,0.35)]"
                style={{
                  left: `${Math.max(0, Math.min(100, botHighlight.xRatio * 100))}%`,
                  top: `${Math.max(0, Math.min(100, botHighlight.yRatio * 100))}%`,
                  width: `${Math.max(1.2, Math.min(100, (botHighlight.widthRatio ?? 0.04) * 100))}%`,
                  height: `${Math.max(1.2, Math.min(100, (botHighlight.heightRatio ?? 0.05) * 100))}%`,
                }}
                title={botHighlight.label || "Bot interaction target"}
              />
            )}
          </div>
          <p className="mb-1 text-xs text-zinc-500">
            Current URL: {session?.currentUrl || "-"}
          </p>
        </section>
        </div>
      </main>
      {confirmFinalizeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-6xl rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Review Steps and Script Before Saving
            </h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              Validate plain-English steps and Playwright script side by side. Delete any step you do not want to save;
              the related Playwright action is removed automatically.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <h4 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Script Steps (Simple English)</h4>
                <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
                  {reviewSteps.length === 0 ? (
                    <p className="text-xs text-zinc-500">No generated steps available for this session yet.</p>
                  ) : (
                    reviewSteps.map((step, index) => (
                      <div key={step.id} className="rounded border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800/40">
                        <div className="mb-1 flex items-start justify-between gap-2">
                          <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Step {index + 1}</p>
                          <button
                            type="button"
                            onClick={() => onDeleteReviewStep(step.id)}
                            className="rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20"
                          >
                            Delete
                          </button>
                        </div>
                        <p className="text-sm text-zinc-800 dark:text-zinc-100">{step.action}</p>
                        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{step.expectedResult}</p>
                        <pre className="mt-2 overflow-auto rounded bg-zinc-950 p-2 text-[11px] text-zinc-100">
                          {step.playwright}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <h4 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Playwright Script</h4>
                <pre className="max-h-[360px] overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-100">
                  {buildPlaywrightScriptFromReviewSteps(testcaseTitle, reviewSteps)}
                </pre>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmFinalizeOpen(false)}
                disabled={finalizing}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 disabled:opacity-50"
              >
                Keep Session Open
              </button>
              <button
                type="button"
                onClick={() => void onFinalize()}
                disabled={finalizing}
                className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {finalizing ? "Saving..." : "Confirm and Save"}
              </button>
            </div>
          </div>
        </div>
      )}
      {reviewScriptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-4xl rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Current Script Preview</h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              This script includes actions captured so far from both chat-guided AI steps and manual live interactions.
            </p>
            {reviewSteps.length > 0 && (
              <div className="mt-3 max-h-[180px] space-y-2 overflow-auto rounded border border-zinc-200 p-2 dark:border-zinc-700">
                {reviewSteps.map((step, index) => (
                  <div key={`${step.id}-preview`} className="rounded bg-zinc-50 p-2 dark:bg-zinc-800/40">
                    <p className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">Step {index + 1}</p>
                    <pre className="mt-1 overflow-auto rounded bg-zinc-950 p-2 text-[11px] text-zinc-100">
                      {step.playwright}
                    </pre>
                  </div>
                ))}
              </div>
            )}
            <pre className="mt-4 max-h-[460px] overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-100">
              {buildPlaywrightScriptFromReviewSteps(testcaseTitle, reviewSteps)}
            </pre>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setReviewScriptOpen(false)}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {!bootstrapSessionId && sessionStartupState === "select-environment" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Choose Environment</h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              Select a test environment URL to start browser automation.
            </p>
            {testRunEnvironments.length > 0 ? (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Environment</label>
                <select
                  value={selectedEnvironmentUrl}
                  onChange={(event) => setSelectedEnvironmentUrl(event.target.value)}
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {testRunEnvironments.map((env) => (
                    <option key={`${env.name}-${env.url}`} value={env.url}>
                      {env.name} - {env.url}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Environment URL</label>
                <input
                  value={customEnvironmentUrl}
                  onChange={(event) => setCustomEnvironmentUrl(event.target.value)}
                  placeholder="https://staging.example.com"
                  className="w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <p className="mt-1 text-[11px] text-zinc-500">No saved environments found in project settings.</p>
              </div>
            )}
            {sessionStartupError && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{sessionStartupError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancelSession}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onStartSessionWithEnvironment()}
                disabled={testRunEnvironments.length === 0 && !customEnvironmentUrl.trim()}
                className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Start Automate
              </button>
            </div>
          </div>
        </div>
      )}
      {(sessionStartupState === "starting" || sessionStartupState === "waiting-stream") && (
        <div className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {sessionStartupState === "starting" && <p className="text-zinc-700 dark:text-zinc-200">Starting automation environment...</p>}
          {sessionStartupState === "waiting-stream" && (
            <p className="text-zinc-700 dark:text-zinc-200">
              Browser is spinning up and opening environment URL. Please wait for live stream before interaction.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
