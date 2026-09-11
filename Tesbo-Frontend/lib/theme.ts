export const THEME_STORAGE_KEY = "tesbo-theme";

// Dispatched by persistTheme() so every mounted ThemeToggle stays in sync — there is no shared
// context, so without this, changing the theme from one instance would leave any other mounted
// instance showing a stale toggle position until it remounts, even though the applied theme
// itself is already correct everywhere.
export const THEME_CHANGE_EVENT = "tesbo-theme-change";

export type ThemeMode = "light" | "dark";

export function normalizeTheme(value: string | null | undefined): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function applyTheme(theme: ThemeMode) {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";

  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

export function persistTheme(theme: ThemeMode) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage write failures and still apply the theme.
    }
  }

  applyTheme(theme);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: theme }));
  }
}
