"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  authMe,
  cancelAutomationSession,
  getAutomationSessionTraceUrl,
  getAutomationSession,
  getAutomationStreamState,
  getProject,
  getTestCase,
  resetAutomationSession,
  runAutomationPlaywrightScript,
  startAutomationSession,
  type AutomationSession,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { runAegisInBackground } from "@/lib/aegis-runner";

type ScriptVersionOption = {
  key: string;
  label: string;
  script: string;
  scriptVersion: number | null;
};

type SessionStartupState = "idle" | "starting" | "waiting-stream" | "ready";
const SESSION_READY_TIMEOUT_MS = 15000;
const SESSION_READY_POLL_INTERVAL_MS = 500;

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

export default function RerunLivePreviewPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const testcaseId = params.tcId as string;
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

  const [testcaseTitle, setTestcaseTitle] = useState("Test Case");
  const [testcaseExternalId, setTestcaseExternalId] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AutomationSession | null>(null);
  const [sessionStartupState, setSessionStartupState] = useState<SessionStartupState>("idle");
  const [sessionStartUrl, setSessionStartUrl] = useState("");
  const [sessionStartupError, setSessionStartupError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"Connecting" | "Live" | "Lagging" | "Disconnected">("Connecting");
  const [liveStreamFailed, setLiveStreamFailed] = useState(false);
  const [liveStreamNonce, setLiveStreamNonce] = useState(0);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [testRunEnvironments, setTestRunEnvironments] = useState<TestEnvironmentSetting[]>([]);
  const [selectedEnvironmentUrl, setSelectedEnvironmentUrl] = useState("");
  const [customEnvironmentUrl, setCustomEnvironmentUrl] = useState("");
  const [scriptVersionOptions, setScriptVersionOptions] = useState<ScriptVersionOption[]>([]);
  const [selectedVersionKey, setSelectedVersionKey] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runStatusMessage, setRunStatusMessage] = useState<string | null>(null);
  const [lastRunTraceAvailable, setLastRunTraceAvailable] = useState(false);
  const [lastRunFailed, setLastRunFailed] = useState(false);
  const [lastRunScript, setLastRunScript] = useState("");
  const [aegisInstruction, setAegisInstruction] = useState("");
  const [sendToAegisBusy, setSendToAegisBusy] = useState(false);
  const [sendToAegisMessage, setSendToAegisMessage] = useState<string | null>(null);

  const selectedStartUrl = (selectedEnvironmentUrl || customEnvironmentUrl).trim();
  const startupReady = sessionStartupState === "ready";

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getProject(projectId), getTestCase(projectId, testcaseId)])
        .then(([project, tc]) => {
          setTestcaseTitle(((tc.title as string) || "Test Case").trim() || "Test Case");
          setTestcaseExternalId(typeof tc.externalId === "string" ? tc.externalId : "");

          const parsedSettings = parseProjectSettings(project.settings);
          const environments = normalizeTestRunEnvironments(parsedSettings.testRunEnvironments);
          setTestRunEnvironments(environments);
          if (environments.length > 0) {
            setSelectedEnvironmentUrl(environments[0].url);
          }

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
        .catch(() => {
          setRunStatusMessage("Failed to load test case details. Please refresh and try again.");
        });
    });
  }, [projectId, testcaseId, router]);

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
    const id = setInterval(() => void tick(), 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, sessionId, sessionStartupState]);

  const liveImageSrc = useMemo(() => {
    if (!sessionId) return "";
    return `${apiBase}/api/projects/${projectId}/automation/sessions/${sessionId}/live?nonce=${liveStreamNonce}`;
  }, [apiBase, projectId, sessionId, liveStreamNonce]);
  const shouldShowLiveStream = Boolean(liveImageSrc);

  useEffect(() => {
    setLiveStreamFailed(false);
    setLiveStreamNonce((prev) => prev + 1);
  }, [sessionId]);

  useEffect(() => {
    if (!liveStreamFailed) return;
    const retryTimer = setTimeout(() => {
      setLiveStreamFailed(false);
      setLiveStreamNonce((prev) => prev + 1);
    }, 1200);
    return () => clearTimeout(retryTimer);
  }, [liveStreamFailed]);

  async function waitForSessionReady(targetSessionId: string): Promise<void> {
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const streamResponse = await getAutomationStreamState(projectId, targetSessionId);
      const rawStatus = typeof streamResponse.status === "string" ? streamResponse.status.toLowerCase() : "";
      const currentUrl = typeof streamResponse.currentUrl === "string" ? streamResponse.currentUrl.trim() : "";
      const encodedScreenshot = typeof streamResponse.screenshotDataUrl === "string" ? streamResponse.screenshotDataUrl : "";
      const streamDisconnected = rawStatus === "disconnected";
      const hasLiveUrl = currentUrl.length > 0 && currentUrl !== "about:blank";
      if (!streamDisconnected && (hasLiveUrl || encodedScreenshot)) {
        setSessionStartupState("ready");
        setStreamState("Live");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_READY_POLL_INTERVAL_MS));
    }
    throw new Error("Live session is taking too long to become ready. Please try again.");
  }

  async function ensureSessionReadyForRun(): Promise<string> {
    const startUrl = selectedStartUrl || undefined;
    const activeSessionId = sessionId;
    if (activeSessionId && startupReady) {
      return activeSessionId;
    }

    let targetSessionId = activeSessionId;
    if (!targetSessionId) {
      setSessionStartupState("starting");
      setRunStatusMessage("Starting live session...");
      const created = await startAutomationSession(projectId, testcaseId, startUrl ? { startUrl } : undefined);
      targetSessionId = created.id;
      setSessionId(created.id);
      setSessionStartUrl(selectedStartUrl);
    } else {
      setRunStatusMessage("Preparing live session...");
    }

    setStreamState("Connecting");
    setSessionStartupState("waiting-stream");
    await waitForSessionReady(targetSessionId);
    return targetSessionId;
  }

  async function onRunSelectedVersion() {
    if (runBusy) return;
    setLastRunFailed(false);
    setSendToAegisMessage(null);
    setRunStatusMessage("Preparing test run...");
    if (!selectedStartUrl) {
      setRunStatusMessage("Select or enter an Environment URL before running the test.");
      return;
    }
    const selected = scriptVersionOptions.find((item) => item.key === selectedVersionKey);
    if (!selected) {
      setRunStatusMessage("Select a script version before running.");
      return;
    }
    setRunBusy(true);
    setRunStatusMessage(null);
    setLastRunTraceAvailable(false);
    let ranSessionId: string | null = null;
    try {
      const activeSessionId = await ensureSessionReadyForRun();
      ranSessionId = activeSessionId;
      const startUrl = sessionStartUrl || selectedStartUrl || undefined;
      setLiveStreamFailed(false);
      setLiveStreamNonce((prev) => prev + 1);
      await resetAutomationSession(projectId, activeSessionId, {
        startUrl,
      });
      const result = await runAutomationPlaywrightScript(projectId, activeSessionId, {
        script: selected.script,
        scriptVersion: selected.scriptVersion,
        startUrl,
        actionDelayMs: 700,
      });
      const runStatus = typeof result.status === "string" ? result.status.toLowerCase() : "failed";
      const passed = runStatus === "passed";
      setLastRunScript(selected.script);
      setLastRunFailed(!passed);
      const durationMs = typeof result.durationMs === "number" ? result.durationMs : null;
      const durationText = durationMs != null ? ` in ${(durationMs / 1000).toFixed(1)}s` : "";
      const errorText =
        !passed && typeof result.errorMessage === "string" && result.errorMessage.trim()
          ? ` Error: ${result.errorMessage.trim()}`
          : "";
      const tracePath = typeof result.tracePath === "string" ? result.tracePath.trim() : "";
      setLastRunTraceAvailable(tracePath.length > 0);
      const artifactText = tracePath ? " Trace artifact captured." : "";
      setRunStatusMessage(`${selected.label} run ${passed ? "PASSED" : "FAILED"}${durationText}.${errorText}${artifactText}`);
      setStreamState("Live");
    } catch (error: unknown) {
      setRunStatusMessage(error instanceof Error ? error.message : "Failed to run script.");
    } finally {
      if (ranSessionId) {
        try {
          await cancelAutomationSession(projectId, ranSessionId);
          setSessionId(null);
          setSession(null);
          setSessionStartupState("idle");
          setSessionStartUrl("");
          setScreenshotDataUrl(null);
          setStreamState("Disconnected");
          setLiveStreamFailed(false);
          setLiveStreamNonce((prev) => prev + 1);
          setRunStatusMessage((prev) => (prev ? `${prev} Session closed.` : "Session closed."));
        } catch {
          setRunStatusMessage((prev) => (prev ? `${prev} Failed to close session.` : "Failed to close session."));
        }
      }
      setRunBusy(false);
    }
  }

  async function onEndSession() {
    if (!sessionId) {
      router.push(`/projects/${projectId}/testcases/${testcaseId}`);
      return;
    }
    await cancelAutomationSession(projectId, sessionId);
    router.push(`/projects/${projectId}/testcases/${testcaseId}`);
  }

  async function onSendFailedScriptToAegis() {
    if (sendToAegisBusy || !lastRunFailed) return;
    if (!lastRunScript.trim()) {
      setSendToAegisMessage("No failed script found. Run the test first, then send it to Aegis.");
      return;
    }
    setSendToAegisBusy(true);
    setSendToAegisMessage(null);
    try {
      const instruction = aegisInstruction.trim();
      const feedback = [
        "Script failed during rerun-live-preview. Fix the script so it passes reliably.",
        instruction
          ? `Customer instruction: ${instruction}`
          : "Customer instruction: Focus on fixing this failure and keeping assertions stable.",
      ];
      await runAegisInBackground(
        projectId,
        testcaseId,
        testcaseTitle,
        testcaseExternalId,
        "failed_fix",
        {
          botFeedback: feedback,
          previousScript: lastRunScript,
        }
      );
      setSendToAegisMessage("Failed script sent to Aegis. Track progress in Aegis Reviews.");
    } catch (error: unknown) {
      setSendToAegisMessage(error instanceof Error ? error.message : "Failed to send script to Aegis.");
    } finally {
      setSendToAegisBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 flex items-center gap-4">
        <Link href={`/projects/${projectId}/dashboard`} className="text-zinc-700 dark:text-zinc-300">Project</Link>
        <span className="text-zinc-500">/</span>
        <Link href={`/projects/${projectId}/testcases/${testcaseId}`} className="text-zinc-700 dark:text-zinc-300">Test case</Link>
        <span className="text-zinc-500">/</span>
        <span className="text-zinc-700 dark:text-zinc-300">Re Run Last Test</span>
      </header>

      <main className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-6 lg:grid-cols-[380px_1fr]">
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Re Run Last Test (Live Preview)</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Run Test will ask for environment, start a fresh browser session, execute the script, and capture artifacts.
          </p>

          <div className="mt-4 space-y-2">
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">Environment</label>
            <select
              value={selectedEnvironmentUrl}
              onChange={(e) => setSelectedEnvironmentUrl(e.target.value)}
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              {testRunEnvironments.length === 0 && <option value="">No saved environments</option>}
              {testRunEnvironments.map((env) => (
                <option key={env.url} value={env.url}>
                  {env.name} - {env.url}
                </option>
              ))}
            </select>
            <input
              value={customEnvironmentUrl}
              onChange={(e) => setCustomEnvironmentUrl(e.target.value)}
              placeholder="Or enter custom start URL"
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>

          <div className="mt-4 space-y-2">
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">Script Version</label>
            <select
              value={selectedVersionKey}
              onChange={(e) => setSelectedVersionKey(e.target.value)}
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              disabled={scriptVersionOptions.length === 0}
            >
              {scriptVersionOptions.length === 0 && <option value="">No saved script found</option>}
              {scriptVersionOptions.map((version) => (
                <option key={version.key} value={version.key}>
                  {version.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void onRunSelectedVersion()}
              disabled={runBusy}
              className="w-full rounded border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
            >
              {runBusy ? "Running test..." : "Run Test"}
            </button>
          </div>

          <div className="mt-4 space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
            <p><span className="font-medium">Test case:</span> {testcaseTitle}</p>
            <p><span className="font-medium">Stream:</span> {streamState}</p>
            <p><span className="font-medium">URL:</span> {session?.currentUrl || "-"}</p>
            {sessionStartupError && <p className="text-red-600 dark:text-red-300">{sessionStartupError}</p>}
            {runStatusMessage && <p className="text-zinc-700 dark:text-zinc-100">{runStatusMessage}</p>}
            {lastRunTraceAvailable && sessionId && (
              <div className="pt-1">
                <a
                  href={getAutomationSessionTraceUrl(projectId, sessionId)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Download Latest Trace (.zip)
                </a>
              </div>
            )}
          </div>

          {lastRunFailed && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                Test failed. Send this script to Aegis to fix it.
              </p>
              <textarea
                value={aegisInstruction}
                onChange={(e) => setAegisInstruction(e.target.value)}
                rows={3}
                placeholder="Add customer instruction for Aegis (optional)"
                className="mt-2 w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-xs text-zinc-900 dark:border-amber-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onSendFailedScriptToAegis()}
                  disabled={sendToAegisBusy}
                  className="rounded border border-amber-400 bg-amber-100 px-2 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-200 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
                >
                  {sendToAegisBusy ? "Sending..." : "Send to Aegis Fix"}
                </button>
                <Link
                  href={`/projects/${projectId}/agents/aegis/reviews`}
                  className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                >
                  Open Aegis Reviews
                </Link>
              </div>
              {sendToAegisMessage && (
                <p className="mt-2 text-xs text-amber-900 dark:text-amber-200">{sendToAegisMessage}</p>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => void onEndSession()}
            className="mt-4 w-full rounded border border-zinc-300 px-2 py-1.5 text-xs dark:border-zinc-700"
          >
            Back to Test Case
          </button>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Live Preview</h2>
          <div className="relative flex h-[72vh] items-center justify-center rounded border border-zinc-200 bg-black dark:border-zinc-700">
            {screenshotDataUrl ? (
              <img
                src={screenshotDataUrl}
                alt="Live browser snapshot"
                className="h-full w-full object-contain"
              />
            ) : shouldShowLiveStream && !liveStreamFailed ? (
              <img
                key={liveImageSrc}
                src={liveImageSrc}
                alt="Live browser stream"
                className="h-full w-full object-contain"
                onLoad={() => setLiveStreamFailed(false)}
                onError={() => setLiveStreamFailed(true)}
              />
            ) : liveStreamFailed ? (
              <p className="text-sm text-red-400">Live stream unavailable. Retrying...</p>
            ) : (
              <p className="text-sm text-zinc-500">Start a session to view live preview.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
