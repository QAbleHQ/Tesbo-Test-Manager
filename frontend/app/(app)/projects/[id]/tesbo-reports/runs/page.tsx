"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { ingestTesboPlaywright, listTesboRuns, type TesboRunSummary } from "@/lib/api";

export default function TesboRunsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [runs, setRuns] = useState<TesboRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [runSearch, setRunSearch] = useState("");
  const [runStatusFilter, setRunStatusFilter] = useState<"ALL" | "PASSED" | "FAILED" | "SKIPPED">("ALL");
  const [runSourceFilter, setRunSourceFilter] = useState<string>("ALL");
  const [runDateRange, setRunDateRange] = useState<"30d" | "7d" | "all">("30d");
  const [runPage, setRunPage] = useState(1);
  const pageSize = 12;
  const [buildBanner, setBuildBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [uploadingBuildFile, setUploadingBuildFile] = useState(false);
  const buildFileInputRef = useRef<HTMLInputElement | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listTesboRuns(projectId));
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadRuns().catch(() => {});
  }, [loadRuns]);

  const normalizeSource = (source?: string | null) => {
    if (!source) return "Unknown";
    return source === "SELENIUM" ? "PLAYWRIGHT" : source;
  };

  const availableSources = ["ALL", ...Array.from(new Set(runs.map((run) => normalizeSource(run.sourceType)).filter(Boolean)))];

  const filteredRuns = runs.filter((run) => {
    const term = runSearch.trim().toLowerCase();
    const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
    const now = Date.now();
    const matchesDate = runDateRange === "all" || started == null ? true : now - started <= (runDateRange === "30d" ? 30 : 7) * 24 * 60 * 60 * 1000;
    const status = (run.status || "").toUpperCase();
    const matchesStatus =
      runStatusFilter === "ALL"
        ? true
        : runStatusFilter === "PASSED"
          ? status.includes("PASS")
          : runStatusFilter === "FAILED"
            ? status.includes("FAIL")
            : status.includes("SKIP");
    const matchesSource = runSourceFilter === "ALL" ? true : normalizeSource(run.sourceType) === runSourceFilter;
    const matchesSearch =
      term.length === 0 ||
      [run.name, run.branchName, run.pullRequest, run.commitAuthor, run.runNumber, run.sourceType, run.githubRunId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    return matchesDate && matchesStatus && matchesSource && matchesSearch;
  });

  const totalRunPages = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
  const paginatedRuns = filteredRuns.slice((runPage - 1) * pageSize, runPage * pageSize);

  useEffect(() => {
    setRunPage(1);
  }, [runSearch, runStatusFilter, runSourceFilter, runDateRange, runs.length]);

  async function ingestPayload(payload: unknown) {
    setUploadingBuildFile(true);
    setBuildBanner(null);
    try {
      await ingestTesboPlaywright(projectId, payload);
      setBuildBanner({ type: "success", text: "Build uploaded and run ingested." });
      await loadRuns();
    } catch {
      setBuildBanner({ type: "error", text: "Upload failed. Verify file format." });
    } finally {
      setUploadingBuildFile(false);
    }
  }

  async function quickIngestSample() {
    setIngesting(true);
    setIngestMessage(null);
    try {
      await ingestPayload({
        runName: `Manual Tesbo import ${new Date().toLocaleString()}`,
        status: "PASSED",
        sourceType: "PLAYWRIGHT",
        branchName: "main",
        pullRequest: "123",
        commitAuthor: "QA Bot",
        runNumber: String(Date.now()).slice(-5),
        githubRunId: String(Date.now()),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        tests: [
          { spec: "checkout.spec.ts", name: "guest checkout", status: "Passed", durationMs: 1220 },
          { spec: "checkout.spec.ts", name: "apply coupon", status: "Failed", durationMs: 980 },
          { spec: "login.spec.ts", name: "2fa login", status: "Skipped", durationMs: 0 },
        ],
      });
      setIngestMessage("Sample ingestion complete.");
    } finally {
      setIngesting(false);
    }
  }

  async function onBuildFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      await ingestPayload(JSON.parse(text));
    } catch {
      setBuildBanner({ type: "error", text: "Invalid JSON build file." });
    }
  }

  return (
    <main className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Tesbo Runs</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Run-level execution reporting from Tesbo Reports.</p>
        </div>
        <Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm text-blue-600 hover:underline">
          Back to Tesbo Reports
        </Link>
      </div>

      <div className="mt-6">
        <div className="mb-4 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Builds</p>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Build history</h2>
              <p className="text-xs text-zinc-500">Filter by time, status, source, or search to find a run.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={buildFileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={onBuildFileSelected} />
              <button type="button" onClick={() => buildFileInputRef.current?.click()} disabled={uploadingBuildFile} className="rounded-full border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                {uploadingBuildFile ? "Uploading..." : "Upload build file"}
              </button>
              <button type="button" onClick={() => loadRuns().catch(() => {})} className="rounded-full border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                Refresh
              </button>
              <button type="button" disabled={ingesting} onClick={() => quickIngestSample().catch(() => {})} className="rounded-full border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 disabled:opacity-50">
                {ingesting ? "Ingesting..." : "Ingest sample"}
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-12">
            <div className="md:col-span-5">
              <input type="text" value={runSearch} onChange={(event) => setRunSearch(event.target.value)} placeholder="Search name, branch, PR, author, run #" className="w-full rounded-2xl border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm" />
            </div>
            <div className="md:col-span-7 flex flex-wrap items-center gap-2">
              {[
                { label: "Last 30 days", value: "30d" as const },
                { label: "Last 7 days", value: "7d" as const },
                { label: "All time", value: "all" as const },
              ].map((option) => (
                <button key={option.value} type="button" onClick={() => setRunDateRange(option.value)} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${runDateRange === option.value ? "border-blue-400 bg-blue-50 text-blue-700" : "border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300"}`}>
                  {option.label}
                </button>
              ))}
              <select value={runStatusFilter} onChange={(event) => setRunStatusFilter(event.target.value as "ALL" | "PASSED" | "FAILED" | "SKIPPED")} className="rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs">
                <option value="ALL">All status</option>
                <option value="PASSED">Passed</option>
                <option value="FAILED">Failed</option>
                <option value="SKIPPED">Skipped</option>
              </select>
              <select value={runSourceFilter} onChange={(event) => setRunSourceFilter(event.target.value)} className="rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs">
                {availableSources.map((source) => (
                  <option key={source} value={source}>
                    {source === "ALL" ? "All sources" : source}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>Showing {paginatedRuns.length} of {filteredRuns.length} filtered runs ({runs.length} total)</span>
            <span>Page {runPage} / {totalRunPages}</span>
          </div>
        </div>

        {buildBanner && <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${buildBanner.type === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-700"}`}>{buildBanner.text}</div>}
        {ingestMessage && <p className="mb-4 text-sm text-zinc-500">{ingestMessage}</p>}

        {loading ? (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-5 text-sm text-zinc-500 dark:text-zinc-400">Loading runs…</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-x-auto bg-white dark:bg-zinc-900">
              <table className="min-w-[1000px] w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-xs uppercase tracking-[0.25em] text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Run #</th>
                    <th className="px-4 py-3 text-left">Name</th>
                    <th className="px-4 py-3 text-left">Branch</th>
                    <th className="px-4 py-3 text-left">PR</th>
                    <th className="px-4 py-3 text-left">Commit author</th>
                    <th className="px-4 py-3 text-left">GitHub build</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Totals</th>
                    <th className="px-4 py-3 text-left">Source</th>
                    <th className="px-4 py-3 text-left">Started</th>
                    <th className="px-4 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRuns.map((run, idx) => (
                    <tr key={run.id} className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer" onClick={() => router.push(`/projects/${projectId}/tesbo-reports/runs/${run.id}`)}>
                      <td className="px-4 py-3 font-semibold text-zinc-900 dark:text-zinc-100">#{run.runNumber || String((runPage - 1) * pageSize + idx + 1)}</td>
                      <td className="px-4 py-3">{run.name}</td>
                      <td className="px-4 py-3">{run.branchName || "-"}</td>
                      <td className="px-4 py-3">{run.pullRequest || "-"}</td>
                      <td className="px-4 py-3">{run.commitAuthor || "-"}</td>
                      <td className="px-4 py-3">{run.githubRunId || "-"}</td>
                      <td className="px-4 py-3">{run.status}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-emerald-500 text-white px-2 py-0.5 text-xs">{run.passed}</span>
                          <span className="rounded-full bg-rose-500 text-white px-2 py-0.5 text-xs">{run.failed}</span>
                          <span className="rounded-full bg-amber-400 text-black px-2 py-0.5 text-xs">{run.skipped}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">{normalizeSource(run.sourceType)}</td>
                      <td className="px-4 py-3">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}</td>
                      <td className="px-4 py-3 text-right text-blue-600">Open</td>
                    </tr>
                  ))}
                  {paginatedRuns.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                        No runs match current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-sm">
              <span>
                Showing {(runPage - 1) * pageSize + 1}-{Math.min(runPage * pageSize, filteredRuns.length)} of {filteredRuns.length}
              </span>
              <div className="flex items-center gap-2">
                <button type="button" className="rounded-full border border-zinc-300 dark:border-zinc-600 px-3 py-1 disabled:opacity-50" onClick={() => setRunPage((page) => Math.max(1, page - 1))} disabled={runPage === 1}>
                  Prev
                </button>
                <span>Page {runPage} / {totalRunPages}</span>
                <button type="button" className="rounded-full border border-zinc-300 dark:border-zinc-600 px-3 py-1 disabled:opacity-50" onClick={() => setRunPage((page) => Math.min(totalRunPages, page + 1))} disabled={runPage === totalRunPages}>
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
