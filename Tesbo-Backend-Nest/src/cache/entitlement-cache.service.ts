import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";
import { REDIS_CACHE_CLIENT } from "./redis-cache.tokens";

// Deliberately short, and deliberately not zero-tolerance like sessions: BillingService's own
// reconcile/self-heal logic already tolerates this class of eventual consistency between Stripe and
// the DB, so a bounded staleness window here is not a new risk, just a smaller one than what already
// exists between a Stripe event firing and its webhook landing.
const TTL_SECONDS = 45;

function entitlementKey(organizationId: string): string {
  return `entitlement:${organizationId}`;
}

/**
 * Redis-backed cache for PlanLimitsService's per-organization entitlement snapshot. Sits underneath
 * the request-scoped memoization added in an earlier phase (RequestCacheService) - that one
 * collapses repeat reads within a single request, this one collapses repeat reads across requests.
 *
 * Best-effort throughout: a Redis error is treated exactly like a cache miss, so the caller always
 * falls back to computing the entitlement from Postgres directly.
 *
 * Known, accepted gap: an admin plan override (V76_admin_plan_override.sql) is applied by a direct
 * SQL statement with no application code path to hook an invalidation into. A cached entitlement can
 * therefore lag such a change by up to TTL_SECONDS - mitigated by keeping that TTL short, and
 * documented for anyone applying such an override to also clear `entitlement:<organizationId>` from
 * Redis, or simply wait out the TTL.
 */
@Injectable()
export class EntitlementCacheService {
  private readonly logger = new Logger(EntitlementCacheService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService
  ) {}

  async get<T>(organizationId: string): Promise<T | undefined> {
    if (!this.config.entitlementCacheEnabled) return undefined;
    try {
      const raw = await this.redis.get(entitlementKey(organizationId));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn(`entitlement cache read failed, falling back to Postgres: ${(error as Error).message}`);
      return undefined;
    }
  }

  async set<T>(organizationId: string, value: T): Promise<void> {
    if (!this.config.entitlementCacheEnabled) return;
    try {
      await this.redis.set(entitlementKey(organizationId), JSON.stringify(value), "EX", TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`entitlement cache write failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /** Called on every write that changes plan / plan_grace_ends_at / plan_source / plan_override_*. */
  async invalidate(organizationId: string): Promise<void> {
    if (!this.config.entitlementCacheEnabled) return;
    try {
      await this.redis.del(entitlementKey(organizationId));
    } catch (error) {
      this.logger.warn(`entitlement cache invalidation failed (non-fatal): ${(error as Error).message}`);
    }
  }
}
