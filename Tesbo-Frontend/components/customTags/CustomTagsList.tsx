"use client";

import { useState } from "react";
import { IconTrash } from "@tabler/icons-react";
import { createCustomTag, deleteCustomTag, CUSTOM_TAG_NAME_MAX_LENGTH, type CustomTag } from "@/lib/api";
import { Button, Field, FieldError, Input, Modal } from "@/components/ui";

export default function CustomTagsList({
  projectId,
  tags,
  onChanged,
}: {
  projectId: string;
  tags: CustomTag[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomTag | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setAddError("Tag name is required.");
      return;
    }
    if (trimmed.length > CUSTOM_TAG_NAME_MAX_LENGTH) {
      setAddError(`Tag name must be ${CUSTOM_TAG_NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await createCustomTag(projectId, { name: trimmed });
      setName("");
      onChanged();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to create tag.");
    } finally {
      setAdding(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setBusyId(target.id);
    setDeleteError(null);
    try {
      await deleteCustomTag(projectId, target.id);
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete tag.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleAdd} className="flex items-start gap-2">
        <Field className="flex-1">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Regression, Smoke, Flaky"
            maxLength={CUSTOM_TAG_NAME_MAX_LENGTH}
          />
          {addError && <FieldError>{addError}</FieldError>}
        </Field>
        <Button type="submit" disabled={adding}>
          Add tag
        </Button>
      </form>

      {tags.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No custom tags yet. Add one above to start tagging test cases.</p>
      ) : (
        <ul className="max-h-[420px] divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-lg border border-[var(--border)]">
          {tags.map((tag) => (
            <li key={tag.id} className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm font-medium text-[var(--foreground)]">{tag.name}</span>
              <button
                type="button"
                aria-label={`Delete tag ${tag.name}`}
                onClick={() => setDeleteTarget(tag)}
                disabled={busyId === tag.id}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--error-foreground)]"
              >
                <IconTrash size={16} stroke={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete custom tag">
        <div className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            Delete &quot;{deleteTarget?.name}&quot;? It will be removed from every test case it&apos;s currently assigned to. This cannot be undone.
          </p>
          {deleteError && <p className="text-sm text-[var(--error-foreground)]">{deleteError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={confirmDelete} disabled={busyId === deleteTarget?.id}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
