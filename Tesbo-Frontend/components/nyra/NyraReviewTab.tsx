"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { IconBook, IconCheck, IconPencil, IconRotate2, IconX } from "@tabler/icons-react";
import {
  approveNyraRun,
  getNyraDocumentPreview,
  NYRA_DOC_KINDS,
  NYRA_KINDS,
  reviewNyraItem,
  reviewNyraItems,
  type NyraApproval,
  type NyraDocPreview,
  type NyraEmbeddings,
  type NyraItem,
  type NyraKind,
  type NyraReviewStatus,
} from "@/lib/nyra";
import { Button, Card, FieldError, Input, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import NyraEditModal from "@/components/nyra/NyraEditModal";
import NyraItemCard from "@/components/nyra/NyraItemCard";
import NyraDocPreviewCard from "@/components/nyra/NyraDocPreview";

const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
type Filter = "waiting" | "all" | NyraReviewStatus;
const DOC_KIND_TABS = NYRA_KINDS.filter((k) => NYRA_DOC_KINDS.has(k.key));

/**
 * Review a finished scan's findings, then approve them into the Knowledge Base as ONE product document.
 * Only the findings that explain the product are reviewed here (screens, features, workflows, business
 * rules, and forms and the tech profile for the appendix); API calls, issues and test cases stay in the
 * report. Reviewing (Correct, Edit, Reject, Undo) is open to every project member; approving writes to
 * the Knowledge Base, so it is for owners and managers, and the server enforces both.
 */
export default function NyraReviewTab({
  projectId,
  nyraId,
  runId,
  items: allItems,
  approval,
  embeddings,
  canApprove,
  onItem,
  onApproved,
  onReload,
}: {
  projectId: string;
  nyraId: string;
  runId: string;
  items: NyraItem[];
  approval: NyraApproval | null;
  embeddings: NyraEmbeddings;
  canApprove: boolean;
  onItem: (item: NyraItem) => void;
  onApproved: (approval: NyraApproval, embeddings: NyraEmbeddings) => void;
  onReload: () => void;
}) {
  const items = useMemo(() => allItems.filter((i) => NYRA_DOC_KINDS.has(i.kind)), [allItems]);
  const [kind, setKind] = useState<NyraKind | "all">("all");
  const [filter, setFilter] = useState<Filter>("waiting");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NyraItem | null>(null);
  const [approving, setApproving] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [justApproved, setJustApproved] = useState<Array<{ documentId: string; title: string; count: number }> | null>(null);

  // The preview is rebuilt by the server after every decision (rev), so it is never a guess of the client's.
  const [rev, setRev] = useState(0);
  const [preview, setPreview] = useState<NyraDocPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setPreviewLoading(true);
    getNyraDocumentPreview(projectId, nyraId, runId, abort.signal)
      .then((p) => {
        setPreview(p);
        setPreviewError(null);
        // The warning is about the state it was raised for; a fresh preview decides again.
        if (!p.editedInKb) setConfirmReplace(false);
      })
      .catch((err) => !abort.signal.aborted && setPreviewError(errText(err, "Could not build the document preview.")))
      .finally(() => !abort.signal.aborted && setPreviewLoading(false));
    return () => abort.abort();
  }, [projectId, nyraId, runId, rev, approval?.approvedAt]);

  const counts = useMemo(() => {
    const c: Record<NyraReviewStatus, number> = { waiting: 0, correct: 0, edited: 0, rejected: 0 };
    for (const i of items) c[i.reviewStatus] += 1;
    return c;
  }, [items]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (kind === "all" || i.kind === kind) &&
        (filter === "all" || i.reviewStatus === filter) &&
        (!q || `${i.title} ${JSON.stringify(i.data)}`.toLowerCase().includes(q))
    );
  }, [items, kind, filter, query]);

  const id = (i: NyraItem) => `${i.kind}:${i.key}`;

  async function decide(item: NyraItem, status: NyraReviewStatus) {
    setBusy(id(item));
    setError(null);
    try {
      onItem(await reviewNyraItem(projectId, nyraId, runId, { kind: item.kind, key: item.key, status }));
      setRev((n) => n + 1);
    } catch (err) {
      setError(errText(err, "Could not save that decision."));
    } finally {
      setBusy(null);
    }
  }

  async function decideShown(status: "correct" | "rejected") {
    const targets = rows.filter((i) => i.reviewStatus === "waiting");
    if (!targets.length) return;
    setBusy("bulk");
    setError(null);
    try {
      // 500 is the server's limit per request.
      for (let at = 0; at < targets.length; at += 500) {
        await reviewNyraItems(projectId, nyraId, runId, { items: targets.slice(at, at + 500).map((i) => ({ kind: i.kind, key: i.key })), status });
      }
      onReload();
    } catch (err) {
      setError(errText(err, "Could not save those decisions."));
    } finally {
      setRev((n) => n + 1);
      setBusy(null);
    }
  }

  async function approve(replaceEdits = false) {
    setApproving(true);
    setError(null);
    try {
      const result = await approveNyraRun(projectId, nyraId, runId, replaceEdits);
      setJustApproved(result.documents.filter((d) => d.count > 0));
      setConfirmReplace(false);
      onApproved({ approvedAt: result.approvedAt, itemCount: result.itemCount, documents: result.documents }, result.embeddings);
    } catch (err) {
      setError(errText(err, "Could not approve the findings."));
      // The document may have been edited since the preview was built: ask the server again, which raises the warning.
      setRev((n) => n + 1);
    } finally {
      setApproving(false);
    }
  }

  const waitingShown = rows.filter((i) => i.reviewStatus === "waiting").length;
  const approvable = preview?.approvable ?? 0;
  const docLink = (documentId: string) => `/projects/${projectId}/knowledge-base/documents/${documentId}`;

  return (
    <div className="space-y-4">
      <Card className="p-5" data-testid="nyra-approval">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-[var(--foreground)]">Approve into the Knowledge Base</h3>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-[var(--muted)]">
              Findings you mark Correct or edit are combined into one document that explains the product: its features, journeys, screens and business rules. It is added to
              this project&apos;s Knowledge Base so Zyra and search can use it. Rejected and waiting findings are left out. Approving again updates the same document.
            </p>
          </div>
          {canApprove ? (
            <Button type="button" onClick={() => (preview?.editedInKb ? setConfirmReplace(true) : approve())} disabled={approving || approvable === 0 || confirmReplace}>
              <IconBook size={16} stroke={1.75} /> {approving ? "Approving…" : "Approve and add to Knowledge Base"}
            </Button>
          ) : (
            <span className="text-[12px] text-[var(--muted)]">Only owners and managers can approve.</span>
          )}
        </div>
        {canApprove && approvable === 0 && !previewLoading && (
          <p className="mt-2 text-[12px] text-[var(--muted)]">Mark at least one screen, feature, workflow or business rule Correct to approve.</p>
        )}
        {confirmReplace && (
          <div className="mt-3 rounded-lg border border-[var(--warning,#b7791f)]/50 px-3 py-3 text-[13px] text-[var(--foreground)]" role="alert" data-testid="nyra-replace-warning">
            This document was edited in the Knowledge Base after it was last approved. Approving again replaces those edits with the findings below.
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" onClick={() => approve(true)} disabled={approving}>
                Replace and approve
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmReplace(false)} disabled={approving}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {/* Vectors use this project's AI provider key when it can embed (OpenAI, Google, Mistral), else another such key in the workspace. */}
        <p
          data-testid="nyra-embeddings"
          className={`mt-3 text-[12px] ${embeddings.available ? "text-[var(--muted)]" : "text-[var(--warning-foreground,var(--muted))]"}`}
        >
          {embeddings.available
            ? embeddings.provider === "voyage"
              ? "Search vectors will be created with the platform's Voyage AI key."
              : `Search vectors will be created with your ${embeddings.provider} key.`
            : "No AI key that can create vectors is set up (OpenAI, Google or Mistral; Anthropic cannot). The approved document is saved and found by keyword search. Add such a key under AI Providers and it is indexed automatically."}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
          {(["waiting", "correct", "edited", "rejected"] as const).map((s) => (
            <span key={s} className="rounded-full bg-[var(--surface-secondary)] px-2.5 py-1 text-[var(--muted)]" data-testid={`nyra-count-${s}`}>
              {s[0].toUpperCase() + s.slice(1)} {counts[s]}
            </span>
          ))}
        </div>
        {counts.waiting > 0 && counts.correct + counts.edited > 0 && <p className="mt-2 text-[12px] text-[var(--muted)]">{counts.waiting} {counts.waiting === 1 ? "finding is" : "findings are"} still waiting and will not be added.</p>}
        {(justApproved || approval) && (
          <div className="mt-3 rounded-lg border border-[var(--success)]/40 bg-[var(--success-soft)] px-3 py-2 text-[13px] text-[var(--foreground)]" role="status">
            {approval ? `Approved ${formatDateTime(approval.approvedAt)}: ${approval.itemCount} ${approval.itemCount === 1 ? "finding is" : "findings are"} in the Knowledge Base.` : null}
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {(justApproved ?? approval!.documents.map((d) => ({ documentId: d.documentId, title: d.title, count: -1 }))).map((d) => (
                <li key={d.documentId}>
                  <Link href={docLink(d.documentId)} className="font-medium text-[var(--accent-light)] hover:underline">
                    {d.title}
                  </Link>
                  {d.count >= 0 && <span className="text-[var(--muted)]"> ({d.count})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {error && <FieldError>{error}</FieldError>}

      <div>
        <Button type="button" variant="secondary" size="sm" aria-expanded={showPreview} onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? "Hide document preview" : "Show document preview"}
        </Button>
      </div>
      {showPreview && <NyraDocPreviewCard preview={preview} loading={previewLoading} error={previewError} />}

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Kind of finding" className="flex flex-wrap gap-1">
          {[{ key: "all" as const, label: "All" }, ...DOC_KIND_TABS].map((k) => {
            const n = items.filter((i) => (k.key === "all" || i.kind === k.key) && (filter === "all" || i.reviewStatus === filter)).length;
            return (
              <button
                key={k.key}
                type="button"
                role="tab"
                aria-selected={kind === k.key}
                onClick={() => setKind(k.key)}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  kind === k.key ? "bg-[var(--brand-primary)] text-white" : "bg-[var(--surface-secondary)] text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {k.label} {n}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select aria-label="Show findings that are" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="w-40">
            <option value="waiting">Waiting</option>
            <option value="all">All</option>
            <option value="correct">Correct</option>
            <option value="edited">Edited</option>
            <option value="rejected">Rejected</option>
          </Select>
          <Input aria-label="Search findings" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} className="w-44" />
          {waitingShown > 0 && (
            <>
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => decideShown("correct")}>
                <IconCheck size={15} stroke={1.75} /> Mark {waitingShown} shown Correct
              </Button>
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => decideShown("rejected")}>
                <IconX size={15} stroke={1.75} /> Reject {waitingShown} shown
              </Button>
            </>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <Card className="p-5 text-sm text-[var(--muted)]">
          {items.length === 0 ? "This scan found nothing to review." : filter === "waiting" && !query ? "Nothing is waiting for review here." : "No findings match."}
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((i) => (
            <NyraItemCard
              key={id(i)}
              item={i}
              projectId={projectId}
              nyraId={nyraId}
              runId={runId}
              footer={
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] pt-3">
                  {i.reviewStatus !== "correct" && (
                    <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => decide(i, "correct")}>
                      <IconCheck size={14} stroke={1.75} /> Correct
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => setEditing(i)}>
                    <IconPencil size={14} stroke={1.75} /> Edit
                  </Button>
                  {i.reviewStatus !== "rejected" && (
                    <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => decide(i, "rejected")}>
                      <IconX size={14} stroke={1.75} /> Reject
                    </Button>
                  )}
                  {i.reviewStatus !== "waiting" && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => decide(i, "waiting")}>
                      <IconRotate2 size={14} stroke={1.75} /> Undo
                    </Button>
                  )}
                </div>
              }
            />
          ))}
        </div>
      )}

      <NyraEditModal
        item={editing}
        projectId={projectId}
        nyraId={nyraId}
        runId={runId}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          onItem(saved);
          setRev((n) => n + 1);
          setEditing(null);
        }}
      />
    </div>
  );
}
