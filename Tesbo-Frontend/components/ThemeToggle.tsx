"use client";

import { useEffect, useState } from "react";
import { applyTheme, persistTheme, readStoredTheme, THEME_CHANGE_EVENT, type ThemeMode } from "@/lib/theme";

// 16px, matching the size IconBell renders at next to this control in the top bar.
function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") {
    return (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3v2.25M12 18.75V21M4.97 4.97l1.59 1.59M17.44 17.44l1.59 1.59M3 12h2.25M18.75 12H21M4.97 19.03l1.59-1.59M17.44 6.56l1.59-1.59" />
        <circle cx="12" cy="12" r="4" strokeWidth="1.8" />
      </svg>
    );
  }

  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Syncs this instance if the theme changes elsewhere (another tab, or another mounted toggle),
  // since there's no shared context between them.
  useEffect(() => {
    function handleExternalChange(e: Event) {
      const next = (e as CustomEvent<ThemeMode>).detail;
      if (next) setTheme(next);
    }
    window.addEventListener(THEME_CHANGE_EVENT, handleExternalChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handleExternalChange);
  }, []);

  const isDark = theme === "dark";

  function toggle() {
    const next: ThemeMode = isDark ? "light" : "dark";
    setTheme(next);
    persistTheme(next);
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      onClick={toggle}
      className="tesbo-glass-strong relative inline-flex h-8 w-14 shrink-0 items-center rounded-full p-1 transition-colors"
    >
      {/* Slides behind whichever icon is active; both icons stay rendered underneath so neither
          ever disappears — only this highlight moves. */}
      <span
        aria-hidden
        className={`absolute inline-flex h-6 w-6 rounded-full bg-[var(--brand-surface)] shadow-sm transition-transform ${
          isDark ? "translate-x-6" : "translate-x-0"
        }`}
      />
      <span
        className={`relative z-10 flex h-6 w-6 items-center justify-center transition-colors ${
          isDark ? "text-[var(--muted)]" : "text-[var(--foreground)]"
        }`}
      >
        <ThemeIcon mode="light" />
      </span>
      <span
        className={`relative z-10 flex h-6 w-6 items-center justify-center transition-colors ${
          isDark ? "text-[var(--foreground)]" : "text-[var(--muted)]"
        }`}
      >
        <ThemeIcon mode="dark" />
      </span>
    </button>
  );
}
