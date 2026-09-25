"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeZyraTask,
  createSuite,
  deleteZyraTaskDraft,
  getJiraStatus,
  getZyraTask,
  listJiraTickets,
  listSuites,
  listZyraTaskTicketComments,
  retryZyraTicketComment,
  saveZyraTask,
  sendZyraFeedback,
  type JiraTicket,
  type SuiteNode,
  type ZyraTask,
  type ZyraTicketComment,
} from "@/lib/api";
import { IconSparkles, IconUser } from "@tabler/icons-react";
import { Button, Card, CopyButton, Field, FieldLabel, Input, Modal, PageLoader, Select, StatusChip, Textarea, SeverityBadge, type Severity } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import { toTsv } from "@/lib/tsv";
import { renderMarkdown } from "@/lib/markdown";
import { ACTION_LABEL, TechniqueBadges } from "@/components/agents/ZyraChatReviewPanel";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

type SaveMode = "existing" | "new";
type DetailTab = "testcases" | "feedback" | "activities" | "sources";

const TICKET_COMMENT_STATUS: Record<ZyraTicketComment["status"], { label: string; tone: "neutral" | "info" | "success" | "warning" | "error" }> = {
  pending: { label: "Posting…", tone: "info" },
  posted: { label: "Posted", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  skipped_disabled: { label: "Not posted — auto-comment off", tone: "neutral" },
  skipped_not_connected: { label: "Not posted — not connected", tone: "warning" },
};

function normalizeStatus(status: string): string {
  if (status === "accepted") return "done";
  if (status === "rejected") return "todo";
  return status || "todo";
}

function tone(status: string): "neutral" | "info" | "success" | "warning" | "error" {
  const normalized = normalizeStatus(status);
  if (normalized === "done") return "success";
  if (normalized === "in_review") return "info";
  if (normalized === "in_progress") return "warning";
  if (normalized === "failed") return "error";
  return "neutral";
}

function latestFailureDetail(activities: ZyraTask["activities"]): string | null {
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    if (activities[i].stage === "failed") return activities[i].detail || "Zyra failed to generate testcase drafts.";
  }
  return null;
}

// Mirrors TaskQuickViewPanel's isFeedbackActivity: only the entry carrying a reviewer's actual
// words counts as "Feedback", not the status/process narration that shares the same activity log.
// Rows written before `kind` existed fall back to matching the fixed title zyraFeedback writes.
function isFeedbackActivity(activity: ZyraTask["activities"][number]): boolean {
  return activity.kind === "feedback" || activity.title === "Review feedback submitted";
}

const TASK_STATUS_LABELS: Record<string, string> = {
  todo: "Pending",
  in_progress: "In Progress",
  in_review: "In Review",
  failed: "Failed",
  done: "Done",
};

function statusLabel(status: string): string {
  const normalized = normalizeStatus(status);
  return TASK_STATUS_LABELS[normalized] ?? normalized.replaceAll("_", " ");
}

const KNOWN_SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low"];
// See ZyraChatReviewPanel/TaskQuickViewPanel's identical guard — a draft's severity is only
// guaranteed to match this set once actually saved (normalizeZyraSeverity).
function knownSeverity(value?: string | null): Severity | null {
  return KNOWN_SEVERITIES.includes(value as Severity) ? (value as Severity) : null;
}

