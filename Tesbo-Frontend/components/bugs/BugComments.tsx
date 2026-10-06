"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconCornerDownRight, IconPaperclip, IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import {
  createBugComment,
  deleteBugComment,
  listBugComments,
  updateBugComment,
  type BugAttachment,
  type BugComment,
} from "@/lib/api";
import { renderCommentMarkdown } from "@/lib/commentMarkdown";
import { formatAbsolute } from "@/components/activity/activityShared";
import {
  EVIDENCE_ACCEPT_ATTRIBUTE,
  BUG_FILE_MAX_SIZE,
  BUG_MAX_ATTACHMENTS,
  formatFileSizeShort,
  validateEvidenceFile,
} from "@/lib/validation";
import { Button, ConfirmModal } from "@/components/ui";
import { MemberAvatar } from "@/components/bugs/BugBadges";
import BugAttachments, { isImageAttachment } from "@/components/bugs/BugAttachments";
import CommentEditor, { type MentionMember } from "@/components/bugs/CommentEditor";
import { StagedThumbnail } from "@/components/BugEvidenceField";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

// Mirrors BUG_COMMENT_MAX_ATTACHMENTS and BUG_FILE_MAX_SIZE in legacy.service.ts: per comment or
// reply, ten files of at most 20MB each.
const MAX_COMMENT_FILES = BUG_MAX_ATTACHMENTS;

/** Same collapse as the backend's normalizeRole: owners and managers may delete anyone's comment. */
function canModerate(role: string | undefined): boolean {
  const n = (role ?? "").trim().toLowerCase().replace(/[- ]/g, "_");
  return n === "owner" || n === "manager" || n === "admin" || n === "test_manager";
}

/**
 * Checks picked or pasted files the way the server will (type, size, count), so a bad file is named
 * the moment it is chosen. Valid files in the same selection are still kept.
 */
