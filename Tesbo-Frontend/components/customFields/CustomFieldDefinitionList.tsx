"use client";

import { useState } from "react";
import {
  IconArchive,
  IconChevronDown,
  IconChevronUp,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import {
  deleteCustomFieldDefinition,
  reorderCustomFieldDefinitions,
  restoreCustomFieldDefinition,
  setCustomFieldDefinitionStatus,
  type CustomFieldDefinition,
} from "@/lib/api";
import { Button, Card, Modal, StatusChip } from "@/components/ui";
import { FIELD_TYPE_LABELS } from "./customFieldTypes";

function statusTone(status: string): "success" | "neutral" | "error" {
  if (status === "active") return "success";
  if (status === "archived") return "error";
  return "neutral";
}

export default function CustomFieldDefinitionList({
  projectId,
  definitions,
  onEdit,
  onChanged,
}: {
  projectId: string;
  definitions: CustomFieldDefinition[];
  onEdit: (definition: CustomFieldDefinition) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which non-archived row is currently the drop target, for the highlight.
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldDefinition | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Fields deleted during this page view, kept only so an "Undo" affordance can be shown in place
  // of the row. Deliberately plain component state (not persisted anywhere): once the settings
  // page is reloaded, the undo window is gone for good even though the row is still recoverable
  // in the database — reloading is the user's signal that they're done with this session.
  const [pendingUndo, setPendingUndo] = useState<Record<string, CustomFieldDefinition>>({});

  const reorderable = definitions.filter((d) => d.status !== "archived").sort((a, b) => a.displayOrder - b.displayOrder);
  const archived = definitions.filter((d) => d.status === "archived");
  const deletedIds = Object.keys(pendingUndo);
  // Guard against the deleted field somehow still coming back from the server (a stale refetch
  // racing the delete) so it never renders twice.
  const justDeleted = deletedIds.map((id) => pendingUndo[id]).filter((d) => !definitions.some((live) => live.id === d.id));
  const ordered = [...reorderable, ...archived];

  // Submits a full reordered id list and refreshes from the server — the one place both the
  // up/down buttons and drag-and-drop actually persist a new order, so they can't drift apart.
  async function applyReorder(nextIds: string[], busyIdWhileSaving: string) {
    setBusyId(busyIdWhileSaving);
    setError(null);
    try {
      await reorderCustomFieldDefinitions(projectId, nextIds);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder fields.");
    } finally {
      setBusyId(null);
    }
  }

  async function move(definition: CustomFieldDefinition, direction: -1 | 1) {
    const index = reorderable.findIndex((d) => d.id === definition.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= reorderable.length) return;
    const next = [...reorderable];
    [next[index], next[target]] = [next[target], next[index]];
    await applyReorder(next.map((d) => d.id), definition.id);
  }

  // Drag-and-drop counterpart to move() — same persistence call, but the dragged field can land at
  // any position instead of swapping with one neighbor. Dropping on itself is a no-op (handled by
  // the fromId === toId guard); dropping outside a valid row never reaches this function at all
  // since only non-archived rows wire up an onDrop handler.
  async function reorderByDrag(fromId: string, toId: string) {
    if (fromId === toId) return;
    const fromIndex = reorderable.findIndex((d) => d.id === fromId);
    const toIndex = reorderable.findIndex((d) => d.id === toId);
    if (fromIndex === -1 || toIndex === -1) return;
    const next = [...reorderable];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    await applyReorder(next.map((d) => d.id), fromId);
  }

  async function toggleActive(definition: CustomFieldDefinition) {
    setBusyId(definition.id);
    setError(null);
    try {
      await setCustomFieldDefinitionStatus(projectId, definition.id, definition.status === "active" ? "inactive" : "active");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update field status.");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(definition: CustomFieldDefinition) {
    if (!window.confirm(`Archive "${definition.name}"? Archived fields become read-only everywhere.`)) return;
    setBusyId(definition.id);
    setError(null);
    try {
      await setCustomFieldDefinitionStatus(projectId, definition.id, "archived");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive field.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setBusyId(target.id);
    setDeleteError(null);
    try {
      await deleteCustomFieldDefinition(projectId, target.id);
      setDeleteTarget(null);
      setPendingUndo((prev) => ({ ...prev, [target.id]: target }));
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete field.");
    } finally {
      setBusyId(null);
    }
  }

  async function undoDelete(definition: CustomFieldDefinition) {
    setBusyId(definition.id);
    setError(null);
    try {
      await restoreCustomFieldDefinition(projectId, definition.id);
      setPendingUndo((prev) => {
        const next = { ...prev };
        delete next[definition.id];
        return next;
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo delete.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && <p className="mb-2 text-sm text-[var(--error-foreground)]">{error}</p>}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Field</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Required</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">In use</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((definition) => {
                const isArchived = definition.status === "archived";
                const busy = busyId === definition.id;
                const indexInReorderable = reorderable.findIndex((d) => d.id === definition.id);
                return (
                  <tr
                    key={definition.id}
                    draggable={!isArchived}
                    onDragStart={
                      !isArchived
                        ? (e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", definition.id);
                          }
                        : undefined
                    }
                    onDragOver={
                      !isArchived
                        ? (e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }
                        : undefined
                    }
                    onDragEnter={!isArchived ? () => setDragOverId(definition.id) : undefined}
                    onDragLeave={
                      !isArchived ? () => setDragOverId((cur) => (cur === definition.id ? null : cur)) : undefined
                    }
                    onDrop={
                      !isArchived
                        ? (e) => {
                            e.preventDefault();
                            const fromId = e.dataTransfer.getData("text/plain");
                            setDragOverId(null);
                            if (fromId) void reorderByDrag(fromId, definition.id);
                          }
                        : undefined
                    }
                    onDragEnd={() => setDragOverId(null)}
                    className={dragOverId === definition.id && !isArchived ? "bg-[var(--brand-soft)]" : undefined}
                  >
                    <td className="px-4 py-3">
                      {!isArchived && (
                        <div className="flex items-center gap-1.5">
                          <span
                            className="cursor-grab text-[var(--muted-soft)] select-none active:cursor-grabbing"
                            aria-hidden="true"
                            title="Drag to reorder"
                          >
                            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" className="opacity-60">
                              <circle cx="3" cy="3" r="1.25" />
                              <circle cx="7" cy="3" r="1.25" />
                              <circle cx="3" cy="7" r="1.25" />
                              <circle cx="7" cy="7" r="1.25" />
                              <circle cx="3" cy="11" r="1.25" />
                              <circle cx="7" cy="11" r="1.25" />
                            </svg>
                          </span>
                          <div className="flex flex-col">
                            <button
                              type="button"
                              onClick={() => move(definition, -1)}
                              disabled={busy || indexInReorderable === 0}
                              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
                              aria-label="Move up"
                            >
                              <IconChevronUp size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => move(definition, 1)}
                              disabled={busy || indexInReorderable === reorderable.length - 1}
                              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
                              aria-label="Move down"
                            >
                              <IconChevronDown size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-[var(--foreground)]">{definition.name}</div>
                      {definition.description && <div className="text-xs text-[var(--muted)]">{definition.description}</div>}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{FIELD_TYPE_LABELS[definition.fieldType]}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{definition.required ? "Required" : "Optional"}</td>
                    <td className="px-4 py-3">
                      <StatusChip tone={statusTone(definition.status)} dot>
                        {definition.status === "active" ? "Active" : definition.status === "inactive" ? "Inactive" : "Archived"}
                      </StatusChip>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{definition.isUsed ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!isArchived && (
                          <>
                            <Button
                              type="button"
                              variant="secondary"
                              size="icon"
                              onClick={() => onEdit(definition)}
                              disabled={busy}
                              title="Edit"
                              aria-label="Edit"
                              className="border-[var(--accent-light)] text-[var(--accent-light)] hover:bg-[var(--brand-soft)] hover:text-[var(--accent-light)]"
                            >
                              <IconPencil size={14} stroke={1.75} />
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="icon"
                              onClick={() => toggleActive(definition)}
                              disabled={busy}
                              title={definition.status === "active" ? "Deactivate" : "Activate"}
                              aria-label={definition.status === "active" ? "Deactivate" : "Activate"}
                              className="text-[var(--foreground)]"
                            >
                              {definition.status === "active" ? (
                                <IconPlayerPause size={14} stroke={1.75} />
                              ) : (
                                <IconPlayerPlay size={14} stroke={1.75} />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="icon"
                              onClick={() => archive(definition)}
                              disabled={busy}
                              title="Archive"
                              aria-label="Archive"
                              className="text-[var(--muted)]"
                            >
                              <IconArchive size={14} stroke={1.75} />
                            </Button>
                          </>
                        )}
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(definition);
                          }}
                          disabled={busy}
                          title="Delete"
                          aria-label="Delete"
                        >
                          <IconTrash size={14} stroke={1.75} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {justDeleted.map((definition) => {
                const busy = busyId === definition.id;
                return (
                  <tr key={definition.id} className="opacity-60">
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3">
                      <div className="font-medium text-[var(--foreground)] line-through">{definition.name}</div>
                      <div className="text-xs text-[var(--muted)]">Deleted — values already recorded on test cases are preserved.</div>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{FIELD_TYPE_LABELS[definition.fieldType]}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{definition.required ? "Required" : "Optional"}</td>
                    <td className="px-4 py-3">
                      <StatusChip tone="neutral" dot>
                        Deleted
                      </StatusChip>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{definition.isUsed ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => undoDelete(definition)}
                          disabled={busy}
                          className="text-[var(--accent-light)] hover:underline disabled:opacity-50"
                        >
                          {busy ? "Undoing…" : "Undo"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {ordered.length === 0 && justDeleted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-[var(--muted)]">
                    No custom fields yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete custom field">
        <div className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            Delete &quot;{deleteTarget?.name}&quot;? It will be removed from this list and hidden everywhere a value could be
            newly assigned. Any values already recorded on test cases are kept, and you can undo this immediately after —
            but not once this page is reloaded.
          </p>
          {deleteError && <p className="text-sm text-[var(--error-foreground)]">{deleteError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete} disabled={busyId === deleteTarget?.id}>
              {busyId === deleteTarget?.id ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
