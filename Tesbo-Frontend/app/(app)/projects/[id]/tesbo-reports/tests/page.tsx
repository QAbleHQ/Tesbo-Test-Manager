"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";
import { listTesboTests, type TesboProjectTest } from "@/lib/api";
import { Button, Input, Card, Select } from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

export default function TesboTestsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [rows, setRows] = useState<TesboProjectTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PASSED" | "FAILED" | "SKIPPED">("ALL");
  const [specFilter, setSpecFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const pageSize = 12;

  const loadTests = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listTesboTests(projectId));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadTests().catch(() => {});
  }, [loadTests]);

  const availableSpecs = useMemo(
    () => ["ALL", ...Array.from(new Set(rows.map((row) => row.specName))).sort()],
    [rows]
  );

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      const status = (row.latestStatus || "").toUpperCase();
      const matchesSearch =
        term.length === 0 ||
        row.specName.toLowerCase().includes(term) ||
        row.testName.toLowerCase().includes(term);
      const matchesStatus =
        statusFilter === "ALL"
          ? true
          : statusFilter === "PASSED"
          ? status.includes("PASS")
          : statusFilter === "FAILED"
          ? status.includes("FAIL")
          : status.includes("SKIP");
      const matchesSpec = specFilter === "ALL" ? true : row.specName === specFilter;
      return matchesSearch && matchesStatus && matchesSpec;
    });
  }, [rows, search, statusFilter, specFilter]);
  const chartRows = useMemo(
    () =>
      [...filteredRows].sort((a, b) => {
        if (b.failed !== a.failed) return b.failed - a.failed;
        return a.testName.localeCompare(b.testName);
      }),
    [filteredRows]
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const paginatedRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, specFilter, rows.length]);

  const filterBar = (
    <Card className="p-4">
      <div className="grid gap-3 md:grid-cols-12">
        <div className="md:col-span-6">
          <Input type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by spec or test" />
        </div>
        <div className="md:col-span-6 flex flex-wrap justify-end gap-2">
          <Select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as "ALL" | "PASSED" | "FAILED" | "SKIPPED")
            }
            className="w-auto min-w-[120px]"
          >
            <option value="ALL">All status</option>
            <option value="PASSED">Passed</option>
            <option value="FAILED">Failed</option>
            <option value="SKIPPED">Skipped</option>
          </Select>
          <Select value={specFilter} onChange={(event) => setSpecFilter(event.target.value)} className="w-auto min-w-[120px]">
            {availableSpecs.map((spec) => (
              <option key={spec} value={spec}>
                {spec === "ALL" ? "All specs" : spec}
              </option>
            ))}
          </Select>
          <Button type="button" variant="secondary" onClick={() => loadTests().catch(() => {})}>
            Refresh
          </Button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>Showing {paginatedRows.length} of {filteredRows.length} tests ({rows.length} total)</span>
        <span>Page {page} / {totalPages}</span>
      </div>
    </Card>
  );

  return (
    <main className="tesbo-page max-w-6xl mx-auto">
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Tesbo Tests"
            subtitle="Inspect test-level histories and outcomes."
            actions={<Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm hover:underline">Back to Tesbo Reports</Link>}
          />
        }
        filterBar={filterBar}
      >
        <div className="space-y-4">
          {chartRows.length > 0 && (
            <Card className="p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--foreground)]">Pass vs fail by test</h2>
                  <p className="mt-1 text-xs text-[var(--muted)]">Scroll horizontally to compare more tests.</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />Passed</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" />Failed</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" />Skipped</span>
                </div>
              </div>
              <StackedOutcomeBarChart
                items={chartRows.map((row) => ({
                  label: `${row.specName} / ${row.testName}`,
                  passed: row.passed,
                  failed: row.failed,
                  skipped: row.skipped,
                }))}
              />
            </Card>
          )}
          <div className="tesbo-card overflow-x-auto">
            <table className="tesbo-table min-w-[900px] w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Spec</th>
                  <th className="text-left px-4 py-3 font-medium">Test</th>
                  <th className="text-left px-4 py-3 font-medium">Latest Status</th>
                  <th className="text-right px-4 py-3 font-medium">Runs</th>
                  <th className="text-right px-4 py-3 font-medium">Passed</th>
                  <th className="text-right px-4 py-3 font-medium">Failed</th>
                  <th className="text-right px-4 py-3 font-medium">Flakiness</th>
                  <th className="text-left px-4 py-3 font-medium">Last Seen</th>
                  <th className="text-right px-4 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-[var(--muted)]">
                      Loading tests...
                    </td>
                  </tr>
                ) : paginatedRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-[var(--muted)]">
                      No tests found.
                    </td>
                  </tr>
                ) : (
                  paginatedRows.map((row) => (
                    <tr key={`${row.specName}-${row.testName}`}>
                      <td className="px-4 py-3">
                        <Link href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(row.specName)}`} className="text-[var(--brand-primary)] hover:underline">
                          {row.specName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 break-all">{row.testName}</td>
                      <td className="px-4 py-3">{row.latestStatus ?? "Unknown"}</td>
                      <td className="px-4 py-3 text-right">{row.totalRuns}</td>
                      <td className="px-4 py-3 text-right text-[var(--success)]">{row.passed}</td>
                      <td className="px-4 py-3 text-right text-[var(--error)]">{row.failed}</td>
                      <td className="px-4 py-3 text-right">
                        {row.totalRuns > 0 ? `${Math.round((row.failed / row.totalRuns) * 1000) / 10}%` : "0%"}
                      </td>
                      <td className="px-4 py-3">
                        {row.latestRunAt ? new Date(row.latestRunAt).toLocaleString() : "-"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/projects/${projectId}/tesbo-reports/tests/${encodeURIComponent(row.specName)}/${encodeURIComponent(row.testName)}`}
                          className="inline-block rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--surface-secondary)]"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button type="button" variant="secondary" size="sm" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page === 1}>
              Prev
            </Button>
            <span>Page {page} / {totalPages}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={page === totalPages}>
              Next
            </Button>
          </div>

          <Card className="p-4">
            <p className="text-sm text-[var(--muted)]">
              Click <span className="font-medium text-[var(--foreground)]">View</span> to open the dedicated test details page with history and charts.
            </p>
          </Card>
        </div>
      </ListWorkspaceLayout>
    </main>
  );
}

