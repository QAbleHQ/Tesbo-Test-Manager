"use client";

import { useEffect, useState } from "react";
import { getTestCase } from "@/lib/api";
import { buildCompareRows, buildContextRows, formatPercent, type CompareRow, type ReviewRecommendation } from "@/lib/reviewBoard";
import { Button, Modal, PageLoader, StatusChip } from "@/components/ui";

function Cell({ value, differs, caption }: { value: string; differs: boolean; caption: string }) {
  return (
    <div
      className={`min-w-0 whitespace-pre-wrap break-words rounded-md px-3 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere] ${
        differs ? "bg-[var(--warning-soft)] text-[var(--foreground)]" : "bg-[var(--surface-secondary)] text-[var(--muted)]"
      }`}
    >
      {/* Only shown when the two columns stack on a narrow screen, where position no longer says which is which. */}
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)] md:hidden">{caption}</span>
      {value.trim() ? value : <span className="text-[var(--muted-soft)]">—</span>}
    </div>
  );
}

// One template for the header cards and every row, so the columns always line up.
const COLUMNS = "md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]";

function Rows({ rows }: { rows: CompareRow[] }) {
  return (
    <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
      {rows.map((r) => (
        <div key={r.key} className={`grid gap-2 p-3 ${COLUMNS}`}>
          <div className="flex min-w-0 flex-row flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5 md:flex-col md:items-start md:pt-2.5">
            <span className="break-words text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">{r.label}</span>
            {r.differs && <StatusChip tone="warning">Differs</StatusChip>}
          </div>
          <Cell value={r.a} differs={r.differs} caption="Test case A" />
          <Cell value={r.b} differs={r.differs} caption="Test case B" />
        </div>
      ))}
    </div>
  );
}

/**
 * Side-by-side comparison. Both test cases are read live through the existing getTestCase API, so this
 * always shows what the cases contain NOW — which is why a finding can be flagged "changed since analysis"
 * while this view already shows the new content. Differences are judged after the same normalisation the
 * backend uses (case, spacing and punctuation are not differences).
 */
export default function ReviewCompareModal({
  projectId,
  recommendation,
  onClose,
}: {
  projectId: string;
  recommendation: ReviewRecommendation | null;
  onClose: () => void;
}) {
  return (
    <Modal open={!!recommendation} onClose={onClose} title="Compare test cases" className="max-w-5xl">
      {/* Keyed by finding, so opening another one starts from a clean loading state. */}
      {recommendation && <CompareBody key={recommendation.id} projectId={projectId} rec={recommendation} onClose={onClose} />}
    </Modal>
  );
}

function CompareBody({ projectId, rec, onClose }: { projectId: string; rec: ReviewRecommendation; onClose: () => void }) {
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [contextRows, setContextRows] = useState<CompareRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const idA = rec.testcaseA.id;
  const idB = rec.testcaseB.id;

  useEffect(() => {
    let cancelled = false;
    Promise.all([getTestCase(projectId, idA), getTestCase(projectId, idB)])
      .then(([a, b]) => {
        if (cancelled) return;
        setRows(buildCompareRows(a, b));
        setContextRows(buildContextRows(a, b));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the test cases.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, idA, idB]);

  return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={rec.classification === "exact_duplicate" ? "error" : "ai"}>
              {rec.classification === "exact_duplicate" ? "Exact duplicate" : "Similar"}
            </StatusChip>
            <span className="text-xs text-[var(--muted)]">{formatPercent(rec.similarity)} match</span>
            {rec.stepAgreement.total > 0 && (
              <span className="text-xs text-[var(--muted)]">· {rec.stepAgreement.identical} of {rec.stepAgreement.total} step{rec.stepAgreement.total === 1 ? "" : "s"} identical</span>
            )}
            {rec.stale && <StatusChip tone="warning">{rec.staleReason === "unverified" ? "Needs re-analysis" : "Changed since analysis"}</StatusChip>}
          </div>
          <p className="text-xs text-[var(--muted)]">{rec.explanation}</p>

          <div className={`grid gap-2 ${COLUMNS}`}>
            <div />
            {[rec.testcaseA, rec.testcaseB].map((t) => (
              <div key={t.id} className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
                <div className="font-mono text-xs text-[var(--muted)]">{t.externalId}</div>
                <div className="line-clamp-2 text-sm font-semibold text-[var(--foreground)]">{t.title}</div>
                <div className="text-xs text-[var(--muted)]">{t.repositoryName}</div>
              </div>
            ))}
          </div>

          {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>}
          {!rows && !error && <PageLoader variant="inline" label="Loading test cases…" />}
          {rows && (
            <>
              <Rows rows={rows} />
              <div>
                <p className="mb-1.5 text-xs text-[var(--muted)]">Not compared by the analysis (shown for context):</p>
                <Rows rows={contextRows} />
              </div>
            </>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
  );
}
