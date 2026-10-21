import { pbkdf2Sync, randomBytes } from "crypto";
import { PasswordService } from "./password.service";
import type { DatabaseService } from "../database/database.service";
import type { LoginLockoutService } from "./login-lockout.service";

function make(row: { id: string; password_hash: string | null } | null = null) {
  const db = { query: jest.fn(async () => ({ rows: row ? [row] : [] })) };
  const lockout = {
    getActiveLock: jest.fn().mockResolvedValue(null),
    recordFailedAttempt: jest.fn().mockResolvedValue(null),
    clear: jest.fn().mockResolvedValue(undefined)
  };
  const svc = new PasswordService(db as unknown as DatabaseService, lockout as unknown as LoginLockoutService);
  return { svc, db, lockout };
}

describe("PasswordService hashing runs off the event loop", () => {
  it("round-trips: what hashPassword writes, verifyCurrentPassword accepts, and a wrong password is refused", async () => {
    const { svc } = make();
    const hash = await svc.hashPassword("Correct9Horse");
    expect(hash).toMatch(/^pbkdf2_sha256\$210000\$[\w-]+\$[\w-]+$/);
    const { svc: reader } = make({ id: "u1", password_hash: hash });
    expect(await reader.verifyCurrentPassword("u1", "Correct9Horse")).toBe(true);
    expect(await reader.verifyCurrentPassword("u1", "Wrong9Horse")).toBe(false);
  });

  it("still reads hashes written by the previous synchronous implementation (same format and algorithm)", async () => {
    const salt = randomBytes(16);
    const digest = pbkdf2Sync("Legacy9Password", salt, 210000, 32, "sha256");
    const stored = `pbkdf2_sha256$210000$${salt.toString("base64url")}$${digest.toString("base64url")}`;
    const { svc } = make({ id: "u1", password_hash: stored });
    expect(await svc.verifyCurrentPassword("u1", "Legacy9Password")).toBe(true);
    expect(await svc.verifyCurrentPassword("u1", "legacy9password")).toBe(false);
  });

  it("salts every hash differently", async () => {
    const { svc } = make();
    expect(await svc.hashPassword("Same9Password")).not.toBe(await svc.hashPassword("Same9Password"));
  });

  it("leaves the event loop free while it works: timers keep firing during a burst of wrong-password checks", async () => {
    const hash = await make().svc.hashPassword("Correct9Horse");
    const { svc } = make({ id: "u1", password_hash: hash });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    // Eight concurrent attempts, which took the process over with pbkdf2Sync.
    await Promise.all(Array.from({ length: 8 }, () => svc.verifyCurrentPassword("u1", "Wrong9Horse")));
    clearInterval(timer);
    // If the loop were blocked, the 5 ms timer could not have fired more than a couple of times.
    expect(ticks).toBeGreaterThan(5);
  }, 30_000);

  it.each([[""], ["pbkdf2_sha256$x"], ["pbkdf2_sha256$1$2"], ["bcrypt$1$2$3"], ["pbkdf2_sha256$abc$AAAA$AAAA"], [null]])(
    "treats a malformed stored hash %j as a failed check, never an exception",
    async (stored) => {
      const { svc } = make({ id: "u1", password_hash: stored });
      await expect(svc.verifyCurrentPassword("u1", "Whatever9x")).resolves.toBe(false);
    }
  );

  it("verifyLogin: unknown email, no password set, wrong password and a locked account are each reported as such", async () => {
    expect((await make(null).svc.verifyLogin("nobody@example.test", "Whatever9x")).outcome).toBe("not_found");
    expect((await make({ id: "u1", password_hash: null }).svc.verifyLogin("a@example.test", "Whatever9x")).outcome).toBe("invalid_password");

    const hash = await make().svc.hashPassword("Correct9Horse");
    const wrong = make({ id: "u1", password_hash: hash });
    expect((await wrong.svc.verifyLogin("a@example.test", "Wrong9Horse")).outcome).toBe("invalid_password");
    expect(wrong.lockout.recordFailedAttempt).toHaveBeenCalledTimes(1);

    const right = make({ id: "u1", password_hash: hash });
    expect(await right.svc.verifyLogin("a@example.test", "Correct9Horse")).toEqual({ outcome: "ok", userId: "u1" });
    expect(right.lockout.clear).toHaveBeenCalledTimes(1);

    const locked = make({ id: "u1", password_hash: hash });
    locked.lockout.getActiveLock.mockResolvedValue(new Date(Date.now() + 60_000));
    expect((await locked.svc.verifyLogin("a@example.test", "Correct9Horse")).outcome).toBe("locked");
  });

  it("refuses to hash a password that breaks the policy, before doing any work", async () => {
    const { svc } = make();
    for (const bad of ["short1A", "alllowercase9", "ALLUPPERCASE9", "NoDigitsHere", "x".repeat(17) + "A1a"]) {
      await expect(svc.hashPassword(bad)).rejects.toBeTruthy();
    }
  });
});
