import { BadRequestException, Injectable } from "@nestjs/common";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { DatabaseService } from "../database/database.service";
import { LoginLockoutService } from "./login-lockout.service";

const MIN_LENGTH = 8;
const MAX_LENGTH = 16;

@Injectable()
export class PasswordService {
  private readonly iterations = 210000;
  private readonly keyLengthBytes = 32;

  constructor(
    private readonly db: DatabaseService,
    private readonly lockout: LoginLockoutService
  ) {}

  /**
   * The single source of truth for password policy — every path that sets a password
   * (signup, invite registration, first-admin setup, change-password, reset-password)
   * goes through hashPassword(), so this is the one place the rule can ever diverge.
   */
  assertValidPassword(password: string | undefined): void {
    const value = password ?? "";
    if (value.length < MIN_LENGTH) {
      throw new BadRequestException({ error: `Password must be at least ${MIN_LENGTH} characters` });
    }
    if (value.length > MAX_LENGTH) {
      throw new BadRequestException({ error: `Password must be at most ${MAX_LENGTH} characters` });
    }
    if (!/[a-z]/.test(value)) {
      throw new BadRequestException({ error: "Password must include at least one lowercase letter" });
    }
    if (!/[A-Z]/.test(value)) {
      throw new BadRequestException({ error: "Password must include at least one uppercase letter" });
    }
    if (!/[0-9]/.test(value)) {
      throw new BadRequestException({ error: "Password must include at least one number" });
    }
  }

  async verifyLogin(
    rawEmail: string,
    password: string
  ): Promise<
    | { outcome: "ok"; userId: string }
    | { outcome: "not_found" }
    | { outcome: "invalid_password" }
    | { outcome: "locked"; lockedUntil: Date }
  > {
    if (!rawEmail?.trim() || !password?.trim()) return { outcome: "invalid_password" };
    const email = rawEmail.trim().toLowerCase();
    const result = await this.db.query<{ id: string; password_hash: string | null }>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email]
    );
    const row = result.rows[0];
    if (!row) return { outcome: "not_found" };

    // Checked before the password itself: a blocked email must not succeed even with the correct
    // password, and a locked-out attempt must not tick the counter (and its lock) further.
    const activeLock = await this.lockout.getActiveLock(email);
    if (activeLock) return { outcome: "locked", lockedUntil: activeLock };

    if (!row.password_hash) return { outcome: "invalid_password" };

    if (!this.verifyPassword(password, row.password_hash)) {
      // The failure that trips the lock (the 5th) still reads as an ordinary wrong-password
      // response for this request — the lock only takes effect starting with the *next* attempt,
      // which is what the getActiveLock check above catches. recordFailedAttempt's return value is
      // intentionally not used to change this attempt's own outcome.
      await this.lockout.recordFailedAttempt(email);
      return { outcome: "invalid_password" };
    }

    await this.lockout.clear(email);
    return { outcome: "ok", userId: row.id };
  }

  /** Used by the password-reset flow: completing a reset unblocks the email it was for. */
  async clearLoginLockout(email: string): Promise<void> {
    await this.lockout.clear(email);
  }

  hashPassword(password: string): string {
    this.assertValidPassword(password);
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, this.iterations, this.keyLengthBytes, "sha256");
    return `pbkdf2_sha256$${this.iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
  }

  async hasPassword(userId: string): Promise<boolean> {
    const result = await this.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
    return !!result.rows[0]?.password_hash;
  }

  async verifyCurrentPassword(userId: string, currentPassword: string): Promise<boolean> {
    const result = await this.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
    const hash = result.rows[0]?.password_hash;
    if (!hash) return false;
    return this.verifyPassword(currentPassword, hash);
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = this.hashPassword(newPassword);
    await this.db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    try {
      const parts = storedHash.split("$");
      if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
      const iterations = Number.parseInt(parts[1], 10);
      const salt = Buffer.from(parts[2], "base64url");
      const expected = Buffer.from(parts[3], "base64url");
      const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
