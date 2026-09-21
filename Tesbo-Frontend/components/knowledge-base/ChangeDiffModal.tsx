"use client";

import Modal from "@/components/ui/Modal";
import type { KnowledgeChangedField } from "@/lib/api";
import { formatEventDate, formatEventTime } from "./ChangeHistory";

/**
 * The "View diff" popup for a Change History entry — old vs new text per changed field. Kept out
 * of ChangeHistoryList's own row so a 500-char description edit never grows the compact timeline
 * itself; the row stays a one-line badge and this is opened on demand.
 */

// A field's label is usually a plain heading word ("Title", "Description", "Comments") — but for a
// Zyra AI Memory log entry, groupSections (text-diff.util.ts) uses the section's own `## <ISO
// timestamp>` heading as the label verbatim, so it reaches here as a raw
// "2026-09-11T15:31:09.877Z" string. Reformat only that shape, into the same DD/MM/YYYY, hh:mm:ss
// AM/PM the Change History list next to this modal already uses — every other label (not matching
// the pattern) is left exactly as the backend sent it.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function formatFieldLabel(label: string): string {
  if (!ISO_TIMESTAMP_RE.test(label)) return label;
  return `${formatEventDate(label)}, ${formatEventTime(label)}`;
}

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
    <Modal open={open} onClose={onClose} title="Difference" className="max-w-[640px]">
      <p className="mb-3 text-[12px] text-[var(--muted)]">{title}</p>
      <div className="space-y-6">
        {fields.map((field, i) => (
          <div key={`${field.label}-${i}`} className={i > 0 ? "border-t border-[var(--border)] pt-6" : undefined}>
            <div className="mb-1 text-[12px] font-semibold text-[var(--foreground)]">{formatFieldLabel(field.label)}</div>
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
