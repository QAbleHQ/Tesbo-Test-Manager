import { AsyncLocalStorage } from "async_hooks";
import { Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service";

type Store = Map<string, Promise<unknown>>;

/**
 * Memoizes read-only lookups for the lifetime of a single HTTP request, so the same row doesn't get
 * re-queried by unrelated guards/services that don't know about each other (see B1 of the platform
 * performance remediation plan: one create-testcase request read the `projects` row 5 times and the
 * `organizations` entitlement row 2 times before this existed).
 *
 * Deliberately NOT a general-purpose cache: only call sites that have individually reasoned about
 * why the memoized value can't go stale mid-request should use `remember()`. Nothing here decides
 * that on their behalf.
 *
 * Backed by AsyncLocalStorage, scoped by `run()` around the whole request in main.ts. Outside that
 * scope (BullMQ processors, unit tests, anything invoked off the request path) or with the kill
 * switch off, `remember()` always calls the loader directly — a miss must degrade to today's
 * uncached behavior, never to a stale or wrong answer.
 */
@Injectable()
export class RequestCacheService {
  private readonly als = new AsyncLocalStorage<Store>();

  constructor(private readonly config: AppConfigService) {}

  run<T>(fn: () => T): T {
    return this.als.run(new Map(), fn);
  }

  /**
   * Returns the memoized value for `key` within the current request, computing it via `loader()`
   * on a miss. Concurrent calls for the same key inside one request share the same in-flight
   * promise rather than issuing two queries. A rejected loader is not cached — the next call
   * (in this request) gets a fresh attempt.
   */
  async remember<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const store = this.als.getStore();
    if (!store || !this.config.enableRequestScopedCache) return loader();

    if (store.has(key)) return store.get(key) as Promise<T>;

    const promise = loader().catch((err) => {
      store.delete(key);
      throw err;
    });
    store.set(key, promise);
    return promise;
  }

  /** Drops one memoized entry, e.g. after this same request writes the row it came from. */
  invalidate(key: string): void {
    this.als.getStore()?.delete(key);
  }

  /** Drops every memoized entry whose key starts with `prefix` (e.g. all entries for one project id). */
  invalidatePrefix(prefix: string): void {
    this.invalidateWhere((key) => key.startsWith(prefix));
  }

  /** Drops every memoized entry whose key matches `predicate` (e.g. every project's entry for one user id). */
  invalidateWhere(predicate: (key: string) => boolean): void {
    const store = this.als.getStore();
    if (!store) return;
    for (const key of store.keys()) {
      if (predicate(key)) store.delete(key);
    }
  }
}
