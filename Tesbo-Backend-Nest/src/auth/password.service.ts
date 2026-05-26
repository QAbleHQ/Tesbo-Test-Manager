import { Injectable } from "@nestjs/common";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class PasswordService {
  private readonly iterations = 210000;
  private readonly keyLengthBytes = 32;

  constructor(private readonly db: DatabaseService) {}

  async verifyLogin(rawEmail: string, password: string): Promise<string | null> {
    if (!rawEmail?.trim() || !password?.trim()) return null;
    const email = rawEmail.trim().toLowerCase();
    const result = await this.db.query<{ id: string; password_hash: string | null }>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email]
    );
    const row = result.rows[0];
    if (!row?.password_hash) return null;
    return this.verifyPassword(password, row.password_hash) ? row.id : null;
  }

  hashPassword(password: string): string {
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, this.iterations, this.keyLengthBytes, "sha256");
    return `pbkdf2_sha256$${this.iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
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
