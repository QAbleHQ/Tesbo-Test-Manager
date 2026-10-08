"use client";

import { useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { deleteZyraMemoryEntry, updateZyraMemoryEntry, type KnowledgeDocument } from "@/lib/api";
import { Button, Modal } from "@/components/ui";
import RichTextEditor from "@/components/knowledge-base/RichTextEditor";
import { documentToMarkdown, markdownToDocument } from "@/components/knowledge-base/editorExtensions";
import { formatDateTime } from "@/lib/date";
import { renderMarkdown } from "@/lib/markdown";

// Id the backend gives any text above Zyra's first timestamped entry (ZYRA_MEMORY_UNSTRUCTURED_ID).
const UNSTRUCTURED_ID = "unstructured";

// Read view only — the stored note is never rewritten.
//
// A line that is only a date/time in the sitewide format ("06 Oct 2026, 01:06 PM") is an entry's
// timestamp that an old editor save flattened into plain text. The note is split at those lines so
// each date sits directly above its own text, groups divided like separate entries.
//
// Blank lines are dropped before rendering: renderMarkdown turns every one into a <br/>, and notes
// saved through the old editor carry runs of them (one per empty paragraph). Paragraph and list
// spacing come from the zyra-prose margins instead.
const DATE_LINE_RE = /^\s*(\d{1,2} [A-Za-z]{3,} \d{4}, \d{1,2}:\d{2}(?: [AP]M)?)\s*$/;

function noteGroups(note: string): Array<{ date: string | null; html: string }> {
  const groups: Array<{ date: string | null; lines: string[] }> = [{ date: null, lines: [] }];
  for (const line of note.split("\n")) {
    const date = DATE_LINE_RE.exec(line);
    if (date) groups.push({ date: date[1], lines: [] });
    else if (line.trim()) groups[groups.length - 1].lines.push(line);
  }
  return groups
    .filter((group) => group.date || group.lines.length)
    .map((group) => ({ date: group.date, html: group.lines.length ? renderMarkdown(group.lines.join("\n")) : "" }));
}

function NoteView({ note }: { note: string }) {
  return (
    <div className="mt-2 divide-y divide-[var(--border-subtle)]">
      {noteGroups(note).map((group, index) => (
        <div key={index} data-testid="zyra-memory-note-group" className="py-2.5 first:pt-0 last:pb-0">
          {group.date && <p className="text-[13px] font-semibold text-[var(--foreground)]">{group.date}</p>}
          {group.html && (
            <div
              className="zyra-prose break-words text-[13px] leading-relaxed text-[var(--muted)]"
              dangerouslySetInnerHTML={{ __html: group.html }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

type Memory = NonNullable<KnowledgeDocument["zyraMemory"]>;

/**
 * Zyra AI Memory's body, in place of the free-form editor: Zyra reads this text back as context on
 * every response, so it is changed one entry at a time — corrected or removed — and only by project
 * owners and managers (the API enforces the same). Entries arrive parsed by the backend
 * (parseZyraMemory, legacy.service.ts), newest first, each identified by its own ISO timestamp,
 * shown here in the sitewide date format.
 */
export function ZyraMemoryEntries({
  projectId,
  documentId,
  memory,
  canManage,
  onUpdated,
}: {
  projectId: string;
  documentId: string;
  memory: Memory;
  canManage: boolean;
  onUpdated: (doc: KnowledgeDocument) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Edit opens the regular Knowledge Base editor: the note (stored as Markdown) is parsed into it on
  // click, and serialised back to Markdown only when Save is pressed after a real change. Both
  // conversions need a DOM, so they run in these handlers, never during render.
  const [editorDoc, setEditorDoc] = useState<JSONContent | null>(null);
  const editedDoc = useRef<JSONContent | null>(null);
  const [editedEmpty, setEditedEmpty] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = [
    ...(memory.unstructured ? [{ id: UNSTRUCTURED_ID, note: memory.unstructured }] : []),
    ...memory.entries,
  ];

  function label(id: string): string {
    return id === UNSTRUCTURED_ID ? "Unstructured notes" : formatDateTime(id);
  }

  function startEdit(id: string, note: string) {
    setEditorDoc(markdownToDocument(note).json);
    editedDoc.current = null;
    setEditedEmpty(false);
    setEditingId(id);
    setError(null);
  }

  async function save(id: string) {
    // Nothing typed: no request, so opening and saving can never re-serialise (normalise) the note.
    if (!editedDoc.current) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onUpdated(await updateZyraMemoryEntry(projectId, documentId, id, documentToMarkdown(editedDoc.current)));
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the memory entry.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      onUpdated(await deleteZyraMemoryEntry(projectId, documentId, id));
      setRemoveId(null);
      if (editingId === id) setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the memory entry.");
      setRemoveId(null);
    } finally {
      setBusy(false);
    }
  }

  if (!items.length) {
    return <p className="py-6 text-[13px] text-[var(--muted)]">Zyra hasn&apos;t recorded anything for this project yet.</p>;
  }

  return (
    <div className="space-y-3" data-testid="zyra-memory-entries">
      {error && (
        <p role="alert" className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-[13px] text-[var(--error-foreground)]">
          {error}
        </p>
      )}
      {items.map((item) => {
        const editing = editingId === item.id;
        return (
          <article
            key={item.id}
            data-testid="zyra-memory-entry"
            data-entry-id={item.id}
            className="rounded-[10px] border border-[var(--border)] px-4 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[14px] font-semibold text-[var(--foreground)]">{label(item.id)}</h2>
              {canManage && !editing && (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    aria-label={`Edit entry ${label(item.id)}`}
                    onClick={() => startEdit(item.id, item.note)}
                  >
                    <IconPencil size={14} /> Edit
                  </Button>
                  <Button variant="danger" size="sm" disabled={busy} aria-label={`Remove entry ${label(item.id)}`} onClick={() => setRemoveId(item.id)}>
                    <IconTrash size={14} /> Remove
                  </Button>
                </div>
              )}
            </div>
            {item.id === UNSTRUCTURED_ID && (
              <p className="mt-1 text-[12px] text-[var(--muted)]">Text that isn&apos;t one of Zyra&apos;s own entries, left by an earlier direct edit. Zyra still reads it.</p>
            )}
            {editing ? (
              <div className="mt-2 space-y-2">
                <RichTextEditor
                  contentJson={editorDoc}
                  onUpdate={({ json, text }) => {
                    editedDoc.current = json;
                    setEditedEmpty(!text.trim());
                  }}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || editedEmpty} onClick={() => void save(item.id)}>
                    {busy ? "Saving…" : "Save entry"}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : item.note ? (
              <NoteView note={item.note} />
            ) : (
              <p className="mt-2 text-[13px] text-[var(--muted-soft)]">No note.</p>
            )}
          </article>
        );
      })}

      <Modal open={removeId !== null} onClose={() => !busy && setRemoveId(null)} title="Remove memory entry" className="max-w-md">
        <p className="text-[13px] text-[var(--muted)]">
          Zyra will no longer use this entry as context. It stays in View history.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRemoveId(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => removeId && void remove(removeId)}>
            {busy ? "Removing…" : "Remove entry"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
