import { AuthService } from "./auth.service";
import { LIMITS, RateLimitedException } from "../rate-limit/rate-limit.service";

/*
 * The brute-force limits must stop a script and never a person: they count FAILURES, they are
 * checked before the work (so a blocked address costs nothing), and a success touches no counter.
 * These drive AuthService directly with stubs so each of those can be asserted on its own.
 */

type Any = Record<string, any>;

function make(opts: { blocked?: boolean; loginOutcome?: Any; verifyOtpToken?: string | null; resetOutcome?: string | null; checkValid?: boolean; currentPasswordValid?: boolean } = {}) {
  const calls: string[] = [];
  const rateLimit = {
    assertAllowed: jest.fn(async (limit: Any) => {
      calls.push(`assert:${limit.bucket}`);
      if (opts.blocked) throw new RateLimitedException(300);
    }),
    recordFailure: jest.fn(async (limit: Any) => void calls.push(`fail:${limit.bucket}`)),
    hit: jest.fn(async (limit: Any) => void calls.push(`hit:${limit.bucket}`))
  };
  const svc = Object.create(AuthService.prototype) as Any;
  svc.rateLimit = rateLimit;
  svc.config = { sessionDays: 30, sessionCookieName: "tesbo_session" };
  svc.audit = { log: jest.fn().mockResolvedValue(undefined) };
  svc.lockout = {
    getActiveLock: jest.fn().mockResolvedValue(null),
    recordFailedAttempt: jest.fn().mockResolvedValue(null),
    clear: jest.fn().mockResolvedValue(undefined)
  };
  svc.password = {
    verifyLogin: jest.fn(async () => {
      calls.push("verifyLogin");
      return opts.loginOutcome ?? { outcome: "ok", userId: "u1" };
    }),
    assertValidPassword: jest.fn(),
    hasPassword: jest.fn().mockResolvedValue(true),
    verifyCurrentPassword: jest.fn(async () => {
      calls.push("verifyCurrentPassword");
      return opts.currentPasswordValid ?? true;
    }),
    setPassword: jest.fn().mockResolvedValue(undefined)
  };
  svc.otp = {
    createSession: jest.fn().mockResolvedValue("session-token"),
    verifyOtp: jest.fn(async () => {
      calls.push("verifyOtp");
      return opts.verifyOtpToken === undefined ? "session-token" : opts.verifyOtpToken;
    }),
    resolveSession: jest.fn().mockResolvedValue("u1"),
    requestOtp: jest.fn().mockResolvedValue(true),
    invalidateAllSessions: jest.fn().mockResolvedValue(undefined)
  };
  svc.passwordReset = {
    requestReset: jest.fn(async () => {
      calls.push("requestReset");
      return opts.resetOutcome === undefined ? "sent" : opts.resetOutcome;
    }),
    verifyResetToken: jest.fn(async () => {
      calls.push("verifyResetToken");
      return opts.checkValid ?? true;
    }),
    resetPassword: jest.fn(async () => {
      calls.push("resetPassword");
      return opts.resetOutcome === null ? null : "u1";
    })
  };
  svc.email = { sendPasswordChanged: jest.fn().mockResolvedValue(undefined) };
  svc.db = { query: jest.fn().mockResolvedValue({ rows: [{ email: "a@example.test" }] }) };
  svc.setSessionCookie = jest.fn();
  svc.clearSessionCookie = jest.fn();
  return { svc, calls, rateLimit };
}

const req = (ip = "203.0.113.9") => ({ ip, get: () => "jest", headers: {} }) as never;
const res = () => ({ cookie: jest.fn(), clearCookie: jest.fn() }) as never;

async function rejected(promise: Promise<unknown>): Promise<Any> {
  try {
    await promise;
  } catch (error) {
    return error as Any;
  }
  throw new Error("expected a rejection");
}

