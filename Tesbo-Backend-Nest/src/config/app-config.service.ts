import { Injectable } from "@nestjs/common";
import * as dotenv from "dotenv";
import { existsSync } from "fs";
import { join } from "path";

@Injectable()
export class AppConfigService {
  private readonly env = this.loadEnv();

  readonly port = this.integer("PORT", 7000);
  readonly databaseUrl = this.normalizeDatabaseUrl(this.string("DATABASE_URL", "postgresql://localhost:5432/tesbo"));
  readonly databaseUser = this.optionalString("DATABASE_USER");
  readonly databasePassword = this.optionalString("DATABASE_PASSWORD");
  readonly postmarkApiToken = this.string("POSTMARK_API_TOKEN", "");
  readonly postmarkFromEmail = this.string("POSTMARK_FROM_EMAIL", "noreply@example.com");
  readonly otpExpiryMinutes = this.integer("OTP_EXPIRY_MINUTES", 10);
  readonly otpMaxAttempts = this.integer("OTP_MAX_ATTEMPTS", 5);
  readonly otpRateLimitWindowMinutes = this.integer("OTP_RATE_LIMIT_WINDOW_MINUTES", 15);
  readonly sessionDays = this.integer("SESSION_DAYS", 30);
  readonly sessionCookieName = "tesbo_session";
  readonly corsAllowedOrigins = this.parseCorsAllowedOrigins();
  readonly frontendUrl = this.string("FRONTEND_URL", "http://localhost:3000");
  readonly uploadDir = this.string("UPLOAD_DIR", "./uploads");
  readonly maxUploadSize = this.integer("MAX_UPLOAD_SIZE", 10485760);

  private loadEnv(): Record<string, string | undefined> {
    const dotenvPath = this.findDotEnvPath();
    const parsed = dotenvPath ? dotenv.config({ path: dotenvPath }).parsed ?? {} : {};
    return { ...process.env, ...parsed };
  }

  normalizeCorsOrigin(raw?: string | null): string {
    if (!raw) return "";
    let origin = raw.trim();
    if (origin.charCodeAt(0) === 0xfeff) origin = origin.slice(1).trim();
    while (origin.endsWith("/")) origin = origin.slice(0, -1).trim();
    return origin;
  }

  private parseCorsAllowedOrigins(): Set<string> {
    const defaults = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "https://frontdoor.tesbo.io",
      "https://automate.tesbo.io",
      "https://exe.tesbo.io",
      "https://backdoor.tesbo.io"
    ].join(",");
    const csv = this.string("CORS_ALLOWED_ORIGINS", defaults).trim() || defaults;
    return new Set(
      csv
        .split(",")
        .map((value) => this.normalizeCorsOrigin(value))
        .filter(Boolean)
    );
  }

  private normalizeDatabaseUrl(raw: string): string {
    const value = raw.trim();
    if (value.startsWith("jdbc:postgresql://")) return value.slice("jdbc:".length);
    if (value.startsWith("jdbc:postgres://")) return value.slice("jdbc:".length);
    return value;
  }

  private string(key: string, defaultValue: string): string {
    return this.env?.[key] ?? process.env[key] ?? defaultValue;
  }

  private optionalString(key: string): string {
    return (this.env?.[key] ?? process.env[key] ?? "").trim();
  }

  private integer(key: string, defaultValue: number): number {
    const value = this.env?.[key] ?? process.env[key];
    if (value == null || value.trim() === "") return defaultValue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return defaultValue;
    return parsed;
  }

  private findDotEnvPath(): string | null {
    const candidates = [join(process.cwd(), ".env"), join(process.cwd(), "backend", ".env")];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }
}
