import { createHash } from "crypto";
import { OtpRateLimitedException, OtpService } from "./otp.service";
import { EmailService } from "./email.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { SessionCacheService } from "../cache/session-cache.service";
import { WelcomeEmailService } from "../welcome-email/welcome-email.service";

/**
 * Signup and invite verification call OtpService.verifyOtpCode directly and have no limiter of their
 * own, so a 6-digit code was guessable by brute force. These pin the per-code attempt budget, the
 * single-use guarantee, the one-live-code rule and the hourly request cap at the service boundary.
 */
const hash = (code: string) => createHash("sha256").update(code, "utf8").digest("base64url");

type Row = { id: string; code_hash: string; attempts: number; used: boolean };

/** An in-memory otp_codes table that honours the exact predicates the service's SQL relies on. */
function makeService(rows: Row[], recentCount = 0) {
  const sent: string[] = [];
  const clientQuery = jest.fn((sql: string, _values?: unknown[]) => {
    if (sql.includes("count(*)")) return Promise.resolve({ rows: [{ n: String(recentCount) }] });
    if (sql.includes("SET used_at = now() WHERE email")) {
      for (const row of rows) row.used = true;
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("INSERT INTO otp_codes")) {
      rows.push({ id: `otp-${rows.length + 1}`, code_hash: String(_values?.[1]), attempts: 0, used: false });
    }
    return Promise.resolve({ rows: [] });
  });
  const query = jest.fn((sql: string, values: unknown[] = []) => {
    if (sql.includes("SET attempts")) {
      const max = Number(values[1]);
      const live = rows.filter((row) => !row.used && row.attempts < max);
      for (const row of live) row.attempts += 1;
      return Promise.resolve({ rows: live.map((row) => ({ id: row.id, code_hash: row.code_hash })) });
    }
    if (sql.includes("SET used_at = now() WHERE id")) {
      const row = rows.find((r) => r.id === values[0]);
      if (!row || row.used) return Promise.resolve({ rows: [], rowCount: 0 });
      row.used = true;
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
  const db = {
    query,
    transaction: async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery })
  };
  const email = { sendOtp: jest.fn(async (_to: string, code: string) => void sent.push(code)) };
  const svc = new OtpService(
    db as unknown as DatabaseService,
    { otpExpiryMinutes: 10, sessionDays: 30 } as AppConfigService,
    email as unknown as EmailService,
    {} as SessionCacheService,
    {} as WelcomeEmailService
  );
  return { svc, sent, query, clientQuery };
}

describe("OtpService.verifyOtpCode: brute-force budget", () => {
  const liveRow = (code = "123456"): Row => ({ id: "otp-1", code_hash: hash(code), attempts: 0, used: false });

  it("accepts the right code and refuses to accept it a second time", async () => {
    const { svc } = makeService([liveRow()]);
    await expect(svc.verifyOtpCode("a@example.test", "123456")).resolves.toBe(true);
    await expect(svc.verifyOtpCode("a@example.test", "123456")).resolves.toBe(false);
  });

  it("kills the code after 5 wrong guesses, so even the correct code is refused afterwards", async () => {
    const { svc } = makeService([liveRow()]);
    for (let i = 0; i < 5; i++) await expect(svc.verifyOtpCode("a@example.test", `00000${i}`)).resolves.toBe(false);
    await expect(svc.verifyOtpCode("a@example.test", "123456")).resolves.toBe(false);
  });

  it("still accepts the right code on the 5th guess (the budget is 5, not 4)", async () => {
    const { svc } = makeService([liveRow()]);
    for (let i = 0; i < 4; i++) await svc.verifyOtpCode("a@example.test", `00000${i}`);
    await expect(svc.verifyOtpCode("a@example.test", "123456")).resolves.toBe(true);
  });

  it("lets only one of two simultaneous correct submissions through", async () => {
    const { svc } = makeService([liveRow()]);
    const results = await Promise.all([svc.verifyOtpCode("a@example.test", "123456"), svc.verifyOtpCode("a@example.test", "123456")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ["a number", 123456],
    ["an object", { $ne: "" }],
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["an oversized string", "9".repeat(10_000)]
  ])("refuses %s without throwing and without spending an attempt", async (_label, bad) => {
    const row = liveRow();
    const { svc, query } = makeService([row]);
    await expect(svc.verifyOtpCode("a@example.test", bad as unknown as string)).resolves.toBe(false);
    expect(row.attempts).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("trims whitespace around a correct code", async () => {
    const { svc } = makeService([liveRow()]);
    await expect(svc.verifyOtpCode("A@Example.test", "  123456 ")).resolves.toBe(true);
  });
});

describe("OtpService.requestOtp: one live code, capped per hour", () => {
  it("retires every earlier live code, so only the newest can be guessed", async () => {
    const old: Row = { id: "otp-old", code_hash: hash("111111"), attempts: 0, used: false };
    const { svc, sent } = makeService([old]);
    await svc.requestOtp("a@example.test");
    expect(old.used).toBe(true);
    await expect(svc.verifyOtpCode("a@example.test", "111111")).resolves.toBe(false);
    await expect(svc.verifyOtpCode("a@example.test", sent[0])).resolves.toBe(true);
  });

  it("refuses the 21st code within the hour with a 429 and sends no email", async () => {
    const { svc, sent } = makeService([], 20);
    await expect(svc.requestOtp("a@example.test")).rejects.toBeInstanceOf(OtpRateLimitedException);
    expect(sent).toHaveLength(0);
  });

  it("still allows the 20th", async () => {
    const { svc, sent } = makeService([], 19);
    await expect(svc.requestOtp("a@example.test")).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("serialises requests for one email behind an advisory lock", async () => {
    const { svc, clientQuery } = makeService([]);
    await svc.requestOtp("A@Example.test");
    const first = clientQuery.mock.calls[0];
    expect(first[0]).toContain("pg_advisory_xact_lock");
    expect(first[1]).toEqual(["otp:a@example.test"]);
  });
});
