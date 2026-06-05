"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  authMe,
  createZyraTask,
  getJiraStatus,
  getZyraAgent,
  listKnowledgeBaseItems,
  listJiraTickets,
  type JiraTicket,
  type KnowledgeBaseItem,
  type ZyraAgentState,
  type ZyraTask,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Select, StatusChip, Textarea } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

const columns = [
  { key: "todo", label: "Todo" },
  { key: "in_progress", label: "In Progress" },
  { key: "in_review", label: "In Review" },
  { key: "done", label: "Done" },
] as const;

function normalizeStatus(status: string): string {
  if (status === "accepted") return "done";
  if (status === "rejected") return "todo";
  return status || "todo";
}

function tone(status: string): "neutral" | "info" | "success" | "warning" {
  const normalized = normalizeStatus(status);
  if (normalized === "done") return "success";
  if (normalized === "in_review") return "info";
  if (normalized === "in_progress") return "warning";
  return "neutral";
}

export default function ZyraTasksPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [state, setState] = useState<ZyraAgentState | null>(null);
  const [jiraTickets, setJiraTickets] = useState<JiraTicket[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeBaseItem[]>([]);
  const [jiraEnabled, setJiraEnabled] = useState(false);
  const [story, setStory] = useState("");
  const [context, setContext] = useState("");
  const [selectedJiraKeys, setSelectedJiraKeys] = useState<string[]>([]);
  const [selectedKnowledgeItemIds, setSelectedKnowledgeItemIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [agentState, jiraStatus] = await Promise.all([
        getZyraAgent(projectId),
        getJiraStatus(projectId).catch(() => ({ connected: false })),
      ]);
      setState(agentState);
      const kb = await listKnowledgeBaseItems(projectId).catch(() => ({ list: [], total: 0 }));
      setKnowledgeItems(kb.list || []);
      setJiraEnabled(jiraStatus.connected === true);
      if (jiraStatus.connected) {
        const tickets = await listJiraTickets(projectId, { limit: 50 }).catch(() => ({ list: [], total: 0 }));
        setJiraTickets(tickets.list || []);
      } else {
        setJiraTickets([]);
      }
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
  }, [loadData, router]);

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
        jiraIssueKeys: selectedJiraKeys,
        knowledgeItemIds: selectedKnowledgeItemIds,
        count: state?.settings.testcaseCount,
      });
      setStory("");
      setContext("");
      setSelectedJiraKeys([]);
      setSelectedKnowledgeItemIds([]);
      setMessage("Task created in Todo. Zyra will pick it up and move it to In Progress.");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to allocate task.");
    } finally {
      setWorking(false);
    }
  }

  function handleSelectJiraTicket(key: string) {
    if (!key || selectedJiraKeys.includes(key)) return;
    const ticket = jiraTickets.find((item) => item.jiraIssueKey === key);
    setSelectedJiraKeys((prev) => [...prev, key]);
    if (!ticket) return;

    const title = `${ticket.jiraIssueKey}: ${ticket.summary}`.trim();
    const description = [ticket.description, ticket.status ? `Status: ${ticket.status}` : "", ticket.priority ? `Priority: ${ticket.priority}` : ""]
      .filter(Boolean)
      .join("\n\n");

    setStory((prev) => {
      if (!prev.trim()) return title;
      if (prev.includes(ticket.jiraIssueKey) || prev.includes(ticket.summary)) return prev;
      return `${prev.trim()}\n\n${title}`;
    });
    setContext((prev) => {
      if (!description.trim()) return prev;
      const block = `Jira ${ticket.jiraIssueKey}\n${description}`;
      if (!prev.trim()) return block;
      if (prev.includes(ticket.jiraIssueKey)) return prev;
      return `${prev.trim()}\n\n${block}`;
    });
  }

  if (loading || !state) {
    return (
      <StandardPageLayout header={<PageHeader title="Agent tasks" />}>
        <div className="flex min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">Loading tasks...</div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Zyra"
          subtitle="Track every task on the Kanban board, then open a card to review generated testcases, feedback, sources, and activity."
          actions={<Link href={`/projects/${projectId}/agents/zyra/settings`} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Settings</Link>}
        />
      }
    >
      {message && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm">{message}</p>}
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}

      <form onSubmit={handleCreateTask}>
        <Card className="p-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">Allocate task to Zyra</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">Zyra considers story, user context, selected knowledge, selected Jira tickets, Zyra memory, and existing testcases.</p>
            </div>
            <StatusChip tone={state.agent.active ? "success" : "warning"}>{state.agent.active ? "Active" : "Inactive"}</StatusChip>
          </div>
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
          {jiraEnabled && (
            <Field>
              <FieldLabel>Jira tickets</FieldLabel>
              <Select
                value=""
                onChange={(event) => {
                  handleSelectJiraTicket(event.target.value);
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
          {knowledgeItems.length > 0 && (
            <Field>
              <FieldLabel>Knowledge Base docs and notes</FieldLabel>
              <Select
                value=""
                onChange={(event) => {
                  const id = event.target.value;
                  if (id && !selectedKnowledgeItemIds.includes(id)) setSelectedKnowledgeItemIds((prev) => [...prev, id]);
                }}
              >
                <option value="">Select knowledge...</option>
                {knowledgeItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.title} - {item.itemType}</option>
                ))}
              </Select>
              {selectedKnowledgeItemIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedKnowledgeItemIds.map((itemId) => {
                    const item = knowledgeItems.find((candidate) => candidate.id === itemId);
                    return (
                      <button
                        type="button"
                        key={itemId}
                        onClick={() => setSelectedKnowledgeItemIds((prev) => prev.filter((id) => id !== itemId))}
                        className="rounded-full border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]"
                      >
                        {item?.title || "Knowledge item"} x
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>
          )}
          <Button type="submit" disabled={working || !state.agent.active || !story.trim()}>{working ? "Creating task..." : "Create task"}</Button>
        </Card>
      </form>

      <div className="grid gap-4 xl:grid-cols-4">
        {columns.map((column) => {
          const tasks = tasksByColumn.get(column.key) || [];
          return (
            <section key={column.key} className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--foreground)]">{column.label}</h2>
                <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--muted)]">{tasks.length}</span>
              </div>
              <div className="space-y-3">
                {tasks.map((task) => (
                  <Link key={task.id} href={`/projects/${projectId}/agents/tasks/${task.id}`} className="block rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--brand-primary)]">
                    <StatusChip tone={tone(task.taskStatus)}>{normalizeStatus(task.taskStatus).replaceAll("_", " ")}</StatusChip>
                    <h3 className="mt-2 line-clamp-3 text-sm font-semibold text-[var(--foreground)]">{task.userStory}</h3>
                    {task.jiraIssueKeys.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {task.jiraIssueKeys.slice(0, 3).map((key) => (
                          <span key={key} className="rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--brand-primary)]">
                            {key}
                          </span>
                        ))}
                        {task.jiraIssueKeys.length > 3 && (
                          <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                            +{task.jiraIssueKeys.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="mt-2 text-xs text-[var(--muted)]">{task.generatedCount} testcase{task.generatedCount === 1 ? "" : "s"} generated - {task.tokenUsage.total} tokens</p>
                  </Link>
                ))}
                {tasks.length === 0 && <div className="rounded-lg border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--muted)]">No tasks</div>}
              </div>
            </section>
          );
        })}
      </div>
    </StandardPageLayout>
  );
}
