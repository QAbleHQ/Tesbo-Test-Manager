import { expect, test } from "@playwright/test";
import { env } from "../utils/env";
import { clearOtpIpRateLimit, clearOtpRateLimit, disposableEmail, seedOtpCode } from "../utils/otp";

test.describe("login", () => {
  // Start these tests logged out even though the project default carries an
  // authenticated storage state, since this suite exercises the login form itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a user can sign in with the seeded smoke-test account", { tag: '@tesbo.testId("TES-TC-625")' }, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email *", { exact: true }).fill(env.testEmail);
    await page.getByLabel("Password *", { exact: true }).fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/projects/);
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  });

  test("rejects an incorrect password", { tag: '@tesbo.testId("TES-TC-626")' }, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email *", { exact: true }).fill(env.testEmail);
    await page.getByLabel("Password *", { exact: true }).fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("rejects an unregistered email", { tag: '@tesbo.testId("TES-TC-627")' }, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email *", { exact: true }).fill(disposableEmail("no-such-user"));
    await page.getByLabel("Password *", { exact: true }).fill("whatever-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Same generic error as a wrong password — the API must not reveal whether the
    // email is registered.
    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("requires an email before submitting", { tag: '@tesbo.testId("TES-TC-628")' }, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Password *", { exact: true }).fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toHaveText("Email is required");
    await expect(page).toHaveURL(/\/login/);
  });

  test("requires a password before submitting", { tag: '@tesbo.testId("TES-TC-629")' }, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email *", { exact: true }).fill(env.testEmail);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toHaveText("Password is required");
    await expect(page).toHaveURL(/\/login/);
  });

  test("switching to Email code mode hides the password field", { tag: '@tesbo.testId("TES-TC-630")' }, async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Password *", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await page.getByRole("button", { name: "Email code" }).click();
    await expect(page.getByLabel("Password *", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send login code" })).toBeVisible();

    await page.getByRole("button", { name: "Password" }).click();
    await expect(page.getByLabel("Password *", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});

test.describe("otp login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Every test here calls the real /otp/request endpoint at least once, and they all
  // share one IP as far as the backend's rate limiter is concerned (all requests come
  // from this same host). Reset before each test so no test starts against a budget
  // partially spent by an earlier one. (IP-scoped only — a blanket clear would race with
  // the API suite's own rate-limit test running concurrently in another project.)
  test.beforeEach(() => clearOtpIpRateLimit());

  async function requestOtpCode(page: import("@playwright/test").Page, email: string) {
    await page.goto("/login");
    await page.getByRole("button", { name: "Email code" }).click();
    await page.getByLabel("Email *", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send login code" }).click();
    await page.waitForURL(/\/verify-otp/);
  }

  async function fillOtpCode(page: import("@playwright/test").Page, code: string) {
    const boxes = page.locator('input[inputmode="numeric"]');
    for (let i = 0; i < code.length; i++) {
      await boxes.nth(i).fill(code[i]);
    }
  }

  test("requesting a code shows the check-your-email screen", { tag: '@tesbo.testId("TES-TC-631")' }, async ({ page }) => {
    const email = disposableEmail("otp-request");
    await requestOtpCode(page, email);

    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify and sign in" })).toBeVisible();
  });

  test("rejects an incorrect code", { tag: '@tesbo.testId("TES-TC-632")' }, async ({ page }) => {
    const email = disposableEmail("otp-wrong");
    await requestOtpCode(page, email);

    await fillOtpCode(page, "000000");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/verify-otp/);
  });

  test("rejects an expired code", { tag: '@tesbo.testId("TES-TC-633")' }, async ({ page }) => {
    const email = disposableEmail("otp-expired");
    await requestOtpCode(page, email);
    seedOtpCode(email, "111222", -5);

    await fillOtpCode(page, "111222");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/verify-otp/);
  });

  test("signs in an existing user with a valid one-time code", { tag: '@tesbo.testId("TES-TC-634")' }, async ({ page }) => {
    // Unlike the disposable emails above, env.testEmail is reused across every run of
    // this suite, so its own rate-limit counter needs an explicit reset too.
    clearOtpRateLimit(env.testEmail);
    await requestOtpCode(page, env.testEmail);
    seedOtpCode(env.testEmail, "654321");

    await fillOtpCode(page, "654321");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await page.waitForURL(/\/projects/);
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  });

  test("auto-creates an account for a brand-new email", { tag: '@tesbo.testId("TES-TC-635")' }, async ({ page }) => {
    const email = disposableEmail("otp-new-account");
    await requestOtpCode(page, email);
    seedOtpCode(email, "789789");

    await fillOtpCode(page, "789789");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await page.waitForURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
  });

  test("lets the user go back to a different email", { tag: '@tesbo.testId("TES-TC-636")' }, async ({ page }) => {
    const email = disposableEmail("otp-back");
    await requestOtpCode(page, email);

    await page.getByRole("link", { name: "Use a different email" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("inviting a teammate from onboarding creates a real invitation, not a silent membership grant", { tag: '@tesbo.testId("TES-TC-3010")' }, async ({ page }) => {
    // Regression: the onboarding "Invite your team" step used to call addWorkspaceMember (POST
    // /api/workspace/members), which upserts the invitee straight into organization_members with no
    // password and never touches the invitations table or sends email — so "the recipient does not
    // receive an invitation link" was because none was ever generated. The fix points onboarding at
    // the same createInvitation endpoint Settings > Members already uses successfully.
    const ownerEmail = disposableEmail("otp-onboarding-owner");
    await requestOtpCode(page, ownerEmail);
    seedOtpCode(ownerEmail, "135791");
    await fillOtpCode(page, "135791");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await page.waitForURL(/\/onboarding/);
    await page.getByLabel("Organization / workspace name *").fill(`E2E Onboarding Invite ${Date.now()}`);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Invite your team (optional)" })).toBeVisible();
    const inviteeEmail = disposableEmail("otp-onboarding-invitee");
    await page.getByLabel("Team member emails").fill(inviteeEmail);
    await page.getByRole("button", { name: "Continue" }).click();

    await page.waitForURL(/\/projects/);

    const invites = await (await page.request.get(`${env.apiBaseUrl}/api/workspace/invitations`)).json();
    const created = invites.find((i: any) => i.email === inviteeEmail);
    expect(created, "onboarding must create a real pending invitation for the invited email").toBeTruthy();
    expect(created.status).toBe("pending");

    const members = await (await page.request.get(`${env.apiBaseUrl}/api/workspace/members`)).json();
    expect(
      members.map((m: any) => m.email),
      "the invitee must not be granted membership before accepting the invite",
    ).not.toContain(inviteeEmail);
  });
});
