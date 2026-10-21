import { createHash } from "crypto";
import { PasswordResetService } from "./password-reset.service";
import type { AppConfigService } from "../config/app-config.service";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "./email.service";
import type { PasswordService } from "./password.service";
import type { SessionCacheService } from "../cache/session-cache.service";

const hash = (v: string) => createHash("sha256").update(v, "utf8").digest("base64url");

/** A reset token row that is valid for "raw-token" and belongs to user-1, or nothing when `valid` is false. */
function makeService(valid = true) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = jest.fn((sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("FROM password_reset_tokens")) {
      return Promise.resolve({ rows: valid && values[0] === hash("raw-token") ? [{ id: "reset-1", user_id: "user-1" }] : [] });
    }
    if (sql.includes("SELECT email FROM users")) return Promise.resolve({ rows: [{ email: "a@example.test" }] });
    return Promise.resolve({ rows: [] });
  });
  const password = { setPassword: jest.fn().mockResolvedValue(undefined), clearLoginLockout: jest.fn().mockResolvedValue(undefined) };
  const sessionCache = { invalidateAllForUser: jest.fn().mockResolvedValue(undefined) };
  const svc = new PasswordResetService(
    { query } as unknown as DatabaseService,
    {} as AppConfigService,
    {} as EmailService,
    password as unknown as PasswordService,
    sessionCache as unknown as SessionCacheService
  );
  return { svc, calls, password, sessionCache };
}

describe("PasswordResetService.resetPassword: what a completed reset revokes", () => {
  it("deletes the user's sessions AND api tokens", async () => {
    const { svc, calls } = makeService();
    await expect(svc.resetPassword("raw-token", "NewPass9x")).resolves.toBe("user-1");
    const sessions = calls.find((c) => c.sql.includes("DELETE FROM sessions"));
    const tokens = calls.find((c) => c.sql.includes("DELETE FROM api_tokens"));
    expect(sessions?.values).toEqual(["user-1"]);
    expect(tokens).toBeDefined(); // a reset must not leave the user's API tokens alive
    expect(tokens?.values).toEqual(["user-1"]);
  });

  it("scopes the delete to the one user, never a project or the whole table", async () => {
    const { svc, calls } = makeService();
    await svc.resetPassword("raw-token", "NewPass9x");
    const tokens = calls.find((c) => c.sql.includes("DELETE FROM api_tokens"))!;
    expect(tokens.sql).toMatch(/WHERE user_id = \$1/);
    expect(tokens.sql).not.toMatch(/project_id/);
  });

  it("revokes after the reset token is consumed and the sessions are cleared", async () => {
    const { svc, calls } = makeService();
    await svc.resetPassword("raw-token", "NewPass9x");
    const sqlOrder = calls.map((c) => c.sql);
    const usedAt = sqlOrder.findIndex((s) => s.includes("SET used_at"));
    const sessions = sqlOrder.findIndex((s) => s.includes("DELETE FROM sessions"));
    const tokens = sqlOrder.findIndex((s) => s.includes("DELETE FROM api_tokens"));
    expect(usedAt).toBeGreaterThanOrEqual(0);
    expect(sessions).toBeGreaterThan(usedAt);
    expect(tokens).toBeGreaterThan(sessions);
  });

  it.each([["an unknown token", "nope"], ["an empty token", ""], ["whitespace", "   "], ["undefined", undefined as unknown as string]])(
    "revokes nothing for %s",
    async (_label, raw) => {
      const { svc, calls, password } = makeService();
      await expect(svc.resetPassword(raw, "NewPass9x")).resolves.toBeNull();
      expect(calls.some((c) => c.sql.includes("DELETE FROM api_tokens"))).toBe(false);
      expect(calls.some((c) => c.sql.includes("DELETE FROM sessions"))).toBe(false);
      expect(password.setPassword).not.toHaveBeenCalled();
    }
  );

  it("revokes nothing for an expired or already-used reset token (the lookup returns no row)", async () => {
    const { svc, calls } = makeService(false);
    await expect(svc.resetPassword("raw-token", "NewPass9x")).resolves.toBeNull();
    expect(calls.some((c) => c.sql.includes("DELETE FROM api_tokens"))).toBe(false);
  });
});
