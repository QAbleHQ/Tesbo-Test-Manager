import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";
import { REDIS_CACHE_CLIENT } from "./redis-cache.tokens";

// A cached entry never outlives what the DB itself would honor (capped against the session's own
// remaining expires_at at set time) - this is a ceiling, not a guarantee of freshness beyond it.
const POSITIVE_TTL_SECONDS = 60;
// Short-lived negative cache for a dead/guessed token, so repeated attempts against it don't each
// cost a Postgres round trip. Deliberately much shorter than the positive TTL: mirrors
// country-detection.service.ts's asymmetric-TTL idiom (short TTL for "no", long TTL for "yes").
const NEGATIVE_TTL_SECONDS = 15;
const NEGATIVE_SENTINEL = "invalid-session";
// Bounds the per-user token-hash index (see invalidateAllForUser) to roughly the lifetime of the
// cache entries it points at, refreshed on every add - so an abandoned index for a user who never
// logs in again just expires, rather than growing forever.
const USER_INDEX_TTL_SECONDS = 120;

function sessionKey(tokenHash: string): string {
  return `session:${tokenHash}`;
}

function userIndexKey(userId: string): string {
  return `user-sessions:${userId}`;
}

/**
 * Redis-backed cache for OtpService.resolveSession, so the session-table round trip every
 * authenticated request pays today isn't paid on every request against the same still-valid token.
 *
 * Every method is best-effort: a Redis error is swallowed and treated exactly like a cache miss, so
 * OtpService always has a safe, correct fallback (read Postgres directly) - this cache can only make
 * things faster, never wrong, and Redis being unreachable degrades this to exactly today's behavior.
 */
@Injectable()
export class SessionCacheService {
  private readonly logger = new Logger(SessionCacheService.name);

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService
  ) {}

  /** undefined = cache miss (caller must check Postgres); null = known-invalid; string = userId. */
  async get(tokenHash: string): Promise<string | null | undefined> {
    if (!this.config.sessionCacheEnabled) return undefined;
    try {
      const raw = await this.redis.get(sessionKey(tokenHash));
      if (raw === null) return undefined;
      return raw === NEGATIVE_SENTINEL ? null : raw;
    } catch (error) {
      this.logger.warn(`session cache read failed, falling back to Postgres: ${(error as Error).message}`);
      return undefined;
    }
  }

  async setValid(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    if (!this.config.sessionCacheEnabled) return;
    const remainingSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    const ttl = Math.min(POSITIVE_TTL_SECONDS, remainingSeconds);
    if (ttl <= 0) return; // already expired by the time we got here - nothing worth caching
    try {
      await this.redis
        .multi()
        .set(sessionKey(tokenHash), userId, "EX", ttl)
        .sadd(userIndexKey(userId), tokenHash)
        .expire(userIndexKey(userId), USER_INDEX_TTL_SECONDS)
        .exec();
    } catch (error) {
      this.logger.warn(`session cache write failed (non-fatal): ${(error as Error).message}`);
    }
  }

  async setInvalid(tokenHash: string): Promise<void> {
    if (!this.config.sessionCacheEnabled) return;
    try {
      await this.redis.set(sessionKey(tokenHash), NEGATIVE_SENTINEL, "EX", NEGATIVE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`session cache negative-write failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /** Called on logout (one token). */
  async invalidateToken(tokenHash: string): Promise<void> {
    if (!this.config.sessionCacheEnabled) return;
    try {
      await this.redis.del(sessionKey(tokenHash));
    } catch (error) {
      this.logger.warn(`session cache invalidation failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /**
   * Called on password change/reset ("sign out everywhere"). The cache is keyed by token hash, not
   * user id, so this walks the per-user index built up by setValid's SADD rather than trying to
   * guess every token - a TTL-only alternative was rejected because it would let a stolen session
   * outlive the password change it's supposed to be killed by, by up to the positive TTL.
   */
  async invalidateAllForUser(userId: string): Promise<void> {
    if (!this.config.sessionCacheEnabled) return;
    try {
      const tokenHashes = await this.redis.smembers(userIndexKey(userId));
      const pipeline = this.redis.multi();
      for (const tokenHash of tokenHashes) pipeline.del(sessionKey(tokenHash));
      pipeline.del(userIndexKey(userId));
      await pipeline.exec();
    } catch (error) {
      this.logger.warn(`session cache bulk invalidation failed (non-fatal): ${(error as Error).message}`);
    }
  }
}
