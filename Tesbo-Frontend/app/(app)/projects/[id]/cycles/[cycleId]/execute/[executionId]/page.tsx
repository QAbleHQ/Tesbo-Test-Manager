"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  listCycleExecutions,
  updateExecution,
  listBugs,
  removeBugLink,
  type ExecutionItem,
  type BugItem,
} from "@/lib/api";
import { IconBug } from "@tabler/icons-react";
import { Button, StatusChip, Input, PageLoader, Textarea, Select, ConfirmModal } from "@/components/ui";
import ExecutionEvidencePanel from "@/components/ExecutionEvidencePanel";
import { AutomationResultMeta } from "@/components/AutomationResultMeta";
import { useLogBugDialog } from "@/components/LogBugDialog";
import { Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

const STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"];

function statusToTone(status: string) {
  const map: Record<string, "success" | "error" | "blocked" | "skipped" | "retest" | "notRun"> = {
    Passed: "success",
    Failed: "error",
    Skipped: "skipped",
    Blocked: "blocked",
    Retest: "retest",
    Untested: "notRun",
  };
  return map[status] ?? "neutral";
}

function executionTitle(execution: ExecutionItem) {
  return execution.title || execution.snapshotTitle || "Untitled test case";
}

function normalizeSteps(value: unknown): Array<{ action: string; expected: string }> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value.trim() ? [{ action: value, expected: "" }] : [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item, index) => {
    if (typeof item === "string") return { action: item, expected: "" };
    const row = item as Record<string, unknown>;
    return {
      action: String(row.action || row.step || row.description || `Step ${index + 1}`),
      expected: String(row.expected || row.expectedResult || row.result || "")
    };
  });
}