describe("password login", () => {
  it("a SUCCESSFUL login never records a failure, however many times it happens", async () => {
    const { svc, rateLimit } = make();
    for (let i = 0; i < 30; i++) await svc.loginWithPassword("a@example.test", "Correct9Horse", req(), res());
    expect(rateLimit.recordFailure).not.toHaveBeenCalled();
    expect(rateLimit.hit).not.toHaveBeenCalled();
  });

  it("checks the address BEFORE doing the password work, so a blocked address costs the server nothing", async () => {
    const { svc, calls } = make({ blocked: true });
    const error = await rejected(svc.loginWithPassword("a@example.test", "Correct9Horse", req(), res()));
    expect(error).toBeInstanceOf(RateLimitedException);
    expect(error.getStatus()).toBe(429);
    expect(calls).toEqual(["assert:login-fail"]);
  });

  it.each([
    ["a wrong password", { outcome: "invalid_password" }],
    ["an unknown email", { outcome: "not_found" }]
  ])("records %s against the address", async (_label, outcome) => {
    const { svc, calls } = make({ loginOutcome: outcome });
    await rejected(svc.loginWithPassword("a@example.test", "Wrong9Horse", req(), res()));
    expect(calls).toEqual(["assert:login-fail", "verifyLogin", "fail:login-fail"]);
  });

  it("does not count an attempt on an account that is already locked: that is not a new guess", async () => {
    const { svc, calls } = make({ loginOutcome: { outcome: "locked", lockedUntil: new Date(Date.now() + 60_000) } });
    const error = await rejected(svc.loginWithPassword("a@example.test", "Correct9Horse", req(), res()));
    expect(error.getStatus()).toBe(429);
    expect(calls).not.toContain("fail:login-fail");
  });

  it("counts against the caller's address, in the normalised form", async () => {
    const { svc, rateLimit } = make({ loginOutcome: { outcome: "invalid_password" } });
    await rejected(svc.loginWithPassword("a@example.test", "x", req("::ffff:198.51.100.7"), res()));
    expect(rateLimit.recordFailure).toHaveBeenCalledWith(LIMITS.loginFailuresPerIp, "198.51.100.7");
  });

  it.each([
    [123, "Correct9Horse"],
    ["a@example.test", 123456],
    [{ a: 1 }, "x"],
    [["a@example.test"], "x"],
    [null, "x"],
    ["", "x"],
    ["a@example.test", ""]
  ])("answers 400, not 500, for email %j and password %j, and never reaches the limiter or the hash", async (email, password) => {
    const { svc, calls } = make();
    const error = await rejected(svc.loginWithPassword(email as never, password as never, req(), res()));
    expect(error.getStatus()).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses an absurdly long email or password before hashing it", async () => {
    const { svc, calls } = make();
    for (const [email, password] of [["a".repeat(256) + "@example.test", "x"], ["a@example.test", "p".repeat(1025)]]) {
      const error = await rejected(svc.loginWithPassword(email, password, req(), res()));
      expect(error.getStatus()).toBe(400);
    }
    expect(calls).toEqual([]);
    await svc.loginWithPassword("a@example.test", "p".repeat(1024), req(), res());
    expect(calls).toContain("verifyLogin");
  });
});

describe("login by email code", () => {
  it("a correct code records nothing", async () => {
    const { svc, rateLimit } = make();
    for (let i = 0; i < 20; i++) await svc.verifyOtp("a@example.test", "123456", req(), res());
    expect(rateLimit.recordFailure).not.toHaveBeenCalled();
  });

  it("a wrong code is recorded against the address, and a blocked address is stopped before any code is checked", async () => {
    const wrong = make({ verifyOtpToken: null });
    await rejected(wrong.svc.verifyOtp("a@example.test", "000000", req(), res()));
    expect(wrong.calls).toEqual(["assert:otp-login-fail", "verifyOtp", "fail:otp-login-fail"]);

    const blocked = make({ blocked: true });
    await rejected(blocked.svc.verifyOtp("a@example.test", "123456", req(), res()));
    expect(blocked.calls).toEqual(["assert:otp-login-fail"]);
  });
});

describe("requesting a login code", () => {
  it("counts the request (a code email has no failure to wait for) and stops once over the cap", async () => {
    const { svc, calls } = make();
    await svc.requestOtp("a@example.test", req());
    expect(calls).toContain("hit:otp-request");
    const blocked = make({ blocked: false });
    blocked.rateLimit.hit.mockRejectedValueOnce(new RateLimitedException(60));
    const error = await rejected(blocked.svc.requestOtp("a@example.test", req()));
    expect(error.getStatus()).toBe(429);
    expect(blocked.svc.otp.requestOtp).not.toHaveBeenCalled();
  });
});

