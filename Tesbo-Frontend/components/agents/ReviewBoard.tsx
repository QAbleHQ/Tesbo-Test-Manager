"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconArrowsLeftRight, IconCheck, IconChecklist, IconCopy, IconEye, IconGitCompare, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import { getBillingInfo, type BillingInfo } from "@/lib/api";
import { Button, Card, Modal, PageLoader, StatusChip } from "@/components/ui";
import PricingModal from "@/components/PricingModal";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import ReviewCompareModal from "@/components/agents/ReviewCompareModal";
import ReviewEditModal from "@/components/agents/ReviewEditModal";
import {
  DIFFERENCE_LABEL,
  STALE_HINT,
  getReviewAnalysis,
  keepReviewRecommendation,
  listReviewRecommendations,
  removeReviewRecommendation,
  RUN_ACTIVE,
  startReviewAnalysis,
  type AnalysisRun,
  type RecommendationList,
  type ReviewRecommendation,
  type ReviewStatus,
} from "@/lib/reviewBoard";

const PAGE_SIZE = 25;
const POLL_MS = 2500;

// "Removed" is deliberately not a filter: the API only lists findings whose two test cases both still
// exist, and a removed finding by definition has a deleted case.
const FILTERS: Array<{ key: ReviewStatus; label: string }> = [
  { key: "pending", label: "To review" },
  { key: "kept", label: "Kept" },
  { key: "edited", label: "Edited" },
  { key: "obsolete", label: "No longer matching" },
];

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "To review",
  kept: "Kept as is",
  edited: "Edited",
  removed: "Removed",
  obsolete: "No longer matching",
};

const STATUS_TONE: Record<ReviewStatus, "warning" | "success" | "info" | "error" | "neutral"> = {
  pending: "warning",
  kept: "success",
  edited: "info",
  removed: "error",
  obsolete: "neutral",
};

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");
const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

const errorBox = "rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]";

/**
 * Pro-only. Mirrors the backend's `effectivePlan` (PlanLimitsService.computeEntitlement): a downgraded
 * workspace still holds Pro until its grace period ends. This is presentation only — every Review Board
 * endpoint enforces the same plan rule, and owner/manager role, on the server.
 */
export default function ReviewBoard({ projectId }: { projectId: string }) {
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [billingError, setBillingError] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  useEffect(() => {
    getBillingInfo().then(setBillingInfo).catch(() => setBillingError(true));
  }, []);

  if (billingError) {
    return <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--muted)]">Couldn&apos;t verify your plan. Reload to try again.</p>;
  }
  if (!billingInfo) return <PageLoader label="Checking your plan…" />;

  if (billingInfo.enabled !== false && billingInfo.plan !== "pro" && !billingInfo.inGracePeriod) {
    return (
      <>
        <Card className="p-5">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Review Board is a Pro plan feature</h2>
          <p className="mt-1.5 text-sm text-[var(--muted)]">
            Find duplicate and similar test cases in your repository, compare them side by side, and decide what to keep, edit, or remove. Nothing changes without your confirmation.
          </p>
          <Button type="button" className="mt-3" onClick={() => setPricingOpen(true)}>Upgrade to Pro</Button>
        </Card>
        <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} billingInfo={billingInfo} />
      </>
    );
  }

  return <RoleGate projectId={projectId} />;
}

/** Owners and managers only — the API answers 403 to everyone else, so the board never calls it for them. */
function RoleGate({ projectId }: { projectId: string }) {
  const { currentUser } = useAppData();
  const { projectMembers } = useProjectData();
  const role = currentUser ? normalizeRole(projectMembers.find((m) => m.userId === currentUser.userId)?.role ?? "qa_engineer") : "qa_engineer";
  if (role === "qa_engineer") {
    return (
      <Card className="p-5">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Only project owners and managers can use the Review Board</h2>
        <p className="mt-1.5 text-sm text-[var(--muted)]">Ask an owner or manager of this project to run and review the analysis.</p>
      </Card>
    );
  }
  return <ReviewWorkspace projectId={projectId} />;
}

