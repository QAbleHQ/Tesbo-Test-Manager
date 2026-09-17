import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { env } from "../utils/env";
import { clearOtpIpRateLimit, disposableEmail, seedOtpCode } from "../utils/otp";
import { hashPasswordForSeed } from "../utils/password";
import { dbControlAvailable, exec, execAllowingAuditImmutability, literal, scalar } from "../utils/psql";

async function anonContext(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  // Playwright Test's request.newContext() otherwise inherits the project's default
  // storageState (our logged-in session) — clear it explicitly to get a truly anonymous context.
  return playwright.request.newContext({
    baseURL: env.apiBaseUrl,
    storageState: { cookies: [], origins: [] },
  });
}

test.describe("auth", () => {
  test("an authenticated session can fetch the current user", { tag: '@tesbo.testId("TES-TC-24")' }, async ({ request }) => {
    const res = await request.get("/api/auth/me");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.email).toBe(env.testEmail);
  });

  test("GET /me splits the stored name into firstName/lastName for the Account screen", { tag: '@tesbo.testId("TES-TC-1311")' }, async ({ request }) => {
    // Basecamp 10212498688 — auth.service.ts me() now derives firstName/lastName from the single
    // `name` column signup writes, so the Account page can show them as separate fields. Asserted
    // against the value the API itself reports for `name`, not a hard-coded fixture string, so this
    // stays true regardless of what the smoke tenant happens to be named.
    const res = await request.get("/api/auth/me");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    const storedName = (body.name ?? "").trim();
    expect(storedName, "this tenant's user has no name stored, so the test proves nothing").not.toBe("");
    const spaceIndex = storedName.indexOf(" ");
    const expectedFirstName = spaceIndex === -1 ? storedName : storedName.slice(0, spaceIndex);
    const expectedLastName = spaceIndex === -1 ? null : storedName.slice(spaceIndex + 1);

    expect(body.firstName).toBe(expectedFirstName);
    expect(body.lastName).toBe(expectedLastName);
  });

  test("an unauthenticated request is rejected", { tag: '@tesbo.testId("TES-TC-25")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const res = await anon.get("/api/auth/me");
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("an incorrect password is rejected", { tag: '@tesbo.testId("TES-TC-34")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const res = await anon.post("/api/auth/password/login", {
      data: { email: env.testEmail, password: "definitely-wrong-password" },
      failOnStatusCode: false,
    });
    expect(res.ok()).toBeFalsy();
    await anon.dispose();
  });

  test("rejects a login request missing required fields", { tag: '@tesbo.testId("TES-TC-45")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const res = await anon.post("/api/auth/password/login", {
      data: { email: env.testEmail },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    await anon.dispose();
  });

  test("invalidates the session on logout", { tag: '@tesbo.testId("TES-TC-27")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    // Log in fresh here rather than reusing the shared default session — logging that
    // one out would break every other spec relying on the same storageState.
    const loginRes = await anon.post("/api/auth/password/login", {
      data: { email: env.testEmail, password: env.testPassword },
    });
    expect(loginRes.ok()).toBeTruthy();

    await anon.post("/api/auth/logout");
    const meRes = await anon.get("/api/auth/me", { failOnStatusCode: false });
    expect(meRes.status()).toBe(401);

    await anon.dispose();
  });
});

