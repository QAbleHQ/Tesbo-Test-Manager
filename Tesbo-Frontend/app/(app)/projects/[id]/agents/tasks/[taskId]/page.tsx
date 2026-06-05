"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  authMe,
  closeZyraTask,
  createSuite,
  deleteZyraTaskDraft,
  getJiraStatus,
  getZyraTask,
  listJiraTickets,
  listSuites,
  saveZyraTask,
  sendZyraFeedback,
  type JiraTicket,
  type SuiteNode,
  type ZyraTask,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input, Modal, Select, StatusChip, Textarea } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type SaveMode = "existing" | "new";
type DetailTab = "testcases" | "activities" | "sources";

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

function stepCount(stepsJson: string): number {
  try {
    const parsed = JSON.parse(stepsJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export default function ZyraTaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const taskId = params.taskId as string;
  const [task, setTask] = useState<ZyraTask | null>(null);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [jiraTickets, setJiraTickets] = useState<JiraTicket[]>([]);
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

  const loadData = useCallback(async () => {
    try {
      const [taskData, suiteList, jiraStatus] = await Promise.all([
        getZyraTask(projectId, taskId),
        listSuites(projectId).catch(() => []),
        getJiraStatus(projectId).catch(() => ({ connected: false })),
      ]);
      setTask(taskData);
      setSuites(suiteList);
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
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

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
      setMessage("Feedback sent. Zyra moved the task to Todo, applied the feedback, and returned it for review.");
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

  if (loading || !task) {
    return (
      <StandardPageLayout header={<PageHeader title="Zyra task" />}>
        <div className="flex min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">Loading task...</div>
      </StandardPageLayout>
    );
  }

  const done = normalizeStatus(task.taskStatus) === "done";
  const allDraftsSelected = task.drafts.length > 0 && selectedDrafts.length === task.drafts.length;
  const tabItems: Array<{ key: DetailTab; label: string; count?: number }> = [
    { key: "testcases", label: "Generated Testcases", count: task.drafts.length },
    { key: "activities", label: "Activities", count: task.activities.length },
    { key: "sources", label: "Sources", count: task.sources.length },
  ];

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Zyra task"
          subtitle="Review the task, save or remove generated testcases, provide feedback, and track every Zyra status update."
          actions={<Link href={`/projects/${projectId}/agents/tasks`} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Back to board</Link>}
        />
      }
    >
      {message && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm">{message}</p>}
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <StatusChip tone={tone(task.taskStatus)}>{normalizeStatus(task.taskStatus).replaceAll("_", " ")}</StatusChip>
            <h2 className="mt-3 text-lg font-semibold text-[var(--foreground)]">{task.userStory}</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {task.generatedCount} testcase{task.generatedCount === 1 ? "" : "s"} generated, {task.savedCount} saved, {task.tokenUsage.total} tokens, updated {new Date(task.updatedAt).toLocaleString()}
            </p>
            {task.jiraIssueKeys.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {task.jiraIssueKeys.map((key) => (
                  <span key={key} className="rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-xs font-medium text-[var(--brand-primary)]">
                    {key}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void handleCloseTask()} disabled={done || working}>Close task</Button>
            <Button variant="confidence" onClick={() => openSaveModal()} disabled={done || selectedDrafts.length === 0}>Save selected</Button>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2 border-b border-[var(--border)]">
        {tabItems.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${activeTab === tab.key ? "border-[var(--brand-primary)] text-[var(--brand-primary)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"}`}
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
                <Button variant="secondary" onClick={clearDraftSelection} disabled={done || selectedDrafts.length === 0}>Clear selection</Button>
                <Button variant="secondary" onClick={() => openSaveModal()} disabled={done || selectedDrafts.length === 0}>Save selected</Button>
                <Button variant="secondary" onClick={() => void handleDeleteSelectedDrafts()} disabled={done || working || selectedDrafts.length === 0}>Delete selected</Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-sm">
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
                        <div className="font-semibold text-[var(--foreground)]">{draft.title}</div>
                        {draft.tags?.length ? <div className="mt-2 text-xs text-[var(--muted-soft)]">{draft.tags.join(", ")}</div> : null}
                      </td>
                      <td className="px-3 py-3">
                        <span className="rounded bg-[var(--surface-secondary)] px-2 py-1 text-xs font-medium text-[var(--muted)]">{draft.priority}</span>
                      </td>
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
                      <td colSpan={7} className="px-3 py-10 text-center text-sm text-[var(--muted)]">No generated testcases remain for this task.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">Feedback</h2>
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
            <Button variant="secondary" onClick={handleFeedback} disabled={working || done || !feedback.trim()}>{working ? "Sending..." : "Send feedback"}</Button>
          </Card>
        </div>
      )}

      {activeTab === "activities" && (
        <Card className="p-4 space-y-3">
          {task.activities.map((activity, index) => (
            <div key={`${activity.title}-${index}`} className="rounded-lg border border-[var(--border)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">{activity.actor} - {activity.stage.replaceAll("_", " ")}</span>
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
                <p className="mt-1 text-sm text-[var(--muted)]">{source.detail}</p>
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
