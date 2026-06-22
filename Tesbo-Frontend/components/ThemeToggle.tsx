"use client";

import { useEffect, useState } from "react";
import { applyTheme, persistTheme, readStoredTheme, type ThemeMode } from "@/lib/theme";

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

  const setMode = (nextTheme: ThemeMode) => {
    setTheme(nextTheme);
    persistTheme(nextTheme);
  };

  return (
    <div className="tesbo-glass-strong inline-flex items-center rounded-lg p-0.5">
      {(["light", "dark"] as ThemeMode[]).map((mode) => {
        const active = theme === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            aria-label={`Use ${mode} theme`}
            onClick={() => setMode(mode)}
            className={`rounded-md p-1.5 transition-colors ${
              active
                ? "bg-[var(--brand-surface)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted)] hover:bg-[var(--glass-surface-muted)] hover:text-[var(--foreground)]"
            }`}
          >
            <ThemeIcon mode={mode} />
          </button>
        );
      })}
    </div>
  );
}