// PATCH /api/auth/me — always run against a disposable OTP-created account, never the shared
// smoke session: other specs read env.testEmail's own name (e.g. navigation.spec.ts's avatar-colour
// invariants use the same identity), and mutating it here would make those flaky depending on run order.
test.describe("profile", () => {
  test("PATCH /api/auth/me updates the first/last name and mobile number, and it persists", { tag: '@tesbo.testId("TES-TC-1402")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-profile-update");
    seedOtpCode(email, "135790");
    const verifyRes = await anon.post("/api/auth/otp/verify", { data: { email, code: "135790" } });
    expect(verifyRes.ok()).toBeTruthy();

    const newFirstName = `E2EFirst${Date.now()}`;
    const newLastName = `E2ELast${Date.now()}`;
    // Already normalized: the API validates against the same strict "+<country code><digits>"
    // pattern as the users.mobile_number CHECK constraint and does not itself strip formatting —
    // that's the frontend's job (see ui/account.spec.ts for the spaced-input round trip).
    const newMobileNumber = "+14155550132";
    const patchRes = await anon.patch("/api/auth/me", {
      data: { firstName: newFirstName, lastName: newLastName, mobileNumber: newMobileNumber },
    });
    expect(patchRes.ok()).toBeTruthy();
    const patched = await patchRes.json();
    expect(patched.firstName).toBe(newFirstName);
    expect(patched.lastName).toBe(newLastName);
    expect(patched.mobileNumber).toBe(newMobileNumber);
    // `name` is kept in sync alongside first/last, since member lists, bug reporter/assignee, and
    // the activity feed still read it.
    expect(patched.name).toBe(`${newFirstName} ${newLastName}`);

    // Persisted server-side, not just echoed back in the PATCH response.
    const meRes = await anon.get("/api/auth/me");
    const me = await meRes.json();
    expect(me.firstName).toBe(newFirstName);
    expect(me.lastName).toBe(newLastName);
    expect(me.mobileNumber).toBe(newMobileNumber);

    await anon.dispose();
  });

  test("PATCH /api/auth/me accepts normalized international mobile numbers without assuming a fixed length", { tag: '@tesbo.testId("TES-TC-1405")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-profile-intl");
    seedOtpCode(email, "864209");
    await anon.post("/api/auth/otp/verify", { data: { email, code: "864209" } });

    // A UK-shaped number and a longer Indian one, neither of which fits a US-only assumption —
    // already normalized, since the API itself doesn't strip formatting (see the spaced/no-plus
    // rejections below).
    for (const candidate of ["+442079460958", "+919812345678"]) {
      const res = await anon.patch("/api/auth/me", { data: { mobileNumber: candidate } });
      expect(res.ok(), `${candidate} should be accepted`).toBeTruthy();
      const body = await res.json();
      expect(body.mobileNumber).toBe(candidate);
    }

    await anon.dispose();
  });

  test("PATCH /api/auth/me rejects a mobile number missing its leading '+' or still carrying formatting", { tag: '@tesbo.testId("TES-TC-1413")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-profile-unnormalized");
    seedOtpCode(email, "864210");
    await anon.post("/api/auth/otp/verify", { data: { email, code: "864210" } });

    // Bare digits with no country-code sign — the API requires an explicit '+', it does not infer one.
    const noPlusRes = await anon.patch("/api/auth/me", { data: { mobileNumber: "919812345678" }, failOnStatusCode: false });
    expect(noPlusRes.status()).toBe(400);

    // Spaces are a frontend convenience, stripped before the request is sent — the API itself
    // rejects them rather than silently normalizing on the server.
    const spacedRes = await anon.patch("/api/auth/me", { data: { mobileNumber: "+1 415 555 0132" }, failOnStatusCode: false });
    expect(spacedRes.status()).toBe(400);

    await anon.dispose();
  });

  test("PATCH /api/auth/me rejects an empty first/last name and an out-of-range mobile number", { tag: '@tesbo.testId("TES-TC-1403")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-profile-validation");
    seedOtpCode(email, "246801");
    await anon.post("/api/auth/otp/verify", { data: { email, code: "246801" } });

    const emptyFirstNameRes = await anon.patch("/api/auth/me", { data: { firstName: "   " }, failOnStatusCode: false });
    expect(emptyFirstNameRes.status()).toBe(400);

    const emptyLastNameRes = await anon.patch("/api/auth/me", { data: { lastName: "   " }, failOnStatusCode: false });
    expect(emptyLastNameRes.status()).toBe(400);

    // Too few significant digits to be a real number.
    const tooShortRes = await anon.patch("/api/auth/me", { data: { mobileNumber: "12345" }, failOnStatusCode: false });
    expect(tooShortRes.status()).toBe(400);

    // Contains characters that aren't digits or ordinary phone-number punctuation.
    const invalidCharsRes = await anon.patch("/api/auth/me", { data: { mobileNumber: "call-me-maybe" }, failOnStatusCode: false });
    expect(invalidCharsRes.status()).toBe(400);

    // An empty string is the deliberate way to clear the number back to unset, and must not be
    // rejected by the same checks that block a malformed one.
    const clearRes = await anon.patch("/api/auth/me", { data: { mobileNumber: "" } });
    expect(clearRes.ok()).toBeTruthy();
    const cleared = await clearRes.json();
    expect(cleared.mobileNumber).toBeNull();

    await anon.dispose();
  });

  test("an existing user with no mobile number on file continues to authenticate and read /me normally", { tag: '@tesbo.testId("TES-TC-1406")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-profile-no-mobile");
    seedOtpCode(email, "753159");
    const verifyRes = await anon.post("/api/auth/otp/verify", { data: { email, code: "753159" } });
    expect(verifyRes.ok()).toBeTruthy();

    // A freshly created account has never had PATCH /me called — mobileNumber must read as null,
    // not error or be missing from the payload, and the session must otherwise work as normal.
    const meRes = await anon.get("/api/auth/me");
    expect(meRes.ok()).toBeTruthy();
    const me = await meRes.json();
    expect(me.mobileNumber).toBeNull();
    expect(me.email).toBe(email);

    await anon.dispose();
  });

  test("an unauthenticated PATCH /api/auth/me is rejected", { tag: '@tesbo.testId("TES-TC-1404")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const res = await anon.patch("/api/auth/me", { data: { firstName: "Nope" }, failOnStatusCode: false });
    expect(res.status()).toBe(401);
    await anon.dispose();
  });
});

