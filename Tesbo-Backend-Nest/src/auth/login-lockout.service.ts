import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 24 * 60;

/**
 * Per-email password-login lockout: 5 consecutive failed attempts for one email blocks that email
 * (and only that email) from password login for 24 hours, even with the correct password.
 *
 * Backed by `otp_rate_limit` (V1_init_schema.sql) rather than a new table — it already has exactly
 * this shape (email PRIMARY KEY, attempt_count, locked_until) and is the table the auth layer's own
 * bucket-key convention documents for this purpose: e2e/utils/otp.ts's comments describe rows keyed
 * as `<action>:<email>` (`send:<email>`, `verify:<email>`) rather than a bare email, so two
 * different attempt counters can share one table without colliding. This service follows that same
 * convention with its own `login:` prefix. (OTP's own send/verify limiting that those comments
 * describe is not currently wired up in otp.service.ts — a pre-existing gap, unrelated to this
 * feature — but the table and its keying convention are exactly what this needs.)
 */
@Injectable()
export class LoginLockoutService {
  constructor(private readonly db: DatabaseService) {}

  private key(email: string): string {
    return `login:${email.trim().toLowerCase()}`;
  }

  /**
   * The active lock expiry for this email, or null if it's free to attempt (never locked, or a
   * lock that has already expired). A pure read — letting a lock expire is only ever observed
   * here; recordFailedAttempt is what actually clears an expired lock's row, on the next failure.
   */
  async getActiveLock(email: string): Promise<Date | null> {
    const result = await this.db.query<{ locked_until: string | Date | null }>(
      "SELECT locked_until FROM otp_rate_limit WHERE email = $1",
      [this.key(email)]
    );
    const lockedUntil = result.rows[0]?.locked_until;
    if (!lockedUntil) return null;
    const asDate = new Date(lockedUntil);
    return asDate.getTime() > Date.now() ? asDate : null;
  }

  /**
   * Records one failed password attempt for this email and returns the lock's new expiry once the
   * 5th consecutive failure trips it (null otherwise).
   *
   * A single INSERT ... ON CONFLICT DO UPDATE keyed on the email primary key: two concurrent failed
   * attempts for the same email are serialized by Postgres's own row lock on that key rather than
   * racing a separate read-then-write in application code, so neither request can act on a stale
   * attempt_count and both increments are guaranteed to land — this is what keeps a burst of
   * concurrent requests from ever exceeding MAX_FAILED_ATTEMPTS before the lock takes effect.
   *
   * An attempt arriving after the previous lock has already expired starts a fresh streak at 1
   * instead of compounding on top of the expired one — the 24-hour block is meant to be served
   * once, not extended indefinitely by whoever's next failed guess happens to still be sitting on
   * top of the old counter.
   */
  async recordFailedAttempt(email: string): Promise<Date | null> {
    const result = await this.db.query<{ attempt_count: number; locked_until: string | Date | null }>(
      `INSERT INTO otp_rate_limit (email, attempt_count, locked_until, updated_at)
       VALUES ($1, 1, NULL, now())
       ON CONFLICT (email) DO UPDATE SET
         attempt_count = CASE
           WHEN otp_rate_limit.locked_until IS NOT NULL AND otp_rate_limit.locked_until <= now() THEN 1
           ELSE otp_rate_limit.attempt_count + 1
         END,
         locked_until = CASE
           WHEN otp_rate_limit.locked_until IS NOT NULL AND otp_rate_limit.locked_until <= now() THEN
             CASE WHEN 1 >= $2 THEN now() + ($3 * interval '1 minute') ELSE NULL END
           WHEN otp_rate_limit.attempt_count + 1 >= $2 THEN now() + ($3 * interval '1 minute')
           ELSE otp_rate_limit.locked_until
         END,
         updated_at = now()
       RETURNING attempt_count, locked_until`,
      [this.key(email), MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES]
    );
    const lockedUntil = result.rows[0]?.locked_until;
    return lockedUntil ? new Date(lockedUntil) : null;
  }

  /** Clears the failed-attempt counter and any lock for this email — a successful login, or a completed password reset. */
  async clear(email: string): Promise<void> {
    await this.db.query("DELETE FROM otp_rate_limit WHERE email = $1", [this.key(email)]);
  }
}
