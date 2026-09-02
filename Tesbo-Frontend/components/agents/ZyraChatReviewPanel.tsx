"use client";

import { useEffect, useState } from "react";
import { deleteZyraTaskDraft, editZyraTaskDraft, saveZyraTask, closeZyraTask, getZyraTask, type ZyraChatTestcaseRow } from "@/lib/api";
import { Button, CopyButton, StatusChip } from "@/components/ui";
import { toTsv } from "@/lib/tsv";
import { ZyraDraftEditor, type ZyraDraftEditValues } from "./ZyraDraftEditor";

function firstStepPreview(value: unknown): string {
  if (!value) return "—";
  if (Array.isArray(value)) {
    const first = value[0] as Record<string, unknown> | undefined;
    if (!first) return "—";
    const text = first.action ?? first.expected;
    return typeof text === "string" && text ? text : "—";
  }
  if (typeof value !== "string") return "—";
  try { return firstStepPreview(JSON.parse(value)); } catch { return "—"; }
}

function priorityTone(priority?: string) {
  if (priority === "P0") return "error" as const;
  if (priority === "P1") return "warning" as const;
  if (priority === "P2") return "confidenceHigh" as const;
  return "neutral" as const;
}

const ACTION_LABEL: Record<string, string> = {
  "proposed-create": "New",
  "proposed-update": "Update",
  "proposed-archive": "Archive",
};

/**
 * Renders a not-yet-saved batch of create/update/archive proposals from a Zyra chat message —
 * the review step the Test Case Repository was missing (select/deselect, edit, discard, or save
 * into the repository). `initialRows` come straight off the message (already fetched); this only
 * calls the server again to confirm the batch is still pending (another tab may have already
 * saved or closed it), and thereafter manages the working set of rows entirely client-side —
 * every action below (edit/discard/save) tells the server exactly what changed, so there is never
 * a need to reconstruct a full drafts array back into display rows.
 */
