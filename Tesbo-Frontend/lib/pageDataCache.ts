"use client";

/**
 * A tiny in-memory cache that sidebar-navigated pages seed their initial render
 * from, so revisiting a page you were just on renders its last-known data
 * immediately instead of blocking behind a full-screen loading state. Pages still
 * run their normal fetch on every mount to revalidate in the background, and
 * silently update both their own state and this cache when that resolves — the
 * cache never substitutes for a real fetch, it only decides whether the *first*
 * render shows a spinner or the last-known data. Lives for the SPA session (module
 * scope, cleared on a hard reload), which is exactly the span sidebar nav covers.
 */
const cache = new Map<string, unknown>();

export function getPageCache<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setPageCache<T>(key: string, data: T): void {
  cache.set(key, data);
}

/**
 * Logout is a client-side redirect (router.replace + router.refresh), not a full document reload,
 * so this module's state would otherwise survive it — called from useLogout so the next signed-in
 * session in this tab never renders a stale cache-hit for a page it hasn't fetched yet itself.
 */
export function clearPageCache(): void {
  cache.clear();
}
