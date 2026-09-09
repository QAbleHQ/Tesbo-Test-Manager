"use client";

import { useState } from "react";
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { Button, Input } from "@/components/ui";

export interface DraftOption {
  /** Stable client-side key. Distinct from `id` so brand-new (unsaved) options can be
   * told apart from options that already exist on the server (which only support
   * deactivation, not removal, once saved). */
  localKey: string;
  id?: string;
  label: string;
  active: boolean;
}

let localKeySeq = 0;
export function nextLocalKey(): string {
  localKeySeq += 1;
  return `local-${localKeySeq}`;
}

export default function CustomFieldOptionsEditor({
  options,
  onChange,
  disabled,
}: {
  options: DraftOption[];
  onChange: (next: DraftOption[]) => void;
  disabled?: boolean;
}) {
  const [newLabel, setNewLabel] = useState("");
  // Which option is currently the drop target, for the highlight — mirrors dragOverId in
  // RepositoryTestCaseTable.tsx's column drag-and-drop.
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  // Drag-and-drop counterpart to move() — same onChange(next) flow (still local until the
  // surrounding form is saved), but the dragged option can land at any position instead of
  // swapping with one neighbor. Dropping on itself is a no-op; dropping outside a valid option row
  // never reaches this function since only option rows wire up an onDrop handler.
  function moveTo(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    const fromIndex = options.findIndex((o) => o.localKey === fromKey);
    const toIndex = options.findIndex((o) => o.localKey === toKey);
    if (fromIndex === -1 || toIndex === -1) return;
    const next = [...options];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onChange(next);
  }

  function updateLabel(index: number, label: string) {
    const next = [...options];
    next[index] = { ...next[index], label };
    onChange(next);
  }

  function toggleActive(index: number) {
    const next = [...options];
    next[index] = { ...next[index], active: !next[index].active };
    onChange(next);
  }

  function removeNew(index: number) {
    onChange(options.filter((_, i) => i !== index));
  }

  function addOption() {
    const label = newLabel.trim();
    if (!label) return;
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) return;
    onChange([...options, { localKey: nextLocalKey(), label, active: true }]);
    setNewLabel("");
  }

  return (
    <div className="space-y-2">
      {options.length === 0 && <p className="text-[13px] text-[var(--muted)]">No options yet — add at least one below.</p>}
      {options.map((option, index) => (
        <div
          key={option.localKey}
          draggable={!disabled}
          onDragStart={
            !disabled
              ? (e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", option.localKey);
                }
              : undefined
          }
          onDragOver={
            !disabled
              ? (e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              : undefined
          }
          onDragEnter={!disabled ? () => setDragOverKey(option.localKey) : undefined}
          onDragLeave={
            !disabled ? () => setDragOverKey((cur) => (cur === option.localKey ? null : cur)) : undefined
          }
          onDrop={
            !disabled
              ? (e) => {
                  e.preventDefault();
                  const fromKey = e.dataTransfer.getData("text/plain");
                  setDragOverKey(null);
                  if (fromKey) moveTo(fromKey, option.localKey);
                }
              : undefined
          }
          onDragEnd={() => setDragOverKey(null)}
          className={`flex items-center gap-1.5 rounded-md ${dragOverKey === option.localKey ? "bg-[var(--brand-soft)]" : ""}`}
        >
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
              onClick={() => move(index, -1)}
              disabled={disabled || index === 0}
              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
              aria-label="Move option up"
            >
              <IconChevronUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={disabled || index === options.length - 1}
              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
              aria-label="Move option down"
            >
              <IconChevronDown size={14} />
            </button>
          </div>
          <Input
            type="text"
            value={option.label}
            onChange={(e) => updateLabel(index, e.target.value)}
            disabled={disabled}
            className="flex-1"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--muted)]">
            <input type="checkbox" checked={option.active} onChange={() => toggleActive(index)} disabled={disabled} />
            Active
          </label>
          {!option.id && (
            <button
              type="button"
              onClick={() => removeNew(index)}
              disabled={disabled}
              className="shrink-0 text-[var(--error-foreground)] hover:opacity-80 disabled:opacity-30"
              aria-label="Remove option"
            >
              <IconTrash size={16} />
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1">
        <Input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Add an option…"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addOption();
            }
          }}
          className="flex-1"
        />
        <Button type="button" variant="secondary" size="sm" onClick={addOption} disabled={disabled || !newLabel.trim()}>
          <IconPlus size={14} className="mr-1" />
          Add
        </Button>
      </div>
    </div>
  );
}
