"use client";

import type { CustomTag } from "@/lib/api";

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
  const selected = new Set(selectedIds);
  return (
    <div className="flex flex-wrap gap-3 rounded-lg border border-[var(--border)] p-2.5">
      {tags.length === 0 && <span className="text-sm text-[var(--muted)]">No tags available</span>}
      {tags.map((tag) => (
        <label key={tag.id} className="flex items-center gap-1.5 text-sm text-[var(--foreground)]">
          <input
            type="checkbox"
            checked={selected.has(tag.id)}
            disabled={disabled}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(tag.id);
              else next.delete(tag.id);
              onChange(Array.from(next));
            }}
          />
          {tag.name}
        </label>
      ))}
    </div>
  );
}