describe("forgot password", () => {
  it("keys the tight per-email cap by email AND address, so a stranger cannot use up the owner's allowance", async () => {
    const { svc, rateLimit } = make();
    await svc.forgotPassword("Owner@Example.test", req("198.51.100.7"));
    expect(rateLimit.hit).toHaveBeenCalledWith(LIMITS.forgotPerEmailPerIp, "owner@example.test|198.51.100.7");
    expect(rateLimit.hit).toHaveBeenCalledWith(LIMITS.forgotPerEmail, "owner@example.test");
  });

  it("records an unknown address against the asking address, and a known one against nobody", async () => {
    const unknown = make({ resetOutcome: "not_found" });
    await rejected(unknown.svc.forgotPassword("nobody@example.test", req()));
    expect(unknown.calls).toContain("fail:forgot-unknown");

    const known = make();
    await known.svc.forgotPassword("owner@example.test", req());
    expect(known.calls).not.toContain("fail:forgot-unknown");
  });

  it("stops an address that has been testing unknown emails before it sends anything", async () => {
    const { svc, calls } = make({ blocked: true });
    await rejected(svc.forgotPassword("owner@example.test", req()));
    expect(calls).toEqual(["assert:forgot-unknown"]);
  });

  it.each([123, { a: 1 }, null, undefined, "", "   "])("answers 400 for %j", async (email) => {
    const error = await rejected(make().svc.forgotPassword(email as never, req()));
    expect(error.getStatus()).toBe(400);
  });

  it("refuses an absurdly long email", async () => {
    const error = await rejected(make().svc.forgotPassword("a".repeat(256) + "@example.test", req()));
    expect(error.getStatus()).toBe(400);
  });
});

describe("reset links", () => {
  it("a valid link costs nothing; an invalid one is recorded", async () => {
    const good = make({ checkValid: true });
    expect(await good.svc.checkResetToken("tok", req())).toEqual({ valid: true });
    expect(good.rateLimit.recordFailure).not.toHaveBeenCalled();

    const bad = make({ checkValid: false });
    expect(await bad.svc.checkResetToken("guess", req())).toEqual({ valid: false });
    expect(bad.rateLimit.recordFailure).toHaveBeenCalledWith(LIMITS.resetTokenFailuresPerIp, "203.0.113.9");
  });

  it("an address that has been guessing links is stopped before the lookup", async () => {
    const { svc, calls } = make({ blocked: true });
    await rejected(svc.checkResetToken("guess", req()));
    expect(calls).toEqual(["assert:reset-token-fail"]);
  });

  it("completing a reset with a bad token is recorded; with a good one it is not", async () => {
    const bad = make({ resetOutcome: null });
    const error = await rejected(bad.svc.resetPassword("guess", "Newpass9x", req()));
    expect(error.getStatus()).toBe(401);
    expect(bad.calls).toContain("fail:reset-token-fail");

    const good = make();
    await good.svc.resetPassword("tok", "Newpass9x", req());
    expect(good.calls).not.toContain("fail:reset-token-fail");
  });

  it.each([123, { a: 1 }, null, undefined, ""])("answers 400 for a token of %j", async (token) => {
    const error = await rejected(make().svc.resetPassword(token as never, "Newpass9x", req()));
    expect(error.getStatus()).toBe(400);
  });
});

describe("changing the password while signed in", () => {
  it("a correct current password records nothing", async () => {
    const { svc, rateLimit } = make({ currentPasswordValid: true });
    await svc.changePassword("u1", "Current9Pass", "Newpass9x", req(), res());
    expect(rateLimit.recordFailure).not.toHaveBeenCalled();
  });

  it("a wrong one is recorded against the USER, not the address (a stolen session guessing the password)", async () => {
    const { svc, rateLimit } = make({ currentPasswordValid: false });
    const error = await rejected(svc.changePassword("u1", "Wrong9Pass", "Newpass9x", req(), res()));
    expect(error.getStatus()).toBe(401);
    expect(rateLimit.recordFailure).toHaveBeenCalledWith(LIMITS.changePasswordFailuresPerUser, "u1");
  });

  it("stops the guessing before any hash is computed once the user is over the cap", async () => {
    const { svc, calls } = make({ blocked: true });
    await rejected(svc.changePassword("u1", "Wrong9Pass", "Newpass9x", req(), res()));
    expect(calls).toEqual(["assert:change-password-fail"]);
  });

  it.each([123, { a: 1 }, ["x"], ""])("answers 400 for a current password of %j", async (current) => {
    const error = await rejected(make().svc.changePassword("u1", current as never, "Newpass9x", req(), res()));
    expect(error.getStatus()).toBe(400);
  });
});