function stepCount(stepsJson: string): number {
  try {
    const parsed = JSON.parse(stepsJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function stepsText(stepsJson: string): string {
  try {
    const parsed = JSON.parse(stepsJson);
    if (!Array.isArray(parsed)) return "";
    return parsed
      .map((step, index) => {
        if (typeof step === "string") return `${index + 1}. ${step}`;
        if (step && typeof step === "object") {
          const action = step.action || step.step || step.description || "";
          const expected = step.expectedResult || step.expected || "";
          if (!action && !expected) return "";
          return expected ? `${index + 1}. ${action} -> ${expected}` : `${index + 1}. ${action}`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" | ");
  } catch {
    return "";
  }
}

export default function ZyraTaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const taskId = params.taskId as string;
  const { currentUser } = useAppData();
  const { project } = useProjectData();
  const projectName = String(project.name || "");
  const [task, setTask] = useState<ZyraTask | null>(null);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [jiraTickets, setJiraTickets] = useState<JiraTicket[]>([]);
  const [ticketComments, setTicketComments] = useState<ZyraTicketComment[]>([]);
  const [retryingCommentId, setRetryingCommentId] = useState<string | null>(null);
  const [selectedDrafts, setSelectedDrafts] = useState<number[]>([]);
  const [feedback, setFeedback] = useState("");
  const [referenceNote, setReferenceNote] = useState("");
  const [selectedJiraKeys, setSelectedJiraKeys] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<DetailTab>("testcases");
  const [savingOpen, setSavingOpen] = useState(false);
  const [saveMode, setSaveMode] = useState<SaveMode>("existing");
  const [targetSuiteId, setTargetSuiteId] = useState("");
  const [newSuiteName, setNewSuiteName] = useState("");
  const [savingDraftIndexes, setSavingDraftIndexes] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollInFlightRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      const [taskData, suiteList, jiraStatus, comments] = await Promise.all([
        getZyraTask(projectId, taskId),
        listSuites(projectId).catch(() => []),
        getJiraStatus(projectId).catch(() => ({ connected: false })),
        listZyraTaskTicketComments(projectId, taskId).catch(() => [] as ZyraTicketComment[]),
      ]);
      setTask(taskData);
      setSuites(suiteList);
      setTicketComments(comments);
      setSelectedDrafts((prev) => prev.filter((index) => index < taskData.drafts.length));
      if (jiraStatus.connected) {
        const tickets = await listJiraTickets(projectId, { limit: 50 }).catch(() => ({ list: [], total: 0 }));
        setJiraTickets(tickets.list || []);
      } else {
        setJiraTickets([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load task.");
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId]);

  useEffect(() => {
    if (!currentUser) router.replace("/login");
    else void loadData();
  }, [loadData, router, projectId, currentUser]);

  // Lighter than loadData (skips suites/Jira) — just re-reads this task so Zyra finishing (or
  // failing) generation server-side shows up here without a manual reload.
  const refreshTask = useCallback(async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const taskData = await getZyraTask(projectId, taskId);
      setTask(taskData);
      setSelectedDrafts((prev) => prev.filter((index) => index < taskData.drafts.length));
    } catch {
      // A missed poll tick isn't worth surfacing; the next one usually succeeds.
    } finally {
      pollInFlightRef.current = false;
    }
  }, [projectId, taskId]);

  useEffect(() => {
    if (!task) return;
    const status = normalizeStatus(task.taskStatus);
    if (status !== "todo" && status !== "in_progress") return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshTask();
    }, 5000);
    return () => clearInterval(timer);
  }, [task, refreshTask]);

  // A ticket comment is posted in the background after a save, so it can still read "Posting…" when
  // the save returns — re-read until none is pending, then stop.
  const hasPendingTicketComment = ticketComments.some((comment) => comment.status === "pending");
  useEffect(() => {
    if (!hasPendingTicketComment) return;
    const timer = setInterval(() => {
      void Promise.all([
        listZyraTaskTicketComments(projectId, taskId).then(setTicketComments),
        getZyraTask(projectId, taskId).then(setTask),
      ]).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [hasPendingTicketComment, projectId, taskId]);

  async function handleRetryTicketComment(comment: ZyraTicketComment) {
    setRetryingCommentId(comment.id);
    setMessage(null);
    setError(null);
    try {
      const result = await retryZyraTicketComment(projectId, taskId, comment.id);
      const label = result.provider === "jira" ? "Jira" : "Linear";
      if (result.status === "posted") setMessage(`Comment posted on ${label} ${result.issueKey}.`);
      else setError(`Comment still couldn't be posted on ${label} ${result.issueKey}${result.reason ? `: ${result.reason}` : "."}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry the ticket comment.");
      await loadData();
    } finally {
      setRetryingCommentId(null);
    }
  }

  function toggleDraft(index: number) {
    setSelectedDrafts((prev) => prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]);
  }

  function selectAllDrafts() {
    if (!task || done) return;
    setSelectedDrafts(task.drafts.map((_, index) => index));
  }

  function clearDraftSelection() {
    if (done) return;
    setSelectedDrafts([]);
  }

  function openSaveModal(indexes?: number[]) {
    setSavingDraftIndexes(indexes || selectedDrafts);
    setSavingOpen(true);
  }

  async function handleFeedback() {
    if (!task || !feedback.trim()) return;
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      const result = await sendZyraFeedback(projectId, task.id, {
        feedback: feedback.trim(),
        referenceNote: referenceNote.trim() || undefined,
        jiraIssueKeys: selectedJiraKeys,
      });
      setTask(result.task);
      setFeedback("");
      setReferenceNote("");
      setSelectedJiraKeys([]);
      setMessage("Feedback sent. Zyra moved the task to Todo and is regenerating the testcase drafts now — this can take a minute.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send feedback.");
    } finally {
      setWorking(false);
    }
  }

  async function handleDeleteDraft(index: number) {
    if (!task) return;
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      const updated = await deleteZyraTaskDraft(projectId, task.id, index);
      setTask(updated);
      setSelectedDrafts((prev) => prev.filter((item) => item !== index).map((item) => item > index ? item - 1 : item));
      setMessage("Generated testcase draft deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete testcase draft.");
    } finally {
      setWorking(false);
    }
  }

  async function handleDeleteSelectedDrafts() {
    if (!task || selectedDrafts.length === 0) return;
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      let updated = task;
      const indexes = [...selectedDrafts].sort((a, b) => b - a);
      for (const index of indexes) {
        updated = await deleteZyraTaskDraft(projectId, task.id, index);
      }
      setTask(updated);
      setSelectedDrafts([]);
      setMessage(`${indexes.length} generated testcase draft${indexes.length === 1 ? "" : "s"} deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete selected testcase drafts.");
    } finally {
      setWorking(false);
    }
  }

  async function handleSave() {
    if (!task) return;
    const indexes = savingDraftIndexes || selectedDrafts;
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      let suiteId = saveMode === "existing" ? targetSuiteId : "";
      if (saveMode === "new" && newSuiteName.trim()) {
        const suite = await createSuite(projectId, { name: newSuiteName.trim() });
        suiteId = suite.id;
      }
      const result = await saveZyraTask(projectId, task.id, {
        selectedDraftIndexes: indexes,
        suiteId: suiteId || undefined,
      });
      setMessage(`${result.savedCount} testcase${result.savedCount === 1 ? "" : "s"} saved.`);
      setSavingOpen(false);
      setSavingDraftIndexes(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save testcases.");
    } finally {
      setWorking(false);
    }
  }

  async function handleCloseTask() {
    if (!task) return;
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      const updated = await closeZyraTask(projectId, task.id);
      setTask(updated);
      setSelectedDrafts([]);
      setMessage("Task closed.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close task.");
    } finally {
      setWorking(false);
    }
  }

  const taskBreadcrumb = (
    <Breadcrumbs
      items={[
        { label: "Projects", href: "/projects" },
        { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
        { label: "Agents", href: `/projects/${projectId}/agents` },
        { label: "Tasks", href: `/projects/${projectId}/agents/tasks` },
        { label: "Zyra task" },
      ]}
    />
  );

  if (loading || !task) {
    return (
      <StandardPageLayout header={<PageHeader title="Zyra task" breadcrumb={taskBreadcrumb} />}>
        <PageLoader label="Loading task…" />
      </StandardPageLayout>
    );
  }

  const done = normalizeStatus(task.taskStatus) === "done";
  const taskStatusNow = normalizeStatus(task.taskStatus);
  // Defensive: activity_log is jsonb server-side and not schema-enforced, so a malformed or
  // missing value must render an empty history rather than throw.
  const feedbackActivities = Array.isArray(task.activities) ? task.activities.filter(isFeedbackActivity) : [];
  // Mirrors the backend guard in zyraFeedback: feedback only makes sense once there's something
  // to review, or to retry after a failure. Disabling it here for todo/in_progress avoids a
  // pointless round trip that the server would reject with a 409 anyway.
  const canGiveFeedback = taskStatusNow === "in_review" || taskStatusNow === "failed";
  const allDraftsSelected = task.drafts.length > 0 && selectedDrafts.length === task.drafts.length;
  const copyableDrafts = selectedDrafts.length > 0 ? selectedDrafts.map((i) => task.drafts[i]) : task.drafts;
  const draftsTsv = toTsv(
    ["Title", "Priority", "Severity", "Component", "Preconditions", "Steps", "Expected Result", "Tags"],
    copyableDrafts.map((draft) => [
      draft.title,
      draft.priority,
      draft.severity ?? "",
      draft.component ?? "",
      draft.preconditions,
      stepsText(draft.stepsJson),
      draft.expectedSummary,
      draft.tags?.join(", ") ?? "",
    ])
  );
  const tabItems: Array<{ key: DetailTab; label: string; count?: number }> = [
    { key: "testcases", label: "Generated Testcases", count: task.drafts.length },
    { key: "feedback", label: "Feedback", count: feedbackActivities.length },
    { key: "activities", label: "Activities", count: task.activities.length },
    { key: "sources", label: "Sources", count: task.sources.length },
  ];

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Zyra task"
          subtitle="Review the task, save or remove generated testcases, provide feedback, and track every Zyra status update."
          breadcrumb={taskBreadcrumb}
          actions={<Link href={`/projects/${projectId}/agents/tasks`} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Back to board</Link>}
        />
      }
    >
      {message && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm">{message}</p>}
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>}

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <StatusChip tone={tone(task.taskStatus)}>{statusLabel(task.taskStatus)}</StatusChip>
            <h2 className="mt-3 text-lg font-semibold text-[var(--foreground)]">{task.userStory}</h2>
            {normalizeStatus(task.taskStatus) === "failed" && (
              <p className="mt-2 rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
                {latestFailureDetail(task.activities)}
              </p>
            )}
            <p className="mt-2 text-sm text-[var(--muted)]">
              {task.generatedCount} testcase{task.generatedCount === 1 ? "" : "s"} generated, {task.savedCount} saved, {task.tokenUsage.total} tokens, updated {new Date(task.updatedAt).toLocaleString()}
            </p>
            {task.jiraIssueKeys.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {task.jiraIssueKeys.map((key) => (
                  <span key={key} className="rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent-light)]">
                    {key}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!done && (
              <Button variant="secondary" onClick={() => void handleCloseTask()} disabled={working}>Close task</Button>
            )}
          </div>
        </div>
      </Card>

      {ticketComments.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Ticket comments</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
            What was posted to the linked ticket after each save. A failed comment can be sent again once the cause is fixed.
          </p>
          <ul className="mt-3 space-y-2">
            {ticketComments.map((comment) => {
              const status = TICKET_COMMENT_STATUS[comment.status] ?? { label: comment.status, tone: "neutral" as const };
              return (
                <li key={comment.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-[var(--foreground)]">{comment.provider === "jira" ? "Jira" : "Linear"} {comment.issueKey}</span>
                      <StatusChip tone={status.tone}>{status.label}</StatusChip>
                      <span className="text-xs text-[var(--muted)]">
                        {comment.testcaseCount} testcase{comment.testcaseCount === 1 ? "" : "s"} · {new Date(comment.postedAt || comment.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    {comment.status === "failed" && comment.reason && (
                      <p className="text-xs text-[var(--error-foreground)]">{comment.reason}</p>
                    )}
                  </div>
                  {comment.status === "failed" && (
                    <Button variant="secondary" onClick={() => void handleRetryTicketComment(comment)} disabled={retryingCommentId !== null}>
                      {retryingCommentId === comment.id ? "Retrying..." : "Retry comment"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap gap-2 border-b border-[var(--border)]">
        {tabItems.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${activeTab === tab.key ? "border-[var(--brand-primary)] text-[var(--accent-light)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"}`}
          >
            {tab.label}{tab.count != null ? ` (${tab.count})` : ""}
          </button>
        ))}
      </div>

      {activeTab === "testcases" && (
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-3">
              <div className="text-sm text-[var(--muted)]">
                <span className="font-semibold text-[var(--foreground)]">{selectedDrafts.length}</span> of {task.drafts.length} testcase{task.drafts.length === 1 ? "" : "s"} selected
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={allDraftsSelected ? clearDraftSelection : selectAllDrafts} disabled={done || task.drafts.length === 0}>
                  {allDraftsSelected ? "Unselect all" : "Select all"}
                </Button>
                {!allDraftsSelected && (
                  <Button variant="secondary" onClick={clearDraftSelection} disabled={done || selectedDrafts.length === 0}>Clear selection</Button>
                )}
                {task.drafts.length > 0 && (
                  <span title={selectedDrafts.length > 0 ? "Copy the selected testcases as tab-separated values, ready to paste into Excel." : "Copy every generated testcase as tab-separated values, ready to paste into Excel."}>
                    <CopyButton
                      value={draftsTsv}
                      label={selectedDrafts.length > 0 ? `Copy ${selectedDrafts.length} selected` : "Copy all"}
                      copiedLabel="Copied"
                    />
                  </span>
                )}
                <Button variant="secondary" onClick={() => openSaveModal()} disabled={done || selectedDrafts.length === 0}>Save selected</Button>
                <Button variant="secondary" onClick={() => void handleDeleteSelectedDrafts()} disabled={done || working || selectedDrafts.length === 0}>Delete selected</Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
                <thead className="bg-[var(--surface-secondary)] text-xs uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                  <tr>
                    <th className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={allDraftsSelected}
                        onChange={allDraftsSelected ? clearDraftSelection : selectAllDrafts}
                        disabled={done || task.drafts.length === 0}
                        aria-label="Select all generated testcases"
                      />
                    </th>
                    <th className="px-3 py-3">Testcase</th>
                    <th className="px-3 py-3">Priority</th>
                    <th className="px-3 py-3">Severity</th>
                    <th className="px-3 py-3">Component</th>
                    <th className="px-3 py-3">Preconditions</th>
                    <th className="px-3 py-3">Steps</th>
                    <th className="px-3 py-3">Expected Result</th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {task.drafts.map((draft, index) => (
                    <tr key={`${task.id}-${index}`} className="border-t border-[var(--border)] align-top">
                      <td className="px-3 py-3">
                        <input type="checkbox" checked={selectedDrafts.includes(index)} onChange={() => toggleDraft(index)} disabled={done} aria-label={`Select testcase ${index + 1}`} />
                      </td>
                      <td className="max-w-[260px] px-3 py-3">
                        {draft.action && (
                          <div className="mb-1 flex flex-wrap items-center gap-1.5">
                            <StatusChip tone="info" className="!rounded-[5px] !px-1.5 !py-0 !text-[10px] !font-medium">
                              {ACTION_LABEL[draft.action] || draft.action}
                            </StatusChip>
                            {draft.externalId && <span className="font-mono text-[11px] text-[var(--muted-soft)]">{draft.externalId}</span>}
                          </div>
                        )}
                        <div className="font-semibold text-[var(--foreground)]">{draft.title}</div>
                        {draft.tags?.length ? <div className="mt-2 text-xs text-[var(--muted-soft)]">{draft.tags.join(", ")}</div> : null}
                        {draft.techniques?.length ? <div className="mt-2"><TechniqueBadges techniques={draft.techniques} /></div> : null}
                        {/* Only present on a normalized update/archive draft (formatAiTask) — why
                            the sweep or the chat turn flagged this, shown right on the card so a
                            reviewer doesn't have to open the Activities tab to find out. */}
                        {draft.reason && <div className="mt-1 text-xs italic text-[var(--muted)]">{draft.reason}</div>}
                      </td>
                      <td className="px-3 py-3">
                        <span className="rounded bg-[var(--surface-secondary)] px-2 py-1 text-xs font-medium text-[var(--muted)]">{draft.priority}</span>
                      </td>
                      <td className="px-3 py-3">{knownSeverity(draft.severity) && <SeverityBadge severity={knownSeverity(draft.severity)!} />}</td>
                      <td className="px-3 py-3 text-[var(--muted)]">{draft.component || ""}</td>
                      <td className="max-w-[220px] px-3 py-3 text-[var(--muted)]">{draft.preconditions}</td>
                      <td className="px-3 py-3 text-[var(--muted)]">{stepCount(draft.stepsJson)} step{stepCount(draft.stepsJson) === 1 ? "" : "s"}</td>
                      <td className="max-w-[260px] px-3 py-3 text-[var(--muted)]">{draft.expectedSummary}</td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" onClick={() => openSaveModal([index])} disabled={done || working}>Save</Button>
                          <Button variant="secondary" onClick={() => void handleDeleteDraft(index)} disabled={done || working}>Delete</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {task.drafts.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-10 text-center text-sm text-[var(--muted)]">No generated testcases remain for this task.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "feedback" && (
        <div className="space-y-4">
          <Card className="p-4 space-y-3">
            {feedbackActivities.map((activity, index) => {
              const isAgent = activity.actor === "agent";
              return (
                <div
                  key={`${activity.title}-${index}`}
                  className={`rounded-lg border border-[var(--border)] p-3 ${isAgent ? "border-l-[3px] border-l-[var(--brand-primary)]" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      {isAgent ? <IconSparkles size={12} stroke={1.75} /> : <IconUser size={12} stroke={1.75} />}
                      {isAgent ? "Zyra" : "You"}
                    </span>
                    <span className="text-[11px] text-[var(--muted-soft)]">
                      {activity.createdAt ? new Date(activity.createdAt).toLocaleString() : ""}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--muted)]">{activity.detail || activity.title}</p>
                </div>
              );
            })}
            {feedbackActivities.length === 0 && <p className="text-sm text-[var(--muted)]">No feedback yet.</p>}
          </Card>

          <Card className="p-4 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">Send feedback</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">Send updates from the same review table so Zyra can regenerate this task with the latest context.</p>
            </div>
            <Field>
              <FieldLabel>Feedback for Zyra</FieldLabel>
              <Textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={5} placeholder="Ask Zyra to improve coverage, add edge cases, remove duplicates, or focus on a missed rule." />
            </Field>
            <Field>
              <FieldLabel>Docs or ticket references for knowledge base</FieldLabel>
              <Textarea value={referenceNote} onChange={(event) => setReferenceNote(event.target.value)} rows={3} placeholder="Mention docs, Jira tickets, release notes, or policy links Zyra should consider." />
            </Field>
            {jiraTickets.length > 0 && (
              <Field>
                <FieldLabel>Attach Jira tickets</FieldLabel>
                <Select
                  value=""
                  onChange={(event) => {
                    const key = event.target.value;
                    if (key && !selectedJiraKeys.includes(key)) setSelectedJiraKeys((prev) => [...prev, key]);
                  }}
                >
                  <option value="">Select ticket...</option>
                  {jiraTickets.map((ticket) => (
                    <option key={ticket.id} value={ticket.jiraIssueKey}>{ticket.jiraIssueKey} - {ticket.summary}</option>
                  ))}
                </Select>
                {selectedJiraKeys.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedJiraKeys.map((key) => (
                      <button
                        type="button"
                        key={key}
                        onClick={() => setSelectedJiraKeys((prev) => prev.filter((item) => item !== key))}
                        className="rounded-full border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]"
                      >
                        {key} x
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            )}
            {!canGiveFeedback && (
              <p className="text-xs text-[var(--muted)]">
                {taskStatusNow === "in_progress" || taskStatusNow === "todo"
                  ? "Feedback opens up once Zyra finishes generating drafts for this task."
                  : "Feedback isn't available once a task is closed."}
              </p>
            )}
            <Button variant="secondary" onClick={handleFeedback} disabled={working || !canGiveFeedback || !feedback.trim()}>{working ? "Sending..." : "Send feedback"}</Button>
          </Card>
        </div>
      )}

      {activeTab === "activities" && (
        <Card className="p-4 space-y-3">
          {task.activities.map((activity, index) => (
            <div key={`${activity.title}-${index}`} className="rounded-lg border border-[var(--border)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">{activity.actor} - {(activity.stage || "").replaceAll("_", " ")}</span>
                <span className="text-[11px] text-[var(--muted-soft)]">{activity.createdAt ? new Date(activity.createdAt).toLocaleString() : ""}</span>
              </div>
              <h3 className="mt-1 text-sm font-semibold text-[var(--foreground)]">{activity.title}</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--muted)]">{activity.detail}</p>
            </div>
          ))}
          {task.activities.length === 0 && <p className="text-sm text-[var(--muted)]">No activity recorded yet.</p>}
        </Card>
      )}

      {activeTab === "sources" && (
        <Card className="p-4 space-y-3">
          {task.sources.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No source summary recorded.</p>
          ) : (
            task.sources.map((source, index) => (
              <div key={`${source.type}-${index}`} className="rounded-lg border border-[var(--border)] p-3">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">{source.type.replaceAll("_", " ")}</span>
                <h3 className="mt-1 text-sm font-semibold text-[var(--foreground)]">{source.title}</h3>
                {source.type === "knowledge_base" ? (
                  <div
                    className="zyra-prose zyra-prose-compact break-words mt-1 text-sm text-[var(--muted)]"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(source.detail) }}
                  />
                ) : (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--muted)]">{source.detail}</p>
                )}
              </div>
            ))
          )}
        </Card>
      )}

      <Modal open={savingOpen} onClose={() => setSavingOpen(false)} title="Save generated testcases">
        <div className="space-y-4">
          <p className="text-sm text-[var(--muted)]">Save {(savingDraftIndexes || selectedDrafts).length} selected testcase draft(s) into a suite.</p>
          <Field>
            <FieldLabel>Suite target</FieldLabel>
            <Select value={saveMode} onChange={(event) => setSaveMode(event.target.value as SaveMode)}>
              <option value="existing">Existing suite</option>
              <option value="new">Create suite</option>
            </Select>
          </Field>
          {saveMode === "existing" ? (
            <Field>
              <FieldLabel>Existing suite</FieldLabel>
              <Select value={targetSuiteId} onChange={(event) => setTargetSuiteId(event.target.value)}>
                <option value="">No suite</option>
                {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
              </Select>
            </Field>
          ) : (
            <Field>
              <FieldLabel>New suite name</FieldLabel>
              <Input value={newSuiteName} onChange={(event) => setNewSuiteName(event.target.value)} placeholder="AI generated regression" />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSavingOpen(false)} disabled={working}>Cancel</Button>
            <Button onClick={handleSave} disabled={working || (savingDraftIndexes || selectedDrafts).length === 0 || (saveMode === "new" && !newSuiteName.trim())}>{working ? "Saving..." : "Save"}</Button>
          </div>
        </div>
      </Modal>
    </StandardPageLayout>
  );
}
