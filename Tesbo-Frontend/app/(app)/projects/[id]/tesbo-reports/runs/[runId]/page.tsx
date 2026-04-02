"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  createTesboRunShare,
  disableTesboRunShare,
  getTesboRun,
  getTesboRunShare,
  type TesboRunCase,
  type TesboRunDetail,
  type TesboShareState,
} from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7000";

export default function TesboRunDetailPage() {
  const params = useParams();
  const projectId = params.id as string;
  const runId = params.runId as string;

  const [run, setRun] = useState<TesboRunDetail | null>(null);
  const [shareState, setShareState] = useState<TesboShareState | null>(null);
  const [loading, setLoading] = useState(true);
  const [caseFilter, setCaseFilter] = useState<"ALL" | "Passed" | "Failed" | "Skipped">("ALL");
  const [caseSearch, setCaseSearch] = useState("");
  const [caseDrawerId, setCaseDrawerId] = useState<string | null>(null);
  const [openSpecs, setOpenSpecs] = useState<Record<string, boolean>>({});
  const [previewScreenshotSrc, setPreviewScreenshotSrc] = useState<string | null>(null);
  const [previewVideoSrc, setPreviewVideoSrc] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showTraceViewer, setShowTraceViewer] = useState(false);

  useEffect(() => {
    setLoading(true);
    getTesboRun(projectId, runId)
      .then((runRes) => {
        setRun(runRes);
        return getTesboRunShare(projectId, runId).then(setShareState).catch(() => {
          setShareState({ enabled: false, token: null, publicUrl: null });
        });
      })
      .catch(() => {
        setRun(null);
        setShareState(null);
      })
      .finally(() => setLoading(false));
  }, [projectId, runId]);

  const filteredCases = useMemo(() => {
    if (!run) return [];
    const term = caseSearch.trim().toLowerCase();
    return run.cases.filter((item) => {
      const matchesStatus = caseFilter === "ALL" ? true : item.status === caseFilter;
      const matchesSearch =
        term.length === 0 ||
        [item.title, item.fullTitle, item.specName, item.errorMessage].filter(Boolean).some((v) => String(v).toLowerCase().includes(term));
      return matchesStatus && matchesSearch;
    });
  }, [caseFilter, caseSearch, run]);

  const groupedCases = useMemo(() => {
    const buckets: Record<string, typeof filteredCases> = {};
    filteredCases.forEach((item) => {
      const key = item.specName || "Unspecified spec";
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(item);
    });
    return Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([specName, cases]) => ({ specName, cases }));
  }, [filteredCases]);

  const specBreakdown = useMemo(() => {
    if (!run) return [] as { specName: string; total: number; passed: number; failed: number; skipped: number }[];
    const bySpec = new Map<string, { specName: string; total: number; passed: number; failed: number; skipped: number }>();
    run.cases.forEach((item) => {
      const specName = item.specName || "Unspecified spec";
      const current = bySpec.get(specName) || { specName, total: 0, passed: 0, failed: 0, skipped: 0 };
      current.total += 1;
      if (item.status === "Passed") current.passed += 1;
      if (item.status === "Failed") current.failed += 1;
      if (item.status === "Skipped") current.skipped += 1;
      bySpec.set(specName, current);
    });
    return Array.from(bySpec.values()).sort((a, b) => {
      if (b.failed !== a.failed) return b.failed - a.failed;
      return a.specName.localeCompare(b.specName);
    });
  }, [run]);

  const passRate = useMemo(() => {
    if (!run || run.total === 0) return 0;
    return Math.round((run.passed / run.total) * 1000) / 10;
  }, [run]);

  const avgDurationMs = useMemo(() => {
    if (!run || run.cases.length === 0) return 0;
    const total = run.cases.reduce((sum, item) => sum + (item.durationMs || 0), 0);
    return Math.round(total / run.cases.length);
  }, [run]);

  useEffect(() => {
    if (!run) return;
    setOpenSpecs((prev) => {
      const next = { ...prev };
      groupedCases.forEach((g) => {
        if (next[g.specName] === undefined) next[g.specName] = true;
      });
      return next;
    });
  }, [groupedCases, run]);

  const activeCase: TesboRunCase | null = useMemo(
    () => filteredCases.find((item) => item.caseId === caseDrawerId) ?? null,
    [caseDrawerId, filteredCases]
  );
  const activeCaseIndex = activeCase ? filteredCases.findIndex((item) => item.caseId === activeCase.caseId) : -1;

  useEffect(() => {
    if (!activeCase) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCaseDrawerId(null);
        return;
      }
      if (event.key === "ArrowLeft" && activeCaseIndex > 0) {
        setCaseDrawerId(filteredCases[activeCaseIndex - 1]?.caseId ?? null);
        return;
      }
      if (event.key === "ArrowRight" && activeCaseIndex >= 0 && activeCaseIndex < filteredCases.length - 1) {
        setCaseDrawerId(filteredCases[activeCaseIndex + 1]?.caseId ?? null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCase, activeCaseIndex, filteredCases]);

  useEffect(() => {
    if (!activeCase) {
      setPreviewScreenshotSrc(null);
      setPreviewVideoSrc(null);
      setPreviewLoading(false);
      setPreviewError(null);
      setShowTraceViewer(false);
      return;
    }

    let disposed = false;
    let screenshotObjectUrl: string | null = null;
    let videoObjectUrl: string | null = null;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewScreenshotSrc(null);
    setPreviewVideoSrc(null);
    setShowTraceViewer(Boolean(activeCase.traceUrl));

    const loadPreviews = async () => {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const jobs: Promise<void>[] = [];

      if (activeCase.screenshotUrl) {
        const screenshotUrl = toAbsoluteArtifactUrl(activeCase.screenshotUrl);
        jobs.push(
          fetch(screenshotUrl, { credentials: "include", headers })
            .then(async (res) => {
              if (!res.ok) {
                if (!disposed) setPreviewScreenshotSrc(screenshotUrl);
                return;
              }
              const blob = await res.blob();
              screenshotObjectUrl = URL.createObjectURL(blob);
              if (!disposed) setPreviewScreenshotSrc(screenshotObjectUrl);
            })
            .catch(() => {
              if (!disposed) setPreviewScreenshotSrc(screenshotUrl);
            })
        );
      }

      if (activeCase.videoUrl) {
        const videoUrl = toAbsoluteArtifactUrl(activeCase.videoUrl);
        jobs.push(
          fetch(videoUrl, { credentials: "include", headers })
            .then(async (res) => {
              if (!res.ok) {
                if (!disposed) setPreviewVideoSrc(videoUrl);
                return;
              }
              const blob = await res.blob();
              videoObjectUrl = URL.createObjectURL(blob);
              if (!disposed) setPreviewVideoSrc(videoObjectUrl);
            })
            .catch(() => {
              if (!disposed) setPreviewVideoSrc(videoUrl);
            })
        );
      }

      try {
        await Promise.all(jobs);
      } catch {
        if (!disposed) setPreviewError("Some artifacts could not be loaded.");
      } finally {
        if (!disposed) setPreviewLoading(false);
      }
    };

    void loadPreviews();

    return () => {
      disposed = true;
      if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
      if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    };
  }, [activeCase]);

  if (loading) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-8">
        <p className="text-sm text-[var(--muted)]">Loading run details...</p>
      </main>
    );
  }

  if (!run) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-8">
        <p className="text-sm text-[var(--muted)]">Run not found.</p>
      </main>
    );
  }

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Tesbo Run</p>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--foreground)]">{run.name}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {run.startedAt ? new Date(run.startedAt).toLocaleString() : "No start time"} · {run.sourceType || "Unknown source"}
          </p>
        </div>
        <Link href={`/projects/${projectId}/tesbo-reports/runs`} className="text-sm text-[var(--brand-primary)] hover:underline">
          Back to Runs
        </Link>
      </div>

      <section className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Test run overview</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">Snapshot of the run health and execution quality.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => createTesboRunShare(projectId, run.id).then((state) => setShareState(state))}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium"
            >
              Create Share Link
            </button>
            <button
              type="button"
              onClick={() => disableTesboRunShare(projectId, run.id).then(() => setShareState({ enabled: false, token: null, publicUrl: null }))}
              className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600"
            >
              Disable Share
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label="Status" value={run.status} />
          <Stat label="Total tests" value={run.total} />
          <Stat label="Pass rate" value={`${passRate}%`} />
          <Stat label="Specs" value={specBreakdown.length} />
          <Stat label="Avg duration" value={`${(avgDurationMs / 1000).toFixed(1)}s`} />
          <Stat label="Failed" value={run.failed} tone="text-rose-600" />
        </div>

        {shareState?.publicUrl && (
          <p className="mt-4 text-xs text-[var(--muted)] break-all">
            Public URL:{" "}
            <a className="text-[var(--brand-primary)] hover:underline" href={shareState.publicUrl}>
              {shareState.publicUrl}
            </a>
          </p>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div>
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Pass vs fail by spec</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">Failure-heavy specs surface first for quicker triage.</p>
        </div>
        <div className="mt-4 space-y-3">
          {specBreakdown.map((spec) => {
            const passWidth = spec.total > 0 ? (spec.passed / spec.total) * 100 : 0;
            const failWidth = spec.total > 0 ? (spec.failed / spec.total) * 100 : 0;
            const skipWidth = Math.max(0, 100 - passWidth - failWidth);
            return (
              <div key={spec.specName}>
                <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                  <p className="font-medium text-[var(--muted)] break-all">{spec.specName}</p>
                  <p className="text-[var(--muted)]">
                    {spec.passed} passed · {spec.failed} failed · {spec.skipped} skipped
                  </p>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)] border border-[var(--border)]">
                  <div className="h-full bg-emerald-500 float-left" style={{ width: `${passWidth}%` }} />
                  <div className="h-full bg-rose-500 float-left" style={{ width: `${failWidth}%` }} />
                  <div className="h-full bg-amber-400 float-left" style={{ width: `${skipWidth}%` }} />
                </div>
              </div>
            );
          })}
          {specBreakdown.length === 0 && <p className="text-sm text-[var(--muted)]">No spec-level data available.</p>}
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Deep dive results</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">Inspect each spec and open a test for full failure context.</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {(["ALL", "Passed", "Failed", "Skipped"] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setCaseFilter(status)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  caseFilter === status
                    ? "border-blue-400 bg-blue-50 text-blue-700"
                    : "border-[var(--border)] text-[var(--muted)]"
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <input
            type="text"
            value={caseSearch}
            onChange={(event) => setCaseSearch(event.target.value)}
            placeholder="Search test, spec, error"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          />
        </div>

        <div className="mt-4 space-y-3">
          {groupedCases.map((group) => (
            <div key={group.specName} className="rounded-xl border border-[var(--border)] overflow-hidden">
              <button
                type="button"
                className="w-full flex items-center justify-between bg-[var(--surface-secondary)] px-3 py-2.5 text-left"
                onClick={() => setOpenSpecs((prev) => ({ ...prev, [group.specName]: !prev[group.specName] }))}
              >
                <span className="font-medium text-sm text-[var(--foreground)] break-all">{group.specName}</span>
                <span className="text-xs text-[var(--muted)]">{group.cases.length} tests</span>
              </button>
              {(openSpecs[group.specName] ?? true) && (
                <div className="divide-y divide-[var(--border-subtle)]">
                  {group.cases.map((item) => (
                    <div
                      key={item.caseId}
                      role="button"
                      tabIndex={0}
                      onClick={() => setCaseDrawerId(item.caseId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setCaseDrawerId(item.caseId);
                        }
                      }}
                      className="px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--surface-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[var(--foreground)] truncate">{item.title}</p>
                        <p className="text-xs text-[var(--muted)]">
                          {(item.durationMs ?? 0) / 1000}s {item.attempt != null ? `· Attempt ${item.attempt + 1}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            item.status === "Passed"
                              ? "bg-emerald-100 text-emerald-700"
                              : item.status === "Failed"
                              ? "bg-rose-100 text-rose-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {item.status}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setCaseDrawerId(item.caseId);
                          }}
                          className="rounded border border-[var(--border)] px-2 py-1 text-xs"
                        >
                          View result
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {groupedCases.length === 0 && <p className="text-sm text-[var(--muted)]">No test cases match current filters.</p>}
        </div>
      </section>

      {activeCase && (
        <div className="fixed inset-0 z-50 bg-black/55">
          <div className="absolute inset-0 overflow-y-auto">
            <div className="min-h-full w-full p-0">
              <div className="min-h-screen w-full border-0 bg-[var(--surface)] p-4 space-y-4 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Test details</p>
                    <h3 className="text-xl font-semibold text-[var(--foreground)]">{activeCase.title}</h3>
                    <p className="text-xs text-[var(--muted)]">{activeCase.specName || "Unspecified spec"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={activeCaseIndex <= 0}
                      onClick={() => setCaseDrawerId(filteredCases[activeCaseIndex - 1]?.caseId ?? null)}
                      className="rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      disabled={activeCaseIndex < 0 || activeCaseIndex >= filteredCases.length - 1}
                      onClick={() => setCaseDrawerId(filteredCases[activeCaseIndex + 1]?.caseId ?? null)}
                      className="rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
                    >
                      Next
                    </button>
                    <button
                      type="button"
                      onClick={() => setCaseDrawerId(null)}
                      className="rounded border border-[var(--border)] px-2 py-1 text-xs"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="Status" value={activeCase.status} />
                  <Stat label="Duration" value={`${((activeCase.durationMs ?? 0) / 1000).toFixed(2)}s`} />
                  <Stat label="Attempt" value={activeCase.attempt != null ? String(activeCase.attempt + 1) : "-"} />
                  <Stat label="Browser" value={activeCase.browserName || "-"} />
                </div>

                <div className="rounded-xl border border-[var(--border)] p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Artifacts</p>
                  <div className="mt-2 flex flex-wrap gap-3 text-sm">
                    {activeCase.traceUrl && (
                      <>
                        <button
                          type="button"
                          onClick={() => setShowTraceViewer((prev) => !prev)}
                          className="rounded border border-[var(--border)] px-2 py-1 text-xs"
                        >
                          {showTraceViewer ? "Hide trace viewer" : "Watch trace"}
                        </button>
                        <a className="text-[var(--brand-primary)] hover:underline" href={toAbsoluteArtifactUrl(activeCase.traceUrl)} target="_blank" rel="noreferrer">
                          Open trace file
                        </a>
                      </>
                    )}
                    {activeCase.screenshotUrl && (
                      <a className="text-[var(--brand-primary)] hover:underline" href={toAbsoluteArtifactUrl(activeCase.screenshotUrl)} target="_blank" rel="noreferrer">
                        Screenshot
                      </a>
                    )}
                    {activeCase.videoUrl && (
                      <a className="text-[var(--brand-primary)] hover:underline" href={toAbsoluteArtifactUrl(activeCase.videoUrl)} target="_blank" rel="noreferrer">
                        Video
                      </a>
                    )}
                    {!activeCase.traceUrl && !activeCase.screenshotUrl && !activeCase.videoUrl && (
                      <span className="text-[var(--muted)]">No artifacts available for this test case.</span>
                    )}
                  </div>
                  {previewLoading && (activeCase.screenshotUrl || activeCase.videoUrl) && (
                    <p className="mt-2 text-xs text-[var(--muted)]">Loading screenshot/video preview...</p>
                  )}
                  {previewError && <p className="mt-2 text-xs text-rose-600">{previewError}</p>}
                </div>

                {showTraceViewer && activeCase.traceUrl && (
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Trace viewer</p>
                    <iframe
                      src={`https://trace.playwright.dev/?trace=${encodeURIComponent(toAbsoluteArtifactUrl(activeCase.traceUrl))}`}
                      title={`Trace viewer for ${activeCase.title}`}
                      className="mt-2 h-[55vh] w-full rounded border border-[var(--border)]"
                      loading="lazy"
                      allowFullScreen
                    />
                  </div>
                )}

                {activeCase.screenshotUrl && previewScreenshotSrc && (
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Screenshot</p>
                    <div className="mt-2 overflow-hidden rounded border border-[var(--border)] p-2">
                      <img
                        src={previewScreenshotSrc}
                        alt={`Screenshot for ${activeCase.title}`}
                        className="h-auto max-h-[45vh] w-full object-contain"
                      />
                    </div>
                  </div>
                )}

                {activeCase.videoUrl && previewVideoSrc && (
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Video</p>
                    <div className="mt-2 overflow-hidden rounded border border-[var(--border)] p-2">
                      <video src={previewVideoSrc} controls preload="metadata" className="w-full rounded bg-black">
                        Your browser does not support the video tag.
                      </video>
                    </div>
                  </div>
                )}

                {(activeCase.errorMessage || activeCase.errorStack) && (
                  <div className="rounded-xl border border-rose-300 bg-rose-50 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-rose-700">Failure details</p>
                    {activeCase.errorMessage && <p className="mt-2 text-sm text-rose-700">{activeCase.errorMessage}</p>}
                    {activeCase.errorStack && <pre className="mt-2 whitespace-pre-wrap text-xs text-rose-800 max-h-56 overflow-y-auto">{activeCase.errorStack}</pre>}
                  </div>
                )}

                <div className="rounded-xl border border-[var(--border)] p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Steps</p>
                  <div className="mt-2 space-y-2">
                    {(activeCase.steps || []).map((step, index) => (
                      <div key={`step-${index}`} className="rounded border border-[var(--border)] px-3 py-2 text-sm">
                        <span className="text-xs text-[var(--muted)]">#{index + 1}</span> {step.description || "Step"}
                      </div>
                    ))}
                    {(!activeCase.steps || activeCase.steps.length === 0) && <p className="text-sm text-[var(--muted)]">No steps captured for this test case.</p>}
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
    <div className="rounded-lg border border-[var(--border)] p-3 bg-[var(--surface)]">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${tone || "text-[var(--foreground)]"}`}>{value}</p>
    </div>
  );
}

function toAbsoluteArtifactUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const parsed = new URL(url);
      // Some deployments store absolute artifact URLs on a backend-only host.
      // When the same path is exposed via the current app host, prefer it so
      // browser viewers (including Playwright trace viewer) can load artifacts.
      if (typeof window !== "undefined") {
        const backendOnlyHost = parsed.hostname.toLowerCase().includes("backdoor");
        const likelyPublicArtifactPath = parsed.pathname.startsWith("/app/artifacts/");
        if ((backendOnlyHost || likelyPublicArtifactPath) && parsed.origin !== window.location.origin) {
          return `${window.location.origin}${parsed.pathname}${parsed.search}`;
        }
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}
