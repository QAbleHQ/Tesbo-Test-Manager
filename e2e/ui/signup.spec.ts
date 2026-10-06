import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { clearOtpIpRateLimit, disposableEmail, seedOtpCode } from "../utils/otp";
import { dbControlAvailable, exec, execAllowingAuditImmutability, execMany, literal, scalar } from "../utils/psql";
import { removeWelcomeJob } from "../utils/welcome-email-queue";

/*
 * Basecamp 10212498688 — "Profile page should have user name and surname and mobile number fields
 * fetched during sign up". The Account page half is pinned in ui/account.spec.ts; this file covers
 * the collection side: the new Mobile number field on /signup, and the one-time /complete-profile
 * step a passwordless OTP sign-in now detours through for a brand-new account (OtpService.
 * findOrCreateUser collects no name/mobile up front, unlike /signup and /invite/[token]/register).
 *
 * Every test here is signed out — a brand-new account is the whole point — so storageState is
 * cleared for the file rather than per test.
 *
 * Labels are prefixed "sgnui-", deliberately NOT "signup-": api/signup.spec.ts's own cleanup and
 * SGN-A-01's "nothing was queued" assertion scan `pending_signups`/`users` with `LIKE 'e2e-signup-%'`
 * (disposableEmail() renders a label straight into the address, see utils/env.ts testAddress()), so a
 * "signup-…" label here would land inside that pattern and get miscounted as SGN-A-01's own leftover
 * debris the moment the two files run in the same pass.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Every email this file creates, purged in afterEach whatever the test did. */
const createdEmails: string[] = [];

function trackedEmail(label: string): string {
  const email = disposableEmail(label);
  createdEmails.push(email);
  return email;
}

test.afterEach(() => {
  if (!dbControlAvailable() || createdEmails.length === 0) return;
  for (const email of createdEmails.splice(0)) {
    const normalized = email.toLowerCase();
    exec(`DELETE FROM pending_signups WHERE email = ${literal(normalized)};`);
    exec(`DELETE FROM otp_codes WHERE email = ${literal(normalized)};`);
    exec(`DELETE FROM otp_rate_limit WHERE email IN (${literal(`send:${normalized}`)}, ${literal(`verify:${normalized}`)}, ${literal(normalized)});`);
    // Best-effort: a brand-new account with no org/project memberships and no audit history can be
    // hard-deleted outright, unlike the audited accounts api/signup.spec.ts's purgeAccount() handles.
    exec(`DELETE FROM users WHERE email = ${literal(normalized)};`);
  }
});

async function fillOtpCode(page: Page, code: string) {
  const boxes = page.locator('input[inputmode="numeric"][maxlength="1"]');
  for (let i = 0; i < code.length; i++) {
    await boxes.nth(i).fill(code[i]);
  }
}

test.describe("signup — mobile number field", () => {
  test.beforeEach(() => clearOtpIpRateLimit());

  test("SGN-UI-01 mobile number is optional — signup succeeds without it", { tag: '@tesbo.testId("TES-TC-1314")' }, async ({ page }) => {
    const email = trackedEmail("sgnui-nomobile");
    await page.goto("/signup");
    await page.locator("#signup-first-name").fill("EndToEnd");
    await page.locator("#signup-last-name").fill("NoMobile");
    await page.locator("#signup-email").fill(email);
    await page.locator("#signup-password").fill("E2eSignPass9f3!");
    await page.getByRole("button", { name: "Create account" }).click();

    // No mobile number was entered and nothing blocked the submit — the field never turned red and
    // the flow reached the OTP step exactly as the happy path does with one filled in. Exact text,
    // not a heading role: the title renders as a plain styled <div>, not a semantic heading element.
    await expect(page.getByText("Check your email", { exact: true })).toBeVisible();
  });

  test("SGN-UI-02 a malformed mobile number is rejected inline before the form submits", { tag: '@tesbo.testId("TES-TC-1315")' }, async ({ page }) => {
    const email = trackedEmail("sgnui-badmobile");
    await page.goto("/signup");
    await page.locator("#signup-first-name").fill("EndToEnd");
    await page.locator("#signup-last-name").fill("BadMobile");
    await page.locator("#signup-mobile").fill("555-not-e164");
    await page.locator("#signup-email").fill(email);
    await page.locator("#signup-password").fill("E2eSignPass9f3!");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(/country code/i)).toBeVisible();
    // Refused client-side, so the form never left the page for the OTP step.
    await expect(page.locator("#signup-mobile")).toBeVisible();
  });
});

