import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CACHE_CLIENT } from "../cache/redis-cache.tokens";
import { DatabaseService } from "../database/database.service";

/** The calendar the daily report is scheduled, labelled and bucketed in. India observes no DST. */
export const ACTIVITY_TZ = "Asia/Kolkata";

// One DB write per user per window, not per request. last_active_at is therefore accurate to this
// window; the daily `engaged` flag is not affected (the first mutation of a day always writes).
const THROTTLE_SECONDS = 300;

// A day key from the IST date, so a mutation at 00:01 is never swallowed by the throttle key a
// mutation at 23:58 set - that user's only action of the new day would otherwise be lost.
function istDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ACTIVITY_TZ }).format(now);
}

/**
 * Records "this user did something" for the daily analytics report: users.last_active_at plus
 * user_daily_activity.engaged. Login is recorded separately in OtpService.createSession, the single
 * choke point every sign-in path goes through.
 *
 * Best-effort by design: tracking must never fail or slow a user's request, so every error is
 * swallowed (logged). If Redis is down the throttle is skipped and the write goes straight to
 * Postgres - correct, just more writes.
 */
@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis
  ) {}

  async recordMutation(userId: string): Promise<void> {
    try {
      if (!(await this.claimWindow(userId))) return;
      // A user row that no longer exists (deleted mid-request) yields no rows from the UPDATE, so
      // nothing is inserted and the FK can never fire.
      await this.db.query(
        `WITH u AS (UPDATE users SET last_active_at = now() WHERE id = $1 RETURNING id)
         INSERT INTO user_daily_activity (user_id, activity_date, engaged)
         SELECT u.id, (now() AT TIME ZONE '${ACTIVITY_TZ}')::date, true FROM u
         ON CONFLICT (user_id, activity_date) DO UPDATE SET engaged = true`,
        [userId]
      );
    } catch (error) {
      this.logger.warn(`activity tracking failed (non-fatal): ${(error as Error).message}`);
    }
  }

  /** True when this caller should write. Redis trouble means "write anyway". */
  private async claimWindow(userId: string): Promise<boolean> {
    try {
      const won = await this.redis.set(`activity:${istDay()}:${userId}`, "1", "EX", THROTTLE_SECONDS, "NX");
      return won === "OK";
    } catch {
      return true;
    }
  }
}
