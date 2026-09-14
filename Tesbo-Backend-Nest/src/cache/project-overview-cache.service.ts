import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";
import { REDIS_CACHE_CLIENT } from "./redis-cache.tokens";

// TTL-only by design — see Phase Set C's C3. The per-project aggregate this caches depends on
// testcases/suites (dense, already covered by SuitesCacheService's write surface) plus cycles/
// executions/project_members plus a 5-table lastActivityAt union PLUS audit_logs (written from ~50
// call sites across the app for action types far beyond testcase/suite CRUD). Enumerating every
// write path to all of that, on top of what SuitesCacheService already tracks, is disproportionate
// to the benefit at a single-digit-second TTL, so unlike SuitesCacheService/TestcasesListCacheService
// there is no invalidate() here at all — staleness is bounded purely by this TTL, a deliberate,
// disclosed trade-off, not an oversight.
const TTL_SECONDS = 10;
const MAX_VALUE_BYTES = 200 * 1024;

function overviewKey(projectId: string): string {
  return `project-overview:${projectId}`;
}

/**
 * Redis-backed cache for the per-project aggregate half of LegacyService.projectsOverview(userId) —
 * testCaseCount/suiteCount/teamMembers/lastActivityAt/runCounts/status/currentPassRate. Keyed per
 * project (never per user): every one of the underlying queries filters only on
 * `project_id = ANY($1::uuid[])`, never on the caller, so the same cached entry is correct for every
 * member of a project — confirmed directly against the current query text before this cache was
 * written, not assumed.
 *
 * `projectsOverview` itself stays responsible for `listProjects(uid)` (never cached here) and for
 * merging each project's own row (name/key/role/...) with these cached aggregate fields — this
 * service only ever sees project ids, never user ids, by construction.
 *
 * Best-effort throughout, like every other Redis cache in this codebase: any failure here is treated
 * as "nothing was cached," so every id simply falls through to a fresh computation — Redis being
 * unavailable degrades this to exactly today's always-fresh-query behavior, never worse.
 */
@Injectable()
export class ProjectOverviewCacheService {
  private readonly logger = new Logger(ProjectOverviewCacheService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService
  ) {}

  /** Returns only the ids that were actually found cached — every miss (including "Redis is down")
   *  is simply absent from the returned Map, never a thrown error. */
  async getMany<T>(projectIds: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    if (!this.config.projectOverviewCacheEnabled || !projectIds.length) return result;
    try {
      const raws = await this.redis.mget(...projectIds.map(overviewKey));
      raws.forEach((raw, index) => {
        if (raw === null) return;
        try {
          result.set(projectIds[index], JSON.parse(raw) as T);
        } catch {
          // One corrupt entry degrades to a miss for that single id, not the whole batch.
        }
      });
    } catch (error) {
      this.logger.warn(`project-overview cache read failed, falling back to Postgres: ${(error as Error).message}`);
    }
    return result;
  }

  async setMany<T>(entries: Map<string, T>): Promise<void> {
    if (!this.config.projectOverviewCacheEnabled || !entries.size) return;
    try {
      const pipeline = this.redis.multi();
      let queued = 0;
      for (const [projectId, value] of entries) {
        const serialized = JSON.stringify(value);
        // Oversized payload: skip caching this one entry rather than storing it — a fail-open, not
        // an error, and it doesn't block the other entries in the same batch.
        if (Buffer.byteLength(serialized, "utf8") > MAX_VALUE_BYTES) continue;
        pipeline.set(overviewKey(projectId), serialized, "EX", TTL_SECONDS);
        queued++;
      }
      if (queued) await pipeline.exec();
    } catch (error) {
      this.logger.warn(`project-overview cache write failed (non-fatal): ${(error as Error).message}`);
    }
  }
}
