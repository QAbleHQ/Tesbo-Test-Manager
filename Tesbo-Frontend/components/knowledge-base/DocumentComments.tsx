"use client";

import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconMessage, IconTrash, IconCornerDownRight, IconRotate } from "@tabler/icons-react";
import {
  listKnowledgeDocumentComments,
  createKnowledgeDocumentComment,
  updateKnowledgeDocumentComment,
  deleteKnowledgeDocumentComment,
  type KnowledgeDocumentComment,
} from "@/lib/api";
import { Button } from "@/components/ui";
import { avatarColor } from "@/lib/avatarColors";
import { formatRelative } from "@/lib/date";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/*
 * Seeded per author's id (not name), so two commenters are told apart at a glance and one person
 * keeps the same colour they have on cycles, plan cards and the top bar. Was a flat --brand-soft
 * for everyone, then a name-only seed that could still disagree with the rest of the app — both
 * part of Basecamp 10198836413.
 */
function Avatar({ name, seed }: { name: string; seed?: string | null }) {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
      style={{ backgroundColor: avatarColor(seed || name || "?") }}
    >
      {initials(name)}
    </span>
  );
}

/**
 * Google-Docs-shaped discussion for one Knowledge Base document: anchored or document-level
 * threads, one level of replies, resolvable.
 *
 * Works on read-only documents by design — the body of a synced provider mirror is replaced on
 * every sync, but comments live in their own table, so this is where human input on a synced
 * ticket belongs (it replaced V72's per-ticket "Notes" document).
 */