test.describe("otp", () => {
  // Every test here touches /api/auth/otp/*, which rate-limits by email AND by the
  // caller's IP — reset the IP side before each so an earlier test's attempts never carry
  // over. (IP-scoped only — a blanket clear would race with a concurrently-running UI spec's
  // own per-email counter, e.g. the rate-limit test below mid-loop.)
  test.beforeEach(() => clearOtpIpRateLimit());

  test("rejects OTP verification with an incorrect code", { tag: '@tesbo.testId("TES-TC-28")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-otp-wrong");
    const res = await anon.post("/api/auth/otp/verify", {
      data: { email, code: "000000" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("completes a full OTP sign-in for a disposable account", { tag: '@tesbo.testId("TES-TC-29")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-otp-roundtrip");
    seedOtpCode(email, "246810");

    const verifyRes = await anon.post("/api/auth/otp/verify", { data: { email, code: "246810" } });
    expect(verifyRes.ok()).toBeTruthy();

    const meRes = await anon.get("/api/auth/me");
    expect(meRes.ok()).toBeTruthy();
    const me = await meRes.json();
    expect(me.email).toBe(email);

    await anon.dispose();
  });

  test("rate-limits repeated OTP requests", { tag: '@tesbo.testId("TES-TC-30")' }, async ({ playwright }) => {
    const anon = await anonContext(playwright);
    const email = disposableEmail("api-otp-rate-limit");

    try {
      // The email key here is unique to this test, so it alone guarantees a lock within
      // 5 of this test's own calls — independent of whatever the shared IP key is doing
      // if other specs happen to run concurrently. Loop with headroom rather than
      // asserting an exact success count, so IP-side contention can't make this flaky.
      let successCount = 0;
      let blockedStatus: number | null = null;
      for (let i = 0; i < 8 && blockedStatus === null; i++) {
        const res = await anon.post("/api/auth/otp/request", {
          data: { email },
          failOnStatusCode: false,
        });
        if (res.status() === 204) successCount++;
        else blockedStatus = res.status();
      }

      expect(successCount).toBeGreaterThan(0);
      expect(blockedStatus).toBe(429);
    } finally {
      clearOtpIpRateLimit();
      await anon.dispose();
    }
  });
});

test.describe("password login lockout", () => {
  /*
   * Per-email failed-password lockout (Tesbo-Backend-Nest/src/auth/login-lockout.service.ts): 5
   * consecutive wrong passwords for one email block that email — and only that email — from
   * password login for 24 hours, even with the correct password. Backed by otp_rate_limit
   * (V1_init_schema.sql), keyed `login:<email>` so it can never collide with that table's
   * documented (currently unused) `send:`/`verify:` OTP buckets.
   *
   * Every account here is seeded directly into Postgres with a real password hash
   * (utils/password.ts's hashPasswordForSeed — the same technique global-setup.ts uses for the
   * smoke tenant) rather than going through OTP or self-serve signup: cheaper, and it keeps this
   * file's several-failed-attempts-per-test from ever touching the shared smoke tenant
   * (env.testEmail) or another spec's counters. NEVER run failed attempts against env.testEmail —
   * locking it for 24 hours would fail every other spec in the suite that logs in as that account.
   */
  const skipReason = dbControlAvailable()
    ? null
    : "needs `docker compose exec postgres psql` to seed a password user and inspect/adjust the lockout row";

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  const created: string[] = [];

  test.afterAll(() => {
    if (skipReason) return;
    for (const email of created) purgeLockoutAccount(email);
  });

  function lockoutEmail(label: string): string {
    const email = disposableEmail(`lockout-${label}`);
    created.push(email);
    return email;
  }

  /** A real, password-login-capable user, seeded straight into Postgres — no OTP, no email. */
  function seedPasswordUser(email: string, password: string): void {
    const hash = hashPasswordForSeed(password);
    exec(
      `INSERT INTO users (email, name, password_hash, profile_completed_at) ` +
        `VALUES (${literal(email.toLowerCase())}, 'E2E Lockout User', ${literal(hash)}, now());`,
    );
  }

  function purgeLockoutAccount(email: string): void {
    const normalized = email.toLowerCase();
    exec(`DELETE FROM otp_rate_limit WHERE email = ${literal(`login:${normalized}`)};`);
    exec(
      `DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ${literal(normalized)});`,
    );
    execAllowingAuditImmutability(`DELETE FROM users WHERE email = ${literal(normalized)};`);
  }

  function attemptCount(email: string): number {
    const raw = scalar(
      `SELECT attempt_count FROM otp_rate_limit WHERE email = ${literal(`login:${email.toLowerCase()}`)};`,
    );
    return raw ? Number(raw) : 0;
  }

  function isLocked(email: string): boolean {
    return (
      scalar(
        `SELECT (locked_until > now()) FROM otp_rate_limit WHERE email = ${literal(`login:${email.toLowerCase()}`)};`,
      ) === "t"
    );
  }

  /** Simulates the 24 hours having already passed, instead of waiting for it. */
  function expireLockNow(email: string): void {
    exec(
      `UPDATE otp_rate_limit SET locked_until = now() - interval '1 minute' WHERE email = ${literal(`login:${email.toLowerCase()}`)};`,
    );
  }

  /**
   * A random, never-delivered reset token seeded straight into password_reset_tokens — the same
   * shape PasswordResetService.resetPassword expects, without needing to read a real email.
   */
  function seedResetToken(email: string): string {
    const userId = scalar(`SELECT id FROM users WHERE email = ${literal(email.toLowerCase())};`);
    const rawToken = `e2e-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("base64url");
    exec(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) ` +
        `VALUES (${literal(userId)}, ${literal(tokenHash)}, now() + interval '1 hour');`,
    );
    return rawToken;
  }

  async function login(anon: import("@playwright/test").APIRequestContext, email: string, password: string) {
    return anon.post("/api/auth/password/login", { data: { email, password }, failOnStatusCode: false });
  }

  test("LOGIN-LOCK-01 five wrong passwords each read as a normal failure, and the 6th is blocked even with the right password", async ({
    playwright,
  }) => {
    const email = lockoutEmail("five-then-six");
    const password = "CorrectHorse9!";
    seedPasswordUser(email, password);
    const anon = await anonContext(playwright);
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await login(anon, email, "wrong-password");
        expect(res.status(), `attempt ${attempt} of 5 — ${await res.text()}`).toBe(401);
      }
      expect(attemptCount(email)).toBe(5);
      expect(isLocked(email), "the 5th failure should have locked the email").toBeTruthy();

      // The 6th attempt is blocked outright — even with the CORRECT password, it never gets far
      // enough to check it.
      const sixth = await login(anon, email, password);
      expect(sixth.status(), await sixth.text()).toBe(429);
      const body = await sixth.json();
      expect(body.error).toContain("Too many failed login attempts");
    } finally {
      await anon.dispose();
    }
  });

  test("LOGIN-LOCK-02 locking one email does not affect a different email's ability to log in", async ({ playwright }) => {
    const lockedEmail = lockoutEmail("isolation-locked");
    const otherEmail = lockoutEmail("isolation-other");
    const password = "CorrectHorse9!";
    seedPasswordUser(lockedEmail, password);
    seedPasswordUser(otherEmail, password);
    const anon = await anonContext(playwright);
    try {
      for (let i = 0; i < 5; i++) {
        await login(anon, lockedEmail, "wrong-password");
      }
      expect(isLocked(lockedEmail)).toBeTruthy();

      const blocked = await login(anon, lockedEmail, password);
      expect(blocked.status()).toBe(429);

      // A completely unrelated email must log in normally, unaffected by the other account's lock.
      const otherLogin = await login(anon, otherEmail, password);
      expect(otherLogin.ok(), await otherLogin.text()).toBeTruthy();
      expect(isLocked(otherEmail)).toBeFalsy();
    } finally {
      await anon.dispose();
    }
  });

  test("LOGIN-LOCK-03 a successful login resets the failed-attempt counter", async ({ playwright }) => {
    const email = lockoutEmail("reset-on-success");
    const password = "CorrectHorse9!";
    seedPasswordUser(email, password);
    const anon = await anonContext(playwright);
    try {
      // Three failures — short of the 5 that would lock the account.
      for (let i = 0; i < 3; i++) {
        await login(anon, email, "wrong-password");
      }
      expect(attemptCount(email)).toBe(3);

      const success = await login(anon, email, password);
      expect(success.ok(), await success.text()).toBeTruthy();

      // The counter row is cleared outright, not merely decremented — so a fresh run of failures
      // starts the 5-attempt count from zero, not from 3.
      expect(attemptCount(email)).toBe(0);
      for (let i = 0; i < 4; i++) {
        const res = await login(anon, email, "wrong-password");
        expect(res.status()).toBe(401);
      }
      expect(isLocked(email), "4 fresh failures after a reset must not lock the account").toBeFalsy();
    } finally {
      await anon.dispose();
    }
  });

  test("LOGIN-LOCK-04 completing a password reset clears the lock, even mid-block", async ({ playwright }) => {
    const email = lockoutEmail("reset-unlocks");
    const oldPassword = "CorrectHorse9!";
    const newPassword = "NewHorse9!";
    seedPasswordUser(email, oldPassword);
    const anon = await anonContext(playwright);
    try {
      for (let i = 0; i < 5; i++) {
        await login(anon, email, "wrong-password");
      }
      expect(isLocked(email)).toBeTruthy();
      const blocked = await login(anon, email, oldPassword);
      expect(blocked.status()).toBe(429);

      const token = seedResetToken(email);
      const resetRes = await anon.post("/api/auth/password/reset", {
        data: { token, password: newPassword },
        failOnStatusCode: false,
      });
      expect(resetRes.ok(), await resetRes.text()).toBeTruthy();

      // Unblocked immediately — the new password works right away, with no 24-hour wait.
      expect(isLocked(email), "the lock must be cleared by a completed reset").toBeFalsy();
      const afterReset = await login(anon, email, newPassword);
      expect(afterReset.ok(), await afterReset.text()).toBeTruthy();
    } finally {
      await anon.dispose();
    }
  });

  test("LOGIN-LOCK-05 the lock expires after 24 hours, and login works again with the correct password", async ({ playwright }) => {
    const email = lockoutEmail("expiry");
    const password = "CorrectHorse9!";
    seedPasswordUser(email, password);
    const anon = await anonContext(playwright);
    try {
      for (let i = 0; i < 5; i++) {
        await login(anon, email, "wrong-password");
      }
      expect(isLocked(email)).toBeTruthy();

      expireLockNow(email);
      expect(isLocked(email)).toBeFalsy();

      const afterExpiry = await login(anon, email, password);
      expect(afterExpiry.ok(), await afterExpiry.text()).toBeTruthy();
      // A successful login clears the row outright, same as any other successful login.
      expect(attemptCount(email)).toBe(0);
    } finally {
      await anon.dispose();
    }
  });
});
