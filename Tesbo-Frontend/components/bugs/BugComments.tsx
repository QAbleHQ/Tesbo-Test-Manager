"use client";

import { useCallback, useEffect, useState } from "react";
import { IconMessage } from "@tabler/icons-react";
import { createBugComment, listBugComments, type BugComment } from "@/lib/api";
import { Button } from "@/components/ui";
import { MemberAvatar } from "@/components/bugs/BugBadges";

/**
 * Comments on one bug, at the bottom of Bug Details (side panel and full page). Styled after the
 * Knowledge Base's DocumentComments, but flat: no replies, anchors or resolve — a bug's status
 * already says whether it is resolved. Render with `key={bugId}` so switching bugs starts clean.
 */
export default function BugComments({
  projectId,
  bugId,
  onCommentAdded,
}: {
  projectId: string;
  bugId: string;
  /** Lets the Activity section beside this one pick up the new "added a comment" entry. */
  onCommentAdded?: () => void;
}) {
  const [comments, setComments] = useState<BugComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await listBugComments(projectId, bugId);
      setComments(data.list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load comments.");
    } finally {
      setLoading(false);
    }
  }, [projectId, bugId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createBugComment(projectId, bugId, body);
      // Appended from the POST response rather than refetched, so it shows the moment it is saved.
      setComments((prev) => [...prev, created]);
      setDraft("");
      onCommentAdded?.();
    } catch (err) {
      // The draft is kept, so a failed post can be retried without retyping it.
      setSubmitError(err instanceof Error ? err.message : "Failed to add comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Comments" className="border-t border-[var(--border)] pt-5">
      <h4 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        <IconMessage size={14} stroke={1.75} />
        Comments{!loading && !loadError && comments.length > 0 ? ` (${comments.length})` : ""}
      </h4>

      {loading ? (
        <p className="text-[13px] text-[var(--muted)]">Loading comments…</p>
      ) : loadError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-[13px] text-[var(--error-foreground)]"
        >
          <span>Couldn&apos;t load comments: {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : comments.length === 0 ? (
        <p className="text-[13px] text-[var(--muted-soft)]">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              data-testid="bug-comment"
              className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
            >
              <MemberAvatar name={comment.authorName} seed={comment.authorId} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-[var(--foreground)]">{comment.authorName}</span>
                  <time dateTime={comment.createdAt} className="text-[11px] text-[var(--muted-soft)]">
                    {new Date(comment.createdAt).toLocaleString()}
                  </time>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-[var(--foreground)]">{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          aria-label="Add a comment"
          placeholder="Add a comment…"
          className="w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--foreground)] placeholder:text-[var(--muted-soft)] focus:border-[var(--brand-primary)] focus:outline-none"
        />
        {submitError && (
          <p role="alert" data-testid="bug-comment-error" className="mt-2 text-[13px] text-[var(--error-foreground)]">
            {submitError}
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void submit()} disabled={submitting || !draft.trim()}>
            {submitting ? "Adding…" : "Add Comment"}
          </Button>
        </div>
      </div>
    </section>
  );
}