test.describe("passwordless sign-in — one-time profile completion", () => {
  test.beforeEach(() => clearOtpIpRateLimit());

  async function signUpPasswordlessAndVerify(page: Page, email: string, code: string) {
    await page.goto("/signup");
    await page.getByRole("button", { name: "Email code" }).click();
    await page.locator("#signup-otp-email").fill(email);
    await page.getByRole("button", { name: "Send login code" }).click();
    await page.waitForURL(/\/verify-otp/);

    seedOtpCode(email, code);
    await fillOtpCode(page, code);
    await page.getByRole("button", { name: "Verify and sign in" }).click();
  }

  test("SGN-UI-03 a brand-new passwordless account is routed through complete-profile before the app", { tag: '@tesbo.testId("TES-TC-1316")' }, async ({ page }) => {
    const email = trackedEmail("sgnui-newprofile");
    await signUpPasswordlessAndVerify(page, email, "483726");

    // OtpService.findOrCreateUser collected no name for this brand-new address, so the app detours
    // here instead of landing straight on /onboarding. Exact text, not a heading role: the title
    // renders as a plain styled <div>. A generous timeout: the page shows its own loading state while
    // it awaits GET /me before rendering the form, and this suite runs many workers against one
    // shared backend.
    await page.waitForURL(/\/complete-profile/);
    await expect(page.getByText(/couple more details/i)).toBeVisible({ timeout: 20_000 });

    await page.locator("#complete-first-name").fill("EndToEnd");
    await page.locator("#complete-last-name").fill("Passwordless");
    await page.locator("#complete-mobile").fill("+14155550199");
    await page.getByRole("button", { name: "Continue" }).click();

    // The default destination signup's own OTP mode already used (redirect=/onboarding) before the
    // detour, so completing the profile has to land there, not strand the user on the profile form.
    await page.waitForURL(/\/onboarding/);

    const me = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).json());
    expect(me.firstName).toBe("EndToEnd");
    expect(me.lastName).toBe("Passwordless");
    expect(me.mobileNumber).toBe("+14155550199");
    expect(me.profileComplete).toBe(true);

    // Once complete, a direct revisit must not ask again — it should bounce straight past the form.
    await page.goto("/complete-profile");
    await page.waitForURL((url) => !url.pathname.includes("/complete-profile"));
  });

  test("SGN-UI-04 first and last name are required to continue past complete-profile", { tag: '@tesbo.testId("TES-TC-1317")' }, async ({ page }) => {
    const email = trackedEmail("sgnui-profilereq");
    await signUpPasswordlessAndVerify(page, email, "192837");

    await page.waitForURL(/\/complete-profile/);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByText("First name is required")).toBeVisible();
    await expect(page.getByText("Last name is required")).toBeVisible();
    // Refused client-side — still on the profile step, not bounced onward with an incomplete profile.
    await expect(page).toHaveURL(/\/complete-profile/);
  });
});

/*
 * "[Sign Up] Resend Verification Code Functionality Is Not Available" — the password-mode code step
 * on /signup had no way to ask for another code, so a delayed or expired email stranded the user.
 *
 * The resend calls signup/start again rather than /otp/request: the pending_signups row expires on
 * the same timer as the code, so a fresh code alone would pass the OTP check and then fail with "No
 * pending signup found". Re-starting writes a new pending row and a new code together, which is what
 * SGN-UI-06 proves by expiring the first pair before resending.
 */
