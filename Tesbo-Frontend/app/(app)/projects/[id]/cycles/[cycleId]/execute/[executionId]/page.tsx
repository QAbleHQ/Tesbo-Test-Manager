"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  authMe,
  listCycleExecutions,
  updateExecution,
  type ExecutionItem,
} from "@/lib/api";
import { Button, StatusChip, Input, Textarea } from "@/components/ui";

const STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"];

function statusToTone(status: string) {
  const map: Record<string, "success" | "error" | "warning" | "info" | "neutral"> = {
    Passed: "success",
    Failed: "error",
    Skipped: "warning",
    Blocked: "warning",
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
          }
        })
        .catch(() => router.replace("/projects"));
    });
  }, [cycleId, executionId, router]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateExecution(cycleId, executionId, {
        status,
        actualResult,
        defectKey: defectKey || undefined,
        defectUrl: defectUrl || undefined,
      });
      router.push(`/projects/${projectId}/cycles/${cycleId}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!execution) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const steps = normalizeSteps(execution.steps);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/projects/${projectId}/cycles`} className="text-[var(--muted)] hover:text-[var(--foreground)]">
            Test Runs
          </Link>
          <span className="text-[var(--muted-soft)]">/</span>
          <Link href={`/projects/${projectId}/cycles/${cycleId}`} className="text-[var(--muted)] hover:text-[var(--foreground)]">
            Run Detail
          </Link>
          <span className="text-[var(--muted-soft)]">/</span>
          <span className="text-[var(--foreground)] font-medium">Execute</span>
        </div>
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
                  Passed: active ? "bg-[var(--success)] text-white" : "border-[var(--success)]/30 text-[var(--success)] hover:bg-[var(--success-soft)]",
                  Failed: active ? "bg-[var(--error)] text-white" : "border-[var(--error)]/30 text-[var(--error)] hover:bg-[var(--error-soft)]",
                  Skipped: active ? "bg-[var(--warning)] text-white" : "border-[var(--warning)]/30 text-[var(--warning)] hover:bg-[var(--warning-soft)]",
                  Blocked: active ? "bg-[var(--warning)] text-white" : "border-[var(--warning)]/30 text-[var(--warning)] hover:bg-[var(--warning-soft)]",
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
              Actual Result / Notes
            </label>
            <Textarea
              value={actualResult}
              onChange={(e) => setActualResult(e.target.value)}
              rows={4}
              placeholder="Describe what actually happened…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
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
