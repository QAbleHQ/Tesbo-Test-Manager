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
