import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";
import { REDIS_CACHE_CLIENT } from "./redis-cache.tokens";

// Short and deliberately not a hit-rate knob: invalidation (see legacy.service.ts's write paths) is
// the primary correctness mechanism for this cache, not the TTL. This bounds the blast radius of a
// missed invalidation hook or a failed Redis DEL to a few seconds, never longer.
const TTL_SECONDS = 10;
// Skip caching (fail open, same as a miss) rather than storing a pathologically large suite tree.
const MAX_VALUE_BYTES = 200 * 1024;

function suitesKey(projectId: string): string {
  return `suites:${projectId}`;
}

/**
 * Redis-backed cache for LegacyService.listSuites(projectId) — a single, already-efficient
 * recursive CTE, but one every request re-runs even when the tree hasn't changed since the last
 * request a moment ago.
 *
 * Best-effort throughout, exactly like EntitlementCacheService/SessionCacheService: a Redis error is
 * treated as a cache miss, so the caller always falls back to running the real query.
 *
 * Invalidation is the primary correctness mechanism here (see every write path to `testcases`/
 * `suites` in legacy.service.ts, each of which calls invalidate(projectId) once its write has
 * durably committed) — the short TTL is strictly a backstop for a missed hook or a failed DEL, not a
 * hit-rate tuning knob.
 */
@Injectable()
export class SuitesCacheService {
  private readonly logger = new Logger(SuitesCacheService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService
  ) {}

  async get<T>(projectId: string): Promise<T | undefined> {
    if (!this.config.suitesCacheEnabled) return undefined;
    try {
      const raw = await this.redis.get(suitesKey(projectId));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn(`suites cache read failed, falling back to Postgres: ${(error as Error).message}`);
      return undefined;
    }
  }

  async set<T>(projectId: string, value: T): Promise<void> {
    if (!this.config.suitesCacheEnabled) return;
    try {
      const serialized = JSON.stringify(value);
      // Oversized payload: skip caching rather than storing it — a fail-open, not an error.
      if (Buffer.byteLength(serialized, "utf8") > MAX_VALUE_BYTES) return;
      await this.redis.set(suitesKey(projectId), serialized, "EX", TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`suites cache write failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /** Called once, after a write to `testcases`/`suites` for this project has durably committed. */
  async invalidate(projectId: string): Promise<void> {
    if (!this.config.suitesCacheEnabled) return;
    try {
      await this.redis.del(suitesKey(projectId));
    } catch (error) {
      this.logger.warn(`suites cache invalidation failed (non-fatal): ${(error as Error).message}`);
    }
  }
}
