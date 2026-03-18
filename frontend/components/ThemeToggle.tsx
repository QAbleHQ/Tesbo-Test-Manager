"use client";

export default function ThemeToggle() {
  return (
    <button
      type="button"
      aria-label="Tesbo Dark theme"
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-[13px] font-semibold text-[var(--foreground)] shadow-sm transition hover:bg-[var(--surface-secondary)]"
    >
      Command Dark
    </button>
  );
}
