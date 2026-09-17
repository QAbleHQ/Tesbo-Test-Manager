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
 * Drops one entry so the next mount of that page can't seed its first render from data a
 * mutation elsewhere just made stale — for a route that changed another page's data without
 * ever holding a reference to that page's own state (e.g. the Zyra chat panel saving test cases
 * into the repository the Test Cases page has cached under `testcases:${projectId}`).
 */
export function invalidatePageCache(key: string): void {
  cache.delete(key);
}

/**
 * Logout is a client-side redirect (router.replace + router.refresh), not a full document reload,
 * so this module's state would otherwise survive it — called from useLogout so the next signed-in
 * session in this tab never renders a stale cache-hit for a page it hasn't fetched yet itself.
 */
export function clearPageCache(): void {
  cache.clear();
}
