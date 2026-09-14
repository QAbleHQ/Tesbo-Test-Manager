import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";
import { REDIS_CACHE_CLIENT } from "./redis-cache.tokens";

// Same reasoning as SuitesCacheService: invalidation is the primary correctness mechanism, this TTL
// is strictly a backstop for a missed hook or a failed Redis command.
const TTL_SECONDS = 10;
const MAX_VALUE_BYTES = 200 * 1024;
// Bounds the per-project key-set index to roughly the cache entries' own lifetime, refreshed on every
// add — an abandoned index (a project nobody revisits) just expires rather than growing forever.
const KEY_INDEX_TTL_SECONDS = 20;

function listKey(projectId: string, limit: number, offset: number): string {
  return `testcases-nofilter:${projectId}:${limit}:${offset}`;
}

function keyIndexKey(projectId: string): string {
  return `testcases-nofilter-keys:${projectId}`;
}

/**
 * Redis-backed cache for LegacyService.listTestCases(projectId, query) — but only for the shape with
 * every filter dimension absent (plain pagination through the whole non-archived repository), never
 * for an arbitrary filtered/sorted/searched query. See Phase Set C's C2 for why: listTestCases takes
 * ~10 independent, freely-combinable filter params, so caching arbitrary shapes would produce
 * near-zero hit rates and unbounded per-project Redis key growth.
 *
 * One project can have several distinct (limit, offset) cache entries alive at once (unlike
 * SuitesCacheService's single per-project key), so invalidation walks a per-project secondary index
 * of the exact keys currently populated — the same SADD-index pattern SessionCacheService uses for
 * invalidateAllForUser — rather than trying to guess every live key.
 *
 * Best-effort throughout, exactly like the other Redis caches: a Redis error is treated as a cache
 * miss, so the caller always falls back to running the real query.
 */
@Injectable()
export class TestcasesListCacheService {
  private readonly logger = new Logger(TestcasesListCacheService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService
  ) {}

  async get<T>(projectId: string, limit: number, offset: number): Promise<T | undefined> {
    if (!this.config.testcasesListCacheEnabled) return undefined;
    try {
      const raw = await this.redis.get(listKey(projectId, limit, offset));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn(`testcases-list cache read failed, falling back to Postgres: ${(error as Error).message}`);
      return undefined;
    }
  }

  async set<T>(projectId: string, limit: number, offset: number, value: T): Promise<void> {
    if (!this.config.testcasesListCacheEnabled) return;
    try {
      const serialized = JSON.stringify(value);
      // Oversized payload: skip caching rather than storing it — a fail-open, not an error.
      if (Buffer.byteLength(serialized, "utf8") > MAX_VALUE_BYTES) return;
      const key = listKey(projectId, limit, offset);
      const indexKey = keyIndexKey(projectId);
      await this.redis.multi().set(key, serialized, "EX", TTL_SECONDS).sadd(indexKey, key).expire(indexKey, KEY_INDEX_TTL_SECONDS).exec();
    } catch (error) {
      this.logger.warn(`testcases-list cache write failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /** Called once, after a write to `testcases` for this project has durably committed. Clears every
   *  (limit, offset) variant cached for the project, not just one. */
  async invalidate(projectId: string): Promise<void> {
    if (!this.config.testcasesListCacheEnabled) return;
    try {
      const indexKey = keyIndexKey(projectId);
      const keys = await this.redis.smembers(indexKey);
      if (!keys.length) {
        await this.redis.del(indexKey);
        return;
      }
      const pipeline = this.redis.multi();
      for (const key of keys) pipeline.del(key);
      pipeline.del(indexKey);
      await pipeline.exec();
    } catch (error) {
      this.logger.warn(`testcases-list cache invalidation failed (non-fatal): ${(error as Error).message}`);
    }
  }
}
