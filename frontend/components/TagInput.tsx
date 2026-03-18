"use client";

import { useMemo, useState } from "react";

type TagInputProps = {
  label: string;
  selectedTags: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
};

function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export default function TagInput({
  label,
  selectedTags,
  onChange,
  suggestions,
  placeholder = "Type a tag and press Enter",
}: TagInputProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const availableSuggestions = useMemo(() => {
    const selected = new Set(selectedTags.map((t) => t.toLowerCase()));
    const query = value.trim().toLowerCase();
    return suggestions
      .filter((tag) => !selected.has(tag.toLowerCase()))
      .filter((tag) => (query ? tag.toLowerCase().includes(query) : true))
      .slice(0, 8);
  }, [selectedTags, suggestions, value]);

  function addTag(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (selectedTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...selectedTags, tag]);
    setValue("");
  }

  function removeTag(tag: string) {
    onChange(selectedTags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(value);
    } else if (e.key === "Backspace" && !value && selectedTags.length > 0) {
      onChange(selectedTags.slice(0, -1));
    }
  }

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-[var(--muted)]">{label}</label>
      <div className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-2">
        <div className="mb-2 flex flex-wrap gap-2">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2 py-1 text-xs text-[var(--brand-primary)]"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                aria-label={`Remove ${tag}`}
                className="text-[var(--brand-primary)] hover:opacity-80"
              >
                x
              </button>
            </span>
          ))}
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted-soft)]"
        />
      </div>
      {focused && availableSuggestions.length > 0 && (
        <div className="mt-1 rounded border border-[var(--border)] bg-[var(--surface)] p-1 shadow">
          {availableSuggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(tag)}
              className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-[var(--surface-secondary)]"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
