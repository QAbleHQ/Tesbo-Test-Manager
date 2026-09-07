"use client";

import Modal from "@/components/ui/Modal";
import type { KnowledgeChangedField } from "@/lib/api";

/**
 * The "View diff" popup for a Change History entry — old vs new text per changed field. Kept out
 * of ChangeHistoryList's own row so a 500-char description edit never grows the compact timeline
 * itself; the row stays a one-line badge and this is opened on demand.
 */
export function ChangeDiffModal({
  open,
  onClose,
  title,
  fields,
}: {
  open: boolean;
  onClose: () => void;
  /** e.g. "Updated by Namrata Gosai on 02/09/2026" — shown once, above every field. */
  title: string;
  fields: KnowledgeChangedField[];
}) {
  return (
    <Modal open={open} onClose={onClose} title="View diff" className="max-w-[640px]">
      <p className="mb-3 text-[12px] text-[var(--muted)]">{title}</p>
      <div className="space-y-4">
        {fields.map((field, i) => (
          <div key={`${field.label}-${i}`}>
            <div className="mb-1 text-[12px] font-semibold text-[var(--foreground)]">{field.label}</div>
            <div className="space-y-1.5">
              {field.oldExcerpt && (
                <div className="whitespace-pre-wrap rounded-[6px] border border-[var(--error)]/25 bg-[var(--error-soft)] px-2.5 py-1.5 text-[12px] text-[var(--error-foreground)]">
                  − {field.oldExcerpt}
                </div>
              )}
              {field.newExcerpt && (
                <div className="whitespace-pre-wrap rounded-[6px] border border-[var(--success)]/25 bg-[var(--success-soft)] px-2.5 py-1.5 text-[12px] text-[var(--success-foreground)]">
                  + {field.newExcerpt}
                </div>
              )}
              {!field.oldExcerpt && !field.newExcerpt && (
                <div className="text-[12px] text-[var(--muted)]">No visible text — this field was cleared.</div>
              )}
            </div>
            {field.truncated && (
              <p className="mt-1 text-[11px] text-[var(--muted-soft)]">
                Showing the first {Math.max(field.oldExcerpt.length, field.newExcerpt.length).toLocaleString()} of{" "}
                {Math.max(field.oldLength, field.newLength).toLocaleString()} characters.
              </p>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
