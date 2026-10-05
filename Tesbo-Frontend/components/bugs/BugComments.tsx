"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconMessage, IconPaperclip, IconPencil, IconTrash, IconX } from "@tabler/icons-react";
import {
  createBugComment,
  deleteBugComment,
  listBugComments,
  updateBugComment,
  type BugAttachment,
  type BugComment,
} from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import {
  EVIDENCE_ACCEPT_ATTRIBUTE,
  EVIDENCE_MAX_FILES_PER_REQUEST,
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

// Mirrors BUG_COMMENT_MAX_ATTACHMENTS in legacy.service.ts — one request's worth of files, per comment.
const MAX_COMMENT_FILES = EVIDENCE_MAX_FILES_PER_REQUEST;

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
    const problem = validateEvidenceFile(file);
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
      <Button type="button" size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
        <IconPaperclip size={14} /> Attach
      </Button>
    </>
  );
}

type EditState = { id: string; draft: string; removeIds: string[]; staged: File[]; rejections: string[] };

/**
 * Comments on one bug, at the bottom of Bug Details (side panel and full page). Flat, no replies or
 * resolve — a bug's status already says whether it is resolved. Comments are Markdown written with
 * a small rich-text editor and shown through the shared renderMarkdown; each can carry files. The
 * author may edit for an hour after posting; the author or a project owner/manager may delete at any
 * time. Render with `key={bugId}` so
 * switching bugs starts clean.
 */
export default function BugComments({
  projectId,
  bugId,
  onCommentAdded,
}: {
  projectId: string;
  bugId: string;
  /** Any comment change (add, edit, delete), so the Activity section beside this one re-reads. */
  onCommentAdded?: () => void;
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

  const [draft, setDraft] = useState("");
  // Bumped to remount (and so clear) the composer's editor once a comment is posted.
  const [composerKey, setComposerKey] = useState(0);
  const [staged, setStaged] = useState<File[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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

  function stageComposerFiles(files: File[]) {
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
      const created = await createBugComment(projectId, bugId, body, staged);
      // Appended from the POST response rather than refetched, so it shows the moment it is saved.
      setComments((prev) => [...prev, created]);
      setDraft("");
      setStaged([]);
      setRejections([]);
      setComposerKey((k) => k + 1);
      onCommentAdded?.();
    } catch (err) {
      // The draft and its files are kept, so a failed post can be retried without redoing either.
      setSubmitError(err instanceof Error ? err.message : "Failed to add comment.");
    } finally {
      setSubmitting(false);
    }
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
      setComments((prev) => prev.filter((c) => c.id !== target.id));
      if (editing?.id === target.id) setEditing(null);
      onCommentAdded?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete the comment.");
    } finally {
      setDeleting(false);
      setConfirmingDelete(null);
    }
  }

  const linkAction = "inline-flex items-center gap-1 text-[12px] text-[var(--muted)]";

  return (
    <section aria-label="Comments" className="border-t border-[var(--border)] pt-5">
      <h4 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        <IconMessage size={14} stroke={1.75} />
        Comments{!loading && !loadError && comments.length > 0 ? ` (${comments.length})` : ""}
      </h4>

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
      ) : comments.length === 0 ? (
        <p className="text-[13px] text-[var(--muted-soft)]">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => {
            const isAuthor = !!currentUserId && comment.authorId === currentUserId;
            const canEdit = isAuthor && Date.parse(comment.editableUntil) > now;
            const canDelete = isAuthor || moderator;
            const isEditing = editing?.id === comment.id;
            return (
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
                    {comment.isEdited && (
                      <span
                        data-testid="bug-comment-edited"
                        title={`Edited ${new Date(comment.updatedAt).toLocaleString()}`}
                        className="text-[11px] italic text-[var(--muted-soft)]"
                      >
                        Edited
                      </span>
                    )}
                    {!isEditing && (canEdit || canDelete) && (
                      <span className="ml-auto flex items-center gap-3">
                        {canEdit && (
                          <button type="button" aria-label="Edit this comment" onClick={() => startEdit(comment)} className={`${linkAction} hover:text-[var(--foreground)]`}>
                            <IconPencil size={12} /> Edit
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            // Named apart from the panel's own Edit/Delete (the bug's), which sit in the same region.
                            aria-label="Delete this comment"
                            onClick={() => setConfirmingDelete(comment)}
                            className={`${linkAction} hover:text-[var(--error-foreground)]`}
                          >
                            <IconTrash size={12} /> Delete
                          </button>
                        )}
                      </span>
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
                        ariaLabel="Edit comment"
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
                        <AttachButton
                          label="Attach files to this comment"
                          onFiles={(files) => stageEditFiles(comment, files)}
                        />
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
                        className="zyra-prose mt-1 break-words text-[13px] text-[var(--foreground)]"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }}
                      />
                      {comment.attachments.length > 0 && (
                        <div className="mt-2" data-testid="bug-comment-attachments">
                          <BugAttachments projectId={projectId} attachments={comment.attachments} readOnly />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
        <CommentEditor
          key={composerKey}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onPasteFiles={stageComposerFiles}
          members={members}
          ariaLabel="Add a comment"
          placeholder="Add a comment… Type @ to mention someone."
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
          <p role="alert" data-testid="bug-comment-error" className="mt-2 text-[13px] text-[var(--error-foreground)]">
            {submitError}
          </p>
        )}
        <div className="mt-2 flex items-center justify-end gap-2">
          <AttachButton label="Attach files to comment" onFiles={stageComposerFiles} />
          <Button size="sm" onClick={() => void submit()} disabled={submitting || !draft.trim()}>
            {submitting ? "Adding…" : "Add Comment"}
          </Button>
        </div>
      </div>

      <ConfirmModal
        open={!!confirmingDelete}
        title="Delete comment"
        message={
          confirmingDelete
            ? `Delete this comment${
                confirmingDelete.attachments.length
                  ? ` and its ${confirmingDelete.attachments.length} attachment${confirmingDelete.attachments.length === 1 ? "" : "s"}`
                  : ""
              }? This can't be undone.`
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