export default function ExecutionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const cycleId = params.cycleId as string;
  const { currentUser } = useAppData();
  const { projectMembers: members } = useProjectData();
  const executionId = params.executionId as string;
  const [execution, setExecution] = useState<ExecutionItem | null>(null);
  const [status, setStatus] = useState("");
  const [actualResult, setActualResult] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  /* Bug Key / Bug Title shown for a Failed execution — read from the real bug(s) filed via "Log
     bug" (bugs/bug_links), not the old free-text defectKey/defectUrl columns on the execution row.
     An execution can have more than one bug linked to it, so this is every bug linked to THIS
     execution specifically, not just the first bug linked to its testcase+cycle. */
  const [linkedBugs, setLinkedBugs] = useState<BugItem[]>([]);
  /* Confirm-then-unlink for a single already-persisted bug — separate from the "Report a Bug"
     dialog's own chip removal, which only discards an unsaved working pick and never calls this. */
  const [bugToUnlink, setBugToUnlink] = useState<BugItem | null>(null);
  const [unlinkingBug, setUnlinkingBug] = useState(false);
  const { dialog: bugDialog, openBugDialogFor } = useLogBugDialog({
    projectId,
    cycleId,
    onLogged: () => {
      if (execution) loadLinkedBug(execution);
    },
  });

  function loadLinkedBug(exec: ExecutionItem) {
    // listBugs is scoped to testcase+cycle, not to this one execution (the API has no executionId
    // filter) — a testcase can be executed more than once in the same cycle, so this narrows to
    // the bugs actually linked to THIS execution via each bug's own links[].
    listBugs(projectId, { testcaseId: exec.testcaseId, cycleId })
      .then((bugs) => setLinkedBugs(bugs.filter((bug) => bug.links.some((l) => l.executionId === exec.id))))
      .catch(() => setLinkedBugs([]));
  }

  /* ───── Unlink one bug from this execution — removes only the bug_links row tying it to this
   * testcase/cycle/execution via the existing addBugLink/removeBugLink pair; never deletes the
   * bug (or, for a Jira/Linear-originated bug, its external ticket). Reloads from the API rather
   * than just filtering linkedBugs locally so the list reflects the same state a refresh would. */
  function requestUnlinkBug(bug: BugItem) {
    setBugToUnlink(bug);
  }

  async function confirmUnlinkBug() {
    if (!bugToUnlink || !execution) return;
    const link = bugToUnlink.links.find((l) => l.executionId === execution.id);
    if (!link) {
      setBugToUnlink(null);
      return;
    }
    setUnlinkingBug(true);
    try {
      await removeBugLink(bugToUnlink.id, link.id);
      loadLinkedBug(execution);
      setBugToUnlink(null);
    } finally {
      setUnlinkingBug(false);
    }
  }

  useEffect(() => {
    if (!currentUser) {
      router.replace("/login");
      return;
    }
    listCycleExecutions(cycleId)
      .then((list) => {
        const e = list.find((x) => x.id === executionId);
        if (e) {
          setExecution(e);
          setStatus(e.status || "Untested");
          setActualResult(e.actualResult || "");
          setAssigneeId(e.assigneeId || "");
          loadLinkedBug(e);
        }
      })
      .catch(() => router.replace("/projects"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId, executionId, projectId, router, currentUser]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateExecution(cycleId, executionId, {
        status,
        actualResult,
        assigneeId: assigneeId || null,
      });
      router.push(`/projects/${projectId}/cycles/${cycleId}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!execution) {
    return <PageLoader variant="screen" />;
  }

  const steps = normalizeSteps(execution.steps);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3">
        <Breadcrumbs
          items={[
            { label: "Test Runs", href: `/projects/${projectId}/cycles` },
            { label: "Run Detail", href: `/projects/${projectId}/cycles/${cycleId}` },
            { label: "Execute" },
          ]}
        />
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-xl font-bold text-[var(--foreground)]">
            {executionTitle(execution)}
          </h1>
          <StatusChip tone={statusToTone(status)}>{status}</StatusChip>
        </div>

        {execution.externalId && (
          <p className="text-xs text-[var(--muted-soft)] font-mono mb-4">{execution.externalId}</p>
        )}

        <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h2 className="mb-3 text-sm font-semibold text-[var(--foreground)]">Test case details</h2>
          <div className="space-y-4 text-sm">
            {execution.description && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Description</p>
                <p className="whitespace-pre-wrap text-[var(--foreground)]">{execution.description}</p>
              </div>
            )}
            {execution.preconditions && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Preconditions</p>
                <p className="whitespace-pre-wrap text-[var(--foreground)]">{execution.preconditions}</p>
              </div>
            )}
            {execution.testData && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Test data</p>
                <p className="whitespace-pre-wrap text-[var(--foreground)]">{execution.testData}</p>
              </div>
            )}
            {steps.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-[var(--muted)]">Steps</p>
                <ol className="space-y-2">
                  {steps.map((step, index) => (
                    <li key={`${step.action}-${index}`} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
                      <p className="font-medium text-[var(--foreground)]">{index + 1}. {step.action}</p>
                      {step.expected && <p className="mt-1 text-[var(--muted)]">Expected: {step.expected}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {!execution.description && !execution.preconditions && !execution.testData && steps.length === 0 && (
              <p className="text-[var(--muted)]">No additional test case details were captured for this execution.</p>
            )}
          </div>
        </section>

        <form onSubmit={handleSave} className="space-y-5">
          {/* Status buttons */}
          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-2">
              Status
            </label>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => {
                const active = status === s;
                const colors: Record<string, string> = {
                  Passed: active ? "bg-[var(--success)] text-white" : "border-[var(--success)]/30 text-[var(--success-foreground)] hover:bg-[var(--success-soft)]",
                  Failed: active ? "bg-[var(--error)] text-white" : "border-[var(--error)]/30 text-[var(--error-foreground)] hover:bg-[var(--error-soft)]",
                  Skipped: active ? "bg-[var(--status-skipped-dot)] text-white" : "border-[var(--status-skipped-dot)]/30 text-[var(--status-skipped-text)] hover:bg-[var(--status-skipped-fill)]",
                  Blocked: active ? "bg-[var(--status-blocked-dot)] text-white" : "border-[var(--status-blocked-dot)]/30 text-[var(--status-blocked-text)] hover:bg-[var(--status-blocked-fill)]",
                  Retest: active ? "bg-[var(--info)] text-white" : "border-[var(--info)]/30 text-[var(--info)] hover:bg-[var(--info-soft)]",
                  Untested: active ? "bg-[var(--muted)] text-white" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-secondary)]",
                };
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${colors[s]}`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Assigned to
            </label>
            <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} aria-label="Assigned to">
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email}
                </option>
              ))}
              {/* Current assignee not among this project's members — an AI agent or a stale row.
                  Keep it visible as a disabled option rather than silently showing "Unassigned",
                  which would clear a real assignment on Save. */}
              {assigneeId && !members.some((m) => m.userId === assigneeId) && (
                <option value={assigneeId} disabled>
                  Unknown assignee (not a project member)
                </option>
              )}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--muted)] mb-1">
              Actual Result / Notes
            </label>
            <Textarea
              value={actualResult}
              onChange={(e) => setActualResult(e.target.value)}
              rows={4}
              placeholder="Describe what actually happened…"
            />
          </div>

          {/*
            * Bug Key / Bug Title — Failed only (Basecamp 10221790207 kept the same visibility
            * rule). Read-only: these reflect the real bug(s) filed via "Log bug" (bugs/bug_links),
            * not a free-text value typed here, so there's nothing to type into them. One execution
            * can now have several bugs linked (multi-select existing-bug picker) — a single linked
            * bug keeps the original "Bug Key"/"Bug Title" labels; more than one numbers them
            * ("Bug 1 Key", "Bug 2 Key", …) so none is silently dropped. Every row gets its own
            * Unlink action regardless of count.
            */}
          <div className="space-y-3" hidden={status !== "Failed"}>
            {linkedBugs.length === 0 ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                    Bug Key
                  </label>
                  <Input type="text" aria-label="Bug Key" value="" readOnly placeholder="e.g. PROJ-123" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                    Bug Title
                  </label>
                  <Input type="text" aria-label="Bug Title" value="" readOnly placeholder="Title of the linked bug" />
                </div>
              </div>
            ) : (
              linkedBugs.map((bug, i) => {
                const keyLabel = linkedBugs.length > 1 ? `Bug ${i + 1} Key` : "Bug Key";
                const titleLabel = linkedBugs.length > 1 ? `Bug ${i + 1} Title` : "Bug Title";
                return (
                  <div key={bug.id} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                    <div>
                      <label className="block text-sm font-medium text-[var(--muted)] mb-1">{keyLabel}</label>
                      <Input type="text" aria-label={keyLabel} value={bug.integrationIssueKey || bug.externalId || ""} readOnly placeholder="e.g. PROJ-123" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--muted)] mb-1">{titleLabel}</label>
                      <Input type="text" aria-label={titleLabel} value={bug.title || ""} readOnly placeholder="Title of the linked bug" />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label={`Unlink ${bug.title}`}
                      onClick={() => requestUnlinkBug(bug)}
                    >
                      Unlink
                    </Button>
                  </div>
                );
              })
            )}
          </div>

          {/* Unlink-bug confirmation — unlink only, never deletes the bug or its Jira/Linear
              ticket. Distinct from the "Report a Bug" dialog's own chip ✕, which only discards an
              unsaved working pick and never reaches this or the removeBugLink API. */}
          <ConfirmModal
            open={!!bugToUnlink}
            title="Unlink bug"
            message={`Remove "${bugToUnlink?.title ?? ""}" from this test case? This only removes the link — the bug itself will not be deleted.`}
            confirmLabel="Unlink"
            loading={unlinkingBug}
            onConfirm={confirmUnlinkBug}
            onCancel={() => setBugToUnlink(null)}
          />

          {/*
            * The same two panels the run drawer shows, so a result looks the same wherever it is
            * opened. Both render nothing for a human-recorded result with no evidence, which is
            * every result that existed before the automation ingest (Basecamp 10189985971).
            */}
          <AutomationResultMeta execution={execution} />

          <div className="h-px bg-[var(--border)]" />

          <ExecutionEvidencePanel cycleId={cycleId} executionId={execution.id} />

          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => openBugDialogFor(execution)}>
              <IconBug size={14} />
              Log bug
            </Button>
            <Link
              href={`/projects/${projectId}/cycles/${cycleId}`}
              className="rounded-lg border border-[var(--border)] py-2 px-5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
            >
              Cancel
            </Link>
          </div>
        </form>
      </main>
      {bugDialog}
    </div>
  );
}
