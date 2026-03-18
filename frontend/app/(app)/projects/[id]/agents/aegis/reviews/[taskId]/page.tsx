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
import { getRunByTaskId, onRunsChanged, type AegisRunLogEntry, type AegisBackgroundRun } from "@/lib/aegis-runner";
import { runAegisInBackground } from "@/lib/aegis-runner";
import { AegisBackgroundIndicator } from "@/components/aegis-background-indicator";
import { Button, Card, StatusChip, Modal, Textarea } from "@/components/ui";
import { PageHeader } from "@/components/workflows";

function ShieldIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 2L3 7v6c0 5.25 3.75 10 9 11 5.25-1 9-5.75 9-11V7l-9-5z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4" />
    </svg>
  );
}

function StatusBadge({ status }: { status: AgentTaskStatus }) {
  const config: Record<AgentTaskStatus, { label: string; tone: "warning" | "success" | "error" | "info" | "ai" | "neutral" }> = {
    pending_review: { label: "Pending Review", tone: "warning" },
    approved: { label: "Approved", tone: "success" },
    rejected: { label: "Rejected", tone: "error" },
    needs_revision: { label: "Needs Revision", tone: "warning" },
    in_progress: { label: "In Progress", tone: "info" },
    bot_reviewing: { label: "Bot Reviewing", tone: "ai" },
    queued: { label: "Re-queued", tone: "neutral" },
  };
  const c = config[status];
  return <StatusChip tone={c.tone}>{c.label}</StatusChip>;
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
  const validTypes = new Set<string>(["thinking", "action", "info", "success", "error", "bot_review", "navigation", "milestone"]);
  return task.logs.map((entry) => {
    const parsedTs = Date.parse(entry.ts);
    const type = entry.type as string;
    const safeType: AegisRunLogEntry["type"] = validTypes.has(type) ? (type as AegisRunLogEntry["type"]) : "info";
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
  const [observeCurrentUrl, setObserveCurrentUrl] = useState<string | null>(null);
  const [observeCurrentAction, setObserveCurrentAction] = useState<string | null>(null);
  const [observeStepsCompleted, setObserveStepsCompleted] = useState<number>(0);
  const [observeStepsTotal, setObserveStepsTotal] = useState<number>(0);
  const [observeStartTime, setObserveStartTime] = useState<number | null>(null);
  const [observeElapsed, setObserveElapsed] = useState<number>(0);
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const observeLogRef = useRef<HTMLDivElement | null>(null);
  const observeSeenEventIdsRef = useRef<Set<string>>(new Set());
  const observeHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isObserving = task?.status === "in_progress" || task?.status === "queued" || task?.status === "bot_reviewing";

  const formatElapsed = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatRelativeTime = (entryTs: number, firstTs: number) => {
    const diff = entryTs - firstTs;
    if (diff < 1000) return "+0s";
    const totalSeconds = Math.floor(diff / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `+${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
    return `+${seconds}s`;
  };

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
        setObserveCurrentUrl(run.currentUrl || null);
        setObserveCurrentAction(run.currentAction || null);
        if (typeof run.stepsCompleted === "number") setObserveStepsCompleted(run.stepsCompleted);
        if (typeof run.stepsTotal === "number") setObserveStepsTotal(run.stepsTotal);
        if (run.phaseStartedAt && !observeStartTime) setObserveStartTime(run.phaseStartedAt);
      } else if (found && (found.status === "queued" || found.status === "in_progress" || found.status === "bot_reviewing")) {
        setObserveLogs(normalizeTaskLogsForObserve(found));
        setObserveSessionId(found.sessionId || null);
        setObservePhase(phaseFromTaskStatus(found.status));
      }
      if (found) setTask(found);
    };
    syncFromRun();
    return onRunsChanged(syncFromRun);
  }, [projectId, taskId, observeStartTime]);

  // Elapsed time ticker
  useEffect(() => {
    if (!isObserving || !observeStartTime) return;
    const tick = () => setObserveElapsed(Date.now() - observeStartTime);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isObserving, observeStartTime]);

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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex-1 p-6 md:p-10 max-w-4xl mx-auto w-full">
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <p className="text-sm text-[var(--muted)] mb-2">Review task not found.</p>
          <Link href={`/projects/${projectId}/agents/aegis/reviews`} className="text-sm font-medium text-[var(--brand-primary)] hover:underline">
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

    const firstLogTs = observeLogs.length > 0 ? observeLogs[0].ts : null;

    const logTypeConfig: Record<string, { bg: string; icon: React.ReactNode; label: string; textColor: string }> = {
      thinking: {
        bg: "bg-gradient-to-r from-blue-50 to-violet-50 border border-blue-200/60",
        icon: <svg className="h-3.5 w-3.5 text-blue-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
        label: "REASONING",
        textColor: "text-blue-800",
      },
      action: {
        bg: "bg-emerald-50 border border-emerald-100",
        icon: <svg className="h-3.5 w-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
        label: "ACTION",
        textColor: "text-emerald-700",
      },
      navigation: {
        bg: "bg-indigo-50 border border-indigo-100",
        icon: <svg className="h-3.5 w-3.5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>,
        label: "NAVIGATION",
        textColor: "text-indigo-700",
      },
      milestone: {
        bg: "bg-amber-50 border border-amber-200",
        icon: <svg className="h-3.5 w-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>,
        label: "MILESTONE",
        textColor: "text-amber-700",
      },
      bot_review: {
        bg: "bg-purple-50 border border-purple-100",
        icon: <svg className="h-3.5 w-3.5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
        label: "REVIEW",
        textColor: "text-purple-700",
      },
      success: {
        bg: "bg-green-50 border border-green-100",
        icon: <svg className="h-3.5 w-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>,
        label: "SUCCESS",
        textColor: "text-green-700",
      },
      error: {
        bg: "bg-red-50 border border-red-100",
        icon: <svg className="h-3.5 w-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>,
        label: "ERROR",
        textColor: "text-red-700",
      },
      info: {
        bg: "bg-[var(--background)] border border-[var(--border-subtle)]",
        icon: <svg className="h-3.5 w-3.5 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
        label: "INFO",
        textColor: "text-[var(--foreground)]",
      },
    };

    return (
      <div className="flex flex-col h-screen">
        {/* Top Bar */}
        <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand-primary)]">
              <ShieldIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-[var(--foreground)]">Aegis — Observing</h1>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700 uppercase tracking-wider">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                  </span>
                  {phaseLabel}
                </span>
                {observeElapsed > 0 && (
                  <span className="text-[10px] text-[var(--muted)] font-mono tabular-nums">
                    {formatElapsed(observeElapsed)}
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--muted)] truncate max-w-md">{task.testcaseTitle}</p>
            </div>
          </div>
          <Link
            href={`/projects/${projectId}/agents/aegis`}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
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
                    ? "bg-[var(--brand-primary)] text-white"
                    : isPast
                      ? "bg-[var(--success)] text-white"
                      : "bg-[var(--surface-tertiary)] text-[var(--muted)]"
                }`}>
                  {isPast && !isCurrent ? (
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  ) : isCurrent ? (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    i + 1
                  )}
                </div>
                <span className={`text-xs font-medium capitalize ${isCurrent ? "text-blue-600" : isPast ? "text-green-600" : "text-[var(--muted)]"}`}>
                  {phase === "bot_reviewing" ? "Bot Review" : phase}
                </span>
                {i < 3 && <div className={`flex-1 h-px ${isPast ? "bg-green-400" : "bg-[var(--border)]"}`} />}
              </div>
            );
          })}
        </div>

        {/* Current Status Banner */}
        {(observeCurrentAction || observeCurrentUrl) && (
          <div className="flex items-center gap-3 border-b border-[var(--border)] bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-2 shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className="flex h-5 w-5 items-center justify-center shrink-0">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              </div>
              {observeCurrentAction && (
                <span className="text-xs font-medium text-blue-700 truncate">
                  {observeCurrentAction}
                </span>
              )}
            </div>
            {observeCurrentUrl && (
              <div className="flex items-center gap-1.5 shrink-0 max-w-[40%]">
                <svg className="h-3 w-3 text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <span className="text-[10px] text-indigo-600 truncate font-mono">
                  {observeCurrentUrl}
                </span>
              </div>
            )}
            {observeStepsTotal > 0 && (
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="h-1.5 w-16 rounded-full bg-blue-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${Math.round((observeStepsCompleted / observeStepsTotal) * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] font-medium text-blue-600 tabular-nums">
                  {observeStepsCompleted}/{observeStepsTotal}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Split pane: Bot Chat + Live Preview */}
        <div ref={splitPaneRef} className="flex flex-1 min-h-0 overflow-hidden" style={{ userSelect: resizingPanes ? "none" : undefined }}>
          {/* Left Panel — Bot Thinking & Actions */}
          <div className="flex flex-col border-r border-[var(--border)] overflow-hidden" style={{ width: `${chatPaneRatio}%` }}>
            <div className="px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Bot Activity</span>
                  <span className="text-xs text-[var(--muted)]">({observeLogs.length} events)</span>
                </div>
                {observeElapsed > 0 && (
                  <span className="text-[10px] font-mono text-[var(--muted)] tabular-nums">
                    Elapsed: {formatElapsed(observeElapsed)}
                  </span>
                )}
              </div>
            </div>
            <div ref={observeLogRef} className="flex-1 overflow-y-auto p-3 space-y-1">
              {observeLogs.map((entry, i) => {
                const config = logTypeConfig[entry.type] || logTypeConfig.info;
                const relTime = firstLogTs ? formatRelativeTime(entry.ts, firstLogTs) : null;
                const isMilestone = entry.type === "milestone";
                const isThinking = entry.type === "thinking";
                const isLongReasoning = isThinking && entry.message.length > 180;
                return (
                  <div key={i} className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${isMilestone ? "ring-1 ring-amber-300 " : ""}${isThinking ? "border-l-[3px] border-l-blue-400 " : ""}${config.bg}`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {config.icon}
                      {relTime && (
                        <span className="text-[10px] font-mono text-[var(--muted)] tabular-nums">{relTime}</span>
                      )}
                      <span className={`text-[10px] font-semibold uppercase ${
                        entry.type === "thinking" ? "text-blue-500" :
                        entry.type === "action" ? "text-emerald-500" :
                        entry.type === "navigation" ? "text-indigo-500" :
                        entry.type === "milestone" ? "text-amber-500" :
                        entry.type === "bot_review" ? "text-purple-500" :
                        entry.type === "success" ? "text-green-500" :
                        entry.type === "error" ? "text-red-500" :
                        "text-[var(--muted-soft)]"
                      }`}>{config.label}</span>
                      {isThinking && (
                        <span className="inline-flex items-center gap-0.5 ml-1">
                          <span className="h-1 w-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                          <span className="h-1 w-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                          <span className="h-1 w-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </span>
                      )}
                      {entry.stepProgress && (
                        <span className="text-[10px] text-[var(--muted)] ml-auto tabular-nums">
                          Step {entry.stepProgress.current}/{entry.stepProgress.total}
                        </span>
                      )}
                      {entry.durationMs != null && entry.durationMs > 0 && (
                        <span className="text-[10px] text-[var(--muted)] ml-auto font-mono tabular-nums">
                          {formatDuration(entry.durationMs)}
                        </span>
                      )}
                    </div>
                    {isThinking ? (
                      <p className={`${config.textColor} italic whitespace-pre-wrap`}>
                        {isLongReasoning ? entry.message.slice(0, 180) + "…" : entry.message}
                      </p>
                    ) : (
                      <p className={config.textColor}>{entry.message}</p>
                    )}
                    {isLongReasoning && (
                      <details className="mt-1">
                        <summary className="text-[10px] text-blue-500 cursor-pointer hover:text-blue-600 select-none">
                          Show full reasoning
                        </summary>
                        <p className={`${config.textColor} italic mt-1 whitespace-pre-wrap text-[11px] leading-relaxed`}>
                          {entry.message}
                        </p>
                      </details>
                    )}
                    {entry.detail && (
                      <p className="mt-1 text-[10px] text-[var(--muted)] break-words">
                        {entry.detail}
                      </p>
                    )}
                    {entry.url && entry.type === "navigation" && (
                      <div className="mt-1 flex items-center gap-1">
                        <svg className="h-2.5 w-2.5 text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                        </svg>
                        <span className="text-[10px] font-mono text-indigo-500 truncate">{entry.url}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {observeLogs.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent mb-3" />
                  <p className="text-xs text-[var(--muted)]">Waiting for bot activity...</p>
                  <p className="text-[10px] text-[var(--muted)] mt-1">The bot is initializing. Activity will appear here in real time.</p>
                </div>
              )}
            </div>

            {task.script && (
              <div className="border-t border-[var(--border)] p-3 shrink-0">
                <button
                  onClick={() => setShowObserveScript((prev) => !prev)}
                  className="w-full flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-left"
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
                  <pre className="mt-2 max-h-56 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-[10px] leading-relaxed overflow-x-auto">
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
                    ? "bg-green-50 border border-green-200"
                    : "bg-red-50 border border-red-200"
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
                    <span className={`text-xs font-bold ${task.botReview.status === "passed" ? "text-green-700" : "text-red-700"}`}>
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
                        <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--surface)]/60 p-2 space-y-1">
                          {task.botReview.categories.map((category, idx) => (
                            <div key={idx} className="flex items-start gap-1.5 text-[10px]">
                              {category.passed ? (
                                <svg className="h-3 w-3 text-green-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                              ) : (
                                <svg className="h-3 w-3 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                              )}
                              <div className="min-w-0">
                                <span className={`font-semibold ${category.passed ? "text-green-700" : "text-red-700"}`}>
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
                            <p key={i} className="text-red-700">- {fb}</p>
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
                        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 p-2 space-y-1">
                          <p className="text-[10px] font-semibold text-amber-700">Assertion Suggestions</p>
                          {task.botReview.assertionSuggestions.slice(0, 2).map((s, idx) => (
                            <div key={idx} className="text-[10px] text-amber-800">
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
            className="w-1.5 cursor-col-resize bg-[var(--border)] hover:bg-[var(--brand-primary)]/40 transition-colors shrink-0"
          />

          {/* Right Panel — Live Browser Preview */}
          <div className="flex-1 flex flex-col bg-[var(--background)] min-w-0">
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
                  <svg className="h-10 w-10 text-[var(--muted)] mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm text-[var(--muted)]">Browser preview unavailable</p>
                  <p className="text-xs text-[var(--muted)] mt-1">Bot is still working. Watch the activity log on the left.</p>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent mx-auto mb-3" />
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
      <PageHeader
        title={task.testcaseTitle}
        breadcrumb={
          <Link
            href={`/projects/${projectId}/agents/aegis`}
            className="inline-flex items-center gap-1 hover:text-[var(--brand-primary)]"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Aegis
          </Link>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2 mt-1">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand-primary)]">
              <ShieldIcon className="h-5 w-5" />
            </span>
            <span className="font-mono text-xs text-[var(--muted)]">{task.testcaseExternalId}</span>
            <StatusBadge status={task.status} />
            {task.botReview && (
              <StatusChip tone={task.botReview.status === "passed" ? "success" : "error"}>
                Bot Review: {task.botReview.status}
              </StatusChip>
            )}
            <span className="text-xs text-[var(--muted)]">
              Created {new Date(task.createdAt).toLocaleString()}
              {task.duration ? ` · Duration: ${(task.duration / 1000).toFixed(1)}s` : ""}
              {task.feedback.length > 0 ? ` · ${task.feedback.length} revision${task.feedback.length > 1 ? "s" : ""}` : ""}
            </span>
          </span>
        }
        actions={
          <>
            {task.status === "pending_review" && previewStatus === "idle" && (
              <Button onClick={handleRunPreview} variant="primary" size="sm">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Run & Preview
              </Button>
            )}
            {previewStatus === "running" && (
              <Button onClick={handleStopPreview} variant="destructive" size="sm">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
                Stop Preview
              </Button>
            )}
          </>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            disabled={!tab.available}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === tab.id
                ? "border-[var(--brand-primary)] text-[var(--brand-primary)]"
                : tab.available
                  ? "border-transparent text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--border)]"
                  : "border-transparent text-[var(--muted-soft)] cursor-not-allowed"
            }`}
          >
            {tab.label}
            {tab.badge && (
              <StatusChip tone="error" live>{tab.badge}</StatusChip>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <Card className="overflow-hidden">
        {activeTab === "script" && (
          <div>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Playwright Script</span>
              <div className="flex items-center gap-2">
                {task.status === "pending_review" && previewStatus === "idle" && (
                  <Button onClick={handleRunPreview} variant="secondary" size="sm" className="border-[var(--brand-primary)] text-[var(--brand-primary)]">
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Run & Preview
                  </Button>
                )}
                {task.status === "pending_review" && task.script && !isEditingScript && (
                  <Button onClick={handleStartEditScript} variant="secondary" size="sm">
                    Edit Script
                  </Button>
                )}
                {task.status === "pending_review" && task.script && isEditingScript && (
                  <>
                    <Button onClick={handleCancelEditScript} variant="secondary" size="sm">
                      Cancel
                    </Button>
                    <Button onClick={handleSaveScript} variant="primary" size="sm">
                      Save Script
                    </Button>
                  </>
                )}
                <Button onClick={handleCopyScript} variant="secondary" size="sm" className="text-[var(--brand-primary)]">
                  {copied ? "Copied!" : "Copy Script"}
                </Button>
              </div>
            </div>
            {task.script ? (
              isEditingScript ? (
                <textarea
                  value={editableScript}
                  onChange={(e) => setEditableScript(e.target.value)}
                  spellCheck={false}
                  className="w-full min-h-[500px] p-4 text-sm text-[var(--foreground)] leading-relaxed font-mono bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-soft)] resize-y"
                />
              ) : (
                <pre className="p-4 text-sm text-[var(--foreground)] overflow-x-auto leading-relaxed font-mono bg-[var(--background)] max-h-[500px] overflow-y-auto">
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
                  <StatusChip tone="error" live>LIVE</StatusChip>
                )}
                {previewStatus === "completed" && (
                  <StatusChip tone="success">DONE</StatusChip>
                )}
              </div>
              <div className="flex items-center gap-2">
                {previewStatus === "idle" && task.status === "pending_review" && (
                  <Button onClick={handleRunPreview} variant="primary" size="sm">
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Start Run
                  </Button>
                )}
                {previewStatus === "running" && (
                  <Button onClick={handleStopPreview} variant="destructive" size="sm">
                    Stop
                  </Button>
                )}
                {(previewStatus === "completed" || previewStatus === "failed") && task.status === "pending_review" && (
                  <Button
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
                    variant="secondary"
                    size="sm"
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>

            {/* Browser viewport */}
            <div className="bg-[var(--background)] min-h-[400px] flex flex-col">
              {previewStatus === "idle" && (
                <div className="flex-1 flex items-center justify-center p-12 min-h-[400px]">
                  <div className="text-center max-w-md">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[var(--brand-primary)] mx-auto mb-4">
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
                      <Button onClick={handleRunPreview} variant="primary">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        </svg>
                        Run & Preview
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {previewStatus === "starting" && (
                <div className="flex-1 flex items-center justify-center p-12 min-h-[400px]">
                  <div className="text-center">
                    <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent mx-auto mb-3" />
                    <p className="text-sm text-[var(--muted)]">Starting browser session...</p>
                  </div>
                </div>
              )}

              {(previewStatus === "running" || previewStatus === "completed") && (
                <div className="flex flex-col">
                  {/* Live browser image */}
                  <div className="relative flex items-center justify-center p-3 min-h-[350px] bg-[var(--surface-tertiary)]">
                    {liveStreamUrl && !previewStreamFailed ? (
                      <img
                        src={liveStreamUrl}
                        alt="Live browser preview"
                        className="max-w-full max-h-[450px] object-contain rounded-lg shadow-lg border border-[var(--border)]"
                        onError={() => setPreviewStreamFailed(true)}
                      />
                    ) : previewStreamFailed ? (
                      <div className="text-center">
                        <svg className="h-10 w-10 text-[var(--muted)] mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        <p className="text-sm text-[var(--muted)]">Browser preview unavailable</p>
                        <p className="text-xs text-[var(--muted)] mt-1">The execution is still running. Check the logs below.</p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--muted-soft)] border-t-transparent mx-auto mb-2" />
                        <p className="text-sm text-[var(--muted)]">Connecting to browser...</p>
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
                            entry.type === "success" ? "text-green-600" :
                            entry.type === "error" ? "text-red-600" :
                            entry.type === "action" ? "text-[var(--brand-primary)]" :
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
                    <p className="text-sm font-medium text-[var(--error)] mb-1">Preview run failed</p>
                    {previewLogs.length > 0 && (
                      <p className="text-xs text-[var(--muted)]">
                        {previewLogs[previewLogs.length - 1].message}
                      </p>
                    )}
                    {task.status === "pending_review" && (
                      <Button
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
                        variant="secondary"
                        className="mt-4"
                      >
                        Try Again
                      </Button>
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
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Execution Timeline</span>
                <span className="text-xs text-[var(--muted)]">{task.logs.length} events</span>
              </div>
            </div>
            {task.logs.length > 0 ? (
              <div className="p-3 space-y-1">
                {task.logs.map((entry, i) => {
                  const entryTs = Date.parse(entry.ts);
                  const firstTs = Date.parse(task.logs[0].ts);
                  const relTime = !Number.isNaN(entryTs) && !Number.isNaN(firstTs) ? formatRelativeTime(entryTs, firstTs) : null;
                  const typeColor =
                    entry.type === "success" ? "text-green-600" :
                    entry.type === "error" ? "text-red-600" :
                    entry.type === "action" ? "text-emerald-600" :
                    entry.type === "thinking" ? "text-blue-600" :
                    entry.type === "navigation" ? "text-indigo-600" :
                    entry.type === "milestone" ? "text-amber-600" :
                    entry.type === "bot_review" ? "text-purple-600" :
                    "text-[var(--foreground)]";
                  const typeBadge =
                    entry.type === "success" ? "bg-green-100 text-green-700" :
                    entry.type === "error" ? "bg-red-100 text-red-700" :
                    entry.type === "action" ? "bg-emerald-100 text-emerald-700" :
                    entry.type === "thinking" ? "bg-blue-100 text-blue-700" :
                    entry.type === "navigation" ? "bg-indigo-100 text-indigo-700" :
                    entry.type === "milestone" ? "bg-amber-100 text-amber-700" :
                    entry.type === "bot_review" ? "bg-purple-100 text-purple-700" :
                    "bg-[var(--surface-tertiary)] text-[var(--muted)]";
                  const isThinkingEntry = entry.type === "thinking";
                  const isLong = isThinkingEntry && entry.message.length > 200;
                  return (
                    <div key={i} className={`flex items-start gap-2 text-xs leading-relaxed py-1 ${isThinkingEntry ? "border-l-2 border-l-blue-300 pl-2 bg-blue-50/40 rounded-r-md -ml-1" : ""}`}>
                      {relTime && (
                        <span className="text-[10px] font-mono text-[var(--muted)] w-10 text-right shrink-0 tabular-nums pt-0.5">{relTime}</span>
                      )}
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase shrink-0 ${typeBadge}`}>
                        {entry.type === "bot_review" ? "review" : entry.type === "thinking" ? "reasoning" : entry.type}
                      </span>
                      {isThinkingEntry ? (
                        <span className={`${typeColor} italic`}>
                          {isLong ? (
                            <details>
                              <summary className="cursor-pointer select-none not-italic">{entry.message.slice(0, 150)}…</summary>
                              <span className="block mt-1 whitespace-pre-wrap">{entry.message}</span>
                            </details>
                          ) : entry.message}
                        </span>
                      ) : (
                        <span className={typeColor}>{entry.message}</span>
                      )}
                    </div>
                  );
                })}
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
                    ? "bg-green-50 border border-green-200"
                    : "bg-red-50 border border-red-200"
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {task.botReview.status === "passed" ? (
                      <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    ) : (
                      <svg className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    )}
                    <span className={`text-sm font-bold ${task.botReview.status === "passed" ? "text-green-700" : "text-red-700"}`}>
                      Bot Review: {task.botReview.status === "passed" ? "PASSED" : "NEEDS IMPROVEMENT"}
                    </span>
                    <span className="text-xs text-[var(--muted)] ml-auto">{new Date(task.botReview.reviewedAt).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2 mb-3 text-xs text-[var(--muted)]">
                    <span>Script execution: {task.botReview.scriptRanSuccessfully ? "Passed" : "Failed"}</span>
                    <span className="text-[var(--border)]">|</span>
                    <span>Steps validated: {task.botReview.validatedSteps.filter(s => s.passed).length}/{task.botReview.validatedSteps.length}</span>
                    {typeof task.botReview.reviewCycle === "number" && typeof task.botReview.maxReviewCycles === "number" && (
                      <>
                        <span className="text-[var(--border)]">|</span>
                        <span>Cycle: {task.botReview.reviewCycle}/{task.botReview.maxReviewCycles}</span>
                      </>
                    )}
                  </div>
                  {task.botReview.categories && task.botReview.categories.length > 0 && (
                    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 p-3 space-y-2">
                      <span className="text-xs font-semibold text-[var(--muted)]">Review Categories</span>
                      {task.botReview.categories.map((category, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs">
                          {category.passed ? (
                            <svg className="h-4 w-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          ) : (
                            <svg className="h-4 w-4 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          )}
                          <div className="min-w-0">
                            <span className={`font-semibold ${category.passed ? "text-green-700" : "text-red-700"}`}>
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
                    <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1">
                      <span className="text-xs font-semibold text-[var(--muted)]">Bot Feedback:</span>
                      {task.botReview.feedback.map((fb, i) => (
                        <p key={i} className="text-xs text-[var(--foreground)]">{fb}</p>
                      ))}
                    </div>
                  )}
                  {task.botReview.assertionSuggestions && task.botReview.assertionSuggestions.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-amber-200 space-y-1">
                      <span className="text-xs font-semibold text-amber-700">Assertion Suggestions:</span>
                      {task.botReview.assertionSuggestions.map((suggestion, idx) => (
                        <div key={idx} className="text-xs text-[var(--foreground)] rounded border border-amber-200 bg-amber-50/60 p-2">
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
                      <div className="h-6 w-6 rounded-full bg-[var(--surface-tertiary)] flex items-center justify-center">
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
      </Card>

      {/* Action Bar */}
      <Card className="mt-6 p-5">
        {actionDone && (
          <div className={`mb-4 rounded-lg p-3 text-sm font-medium ${
            actionDone === "approved"
              ? "bg-green-50 text-green-700"
              : actionDone === "rejected"
                ? "bg-red-50 text-red-700"
                : actionDone === "feedback_sent"
                  ? "bg-amber-50 text-amber-700"
                  : "bg-blue-50 text-blue-700"
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
                <Button
                  onClick={handleApprove}
                  className="bg-green-600 hover:bg-green-700"
                >
                  Approve Script
                </Button>
                <Button
                  onClick={() => setShowRejectConfirm(true)}
                  variant="secondary"
                  className="border-red-300 text-red-600 hover:bg-red-50"
                >
                  Reject Script
                </Button>
                {previewStatus === "idle" && (
                  <Button
                    onClick={handleRunPreview}
                    variant="secondary"
                    className="border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-[var(--brand-soft)]"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Run & Validate
                  </Button>
                )}
                {previewStatus === "running" && (
                  <span className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                    Preview running...
                  </span>
                )}
              </div>

              {showRejectConfirm && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-100 shrink-0 mt-0.5">
                      <svg className="h-4 w-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h4 className="text-sm font-semibold text-red-700 mb-1">Reject this script?</h4>
                      <p className="text-xs text-red-600/80 mb-3">
                        The generated script will be discarded and the task will be marked as rejected. This will not trigger a re-run.
                      </p>
                      <Textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason for rejection (optional)..."
                        rows={2}
                        className="border-red-200 bg-[var(--surface)] focus:ring-red-400/40 resize-none mb-3"
                      />
                      <div className="flex gap-2">
                        <Button onClick={handleRejectChanges} variant="destructive" size="sm">
                          Confirm Reject
                        </Button>
                        <Button
                          onClick={() => { setShowRejectConfirm(false); setRejectReason(""); }}
                          variant="secondary"
                          size="sm"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="text-sm font-medium text-[var(--foreground)] mb-1.5 block">
                  Provide feedback to improve
                </label>
                <Textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="Describe what needs to change (e.g., 'Add assertion for the success message', 'Navigate to settings page instead of dashboard')..."
                  rows={3}
                  className="resize-none"
                />
                <Button
                  onClick={handleReject}
                  disabled={!feedbackText.trim()}
                  className="mt-2 bg-amber-600 hover:bg-amber-700"
                >
                  Send Feedback & Re-run Aegis
                </Button>
              </div>

              <Card className="bg-[var(--background)] p-4">
                <h4 className="text-sm font-semibold text-[var(--foreground)]">Automate by Self</h4>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  If you are not satisfied with the autonomous result, continue in AI Assisted or Manual Live mode and automate the flow yourself.
                </p>
                <Link
                  href={`/projects/${projectId}/testcases/${task.testcaseId}/automate`}
                  className="mt-3 inline-flex rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)] transition-colors"
                >
                  Open Automate by Self
                </Link>
              </Card>
            </div>
          </>
        )}

        {task.status === "approved" && (
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium text-green-700">
              This script has been approved and saved to the test case.
            </span>
          </div>
        )}

        {task.status === "rejected" && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <svg className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm font-medium text-red-700">
                This script has been rejected. The generated changes were discarded.
              </span>
            </div>
            {task.feedback.length > 0 && (
              <p className="text-xs text-[var(--muted)] mb-3 ml-8">
                Reason: {task.feedback[task.feedback.length - 1].message}
              </p>
            )}
            <Button onClick={handleRequeue} variant="primary">
              Re-run Aegis
            </Button>
          </div>
        )}

        {task.status === "needs_revision" && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <svg className="h-5 w-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span className="text-sm font-medium text-amber-700">
                Revision requested. Aegis will re-run this task automatically.
              </span>
            </div>
            <Button onClick={handleRequeue} variant="primary">
              Re-run Now
            </Button>
          </div>
        )}

        {(task.status === "queued" || task.status === "in_progress") && (
          <div className="flex items-center gap-3">
            <span className="h-5 w-5 flex items-center justify-center">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
            </span>
            <span className="text-sm font-medium text-[var(--foreground)]">
              {task.status === "queued" ? "This task is queued for the agent to process." : "Aegis is working on this task in the background."}
            </span>
          </div>
        )}

        <div className="mt-6 rounded-lg border border-red-200 bg-red-50/70 p-4">
          <h4 className="text-sm font-semibold text-red-700">Danger Zone</h4>
          <p className="mt-1 text-xs text-red-700/80">
            Delete this review task permanently. This action cannot be undone.
          </p>
          <Button
            onClick={handleDeleteTask}
            variant="secondary"
            size="sm"
            className="mt-3 border-red-300 text-red-600 hover:bg-red-100"
          >
            Delete Task
          </Button>
        </div>
      </Card>
    </div>
  );
}