export function DocumentComments({
  projectId,
  documentId,
  currentUserId,
  canModerate,
  pendingAnchor,
  onAnchorConsumed,
  onAnchorClick,
}: {
  projectId: string;
  documentId: string;
  currentUserId: string | null;
  /** Owners/managers may resolve and delete others' threads; everyone may edit only their own. */
  canModerate: boolean;
  /** Selection handed over by the document page's "Comment" button. */
  pendingAnchor: { text: string; start: number; end: number } | null;
  onAnchorConsumed: () => void;
  onAnchorClick: (anchorText: string) => void;
}) {
  const [threads, setThreads] = useState<KnowledgeDocumentComment[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listKnowledgeDocumentComments(projectId, documentId);
      setThreads(data.list);
      setOpenCount(data.openCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load comments.");
    } finally {
      setLoading(false);
    }
  }, [projectId, documentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submitThread() {
    const body = draft.trim();
    if (!body) return;
    setSubmitting(true);
    setError(null);
    try {
      await createKnowledgeDocumentComment(projectId, documentId, {
        body,
        ...(pendingAnchor
          ? { anchorText: pendingAnchor.text, anchorStart: pendingAnchor.start, anchorEnd: pendingAnchor.end }
          : {}),
      });
      setDraft("");
      onAnchorConsumed();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add comment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReply(parentCommentId: string) {
    const body = replyDraft.trim();
    if (!body) return;
    setSubmitting(true);
    setError(null);
    try {
      await createKnowledgeDocumentComment(projectId, documentId, { body, parentCommentId });
      setReplyDraft("");
      setReplyTo(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add reply.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleResolved(thread: KnowledgeDocumentComment) {
    setError(null);
    try {
      await updateKnowledgeDocumentComment(projectId, thread.id, { isResolved: !thread.isResolved });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update thread.");
    }
  }

  async function remove(comment: KnowledgeDocumentComment, isThread: boolean) {
    if (!window.confirm(isThread ? "Delete this thread and all its replies?" : "Delete this reply?")) return;
    setError(null);
    try {
      await deleteKnowledgeDocumentComment(projectId, comment.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete comment.");
    }
  }

  const canMutate = (comment: KnowledgeDocumentComment) => canModerate || (!!currentUserId && comment.authorId === currentUserId);
  const visible = showResolved ? threads : threads.filter((thread) => !thread.isResolved);
  const resolvedCount = threads.length - threads.filter((thread) => !thread.isResolved).length;

  return (
    <section className="mt-8 border-t border-[var(--border)] pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--foreground)]">
          <IconMessage size={17} stroke={1.75} />
          Comments
          {openCount > 0 && (
            <span className="rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-light)]">
              {openCount} open
            </span>
          )}
        </h2>
        {/*
          * Basecamp 10199290648 — reported as "resolving a comment deletes the comment and its
          * replies". Nothing is deleted: resolve sets is_resolved, the list endpoint still returns the
          * thread, and it can be reopened. But resolving HIDES it from the default view, and this
          * control used to be a 12px grey underlined link in the far corner — so when the resolved
          * thread was the last open one, the entire list emptied at once with only a faint link to say
          * where it went. That reads as destruction.
          *
          * Same behaviour, unmissable affordance: a real chip carrying the count, styled like the
          * "N open" chip beside it so the two read as two buckets rather than one disappearance.
          */}
        {resolvedCount > 0 && (
          <button
            type="button"
            data-testid="toggle-resolved-comments"
            aria-pressed={showResolved}
            title={showResolved ? "Hide resolved threads" : "Resolved threads are kept, not deleted — show them"}
            onClick={() => setShowResolved((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
              showResolved
                ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--accent-light)]"
                : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
            }`}
          >
            <IconCheck size={12} stroke={2} />
            {resolvedCount} resolved
            <span className="text-[var(--muted-soft)]">{showResolved ? "· hide" : "· show"}</span>
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-3 py-2 text-[13px] text-[var(--error-foreground)]">{error}</div>
      )}

      <div className="mb-5 rounded-[10px] border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
        {/* Selection captured in the body, shown so it's obvious what the comment will attach to. */}
        {pendingAnchor && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-[6px] border-l-2 border-[var(--brand-primary)] bg-[var(--surface)] px-2.5 py-1.5">
            <p className="line-clamp-2 text-[12px] italic text-[var(--muted)]">&ldquo;{pendingAnchor.text}&rdquo;</p>
            <button type="button" onClick={onAnchorConsumed} className="shrink-0 text-[11px] text-[var(--muted)] underline hover:text-[var(--foreground)]">
              Remove
            </button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder={pendingAnchor ? "Comment on the selected text…" : "Add a comment. Select text in the document to comment on a specific passage."}
          className="w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--foreground)] placeholder:text-[var(--muted-soft)] focus:border-[var(--brand-primary)] focus:outline-none"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={submitThread} disabled={submitting || !draft.trim()}>
            {submitting ? "Posting…" : pendingAnchor ? "Comment on selection" : "Comment"}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-[13px] text-[var(--muted)]">Loading comments…</p>
      ) : visible.length === 0 ? (
        <p className="text-[13px] text-[var(--muted)]">
          {threads.length === 0
            ? "No comments yet."
            : `No open comments — all ${resolvedCount} ${resolvedCount === 1 ? "thread is" : "threads are"} resolved. Nothing was deleted; use "${resolvedCount} resolved" above to see or reopen them.`}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((thread) => (
            <li
              key={thread.id}
              className={`rounded-[10px] border px-3.5 py-3 ${
                thread.isResolved ? "border-[var(--border-subtle)] bg-[var(--surface-secondary)]/50 opacity-75" : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {thread.anchorText && (
                <button
                  type="button"
                  onClick={() => onAnchorClick(thread.anchorText!)}
                  title="Jump to this passage in the document"
                  className="mb-2 block w-full rounded-[6px] border-l-2 border-[var(--brand-primary)] bg-[var(--brand-soft)]/40 px-2.5 py-1.5 text-left"
                >
                  <span className="line-clamp-2 text-[12px] italic text-[var(--muted)]">&ldquo;{thread.anchorText}&rdquo;</span>
                </button>
              )}

              <div className="flex items-start gap-2.5">
                <Avatar name={thread.authorName} seed={thread.authorId} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-[var(--foreground)]">{thread.authorName}</span>
                    <span className="text-[11px] text-[var(--muted-soft)]">{formatRelative(thread.createdAt)}</span>
                    {thread.isResolved && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--success-foreground)]">
                        <IconCheck size={10} /> Resolved{thread.resolvedByName ? ` by ${thread.resolvedByName}` : ""}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] text-[var(--foreground)]">{thread.body}</p>

                  <div className="mt-1.5 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setReplyTo(replyTo === thread.id ? null : thread.id);
                        setReplyDraft("");
                      }}
                      className="text-[12px] text-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      Reply
                    </button>
                    {canMutate(thread) && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleResolved(thread)}
                          className="inline-flex items-center gap-1 text-[12px] text-[var(--muted)] hover:text-[var(--foreground)]"
                        >
                          {thread.isResolved ? <><IconRotate size={12} /> Reopen</> : <><IconCheck size={12} /> Resolve</>}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(thread, true)}
                          className="inline-flex items-center gap-1 text-[12px] text-[var(--muted)] hover:text-[var(--error-foreground)]"
                        >
                          <IconTrash size={12} /> Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {thread.replies.length > 0 && (
                <ul className="mt-3 space-y-2.5 border-l border-[var(--border-subtle)] pl-3">
                  {thread.replies.map((reply) => (
                    <li key={reply.id} className="flex items-start gap-2.5">
                      <Avatar name={reply.authorName} seed={reply.authorId} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-semibold text-[var(--foreground)]">{reply.authorName}</span>
                          <span className="text-[11px] text-[var(--muted-soft)]">{formatRelative(reply.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-[var(--foreground)]">{reply.body}</p>
                        {canMutate(reply) && (
                          <button
                            type="button"
                            onClick={() => remove(reply, false)}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--muted)] hover:text-[var(--error-foreground)]"
                          >
                            <IconTrash size={11} /> Delete
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {replyTo === thread.id && (
                <div className="mt-3 border-l border-[var(--border-subtle)] pl-3">
                  <textarea
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value)}
                    rows={2}
                    autoFocus
                    placeholder="Reply…"
                    className="w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--foreground)] placeholder:text-[var(--muted-soft)] focus:border-[var(--brand-primary)] focus:outline-none"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button size="sm" onClick={() => submitReply(thread.id)} disabled={submitting || !replyDraft.trim()}>
                      <IconCornerDownRight size={13} /> {submitting ? "Posting…" : "Reply"}
                    </Button>
                    <button type="button" onClick={() => setReplyTo(null)} className="text-[12px] text-[var(--muted)] hover:text-[var(--foreground)]">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
