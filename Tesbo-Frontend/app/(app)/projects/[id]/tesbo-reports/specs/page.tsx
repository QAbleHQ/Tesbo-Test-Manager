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
  const chartSpecs = useMemo(
    () =>
      [...filteredSpecs].sort((a, b) => {
        if (b.failed !== a.failed) return b.failed - a.failed;
        return a.specName.localeCompare(b.specName);
      }),
    [filteredSpecs]
  );
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
          {chartSpecs.length > 0 && (
            <div className="mb-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--foreground)]">Pass vs fail by spec</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">Scroll horizontally to compare specs when the list grows.</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />Passed</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" />Failed</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" />Skipped</span>
                </div>
              </div>
              <StackedOutcomeBarChart
                items={chartSpecs.map((spec) => ({
                  label: spec.specName,
                  passed: spec.passed,
                  failed: spec.failed,
                  skipped: spec.skipped,
                }))}
              />
            </div>
          )}
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

function StackedOutcomeBarChart({
  items,
}: {
  items: { label: string; passed: number; failed: number; skipped: number }[];
}) {
  const CHART_HEIGHT = 190;
  const BAR_WIDTH = 46;
  const BAR_GAP = 12;
  const maxTotal = Math.max(...items.map((item) => item.passed + item.failed + item.skipped), 1);
  const gridLines = 4;
  const stepValue = Math.max(1, Math.ceil(maxTotal / gridLines));
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) => i * stepValue);
  const scaleMax = ticks[ticks.length - 1] || 1;
  const chartWidth = items.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;

  return (
    <div className="mt-3 flex">
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
                const shortLabel = item.label.split("/").pop()?.replace(/\.spec\.\w+$/, "") || item.label;
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
