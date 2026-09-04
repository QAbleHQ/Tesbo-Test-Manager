"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconSparkles } from "@tabler/icons-react";
import {
  authMe,
  createZyraTask,
  getProject,
  getZyraAgent,
  listKnowledgeDocuments,
  type KnowledgeDocument,
  type ZyraAgentState,
  type ZyraTask,
} from "@/lib/api";
import { Button, Field, FieldLabel, Modal, PageLoader, Select, StatusChip, Textarea } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import TaskQuickViewPanel, { JIRA_BADGE_CLASS, latestFailureDetail, normalizeTaskStatus as normalizeStatus, taskStatusLabel, taskStatusTone as tone } from "@/components/agents/TaskQuickViewPanel";

const columns = [
  { key: "todo", label: "To Do", dot: "var(--muted-soft)" },
  { key: "in_progress", label: "In Progress", dot: "var(--warning)" },
  { key: "in_review", label: "In Review", dot: "var(--accent-light)" },
  { key: "failed", label: "Failed", dot: "var(--error)" },
  { key: "done", label: "Done", dot: "var(--success)" },
] as const;

type TaskView = "tasks" | "kanban";

function htmlToPlainText(html: string): string {
  // The knowledge-base editor only ever produces rich-text markup (paragraphs, lists, headings,
  // inline marks) — never <script>/<style> — so a generic tag strip is all this needs.
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `contentText` is the plain-text render kept in sync by the editor and by integration sync, but a
 * handful of paths (a brand-new blank document, an older row from before contentText existed) can
 * leave it null while contentHtml still holds the real content. Falling back to it means selecting
 * a document never silently yields empty Context just because that one column is unset.
 */
function resolveDocumentText(item: KnowledgeDocument): string {
  if (item.contentText?.trim()) return item.contentText;
  if (item.contentHtml?.trim()) return htmlToPlainText(item.contentHtml);
  return "";
}

/**
 * Knowledge Base documents mirror Jira/Linear tickets as flattened markdown (see
 * IntegrationSyncDocumentBuilder), so an "Acceptance Criteria" section arrives as a plain line
 * inside the text rather than its own field. Splits that section out so a selected doc's
 * acceptance criteria land in a dedicated field instead of getting mixed into Context.
 */
function splitAcceptanceCriteria(text: string): { body: string; acceptanceCriteria: string } {
  const lines = text.split("\n");
  const markerIndex = lines.findIndex((line) => {
    const normalized = line.trim().replace(/^#+\s*/, "").replace(/:$/, "").trim().toLowerCase();
    return normalized === "acceptance criteria";
  });
  if (markerIndex === -1) return { body: text, acceptanceCriteria: "" };

  let endIndex = lines.length;
  for (let i = markerIndex + 1; i < lines.length; i++) {
    if (/^#+\s/.test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }

  const acceptanceCriteria = lines.slice(markerIndex + 1, endIndex).join("\n").trim();
  if (!acceptanceCriteria) return { body: text, acceptanceCriteria: "" };

  const body = [...lines.slice(0, markerIndex), ...lines.slice(endIndex)].join("\n").trim();
  return { body, acceptanceCriteria };
}

export default function ZyraTasksPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeDocument[]>([]);
  const [story, setStory] = useState("");
  const [context, setContext] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [selectedKnowledgeItemIds, setSelectedKnowledgeItemIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeView, setActiveView] = useState<TaskView>("tasks");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quickViewTask, setQuickViewTask] = useState<ZyraTask | null>(null);
  const [projectName, setProjectName] = useState("");
  // Guards the poll loop below against piling up requests if one tick is still in flight
  // (a slow response, or the tab waking from sleep) when the next interval fires.
  const pollInFlightRef = useRef(false);

  function handleTaskUpdated(updated: ZyraTask) {
    setQuickViewTask(updated);
    setState((prev) => (prev ? { ...prev, tasks: prev.tasks.map((t) => (t.id === updated.id ? updated : t)) } : prev));
  }

  const loadData = useCallback(async () => {
    try {
      const agentState = await getZyraAgent(projectId);
      setState(agentState);
      const kb = await listKnowledgeDocuments(projectId).catch(() => ({ list: [], total: 0 }));
      setKnowledgeItems(kb.list || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent tasks.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
    getProject(projectId).then((p) => setProjectName(String(p.name || ""))).catch(() => setProjectName(""));
  }, [loadData, router, projectId]);

  // Refreshes just the task list (cheaper than loadData, which also re-pulls knowledge-base
  // data). Zyra picks up and finishes tasks asynchronously server-side, so without this the board
  // only ever reflected that after a manual reload.
  const refreshTasks = useCallback(async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const agentState = await getZyraAgent(projectId);
      setState((prev) => (prev ? { ...prev, tasks: agentState.tasks, testcasesCreated: agentState.testcasesCreated, tokenUsage: agentState.tokenUsage, agent: agentState.agent } : agentState));
      setQuickViewTask((prev) => (prev ? agentState.tasks.find((t) => t.id === prev.id) || prev : prev));
    } catch {
      // A missed poll tick isn't worth surfacing as an error — the row itself is the source of
      // truth, and the next tick usually succeeds.
    } finally {
      pollInFlightRef.current = false;
    }
  }, [projectId]);

  const hasActiveTask = (state?.tasks || []).some((task) => ["todo", "in_progress"].includes(normalizeStatus(task.taskStatus)));

  useEffect(() => {
    if (!hasActiveTask) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshTasks();
    }, 5000);
    return () => clearInterval(timer);
  }, [hasActiveTask, refreshTasks]);

  const tasksByColumn = useMemo(() => {
    const grouped = new Map<string, ZyraTask[]>();
    for (const column of columns) grouped.set(column.key, []);
    for (const task of state?.tasks || []) {
      const key = normalizeStatus(task.taskStatus);
      grouped.set(key, [...(grouped.get(key) || []), task]);
    }
    return grouped;
  }, [state]);

  async function handleCreateTask(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    setError(null);
    try {
      await createZyraTask(projectId, {
        story,
        context,
        acceptanceCriteria,
        knowledgeItemIds: selectedKnowledgeItemIds,
        count: state?.settings.testcaseCount,
      });
      setStory("");
      setContext("");
      setAcceptanceCriteria("");
      setSelectedKnowledgeItemIds([]);
      setCreateOpen(false);
      setMessage("Task created in Todo. Zyra will pick it up and move it to In Progress.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to allocate task.");
    } finally {
      setWorking(false);
    }
  }

  function handleSelectKnowledgeItem(id: string) {
    if (!id || selectedKnowledgeItemIds.includes(id)) return;
    const item = knowledgeItems.find((candidate) => candidate.id === id);
    setSelectedKnowledgeItemIds((prev) => [...prev, id]);
    if (!item) return;

    setStory((prev) => {
      if (!prev.trim()) return item.title;
      if (prev.includes(item.title)) return prev;
      return `${prev.trim()}\n\n${item.title}`;
    });

    const { body, acceptanceCriteria: extractedCriteria } = splitAcceptanceCriteria(resolveDocumentText(item));

    setContext((prev) => {
      if (!body.trim()) return prev;
      const block = `${item.title}\n${body}`;
      if (!prev.trim()) return block;
      if (prev.includes(item.title)) return prev;
      return `${prev.trim()}\n\n${block}`;
    });

    if (extractedCriteria) {
      setAcceptanceCriteria((prev) => {
        const block = `${item.title}\n${extractedCriteria}`;
        if (!prev.trim()) return block;
        if (prev.includes(item.title)) return prev;
        return `${prev.trim()}\n\n${block}`;
      });
    }
  }

  const tasksBreadcrumb = (
    <Breadcrumbs
      items={[
        { label: "Projects", href: "/projects" },
        { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
        { label: "Agents", href: `/projects/${projectId}/agents` },
        { label: "Tasks" },
      ]}
    />
  );

  if (loading || !state) {
    return (
      <StandardPageLayout header={<PageHeader title="Agent tasks" breadcrumb={tasksBreadcrumb} />}>
        <PageLoader label="Loading tasks…" />
      </StandardPageLayout>
    );
  }

  const tasks = state.tasks || [];

  return (
    <StandardPageLayout
      header={
        <PageHeader
          breadcrumb={tasksBreadcrumb}
          title={
            <>
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px]"
                style={{ background: "linear-gradient(135deg, var(--brand-primary), var(--accent-light))" }}
              >
                <IconSparkles size={15} stroke={1.75} className="text-white" />
              </span>
              Zyra
            </>
          }
          subtitle="Track every task on the Kanban board, then open a card to review generated testcases, feedback, sources, and activity."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setCreateOpen(true)} disabled={!state.agent.active}>Create task</Button>
              <Link href={`/projects/${projectId}/agents/zyra`} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Chat</Link>
              <Link href={`/projects/${projectId}/agents/zyra/settings`} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Settings</Link>
            </div>
          }
        />
      }
    >
      {message && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm">{message}</p>}
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)]">
        <div className="flex gap-1" role="tablist" aria-label="Zyra task views">
          {[
            { key: "tasks" as const, label: "Task window" },
            { key: "kanban" as const, label: "Kanban board" },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeView === tab.key}
              onClick={() => setActiveView(tab.key)}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeView === tab.key
                  ? "border-[var(--brand-primary)] text-[var(--accent-light)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 pb-2.5">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ background: state.agent.active ? "var(--success)" : "var(--muted-soft)" }}
          />
          <span
            className="text-xs font-medium"
            style={{ color: state.agent.active ? "var(--success-foreground)" : "var(--muted-soft)" }}
          >
            {state.agent.active ? "Active" : "Inactive"}
          </span>
        </div>
      </div>

      {activeView === "tasks" ? (
        <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="grid grid-cols-[minmax(240px,1fr)_140px_180px_150px_120px] gap-3 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-3 text-xs font-semibold uppercase text-[var(--muted)] max-lg:hidden">
            <span>Task</span>
            <span>Status</span>
            <span>Jira</span>
            <span>Generated</span>
            <span>Tokens</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {tasks.map((task) => (
              <button
                type="button"
                key={task.id}
                onClick={() => setQuickViewTask(task)}
                className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-[var(--surface-secondary)] lg:grid-cols-[minmax(240px,1fr)_140px_180px_150px_120px] lg:items-center"
              >
                <div className="min-w-0">
                  <h2 className="line-clamp-2 text-sm font-semibold text-[var(--foreground)]">{task.userStory}</h2>
                  {normalizeStatus(task.taskStatus) === "failed" ? (
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--error-foreground)]">{latestFailureDetail(task.activities)}</p>
                  ) : (
                    task.context && <p className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">{task.context}</p>
                  )}
                </div>
                <div><StatusChip tone={tone(task.taskStatus)}>{taskStatusLabel(task.taskStatus)}</StatusChip></div>
                <div className="flex flex-wrap gap-1.5">
                  {task.jiraIssueKeys.slice(0, 2).map((key) => (
                    <span key={key} className={JIRA_BADGE_CLASS}>{key}</span>
                  ))}
                  {task.jiraIssueKeys.length === 0 && <span className="text-xs text-[var(--muted)]">No tickets</span>}
                  {task.jiraIssueKeys.length > 2 && <span className="text-xs text-[var(--muted)]">+{task.jiraIssueKeys.length - 2}</span>}
                </div>
                <span className="text-sm text-[var(--foreground)]">{task.generatedCount} testcase{task.generatedCount === 1 ? "" : "s"}</span>
                <span className="font-mono text-sm text-[var(--muted)]">{task.tokenUsage.total}</span>
              </button>
            ))}
            {tasks.length === 0 && <div className="p-8 text-center text-sm text-[var(--muted)]">No tasks in queue</div>}
          </div>
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-5">
          {columns.map((column) => {
            const columnTasks = tasksByColumn.get(column.key) || [];
            const isDone = column.key === "done";
            return (
              <section key={column.key} className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: column.dot }} />
                    <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--foreground)]">{column.label}</h2>
                  </div>
                  <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--muted)]">{columnTasks.length}</span>
                </div>
                <div className="space-y-3">
                  {columnTasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      onClick={() => setQuickViewTask(task)}
                      className={`block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-[opacity,border-color] hover:border-[var(--brand-primary)] ${isDone ? "opacity-75 hover:opacity-100" : ""}`}
                    >
                      <StatusChip tone={tone(task.taskStatus)}>{taskStatusLabel(task.taskStatus)}</StatusChip>
                      <h3 className="mt-2 line-clamp-3 text-sm font-semibold text-[var(--foreground)]">{task.userStory}</h3>
                      {normalizeStatus(task.taskStatus) === "failed" && (
                        <p className="mt-1 line-clamp-2 text-xs text-[var(--error-foreground)]">{latestFailureDetail(task.activities)}</p>
                      )}
                      {task.context && <p className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">{task.context}</p>}
                      {task.jiraIssueKeys.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {task.jiraIssueKeys.slice(0, 3).map((key) => (
                            <span key={key} className={JIRA_BADGE_CLASS}>{key}</span>
                          ))}
                          {task.jiraIssueKeys.length > 3 && (
                            <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                              +{task.jiraIssueKeys.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                      <p className="mt-2 text-xs text-[var(--muted)]">{task.generatedCount} testcase{task.generatedCount === 1 ? "" : "s"} generated - {task.tokenUsage.total} tokens</p>
                    </button>
                  ))}
                  {columnTasks.length === 0 && <div className="rounded-lg border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--muted)]">No tasks</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {quickViewTask && (
        <TaskQuickViewPanel
          task={quickViewTask}
          projectId={projectId}
          onClose={() => setQuickViewTask(null)}
          onTaskUpdated={handleTaskUpdated}
        />
      )}

      <Modal open={createOpen} onClose={() => !working && setCreateOpen(false)} title="Create Zyra task" className="max-w-3xl">
        <form onSubmit={handleCreateTask} className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <Field>
              <FieldLabel>Story</FieldLabel>
              <Textarea value={story} onChange={(event) => setStory(event.target.value)} rows={5} placeholder="As a user, I want..." />
            </Field>
            <Field>
              <FieldLabel>Context</FieldLabel>
              <Textarea value={context} onChange={(event) => setContext(event.target.value)} rows={5} placeholder="Business rules, edge cases, acceptance notes..." />
            </Field>
          </div>
          <Field>
            <FieldLabel>Acceptance Criteria</FieldLabel>
            <Textarea
              value={acceptanceCriteria}
              onChange={(event) => setAcceptanceCriteria(event.target.value)}
              rows={4}
              placeholder="Given ..., when ..., then ..."
            />
          </Field>
          {knowledgeItems.length > 0 && (
            <Field>
              <FieldLabel>Knowledge Base docs and notes</FieldLabel>
              <Select
                value=""
                onChange={(event) => handleSelectKnowledgeItem(event.target.value)}
              >
                <option value="">Select knowledge...</option>
                {knowledgeItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.title} - {item.documentType}</option>
                ))}
              </Select>
              {selectedKnowledgeItemIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedKnowledgeItemIds.map((itemId) => {
                    const item = knowledgeItems.find((candidate) => candidate.id === itemId);
                    return (
                      <button type="button" key={itemId} onClick={() => setSelectedKnowledgeItemIds((prev) => prev.filter((id) => id !== itemId))} className="rounded-full border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]">
                        {item?.title || "Knowledge item"} x
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)} disabled={working}>Cancel</Button>
            <Button type="submit" disabled={working || !state.agent.active || !story.trim()}>{working ? "Creating..." : "Create task"}</Button>
          </div>
        </form>
      </Modal>
    </StandardPageLayout>
  );
}
