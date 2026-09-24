"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconX } from "@tabler/icons-react";
import type { CustomTag } from "@/lib/api";

/**
 * Chips + a checkbox dropdown, not a flat inline checkbox list — a project's tag catalog can run to
 * dozens of similarly-named tags, and a flat list wraps into an unreadable block at that size (a
 * search box only appears once there's enough tags to need one).
 */
export default function CustomTagsMultiSelect({
  tags,
  selectedIds,
  onChange,
  disabled,
}: {
  tags: CustomTag[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selected = new Set(selectedIds);
  const selectedTags = tags.filter((t) => selected.has(t.id));
  const visibleTags = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags;
  }, [tags, query]);

  function toggle(id: string) {
    onChange(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Custom tags"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex min-h-[38px] w-full flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-left disabled:opacity-60"
      >
        {selectedTags.length === 0 ? (
          <span className="text-sm text-[var(--muted-soft)]">Select tags…</span>
        ) : (
          selectedTags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-xs text-[var(--accent-light)]"
            >
              {tag.name}
              <span
                role="button"
                aria-label={`Remove ${tag.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(tag.id);
                }}
                className="hover:opacity-80"
              >
                <IconX size={12} stroke={2} />
              </span>
            </span>
          ))
        )}
        <IconChevronDown size={14} stroke={1.75} className="ml-auto shrink-0 text-[var(--muted)]" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+4px)] z-20 w-full min-w-[240px] rounded-lg border border-[var(--border)] bg-[var(--surface-overlay)] p-2 shadow-[var(--shadow-elevated)]"
        >
          {tags.length > 8 && (
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tags…"
              className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
            />
          )}
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {visibleTags.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-[var(--muted)]">No matching tags</p>
            ) : (
              visibleTags.map((tag) => (
                <label
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                >
                  <input type="checkbox" checked={selected.has(tag.id)} onChange={() => toggle(tag.id)} />
                  {tag.name}
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