test.describe("signup — resend verification code", () => {
  test.beforeEach(() => clearOtpIpRateLimit());

  const otpBoxes = (page: Page) => page.locator('input[inputmode="numeric"][maxlength="1"]');

  function pendingCount(email: string): number {
    return Number(scalar(`SELECT COUNT(*) FROM pending_signups WHERE email = ${literal(email.toLowerCase())};`));
  }

  function usablePendingCount(email: string): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM pending_signups WHERE email = ${literal(email.toLowerCase())} ` +
          "AND consumed_at IS NULL AND expires_at > now();",
      ),
    );
  }

  async function reachCodeStep(page: Page, email: string, lastName: string) {
    await page.goto("/signup");
    await page.locator("#signup-first-name").fill("EndToEnd");
    await page.locator("#signup-last-name").fill(lastName);
    await page.locator("#signup-email").fill(email);
    await page.locator("#signup-password").fill("E2eSignPass9f3!");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Check your email", { exact: true })).toBeVisible();
  }

  test("SGN-UI-05 resend issues a fresh signup request, clears the code boxes and starts a 30s cooldown", async ({ page }) => {
    const email = trackedEmail("sgnui-resend");
    // Fake clock (still running in real time) so the 30s cooldown can be skipped rather than waited
    // out. Installed before navigation so the page's Date and timers are the controlled ones.
    await page.clock.install();
    await reachCodeStep(page, email, "Resend");
    expect(pendingCount(email)).toBe(1);

    // A half-typed code from the first email must not linger once a new code is on its way.
    await fillOtpCode(page, "123");
    await page.getByRole("button", { name: "Resend code" }).click();

    await expect(page.getByRole("status").filter({ hasText: "We sent a new code" })).toBeVisible();
    // Read straight away: each scalar() below is a ~3s round trip to the hosted database, and the
    // countdown keeps running in real time meanwhile, so checked later it reads well under 30.
    const cooling = page.getByRole("button", { name: /Resend in \d+s/ });
    await expect(cooling).toHaveText(/^Resend in (29|30)s$/);
    for (let i = 0; i < 6; i++) await expect(otpBoxes(page).nth(i)).toHaveValue("");

    // Persisted, not just a toast: a second pending signup carrying the same details the form held.
    expect(pendingCount(email)).toBe(2);
    const newest = scalar(
      `SELECT first_name || '|' || last_name || '|' || (password_hash IS NOT NULL) FROM pending_signups ` +
        `WHERE email = ${literal(email.toLowerCase())} ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(newest).toBe("EndToEnd|Resend|true");

    // Cooldown: disabled with a countdown, and a forced click (a double-click, say) sends nothing.
    await expect(cooling).toBeDisabled();
    await cooling.click({ force: true });
    expect(pendingCount(email)).toBe(2);

    await page.clock.fastForward(30_000);
    await expect(page.getByRole("button", { name: "Resend code" })).toBeEnabled();
  });

  test("SGN-UI-06 after the first code and signup request expire, the resent code still creates the account", async ({ page }) => {
    // Not tracked in createdEmails: this test completes the signup, which audits the new user, so its
    // teardown has to tolerate the append-only audit_logs trigger — the shared afterEach does not.
    const email = disposableEmail("sgnui-resendexpired");
    const normalized = email.toLowerCase();
    let userId: string | null = null;
    try {
      await reachCodeStep(page, email, "Expired");
      // The user waited too long: both the first code and the pending signup behind it are dead.
      execMany([
        `UPDATE pending_signups SET expires_at = now() - interval '1 minute' WHERE email = ${literal(normalized)}`,
        `UPDATE otp_codes SET expires_at = now() - interval '1 minute' WHERE email = ${literal(normalized)}`,
      ]);
      expect(usablePendingCount(email)).toBe(0);

      await page.getByRole("button", { name: "Resend code" }).click();
      await expect(page.getByRole("status").filter({ hasText: "We sent a new code" })).toBeVisible();
      expect(usablePendingCount(email)).toBe(1);

      seedOtpCode(email, "624813");
      await fillOtpCode(page, "624813");
      await page.getByRole("button", { name: "Verify and create account" }).click();
      await page.waitForURL(/\/onboarding/);

      userId = scalar(`SELECT id FROM users WHERE email = ${literal(normalized)};`) || null;
      expect(userId, "verifying the resent code did not create the account").toBeTruthy();
      expect(scalar(`SELECT last_name FROM users WHERE email = ${literal(normalized)};`)).toBe("Expired");
    } finally {
      removeWelcomeJob(userId);
      execMany([
        `DELETE FROM pending_signups WHERE email = ${literal(normalized)}`,
        `DELETE FROM otp_codes WHERE email = ${literal(normalized)}`,
        `DELETE FROM otp_rate_limit WHERE email IN (${literal(`send:${normalized}`)}, ${literal(`verify:${normalized}`)}, ${literal(normalized)})`,
      ]);
      execAllowingAuditImmutability(`DELETE FROM users WHERE email = ${literal(normalized)};`);
    }
  });

  test("SGN-UI-07 a wrong code shows a readable message, not the raw error code", async ({ page }) => {
    const email = trackedEmail("sgnui-wrongcode");
    await reachCodeStep(page, email, "WrongCode");

    // Nothing was seeded, so any code is wrong.
    await fillOtpCode(page, "000000");
    await page.getByRole("button", { name: "Verify and create account" }).click();

    await expect(page.getByText("That code is invalid or has expired. Request a new one.")).toBeVisible();
    await expect(page.getByText("invalid_or_expired_otp")).toHaveCount(0);
    // Still on the code step, where the resend it points to actually is.
    await expect(page.getByRole("button", { name: "Resend code" })).toBeVisible();
  });

  test("SGN-UI-08 a failed resend reports the error, keeps the typed code and starts no cooldown", async ({ page }) => {
    const email = trackedEmail("sgnui-resendfail");
    await reachCodeStep(page, email, "ResendFail");

    // Stubbed only after the first, real start() — this is the resend's request alone.
    await page.route("**/api/auth/signup/start", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Email delivery is temporarily unavailable" }),
      }),
    );
    await fillOtpCode(page, "12");
    await page.getByRole("button", { name: "Resend code" }).click();

    await expect(page.getByText("Email delivery is temporarily unavailable")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resend code" })).toBeEnabled();
    await expect(page.getByText(/We sent a new code/)).toHaveCount(0);
    await expect(otpBoxes(page).nth(0)).toHaveValue("1");
    await expect(otpBoxes(page).nth(1)).toHaveValue("2");
    expect(pendingCount(email)).toBe(1);
  });
});
