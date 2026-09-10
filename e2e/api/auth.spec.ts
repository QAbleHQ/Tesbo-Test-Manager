import { expect, test } from "@playwright/test";
import { env } from "../utils/env";
import { clearOtpIpRateLimit, disposableEmail, seedOtpCode } from "../utils/otp";

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
