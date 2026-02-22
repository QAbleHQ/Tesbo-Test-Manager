"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  getTesboRun,
  getTesboTestHistory,
  type TesboRunCase,
  type TesboRunDetail,
} from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

type TestHistory = {
  specName: string;
  testName: string;
  runs: { runId: string; runName: string; status: string; executedAt: string | null }[];
};

export default function TesboTestDetailPage() {
  const params = useParams();
  const projectId = params.id as string;
  const testSegments = Array.isArray(params.test) ? params.test : [String(params.test || "")];
  const specName = decodeURIComponent(testSegments[0] || "");
  const testName = decodeURIComponent(testSegments.slice(1).join("/") || "");

  const [history, setHistory] = useState<TestHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [runsById, setRunsById] = useState<Record<string, TesboRunDetail>>({});
  const [casesByRunId, setCasesByRunId] = useState<Record<string, TesboRunCase | null>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);
  const [isDetailPopupOpen, setIsDetailPopupOpen] = useState(false);
  const [showTraceViewer, setShowTraceViewer] = useState(false);
  const [previewScreenshotSrc, setPreviewScreenshotSrc] = useState<string | null>(null);
  const [previewVideoSrc, setPreviewVideoSrc] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHistoryLoading(true);
    setHistoryError(null);
    setRunsById({});
    setCasesByRunId({});
    setSelectedRunId(null);

    getTesboTestHistory(projectId, specName, testName)
      .then(async (res) => {
        if (!active) return;
        setHistory(res);
        const firstRun = res.runs[0]?.runId || null;
        setSelectedRunId(firstRun);
        const runsToHydrate = res.runs.slice(0, 40);
        const details = await Promise.all(
          runsToHydrate.map(async (run) => {
            try {
              const detail = await getTesboRun(projectId, run.runId);
              return { runId: run.runId, detail };
            } catch {
              return null;
            }
          })
        );
        if (!active) return;
        const nextRunsById: Record<string, TesboRunDetail> = {};
        const nextCasesByRunId: Record<string, TesboRunCase | null> = {};
        details.forEach((entry) => {
          if (!entry) return;
          nextRunsById[entry.runId] = entry.detail;
          nextCasesByRunId[entry.runId] =
            entry.detail.cases.find((item) => item.specName === specName && item.title === testName) ||
            entry.detail.cases.find((item) => item.title === testName) ||
            null;
        });
        setRunsById(nextRunsById);
        setCasesByRunId(nextCasesByRunId);
      })
      .catch(() => {
        if (!active) return;
        setHistory(null);
        setHistoryError("Unable to load test details.");
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });

    return () => {
      active = false;
    };
  }, [projectId, specName, testName]);

  useEffect(() => {
    if (!selectedRunId || runsById[selectedRunId]) return;
    setSelectedRunLoading(true);
    getTesboRun(projectId, selectedRunId)
      .then((detail) => {
        setRunsById((prev) => ({ ...prev, [selectedRunId]: detail }));
        const matched =
          detail.cases.find((item) => item.specName === specName && item.title === testName) ||
          detail.cases.find((item) => item.title === testName) ||
          null;
        setCasesByRunId((prev) => ({ ...prev, [selectedRunId]: matched }));
      })
      .finally(() => setSelectedRunLoading(false));
  }, [projectId, selectedRunId, runsById, specName, testName]);

  useEffect(() => {
    setIsDetailPopupOpen(false);
    setShowTraceViewer(false);
  }, [selectedRunId]);

  const selectedRun = selectedRunId ? runsById[selectedRunId] || null : null;
  const selectedCase = selectedRunId ? casesByRunId[selectedRunId] || null : null;

  useEffect(() => {
    if (!isDetailPopupOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsDetailPopupOpen(false);
        setShowTraceViewer(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDetailPopupOpen]);

  useEffect(() => {
    if (!isDetailPopupOpen || !selectedCase) {
      setPreviewScreenshotSrc(null);
      setPreviewVideoSrc(null);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }

    let disposed = false;
    let screenshotObjectUrl: string | null = null;
    let videoObjectUrl: string | null = null;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewScreenshotSrc(null);
    setPreviewVideoSrc(null);

    const load = async () => {
      try {
        const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const tasks: Promise<void>[] = [];

        if (selectedCase.screenshotUrl) {
          const absScreenshot = toAbsoluteArtifactUrl(selectedCase.screenshotUrl);
          tasks.push(
            fetch(absScreenshot, { credentials: "include", headers })
              .then(async (res) => {
                if (!res.ok) throw new Error("Screenshot could not be loaded.");
                const blob = await res.blob();
                screenshotObjectUrl = URL.createObjectURL(blob);
                if (!disposed) setPreviewScreenshotSrc(screenshotObjectUrl);
              })
          );
        }

        if (selectedCase.videoUrl) {
          const absVideo = toAbsoluteArtifactUrl(selectedCase.videoUrl);
          tasks.push(
            fetch(absVideo, { credentials: "include", headers })
              .then(async (res) => {
                if (!res.ok) throw new Error("Video could not be loaded.");
                const blob = await res.blob();
                videoObjectUrl = URL.createObjectURL(blob);
                if (!disposed) setPreviewVideoSrc(videoObjectUrl);
              })
          );
        }

        await Promise.all(tasks);
      } catch (err) {
        if (!disposed) {
          setPreviewError(err instanceof Error ? err.message : "Failed to load test artifacts.");
        }
      } finally {
        if (!disposed) setPreviewLoading(false);
      }
    };

    void load();

    return () => {
      disposed = true;
      if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
      if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    };
  }, [isDetailPopupOpen, selectedCase]);

  const screenshotUrl = selectedCase?.screenshotUrl ? toAbsoluteArtifactUrl(selectedCase.screenshotUrl) : null;
  const videoUrl = selectedCase?.videoUrl ? toAbsoluteArtifactUrl(selectedCase.videoUrl) : null;
  const traceUrl = selectedCase?.traceUrl ? toAbsoluteArtifactUrl(selectedCase.traceUrl) : null;
  const traceViewerUrl = traceUrl
    ? `https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`
    : null;

  const totals = useMemo(() => {
    if (!history) {
      return { executions: 0, passed: 0, failed: 0, skipped: 0, flakiness: 0, avgDurationSec: 0 };
    }
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let durationTotalMs = 0;
    let durationCount = 0;
    history.runs.forEach((run) => {
      const caseData = casesByRunId[run.runId];
      const status = (caseData?.status || run.status || "").toUpperCase();
      if (status.includes("PASS")) passed += 1;
      else if (status.includes("FAIL")) failed += 1;
      else skipped += 1;
      if (caseData?.durationMs != null) {
        durationTotalMs += caseData.durationMs;
        durationCount += 1;
      }
    });
    const executions = history.runs.length;
    const flakiness = executions > 0 ? Math.round((failed / executions) * 1000) / 10 : 0;
    const avgDurationSec = durationCount > 0 ? Math.round((durationTotalMs / durationCount) / 10) / 100 : 0;
    return { executions, passed, failed, skipped, flakiness, avgDurationSec };
  }, [casesByRunId, history]);

  const durationChartPoints = useMemo(() => {
    if (!history || history.runs.length === 0) return "";
    const chartRuns = [...history.runs].reverse().slice(-24);
    const values = chartRuns.map((run) => (casesByRunId[run.runId]?.durationMs || 0) / 1000);
    const max = Math.max(1, ...values);
    return values
      .map((value, index) => {
        const x = (index / Math.max(1, values.length - 1)) * 100;
        const y = 100 - (value / max) * 100;
        return `${x},${y}`;
      })
      .join(" ");
  }, [casesByRunId, history]);

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href={`/projects/${projectId}/tesbo-reports/tests`} className="text-xs text-blue-600 hover:underline">
            Back to tests
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100 break-all">{testName || "Test details"}</h1>
          <p className="mt-1 text-sm text-zinc-500 break-all">{specName}</p>
        </div>
      </div>

      <section className="mt-5 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Executions" value={totals.executions} />
          <Stat label="Passed" value={totals.passed} tone="text-emerald-600" />
          <Stat label="Failed" value={totals.failed} tone="text-rose-600" />
          <Stat label="Skipped" value={totals.skipped} tone="text-amber-600" />
          <Stat label="Flakiness" value={`${totals.flakiness}%`} />
          <Stat label="Avg duration" value={`${totals.avgDurationSec}s`} />
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Execution history</h2>
          {historyLoading ? (
            <p className="mt-3 text-sm text-zinc-500">Loading history...</p>
          ) : historyError ? (
            <p className="mt-3 text-sm text-rose-600">{historyError}</p>
          ) : !history || history.runs.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No executions found for this test.</p>
          ) : (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {history.runs.map((run) => {
                const status = (casesByRunId[run.runId]?.status || run.status || "Unknown").toUpperCase();
                const dotClass = status.includes("PASS")
                  ? "bg-emerald-500"
                  : status.includes("FAIL")
                  ? "bg-rose-500"
                  : "bg-amber-400";
                return (
                  <button
                    key={run.runId}
                    type="button"
                    title={`${run.runName} - ${status}`}
                    onClick={() => setSelectedRunId(run.runId)}
                    className={`h-5 w-5 rounded-full ${dotClass} ${selectedRunId === run.runId ? "ring-2 ring-blue-500 ring-offset-1" : ""}`}
                  />
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Duration trend (seconds)</h2>
          {!history || history.runs.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No duration data available.</p>
          ) : (
            <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-700 p-3">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-36 w-full">
                <polyline fill="none" stroke="rgb(34 197 94)" strokeWidth="2" points={durationChartPoints} />
              </svg>
            </div>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Run history</h2>
          <div className="mt-3 space-y-2 max-h-[60vh] overflow-auto pr-1">
            {(history?.runs || []).map((run) => (
              <button
                key={run.runId}
                type="button"
                onClick={() => setSelectedRunId(run.runId)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  selectedRunId === run.runId
                    ? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
                    : "border-zinc-200 dark:border-zinc-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate">{run.runName}</p>
                  <span className="text-xs text-zinc-500">{casesByRunId[run.runId]?.status || run.status}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {run.executedAt ? new Date(run.executedAt).toLocaleString() : "No timestamp"}
                </p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Selected run details</h2>
          {selectedRunLoading ? (
            <p className="mt-3 text-sm text-zinc-500">Loading selected run...</p>
          ) : !selectedRun ? (
            <p className="mt-3 text-sm text-zinc-500">Select a run from history.</p>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2">
                <p><span className="text-zinc-500">Run:</span> {selectedRun.name}</p>
                <p><span className="text-zinc-500">Status:</span> {selectedRun.status}</p>
                <p><span className="text-zinc-500">Started:</span> {selectedRun.startedAt ? new Date(selectedRun.startedAt).toLocaleString() : "-"}</p>
                <Link className="mt-2 inline-block text-blue-600 hover:underline" href={`/projects/${projectId}/tesbo-reports/runs/${selectedRun.id}`}>
                  Open full run page
                </Link>
              </div>
              {selectedCase ? (
                <>
                  <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2">
                    <p><span className="text-zinc-500">Duration:</span> {((selectedCase.durationMs || 0) / 1000).toFixed(2)}s</p>
                    <p><span className="text-zinc-500">Attempt:</span> {selectedCase.attempt != null ? selectedCase.attempt + 1 : "-"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setIsDetailPopupOpen(true)}
                        className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/20"
                      >
                        Open test details popup
                      </button>
                    </div>
                  </div>
                  {(selectedCase.errorMessage || selectedCase.errorStack) && (
                    <div className="rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-900/20 p-2">
                      {selectedCase.errorMessage && <p className="text-rose-700">{selectedCase.errorMessage}</p>}
                      {selectedCase.errorStack && (
                        <pre className="mt-2 whitespace-pre-wrap text-xs max-h-48 overflow-y-auto">{selectedCase.errorStack}</pre>
                      )}
                    </div>
                  )}
                  <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2">
                    <p className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Steps</p>
                    <div className="mt-2 space-y-1.5">
                      {(selectedCase.steps || []).map((step, idx) => (
                        <div key={idx} className="rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1">
                          <span className="text-xs text-zinc-500">#{idx + 1}</span> {step.description || "Step"}
                        </div>
                      ))}
                      {(!selectedCase.steps || selectedCase.steps.length === 0) && (
                        <p className="text-zinc-500">No steps captured for this run.</p>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-zinc-500">Test-level details unavailable for this run.</p>
              )}
            </div>
          )}
        </section>
      </div>

      {isDetailPopupOpen && selectedCase && (
        <div className="fixed inset-0 z-50 bg-black/55" role="dialog" aria-modal="true" aria-label="Test details popup">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            aria-label="Close test details popup"
            onClick={() => {
              setIsDetailPopupOpen(false);
              setShowTraceViewer(false);
            }}
          />
          <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-5xl p-4 md:p-8">
              <div className="relative space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Test details</p>
                    <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-all">{selectedCase.title}</h3>
                    <p className="text-xs text-zinc-500 break-all">{selectedCase.specName || "Unspecified spec"}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsDetailPopupOpen(false);
                      setShowTraceViewer(false);
                    }}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                  >
                    Close
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Status" value={selectedCase.status} />
                  <Stat label="Duration" value={`${((selectedCase.durationMs || 0) / 1000).toFixed(2)}s`} />
                  <Stat label="Attempt" value={selectedCase.attempt != null ? selectedCase.attempt + 1 : "-"} />
                  <Stat label="Browser" value={selectedCase.browserName || "-"} />
                </div>

                <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Artifacts</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    {traceViewerUrl && (
                      <>
                        <button
                          type="button"
                          onClick={() => setShowTraceViewer((prev) => !prev)}
                          className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                        >
                          {showTraceViewer ? "Hide trace viewer" : "Watch trace"}
                        </button>
                        <a
                          className="text-blue-600 hover:underline"
                          href={traceViewerUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open trace in new tab
                        </a>
                      </>
                    )}
                    {screenshotUrl && (
                      <a className="text-blue-600 hover:underline" href={screenshotUrl} target="_blank" rel="noreferrer">
                        Open screenshot
                      </a>
                    )}
                    {videoUrl && (
                      <a className="text-blue-600 hover:underline" href={videoUrl} target="_blank" rel="noreferrer">
                        Open video
                      </a>
                    )}
                    {!traceViewerUrl && !screenshotUrl && !videoUrl && (
                      <span className="text-zinc-500">No artifacts available for this test case.</span>
                    )}
                  </div>
                  {previewLoading && (screenshotUrl || videoUrl) && (
                    <p className="mt-2 text-xs text-zinc-500">Loading screenshot/video preview...</p>
                  )}
                  {previewError && <p className="mt-2 text-xs text-rose-600">{previewError}</p>}
                </div>

                {showTraceViewer && traceViewerUrl && (
                  <div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Trace viewer</p>
                    <iframe
                      key={traceViewerUrl}
                      src={traceViewerUrl}
                      title={`Trace viewer for ${selectedCase.title}`}
                      className="h-[60vh] w-full rounded border"
                      loading="lazy"
                      allowFullScreen
                    />
                  </div>
                )}

                {screenshotUrl && (
                  <div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Screenshot</p>
                    <div className="mt-2 relative overflow-hidden rounded border border-zinc-200 p-2 dark:border-zinc-700">
                      {previewScreenshotSrc ? (
                        <img
                          src={previewScreenshotSrc}
                          alt={`Screenshot for ${selectedCase.title}`}
                          className="h-auto max-h-[50vh] w-full object-contain"
                        />
                      ) : (
                        <p className="text-xs text-zinc-500">Screenshot preview unavailable.</p>
                      )}
                    </div>
                  </div>
                )}

                {videoUrl && (
                  <div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Video</p>
                    <div className="mt-2 overflow-hidden rounded border border-zinc-200 p-2 dark:border-zinc-700">
                      {previewVideoSrc ? (
                        <video src={previewVideoSrc} controls preload="metadata" className="w-full rounded bg-black">
                          Your browser does not support the video tag.
                        </video>
                      ) : (
                        <p className="text-xs text-zinc-500">Video preview unavailable.</p>
                      )}
                    </div>
                  </div>
                )}

                {(selectedCase.errorMessage || selectedCase.errorStack) && (
                  <div className="rounded-lg border border-rose-300 bg-rose-50 p-2 dark:bg-rose-900/20">
                    {selectedCase.errorMessage && <p className="text-rose-700">{selectedCase.errorMessage}</p>}
                    {selectedCase.errorStack && (
                      <pre className="mt-2 whitespace-pre-wrap text-xs max-h-48 overflow-y-auto">{selectedCase.errorStack}</pre>
                    )}
                  </div>
                )}

                <div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
                  <p className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Steps</p>
                  <div className="mt-2 space-y-1.5">
                    {(selectedCase.steps || []).map((step, idx) => (
                      <div key={idx} className="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-700">
                        <span className="text-xs text-zinc-500">#{idx + 1}</span> {step.description || "Step"}
                      </div>
                    ))}
                    {(!selectedCase.steps || selectedCase.steps.length === 0) && (
                      <p className="text-zinc-500">No steps captured for this run.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 bg-white dark:bg-zinc-900">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${tone || "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
    </div>
  );
}

function toAbsoluteArtifactUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}
