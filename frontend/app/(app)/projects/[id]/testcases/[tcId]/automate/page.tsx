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
  runAutomationPlaywrightScript,
  type AutomationSession,
  type TestEnvironmentSetting,
} from "@/lib/api";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AutomationMode = "autonomous" | "live";
type AutonomousTraceMode = "normal" | "debug";

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
};

type SessionStartupState = "select-environment" | "starting" | "waiting-stream" | "ready";
type BotHighlight = {
  xRatio: number;
  yRatio: number;
  widthRatio?: number;
  heightRatio?: number;
  label?: string;
};
type ScriptVersionOption = {
  key: string;
  label: string;
  script: string;
  scriptVersion: number | null;
};

type IntentSource = "testcase-intent" | "custom-command";

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
    }),
    [searchParams]
  );
  const bootstrapSessionId = bootstrap.sessionId;
  const openInLivePreview = bootstrap.openInLivePreview;

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
  const [chatPaneRatio, setChatPaneRatio] = useState(30);
  const [resizingPanes, setResizingPanes] = useState(false);
  const [desktopSplitEnabled, setDesktopSplitEnabled] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [confirmFinalizeOpen, setConfirmFinalizeOpen] = useState(false);
  const [reviewSteps, setReviewSteps] = useState<ReviewStep[]>([]);
  const [streamState, setStreamState] = useState<"Connecting" | "Live" | "Lagging" | "Disconnected">("Connecting");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<AutomationMode>("autonomous");
  const [autonomousTraceMode, setAutonomousTraceMode] = useState<AutonomousTraceMode>("normal");
  const [sessionStartupState, setSessionStartupState] = useState<SessionStartupState>("select-environment");
  const [sessionStartupError, setSessionStartupError] = useState<string | null>(null);
  const [liveStreamFailed, setLiveStreamFailed] = useState(false);
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [sessionStartUrl, setSessionStartUrl] = useState("");
  const [selectedEnvironmentUrl, setSelectedEnvironmentUrl] = useState("");
  const [customEnvironmentUrl, setCustomEnvironmentUrl] = useState("");
  const [manualText, setManualText] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [quickActionBusy, setQuickActionBusy] = useState<"run" | "rerun" | null>(null);
  const [scriptVersionOptions, setScriptVersionOptions] = useState<ScriptVersionOption[]>([]);
  const [versionPickerOpen, setVersionPickerOpen] = useState(false);
  const [selectedVersionKey, setSelectedVersionKey] = useState<string>("");
  const [intentSource, setIntentSource] = useState<IntentSource>("testcase-intent");
  const [autoStartFromIntent, setAutoStartFromIntent] = useState(true);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [aiProvider, setAiProvider] = useState<"openai" | "anthropic">("openai");
  const [lastClickTarget, setLastClickTarget] = useState<{ xRatio: number; yRatio: number } | null>(null);
  const [cursorPulse, setCursorPulse] = useState(false);
  const [keyboardCapture, setKeyboardCapture] = useState(true);
  const [botHighlight, setBotHighlight] = useState<BotHighlight | null>(null);
  const dragStartRef = useRef<{ xRatio: number; yRatio: number } | null>(null);
  const suppressClickRef = useRef(false);
  const lastScrollAtRef = useRef(0);
  const autoIntentStartedForSessionRef = useRef<string | null>(null);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const liveViewportRef = useRef<HTMLDivElement | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const timelineLogRef = useRef<HTMLDivElement | null>(null);
  const keyQueueRef = useRef<Array<{ actionType: "press" | "type"; key?: string; text?: string }>>([]);
  const processingKeyQueueRef = useRef(false);
  const streamedAutonomousEventIdsRef = useRef<Set<string>>(new Set());
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";
  const verboseAutonomousEvents = process.env.NEXT_PUBLIC_AUTONOMOUS_VERBOSE_EVENTS === "true";
  const showAutonomousDebugTrace = verboseAutonomousEvents || autonomousTraceMode === "debug";
  const isLiveMode = mode === "live";
  const isAutonomousMode = mode === "autonomous";
  const startupReady = sessionStartupState === "ready";
  const selectedStartUrl = (selectedEnvironmentUrl || customEnvironmentUrl).trim();
  const runtimeInfo = session?.runtime;
  const commandInProgress = Boolean(runtimeInfo?.isRunning);
  const queuedCommandCount = Number(runtimeInfo?.queuedCount || 0);

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

  function playwrightLineForAction(parsed: Record<string, unknown>): string {
    const action = asText(parsed.action);
    if (action === "navigate") {
      const url = asText(parsed.url);
      return url ? `await page.goto('${url.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');` : "// navigate step unavailable";
    }
    if (action === "click") {
      const selector = asText(parsed.selector);
      if (selector) {
        return `await page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first().click();`;
      }
      return "// click target unavailable";
    }
    if (action === "type") {
      const selector = asText(parsed.selector);
      const value = asText(parsed.value);
      const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      if (selector && selector !== "activeElement") {
        return `await page.locator('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}').first().fill('${escapedValue}');`;
      }
      return value ? `await page.keyboard.type('${escapedValue}');` : "// type value unavailable";
    }
    if (action === "press") {
      const key = asText(parsed.key) || "Enter";
      return `await page.keyboard.press('${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');`;
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
    return {
      id: `review-step-${index + 1}-${action}`,
      action: actionText,
      expectedResult,
      playwright: playwrightLineForAction(parsed),
    };
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
        if (!isPassedStatus(parsed.status)) continue;
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        if (turn != null && successfulAutonomousTurns.size > 0 && !successfulAutonomousTurns.has(turn)) continue;
        const step = asRecord(parsed.step);
        if (Object.keys(step).length > 0) actions.push(step);
        continue;
      }
      if (event.eventType === "autonomous_turn_executed" && !hasAutonomousStepEvents) {
        if (!isPassedStatus(parsed.status)) continue;
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        const results = Array.isArray(parsed.results) ? parsed.results : [];
        if (results.length === 0) {
          for (const step of steps) actions.push(asRecord(step));
        } else {
          const bound = Math.min(steps.length, results.length);
          for (let i = 0; i < bound; i += 1) {
            const result = asRecord(results[i]);
            if (isPassedStatus(result.status)) actions.push(asRecord(steps[i]));
          }
        }
        continue;
      }
      if (event.eventType === "command_executed") {
        const parsedMode = asText(parsed.mode).toLowerCase();
        const executionMode = asText(execution.mode).toLowerCase();
        if (parsedMode === "autonomous" || executionMode === "autonomous") continue;
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        const results = Array.isArray(execution.results) ? execution.results : [];
        if (results.length === 0) {
          for (const step of steps) actions.push(asRecord(step));
        } else {
          const bound = Math.min(steps.length, results.length);
          for (let i = 0; i < bound; i += 1) {
            const result = asRecord(results[i]);
            if (isPassedStatus(result.status)) actions.push(asRecord(steps[i]));
          }
        }
        continue;
      }
      if (event.eventType === "manual_action_executed" || event.eventType === "step_finished") {
        const status = asText(execution.status);
        if (status && !isPassedStatus(status)) continue;
        if (Object.keys(parsed).length > 0) actions.push(parsed);
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
          const currentScript = typeof tc.automationScript === "string" ? tc.automationScript : "";
          const currentVersionRaw = Number(tc.automationScriptVersion ?? 0);
          const currentScriptVersion = Number.isFinite(currentVersionRaw) && currentVersionRaw > 0 ? currentVersionRaw : 1;
          const historyRaw = Array.isArray(tc.automationScriptHistory)
            ? (tc.automationScriptHistory as Array<Record<string, unknown>>)
            : [];
          const historyOptions: ScriptVersionOption[] = historyRaw
            .map((entry, idx) => {
              const script = typeof entry.script === "string" ? entry.script : "";
              if (!script.trim()) return null;
              const scriptVersionRaw = Number(entry.scriptVersion ?? 0);
              const scriptVersion = Number.isFinite(scriptVersionRaw) && scriptVersionRaw > 0 ? scriptVersionRaw : null;
              const isCurrent = entry.isCurrent === true;
              return {
                key: `history-${idx}`,
                label: isCurrent ? `v${scriptVersion ?? currentScriptVersion} (Latest)` : `v${scriptVersion ?? "previous"}`,
                script,
                scriptVersion,
              };
            })
            .filter((entry): entry is ScriptVersionOption => entry !== null);
          const currentOption =
            currentScript.trim().length > 0
              ? [
                  {
                    key: "current",
                    label: `v${currentScriptVersion} (Latest)`,
                    script: currentScript,
                    scriptVersion: currentScriptVersion,
                  } satisfies ScriptVersionOption,
                ]
              : [];
          const merged = [...currentOption, ...historyOptions.filter((entry) => entry.key !== "current")];
          const deduped: ScriptVersionOption[] = [];
          const seen = new Set<string>();
          for (const option of merged) {
            const token = `${option.scriptVersion ?? "none"}::${option.script.slice(0, 80)}`;
            if (seen.has(token)) continue;
            seen.add(token);
            deduped.push(option);
          }
          setScriptVersionOptions(deduped);
          setSelectedVersionKey(deduped[0]?.key ?? "");
        })
        .catch(() => {});
      if (bootstrapSessionId) {
        if (openInLivePreview) {
          setMode("live");
        }
        setSessionId(bootstrapSessionId);
        setSessionStartupState("waiting-stream");
        setMessages([
          {
            role: "assistant",
            content:
              "Automation session started. Choose a mode: Autonomous (agent plans and executes) or Live (you interact while I suggest assertions).",
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
          if (openInLivePreview || !aiState.configured) {
            setMode("live");
          }
          setSessionStartupState("select-environment");
        })
        .catch(() => {
          setSessionStartupState("select-environment");
        });
    });
  }, [projectId, testcaseId, router, bootstrap]);

  const testcaseIntentObjective = useMemo(
    () => buildIntentObjective(testcaseIntentDetails),
    [testcaseIntentDetails]
  );

  useEffect(() => {
    if (!sessionId || !startupReady || !aiConfigured || !isAutonomousMode) return;
    if (!autoStartFromIntent || intentSource !== "testcase-intent") return;
    if (bootstrapSessionId) return;
    if (autoIntentStartedForSessionRef.current === sessionId) return;
    autoIntentStartedForSessionRef.current = sessionId;
    void executeCommand(testcaseIntentObjective, { forceAutonomous: true });
  }, [
    sessionId,
    startupReady,
    aiConfigured,
    isAutonomousMode,
    autoStartFromIntent,
    intentSource,
    bootstrapSessionId,
    testcaseIntentObjective,
  ]);

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
          content:
            "Automation session started. Waiting for browser stream to become ready. Choose Autonomous or Live mode after stream is available.",
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
    setBotHighlight(null);
  }, [sessionId]);

  useEffect(() => {
    if (!chatLogRef.current) return;
    chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!timelineLogRef.current) return;
    timelineLogRef.current.scrollTop = timelineLogRef.current.scrollHeight;
  }, [timeline]);

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

  async function executeCommand(
    input: string,
    options?: { forceAutonomous?: boolean }
  ) {
    if (!sessionId || !startupReady || !input.trim() || sending) return;
    const shouldUseAutonomousMode = options?.forceAutonomous === true || isAutonomousMode || isLiveMode;
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
    const commandAddon = command.trim();
    if (intentSource === "custom-command" && !commandAddon) return;
    const value =
      intentSource === "testcase-intent"
        ? commandAddon
          ? `${testcaseIntentObjective}\n\nAdditional user instruction:\n${commandAddon}`
          : testcaseIntentObjective
        : commandAddon;
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

  async function onRerunIndividualTest() {
    if (!sessionId || !startupReady || sending || quickActionBusy) return;
    if (scriptVersionOptions.length === 0) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "No Playwright script version is available to rerun yet. Save or generate a script first.",
        },
      ]);
      return;
    }
    setVersionPickerOpen(true);
  }

  async function onRunSelectedVersion() {
    if (!sessionId || !startupReady || sending || quickActionBusy) return;
    const selected = scriptVersionOptions.find((item) => item.key === selectedVersionKey);
    if (!selected) return;
    setQuickActionBusy("rerun");
    setVersionPickerOpen(false);
    try {
      await resetSessionForFreshRun();
      const result = await runAutomationPlaywrightScript(projectId, sessionId, {
        script: selected.script,
        scriptVersion: selected.scriptVersion,
        startUrl: sessionStartUrl || selectedStartUrl || undefined,
      });
      const runStatus = typeof result.status === "string" ? result.status.toLowerCase() : "failed";
      const passed = runStatus === "passed";
      const durationMs = typeof result.durationMs === "number" ? result.durationMs : null;
      const durationText = durationMs != null ? ` in ${(durationMs / 1000).toFixed(1)}s` : "";
      const errorText =
        !passed && typeof result.errorMessage === "string" && result.errorMessage.trim()
          ? ` Error: ${result.errorMessage.trim()}`
          : "";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${selected.label} run ${passed ? "PASSED" : "FAILED"}${durationText}.${errorText}`,
        },
      ]);
      setStreamState("Live");
    } finally {
      setQuickActionBusy(null);
    }
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
      const result = await sendAutomationManualAction(projectId, sessionId, {
        actionType: "click",
        xRatio,
        yRatio,
      });
      const targetText = typeof result.targetText === "string" ? result.targetText.trim() : "";
      const suggestion = targetText
        ? `Assertion suggestion: verify "${targetText}" is visible after this click.`
        : "Assertion suggestion: verify the next state (URL, heading, or CTA visibility) after this click.";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Manual click recorded in live mode." },
        { role: "assistant", content: suggestion },
      ]);
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

  async function onManualType() {
    if (!sessionId || !startupReady || !isLiveMode || manualBusy || !manualText.trim()) return;
    const text = manualText;
    setManualText("");
    setManualBusy(true);
    try {
      await sendAutomationManualAction(projectId, sessionId, {
        actionType: "type",
        text,
        xRatio: lastClickTarget?.xRatio,
        yRatio: lastClickTarget?.yRatio,
      });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Manual typing recorded in live mode." },
        { role: "assistant", content: `Assertion suggestion: verify the field value contains "${text}".` },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Manual typing failed." },
      ]);
    } finally {
      setManualBusy(false);
    }
  }

  async function onManualPressEnter() {
    if (!sessionId || !startupReady || !isLiveMode || manualBusy) return;
    setManualBusy(true);
    try {
      const result = await sendAutomationManualAction(projectId, sessionId, {
        actionType: "press",
        key: "Enter",
        xRatio: lastClickTarget?.xRatio,
        yRatio: lastClickTarget?.yRatio,
      });
      const currentUrl = typeof result.currentUrl === "string" ? result.currentUrl : "";
      const suggestion = currentUrl
        ? `Assertion suggestion: verify URL is "${currentUrl}" after pressing Enter.`
        : "Assertion suggestion: verify submit action completed successfully after pressing Enter.";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Manual Enter key recorded." },
        { role: "assistant", content: suggestion },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Manual key press failed." },
      ]);
    } finally {
      setManualBusy(false);
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
      // drop failures silently to avoid chat spam during fast typing
    } finally {
      processingKeyQueueRef.current = false;
    }
  }

  function enqueueKeyboardAction(item: { actionType: "press" | "type"; key?: string; text?: string }) {
    keyQueueRef.current.push(item);
    void processKeyboardQueue();
  }

  function onLiveViewportKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!startupReady || !isLiveMode || !keyboardCapture || !sessionId) return;
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

  function getPointerRatio(img: HTMLImageElement, clientX: number, clientY: number): { xRatio: number; yRatio: number } | null {
    const rect = img.getBoundingClientRect();
    const naturalWidth = img.naturalWidth || 1366;
    const naturalHeight = img.naturalHeight || 768;
    const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
    const renderedWidth = naturalWidth * scale;
    const renderedHeight = naturalHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    const localX = clientX - rect.left - offsetX;
    const localY = clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) {
      return null;
    }
    return {
      xRatio: localX / renderedWidth,
      yRatio: localY / renderedHeight,
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
          <div className="flex items-center rounded border border-zinc-300 p-0.5 text-xs dark:border-zinc-700">
            {(["autonomous", "live"] as AutomationMode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                disabled={!startupReady || (item === "autonomous" && !aiConfigured)}
                className={`rounded px-2 py-1 capitalize ${
                  mode === item
                    ? "bg-emerald-600 text-white"
                    : "text-zinc-700 dark:text-zinc-200"
                }`}
              >
                {item}
              </button>
            ))}
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
            {isAutonomousMode && (
              <div className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-100 p-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-800">
                <button
                  type="button"
                  onClick={() => setAutonomousTraceMode("normal")}
                  className={`rounded-full px-2 py-0.5 ${
                    autonomousTraceMode === "normal"
                      ? "bg-white text-zinc-900 dark:bg-zinc-200 dark:text-zinc-900"
                      : "text-zinc-600 dark:text-zinc-300"
                  }`}
                >
                  Normal
                </button>
                <button
                  type="button"
                  onClick={() => setAutonomousTraceMode("debug")}
                  className={`rounded-full px-2 py-0.5 ${
                    autonomousTraceMode === "debug"
                      ? "bg-white text-zinc-900 dark:bg-zinc-200 dark:text-zinc-900"
                      : "text-zinc-600 dark:text-zinc-300"
                  }`}
                >
                  Debug
                </button>
              </div>
            )}
          </div>
          {!aiConfigured && (
            <p className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              {`AI key missing for ${aiProvider === "anthropic" ? "Anthropic" : "OpenAI"} provider. Configure it in Project Settings to enable Autonomous mode commands. Live mode is available for recording.`}
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
                    : intentSource === "testcase-intent"
                    ? "Optional extra guidance..."
                    : isAutonomousMode
                    ? "Describe the end goal..."
                    : "Live mode tip: interact manually, or run a goal from here"
                }
                className="w-full resize-none rounded-2xl border border-zinc-300 px-3 py-2 pr-12 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => void (commandInProgress ? onStopCurrentCommand() : onSendCommand())}
                disabled={commandInProgress ? stoppingCommand || !sessionId || !startupReady : sending || !sessionId || !startupReady || !aiConfigured}
                title={
                  commandInProgress
                    ? (stoppingCommand ? "Stopping command" : "Stop current command")
                    : sending
                      ? "Queueing command"
                      : "Send (Enter)"
                }
                aria-label={
                  commandInProgress
                    ? (stoppingCommand ? "Stopping command" : "Stop current command")
                    : sending
                      ? "Queueing command"
                      : "Send"
                }
                className={`absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white disabled:opacity-50 ${
                  commandInProgress
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {commandInProgress ? (stoppingCommand ? "…" : "■") : sending ? "…" : "↑"}
              </button>
            </div>
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
              onClick={() => void onRerunIndividualTest()}
              disabled={!startupReady || sending || Boolean(quickActionBusy)}
              className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 disabled:opacity-50"
            >
              {quickActionBusy === "rerun" ? "Re-running..." : "Re Run Last Test (Live Preview)"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Quick actions run inside the current automation session, so you can watch each run directly in Live Browser preview.
          </p>
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
            className={`mb-2 relative flex items-center justify-center rounded border border-zinc-200 bg-black outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 ${isLiveMode ? "h-[78vh] lg:h-auto lg:flex-1" : "h-[320px] lg:h-auto lg:flex-1"}`}
          >
            {shouldShowLiveStream && !liveStreamFailed ? (
              <img
                src={liveImageSrc}
                alt="Live browser stream"
                className={`h-full w-full object-contain ${isLiveMode ? "cursor-crosshair" : "cursor-default"}`}
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
                className="h-full w-full object-contain"
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
          {isLiveMode && (
            <div className="mb-2 flex gap-2">
              <input
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Type text into currently focused element"
                className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => void onManualType()}
                disabled={!startupReady || manualBusy || !manualText.trim()}
                className="rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 disabled:opacity-50"
              >
                Type
              </button>
              <button
                type="button"
                onClick={() => void onManualPressEnter()}
                disabled={!startupReady || manualBusy}
                className="rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 disabled:opacity-50"
              >
                Enter
              </button>
              <button
                type="button"
                onClick={() => setKeyboardCapture((prev) => !prev)}
                disabled={!startupReady}
                className={`rounded border px-2 py-1.5 text-xs ${
                  keyboardCapture
                    ? "border-emerald-500 text-emerald-700 dark:border-emerald-500 dark:text-emerald-300"
                    : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                {keyboardCapture ? "Keyboard Capture On" : "Keyboard Capture Off"}
              </button>
            </div>
          )}
          {isLiveMode && (
            <p className="mb-1 text-[11px] text-zinc-500">
              Tip: click target input in live browser first, then type on your keyboard while live viewport is focused.
            </p>
          )}
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
      {!bootstrapSessionId && sessionStartupState === "select-environment" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Choose Environment</h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              Select a test environment URL to start browser automation. Live mode works without AI keys; Autonomous commands require provider API key in project settings.
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
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/40">
              <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Test Intent Preferences</p>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                Choose how the session should begin after browser startup.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">Intent Source</span>
                <button
                  type="button"
                  onClick={() => setIntentSource("testcase-intent")}
                  className={`rounded-full px-2.5 py-1 text-[11px] ${
                    intentSource === "testcase-intent"
                      ? "bg-blue-600 text-white"
                      : "border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                  }`}
                >
                  Test case
                </button>
                <button
                  type="button"
                  onClick={() => setIntentSource("custom-command")}
                  className={`rounded-full px-2.5 py-1 text-[11px] ${
                    intentSource === "custom-command"
                      ? "bg-blue-600 text-white"
                      : "border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                  }`}
                >
                  Custom
                </button>
              </div>
              {intentSource === "testcase-intent" && (
                <label className="mt-3 inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={autoStartFromIntent}
                    onChange={(event) => setAutoStartFromIntent(event.target.checked)}
                  />
                  Start testcase intent automatically after setup
                </label>
              )}
              {intentSource === "custom-command" && (
                <p className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Session will start without running a test intent automatically. You can start manually from chat.
                </p>
              )}
            </div>
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
                {intentSource === "testcase-intent" && autoStartFromIntent ? "Start and Run Intent" : "Start Automate"}
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
      {versionPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Choose Script Version to Re-run</h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              Select which Playwright script version should run in live preview for pass/fail verification.
            </p>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Script Version</label>
              <select
                value={selectedVersionKey}
                onChange={(event) => setSelectedVersionKey(event.target.value)}
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {scriptVersionOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setVersionPickerOpen(false)}
                className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onRunSelectedVersion()}
                disabled={!selectedVersionKey}
                className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Run Selected Version
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