export function ZyraChatReviewPanel({
  projectId,
  reviewRequestId,
  initialRows,
}: {
  projectId: string;
  reviewRequestId: string;
  initialRows: ZyraChatTestcaseRow[];
}) {
  const [status, setStatus] = useState<"checking" | "in_review" | "resolved">("checking");
  const [rows, setRows] = useState<ZyraChatTestcaseRow[]>(initialRows);
  const [selected, setSelected] = useState<number[]>(() => initialRows.map((_, index) => index));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getZyraTask(projectId, reviewRequestId)
      .then((task) => {
        if (cancelled) return;
        setStatus(task.taskStatus === "in_review" ? "in_review" : "resolved");
      })
      .catch(() => {
        // Fail open — let the user try acting on it; a batch that's actually already resolved
        // elsewhere will reject the first action with a clear conflict message instead.
        if (!cancelled) setStatus("in_review");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reviewRequestId]);

  if (status === "checking") {
    return <p className="mt-3 text-xs text-[var(--muted)]">Checking review status…</p>;
  }

  if (status === "resolved" && !message) {
    return (
      <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs text-[var(--muted)]">
        This batch was already saved or closed — nothing left here to review.
      </p>
    );
  }

  function toggle(index: number) {
    setSelected((prev) => (prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]));
  }
  const allSelected = rows.length > 0 && selected.length === rows.length;

  async function handleDiscard(index: number) {
    setWorking(true);
    setError(null);
    try {
      await deleteZyraTaskDraft(projectId, reviewRequestId, index);
      setRows((prev) => prev.filter((_, i) => i !== index).map((row, newIndex) => ({ ...row, draftIndex: newIndex })));
      setSelected((prev) => prev.filter((item) => item !== index).map((item) => (item > index ? item - 1 : item)));
      if (editingIndex === index) setEditingIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to discard the draft.");
    } finally {
      setWorking(false);
    }
  }

  async function handleSaveEdit(index: number, values: ZyraDraftEditValues) {
    setWorking(true);
    setError(null);
    try {
      await editZyraTaskDraft(projectId, reviewRequestId, index, {
        title: values.title,
        priority: values.priority,
        preconditions: values.preconditions,
        description: values.description,
        stepsJson: values.stepsJson,
      });
      setRows((prev) =>
        prev.map((row, i) =>
          i === index
            ? { ...row, title: values.title, priority: values.priority, preconditions: values.preconditions, expectedSummary: values.description, stepsJson: values.stepsJson }
            : row
        )
      );
      setEditingIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the edit.");
    } finally {
      setWorking(false);
    }
  }

  async function handleSaveSelected() {
    if (!selected.length) return;
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const savedSet = new Set(selected);
      const result = await saveZyraTask(projectId, reviewRequestId, { selectedDraftIndexes: selected });
      // A partial selection leaves the rest staged for a later Save — only once nothing remains
      // does the batch resolve (matches the server: see zyraSaveAttempt's `remaining` handling).
      setRows((prev) => prev.filter((_, i) => !savedSet.has(i)).map((row, newIndex) => ({ ...row, draftIndex: newIndex })));
      setSelected([]);
      if (!result.remaining) setStatus("resolved");
      setMessage(`${result.savedCount} test case${result.savedCount === 1 ? "" : "s"} saved to the repository.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the selected test cases.");
    } finally {
      setWorking(false);
    }
  }

  async function handleDiscardAll() {
    setWorking(true);
    setError(null);
    try {
      await closeZyraTask(projectId, reviewRequestId);
      setRows([]);
      setSelected([]);
      setStatus("resolved");
      setMessage("Batch closed — nothing was saved to the repository.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close the batch.");
    } finally {
      setWorking(false);
    }
  }

  const tsv = toTsv(
    ["Action", "Title", "Priority", "Preconditions", "First step", "Expected result"],
    rows.map((row) => [ACTION_LABEL[row.action || ""] || row.action || "", row.title, row.priority || "P2", row.preconditions || "", firstStepPreview(row.stepsJson), row.expectedSummary || ""])
  );

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[var(--brand-border)] bg-[var(--surface)] p-3">
      {message && <p className="rounded-md border border-[var(--border)] bg-[var(--surface-secondary)] px-2.5 py-1.5 text-xs text-[var(--foreground)]">{message}</p>}
      {error && <p className="rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-2.5 py-1.5 text-xs text-[var(--error-foreground)]">{error}</p>}
      {rows.length === 0 ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[var(--foreground)]">
              {selected.length} of {rows.length} selected — pending review
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => setSelected(allSelected ? [] : rows.map((_, i) => i))} disabled={working}>
                {allSelected ? "Unselect all" : "Select all"}
              </Button>
              <span title="Copy these proposed test cases as tab-separated values, ready to paste into Excel.">
                <CopyButton value={tsv} label="Copy" copiedLabel="Copied" size="sm" />
              </span>
              <Button variant="secondary" size="sm" onClick={() => void handleDiscardAll()} disabled={working}>Discard all</Button>
              <Button size="sm" onClick={() => void handleSaveSelected()} disabled={working || selected.length === 0}>
                {working ? "Saving…" : `Save ${selected.length || ""} to repository`}
              </Button>
            </div>
          </div>

          <ul className="space-y-2 list-none p-0 m-0" aria-label="Proposed test cases">
            {rows.map((row, index) => (
              <li key={`${reviewRequestId}-${index}`} className="rounded-md border border-[var(--border)] bg-[var(--background)] p-2.5">
                <div className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(index)}
                    onChange={() => toggle(index)}
                    disabled={working}
                    aria-label={`Select proposed test case ${index + 1}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusChip tone="info" className="!rounded-[5px] !px-1.5 !py-0 !text-[10px] !font-medium">
                        {ACTION_LABEL[row.action || ""] || "Proposed"}
                      </StatusChip>
                      <StatusChip tone={priorityTone(row.priority)} className="!rounded-[5px] !px-1.5 !py-0 !font-mono !text-[10px] !font-semibold">
                        {row.priority || "P2"}
                      </StatusChip>
                      {row.externalId && <span className="font-mono text-[11px] text-[var(--muted)]">{row.externalId}</span>}
                    </div>
                    <p className="mt-1 text-[13px] font-medium text-[var(--foreground)]">{row.title}</p>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-[var(--muted)]">{firstStepPreview(row.stepsJson)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => setEditingIndex(editingIndex === index ? null : index)} disabled={working}>
                      {editingIndex === index ? "Close" : "Edit"}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void handleDiscard(index)} disabled={working}>Discard</Button>
                  </div>
                </div>
                {editingIndex === index && (
                  <div className="mt-2.5">
                    <ZyraDraftEditor
                      row={row}
                      saving={working}
                      onCancel={() => setEditingIndex(null)}
                      onSave={(values) => void handleSaveEdit(index, values)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
