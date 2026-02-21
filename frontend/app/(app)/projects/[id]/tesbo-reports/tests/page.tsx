"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";
import {
  listTesboTests,
  type TesboProjectTest,
} from "@/lib/api";

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

  return (
    <main className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Tesbo Tests</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Inspect test-level histories and outcomes.
          </p>
        </div>
        <Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm text-blue-600 hover:underline">
          Back to Tesbo Reports
        </Link>
      </div>
      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <div className="grid gap-3 md:grid-cols-12">
            <div className="md:col-span-6">
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by spec or test"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              />
            </div>
            <div className="md:col-span-6 flex flex-wrap justify-end gap-2">
              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as "ALL" | "PASSED" | "FAILED" | "SKIPPED")
                }
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              >
                <option value="ALL">All status</option>
                <option value="PASSED">Passed</option>
                <option value="FAILED">Failed</option>
                <option value="SKIPPED">Skipped</option>
              </select>
              <select
                value={specFilter}
                onChange={(event) => setSpecFilter(event.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              >
                {availableSpecs.map((spec) => (
                  <option key={spec} value={spec}>
                    {spec === "ALL" ? "All specs" : spec}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => loadTests().catch(() => {})}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span>Showing {paginatedRows.length} of {filteredRows.length} tests ({rows.length} total)</span>
            <span>Page {page} / {totalPages}</span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-x-auto bg-white dark:bg-zinc-900">
          <table className="min-w-[900px] w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-zinc-500 dark:text-zinc-400">
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
                  <td colSpan={9} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                    Loading tests...
                  </td>
                </tr>
              ) : paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                    No tests found.
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => (
                  <tr key={`${row.specName}-${row.testName}`} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(row.specName)}`}
                        className="text-blue-600 hover:underline"
                      >
                        {row.specName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 break-all">{row.testName}</td>
                    <td className="px-4 py-3">{row.latestStatus ?? "Unknown"}</td>
                    <td className="px-4 py-3 text-right">{row.totalRuns}</td>
                    <td className="px-4 py-3 text-right text-emerald-600">{row.passed}</td>
                    <td className="px-4 py-3 text-right text-rose-600">{row.failed}</td>
                    <td className="px-4 py-3 text-right">
                      {row.totalRuns > 0 ? `${Math.round((row.failed / row.totalRuns) * 1000) / 10}%` : "0%"}
                    </td>
                    <td className="px-4 py-3">
                      {row.latestRunAt ? new Date(row.latestRunAt).toLocaleString() : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/projects/${projectId}/tesbo-reports/tests/${encodeURIComponent(row.specName)}/${encodeURIComponent(row.testName)}`}
                        className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs inline-block"
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

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Click <span className="font-medium">View</span> to open the dedicated test details page with history and charts.
          </p>
        </div>
      </div>
    </main>
  );
}