function StackedOutcomeBarChart({
  items,
}: {
  items: { label: string; passed: number; failed: number; skipped: number }[];
}) {
  const CHART_HEIGHT = 190;
  const BAR_WIDTH = 44;
  const BAR_GAP = 10;
  const maxTotal = Math.max(...items.map((item) => item.passed + item.failed + item.skipped), 1);
  const gridLines = 4;
  const stepValue = Math.max(1, Math.ceil(maxTotal / gridLines));
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) => i * stepValue);
  const scaleMax = ticks[ticks.length - 1] || 1;
  const chartWidth = items.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;

  return (
    <div className="mt-4 flex">
      <div className="flex flex-col justify-between shrink-0 pr-2 pb-[46px]" style={{ height: CHART_HEIGHT }}>
        {[...ticks].reverse().map((tick) => (
          <span key={tick} className="text-[10px] leading-none text-[var(--muted)] text-right tabular-nums">
            {tick}
          </span>
        ))}
      </div>
      <div className="flex-1 overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
        <div style={{ width: chartWidth, minWidth: "100%" }}>
          <div className="relative border-l border-b border-[var(--border)]" style={{ height: CHART_HEIGHT }}>
            {ticks.map((tick) => {
              const y = CHART_HEIGHT - (tick / scaleMax) * CHART_HEIGHT;
              return (
                <div
                  key={tick}
                  className="absolute left-0 right-0 border-t border-[var(--border)] opacity-40"
                  style={{ top: y }}
                />
              );
            })}
            <div className="absolute inset-0 flex items-end" style={{ gap: BAR_GAP, padding: `0 ${BAR_GAP / 2}px` }}>
              {items.map((item) => {
                const passH = (item.passed / scaleMax) * CHART_HEIGHT;
                const failH = (item.failed / scaleMax) * CHART_HEIGHT;
                const skipH = (item.skipped / scaleMax) * CHART_HEIGHT;
                const shortLabel = item.label.split("/").pop()?.trim() || item.label;
                return (
                  <div key={item.label} className="group relative" style={{ width: BAR_WIDTH }}>
                    <div className="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
                      <p className="font-medium text-[var(--foreground)]">{item.label}</p>
                      <p className="text-emerald-600">{item.passed} passed</p>
                      <p className="text-rose-600">{item.failed} failed</p>
                      <p className="text-amber-600">{item.skipped} skipped</p>
                    </div>
                    <div className="flex flex-col-reverse overflow-hidden rounded-t-sm" style={{ width: BAR_WIDTH }}>
                      {item.passed > 0 && <div className="bg-emerald-500" style={{ height: passH }} />}
                      {item.failed > 0 && <div className="bg-rose-500" style={{ height: failH }} />}
                      {item.skipped > 0 && <div className="bg-amber-400" style={{ height: skipH }} />}
                    </div>
                    <p className="mt-1 truncate text-[10px] leading-tight text-[var(--muted)] text-center" title={item.label}>
                      {shortLabel}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
