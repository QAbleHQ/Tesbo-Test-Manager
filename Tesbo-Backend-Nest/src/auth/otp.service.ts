import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { randomBytes, randomInt, createHash } from "crypto";
import { DatabaseService } from "../database/database.service";
import { AppConfigService } from "../config/app-config.service";
import { EmailService } from "./email.service";
import { SessionCacheService } from "../cache/session-cache.service";
import { WelcomeEmailService } from "../welcome-email/welcome-email.service";
import { ACTIVITY_TZ } from "./user-activity.service";

// A 6-digit code has 1M values, so the guess budget has to be per code, not per caller: signup and
// invite verification share verifyOtpCode and have no other limiter. Five guesses per code, and at
// most ten codes per email per hour, caps a blind attacker at 50 guesses an hour per email (0.005%).
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 10;
const MAX_CODE_LENGTH = 64;

/** Too many codes requested for one email. Callers must let this through, not report it as a delivery failure. */
export class OtpRateLimitedException extends HttpException {
  constructor() {
    super({ error: "otp_rate_limited" }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class OtpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly email: EmailService,
    private readonly sessionCache: SessionCacheService,
    private readonly welcomeEmail: WelcomeEmailService
  ) {}

  async requestOtp(rawEmail: string, _ipAddress?: string | null, _userAgent?: string | null): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase();
    if (!email) return false;

    const plainCode = this.generateOtp();
    const codeHash = this.hash(plainCode);
    const expiresAt = new Date(Date.now() + this.config.otpExpiryMinutes * 60_000);

    await this.db.transaction(async (client) => {
      // One request at a time per email, so a burst cannot all read the same count and overshoot the cap.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`otp:${email}`]);
      const recent = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM otp_codes WHERE email = $1 AND created_at > now() - interval '1 hour'",
        [email]
      );
      if (Number(recent.rows[0]?.n ?? 0) >= MAX_REQUESTS_PER_HOUR) throw new OtpRateLimitedException();
      // Only the newest code may work. Left live, N requests would leave N codes to guess against.
      // Marked used rather than deleted so the row count still shows how many were sent.
      await client.query("UPDATE otp_codes SET used_at = now() WHERE email = $1 AND used_at IS NULL", [email]);
      await client.query("INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)", [
        email,
        codeHash,
        expiresAt
      ]);
    });
    await this.email.sendOtp(email, plainCode);
    return true;
  }

  async verifyOtp(rawEmail: string, code: string, ipAddress?: string | null, userAgent?: string | null): Promise<string | null> {
    const email = rawEmail.trim().toLowerCase();
    if (!(await this.verifyOtpCode(email, code))) return null;
    const user = await this.findOrCreateUser(email);
    if (!user) return null;
    // Passwordless sign-in doubles as signup: only a call that actually created the account welcomes
    // it — an existing user signing in with a code is not a registration.
    if (user.created) await this.welcomeEmail.schedule(user.id);
    return this.createSession(user.id, ipAddress, userAgent);
  }

  async verifyOtpCode(rawEmail: string, code: string): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase();
    // A non-string body field (number, object) used to throw on .trim() and surface as a 500.
    if (typeof code !== "string") return false;
    const guess = code.trim();
    if (!guess || guess.length > MAX_CODE_LENGTH) return false;

    // Spend an attempt BEFORE comparing. A read-then-increment lets a parallel burst all see
    // attempts < max and each get a guess; one UPDATE makes Postgres serialise on the row lock and
    // re-check `attempts < max` after the wait, so no more than MAX guesses ever get through.
    const live = await this.db.query<{ id: string; code_hash: string }>(
      `UPDATE otp_codes SET attempts = attempts + 1
       WHERE email = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2
       RETURNING id, code_hash`,
      [email, MAX_VERIFY_ATTEMPTS]
    );
    const guessHash = this.hash(guess);
    const match = live.rows.find((row) => row.code_hash === guessHash);
    if (!match) return false;

    // Single use even under two simultaneous correct submissions: only the call that flips used_at wins.
    return this.markOtpUsed(match.id);
  }

  async createSession(userId: string, ipAddress?: string | null, userAgent?: string | null): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + this.config.sessionDays * 86_400_000);
    await this.db.query(
      "INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [userId, tokenHash, userAgent ?? null, ipAddress ?? null, expiresAt]
    );
    // Not awaited: tracking must not add latency to, or be able to fail, a sign-in.
    void this.recordLogin(userId);
    return token;
  }

  /**
   * Feeds the daily analytics report (V136). Every sign-in path ends in createSession, so recording
   * here covers OTP, password, signup and invite logins with one write. Best-effort: a tracking
   * failure must never fail a login.
   */
  private async recordLogin(userId: string): Promise<void> {
    try {
      await this.db.query(
        `WITH u AS (UPDATE users SET last_login_at = now(), last_active_at = now() WHERE id = $1 RETURNING id)
         INSERT INTO user_daily_activity (user_id, activity_date, logged_in)
         SELECT u.id, (now() AT TIME ZONE '${ACTIVITY_TZ}')::date, true FROM u
         ON CONFLICT (user_id, activity_date) DO UPDATE SET logged_in = true`,
        [userId]
      );
    } catch (error) {
      console.warn("Login activity tracking failed (non-fatal):", error);
    }
  }

  async resolveSession(sessionToken: string): Promise<string | null> {
    if (!sessionToken?.trim()) return null;
    const tokenHash = this.hash(sessionToken);

    // Redis-backed cache, checked before Postgres: undefined = miss (fall through below), null =
    // known-invalid, string = the cached userId. A cache error already reads as undefined (miss), so
    // this is never worse than skipping the cache entirely.
    const cached = await this.sessionCache.get(tokenHash);
    if (cached !== undefined) return cached;

    const result = await this.db.query<{ user_id: string; expires_at: string }>(
      "SELECT user_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()",
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) {
      await this.sessionCache.setInvalid(tokenHash);
      return null;
    }
    await this.sessionCache.setValid(tokenHash, row.user_id, new Date(row.expires_at));
    return row.user_id;
  }

  async invalidateSession(sessionToken: string): Promise<void> {
    if (!sessionToken?.trim()) return;
    const tokenHash = this.hash(sessionToken);
    await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    await this.sessionCache.invalidateToken(tokenHash);
  }

  /** Signs the user out of every session, including the one making this call. */
  async invalidateAllSessions(userId: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await this.sessionCache.invalidateAllForUser(userId);
  }

  private async markOtpUsed(otpId: string): Promise<boolean> {
    const result = await this.db.query("UPDATE otp_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL", [otpId]);
    return (result.rowCount ?? 0) > 0;
  }

  private async findOrCreateUser(email: string): Promise<{ id: string; created: boolean } | null> {
    const existing = await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    const inserted = await this.db.query<{ id: string }>(
      "INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
      [email, email.split("@")[0]]
    );
    // No row back means a concurrent verify won the insert — that call is the one that created (and
    // welcomes) the account, so this one re-reads it as existing.
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    return this.findOrCreateUser(email);
  }

  private generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("base64url");
  }
}
