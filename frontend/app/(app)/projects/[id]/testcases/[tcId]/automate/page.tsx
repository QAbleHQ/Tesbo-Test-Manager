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
  finalizeAutomationSession,
  cancelAutomationSession,
  sendAutomationManualAction,
  type AutomationSession,
  type TestEnvironmentSetting,
} from "@/lib/api";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AutomationMode = "autonomous" | "chat" | "live";

type TimelineItem = {
  timeLabel: string;
  actionLabel: string;
  primary?: string;
  secondary?: string;
  tertiary?: string;
};

type SessionStartupState = "select-environment" | "starting" | "waiting-stream" | "ready";

export default function AutomateTestCasePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const testcaseId = params.tcId as string;
  const bootstrapSessionId = searchParams.get("sessionId");

  const [testcaseTitle, setTestcaseTitle] = useState("Test Case");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [confirmFinalizeOpen, setConfirmFinalizeOpen] = useState(false);
  const [streamState, setStreamState] = useState<"Connecting" | "Live" | "Lagging" | "Disconnected">("Connecting");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<AutomationMode>("chat");
  const [sessionStartupState, setSessionStartupState] = useState<SessionStartupState>("select-environment");
  const [sessionStartupError, setSessionStartupError] = useState<string | null>(null);
  const [liveStreamFailed, setLiveStreamFailed] = useState(false);
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [selectedEnvironmentUrl, setSelectedEnvironmentUrl] = useState("");
  const [customEnvironmentUrl, setCustomEnvironmentUrl] = useState("");
  const [manualText, setManualText] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [aiProvider, setAiProvider] = useState<"openai" | "anthropic">("openai");
  const [lastClickTarget, setLastClickTarget] = useState<{ xRatio: number; yRatio: number } | null>(null);
  const [cursorPulse, setCursorPulse] = useState(false);
  const [keyboardCapture, setKeyboardCapture] = useState(true);
  const dragStartRef = useRef<{ xRatio: number; yRatio: number } | null>(null);
  const suppressClickRef = useRef(false);
  const lastScrollAtRef = useRef(0);
  const liveViewportRef = useRef<HTMLDivElement | null>(null);
  const keyQueueRef = useRef<Array<{ actionType: "press" | "type"; key?: string; text?: string }>>([]);
  const processingKeyQueueRef = useRef(false);
  const streamedAutonomousEventIdsRef = useRef<Set<string>>(new Set());
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";
  const isLiveMode = mode === "live";
  const isAutonomousMode = mode === "autonomous";
  const isChatMode = mode === "chat";
  const startupReady = sessionStartupState === "ready";
  const selectedStartUrl = (selectedEnvironmentUrl || customEnvironmentUrl).trim();

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

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getTestCase(projectId, testcaseId)
        .then((tc) => setTestcaseTitle((tc.title as string) || "Generated Test"))
        .catch(() => {});
      if (bootstrapSessionId) {
        setSessionId(bootstrapSessionId);
        setSessionStartupState("waiting-stream");
        setMessages([
          {
            role: "assistant",
            content:
              "Automation session started. Choose a mode: Autonomous (agent plans and executes), Chat (intent-driven execution), or Live (you interact while I suggest assertions).",
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
          if (!aiState.configured) {
            setMode("live");
          }
          setSessionStartupState("select-environment");
        })
        .catch(() => {
          setSessionStartupState("select-environment");
        });
    });
  }, [projectId, testcaseId, router, bootstrapSessionId]);

  async function onStartSessionWithEnvironment() {
    if (sessionStartupState === "starting") return;
    setSessionStartupError(null);
    setSessionStartupState("starting");
    try {
      const created = await startAutomationSession(projectId, testcaseId, selectedStartUrl ? { startUrl: selectedStartUrl } : undefined);
      setSessionId(created.id);
      setStreamState("Connecting");
      setSessionStartupState("waiting-stream");
      setMessages([
        {
          role: "assistant",
          content:
            "Automation session started. Waiting for browser stream to become ready. Choose a mode after live stream is available.",
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
    const intervalMs = isLiveMode ? 400 : isAutonomousMode ? 800 : 1500;
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
        rawItems.push({
          at,
          actionLabel: "Autonomous Replan",
          primary: turn ? `After turn ${turn}` : "After previous turn",
          secondary: reason,
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
  }, [session?.events]);

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
  }, [sessionId]);

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
        const chain = steps
          .map((step) => (typeof step.action === "string" ? step.action : "step"))
          .filter(Boolean)
          .join(" -> ");
        const stepCount = steps.length;
        newChatLines.push(
          `${turn ? `Turn ${turn}` : "Next turn"} planning: I understand the goal as "${intent}". I will run ${stepCount} step${stepCount === 1 ? "" : "s"} now${chain ? ` using this sequence: ${chain}.` : "."}`
        );
      } else if (event.eventType === "autonomous_turn_replanned") {
        const turn = typeof parsed.turn === "number" ? parsed.turn : null;
        const reason = typeof parsed.reason === "string" ? parsed.reason : "Trying an alternative strategy.";
        newChatLines.push(
          `${turn ? `After turn ${turn}` : "After the previous turn"}, I did not get the expected outcome. I am replanning with an alternative approach. ${reason}`
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
  }, [isAutonomousMode, session?.events]);

  async function onSendCommand() {
    if (!sessionId || !startupReady || !command.trim() || sending) return;
    if ((isAutonomousMode || isChatMode) && !aiConfigured) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "Add your AI API key in Project Settings to use Autonomous and Chat modes. Live mode works without AI for recording.",
        },
      ]);
      return;
    }
    const value = command.trim();
    const outboundCommand = isAutonomousMode
      ? `Autonomous mode objective: ${value}. Think step-by-step based on current DOM/page content, execute the full flow, and include meaningful validation assertions in the plan.`
      : value;
    setCommand("");
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
        const result = (response.result || {}) as { results?: Array<Record<string, unknown>> };
        const steps = Array.isArray(result.results) ? result.results : [];
        const assertionCount = steps.filter((step) => {
          const action = typeof step.action === "string" ? step.action : "";
          return action.startsWith("assert");
        }).length;
        const iterations = typeof (response.result as Record<string, unknown> | undefined)?.iterations === "number"
          ? Number((response.result as Record<string, unknown>).iterations)
          : null;
        const goalAchieved = (response.result as Record<string, unknown> | undefined)?.goalAchieved === true;
        const completionReason =
          typeof (response.result as Record<string, unknown> | undefined)?.completionReason === "string"
            ? String((response.result as Record<string, unknown>).completionReason)
            : "";
        const plannedTurnsRaw = (response.result as Record<string, unknown> | undefined)?.plannedTurns;
        const plannedTurns = Array.isArray(plannedTurnsRaw) ? plannedTurnsRaw : [];
        const summary = isAutonomousMode
          ? `Autonomous run finished. Executed ${steps.length} step(s)${iterations ? ` across ${iterations} planning turn(s)` : ""}, including ${assertionCount} assertion step(s). ${goalAchieved ? "Objective achieved." : "Objective not fully confirmed."}`
          : `Command executed with ${steps.length} step(s) and ${assertionCount} assertion step(s).`;
        const suffix = completionReason ? ` ${completionReason}` : "";
        const thinkingLines = plannedTurns
          .slice(0, 8)
          .map((turn, idx) => {
            const turnObj = turn as Record<string, unknown>;
            const stepList = Array.isArray(turnObj.steps) ? turnObj.steps : [];
            const intentLabel =
              typeof turnObj.intentLabel === "string" && turnObj.intentLabel.trim()
                ? turnObj.intentLabel.trim()
                : "Autonomous action";
            const actions = stepList
              .map((s) => {
                const step = s as Record<string, unknown>;
                return typeof step.action === "string" ? step.action : "step";
              })
              .filter(Boolean)
              .join(" -> ");
            const turnNo = typeof turnObj.turn === "number" ? turnObj.turn : idx + 1;
            return `Turn ${turnNo} [${intentLabel}]: ${actions || "(no steps)"}`;
          });
        const thinkingLog = thinkingLines.length > 0 ? `Autonomous thinking log:\n${thinkingLines.join("\n")}` : "";
        setMessages((prev) => [
          ...prev,
          ...(thinkingLog ? [{ role: "assistant" as const, content: thinkingLog }] : []),
          { role: "assistant", content: `${summary}${suffix} Review timeline and browser output.` },
        ]);
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

  async function onFinalize() {
    if (!sessionId || finalizing) return;
    setFinalizing(true);
    try {
      await finalizeAutomationSession(projectId, sessionId, {
        framework: "Playwright",
        testName: testcaseTitle,
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
            {(["autonomous", "chat", "live"] as AutomationMode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                disabled={!startupReady || ((item === "autonomous" || item === "chat") && !aiConfigured)}
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
            onClick={() => setConfirmFinalizeOpen(true)}
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

      <main className={`grid gap-4 p-4 ${isLiveMode ? "grid-cols-1" : "lg:grid-cols-2"}`}>
        <section className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 ${isLiveMode ? "order-2" : ""}`}>
          <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Automation Chat</h2>
          <p className="mb-3 text-xs text-zinc-500">
            {isAutonomousMode
              ? "Autonomous mode: provide a goal, the bot plans full steps with assertions, then executes."
              : isLiveMode
                ? "Live mode: you interact with browser directly, and the bot suggests assertions."
                : "Chat mode: share intent, and the bot decides and executes steps."}
          </p>
          {!aiConfigured && (
            <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              {`AI key missing for ${aiProvider === "anthropic" ? "Anthropic" : "OpenAI"} provider. Configure it in Project Settings to enable Chat and Autonomous modes. Live mode is available for recording.`}
            </p>
          )}
          <div className="mb-3 h-[420px] overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950">
            <div className="space-y-3">
              {messages.map((message, idx) => (
                <div
                  key={idx}
                  className={`rounded p-2 text-sm ${
                    message.role === "user"
                      ? "ml-10 bg-blue-600 text-white"
                      : "mr-10 bg-white text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  }`}
                >
                  {message.content}
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <input
              value={command}
              disabled={!startupReady || ((isAutonomousMode || isChatMode) && !aiConfigured)}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSendCommand();
                }
              }}
              placeholder={
                (isAutonomousMode || isChatMode) && !aiConfigured
                  ? "Add AI API key in Project Settings to use this mode"
                  : isAutonomousMode
                  ? "Describe the end goal. Example: complete signup flow and verify success page"
                  : "Try: open qable.io, click on Connect us now, verify What we do is visible"
              }
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={() => void onSendCommand()}
              disabled={sending || !sessionId || !startupReady || ((isAutonomousMode || isChatMode) && !aiConfigured)}
              className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {sending ? "Running..." : isAutonomousMode ? "Start Autonomous Run" : "Run"}
            </button>
          </div>
        </section>

        <section className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900 ${isLiveMode ? "order-1" : ""}`}>
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Live Browser</h2>
          <p className="mb-2 text-xs text-zinc-500">
            {isLiveMode
              ? "Live mode increases stream refresh for near real-time browser playback and manual action recording."
              : isAutonomousMode
                ? "Autonomous mode uses medium refresh while the agent plans and executes in the browser."
                : "Chat mode executes intent from messages and records steps in timeline."}
          </p>
          <div
            ref={liveViewportRef}
            tabIndex={0}
            onKeyDown={onLiveViewportKeyDown}
            className={`mb-3 relative flex items-center justify-center rounded border border-zinc-200 bg-black outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 ${isLiveMode ? "h-[78vh]" : "h-[320px]"}`}
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
          </div>
          {isLiveMode && (
            <div className="mb-3 flex gap-2">
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
            <p className="mb-2 text-[11px] text-zinc-500">
              Tip: click target input in live browser first, then type on your keyboard while live viewport is focused.
            </p>
          )}
          <p className="mb-3 text-xs text-zinc-500">
            Current URL: {session?.currentUrl || "-"}
          </p>
          <div className="h-[160px] overflow-auto rounded border border-zinc-200 p-2 text-xs dark:border-zinc-700">
            <p className="mb-2 font-medium">Recent Step Events</p>
            <div className="space-y-1">
              {timeline.map((event, idx) => (
                <div key={`${event.timeLabel}-${event.actionLabel}-${idx}`} className="rounded bg-zinc-50 px-2 py-1 dark:bg-zinc-800">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-zinc-500">{event.timeLabel}</span>
                    <span className="font-semibold">{event.actionLabel}</span>
                  </div>
                  {event.primary && <p className="mt-0.5 break-words text-zinc-800 dark:text-zinc-100">{event.primary}</p>}
                  {event.secondary && <p className="mt-0.5 break-words text-zinc-600 dark:text-zinc-300">{event.secondary}</p>}
                  {event.tertiary && <p className="mt-0.5 break-words text-zinc-500 dark:text-zinc-400">{event.tertiary}</p>}
                </div>
              ))}
              {timeline.length === 0 && <p className="text-zinc-500">No recent step events yet.</p>}
            </div>
          </div>
        </section>
      </main>
      {confirmFinalizeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Complete Browser Session and Save Script?
            </h3>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              This will end the current browser session, convert recorded actions into a Playwright script, and store
              generated plain-English step definitions in the test case <span className="font-medium">Test Steps</span>{" "}
              section (with expected results where possible).
            </p>
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
                {finalizing ? "Saving..." : "Complete and Save"}
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
              Select a test environment URL to start browser automation. Live mode works without AI keys; Chat and Autonomous require provider API key in project settings.
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
