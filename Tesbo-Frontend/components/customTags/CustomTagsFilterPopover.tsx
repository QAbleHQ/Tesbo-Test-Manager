"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconTag } from "@tabler/icons-react";
import type { CustomTag } from "@/lib/api";

/**
 * The repository toolbar's "Tags" filter: a checkbox list of the project's custom tag catalog.
 * Selecting several means "any of these" — the server's customTagIds filter ORs them. Styled to sit
 * beside CustomFieldFilterPopover. Selections live only here — ticked boxes plus the trigger's count
 * badge, deliberately no per-tag chips in the toolbar (long tag names crowded out the filter row) —
 * so this is where tags are unticked individually or cleared all at once.
 */
export default function CustomTagsFilterPopover({
  tags,
  selectedIds,
  onChange,
}: {
  tags: CustomTag[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selected = new Set(selectedIds);
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
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] hover:bg-[var(--surface-secondary)]"
      >
        <IconTag size={13} stroke={1.75} />
        Tags
        {selectedIds.length > 0 && (
          <span className="ml-0.5 rounded-full bg-[var(--brand-primary)] px-1.5 text-[11px] font-medium text-white">{selectedIds.length}</span>
        )}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Filter by tags"
          aria-multiselectable="true"
          className="absolute right-0 top-[calc(100%+4px)] z-20 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface-overlay)] p-2 shadow-[var(--shadow-elevated)]"
        >
          {tags.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-[var(--muted)]">
              No custom tags in this project yet. Add them in Project settings &rarr; Custom Tags.
            </p>
          ) : (
            <>
              {tags.length > 8 && (
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tags…"
                  className="mb-2 h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 text-[12px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
                />
              )}
              <div className="max-h-60 space-y-0.5 overflow-y-auto">
                {visibleTags.length === 0 ? (
                  <p className="px-2 py-1.5 text-[12px] text-[var(--muted)]">No matching tags</p>
                ) : (
                  visibleTags.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
                    >
                      <input type="checkbox" checked={selected.has(tag.id)} onChange={() => toggle(tag.id)} />
                      <span className="truncate">{tag.name}</span>
                    </label>
                  ))
                )}
              </div>
              {selectedIds.length > 0 && (
                <div className="mt-2 flex items-center justify-between border-t border-[var(--border)] px-2 pt-2 text-[12px]">
                  <span className="text-[var(--muted)]">{selectedIds.length} selected · matches any</span>
                  <button type="button" onClick={() => onChange([])} className="font-medium text-[var(--accent-light)] hover:underline">
                    Clear
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
