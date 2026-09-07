"use client";

import { useEffect, useState } from "react";
import { IconCalendar, IconClock } from "@tabler/icons-react";
import { getKnowledgeDocumentHistory, type KnowledgeDocumentHistoryEntry } from "@/lib/api";
import { ChangeDiffModal } from "./ChangeDiffModal";

/**
 * The Change History timeline for one Knowledge Base document — shared between the knowledge-base
 * list's info-icon popover (ChangeHistoryTrigger, knowledge-base/page.tsx) and the document detail
 * page's "History" modal (documents/[documentId]/page.tsx). Renders the same shape for a synced
 * Jira/Linear mirror (the sync pipeline's own log) and a manually-created document (synthesized
 * from its version snapshots) — see getKnowledgeDocumentHistory in lib/api.ts.
 */

export const CHANGE_HISTORY_PAGE_SIZE = 5;

// A single field's before/after is only worth its own "View diff" button once it stops being a
// one-glance sentence — short single-field edits keep today's plain, button-less row.
const LARGE_CHANGE_THRESHOLD = 160;

// DD/MM/YYYY and 12-hour HH:MM:SS AM/PM — a fixed format, deliberately not locale-dependent.
function formatEventDate(value: string): string {
  const date = new Date(value);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  const hours24 = date.getHours();
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${String(hours12).padStart(2, "0")}:${mm}:${ss} ${period}`;
}

function isLargeChange(entry: KnowledgeDocumentHistoryEntry): boolean {
  if (!entry.changedFields.length) return false;
  if (entry.changedFields.length > 1) return true;
  return entry.changedFields.some((f) => f.oldLength + f.newLength > LARGE_CHANGE_THRESHOLD);
}

export function ChangeHistoryList({
  projectId,
  documentId,
  showHeading = true,
  onRestoreVersion,
  restoringVersionId = null,
}: {
  projectId: string;
  documentId: string;
  /** The popover has no surrounding chrome of its own and needs its own heading; a Modal usage
   *  already renders "Change history" in its title bar, so that caller passes false. */
  showHeading?: boolean;
  /** Only a manual document's version-diff entries carry a versionId to restore — the button never
   *  renders on any other row, so it's safe to always pass this (as the detail page's History
   *  modal does) rather than needing to know in advance whether this document is a mirror. */
  onRestoreVersion?: (entry: KnowledgeDocumentHistoryEntry) => void;
  /** Disables every row's Restore button while one restore is in flight. */
  restoringVersionId?: string | null;
}) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{ loading: boolean; events: KnowledgeDocumentHistoryEntry[]; hasMore: boolean; error: boolean }>({
    loading: true,
    events: [],
    hasMore: false,
    error: false,
  });
  const [diffEntry, setDiffEntry] = useState<KnowledgeDocumentHistoryEntry | null>(null);

  // Deliberately doesn't reset to `loading: true` before the fetch resolves: the previous page's
  // rows stay on screen until the new page arrives (typically near-instant, a single indexed
  // query), which reads as an instant page flip rather than a loading flash on every click.
  useEffect(() => {
    let cancelled = false;
    getKnowledgeDocumentHistory(projectId, documentId, { limit: CHANGE_HISTORY_PAGE_SIZE, offset: page * CHANGE_HISTORY_PAGE_SIZE })
      .then((res) => {
        if (!cancelled) setState({ loading: false, events: res.events, hasMore: res.hasMore, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, events: [], hasMore: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, page]);

  const showPager = !state.loading && !state.error && (page > 0 || state.hasMore);

  return (
    <div>
      {showHeading && (
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Change history</div>
      )}
      {state.loading ? (
        <div className="py-2 text-[12px] text-[var(--muted)]">Loading…</div>
      ) : state.error ? (
        <div className="py-2 text-[12px] text-[var(--error-foreground)]">Couldn&apos;t load change history.</div>
      ) : state.events.length === 0 ? (
        <div className="py-2 text-[12px] text-[var(--muted)]">
          {page === 0 ? "No change history recorded yet." : "No more changes."}
        </div>
      ) : (
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {state.events.map((event) => {
            const large = isLargeChange(event);
            return (
              <li key={event.id} className="rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-secondary)]/50 px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-[12px] font-medium text-[var(--foreground)]" title={`by ${event.actorName}`}>
                    {event.eventType === "created" ? "Added" : "Updated"}
                    <span className="font-normal text-[var(--muted)]"> · by {event.actorName}</span>
                  </div>
                  {onRestoreVersion && event.versionId && (
                    <button
                      type="button"
                      disabled={restoringVersionId !== null}
                      onClick={() => onRestoreVersion(event)}
                      className="shrink-0 text-[11px] font-medium text-[var(--accent-light)] hover:underline disabled:opacity-40 disabled:hover:no-underline"
                    >
                      {restoringVersionId === event.versionId ? "Restoring…" : "Restore"}
                    </button>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-[var(--muted)]">
                  <span className="flex items-center gap-1">
                    <IconCalendar size={12} stroke={1.75} />
                    {formatEventDate(event.createdAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <IconClock size={12} stroke={1.75} />
                    {formatEventTime(event.createdAt)}
                  </span>
                </div>
                {event.changedSummary && (
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted)]">
                    <span className="min-w-0 flex-1 truncate" title={event.changedSummary}>
                      {event.changedSummary}
                    </span>
                    {large && (
                      <button
                        type="button"
                        onClick={() => setDiffEntry(event)}
                        className="shrink-0 font-medium text-[var(--accent-light)] hover:underline"
                      >
                        View diff
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {showPager && (
        <div className="mt-2.5 flex items-center justify-between border-t border-[var(--border-subtle)] pt-2">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="text-[11px] font-medium text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:hover:text-[var(--muted)]"
          >
            Previous
          </button>
          <span className="text-[11px] text-[var(--muted-soft)]">Page {page + 1}</span>
          <button
            type="button"
            disabled={!state.hasMore}
            onClick={() => setPage((p) => p + 1)}
            className="text-[11px] font-medium text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:hover:text-[var(--muted)]"
          >
            Next
          </button>
        </div>
      )}
      {diffEntry && (
        <ChangeDiffModal
          open
          onClose={() => setDiffEntry(null)}
          title={`${diffEntry.eventType === "created" ? "Added" : "Updated"} by ${diffEntry.actorName} · ${formatEventDate(diffEntry.createdAt)} ${formatEventTime(diffEntry.createdAt)}`}
          fields={diffEntry.changedFields}
        />
      )}
    </div>
  );
}
