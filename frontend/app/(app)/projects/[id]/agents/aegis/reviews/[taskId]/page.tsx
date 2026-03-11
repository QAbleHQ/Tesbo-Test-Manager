"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getStoredAgentTasks,
  updateAgentTaskStatus,
  updateAgentTaskScript,
  deleteAgentTask,
  getAgentSettings,
  getProject,
  startAutomationSession,
  getAutomationSession,
  runAutomationPlaywrightScript,
  cancelAutomationSession,
  type AgentTask,
  type AgentTaskStatus,
  type TestEnvironmentSetting,
} from "@/lib/api";
import { getRunByTaskId, onRunsChanged, type AegisRunLogEntry } from "@/lib/aegis-runner";
import { runAegisInBackground } from "@/lib/aegis-runner";
import { AegisBackgroundIndicator } from "@/components/aegis-background-indicator";

function ShieldIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4" />
    </svg>
  );
}

function StatusBadge({ status }: { status: AgentTaskStatus }) {
  const config: Record<AgentTaskStatus, { label: string; cls: string }> = {
    pending_review: { label: "Pending Review", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
    approved: { label: "Approved", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
    rejected: { label: "Rejected", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
    needs_revision: { label: "Needs Revision", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
    in_progress: { label: "In Progress", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
    bot_reviewing: { label: "Bot Reviewing", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
    queued: { label: "Re-queued", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
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

type DetailTab = "script" | "logs" | "live_preview" | "history";
type PreviewStatus = "idle" | "starting" | "running" | "completed" | "failed";
type BotHighlight = {
  xRatio: number;
  yRatio: number;
  widthRatio?: number;
  heightRatio?: number;
  label?: string;
};

function phaseFromTaskStatus(status: AgentTaskStatus): string {
  if (status === "bot_reviewing") return "bot_reviewing";
  if (status === "queued") return "queued";
  if (status === "in_progress") return "building";
  return "queued";
}

function normalizeTaskLogsForObserve(task: AgentTask | null): AegisRunLogEntry[] {
  if (!task || !Array.isArray(task.logs)) return [];
  return task.logs.map((entry) => {
    const parsedTs = Date.parse(entry.ts);
    const type = entry.type as AegisRunLogEntry["type"];
    const safeType: AegisRunLogEntry["type"] =
      type === "thinking" || type === "action" || type === "info" || type === "success" || type === "error" || type === "bot_review"
        ? type
        : "info";
    return {
      ts: Number.isNaN(parsedTs) ? Date.now() : parsedTs,
      message: entry.message,
      type: safeType,
    };
  });
}

function reviewCategoryLabel(key: string): string {
  switch (key) {
    case "goal_validation":
      return "Goal Validation";
    case "rerun_validation":
      return "Rerun Validation";
    case "plan_steps_alignment":
      return "Plan/Steps Alignment";
    case "assertion_validation":
      return "Assertion Validation";
    case "code_quality":
      return "Code Quality";
    case "rerun_execution":
      return "Rerun Execution";
    case "goal_assertion_coverage":
      return "Goal & Assertions Coverage";
    case "minimum_criteria":
      return "Minimum Criteria";
    case "improvement_opportunities":
      return "Improvement Opportunities";
    default:
      return key;
  }
}

export default function ReviewDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const taskId = params.taskId as string;
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

  const [task, setTask] = useState<AgentTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<DetailTab>("script");
  const [feedbackText, setFeedbackText] = useState("");
  const [copied, setCopied] = useState(false);
  const [actionDone, setActionDone] = useState<string | null>(null);
  const [isEditingScript, setIsEditingScript] = useState(false);
  const [editableScript, setEditableScript] = useState("");
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);
  const [previewStreamFailed, setPreviewStreamFailed] = useState(false);
  const [previewHighlight, setPreviewHighlight] = useState<BotHighlight | null>(null);
  const [previewLogs, setPreviewLogs] = useState<{ ts: number; message: string; type: string }[]>([]);
  const cancelledRef = useRef(false);
  const previewLogRef = useRef<HTMLDivElement | null>(null);
  const previewSeenEventIdsRef = useRef<Set<string>>(new Set());
  const previewHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [observeLogs, setObserveLogs] = useState<AegisRunLogEntry[]>([]);
  const [observeSessionId, setObserveSessionId] = useState<string | null>(null);
  const [observePhase, setObservePhase] = useState<string | null>(null);
  const [observeStreamFailed, setObserveStreamFailed] = useState(false);
  const [observeHighlight, setObserveHighlight] = useState<BotHighlight | null>(null);
  const [showObserveScript, setShowObserveScript] = useState(false);
  const [showObserveBotReview, setShowObserveBotReview] = useState(false);
  const [chatPaneRatio, setChatPaneRatio] = useState(35);
  const [resizingPanes, setResizingPanes] = useState(false);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const observeLogRef = useRef<HTMLDivElement | null>(null);
  const observeSeenEventIdsRef = useRef<Set<string>>(new Set());
  const observeHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isObserving = task?.status === "in_progress" || task?.status === "queued" || task?.status === "bot_reviewing";

  const loadTask = useCallback(() => {
    const tasks = getStoredAgentTasks(projectId, "aegis");
    const found = tasks.find((t) => t.id === taskId) || null;
    setTask(found);
    setLoading(false);
  }, [projectId, taskId]);

  useEffect(() => { loadTask(); }, [loadTask]);

  useEffect(() => {
    if (!isEditingScript) {
      setEditableScript(task?.script ?? "");
    }
  }, [task?.script, isEditingScript]);

  // Subscribe to background run changes for observation mode
  useEffect(() => {
    const syncFromRun = () => {
      const run = getRunByTaskId(taskId);
      const tasks = getStoredAgentTasks(projectId, "aegis");
      const found = tasks.find((t) => t.id === taskId) || null;
      if (run) {
        setObserveLogs([...run.logs]);
        setObserveSessionId(run.phase === "bot_reviewing" ? (run.reviewSessionId || run.sessionId) : run.sessionId);
        setObservePhase(run.phase);
      } else if (found && (found.status === "queued" || found.status === "in_progress" || found.status === "bot_reviewing")) {
        setObserveLogs(normalizeTaskLogsForObserve(found));
        setObserveSessionId(found.sessionId || null);
        setObservePhase(phaseFromTaskStatus(found.status));
      }
      // Re-load task from storage to pick up status changes
      if (found) setTask(found);
    };
    syncFromRun();
    return onRunsChanged(syncFromRun);
  }, [projectId, taskId]);

  useEffect(() => {
    setObserveStreamFailed(false);
    setObserveHighlight(null);
    observeSeenEventIdsRef.current = new Set();
    if (observeHighlightTimeoutRef.current) {
      clearTimeout(observeHighlightTimeoutRef.current);
      observeHighlightTimeoutRef.current = null;
    }
  }, [observeSessionId]);

  useEffect(() => {
    setPreviewHighlight(null);
    previewSeenEventIdsRef.current = new Set();
    if (previewHighlightTimeoutRef.current) {
      clearTimeout(previewHighlightTimeoutRef.current);
      previewHighlightTimeoutRef.current = null;
    }
  }, [previewSessionId]);

  useEffect(() => {
    if (previewLogRef.current) previewLogRef.current.scrollTop = previewLogRef.current.scrollHeight;
  }, [previewLogs]);

  useEffect(() => {
    if (observeLogRef.current) observeLogRef.current.scrollTop = observeLogRef.current.scrollHeight;
  }, [observeLogs]);

  useEffect(() => {
    return () => {
      if (previewHighlightTimeoutRef.current) clearTimeout(previewHighlightTimeoutRef.current);
      if (observeHighlightTimeoutRef.current) clearTimeout(observeHighlightTimeoutRef.current);
    };
  }, []);

  const consumeSessionHighlights = useCallback(
    (session: Awaited<ReturnType<typeof getAutomationSession>>, mode: "preview" | "observe") => {
      if (!Array.isArray(session.events) || session.events.length === 0) return;
      const seenRef = mode === "preview" ? previewSeenEventIdsRef : observeSeenEventIdsRef;

      for (const event of session.events) {
        const eventId = typeof event.id === "string" ? event.id : "";
        if (!eventId || seenRef.current.has(eventId)) continue;
        seenRef.current.add(eventId);

        const executionResult = (event.executionResult ?? {}) as Record<string, unknown>;
        const nestedResult = (executionResult.result ?? {}) as Record<string, unknown>;
        const highlightSource =
          typeof nestedResult.highlight === "object" && nestedResult.highlight
            ? (nestedResult.highlight as Record<string, unknown>)
            : typeof executionResult.highlight === "object" && executionResult.highlight
              ? (executionResult.highlight as Record<string, unknown>)
              : null;
        if (!highlightSource) continue;

        const xRatio = typeof highlightSource.xRatio === "number" ? highlightSource.xRatio : null;
        const yRatio = typeof highlightSource.yRatio === "number" ? highlightSource.yRatio : null;
        if (xRatio == null || yRatio == null) continue;

        const highlight: BotHighlight = {
          xRatio,
          yRatio,
          widthRatio: typeof highlightSource.widthRatio === "number" ? highlightSource.widthRatio : undefined,
          heightRatio: typeof highlightSource.heightRatio === "number" ? highlightSource.heightRatio : undefined,
          label: typeof highlightSource.label === "string" ? highlightSource.label : undefined,
        };

        if (mode === "preview") {
          setPreviewHighlight(highlight);
          if (previewHighlightTimeoutRef.current) clearTimeout(previewHighlightTimeoutRef.current);
          previewHighlightTimeoutRef.current = setTimeout(() => setPreviewHighlight(null), 2200);
        } else {
          setObserveHighlight(highlight);
          if (observeHighlightTimeoutRef.current) clearTimeout(observeHighlightTimeoutRef.current);
          observeHighlightTimeoutRef.current = setTimeout(() => setObserveHighlight(null), 2200);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!observeSessionId || !isObserving) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const session = await getAutomationSession(projectId, observeSessionId);
        if (cancelled) return;
        consumeSessionHighlights(session, "observe");
      } catch {}
    };
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, observeSessionId, isObserving, consumeSessionHighlights]);

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

  const addPreviewLog = useCallback((message: string, type: string = "info") => {
    setPreviewLogs((prev) => [...prev, { ts: Date.now(), message, type }]);
  }, []);

  const handleRunPreview = useCallback(async () => {
    if (!task) return;
    const scriptToRun = (isEditingScript ? editableScript : task.script) ?? "";
    if (!scriptToRun.trim()) {
      setPreviewLogs([]);
      setPreviewStatus("failed");
      setActiveTab("live_preview");
      addPreviewLog("No script available to run. Generate or save a script first.", "error");
      return;
    }
    cancelledRef.current = false;
    setPreviewStatus("starting");
    setPreviewLogs([]);
    setPreviewStreamFailed(false);
    setPreviewHighlight(null);
    previewSeenEventIdsRef.current = new Set();
    if (previewHighlightTimeoutRef.current) {
      clearTimeout(previewHighlightTimeoutRef.current);
      previewHighlightTimeoutRef.current = null;
    }
    setPreviewSessionId(null);
    setActiveTab("live_preview");

    addPreviewLog("Resolving environment...", "info");

    let envUrl: string | null = null;
    const settings = getAgentSettings(projectId, "aegis");
    if (settings.defaultEnvironmentUrl) {
      envUrl = settings.defaultEnvironmentUrl;
    } else {
      try {
        const p = await getProject(projectId);
        const parsed = typeof p.settings === "string" && p.settings.trim() ? JSON.parse(p.settings) : {};
        const automation = parsed.automation as Record<string, unknown> | undefined;
        const envs = normalizeTestRunEnvironments(automation?.testRunEnvironments);
        if (envs.length > 0) envUrl = envs[0].url;
      } catch {}
    }

    if (!envUrl) {
      addPreviewLog("No environment configured. Please set one in Aegis settings.", "error");
      setPreviewStatus("failed");
      return;
    }

    try {
      addPreviewLog(`Starting browser session on ${envUrl}...`, "info");
      const { id: sessionId } = await startAutomationSession(projectId, task.testcaseId, { startUrl: envUrl });
      setPreviewSessionId(sessionId);
      setPreviewStatus("running");

      addPreviewLog("Session created. Executing saved script...", "info");
      const result = await runAutomationPlaywrightScript(projectId, sessionId, {
        script: scriptToRun,
        startUrl: envUrl,
        actionDelayMs: 700,
      });
      try {
        const session = await getAutomationSession(projectId, sessionId);
        consumeSessionHighlights(session, "preview");
      } catch {
        // best effort for highlight sync
      }

      if (cancelledRef.current) {
        try { await cancelAutomationSession(projectId, sessionId); } catch {}
        addPreviewLog("Preview run cancelled.", "info");
        setPreviewStatus("idle");
      } else {
        const status = typeof result.status === "string" ? result.status.toLowerCase() : "failed";
        const passed = status === "passed" || status === "success";
        if (passed) {
          addPreviewLog("Script execution completed successfully.", "success");
          setPreviewStatus("completed");
        } else {
          const message = typeof result.errorMessage === "string" && result.errorMessage.trim()
            ? result.errorMessage.trim()
            : "Script execution failed.";
          addPreviewLog(`Script execution failed: ${message}`, "error");
          setPreviewStatus("failed");
        }
      }
    } catch (err) {
      if (cancelledRef.current) {
        addPreviewLog("Preview run cancelled.", "info");
        setPreviewStatus("idle");
      } else {
        addPreviewLog(`Failed to start preview: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
        setPreviewStatus("failed");
      }
    }
  }, [task, projectId, addPreviewLog, consumeSessionHighlights, editableScript, isEditingScript]);

  const handleStopPreview = useCallback(async () => {
    cancelledRef.current = true;
    if (previewSessionId) {
      try { await cancelAutomationSession(projectId, previewSessionId); } catch {}
    }
    if (previewHighlightTimeoutRef.current) {
      clearTimeout(previewHighlightTimeoutRef.current);
      previewHighlightTimeoutRef.current = null;
    }
    setPreviewHighlight(null);
    setPreviewStatus("idle");
    addPreviewLog("Preview stopped by user.", "info");
  }, [previewSessionId, projectId, addPreviewLog]);

  const handleApprove = () => {
    const updated = updateAgentTaskStatus(projectId, "aegis", taskId, "approved");
    if (updated) {
      setTask(updated);
      setActionDone("approved");
      setTimeout(() => setActionDone(null), 3000);
    }
  };

  const handleRejectChanges = () => {
    const reason = rejectReason.trim() || undefined;
    const updated = updateAgentTaskStatus(projectId, "aegis", taskId, "rejected", reason);
    if (updated) {
      setTask(updated);
      setShowRejectConfirm(false);
      setRejectReason("");
      setActionDone("rejected");
      setTimeout(() => setActionDone(null), 3000);
    }
  };

  const handleReject = () => {
    if (!feedbackText.trim()) return;
    const updated = updateAgentTaskStatus(projectId, "aegis", taskId, "needs_revision", feedbackText.trim());
    if (updated) {
      updateAgentTaskStatus(projectId, "aegis", taskId, "in_progress");
      setFeedbackText("");
      setActionDone("feedback_sent");
      setTimeout(() => setActionDone(null), 5000);
      setTask({ ...updated, status: "in_progress", feedback: [...updated.feedback] });
      runAegisInBackground(projectId, updated.testcaseId, updated.testcaseTitle, updated.testcaseExternalId, "revision");
    }
  };

  const handleRequeue = () => {
    const updated = updateAgentTaskStatus(projectId, "aegis", taskId, "in_progress");
    if (updated) {
      setActionDone("requeued");
      setTimeout(() => setActionDone(null), 5000);
      setTask({ ...updated });
      runAegisInBackground(projectId, updated.testcaseId, updated.testcaseTitle, updated.testcaseExternalId, "revision");
    }
  };

  const handleDeleteTask = () => {
    if (!confirm("Delete this task? This cannot be undone.")) return;
    deleteAgentTask(projectId, "aegis", taskId);
    router.push(`/projects/${projectId}/agents/aegis`);
  };

  const handleCopyScript = () => {
    if (task?.script && typeof navigator !== "undefined") {
      navigator.clipboard.writeText(isEditingScript ? editableScript : task.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleStartEditScript = () => {
    setEditableScript(task?.script ?? "");
    setIsEditingScript(true);
  };

  const handleCancelEditScript = () => {
    setEditableScript(task?.script ?? "");
    setIsEditingScript(false);
  };

  const handleSaveScript = () => {
    if (!task) return;
    const updated = updateAgentTaskScript(projectId, "aegis", taskId, editableScript);
    if (updated) {
      setTask({ ...updated });
      setIsEditingScript(false);
      setActionDone("script_saved");
      setTimeout(() => setActionDone(null), 3000);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-10">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex-1 p-6 md:p-10 max-w-4xl mx-auto w-full">
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <p className="text-sm text-[var(--muted)] mb-2">Review task not found.</p>
          <Link href={`/projects/${projectId}/agents/aegis/reviews`} className="text-sm font-medium text-[var(--primary)] hover:underline">
            Back to Reviews
          </Link>
        </div>
      </div>
    );
  }

  const liveStreamUrl = previewSessionId
    ? `${apiBase}/api/projects/${projectId}/automation/sessions/${previewSessionId}/live`
    : null;

  const observeLiveStreamUrl = observeSessionId
    ? `${apiBase}/api/projects/${projectId}/automation/sessions/${observeSessionId}/live`
    : null;

  // ========== OBSERVATION MODE (in_progress / bot_reviewing / queued) ==========
  if (isObserving) {
    const phaseLabel = observePhase === "bot_reviewing"
      ? "Bot Reviewing Script"
      : observePhase === "building"
        ? "Building Automation"
        : task.status === "queued"
          ? "Queued"
          : "Working...";

    return (
      <div className="flex flex-col h-screen">
        {/* Top Bar */}
        <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)]">
              <ShieldIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-[var(--foreground)]">Aegis — Observing</h1>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                  </span>
                  {phaseLabel}
                </span>
              </div>
              <p className="text-xs text-[var(--muted)] truncate max-w-md">{task.testcaseTitle}</p>
            </div>
          </div>
          <Link
            href={`/projects/${projectId}/agents/aegis`}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Back to Aegis
          </Link>
        </div>

        {/* Phase Progress Bar */}
        <div className="flex items-center gap-0 shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
          {["queued", "building", "bot_reviewing", "completed"].map((phase, i) => {
            const isCurrent = observePhase === phase;
            const isPast = observePhase === "completed" || (observePhase === "bot_reviewing" && i < 2) || (observePhase === "building" && i < 1);
            return (
              <div key={phase} className="flex items-center gap-2 flex-1">
                <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold shrink-0 ${
                  isCurrent
                    ? "bg-blue-500 text-white"
                    : isPast
                      ? "bg-green-500 text-white"
                      : "bg-zinc-200 dark:bg-zinc-700 text-zinc-500"
                }`}>
                  {isPast && !isCurrent ? (
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span className={`text-xs font-medium capitalize ${isCurrent ? "text-blue-600 dark:text-blue-400" : isPast ? "text-green-600 dark:text-green-400" : "text-[var(--muted)]"}`}>
                  {phase === "bot_reviewing" ? "Bot Review" : phase}
                </span>
                {i < 3 && <div className={`flex-1 h-px ${isPast ? "bg-green-400" : "bg-zinc-200 dark:bg-zinc-700"}`} />}
              </div>
            );
          })}
        </div>

        {/* Split pane: Bot Chat + Live Preview */}
        <div ref={splitPaneRef} className="flex flex-1 min-h-0 overflow-hidden" style={{ userSelect: resizingPanes ? "none" : undefined }}>
          {/* Left Panel — Bot Thinking & Actions */}
          <div className="flex flex-col border-r border-[var(--border)] overflow-hidden" style={{ width: `${chatPaneRatio}%` }}>
            <div className="px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Bot Activity</span>
                <span className="text-xs text-[var(--muted)]">({observeLogs.length} events)</span>
              </div>
            </div>
            <div ref={observeLogRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {observeLogs.map((entry, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  entry.type === "thinking"
                    ? "bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30"
                    : entry.type === "action"
                      ? "bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30"
                      : entry.type === "bot_review"
                        ? "bg-purple-50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-900/30"
                        : entry.type === "success"
                          ? "bg-green-50 dark:bg-green-900/10 border border-green-100 dark:border-green-900/30"
                          : entry.type === "error"
                            ? "bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30"
                            : "bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800"
                }`}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {entry.type === "thinking" && (
                      <svg className="h-3 w-3 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                    )}
                    {entry.type === "action" && (
                      <svg className="h-3 w-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    )}
                    {entry.type === "bot_review" && (
                      <svg className="h-3 w-3 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    )}
                    {entry.type === "success" && (
                      <svg className="h-3 w-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    )}
                    {entry.type === "error" && (
                      <svg className="h-3 w-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    )}
                    <span className="text-[10px] text-[var(--muted)]">{new Date(entry.ts).toLocaleTimeString()}</span>
                    <span className={`text-[10px] font-semibold uppercase ${
                      entry.type === "thinking" ? "text-blue-500" :
                      entry.type === "action" ? "text-emerald-500" :
                      entry.type === "bot_review" ? "text-purple-500" :
                      entry.type === "success" ? "text-green-500" :
                      entry.type === "error" ? "text-red-500" :
                      "text-zinc-400"
                    }`}>{entry.type === "bot_review" ? "review" : entry.type}</span>
                  </div>
                  <p className={`${
                    entry.type === "thinking" ? "text-blue-700 dark:text-blue-300" :
                    entry.type === "action" ? "text-emerald-700 dark:text-emerald-300" :
                    entry.type === "bot_review" ? "text-purple-700 dark:text-purple-300" :
                    entry.type === "success" ? "text-green-700 dark:text-green-300" :
                    entry.type === "error" ? "text-red-700 dark:text-red-300" :
                    "text-[var(--foreground)]"
                  }`}>{entry.message}</p>
                  {entry.detail && (
                    <p className="mt-1 text-[10px] text-[var(--muted)] break-words">
                      {entry.detail}
                    </p>
                  )}
                </div>
              ))}
              {observeLogs.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent mb-3" />
                  <p className="text-xs text-[var(--muted)]">Waiting for bot activity...</p>
                </div>
              )}
            </div>

            {task.script && (
              <div className="border-t border-[var(--border)] p-3 shrink-0">
                <button
                  onClick={() => setShowObserveScript((prev) => !prev)}
                  className="w-full flex items-center justify-between rounded-md border border-[var(--border)] bg-zinc-50 dark:bg-zinc-900/50 px-2.5 py-2 text-left"
                >
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                      Generated Script
                    </span>
                    <p className="text-[10px] text-[var(--muted)]">Displayed before final bot verdict</p>
                  </div>
                  <svg
                    className={`h-4 w-4 text-[var(--muted)] transition-transform ${showObserveScript ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showObserveScript && (
                  <pre className="mt-2 max-h-56 overflow-y-auto rounded-md border border-[var(--border)] bg-zinc-50 dark:bg-zinc-900 p-2 text-[10px] leading-relaxed overflow-x-auto">
                    {task.script}
                  </pre>
                )}
              </div>
            )}

            {/* Bot Review Result Summary */}
            {task.botReview && (
              <div className="border-t border-[var(--border)] p-3 shrink-0">
                <div className={`rounded-lg p-3 ${
                  task.botReview.status === "passed"
                    ? "bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                }`}>
                  <button
                    onClick={() => setShowObserveBotReview((prev) => !prev)}
                    className="w-full flex items-center gap-2"
                  >
                    {task.botReview.status === "passed" ? (
                      <svg className="h-4 w-4 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    ) : (
                      <svg className="h-4 w-4 text-red-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    )}
                    <span className={`text-xs font-bold ${task.botReview.status === "passed" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                      Bot Review: {task.botReview.status === "passed" ? "PASSED" : "NEEDS IMPROVEMENT"}
                    </span>
                    {typeof task.botReview.reviewCycle === "number" && typeof task.botReview.maxReviewCycles === "number" && (
                      <span className="ml-auto text-[10px] text-[var(--muted)]">
                        Cycle {task.botReview.reviewCycle}/{task.botReview.maxReviewCycles}
                      </span>
                    )}
                    <svg
                      className={`h-4 w-4 text-[var(--muted)] transition-transform ${showObserveBotReview ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showObserveBotReview && (
                    <>
                      {task.botReview.categories && task.botReview.categories.length > 0 && (
                        <div className="mt-2 rounded-md border border-[var(--border)] bg-white/60 dark:bg-zinc-900/30 p-2 space-y-1">
                          {task.botReview.categories.map((category, idx) => (
                            <div key={idx} className="flex items-start gap-1.5 text-[10px]">
                              {category.passed ? (
                                <svg className="h-3 w-3 text-green-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                              ) : (
                                <svg className="h-3 w-3 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                              )}
                              <div className="min-w-0">
                                <span className={`font-semibold ${category.passed ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                                  {reviewCategoryLabel(category.key)}
                                </span>
                                <p className="text-[var(--foreground)]">{category.detail}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {task.botReview.feedback.length > 0 && (
                        <div className="mt-2 text-[10px] space-y-0.5">
                          {task.botReview.feedback.slice(0, 3).map((fb, i) => (
                            <p key={i} className="text-red-700 dark:text-red-300">- {fb}</p>
                          ))}
                        </div>
                      )}
                      <div className="space-y-0.5 mt-2">
                        {task.botReview.validatedSteps.map((vs, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[10px]">
                            {vs.passed ? (
                              <svg className="h-3 w-3 text-green-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                            ) : (
                              <svg className="h-3 w-3 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                            )}
                            <span className="text-[var(--foreground)]">{vs.step}</span>
                          </div>
                        ))}
                      </div>
                      {task.botReview.assertionSuggestions && task.botReview.assertionSuggestions.length > 0 && (
                        <div className="mt-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/20 p-2 space-y-1">
                          <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">Assertion Suggestions</p>
                          {task.botReview.assertionSuggestions.slice(0, 2).map((s, idx) => (
                            <div key={idx} className="text-[10px] text-amber-800 dark:text-amber-300">
                              <p className="font-medium">{s.step}</p>
                              <p>{s.suggestion}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Resize Handle */}
          <div
            onMouseDown={handleSplitMouseDown}
            className="w-1.5 cursor-col-resize bg-[var(--border)] hover:bg-[var(--primary)]/40 transition-colors shrink-0"
          />

          {/* Right Panel — Live Browser Preview */}
          <div className="flex-1 flex flex-col bg-zinc-100 dark:bg-zinc-900 min-w-0">
            {observeLiveStreamUrl && !observeStreamFailed ? (
              <div className="relative flex-1 flex items-center justify-center p-2 overflow-hidden">
                <img
                  src={observeLiveStreamUrl}
                  alt="Live browser preview"
                  className="max-w-full max-h-full object-contain rounded-lg shadow-lg border border-[var(--border)]"
                  onError={() => setObserveStreamFailed(true)}
                />
                {observeHighlight && (
                  <div
                    className="pointer-events-none absolute z-20 rounded border-2 border-emerald-400 bg-emerald-300/20 shadow-[0_0_0_2px_rgba(16,185,129,0.35)]"
                    style={{
                      left: `${Math.max(0, Math.min(100, observeHighlight.xRatio * 100))}%`,
                      top: `${Math.max(0, Math.min(100, observeHighlight.yRatio * 100))}%`,
                      width: `${Math.max(1.2, Math.min(100, (observeHighlight.widthRatio ?? 0.04) * 100))}%`,
                      height: `${Math.max(1.2, Math.min(100, (observeHighlight.heightRatio ?? 0.05) * 100))}%`,
                    }}
                    title={observeHighlight.label || "Current interaction target"}
                  />
                )}
              </div>
            ) : observeStreamFailed ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <svg className="h-10 w-10 text-zinc-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm text-[var(--muted)]">Browser preview unavailable</p>
                  <p className="text-xs text-[var(--muted)] mt-1">Bot is still working. Watch the activity log on the left.</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent mx-auto mb-3" />
                  <p className="text-sm text-[var(--muted)]">Connecting to browser session...</p>
                  <p className="text-xs text-[var(--muted)] mt-1">The live preview will appear once the bot starts the browser.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ========== NORMAL REVIEW MODE ==========

  const tabs: { id: DetailTab; label: string; available: boolean; badge?: string }[] = [
    { id: "script", label: "Generated Script", available: Boolean(task.script) },
    {
      id: "live_preview",
      label: "Live Preview",
      available: true,
      badge: previewStatus === "running" ? "LIVE" : undefined,
    },
    { id: "logs", label: "Activity Logs", available: task.logs.length > 0 },
    { id: "history", label: "Feedback History", available: true },
  ];

  return (
    <div className="flex-1 p-6 md:p-10 max-w-5xl mx-auto w-full">
      <AegisBackgroundIndicator />
      {/* Breadcrumb */}
      <Link
        href={`/projects/${projectId}/agents/aegis`}
        className="text-sm text-[var(--muted)] hover:text-[var(--primary)] mb-4 inline-flex items-center gap-1"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Aegis
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)] mt-0.5">
            <ShieldIcon className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
              <StatusBadge status={task.status} />
              {task.botReview && (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  task.botReview.status === "passed"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}>
                  Bot Review: {task.botReview.status}
                </span>
              )}
            </div>
            <h1 className="text-lg font-bold text-[var(--foreground)]">{task.testcaseTitle}</h1>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Created {new Date(task.createdAt).toLocaleString()}
              {task.duration ? ` · Duration: ${(task.duration / 1000).toFixed(1)}s` : ""}
              {task.feedback.length > 0 ? ` · ${task.feedback.length} revision${task.feedback.length > 1 ? "s" : ""}` : ""}
            </p>
          </div>
        </div>
        {/* Run Preview button in header */}
        {task.status === "pending_review" && previewStatus === "idle" && (
          <button
            onClick={handleRunPreview}
            className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Run & Preview
          </button>
        )}
        {previewStatus === "running" && (
          <button
            onClick={handleStopPreview}
            className="rounded-lg border border-red-300 dark:border-red-700 px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            Stop Preview
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            disabled={!tab.available}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === tab.id
                ? "border-[var(--primary)] text-[var(--primary)]"
                : tab.available
                  ? "border-transparent text-[var(--muted)] hover:text-[var(--foreground)] hover:border-zinc-300"
                  : "border-transparent text-zinc-300 dark:text-zinc-700 cursor-not-allowed"
            }`}
          >
            {tab.label}
            {tab.badge && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wider">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        {activeTab === "script" && (
          <div>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Playwright Script</span>
              <div className="flex items-center gap-2">
                {task.status === "pending_review" && previewStatus === "idle" && (
                  <button
                    onClick={handleRunPreview}
                    className="rounded-lg border border-[var(--primary)] px-3 py-1 text-xs font-medium text-[var(--primary)] hover:bg-[#e8f5eb] dark:hover:bg-zinc-800 flex items-center gap-1.5"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Run & Preview
                  </button>
                )}
                {task.status === "pending_review" && task.script && !isEditingScript && (
                  <button
                    onClick={handleStartEditScript}
                    className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    Edit Script
                  </button>
                )}
                {task.status === "pending_review" && task.script && isEditingScript && (
                  <>
                    <button
                      onClick={handleCancelEditScript}
                      className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveScript}
                      className="rounded-lg bg-[var(--primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                    >
                      Save Script
                    </button>
                  </>
                )}
                <button
                  onClick={handleCopyScript}
                  className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--primary)] hover:bg-[#e8f5eb] dark:hover:bg-zinc-800"
                >
                  {copied ? "Copied!" : "Copy Script"}
                </button>
              </div>
            </div>
            {task.script ? (
              isEditingScript ? (
                <textarea
                  value={editableScript}
                  onChange={(e) => setEditableScript(e.target.value)}
                  spellCheck={false}
                  className="w-full min-h-[500px] p-4 text-sm text-[var(--foreground)] leading-relaxed font-mono bg-zinc-50 dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/40 resize-y"
                />
              ) : (
                <pre className="p-4 text-sm text-[var(--foreground)] overflow-x-auto leading-relaxed font-mono bg-zinc-50 dark:bg-zinc-900 max-h-[500px] overflow-y-auto">
                  {task.script}
                </pre>
              )
            ) : (
              <div className="p-8 text-center text-sm text-[var(--muted)]">No script generated for this task.</div>
            )}
          </div>
        )}

        {activeTab === "live_preview" && (
          <div>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Live Preview</span>
                {previewStatus === "running" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wider">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                    LIVE
                  </span>
                )}
                {previewStatus === "completed" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/40 px-2 py-0.5 text-[10px] font-bold text-green-600 dark:text-green-400 uppercase tracking-wider">
                    DONE
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {previewStatus === "idle" && task.status === "pending_review" && (
                  <button
                    onClick={handleRunPreview}
                    className="rounded-lg bg-[var(--primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 flex items-center gap-1.5"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Start Run
                  </button>
                )}
                {previewStatus === "running" && (
                  <button
                    onClick={handleStopPreview}
                    className="rounded-lg border border-red-300 dark:border-red-700 px-3 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    Stop
                  </button>
                )}
                {(previewStatus === "completed" || previewStatus === "failed") && task.status === "pending_review" && (
                  <button
                    onClick={() => {
                      if (previewHighlightTimeoutRef.current) {
                        clearTimeout(previewHighlightTimeoutRef.current);
                        previewHighlightTimeoutRef.current = null;
                      }
                      setPreviewHighlight(null);
                      setPreviewStatus("idle");
                      setPreviewSessionId(null);
                      setPreviewLogs([]);
                    }}
                    className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Browser viewport */}
            <div className="bg-zinc-100 dark:bg-zinc-900 min-h-[400px] flex flex-col">
              {previewStatus === "idle" && (
                <div className="flex-1 flex items-center justify-center p-12 min-h-[400px]">
                  <div className="text-center max-w-md">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#e8f5eb] dark:bg-zinc-800 text-[var(--primary)] mx-auto mb-4">
                      <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Validate with Live Preview</h3>
                    <p className="text-xs text-[var(--muted)] mb-4">
                      Re-run the automation against your application and watch it execute in real-time.
                      Verify that the correct actions are being performed before approving the script.
                    </p>
                    {task.status === "pending_review" && (
                      <button
                        onClick={handleRunPreview}
                        className="rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity inline-flex items-center gap-2"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        </svg>
                        Run & Preview
                      </button>
                    )}
                  </div>
                </div>
              )}

              {previewStatus === "starting" && (
                <div className="flex-1 flex items-center justify-center p-12 min-h-[400px]">
                  <div className="text-center">
                    <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent mx-auto mb-3" />
                    <p className="text-sm text-[var(--muted)]">Starting browser session...</p>
                  </div>
                </div>
              )}

              {(previewStatus === "running" || previewStatus === "completed") && (
                <div className="flex flex-col">
                  {/* Live browser image */}
                  <div className="relative flex items-center justify-center p-3 min-h-[350px] bg-zinc-900">
                    {liveStreamUrl && !previewStreamFailed ? (
                      <img
                        src={liveStreamUrl}
                        alt="Live browser preview"
                        className="max-w-full max-h-[450px] object-contain rounded-lg shadow-lg border border-zinc-700"
                        onError={() => setPreviewStreamFailed(true)}
                      />
                    ) : previewStreamFailed ? (
                      <div className="text-center">
                        <svg className="h-10 w-10 text-zinc-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        <p className="text-sm text-zinc-400">Browser preview unavailable</p>
                        <p className="text-xs text-zinc-500 mt-1">The execution is still running. Check the logs below.</p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent mx-auto mb-2" />
                        <p className="text-sm text-zinc-400">Connecting to browser...</p>
                      </div>
                    )}
                    {previewHighlight && (
                      <div
                        className="pointer-events-none absolute z-20 rounded border-2 border-emerald-400 bg-emerald-300/20 shadow-[0_0_0_2px_rgba(16,185,129,0.35)]"
                        style={{
                          left: `${Math.max(0, Math.min(100, previewHighlight.xRatio * 100))}%`,
                          top: `${Math.max(0, Math.min(100, previewHighlight.yRatio * 100))}%`,
                          width: `${Math.max(1.2, Math.min(100, (previewHighlight.widthRatio ?? 0.04) * 100))}%`,
                          height: `${Math.max(1.2, Math.min(100, (previewHighlight.heightRatio ?? 0.05) * 100))}%`,
                        }}
                        title={previewHighlight.label || "Current interaction target"}
                      />
                    )}
                  </div>

                  {/* Preview execution log */}
                  <div className="border-t border-[var(--border)] max-h-[180px] overflow-y-auto" ref={previewLogRef}>
                    <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Execution Log</span>
                      <span className="ml-2 text-[10px] text-[var(--muted)]">Green box indicates active interaction target.</span>
                    </div>
                    <div className="p-3 space-y-0.5">
                      {previewLogs.map((entry, i) => (
                        <div key={i} className="text-xs leading-relaxed font-mono">
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
                      {previewLogs.length === 0 && (
                        <p className="text-xs text-[var(--muted)] italic">Waiting for activity...</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {previewStatus === "failed" && (
                <div className="flex-1 flex items-center justify-center p-12 min-h-[400px]">
                  <div className="text-center">
                    <svg className="h-10 w-10 text-red-500 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-1">Preview run failed</p>
                    {previewLogs.length > 0 && (
                      <p className="text-xs text-[var(--muted)]">
                        {previewLogs[previewLogs.length - 1].message}
                      </p>
                    )}
                    {task.status === "pending_review" && (
                      <button
                        onClick={() => {
                          if (previewHighlightTimeoutRef.current) {
                            clearTimeout(previewHighlightTimeoutRef.current);
                            previewHighlightTimeoutRef.current = null;
                          }
                          setPreviewHighlight(null);
                          setPreviewStatus("idle");
                          setPreviewSessionId(null);
                          setPreviewLogs([]);
                        }}
                        className="mt-4 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      >
                        Try Again
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div className="max-h-[500px] overflow-y-auto">
            <div className="px-4 py-2.5 border-b border-[var(--border)]">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Execution Logs</span>
            </div>
            {task.logs.length > 0 ? (
              <div className="p-4 space-y-1">
                {task.logs.map((entry, i) => (
                  <div key={i} className="text-xs leading-relaxed font-mono">
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
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-[var(--muted)]">No logs available.</div>
            )}
          </div>
        )}

        {activeTab === "history" && (
          <div>
            <div className="px-4 py-2.5 border-b border-[var(--border)]">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Feedback & Revision History</span>
            </div>

            {/* Bot Review Result */}
            {task.botReview && (
              <div className="p-4 border-b border-[var(--border)]">
                <div className={`rounded-lg p-4 ${
                  task.botReview.status === "passed"
                    ? "bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {task.botReview.status === "passed" ? (
                      <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    ) : (
                      <svg className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    )}
                    <span className={`text-sm font-bold ${task.botReview.status === "passed" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                      Bot Review: {task.botReview.status === "passed" ? "PASSED" : "NEEDS IMPROVEMENT"}
                    </span>
                    <span className="text-xs text-[var(--muted)] ml-auto">{new Date(task.botReview.reviewedAt).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2 mb-3 text-xs text-[var(--muted)]">
                    <span>Script execution: {task.botReview.scriptRanSuccessfully ? "Passed" : "Failed"}</span>
                    <span className="text-zinc-300 dark:text-zinc-600">|</span>
                    <span>Steps validated: {task.botReview.validatedSteps.filter(s => s.passed).length}/{task.botReview.validatedSteps.length}</span>
                    {typeof task.botReview.reviewCycle === "number" && typeof task.botReview.maxReviewCycles === "number" && (
                      <>
                        <span className="text-zinc-300 dark:text-zinc-600">|</span>
                        <span>Cycle: {task.botReview.reviewCycle}/{task.botReview.maxReviewCycles}</span>
                      </>
                    )}
                  </div>
                  {task.botReview.categories && task.botReview.categories.length > 0 && (
                    <div className="mb-3 rounded-lg border border-[var(--border)] bg-white/60 dark:bg-zinc-900/30 p-3 space-y-2">
                      <span className="text-xs font-semibold text-[var(--muted)]">Review Categories</span>
                      {task.botReview.categories.map((category, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs">
                          {category.passed ? (
                            <svg className="h-4 w-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          ) : (
                            <svg className="h-4 w-4 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          )}
                          <div className="min-w-0">
                            <span className={`font-semibold ${category.passed ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                              {reviewCategoryLabel(category.key)}
                            </span>
                            <p className="text-[var(--foreground)]">{category.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1">
                    {task.botReview.validatedSteps.map((vs, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        {vs.passed ? (
                          <svg className="h-4 w-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        ) : (
                          <svg className="h-4 w-4 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        )}
                        <span className="text-[var(--foreground)]">{vs.step}</span>
                      </div>
                    ))}
                  </div>
                  {task.botReview.feedback.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700 space-y-1">
                      <span className="text-xs font-semibold text-[var(--muted)]">Bot Feedback:</span>
                      {task.botReview.feedback.map((fb, i) => (
                        <p key={i} className="text-xs text-[var(--foreground)]">{fb}</p>
                      ))}
                    </div>
                  )}
                  {task.botReview.assertionSuggestions && task.botReview.assertionSuggestions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-amber-200 dark:border-amber-800 space-y-1">
                      <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">Assertion Suggestions:</span>
                      {task.botReview.assertionSuggestions.map((suggestion, idx) => (
                        <div key={idx} className="text-xs text-[var(--foreground)] rounded border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/20 p-2">
                          <p><span className="font-semibold">Step:</span> {suggestion.step}</p>
                          <p><span className="font-semibold">Suggestion:</span> {suggestion.suggestion}</p>
                          <p className="text-[var(--muted)]"><span className="font-semibold">Why:</span> {suggestion.reason}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Human Feedback */}
            {task.feedback.length > 0 ? (
              <div className="p-4 space-y-3">
                {task.feedback.map((fb) => (
                  <div key={fb.id} className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="h-6 w-6 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center">
                        <svg className="h-3.5 w-3.5 text-[var(--muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                      </div>
                      <span className="text-xs font-medium text-[var(--foreground)]">Human Reviewer</span>
                      <span className="text-xs text-[var(--muted)]">{new Date(fb.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-[var(--foreground)] pl-8">{fb.message}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-[var(--muted)]">
                No human feedback provided yet.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Bar */}
      <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        {actionDone && (
          <div className={`mb-4 rounded-lg p-3 text-sm font-medium ${
            actionDone === "approved"
              ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
              : actionDone === "rejected"
                ? "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                : actionDone === "feedback_sent"
                  ? "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                  : "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
          }`}>
            {actionDone === "approved" && "Script approved and saved to the test case."}
            {actionDone === "rejected" && "Script has been rejected. The generated changes have been discarded."}
            {actionDone === "script_saved" && "Script changes saved."}
            {actionDone === "feedback_sent" && "Feedback sent. Aegis is already working on the revision in the background."}
            {actionDone === "requeued" && "Aegis is re-running this task in the background."}
          </div>
        )}

        {task.status === "pending_review" && (
          <>
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-3">Review Actions</h3>
            <div className="flex flex-col gap-4">
              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={handleApprove}
                  className="rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors"
                >
                  Approve Script
                </button>
                <button
                  onClick={() => setShowRejectConfirm(true)}
                  className="rounded-lg border border-red-300 dark:border-red-700 px-5 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  Reject Script
                </button>
                {previewStatus === "idle" && (
                  <button
                    onClick={handleRunPreview}
                    className="rounded-lg border border-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary)] hover:bg-[#e8f5eb] dark:hover:bg-zinc-800 transition-colors flex items-center gap-1.5"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Run & Validate
                  </button>
                )}
                {previewStatus === "running" && (
                  <span className="inline-flex items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-2 text-sm text-blue-700 dark:text-blue-400">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                    Preview running...
                  </span>
                )}
              </div>

              {showRejectConfirm && (
                <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30 shrink-0 mt-0.5">
                      <svg className="h-4 w-4 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h4 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-1">Reject this script?</h4>
                      <p className="text-xs text-red-600/80 dark:text-red-400/70 mb-3">
                        The generated script will be discarded and the task will be marked as rejected. This will not trigger a re-run.
                      </p>
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason for rejection (optional)..."
                        rows={2}
                        className="w-full rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-red-400/40 resize-none mb-3"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleRejectChanges}
                          className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
                        >
                          Confirm Reject
                        </button>
                        <button
                          onClick={() => { setShowRejectConfirm(false); setRejectReason(""); }}
                          className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="text-sm font-medium text-[var(--foreground)] mb-1.5 block">
                  Provide feedback to improve
                </label>
                <textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="Describe what needs to change (e.g., 'Add assertion for the success message', 'Navigate to settings page instead of dashboard')..."
                  rows={3}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/40 resize-none"
                />
                <button
                  onClick={handleReject}
                  disabled={!feedbackText.trim()}
                  className="mt-2 rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white hover:bg-amber-700 transition-colors disabled:opacity-50"
                >
                  Send Feedback & Re-run Aegis
                </button>
              </div>

              <div className="rounded-lg border border-[var(--border)] bg-zinc-50 p-4 dark:bg-zinc-900/40">
                <h4 className="text-sm font-semibold text-[var(--foreground)]">Automate by Self</h4>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  If you are not satisfied with the autonomous result, continue in AI Assisted or Manual Live mode and automate the flow yourself.
                </p>
                <Link
                  href={`/projects/${projectId}/testcases/${task.testcaseId}/automate`}
                  className="mt-3 inline-flex rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  Open Automate by Self
                </Link>
              </div>
            </div>
          </>
        )}

        {task.status === "approved" && (
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium text-green-700 dark:text-green-400">
              This script has been approved and saved to the test case.
            </span>
          </div>
        )}

        {task.status === "rejected" && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm font-medium text-red-700 dark:text-red-400">
                This script has been rejected. The generated changes were discarded.
              </span>
            </div>
            {task.feedback.length > 0 && (
              <p className="text-xs text-[var(--muted)] mb-3 ml-8">
                Reason: {task.feedback[task.feedback.length - 1].message}
              </p>
            )}
            <button
              onClick={handleRequeue}
              className="rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
            >
              Re-run Aegis
            </button>
          </div>
        )}

        {task.status === "needs_revision" && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <svg className="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span className="text-sm font-medium text-amber-700 dark:text-amber-400">
                Revision requested. Aegis will re-run this task automatically.
              </span>
            </div>
            <button
              onClick={handleRequeue}
              className="rounded-lg bg-[var(--primary)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
            >
              Re-run Now
            </button>
          </div>
        )}

        {(task.status === "queued" || task.status === "in_progress") && (
          <div className="flex items-center gap-3">
            <span className="h-5 w-5 flex items-center justify-center">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
            </span>
            <span className="text-sm font-medium text-[var(--foreground)]">
              {task.status === "queued" ? "This task is queued for the agent to process." : "Aegis is working on this task in the background."}
            </span>
          </div>
        )}

        <div className="mt-6 rounded-lg border border-red-200 bg-red-50/70 p-4 dark:border-red-800 dark:bg-red-900/10">
          <h4 className="text-sm font-semibold text-red-700 dark:text-red-400">Danger Zone</h4>
          <p className="mt-1 text-xs text-red-700/80 dark:text-red-300/80">
            Delete this review task permanently. This action cannot be undone.
          </p>
          <button
            onClick={handleDeleteTask}
            className="mt-3 rounded-lg border border-red-300 bg-white px-4 py-2 text-xs font-medium text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors"
          >
            Delete Task
          </button>
        </div>
      </div>
    </div>
  );
}