function ReviewWorkspace({ projectId }: { projectId: string }) {
  // undefined = first load in flight; null = this project has never been analysed.
  const [analysis, setAnalysis] = useState<AnalysisRun | null | undefined>(undefined);
  const [data, setData] = useState<RecommendationList | null>(null);
  const [filter, setFilter] = useState<ReviewStatus>("pending");
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [compareFor, setCompareFor] = useState<ReviewRecommendation | null>(null);
  const [editFor, setEditFor] = useState<ReviewRecommendation | null>(null);
  const [removeFor, setRemoveFor] = useState<ReviewRecommendation | null>(null);
  const pollInFlight = useRef(false);

  const active = !!analysis && RUN_ACTIVE.has(analysis.status);

  const loadAnalysis = useCallback(async (): Promise<AnalysisRun | null | undefined> => {
    try {
      const run = await getReviewAnalysis(projectId);
      setAnalysis(run);
      return run;
    } catch (err) {
      setLoadError(errText(err, "Failed to load the analysis."));
      setAnalysis((prev) => (prev === undefined ? null : prev));
      return undefined;
    }
  }, [projectId]);

  const loadList = useCallback(async () => {
    try {
      const res = await listReviewRecommendations(projectId, { status: [filter], limit: PAGE_SIZE, offset });
      setData(res);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err, "Failed to load recommendations."));
    }
  }, [projectId, filter, offset]);

  useEffect(() => {
    void loadAnalysis();
  }, [loadAnalysis]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // While a run is queued/running, poll its status; when it finishes, load the results. Hidden tabs skip
  // a tick, and a slow response never stacks a second request.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const run = await getReviewAnalysis(projectId);
        setAnalysis(run);
        if (run && !RUN_ACTIVE.has(run.status)) {
          setOffset(0);
          await loadList();
        }
      } catch {
        // A missed tick is not worth surfacing; the next one usually succeeds.
      } finally {
        pollInFlight.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, projectId, loadList]);

  async function handleStart() {
    if (starting || active) return;
    setStarting(true);
    setStartError(null);
    setActionError(null);
    setNotice(null);
    try {
      setAnalysis(await startReviewAnalysis(projectId));
    } catch (err) {
      // 409 means someone else already started one: show their run rather than a dead end.
      setStartError(errText(err, "Failed to start the analysis."));
      void loadAnalysis();
    } finally {
      setStarting(false);
    }
  }

  async function handleKeep(rec: ReviewRecommendation) {
    setBusyId(rec.id);
    setActionError(null);
    setNotice(null);
    try {
      await keepReviewRecommendation(projectId, rec.id);
      setNotice(`${rec.testcaseA.externalId} and ${rec.testcaseB.externalId} kept as they are. Neither test case was changed.`);
    } catch (err) {
      setActionError(errText(err, "Failed to keep this recommendation."));
    } finally {
      setBusyId(null);
      await loadList();
    }
  }

  const empty = !!data && data.total === 0;
  const neverFound = !!data && Object.values(data.counts).every((n) => n === 0);
  const busyRun = starting || active;

  return (
    <section aria-label="Review Board" className="min-w-0 space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-secondary)] text-[var(--accent-light)]">
              <IconGitCompare size={22} stroke={1.75} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[var(--foreground)]">Duplicate and similar test cases</h2>
              <p className="mt-0.5 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
                Find test cases in this project that repeat each other. You review every suggestion — nothing is edited or removed until you confirm it.
              </p>
            </div>
          </div>
          <Button type="button" size="lg" onClick={() => void handleStart()} disabled={busyRun || analysis === undefined}>
            <span className="inline-flex items-center gap-2">
              <IconRefresh size={17} stroke={1.9} className={busyRun ? "animate-spin" : undefined} />
              {busyRun ? "Analysing…" : analysis?.status === "completed" ? "Analyse again" : "Start Analysing"}
            </span>
          </Button>
        </div>

        {startError && <p role="alert" className={errorBox}>{startError}</p>}

        {analysis === undefined && <PageLoader variant="inline" label="Loading analysis…" />}

        {analysis === null && !loadError && (
          <div className="grid gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-3">
            {[
              ["1", "Analyse", "We compare the title, steps, expected results and test data of every test case."],
              ["2", "Review", "See why two test cases match and exactly what is different between them."],
              ["3", "Decide", "Keep both, edit one, or remove one — only after you confirm."],
            ].map(([n, title, text]) => (
              <div key={n} className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-secondary)] text-xs font-semibold text-[var(--accent-light)]">{n}</span>
                <div>
                  <p className="text-sm font-medium text-[var(--foreground)]">{title}</p>
                  <p className="text-xs leading-relaxed text-[var(--muted)]">{text}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {analysis && active && (
          <div role="status" className="flex items-start gap-3 border-t border-[var(--border)] pt-4">
            <PageLoader variant="inline" label={analysis.status === "queued" ? "Analysis queued…" : "Analysing test cases…"} />
            <p className="text-xs leading-relaxed text-[var(--muted)]">
              Started {fmtDate(analysis.createdAt)}. It keeps running if you leave this page — results appear here when it finishes.
            </p>
          </div>
        )}

        {analysis?.status === "failed" && (
          <div role="alert" className={`${errorBox} flex items-start gap-2`}>
            <IconAlertTriangle size={17} className="mt-0.5 shrink-0" />
            <span>
              The analysis didn&apos;t finish{analysis.finishedAt ? ` (${fmtDate(analysis.finishedAt)})` : ""}: {analysis.error ?? "unknown error"} You can start it again.
            </span>
          </div>
        )}

        {analysis?.status === "completed" && (
          <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--muted)]">
              <div className="flex gap-1.5"><dt>Last analysed</dt><dd className="font-medium text-[var(--foreground)]">{fmtDate(analysis.finishedAt)}</dd></div>
              <div className="flex gap-1.5"><dt>Test cases checked</dt><dd className="font-medium text-[var(--foreground)]">{analysis.testcasesAnalyzed ?? 0}</dd></div>
              <div className="flex gap-1.5"><dt>Pairs found</dt><dd className="font-medium text-[var(--foreground)]">{analysis.pairsFound ?? 0}</dd></div>
            </dl>
            {analysis.truncated && (
              <p className="text-xs text-[var(--warning-foreground)]">Only the most similar pairs are listed. Resolve some and analyse again to see the rest.</p>
            )}
          </div>
        )}
      </Card>

      {loadError && <p role="alert" className={errorBox}>{loadError}</p>}
      {actionError && <p role="alert" className={errorBox}>{actionError}</p>}
      {notice && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2.5 text-sm text-[var(--foreground)]">
          <IconCheck size={17} className="mt-0.5 shrink-0 text-[var(--success-foreground)]" />
          <span>{notice}</span>
        </p>
      )}

      {analysis !== undefined && analysis !== null && (
        <div role="tablist" aria-label="Filter findings" className="flex flex-wrap gap-1 border-b border-[var(--border)]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                setOffset(0);
              }}
              className={`flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
                filter === f.key ? "border-[var(--brand-primary)] text-[var(--accent-light)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {f.label}
              {data && (
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none ${filter === f.key ? "bg-[var(--surface-secondary)] text-[var(--foreground)]" : "bg-[var(--surface-secondary)] text-[var(--muted)]"}`}>
                  {data.counts[f.key]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {empty && analysis?.status === "completed" && (
        <section className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center">
          <IconChecklist size={30} stroke={1.5} className="mx-auto text-[var(--muted-soft)]" />
          <h3 className="mt-3 text-sm font-semibold text-[var(--foreground)]">
            {neverFound ? "No duplicate or similar test cases found" : `Nothing in “${FILTERS.find((f) => f.key === filter)?.label}”`}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">
            {neverFound ? "Every test case in this project looks distinct. Analyse again after adding or changing test cases." : "Use the tabs above to look at the other groups."}
          </p>
        </section>
      )}

      {data && data.items.length > 0 && (
        <div className="space-y-4">
          {data.items.map((rec) => (
            <RecommendationRow
              key={rec.id}
              rec={rec}
              busy={busyId === rec.id}
              reanalyseDisabled={busyRun}
              onReanalyse={() => void handleStart()}
              onCompare={() => setCompareFor(rec)}
              onKeep={() => void handleKeep(rec)}
              onEdit={() => setEditFor(rec)}
              onRemove={() => setRemoveFor(rec)}
            />
          ))}
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-[var(--muted)]">
          <span>
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}
          </span>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
            <Button type="button" size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
          </div>
        </div>
      )}

      <ReviewCompareModal projectId={projectId} recommendation={compareFor} onClose={() => setCompareFor(null)} />
      <ReviewEditModal
        projectId={projectId}
        recommendation={editFor}
        onClose={() => setEditFor(null)}
        onSaved={() => {
          setNotice("Saved. Re-run the analysis to refresh the findings.");
          setEditFor(null);
          void loadList();
        }}
      />
      <RemoveModal
        projectId={projectId}
        recommendation={removeFor}
        onClose={() => setRemoveFor(null)}
        onRemoved={(label) => {
          setNotice(`${label} was removed from the project. The removal is recorded in the audit log.`);
          setRemoveFor(null);
          void loadList();
        }}
        onFailed={(message) => {
          setActionError(message);
          setRemoveFor(null);
          void loadList();
        }}
      />
    </section>
  );
}

