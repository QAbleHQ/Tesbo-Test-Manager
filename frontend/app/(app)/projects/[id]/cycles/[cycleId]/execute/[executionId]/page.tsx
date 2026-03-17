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

const STATUSES = ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"];

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    Passed: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    Failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    Skipped: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    Blocked: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    Retest: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    Untested: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls[status] || cls.Untested}`}>
      {status}
    </span>
  );
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
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-3">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/projects/${projectId}/cycles`} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Test Runs
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <Link href={`/projects/${projectId}/cycles/${cycleId}`} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Run Detail
          </Link>
          <span className="text-zinc-300 dark:text-zinc-600">/</span>
          <span className="text-zinc-900 dark:text-zinc-100 font-medium">Execute</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {execution.title}
          </h1>
          <StatusBadge status={status} />
        </div>

        {execution.externalId && (
          <p className="text-xs text-zinc-400 font-mono mb-4">{execution.externalId}</p>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          {/* Status buttons */}
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Status
            </label>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => {
                const active = status === s;
                const colors: Record<string, string> = {
                  Passed: active ? "bg-green-600 text-white" : "border-green-200 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/20",
                  Failed: active ? "bg-red-600 text-white" : "border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20",
                  Skipped: active ? "bg-yellow-500 text-white" : "border-yellow-200 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-800 dark:text-yellow-400 dark:hover:bg-yellow-900/20",
                  Blocked: active ? "bg-orange-500 text-white" : "border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-900/20",
                  Retest: active ? "bg-purple-600 text-white" : "border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/20",
                  Untested: active ? "bg-zinc-600 text-white" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800",
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
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Actual Result / Notes
            </label>
            <textarea
              value={actualResult}
              onChange={(e) => setActualResult(e.target.value)}
              rows={4}
              placeholder="Describe what actually happened…"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>

          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-zinc-50 dark:bg-zinc-900/40">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              Automated Run Artifacts
            </h3>
            {liveRunState && (
              <div className="mb-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
                {liveRunState === "running"
                  ? "Live preview is active. This page refreshes automation artifacts every few seconds."
                  : "This testcase is queued for automation. Live preview will start when execution begins."}
              </div>
            )}
            {reportLoading ? (
              <p className="text-sm text-zinc-500">Loading run logs...</p>
            ) : !automationReport || automationReport.status === "not_available" ? (
              <p className="text-sm text-zinc-500">
                No automated run artifacts found for this execution yet.
              </p>
            ) : (
              <div className="space-y-4">
                {latestScreenshotUrl && (
                  <div>
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">Live Preview</p>
                    <a href={latestScreenshotUrl} target="_blank" rel="noreferrer" className="block">
                      <img
                        src={latestScreenshotUrl}
                        alt="Latest automation screenshot"
                        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 object-contain max-h-96"
                      />
                    </a>
                  </div>
                )}
                <div className="text-xs text-zinc-500">
                  <p>Status: <span className="font-medium">{automationReport.status}</span></p>
                  {automationReport.startedAt && (
                    <p>Started: {new Date(automationReport.startedAt).toLocaleString()}</p>
                  )}
                  {automationReport.endedAt && (
                    <p>Ended: {new Date(automationReport.endedAt).toLocaleString()}</p>
                  )}
                  {automationReport.errorMessage && (
                    <p className="text-red-600 dark:text-red-400">Error: {automationReport.errorMessage}</p>
                  )}
                </div>

                {automationReport.videoAvailable ? (
                  <div>
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">Run Video</p>
                    {automationReport.videoUrl || automationReport.videoAvailable ? (
                      <video
                        controls
                        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-black"
                        src={automationReport.videoUrl || getExecutionAutomationVideoUrl(cycleId, executionId)}
                      />
                    ) : (
                      <p className="text-xs text-zinc-500">Generating secure video URL...</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Video is not available for this run.</p>
                )}

                {(automationReport.traceAvailable || automationReport.tracePath) ? (
                  <div>
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">Trace Artifact</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={automationReport.traceUrl || getExecutionAutomationTraceUrl(cycleId, executionId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      >
                        Download Trace (.zip)
                      </a>
                      {automationReport.traceUrl && (
                        <a
                          href={`https://trace.playwright.dev/?trace=${encodeURIComponent(automationReport.traceUrl)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center rounded-md border border-emerald-800 bg-emerald-700 px-2.5 py-1.5 text-sm font-semibold !text-white visited:!text-white shadow-sm transition-colors hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 dark:border-emerald-300 dark:bg-emerald-500 dark:!text-zinc-950 dark:hover:bg-emerald-400"
                        >
                          Open in Trace Viewer
                        </a>
                      )}
                    </div>
                    {!automationReport.traceUrl && (
                      <p className="mt-1 text-[11px] text-zinc-500">
                        Trace Viewer needs a direct trace URL. Download the trace zip if direct URL is unavailable.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Trace is not available for this run.</p>
                )}

                <div>
                  <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2">Step Logs</p>
                  {executedSteps.length === 0 ? (
                    <p className="text-xs text-zinc-500">No step logs recorded.</p>
                  ) : (
                    <div className="max-h-64 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-800">
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
                            <tr key={`${log.stepId ?? "step"}-${idx}`} className="border-t border-zinc-100 dark:border-zinc-800">
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
                                    className="text-blue-600 hover:underline"
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
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Defect Key
              </label>
              <input
                type="text"
                value={defectKey}
                onChange={(e) => setDefectKey(e.target.value)}
                placeholder="e.g. PROJ-123"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Defect URL
              </label>
              <input
                type="url"
                value={defectUrl}
                onChange={(e) => setDefectUrl(e.target.value)}
                placeholder="https://…"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2 px-5 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <Link
              href={`/projects/${projectId}/cycles/${cycleId}`}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 py-2 px-5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}
