"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getTesboRun, getTesboSpec, getTesboTestHistory, type TesboRunCase, type TesboRunDetail, type TesboSpecDetail } from "@/lib/api";

type History = {
  specName: string;
  testName: string;
  runs: { runId: string; runName: string; status: string; executedAt: string | null }[];
};

export default function TesboSpecDetailPage() {
  const params = useParams();
  const projectId = params.id as string;
  const rawSpec = params.spec;
  const specName = Array.isArray(rawSpec)
    ? rawSpec.map((segment) => decodeURIComponent(segment)).join("/")
    : decodeURIComponent(String(rawSpec || ""));

  const [detail, setDetail] = useState<TesboSpecDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PASSED" | "FAILED" | "SKIPPED">("ALL");
  const [page, setPage] = useState(1);
  const pageSize = 14;
  const [history, setHistory] = useState<History | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<TesboRunDetail | null>(null);
  const [runLoading, setRunLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getTesboSpec(projectId, specName)
      .then((res) => setDetail(res))
      .catch(() => {
        setDetail(null);
        setError("Unable to load this spec.");
      })
      .finally(() => setLoading(false));
  }, [projectId, specName]);

  const filteredTests = useMemo(() => {
    if (!detail) return [];
    const term = search.trim().toLowerCase();
    return detail.tests.filter((test) => {
      const status = (test.latestStatus || "").toUpperCase();
      const matchesSearch = term.length === 0 || test.testName.toLowerCase().includes(term);
      const matchesStatus =
        statusFilter === "ALL"
          ? true
          : statusFilter === "PASSED"
          ? status.includes("PASS")
          : statusFilter === "FAILED"
          ? status.includes("FAIL")
          : status.includes("SKIP");
      return matchesSearch && matchesStatus;
    });
  }, [detail, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredTests.length / pageSize));
  const paginatedTests = filteredTests.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, detail?.tests.length]);

  const totals = useMemo(() => {
    if (!detail) {
      return { runs: 0, passed: 0, failed: 0, skipped: 0, unstable: 0, passRate: 0 };
    }
    const runs = detail.tests.reduce((sum, item) => sum + item.totalRuns, 0);
    const passed = detail.tests.reduce((sum, item) => sum + item.passed, 0);
    const failed = detail.tests.reduce((sum, item) => sum + item.failed, 0);
    const skipped = detail.tests.reduce((sum, item) => sum + item.skipped, 0);
    const unstable = detail.tests.filter((item) => item.failed > 0).length;
    const passRate = runs > 0 ? Math.round((passed / runs) * 1000) / 10 : 0;
    return { runs, passed, failed, skipped, unstable, passRate };
  }, [detail]);

  const openHistory = useCallback(async (testName: string) => {
    setHistoryLoading(true);
    try {
      const response = await getTesboTestHistory(projectId, specName, testName);
      setHistory(response);
      if (response.runs[0]?.runId) {
        setActiveRunId(response.runs[0].runId);
      } else {
        setActiveRunId(null);
        setActiveRun(null);
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [projectId, specName]);

  const closeModal = useCallback(() => {
    setHistory(null);
    setActiveRunId(null);
    setActiveRun(null);
  }, []);

  useEffect(() => {
    if (!history || !activeRunId) return;
    setRunLoading(true);
    getTesboRun(projectId, activeRunId)
      .then((run) => setActiveRun(run))
      .catch(() => setActiveRun(null))
      .finally(() => setRunLoading(false));
  }, [activeRunId, history, projectId]);

  useEffect(() => {
    if (!history) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [history, closeModal]);

  const activeCase: TesboRunCase | null = useMemo(() => {
    if (!history || !activeRun) return null;
    return (
      activeRun.cases.find((item) => item.specName === history.specName && item.title === history.testName) ||
      activeRun.cases.find((item) => item.title === history.testName) ||
      null
    );
  }, [activeRun, history]);

  const topFlakyTests = useMemo(() => {
    if (!detail) return [];
    return [...detail.tests]
      .map((item) => ({
        ...item,
        flakiness: item.totalRuns > 0 ? Math.round((item.failed / item.totalRuns) * 1000) / 10 : 0,
      }))
      .sort((a, b) => {
        if (b.flakiness !== a.flakiness) return b.flakiness - a.flakiness;
        return b.failed - a.failed;
      })
      .slice(0, 8);
  }, [detail]);

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Tesbo Spec</p>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 break-all">{specName}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Dedicated spec details with run quality, flakiness, and test history.
          </p>
        </div>
        <Link href={`/projects/${projectId}/tesbo-reports/specs`} className="text-sm text-blue-600 hover:underline">
          Back to Specs
        </Link>
      </div>

      <section className="mt-6 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Total tests" value={detail?.tests.length ?? 0} />
          <StatCard label="Total runs" value={totals.runs} />
          <StatCard label="Pass rate" value={`${totals.passRate}%`} tone="text-emerald-600" />
          <StatCard label="Failed runs" value={totals.failed} tone="text-rose-600" />
          <StatCard label="Unstable tests" value={totals.unstable} tone="text-amber-600" />
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Pass/fail by test</h2>
          {loading ? (
            <p className="mt-3 text-sm text-zinc-500">Loading tests...</p>
          ) : detail && detail.tests.length > 0 ? (
            <div className="mt-4 space-y-3 max-h-[350px] overflow-auto pr-1">
              {detail.tests.slice(0, 20).map((test) => {
                const total = Math.max(1, test.totalRuns);
                const pass = (test.passed / total) * 100;
                const fail = (test.failed / total) * 100;
                const skip = Math.max(0, 100 - pass - fail);
                return (
                  <div key={test.testName}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <p className="font-medium text-zinc-700 dark:text-zinc-300 truncate">{test.testName}</p>
                      <p className="text-zinc-500">
                        {test.passed} / {test.failed} / {test.skipped}
                      </p>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                      <div className="h-full bg-emerald-500 float-left" style={{ width: `${pass}%` }} />
                      <div className="h-full bg-rose-500 float-left" style={{ width: `${fail}%` }} />
                      <div className="h-full bg-amber-400 float-left" style={{ width: `${skip}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">No tests found for this spec.</p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Most flaky tests</h2>
          {loading ? (
            <p className="mt-3 text-sm text-zinc-500">Loading flaky list...</p>
          ) : topFlakyTests.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No flaky tests detected.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {topFlakyTests.map((test) => (
                <div
                  key={test.testName}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm flex items-center justify-between gap-2"
                >
                  <p className="truncate">{test.testName}</p>
                  <span className="text-xs text-rose-600">{test.flakiness}% flaky</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="mt-4 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Tests in this spec</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Open any test to inspect run-by-run history.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setError(null);
              getTesboSpec(projectId, specName)
                .then((res) => setDetail(res))
                .catch(() => setError("Unable to refresh this spec."))
                .finally(() => setLoading(false));
            }}
            className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-xs"
          >
            Refresh
          </button>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-12">
          <div className="md:col-span-8">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tests in this spec"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
            />
          </div>
          <div className="md:col-span-4 flex justify-end">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as "ALL" | "PASSED" | "FAILED" | "SKIPPED")}
              className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
            >
              <option value="ALL">All status</option>
              <option value="PASSED">Passed</option>
              <option value="FAILED">Failed</option>
              <option value="SKIPPED">Skipped</option>
            </select>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-x-auto">
          <table className="min-w-[900px] w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Test</th>
                <th className="text-right px-4 py-3 font-medium">Runs</th>
                <th className="text-right px-4 py-3 font-medium">Passed</th>
                <th className="text-right px-4 py-3 font-medium">Failed</th>
                <th className="text-right px-4 py-3 font-medium">Skipped</th>
                <th className="text-right px-4 py-3 font-medium">Flakiness</th>
                <th className="text-left px-4 py-3 font-medium">Latest</th>
                <th className="text-right px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">Loading tests...</td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-rose-600">{error}</td>
                </tr>
              ) : paginatedTests.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">No tests match the current filters.</td>
                </tr>
              ) : (
                paginatedTests.map((test) => {
                  const flakiness = test.totalRuns > 0 ? Math.round((test.failed / test.totalRuns) * 1000) / 10 : 0;
                  return (
                    <tr key={test.testName} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-3 max-w-[320px]">
                        <p className="break-all">{test.testName}</p>
                      </td>
                      <td className="px-4 py-3 text-right">{test.totalRuns}</td>
                      <td className="px-4 py-3 text-right text-emerald-600">{test.passed}</td>
                      <td className="px-4 py-3 text-right text-rose-600">{test.failed}</td>
                      <td className="px-4 py-3 text-right text-amber-600">{test.skipped}</td>
                      <td className="px-4 py-3 text-right">{flakiness}%</td>
                      <td className="px-4 py-3">
                        <StatusPill status={test.latestStatus} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openHistory(test.testName).catch(() => {})}
                          className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs"
                        >
                          View history
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <button
            type="button"
            className="rounded-full border border-zinc-300 dark:border-zinc-600 px-3 py-1 disabled:opacity-50"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page === 1}
          >
            Prev
          </button>
          <span>Page {page} / {totalPages}</span>
          <button
            type="button"
            className="rounded-full border border-zinc-300 dark:border-zinc-600 px-3 py-1 disabled:opacity-50"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page === totalPages}
          >
            Next
          </button>
        </div>
      </section>

      {history && (
        <div className="fixed inset-0 z-50 bg-black/55">
          <div className="h-full w-full overflow-y-auto p-2 md:p-4">
            <div className="h-full w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 md:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Test history</p>
                  <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-all">{history.testName}</h3>
                  <p className="text-sm text-zinc-500 break-all">{history.specName}</p>
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs"
                >
                  Close
                </button>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Run history</p>
                  {historyLoading ? (
                    <p className="mt-3 text-sm text-zinc-500">Loading history...</p>
                  ) : (
                    <ul className="mt-3 space-y-2 max-h-[70vh] overflow-auto pr-1">
                      {history.runs.map((run) => (
                        <li key={`${run.runId}-${run.executedAt}`}>
                          <div
                            className={`w-full rounded border px-3 py-2 text-left text-sm ${
                              activeRunId === run.runId
                                ? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
                                : "border-zinc-200 dark:border-zinc-700"
                            }`}
                          >
                            <button type="button" onClick={() => setActiveRunId(run.runId)} className="w-full text-left">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate">{run.runName}</span>
                                <span>{run.status}</span>
                              </div>
                              <p className="mt-1 text-xs text-zinc-500">
                                {run.executedAt ? new Date(run.executedAt).toLocaleString() : "No timestamp"}
                              </p>
                            </button>
                            <Link
                              href={`/projects/${projectId}/tesbo-reports/runs/${run.runId}`}
                              className="mt-2 inline-block text-xs text-blue-600 hover:underline"
                            >
                              Open run details
                            </Link>
                          </div>
                        </li>
                      ))}
                      {history.runs.length === 0 && <li className="text-sm text-zinc-500">No history entries.</li>}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Selected run details</p>
                  {runLoading ? (
                    <p className="mt-3 text-sm text-zinc-500">Loading run details...</p>
                  ) : !activeRun ? (
                    <p className="mt-3 text-sm text-zinc-500">Select a run from history.</p>
                  ) : (
                    <div className="mt-3 space-y-3 text-sm">
                      <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                        <p><span className="text-zinc-500">Run:</span> {activeRun.name}</p>
                        <p><span className="text-zinc-500">Status:</span> {activeRun.status}</p>
                        <p><span className="text-zinc-500">Started:</span> {activeRun.startedAt ? new Date(activeRun.startedAt).toLocaleString() : "-"}</p>
                      </div>
                      {activeCase ? (
                        <>
                          <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                            <p><span className="text-zinc-500">Test:</span> {activeCase.title}</p>
                            <p><span className="text-zinc-500">Duration:</span> {((activeCase.durationMs || 0) / 1000).toFixed(2)}s</p>
                            <p><span className="text-zinc-500">Attempt:</span> {activeCase.attempt != null ? activeCase.attempt + 1 : "-"}</p>
                          </div>
                          {(activeCase.traceUrl || activeCase.screenshotUrl || activeCase.videoUrl) && (
                            <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                              <p className="text-zinc-500 text-xs uppercase tracking-[0.2em]">Artifacts</p>
                              <div className="mt-2 flex gap-3">
                                {activeCase.traceUrl && <a className="text-blue-600 hover:underline" href={activeCase.traceUrl} target="_blank" rel="noreferrer">Trace</a>}
                                {activeCase.screenshotUrl && <a className="text-blue-600 hover:underline" href={activeCase.screenshotUrl} target="_blank" rel="noreferrer">Screenshot</a>}
                                {activeCase.videoUrl && <a className="text-blue-600 hover:underline" href={activeCase.videoUrl} target="_blank" rel="noreferrer">Video</a>}
                              </div>
                            </div>
                          )}
                          {(activeCase.errorMessage || activeCase.errorStack) && (
                            <div className="rounded border border-rose-300 bg-rose-50 dark:bg-rose-900/20 p-2">
                              {activeCase.errorMessage && <p className="text-rose-700">{activeCase.errorMessage}</p>}
                              {activeCase.errorStack && (
                                <pre className="mt-2 text-xs whitespace-pre-wrap max-h-[35vh] overflow-y-auto">{activeCase.errorStack}</pre>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-zinc-500">Case-level details unavailable in this run.</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 bg-white dark:bg-zinc-900">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${tone || "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const normalized = (status || "Unknown").toUpperCase();
  const classes = normalized.includes("PASS")
    ? "bg-emerald-100 text-emerald-700"
    : normalized.includes("FAIL")
    ? "bg-rose-100 text-rose-700"
    : normalized.includes("SKIP")
    ? "bg-amber-100 text-amber-700"
    : "bg-zinc-100 text-zinc-700";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${classes}`}>{status || "Unknown"}</span>;
}