/** Match percentage with a small bar, so strong matches stand out from borderline ones at a glance. */
function MatchMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2" title={`${pct}% of the compared content matches`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--surface-secondary)] ring-1 ring-[var(--border)]" aria-hidden="true">
        <div className="h-full rounded-full bg-[var(--brand-primary)]" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-semibold text-[var(--foreground)]">{pct}% match</span>
    </div>
  );
}

function TestcaseCard({ label, t }: { label: string; t: ReviewRecommendation["testcaseA"] }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">{label}</p>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-xs text-[var(--foreground)] ring-1 ring-[var(--border)]">{t.externalId}</span>
        <span className="min-w-0 truncate text-xs text-[var(--muted)]">{t.repositoryName}</span>
      </div>
      <p className="mt-2 line-clamp-3 break-words text-sm font-semibold leading-snug text-[var(--foreground)]">{t.title}</p>
    </div>
  );
}

function RecommendationRow({
  rec,
  busy,
  reanalyseDisabled,
  onReanalyse,
  onCompare,
  onKeep,
  onEdit,
  onRemove,
}: {
  rec: ReviewRecommendation;
  busy: boolean;
  reanalyseDisabled: boolean;
  onReanalyse: () => void;
  onCompare: () => void;
  onKeep: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  // An outdated finding must not stay actionable: once either case changed after the analysis, only
  // Compare is available until the analysis is re-run. The API refuses the destructive actions regardless.
  const actionable = rec.reviewStatus === "pending" && !rec.stale && !busy;
  const whyDisabled = actionable
    ? undefined
    : rec.reviewStatus !== "pending"
      ? "This finding has already been reviewed."
      : rec.stale
        ? "This finding is out of date — analyse again first."
        : "Working…";
  const exact = rec.classification === "exact_duplicate";

  return (
    <article className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip tone={exact ? "error" : "ai"}>
            <span className="inline-flex items-center gap-1.5">
              {exact ? <IconCopy size={13} stroke={2} /> : <IconGitCompare size={13} stroke={2} />}
              {exact ? "Exact duplicate" : "Similar"}
            </span>
          </StatusChip>
          <MatchMeter value={rec.similarity} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rec.reviewStatus !== "pending" && <StatusChip tone={STATUS_TONE[rec.reviewStatus]}>{STATUS_LABEL[rec.reviewStatus]}</StatusChip>}
          {rec.stale && <StatusChip tone="warning">{rec.staleReason === "unverified" ? "Needs re-analysis" : "Changed since analysis"}</StatusChip>}
        </div>
      </header>

      <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <TestcaseCard label="Test case A" t={rec.testcaseA} />
        <div className="hidden items-center text-[var(--muted-soft)] md:flex" aria-hidden="true">
          <IconArrowsLeftRight size={18} stroke={1.75} />
        </div>
        <TestcaseCard label="Test case B" t={rec.testcaseB} />
      </div>

      <div className="rounded-lg border-l-2 border-[var(--brand-primary)] bg-[var(--surface-secondary)] px-3.5 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">Why they match</p>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--foreground)]">{rec.explanation}</p>
      </div>

      {rec.differences.length > 0 && (
        <details className="rounded-lg border border-[var(--border)]" open={rec.differences.length <= 2}>
          <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-[var(--foreground)]">
            What is different
            <span className="ml-2 font-normal text-[var(--muted)]">{rec.differences.map((d) => DIFFERENCE_LABEL[d.field]).join(", ")}</span>
          </summary>
          <div className="space-y-2 border-t border-[var(--border)] p-3">
            <div className="hidden gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)] md:grid md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
              <span />
              <span>Test case A</span>
              <span>Test case B</span>
            </div>
            {rec.differences.map((d) => (
              <div key={d.field} className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="pt-1.5 text-xs font-semibold text-[var(--foreground)]">{DIFFERENCE_LABEL[d.field]}</div>
                <div className="line-clamp-4 whitespace-pre-wrap break-words rounded-md bg-[var(--warning-soft)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--foreground)]">{d.a || "—"}</div>
                <div className="line-clamp-4 whitespace-pre-wrap break-words rounded-md bg-[var(--warning-soft)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--foreground)]">{d.b || "—"}</div>
              </div>
            ))}
          </div>
        </details>
      )}

      {rec.stale && rec.staleReason && rec.reviewStatus === "pending" && (
        <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3.5 py-3">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-sm leading-relaxed text-[var(--warning-foreground)]">
            <IconAlertTriangle size={17} className="mt-0.5 shrink-0" />
            <span>{STALE_HINT[rec.staleReason]} Analyse again to keep, edit or remove them.</span>
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={onReanalyse} disabled={reanalyseDisabled}>Analyse again</Button>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
        <Button type="button" size="sm" variant="secondary" onClick={onCompare}>
          <span className="inline-flex items-center gap-1.5"><IconEye size={15} stroke={1.9} />Compare</span>
        </Button>
        <span title={whyDisabled}>
          <Button type="button" size="sm" variant="secondary" disabled={!actionable} onClick={onKeep}>
            <span className="inline-flex items-center gap-1.5"><IconCheck size={15} stroke={1.9} />Keep as is</span>
          </Button>
        </span>
        <span title={whyDisabled}>
          <Button type="button" size="sm" variant="secondary" disabled={!actionable} onClick={onEdit}>
            <span className="inline-flex items-center gap-1.5"><IconPencil size={15} stroke={1.9} />Edit</span>
          </Button>
        </span>
        <span className="ml-auto" title={whyDisabled}>
          <Button type="button" size="sm" variant="destructive" disabled={!actionable} onClick={onRemove}>
            <span className="inline-flex items-center gap-1.5"><IconTrash size={15} stroke={1.9} />Remove from project</span>
          </Button>
        </span>
        <p className="basis-full text-[11px] text-[var(--muted-soft)]">
          Found by the analysis on {fmtDate(rec.lastAnalysis.finishedAt) || "—"}
          {rec.lastAnalysis.status && rec.lastAnalysis.status !== "completed" ? ` (${rec.lastAnalysis.status})` : ""}.
        </p>
      </footer>
    </article>
  );
}

