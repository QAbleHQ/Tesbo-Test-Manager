"use client";

import { useState } from "react";
import { IconDownload, IconExternalLink, IconEye, IconFileText, IconTrash, IconX } from "@tabler/icons-react";
import { deleteBugAttachment, getBugAttachmentDownloadUrl, type BugAttachment } from "@/lib/api";
import { Button, ConfirmModal, Modal } from "@/components/ui";
import { formatFileSizeShort } from "@/lib/validation";

/*
 * Attachments in Bug Details (side panel and full page). Images show as thumbnails with an in-app
 * preview; other files keep the filename link. Every file can be opened and deleted.
 *
 * Thumbnails and the preview load the existing download route directly. It always answers with
 * Content-Disposition: attachment, which an <img> ignores but a browser tab does not, so an image
 * opened in a new tab would download rather than display. That is why images get the in-app
 * preview and why non-images keep the existing "open = download" link (a PDF included).
 * Deleting uses the same DELETE the Edit Bug form's evidence field already calls.
 */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isImageAttachment(att: Pick<BugAttachment, "fileName" | "contentType">): boolean {
  if (att.contentType && IMAGE_TYPES.has(att.contentType.toLowerCase())) return true;
  const ext = att.fileName.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

type BugAttachmentsProps = {
  projectId: string;
  attachments: BugAttachment[];
  /** Called once the server has deleted an attachment, so the caller can refresh its bug. */
  onDeleted?: (attachmentId: string) => void;
  /**
   * A comment's files reuse this view read-only: no "Attachments (n)" heading, and no Delete — those
   * files are removed by editing the comment, under the comment's permissions.
   */
  readOnly?: boolean;
};

export default function BugAttachments({ projectId, attachments, onDeleted, readOnly = false }: BugAttachmentsProps) {
  const [viewing, setViewing] = useState<BugAttachment | null>(null);
  const [confirming, setConfirming] = useState<BugAttachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const images = attachments.filter(isImageAttachment);
  const files = attachments.filter((att) => !isImageAttachment(att));

  async function handleDelete() {
    if (!confirming || deleting) return;
    const target = confirming;
    setDeleting(true);
    setError(null);
    try {
      await deleteBugAttachment(target.id);
      setConfirming(null);
      if (viewing?.id === target.id) setViewing(null);
      onDeleted?.(target.id);
    } catch (err) {
      setConfirming(null);
      setError(err instanceof Error ? err.message : `Couldn't delete ${target.fileName}.`);
    } finally {
      setDeleting(false);
    }
  }

  const iconButton =
    "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--surface-raised)]";

  return (
    <div>
      {!readOnly && (
        <p className="text-xs font-medium text-[var(--muted)] uppercase tracking-wide mb-1">
          Attachments <span className="text-[var(--muted-soft)]">({attachments.length})</span>
        </p>
      )}

      {error && (
        <p role="alert" data-testid="bug-attachment-error" className="mb-2 text-[13px] text-[var(--error-foreground)]">
          {error}
        </p>
      )}

      {images.length > 0 && (
        <ul className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
          {images.map((att) => (
            <li
              key={att.id}
              data-testid="bug-attachment-image"
              className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)]"
            >
              <button
                type="button"
                onClick={() => setViewing(att)}
                aria-label={`View ${att.fileName}`}
                className="block w-full transition-opacity hover:opacity-90"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={getBugAttachmentDownloadUrl(projectId, att.id)}
                  alt={att.fileName}
                  loading="lazy"
                  className="h-20 w-full object-cover"
                />
              </button>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--foreground)]" title={att.fileName}>
                  {att.fileName}
                </span>
                <button type="button" onClick={() => setViewing(att)} aria-label={`View ${att.fileName}`} title="View" className={`${iconButton} hover:text-[var(--accent-light)]`}>
                  <IconEye size={15} />
                </button>
                {!readOnly && (
                  <button type="button" onClick={() => setConfirming(att)} aria-label={`Delete ${att.fileName}`} title="Delete" className={`${iconButton} hover:text-[var(--error-foreground)]`}>
                    <IconTrash size={15} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((att) => (
            <li key={att.id} data-testid="bug-attachment-file" className="flex items-center gap-1.5">
              <IconFileText size={15} className="shrink-0 text-[var(--muted)]" />
              <a
                href={getBugAttachmentDownloadUrl(projectId, att.id)}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-[var(--accent-light)] hover:underline"
                title={att.fileName}
              >
                {att.fileName}
              </a>
              {att.fileSize > 0 && (
                <span className="shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">{formatFileSizeShort(att.fileSize)}</span>
              )}
              <a
                href={getBugAttachmentDownloadUrl(projectId, att.id)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${att.fileName}`}
                title="Open"
                className={`${iconButton} hover:text-[var(--accent-light)]`}
              >
                <IconExternalLink size={15} />
              </a>
              {!readOnly && (
                <button type="button" onClick={() => setConfirming(att)} aria-label={`Delete ${att.fileName}`} title="Delete" className={`${iconButton} hover:text-[var(--error-foreground)]`}>
                  <IconTrash size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Image preview. Shared Modal, sized like the Knowledge Base file viewer. */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} className="max-w-4xl">
        {viewing && (
          <section aria-label="Attachment preview" className="flex max-h-[75vh] flex-col">
            <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
              <h2 className="truncate text-[16px] font-semibold text-[var(--foreground)]">{viewing.fileName}</h2>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={getBugAttachmentDownloadUrl(projectId, viewing.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                >
                  <IconDownload size={14} /> Download
                </a>
                {!readOnly && (
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(viewing)}>
                    <IconTrash size={14} /> Delete
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setViewing(null)}
                  aria-label="Close preview"
                  className="rounded p-1.5 text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconX size={16} />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={getBugAttachmentDownloadUrl(projectId, viewing.id)}
                alt={viewing.fileName}
                className="max-h-[65vh] max-w-full object-contain"
              />
            </div>
          </section>
        )}
      </Modal>

      <ConfirmModal
        open={!!confirming}
        title="Delete attachment"
        message={confirming ? `Delete "${confirming.fileName}" from this bug? This can't be undone.` : ""}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