function acceptFiles(picked: File[], alreadyAttached: number): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of picked) {
    const problem = validateEvidenceFile(file, BUG_FILE_MAX_SIZE);
    if (problem) rejected.push(problem);
    else if (alreadyAttached + accepted.length >= MAX_COMMENT_FILES) rejected.push(`${file.name}: a comment can have at most ${MAX_COMMENT_FILES} attachments.`);
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** Files waiting to be saved with a comment (new picks), plus — while editing — the ones it already has. */
function CommentFiles({
  existing = [],
  onRemoveExisting,
  staged,
  onRemoveStaged,
  rejections,
}: {
  existing?: BugAttachment[];
  onRemoveExisting?: (id: string) => void;
  staged: File[];
  onRemoveStaged: (index: number) => void;
  rejections: string[];
}) {
  if (!existing.length && !staged.length && !rejections.length) return null;
  const row = "flex items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[12.5px]";
  return (
    <div className="mt-2 space-y-1">
      <ul className="space-y-1">
        {existing.map((att) => (
          <li key={att.id} data-testid="bug-comment-existing-file" className={row}>
            <span className="min-w-0 flex-1 truncate">{att.fileName}</span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">{formatFileSizeShort(att.fileSize)}</span>
            <button type="button" aria-label={`Remove ${att.fileName}`} onClick={() => onRemoveExisting?.(att.id)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
              <IconX size={13} />
            </button>
          </li>
        ))}
        {staged.map((file, index) => (
          <li key={`${file.name}-${index}`} data-testid="bug-comment-staged-file" className={row}>
            {isImageAttachment({ fileName: file.name, contentType: file.type }) && <StagedThumbnail file={file} />}
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">{formatFileSizeShort(file.size)}</span>
            <button type="button" aria-label={`Remove ${file.name}`} onClick={() => onRemoveStaged(index)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
              <IconX size={13} />
            </button>
          </li>
        ))}
      </ul>
      {rejections.length > 0 && (
        <ul data-testid="bug-comment-file-rejections" className="space-y-1">
          {rejections.map((message) => (
            <li key={message} className="text-[12.5px] text-[var(--error-foreground)]">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The paperclip button and the hidden input behind it. */
function AttachButton({ label, onFiles }: { label: string; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={EVIDENCE_ACCEPT_ATTRIBUTE}
        aria-label={label}
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => inputRef.current?.click()}
        title={`Up to ${MAX_COMMENT_FILES} files, ${formatFileSizeShort(BUG_FILE_MAX_SIZE)} each`}
      >
        <IconPaperclip size={14} /> Attach
      </Button>
    </>
  );
}

type EditState = { id: string; draft: string; removeIds: string[]; staged: File[]; rejections: string[] };

type ComposerLabels = {
  box: string;
  placeholder: string;
  attach: string;
  submit: string;
  submitting: string;
  errorTestId: string;
};

/**
 * The write box — the one at the foot of the list, and the one under a thread when replying. Owns
 * its draft and staged files, so a failed post keeps both for a retry, and a reply box opening or
 * closing never disturbs the main one.
 */
function CommentComposer({
  projectId,
  bugId,
  members,
  parentCommentId = null,
  labels,
  autoFocus = false,
  onPosted,
  onCancel,
}: {
  projectId: string;
  bugId: string;
  members: MentionMember[];
  /** Set for a reply: always the thread's top-level comment. */
  parentCommentId?: string | null;
  labels: ComposerLabels;
  autoFocus?: boolean;
  onPosted: (created: BugComment) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState("");
  // Bumped to remount (and so clear) the editor once the post is saved.
  const [editorKey, setEditorKey] = useState(0);
  const [staged, setStaged] = useState<File[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function stage(files: File[]) {
    const { accepted, rejected } = acceptFiles(files, staged.length);
    setRejections(rejected);
    if (accepted.length) setStaged((prev) => [...prev, ...accepted]);
  }

  async function submit() {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createBugComment(projectId, bugId, body, staged, parentCommentId);
      setDraft("");
      setStaged([]);
      setRejections([]);
      setEditorKey((k) => k + 1);
      onPosted(created);
    } catch (err) {
      // The draft and its files are kept, so a failed post can be retried without redoing either.
      setSubmitError(err instanceof Error ? err.message : "Failed to add comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
      <CommentEditor
        key={editorKey}
        onChange={setDraft}
        onSubmit={() => void submit()}
        onPasteFiles={stage}
        members={members}
        ariaLabel={labels.box}
        placeholder={labels.placeholder}
        autoFocus={autoFocus}
      />
      <CommentFiles
        staged={staged}
        onRemoveStaged={(index) => {
          setRejections([]);
          setStaged((prev) => prev.filter((_, i) => i !== index));
        }}
        rejections={rejections}
      />
      {submitError && (
        <p role="alert" data-testid={labels.errorTestId} className="mt-2 text-[13px] text-[var(--error-foreground)]">
          {submitError}
        </p>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <AttachButton label={labels.attach} onFiles={stage} />
        {onCancel && (
          <Button size="sm" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={() => void submit()} disabled={submitting || !draft.trim()}>
          {submitting ? labels.submitting : labels.submit}
        </Button>
      </div>
    </div>
  );
}

const COMMENT_COMPOSER_LABELS: ComposerLabels = {
  box: "Add a comment",
  placeholder: "Add a comment… Type @ to mention someone.",
  attach: "Attach files to comment",
  submit: "Add Comment",
  submitting: "Adding…",
  errorTestId: "bug-comment-error",
};

const REPLY_COMPOSER_LABELS: ComposerLabels = {
  box: "Write a reply",
  placeholder: "Reply… Type @ to mention someone.",
  attach: "Attach files to reply",
  submit: "Reply",
  submitting: "Replying…",
  errorTestId: "bug-comment-reply-error",
};

/** "and its 2 replies and 1 attachment", or "" — what else a delete takes with it. */
function deleteExtras(replies: number, attachments: number): string {
  const parts = [
    replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "",
    attachments ? `${attachments} attachment${attachments === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? ` and its ${parts.join(" and ")}` : "";
}

/**
 * Comments on one bug, at the bottom of Bug Details (side panel and full page), with replies one
 * level deep beneath each. No resolve — a bug's status already says whether it is resolved.
 * Comments and replies are Markdown written with a small rich-text editor and shown through the
 * shared renderMarkdown; each can carry files. The author may edit for an hour after posting; the
 * author or a project owner/manager may delete at any time, and deleting a comment deletes its
 * replies. Render with `key={bugId}` so switching bugs starts clean.
 */
export default function BugComments({
  projectId,
  bugId,
  onCommentAdded,
  onCountChange,
}: {
  projectId: string;
  bugId: string;
  /** Any comment change (add, reply, edit, delete), so the Activity tab re-reads. */
  onCommentAdded?: () => void;
  /** Comments plus replies, for the tab label; null while loading or after a failed load. */
  onCountChange?: (count: number | null) => void;
}) {
  const { currentUser } = useAppData();
  const { projectMembers } = useProjectData();
  const currentUserId = currentUser?.userId ?? null;
  const moderator = canModerate(projectMembers.find((m) => m.userId === currentUserId)?.role);
  const members: MentionMember[] = useMemo(
    () => projectMembers.map((m) => ({ userId: m.userId, name: m.name, email: m.email })),
    [projectMembers]
  );

  const [comments, setComments] = useState<BugComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The top-level comment whose reply box is open; one at a time.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const [editing, setEditing] = useState<EditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState<BugComment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  // Counts replies too: everything said on the bug.
  const count = loading || loadError ? null : comments.length;
  useEffect(() => {
    onCountChange?.(count);
  }, [count, onCountChange]);

  // Edit is offered only inside the hour after posting. Re-render when the soonest of your own open
  // windows closes, so the button disappears on time rather than on the next unrelated render. A
  // save already underway past the deadline is refused by the server, and its reason shown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const next = comments
      .filter((c) => c.authorId === currentUserId)
      .map((c) => Date.parse(c.editableUntil))
      .filter((until) => until > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0) + 250, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [comments, currentUserId, now]);

  // The list arrives flat and oldest first, so grouping by parent keeps each thread in date order.
  // A new post is appended, which is also its place in time.
  const { roots, repliesOf } = useMemo(() => {
    const repliesOf = new Map<string, BugComment[]>();
    for (const c of comments) {
      if (!c.parentCommentId) continue;
      repliesOf.set(c.parentCommentId, [...(repliesOf.get(c.parentCommentId) ?? []), c]);
    }
    return { roots: comments.filter((c) => !c.parentCommentId), repliesOf };
  }, [comments]);

  function posted(created: BugComment) {
    // Appended from the POST response rather than refetched, so it shows the moment it is saved.
    setComments((prev) => [...prev, created]);
    if (created.parentCommentId) setReplyingTo(null);
    onCommentAdded?.();
  }

  function startEdit(comment: BugComment) {
    setEditError(null);
    setActionError(null);
    setEditing({ id: comment.id, draft: comment.body, removeIds: [], staged: [], rejections: [] });
  }

  function stageEditFiles(comment: BugComment, files: File[]) {
    if (!editing) return;
    const kept = comment.attachments.length - editing.removeIds.length + editing.staged.length;
    const { accepted, rejected } = acceptFiles(files, kept);
    setEditing((prev) => (prev ? { ...prev, staged: [...prev.staged, ...accepted], rejections: rejected } : prev));
  }

  async function saveEdit(comment: BugComment) {
    if (!editing || savingEdit) return;
    const body = editing.draft.trim();
    if (!body) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const updated = await updateBugComment(projectId, bugId, comment.id, {
        body,
        removeAttachmentIds: editing.removeIds,
        files: editing.staged,
      });
      setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditing(null);
      onCommentAdded?.();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save the comment.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function confirmDelete() {
    if (!confirmingDelete || deleting) return;
    const target = confirmingDelete;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteBugComment(projectId, bugId, target.id);
      // A top-level comment goes with its replies, as the server deleted them too.
      const gone = (c: BugComment) => c.id === target.id || c.parentCommentId === target.id;
      setComments((prev) => prev.filter((c) => !gone(c)));
      if (editing && comments.some((c) => c.id === editing.id && gone(c))) setEditing(null);
      if (replyingTo === target.id) setReplyingTo(null);
      onCommentAdded?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete the comment.");
    } finally {
      setDeleting(false);
      setConfirmingDelete(null);
    }
  }

  // Quiet text actions under the body, as in most threads: they never wrap onto their own line
  // above the text, and they read as part of the comment rather than as a toolbar.
  const action =
    "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[12px] font-medium text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)]";

  // Highlighted the same way Activity shows "@Name": the names and emails the server matches.
  const mentionLabels = useMemo(() => projectMembers.flatMap((m) => [m.name, m.email]).filter(Boolean), [projectMembers]);

  /** One comment or reply: author line, the body (or the editor while editing it), then actions. */
  function renderComment(comment: BugComment) {
    const isReply = !!comment.parentCommentId;
    const noun = isReply ? "reply" : "comment";
    const isAuthor = !!currentUserId && comment.authorId === currentUserId;
    const canEdit = isAuthor && Date.parse(comment.editableUntil) > now;
    const canDelete = isAuthor || moderator;
    const isEditing = editing?.id === comment.id;
    // Reply on a reply joins the same thread: threads are one level deep.
    const threadId = comment.parentCommentId ?? comment.id;
    return (
      <div className="flex items-start gap-2.5">
        <MemberAvatar name={comment.authorName} seed={comment.authorId} size={isReply ? 22 : 28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold text-[var(--foreground)]">{comment.authorName}</span>
            {/* Same short form as the Activity column beside this; the full time is on hover. */}
            <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()} className="text-[11.5px] text-[var(--muted-soft)]">
              {formatAbsolute(comment.createdAt)}
            </time>
            {comment.isEdited && (
              <>
                <span aria-hidden className="text-[11.5px] text-[var(--muted-soft)]">·</span>
                <span
                  data-testid="bug-comment-edited"
                  title={`Edited ${new Date(comment.updatedAt).toLocaleString()}`}
                  className="text-[11.5px] text-[var(--muted-soft)]"
                >
                  Edited
                </span>
              </>
            )}
          </div>

          {isEditing && editing ? (
            <div className="mt-2">
              <CommentEditor
                key={`edit-${comment.id}`}
                initialMarkdown={comment.body}
                onChange={(markdown) => setEditing((prev) => (prev ? { ...prev, draft: markdown } : prev))}
                onSubmit={() => void saveEdit(comment)}
                onPasteFiles={(files) => stageEditFiles(comment, files)}
                members={members}
                ariaLabel={`Edit ${noun}`}
                autoFocus
              />
              <CommentFiles
                existing={comment.attachments.filter((att) => !editing.removeIds.includes(att.id))}
                onRemoveExisting={(id) => setEditing((prev) => (prev ? { ...prev, removeIds: [...prev.removeIds, id] } : prev))}
                staged={editing.staged}
                onRemoveStaged={(index) =>
                  setEditing((prev) => (prev ? { ...prev, staged: prev.staged.filter((_, i) => i !== index), rejections: [] } : prev))
                }
                rejections={editing.rejections}
              />
              {editError && (
                <p role="alert" data-testid="bug-comment-edit-error" className="mt-2 text-[13px] text-[var(--error-foreground)]">
                  {editError}
                </p>
              )}
              <div className="mt-2 flex items-center justify-end gap-2">
                <AttachButton label={`Attach files to this ${noun}`} onFiles={(files) => stageEditFiles(comment, files)} />
                <Button size="sm" variant="secondary" onClick={() => setEditing(null)} disabled={savingEdit}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void saveEdit(comment)} disabled={savingEdit || !editing.draft.trim()}>
                  {savingEdit ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* renderMarkdown escapes the text before adding any markup, so this is safe to inject. */}
              <div
                data-testid="bug-comment-body"
                className="zyra-prose mt-0.5 break-words text-[13.5px] leading-[1.55] text-[var(--foreground)]"
                dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(comment.body, mentionLabels) }}
              />
              {comment.attachments.length > 0 && (
                <div className="mt-2" data-testid="bug-comment-attachments">
                  <BugAttachments projectId={projectId} attachments={comment.attachments} readOnly />
                </div>
              )}
              <div className="-ml-1 mt-1.5 flex items-center gap-1">
                <button
                  type="button"
                  // Named apart from the panel's own Edit/Delete (the bug's), which sit in the same
                  // region, and a reply's apart from its thread's.
                  aria-label={isReply ? "Reply in this thread" : "Reply to this comment"}
                  onClick={() => setReplyingTo(threadId)}
                  className={`${action} hover:text-[var(--foreground)]`}
                >
                  <IconCornerDownRight size={13} /> Reply
                </button>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Edit this ${noun}`}
                    onClick={() => startEdit(comment)}
                    className={`${action} hover:text-[var(--foreground)]`}
                  >
                    <IconPencil size={13} /> Edit
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete this ${noun}`}
                    onClick={() => setConfirmingDelete(comment)}
                    className={`${action} hover:text-[var(--error-foreground)]`}
                  >
                    <IconTrash size={13} /> Delete
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const deletingReplies = confirmingDelete ? (repliesOf.get(confirmingDelete.id) ?? []) : [];
  const deletingFiles = confirmingDelete
    ? confirmingDelete.attachments.length + deletingReplies.reduce((sum, reply) => sum + reply.attachments.length, 0)
    : 0;
  const deletingNoun = confirmingDelete?.parentCommentId ? "reply" : "comment";

  return (
    // Titled by its tab in BugDiscussion, which also shows the count.
    <section aria-label="Comments">

      {actionError && (
        <p role="alert" data-testid="bug-comment-action-error" className="mb-2 text-[13px] text-[var(--error-foreground)]">
          {actionError}
        </p>
      )}

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
      ) : roots.length === 0 ? (
        <p className="text-[13px] text-[var(--muted-soft)]">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {roots.map((root) => {
            const replies = repliesOf.get(root.id) ?? [];
            return (
              <li
                key={root.id}
                data-testid="bug-comment"
                className="rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5"
              >
                {renderComment(root)}
                {(replies.length > 0 || replyingTo === root.id) && (
                  // Indented to line up under the comment text (28px avatar + 10px gap), with a rail
                  // that ties the replies to the comment they answer.
                  <div className="ml-[38px] mt-3 space-y-3 border-l-2 border-[var(--border-subtle)] pl-4">
                    {replies.length > 0 && (
                      <ul aria-label="Replies" className="space-y-3.5">
                        {replies.map((reply) => (
                          <li key={reply.id} data-testid="bug-comment-reply">
                            {renderComment(reply)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {replyingTo === root.id && (
                      <CommentComposer
                        key={root.id}
                        projectId={projectId}
                        bugId={bugId}
                        members={members}
                        parentCommentId={root.id}
                        labels={REPLY_COMPOSER_LABELS}
                        autoFocus
                        onPosted={posted}
                        onCancel={() => setReplyingTo(null)}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4">
        <CommentComposer projectId={projectId} bugId={bugId} members={members} labels={COMMENT_COMPOSER_LABELS} onPosted={posted} />
      </div>

      <ConfirmModal
        open={!!confirmingDelete}
        title={`Delete ${deletingNoun}`}
        message={
          confirmingDelete
            ? `Delete this ${deletingNoun}${deleteExtras(deletingReplies.length, deletingFiles)}? This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDelete(null)}
      />
    </section>
  );
}
