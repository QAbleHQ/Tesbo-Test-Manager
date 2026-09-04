"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  authMe,
  listCycleExecutions,
  updateExecution,
  listProjectMembers,
  type ExecutionItem,
} from "@/lib/api";
import { Button, StatusChip, Input, PageLoader, Textarea, Select } from "@/components/ui";
import ExecutionEvidencePanel from "@/components/ExecutionEvidencePanel";
import { AutomationResultMeta } from "@/components/AutomationResultMeta";
import { Breadcrumbs } from "@/components/workflows";

const STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"];

function statusToTone(status: string) {
  const map: Record<string, "success" | "error" | "blocked" | "skipped" | "info" | "neutral"> = {
    Passed: "success",
    Failed: "error",
    Skipped: "skipped",
    Blocked: "blocked",
    Retest: "info",
    Untested: "neutral",
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
  const executionId = params.executionId as string;
  const [execution, setExecution] = useState<ExecutionItem | null>(null);
  const [status, setStatus] = useState("");
  const [actualResult, setActualResult] = useState("");
  const [defectKey, setDefectKey] = useState("");
  const [defectUrl, setDefectUrl] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [members, setMembers] = useState<{ userId: string; email: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
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
            setDefectKey(e.defectKey || "");
            setDefectUrl(e.defectUrl || "");
            setAssigneeId(e.assigneeId || "");
          }
        })
        .catch(() => router.replace("/projects"));
      listProjectMembers(projectId).then(setMembers).catch(() => {});
    });
  }, [cycleId, executionId, projectId, router]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateExecution(cycleId, executionId, {
        status,
        actualResult,
        defectKey: defectKey || undefined,
        defectUrl: defectUrl || undefined,
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
            * Basecamp 10221790207 — "Only failed test case should show defect key and Defect URL".
            * A defect reference on a passing case is not just clutter: it flows into the CSV export
            * and the traceability matrix, where it reads as a bug against a case that passed. The
            * backend clears the stored values when a status other than Failed is saved, so hiding
            * the inputs here does not leave data behind invisibly.
            */}
          <div className="grid grid-cols-2 gap-3" hidden={status !== "Failed"}>
            <div>
              <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                Defect Key
              </label>
              <Input
                type="text"
                value={defectKey}
                onChange={(e) => setDefectKey(e.target.value)}
                placeholder="e.g. PROJ-123"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--muted)] mb-1">
                Defect URL
              </label>
              <Input
                type="url"
                value={defectUrl}
                onChange={(e) => setDefectUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
          </div>

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
            <Link
              href={`/projects/${projectId}/cycles/${cycleId}`}
              className="rounded-lg border border-[var(--border)] py-2 px-5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
            >
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}
