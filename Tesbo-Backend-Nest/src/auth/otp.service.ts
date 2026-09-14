import { Injectable } from "@nestjs/common";
import { randomBytes, randomInt, createHash } from "crypto";
import { DatabaseService } from "../database/database.service";
import { AppConfigService } from "../config/app-config.service";
import { EmailService } from "./email.service";
import { SessionCacheService } from "../cache/session-cache.service";

@Injectable()
export class OtpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly email: EmailService,
    private readonly sessionCache: SessionCacheService
  ) {}

  async requestOtp(rawEmail: string, _ipAddress?: string | null, _userAgent?: string | null): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase();
    if (!email) return false;

    const plainCode = this.generateOtp();
    const codeHash = this.hash(plainCode);
    const expiresAt = new Date(Date.now() + this.config.otpExpiryMinutes * 60_000);

    await this.db.query("INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)", [
      email,
      codeHash,
      expiresAt
    ]);
    await this.email.sendOtp(email, plainCode);
    return true;
  }

  async verifyOtp(rawEmail: string, code: string, ipAddress?: string | null, userAgent?: string | null): Promise<string | null> {
    const email = rawEmail.trim().toLowerCase();
    if (!(await this.verifyOtpCode(email, code))) return null;
    const userId = await this.findOrCreateUser(email);
    if (!userId) return null;
    return this.createSession(userId, ipAddress, userAgent);
  }

  async verifyOtpCode(rawEmail: string, code: string): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase();

    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM otp_codes WHERE email = $1 AND code_hash = $2 AND expires_at > now() AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [email, this.hash(code.trim())]
    );
    const otpId = result.rows[0]?.id;
    if (!otpId) return false;

    await this.markOtpUsed(otpId);
    return true;
  }

  async createSession(userId: string, ipAddress?: string | null, userAgent?: string | null): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + this.config.sessionDays * 86_400_000);
    await this.db.query(
      "INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [userId, tokenHash, userAgent ?? null, ipAddress ?? null, expiresAt]
    );
    return token;
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

  private async markOtpUsed(otpId: string): Promise<void> {
    await this.db.query("UPDATE otp_codes SET used_at = now() WHERE id = $1", [otpId]);
  }

  private async findOrCreateUser(email: string): Promise<string | null> {
    const existing = await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows[0]) return existing.rows[0].id;
    const inserted = await this.db.query<{ id: string }>(
      "INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
      [email, email.split("@")[0]]
    );
    return inserted.rows[0]?.id ?? (await this.findOrCreateUser(email));
  }

  private generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("base64url");
  }
}