/** Choose exactly which test case goes, see what that means, and confirm. Nothing is pre-selected. */
function RemoveModal({
  projectId,
  recommendation,
  onClose,
  onRemoved,
  onFailed,
}: {
  projectId: string;
  recommendation: ReviewRecommendation | null;
  onClose: () => void;
  onRemoved: (label: string) => void;
  onFailed: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={!!recommendation} onClose={() => !busy && onClose()} title="Remove a test case from the project?" className="max-w-2xl">
      {/* Keyed by finding: every opening starts with nothing selected and nothing acknowledged. */}
      {recommendation && (
        <RemoveBody key={recommendation.id} projectId={projectId} rec={recommendation} busy={busy} setBusy={setBusy} onClose={onClose} onRemoved={onRemoved} onFailed={onFailed} />
      )}
    </Modal>
  );
}

function RemoveBody({
  projectId,
  rec,
  busy,
  setBusy,
  onClose,
  onRemoved,
  onFailed,
}: {
  projectId: string;
  rec: ReviewRecommendation;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onClose: () => void;
  onRemoved: (label: string) => void;
  onFailed: (message: string) => void;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const target = [rec.testcaseA, rec.testcaseB].find((t) => t.id === targetId);
  const other = target ? (target.id === rec.testcaseA.id ? rec.testcaseB : rec.testcaseA) : undefined;

  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    try {
      await removeReviewRecommendation(projectId, rec.id, target.id);
      onRemoved(`${target.externalId} “${target.title}”`);
    } catch (err) {
      onFailed(errText(err, "Failed to remove the test case."));
    } finally {
      setBusy(false);
    }
  }

  return (
        <div className="space-y-4">
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">Select the test case to remove</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[rec.testcaseA, rec.testcaseB].map((t) => (
                <label
                  key={t.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                    targetId === t.id ? "border-[var(--error)] bg-[var(--error-soft)]" : "border-[var(--border)]"
                  }`}
                >
                  <input type="radio" name="review-remove-target" className="mt-1" checked={targetId === t.id} onChange={() => { setTargetId(t.id); setAcknowledged(false); }} />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-[var(--muted)]">{t.externalId} · {t.repositoryName}</span>
                    <span className="line-clamp-2 font-medium text-[var(--foreground)]">{t.title}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {target && other && (
            <div className="space-y-2 text-sm">
              <p className="text-[var(--foreground)]">
                <span className="font-semibold">{target.externalId}</span> “{target.title}” will be removed from this project. It is soft-deleted and the removal is recorded in the audit log.
              </p>
              <p className="text-[var(--muted)]">
                <span className="font-mono">{other.externalId}</span> “{other.title}” is not changed.
              </p>
              <label className="flex items-start gap-2 text-xs text-[var(--foreground)]">
                <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={busy} />
                I have compared these test cases and confirm {target.externalId} should be removed.
              </label>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={!target || !acknowledged || busy} onClick={() => void confirm()}>
              {busy ? "Removing..." : target ? `Remove ${target.externalId}` : "Remove test case"}
            </Button>
          </div>
        </div>
  );
}
