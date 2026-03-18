"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listTesboSpecs, type TesboSpecSummary } from "@/lib/api";
import { Button, Input, Card } from "@/components/ui";
import { PageHeader, ListWorkspaceLayout } from "@/components/workflows";

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

  const filterBar = (
    <Card className="p-4">
      <div className="grid gap-3 md:grid-cols-12">
        <div className="md:col-span-8">
          <Input type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search spec name" />
        </div>
        <div className="md:col-span-4 flex justify-end">
          <Button type="button" variant="secondary" onClick={() => loadSpecs().catch(() => {})}>
            Refresh
          </Button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>Showing {paginatedSpecs.length} of {filteredSpecs.length} specs ({specs.length} total)</span>
        <span>Page {page} / {totalPages}</span>
      </div>
    </Card>
  );

  return (
    <main className="tesbo-page max-w-6xl mx-auto">
      <ListWorkspaceLayout
        header={
          <PageHeader
            title="Tesbo Specs"
            subtitle="Browse specification-level reports and trends."
            actions={<Link href={`/projects/${projectId}/tesbo-reports`} className="text-sm hover:underline">Back to Tesbo Reports</Link>}
          />
        }
        filterBar={filterBar}
      >
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)] mb-3">Specs</p>
          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading specs...</p>
          ) : error ? (
            <p className="text-sm text-[var(--error)]">{error}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {paginatedSpecs.map((spec) => (
                <Link
                  key={spec.specName}
                  href={`/projects/${projectId}/tesbo-reports/specs/${encodeURIComponent(spec.specName)}`}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 text-left hover:border-[var(--brand-primary)] block"
                >
                  <p className="text-sm font-semibold text-[var(--foreground)] break-all">{spec.specName}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{spec.totalRuns} runs</p>
                  <div className="mt-2 flex gap-2 text-xs">
                    <span className="rounded-full bg-[var(--success)] text-white px-2 py-0.5">{spec.passed}</span>
                    <span className="rounded-full bg-[var(--error)] text-white px-2 py-0.5">{spec.failed}</span>
                    <span className="rounded-full bg-[var(--warning)] text-black px-2 py-0.5">{spec.skipped}</span>
                  </div>
                  <span className="mt-3 inline-block text-xs text-[var(--brand-primary)] hover:underline">
                    Open spec page
                  </span>
                </Link>
              ))}
              {paginatedSpecs.length === 0 && (
                <p className="text-sm text-[var(--muted)]">No specs match current search.</p>
              )}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2 text-sm">
            <Button type="button" variant="secondary" size="sm" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page === 1}>
              Prev
            </Button>
            <span>Page {page} / {totalPages}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={page === totalPages}>
              Next
            </Button>
          </div>
        </Card>
      </ListWorkspaceLayout>
    </main>
  );
}
