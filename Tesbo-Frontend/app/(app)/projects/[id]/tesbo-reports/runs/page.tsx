"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { listTesboRuns, type TesboRunSummary } from "@/lib/api";
import { Button, Input, Card, StatusChip, EmptyStateBlock } from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

function relativeTime(date: string | null): string {
  if (!date) return "—";
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function statusTone(status: string): "success" | "error" | "warning" | "neutral" {
  const s = (status || "").toUpperCase();
  if (s.includes("PASS") || s.includes("COMPLETE")) return "success";
  if (s.includes("FAIL")) return "error";
  if (s.includes("SKIP")) return "warning";
  return "neutral";
}

function statusLabel(status: string): string {
  const s = (status || "").toUpperCase();
  if (s.includes("PASS") || s.includes("COMPLETE")) return "Passed";
  if (s.includes("FAIL")) return "Failed";
  if (s.includes("SKIP")) return "Skipped";
  return status || "Unknown";
}

function accentBorder(status: string): string {
  const s = (status || "").toUpperCase();
  if (s.includes("FAIL")) return "border-l-[var(--error)]";
  if (s.includes("PASS") || s.includes("COMPLETE")) return "border-l-[var(--success)]";
  if (s.includes("SKIP")) return "border-l-[var(--warning)]";
  return "border-l-[var(--border)]";
}

function normalizeSource(source?: string | null) {
  if (!source) return "Unknown";
  return source === "SELENIUM" ? "PLAYWRIGHT" : source;
}

function RunSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="tesbo-card border-l-4 border-l-[var(--border)] p-4 animate-pulse">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-5 w-12 rounded bg-[var(--surface-tertiary)]" />
            <div className="h-5 w-16 rounded-full bg-[var(--surface-tertiary)]" />
          </div>
          <div className="h-4 w-2/3 rounded bg-[var(--surface-tertiary)] mb-3" />
          <div className="flex items-center gap-4">
            <div className="h-3 w-full max-w-xs rounded-full bg-[var(--surface-tertiary)]" />
            <div className="h-3 w-20 rounded bg-[var(--surface-tertiary)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function TestResultBar({ passed, failed, skipped, total }: { passed: number; failed: number; skipped: number; total: number }) {
  if (total === 0) return <span className="text-xs text-[var(--muted)]">No tests</span>;
  const pPct = (passed / total) * 100;
  const fPct = (failed / total) * 100;
  const sPct = (skipped / total) * 100;

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="flex h-2 flex-1 max-w-[180px] overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
        {pPct > 0 && <div className="bg-[var(--success)]" style={{ width: `${pPct}%` }} />}
        {fPct > 0 && <div className="bg-[var(--error)]" style={{ width: `${fPct}%` }} />}
        {sPct > 0 && <div className="bg-[var(--warning)]" style={{ width: `${sPct}%` }} />}
      </div>
      <div className="flex items-center gap-2 text-xs font-medium whitespace-nowrap">
        <span className="text-[var(--success)]">{passed}</span>
        <span className="text-[var(--muted)]">/</span>
        <span className="text-[var(--error)]">{failed}</span>
        <span className="text-[var(--muted)]">/</span>
        <span className="text-[var(--warning-foreground,var(--warning))]">{skipped}</span>
      </div>
    </div>
  );
}

function MetaTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
      {children}
    </span>
  );
}

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
          ? status.includes("PASS") || status.includes("COMPLETE")
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

  /* ---- Aggregate stats — computed without status filter so numbers stay stable ---- */
  const statsRuns = runs.filter((run) => {
    const term = runSearch.trim().toLowerCase();
    const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
    const now = Date.now();
    const matchesDate = runDateRange === "all" || started == null ? true : now - started <= (runDateRange === "30d" ? 30 : 7) * 24 * 60 * 60 * 1000;
    const matchesSource = runSourceFilter === "ALL" ? true : normalizeSource(run.sourceType) === runSourceFilter;
    const matchesSearch =
      term.length === 0 ||
      [run.name, run.branchName, run.pullRequest, run.commitAuthor, run.runNumber, run.sourceType, run.githubRunId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    return matchesDate && matchesSource && matchesSearch;
  });
  const totalTests = statsRuns.reduce((s, r) => s + r.total, 0);
  const totalPassed = statsRuns.reduce((s, r) => s + r.passed, 0);
  const totalFailed = statsRuns.reduce((s, r) => s + r.failed, 0);
  const failedRunCount = statsRuns.filter((r) => (r.status || "").toUpperCase().includes("FAIL")).length;

  const filterBar = (
    <Card className="p-5 space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.25em] font-semibold text-[var(--muted)] mb-1">Execution History</p>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">Build Runs</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => loadRuns().catch(() => {})}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Summary stats strip */}
      {!loading && runs.length > 0 && (
        <div className="flex flex-wrap gap-6 border-t border-b border-[var(--border)] py-3 text-sm">
          <div>
            <span className="text-[var(--muted)] text-xs font-medium">Runs</span>
            <p className="text-[var(--foreground)] font-semibold">{statsRuns.length}</p>
          </div>
          <div>
            <span className="text-[var(--muted)] text-xs font-medium">Total tests</span>
            <p className="text-[var(--foreground)] font-semibold">{totalTests.toLocaleString()}</p>
          </div>
          <div>
            <span className="text-[var(--muted)] text-xs font-medium">Passed</span>
            <p className="text-[var(--success)] font-semibold">{totalPassed.toLocaleString()}</p>
          </div>
          <div>
            <span className="text-[var(--muted)] text-xs font-medium">Failed</span>
            <p className="text-[var(--error)] font-semibold">{totalFailed.toLocaleString()}</p>
          </div>
          {failedRunCount > 0 && (
            <div>
              <span className="text-[var(--muted)] text-xs font-medium">Failed runs</span>
              <p className="text-[var(--error)] font-semibold">{failedRunCount}</p>
            </div>
          )}
        </div>
      )}

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex-1 min-w-[160px] max-w-[220px]">
          <Input type="text" value={runSearch} onChange={(event) => setRunSearch(event.target.value)} placeholder="Search runs..." className="!h-8 !text-xs !rounded-full !px-3" />
        </div>
        <div className="w-px h-5 bg-[var(--border)] mx-0.5" />
        {[
          { label: "30d", value: "30d" as const },
          { label: "7d", value: "7d" as const },
          { label: "All", value: "all" as const },
        ].map((option) => (
          <button key={option.value} type="button" onClick={() => setRunDateRange(option.value)} className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${runDateRange === option.value ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"}`}>
            {option.label}
          </button>
        ))}
        <div className="w-px h-5 bg-[var(--border)] mx-0.5" />
        {(["ALL", "PASSED", "FAILED", "SKIPPED"] as const).map((value) => {
          const label = value === "ALL" ? "All" : value.charAt(0) + value.slice(1).toLowerCase();
          const active = runStatusFilter === value;
          return (
            <button key={value} type="button" onClick={() => setRunStatusFilter(value)} className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${active ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"}`}>
              {label}
            </button>
          );
        })}
        {availableSources.length > 2 && (
          <>
            <div className="w-px h-5 bg-[var(--border)] mx-0.5" />
            {availableSources.map((source) => {
              const active = runSourceFilter === source;
              const label = source === "ALL" ? "All sources" : source;
              return (
                <button key={source} type="button" onClick={() => setRunSourceFilter(source)} className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${active ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"}`}>
                  {label}
                </button>
              );
            })}
          </>
        )}
      </div>
    </Card>
  );

  return (
    <main className="tesbo-page max-w-6xl mx-auto">
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Automation Runs"
            subtitle="Execution history and test results across all automation sources."
            actions={<Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm text-[var(--brand-primary)] hover:underline font-medium">Back to Tesbo Reports</Link>}
          />
        }
        filterBar={filterBar}
      >
        {loading ? (
          <RunSkeleton />
        ) : paginatedRuns.length === 0 ? (
          <EmptyStateBlock
            title="No runs match current filters"
            description="Adjust your filters or trigger a new automation run to see results here."
            icon={
              <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
              </svg>
            }
            action={
              <div className="flex items-center justify-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => { setRunSearch(""); setRunStatusFilter("ALL"); setRunSourceFilter("ALL"); setRunDateRange("all"); }}>
                  Clear filters
                </Button>
              </div>
            }
          />
        ) : (
          <div className="space-y-4">
            <div className="tesbo-card overflow-x-auto">
              <table className="tesbo-table min-w-[1000px] w-full text-sm">
                <thead>
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
                    <tr key={run.id} className="cursor-pointer" onClick={() => router.push(`/projects/${projectId}/tesbo-reports/runs/${run.id}`)}>
                      <td className="px-4 py-3 font-semibold text-[var(--foreground)]">#{run.runNumber || String(runs.length - ((runPage - 1) * pageSize + idx))}</td>
                      <td className="px-4 py-3">{run.name}</td>
                      <td className="px-4 py-3">{run.branchName || "-"}</td>
                      <td className="px-4 py-3">{run.pullRequest || "-"}</td>
                      <td className="px-4 py-3">{run.commitAuthor || "-"}</td>
                      <td className="px-4 py-3">{run.githubRunId || "-"}</td>
                      <td className="px-4 py-3">{run.status}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-[var(--success)] text-white px-2 py-0.5 text-xs">{run.passed}</span>
                          <span className="rounded-full bg-[var(--error)] text-white px-2 py-0.5 text-xs">{run.failed}</span>
                          <span className="rounded-full bg-[var(--warning)] text-black px-2 py-0.5 text-xs">{run.skipped}</span>
                        </div>

                        <p className="text-sm text-[var(--foreground)] truncate max-w-lg font-medium" title={run.name}>
                          {run.name}
                        </p>

                        {hasMeta && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {run.branchName && (
                              <MetaTag>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 103 3 3 3 0 00-3-3zm12-6a3 3 0 10-3-3 3 3 0 003 3zm0 0v6a3 3 0 01-3 3H9" /></svg>
                                {run.branchName}
                              </MetaTag>
                            )}
                            {run.pullRequest && (
                              <MetaTag>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
                                PR #{run.pullRequest}
                              </MetaTag>
                            )}
                            {run.commitAuthor && (
                              <MetaTag>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" /></svg>
                                {run.commitAuthor}
                              </MetaTag>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Right: test results + action */}
                      <div className="flex items-center gap-5 sm:flex-col sm:items-end sm:gap-3">
                        <TestResultBar passed={run.passed} failed={run.failed} skipped={run.skipped} total={run.total} />
                        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--brand-primary)] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          View run details
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between tesbo-card px-4 py-3 text-sm">
              <span className="text-[var(--muted)]">
                {(runPage - 1) * pageSize + 1}–{Math.min(runPage * pageSize, filteredRuns.length)} of {filteredRuns.length} runs
              </span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setRunPage((page) => Math.max(1, page - 1))} disabled={runPage === 1}>
                  Previous
                </Button>
                <span className="text-xs text-[var(--muted)] font-medium">
                  {runPage} / {totalRunPages}
                </span>
                <Button type="button" variant="secondary" size="sm" onClick={() => setRunPage((page) => Math.min(totalRunPages, page + 1))} disabled={runPage === totalRunPages}>
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </ListWorkspaceLayout>
    </main>
  );
}
