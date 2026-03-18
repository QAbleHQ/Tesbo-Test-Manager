"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  authMe,
  listCycleExecutions,
  updateExecution,
  getExecutionAutomationReport,
  getLatestAutomatedRunStatus,
  getExecutionAutomationVideoUrl,
  getExecutionAutomationTraceUrl,
  type ExecutionAutomationReport,
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
  const [automationReport, setAutomationReport] = useState<ExecutionAutomationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [liveRunState, setLiveRunState] = useState<"running" | "queued" | null>(null);

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
            setReportLoading(true);
            getExecutionAutomationReport(cycleId, e.id)
              .then(setAutomationReport)
              .catch(() => setAutomationReport(null))
              .finally(() => setReportLoading(false));
          }
        })
        .catch(() => router.replace("/projects"));
    });
  }, [cycleId, executionId, router]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const run = await getLatestAutomatedRunStatus(cycleId);
        if (cancelled) return;
        const item = run.items.find((entry) => entry.executionId === executionId);
        const nextLiveState = item?.status === "running" ? "running" : item?.status === "queued" ? "queued" : null;
        setLiveRunState(nextLiveState);

        if (nextLiveState || run.status === "running") {
          try {
            const latestReport = await getExecutionAutomationReport(cycleId, executionId);
            if (!cancelled) {
              setAutomationReport(latestReport);
            }
          } catch {
            // Ignore transient report read errors while live polling.
          }
          timer = setTimeout(poll, 2000);
          return;
        }
      } catch {
        // No active run or status endpoint temporarily unavailable.
      }

      timer = setTimeout(poll, 5000);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cycleId, executionId]);

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

  const executedSteps =
    automationReport?.logs?.filter((log) => log.kind === "step" || !!log.stepId || !!log.action) ?? [];
  const latestScreenshotUrl = useMemo(() => {
    for (let i = executedSteps.length - 1; i >= 0; i -= 1) {
      const candidate = executedSteps[i]?.screenshotUrl;
      if (candidate) return candidate;
    }
    return automationReport?.screenshotUrl || null;
  }, [automationReport?.screenshotUrl, executedSteps]);

  if (!execution) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

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
            {execution.title}
          </h1>
          <StatusChip tone={statusToTone(status)}>{status}</StatusChip>
        </div>

        {execution.externalId && (
          <p className="text-xs text-[var(--muted-soft)] font-mono mb-4">{execution.externalId}</p>
        )}

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

          <div className="rounded-xl border border-[var(--border)] p-4 bg-[var(--surface-secondary)]">
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-2">
              Automated Run Artifacts
            </h3>
            {liveRunState && (
              <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                {liveRunState === "running"
                  ? "Live preview is active. This page refreshes automation artifacts every few seconds."
                  : "This testcase is queued for automation. Live preview will start when execution begins."}
              </div>
            )}
            {reportLoading ? (
              <p className="text-sm text-[var(--muted)]">Loading run logs...</p>
            ) : !automationReport || automationReport.status === "not_available" ? (
              <p className="text-sm text-[var(--muted)]">
                No automated run artifacts found for this execution yet.
              </p>
            ) : (
              <div className="space-y-4">
                {latestScreenshotUrl && (
                  <div>
                    <p className="text-xs font-medium text-[var(--muted)] mb-2">Live Preview</p>
                    <a href={latestScreenshotUrl} target="_blank" rel="noreferrer" className="block">
                      <img
                        src={latestScreenshotUrl}
                        alt="Latest automation screenshot"
                        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] object-contain max-h-96"
                      />
                    </a>
                  </div>
                )}
                <div className="text-xs text-[var(--muted)]">
                  <p>Status: <span className="font-medium">{automationReport.status}</span></p>
                  {automationReport.startedAt && (
                    <p>Started: {new Date(automationReport.startedAt).toLocaleString()}</p>
                  )}
                  {automationReport.endedAt && (
                    <p>Ended: {new Date(automationReport.endedAt).toLocaleString()}</p>
                  )}
                  {automationReport.errorMessage && (
                    <p className="text-[var(--error)]">Error: {automationReport.errorMessage}</p>
                  )}
                </div>

                {automationReport.videoAvailable ? (
                  <div>
                    <p className="text-xs font-medium text-[var(--muted)] mb-2">Run Video</p>
                    {automationReport.videoUrl || automationReport.videoAvailable ? (
                      <video
                        controls
                        className="w-full rounded-lg border border-[var(--border)] bg-black"
                        src={automationReport.videoUrl || getExecutionAutomationVideoUrl(cycleId, executionId)}
                      />
                    ) : (
                      <p className="text-xs text-[var(--muted)]">Generating secure video URL...</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--muted)]">Video is not available for this run.</p>
                )}

                {(automationReport.traceAvailable || automationReport.tracePath) ? (
                  <div>
                    <p className="text-xs font-medium text-[var(--muted)] mb-2">Trace Artifact</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={automationReport.traceUrl || getExecutionAutomationTraceUrl(cycleId, executionId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                      >
                        Download Trace (.zip)
                      </a>
                      {automationReport.traceUrl && (
                        <a
                          href={`https://trace.playwright.dev/?trace=${encodeURIComponent(automationReport.traceUrl)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center rounded-md border border-emerald-800 bg-emerald-700 px-2.5 py-1.5 text-sm font-semibold !text-white visited:!text-white shadow-sm transition-colors hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1"
                        >
                          Open in Trace Viewer
                        </a>
                      )}
                    </div>
                    {!automationReport.traceUrl && (
                      <p className="mt-1 text-[11px] text-[var(--muted)]">
                        Trace Viewer needs a direct trace URL. Download the trace zip if direct URL is unavailable.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--muted)]">Trace is not available for this run.</p>
                )}

                <div>
                  <p className="text-xs font-medium text-[var(--muted)] mb-2">Step Logs</p>
                  {executedSteps.length === 0 ? (
                    <p className="text-xs text-[var(--muted)]">No step logs recorded.</p>
                  ) : (
                    <div className="max-h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-[var(--surface-secondary)]">
                          <tr>
                            <th className="text-left px-2 py-1">Step</th>
                            <th className="text-left px-2 py-1">Action</th>
                            <th className="text-left px-2 py-1">Status</th>
                            <th className="text-left px-2 py-1">Message</th>
                            <th className="text-left px-2 py-1">Screenshot</th>
                          </tr>
                        </thead>
                        <tbody>
                          {executedSteps.map((log, idx) => (
                            <tr key={`${log.stepId ?? "step"}-${idx}`} className="border-t border-[var(--border-subtle)]">
                              <td className="px-2 py-1 font-mono">{log.stepId ?? idx + 1}</td>
                              <td className="px-2 py-1">{log.action ?? "-"}</td>
                              <td className="px-2 py-1">{log.status ?? "-"}</td>
                              <td className="px-2 py-1">{log.message ?? "-"}</td>
                              <td className="px-2 py-1">
                                {log.screenshotUrl ? (
                                  <a
                                    href={log.screenshotUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[var(--brand-primary)] hover:underline"
                                  >
                                    View
                                  </a>
                                ) : (
                                  "-"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
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
