import { Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "crypto";
import { DatabaseService } from "../database/database.service";
import { AppConfigService } from "../config/app-config.service";
import { EmailService } from "./email.service";

@Injectable()
export class OtpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly email: EmailService
  ) {}

  async requestOtp(rawEmail: string, ipAddress?: string | null, _userAgent?: string | null): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase();
    if (!email) return false;
    const ipKey = this.rateLimitKeyForIp(ipAddress);
    if ((await this.isRateLimited(email)) || (await this.isRateLimited(ipKey))) return false;

    const plainCode = this.generateOtp();
    const codeHash = this.hash(plainCode);
    const expiresAt = new Date(Date.now() + this.config.otpExpiryMinutes * 60_000);

    await this.db.query("INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)", [
      email,
      codeHash,
      expiresAt
    ]);
    await this.recordOtpAttempt(email);
    await this.recordOtpAttempt(ipKey);
    await this.email.sendOtp(email, plainCode);
    return true;
  }

  async verifyOtp(rawEmail: string, code: string, ipAddress?: string | null, userAgent?: string | null): Promise<string | null> {
    const email = rawEmail.trim().toLowerCase();
    const ipKey = this.rateLimitKeyForIp(ipAddress);
    if ((await this.isRateLimited(email)) || (await this.isRateLimited(ipKey))) return null;

    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM otp_codes WHERE email = $1 AND code_hash = $2 AND expires_at > now() AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [email, this.hash(code.trim())]
    );
    const otpId = result.rows[0]?.id;
    if (!otpId) {
      await this.recordOtpAttempt(email);
      await this.recordOtpAttempt(ipKey);
      return null;
    }

    await this.markOtpUsed(otpId);
    const userId = await this.findOrCreateUser(email);
    if (!userId) return null;
    const token = await this.createSession(userId, ipAddress, userAgent);
    await this.clearRateLimit(email);
    await this.clearRateLimit(ipKey);
    return token;
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
    const result = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
      [this.hash(sessionToken)]
    );
    return result.rows[0]?.user_id ?? null;
  }

  async invalidateSession(sessionToken: string): Promise<void> {
    if (!sessionToken?.trim()) return;
    await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [this.hash(sessionToken)]);
  }

  private async isRateLimited(key: string): Promise<boolean> {
    const result = await this.db.query<{ locked_until: Date | null }>("SELECT locked_until FROM otp_rate_limit WHERE email = $1", [key]);
    const lockedUntil = result.rows[0]?.locked_until;
    return !!lockedUntil && lockedUntil.getTime() > Date.now();
  }

  private async recordOtpAttempt(key: string): Promise<void> {
    const sql = `
      INSERT INTO otp_rate_limit (email, attempt_count, locked_until, updated_at)
      VALUES ($1, 1, NULL, now())
      ON CONFLICT (email) DO UPDATE
      SET attempt_count = otp_rate_limit.attempt_count + 1,
          locked_until = CASE
            WHEN otp_rate_limit.attempt_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
            ELSE otp_rate_limit.locked_until
          END,
          updated_at = now()
    `;
    await this.db.query(sql, [key, this.config.otpMaxAttempts, this.config.otpRateLimitWindowMinutes]);
  }

  private async clearRateLimit(key: string): Promise<void> {
    await this.db.query("DELETE FROM otp_rate_limit WHERE email = $1", [key]);
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

  private rateLimitKeyForIp(ipAddress?: string | null): string {
    return `ip:${ipAddress?.trim() ?? ""}`;
  }

  private generateOtp(): string {
    let code = "";
    for (let i = 0; i < 6; i += 1) code += Math.floor(Math.random() * 10).toString();
    return code;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("base64url");
  }
}
