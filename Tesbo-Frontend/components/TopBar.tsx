"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconBell, IconSearch, IconX } from "@tabler/icons-react";
import type { AppNotification, ProjectSummary } from "@/lib/api";
import { listNotifications } from "@/lib/api";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { useAppData } from "@/components/app/AppDataProvider";
import { useLogout } from "@/lib/useLogout";
import ThemeToggle from "@/components/ThemeToggle";

const MAX_RESULTS = 8;

import { avatarColor } from "@/lib/avatarColors";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export default function TopBar() {
  const router = useRouter();
  const { currentUser: user, projects } = useAppData();
  const { bindStart, bindEnd, filled } = useTopBarSlots();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchBoxRef = useRef<HTMLLabelElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [notifOpen, setNotifOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<AppNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const notifBoxRef = useRef<HTMLDivElement>(null);

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { isLoggingOut, logout: onLogout } = useLogout();

  // Only used for the tooltip text on the search button — the ⌘K/Ctrl+K shortcut itself works on
  // every platform regardless. Resolved after mount so SSR and the first client render still match.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent));
  }, []);

  // ⌘K / Ctrl+K focuses the search box from anywhere, matching the shortcut hint shown in it.
  useEffect(() => {
    function handleShortcut(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!notifOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (notifBoxRef.current && !notifBoxRef.current.contains(e.target as Node)) setNotifOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setNotifOpen(false);
    }
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [notifOpen]);

  useEffect(() => {
    if (!userMenuOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [userMenuOpen]);

  async function loadNotifications() {
    setNotifLoading(true);
    setNotifError(null);
    try {
      const items = await listNotifications();
      setNotifItems(items);
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : "Could not load notifications.");
    } finally {
      setNotifLoading(false);
    }
  }

  function toggleNotifications() {
    const opening = !notifOpen;
    setNotifOpen(opening);
    if (opening) void loadNotifications();
  }

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return projects
      .filter((p) => [p.name, p.key, p.description ?? ""].some((field) => field.toLowerCase().includes(q)))
      .slice(0, MAX_RESULTS);
  }, [projects, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function goToProject(p: ProjectSummary) {
    setOpen(false);
    setQuery("");
    router.push(`/projects/${p.id}/dashboard`);
  }

  function clearQuery() {
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) goToProject(chosen);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  const displayName = user?.name || user?.email || "";
  // Seeded on the user id: a display name can be edited and an email can be changed, either of
  // which would move someone's colour or collide two people. The id is the one field every other
  // screen (team avatars, activity, admins) also has and never changes.
  const avatarSeed = user?.userId || user?.email || user?.name || "";

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface)] px-8">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Page-provided start slot (e.g. breadcrumb). Fills via a portal from the page. */}
        <div ref={bindStart} className="flex min-w-0 items-center" />
        {/* Default global search — only when no page has taken over the top bar. */}
        {!filled && (
          <label
            ref={searchBoxRef}
            className="relative flex h-8 w-[260px] items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--muted-soft)] transition-colors focus-within:border-[var(--brand-primary)]"
          >
            <IconSearch size={14} stroke={1.75} className="shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder="Search projects…"
              className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                title="Clear search"
                onMouseDown={(e) => e.preventDefault()}
                onClick={clearQuery}
                className="flex shrink-0 items-center justify-center rounded-[3px] p-0.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
              >
                <IconX size={14} stroke={1.75} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Search"
                title={isMac ? "Search (⌘K)" : "Search (Ctrl+K)"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => inputRef.current?.focus()}
                className="flex shrink-0 items-center justify-center rounded-[3px] p-0.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
              >
                <IconSearch size={14} stroke={1.75} />
              </button>
            )}

            {open && query.trim() && (
              <div className="absolute left-0 top-full z-40 mt-1 w-full max-w-[360px] rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
                {results.length === 0 ? (
                  <p className="px-3 py-2 text-[13px] text-[var(--muted-soft)]">No projects found</p>
                ) : (
                  results.map((p, idx) => (
                    <button
                      key={p.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        goToProject(p);
                      }}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                        idx === activeIndex ? "bg-[var(--surface-secondary)]" : ""
                      }`}
                    >
                      <span className="truncate text-[var(--foreground)]">{p.name}</span>
                      <span className="shrink-0 font-mono text-[11px] uppercase text-[var(--muted-soft)]">{p.key}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </label>
        )}
      </div>
      <div className="flex items-center gap-2">
        {/* Page-provided end slot (e.g. page actions). Fills via a portal from the page. */}
        <div ref={bindEnd} className="flex items-center gap-2 empty:hidden" />
        <div ref={notifBoxRef} className="relative">
          <button
            type="button"
            aria-label="Notifications"
            aria-haspopup="true"
            aria-expanded={notifOpen}
            onClick={toggleNotifications}
            className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)]"
          >
            <IconBell size={16} stroke={1.75} />
          </button>

          {notifOpen && (
            <div
              role="menu"
              aria-label="Notifications"
              className="absolute right-0 top-full z-40 mt-1 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]"
            >
              {notifLoading ? (
                <p className="px-3 py-2 text-[13px] text-[var(--muted-soft)]">Loading…</p>
              ) : notifError ? (
                <div className="px-3 py-2">
                  <p className="text-[13px] text-[var(--error-foreground)]">{notifError}</p>
                  <button
                    type="button"
                    onClick={() => void loadNotifications()}
                    className="mt-1 text-[13px] font-medium text-[var(--brand-primary)] hover:underline"
                  >
                    Try again
                  </button>
                </div>
              ) : notifItems.length === 0 ? (
                <p className="px-3 py-2 text-[13px] text-[var(--muted-soft)]">No notifications</p>
              ) : (
                notifItems.map((n) => (
                  <div key={n.id} role="menuitem" className="px-3 py-2 text-left text-[13px]">
                    <p className="font-medium text-[var(--foreground)]">{n.title}</p>
                    {n.body && <p className="mt-0.5 text-[var(--muted-soft)]">{n.body}</p>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div ref={userMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setUserMenuOpen((o) => !o)}
            title={displayName || undefined}
            aria-label="User menu"
            aria-haspopup="true"
            aria-expanded={userMenuOpen}
            className="shrink-0 rounded-full"
          >
            <span
              /*
               * Seeded from the identity, not a flat brand fill.
               *
               * Basecamp 10198836413 — "Display picture initials show different colours across the
               * website". One person's initials were painted five different ways: the seeded palette on
               * cycles and plan cards, a flat --cta-primary here and in the workspace switcher, a flat
               * --brand-soft in knowledge base comments, and a flat --surface-tertiary in Manage Admins.
               * avatarColor() is the single source, and every swatch in it clears 4.5:1 under white text.
               */
              className="grid h-[30px] w-[30px] place-items-center rounded-full text-[11px] font-semibold text-white"
              style={{ backgroundColor: avatarColor(avatarSeed || "?") }}
            >
              {displayName ? getInitials(displayName) : ""}
            </span>
          </button>

          {userMenuOpen && (
            <div
              role="menu"
              aria-label="User menu"
              className="absolute right-0 top-full z-40 mt-1 w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  router.push("/account");
                }}
                className="block w-full px-3 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
              >
                Profile Settings
              </button>

              <div role="none" className="flex items-center justify-between gap-3 px-3 py-2">
                <p className="text-[13px] text-[var(--foreground)]">Theme</p>
                <ThemeToggle />
              </div>

              <div role="none" className="my-1 border-t border-[var(--border-subtle)]" />

              <button
                type="button"
                role="menuitem"
                disabled={isLoggingOut}
                onClick={() => {
                  setUserMenuOpen(false);
                  void onLogout();
                }}
                className="block w-full px-3 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoggingOut ? "Logging out…" : "Logout"}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
