"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listTesboSpecs, type TesboSpecSummary } from "@/lib/api";

export default function TesboSpecsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const [specs, setSpecs] = useState<TesboSpecSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 12;

  const loadSpecs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSpecs(await listTesboSpecs(projectId));
    } catch {
      setSpecs([]);
      setError("Unable to load specs.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadSpecs().catch(() => {});
  }, [loadSpecs]);

  const filteredSpecs = useMemo(() => {
    const term = search.trim().toLowerCase();
    return specs.filter((spec) => term.length === 0 || spec.specName.toLowerCase().includes(term));
  }, [specs, search]);
  const totalPages = Math.max(1, Math.ceil(filteredSpecs.length / pageSize));
  const paginatedSpecs = filteredSpecs.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [search, specs.length]);

  return (
    <main className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Tesbo Specs</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Browse specification-level reports and trends.
          </p>
        </div>
        <Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm text-blue-600 hover:underline">
          Back to Tesbo Reports
        </Link>
      </div>
      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <div className="grid gap-3 md:grid-cols-12">
            <div className="md:col-span-8">
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search spec name"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              />
            </div>
            <div className="md:col-span-4 flex justify-end">
              <button
                type="button"
                onClick={() => loadSpecs().catch(() => {})}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span>Showing {paginatedSpecs.length} of {filteredSpecs.length} specs ({specs.length} total)</span>
            <span>Page {page} / {totalPages}</span>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
          <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-3">Specs</p>
          {loading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading specs...</p>
          ) : error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {paginatedSpecs.map((spec) => (
                <Link
                  key={spec.specName}
                  href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(spec.specName)}`}
                  className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-3 text-left hover:border-blue-400 block"
                >
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 break-all">{spec.specName}</p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{spec.totalRuns} runs</p>
                  <div className="mt-2 flex gap-2 text-xs">
                    <span className="rounded-full bg-emerald-500 text-white px-2 py-0.5">{spec.passed}</span>
                    <span className="rounded-full bg-rose-500 text-white px-2 py-0.5">{spec.failed}</span>
                    <span className="rounded-full bg-amber-400 text-black px-2 py-0.5">{spec.skipped}</span>
                  </div>
                  <span className="mt-3 inline-block text-xs text-blue-600 hover:underline">
                    Open spec page
                  </span>
                </Link>
              ))}
              {paginatedSpecs.length === 0 && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">No specs match current search.</p>
              )}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2 text-sm">
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
        </div>
      </div>
    </main>
  );
}
