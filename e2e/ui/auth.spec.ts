import { expect, test } from "@playwright/test";
import { env } from "../utils/env";
import { clearOtpIpRateLimit, clearOtpRateLimit, disposableEmail, seedOtpCode } from "../utils/otp";
import { exec, literal, scalar } from "../utils/psql";

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

  test("resend code is locked for 30 seconds after a successful resend", async ({ page }) => {
    // Regression: the button was disabled only while the request was in flight, so "Code sent" was
    // itself clickable and every click mailed another code. Each send also counts toward the 5-attempt
    // login lockout (AuthService.requestOtp), so a few impatient clicks locked the email for a day.
    // /verify-otp is shared by login and signup's "Email code" mode, so this covers both entry points.
    const email = disposableEmail("otp-resend-cooldown");
    const normalized = email.toLowerCase();
    const sentCodes = () => Number(scalar(`SELECT COUNT(*) FROM otp_codes WHERE email = ${literal(normalized)};`));
    try {
      // Fake clock (still running in real time) so the cooldown can be skipped rather than waited out.
      await page.clock.install();
      await requestOtpCode(page, email);
      expect(sentCodes()).toBe(1);

      await page.getByRole("button", { name: "Resend code" }).click();
      const sent = page.getByRole("button", { name: "Code sent" });
      await expect(sent).toBeDisabled();
      expect(sentCodes()).toBe(2);

      // A forced click (a double-click, or clicking the success label) must not send a third code.
      await sent.click({ force: true });
      expect(sentCodes()).toBe(2);

      // Past the 4s "Code sent" label, the countdown takes over and the button stays locked.
      await page.clock.fastForward(5_000);
      const cooling = page.getByRole("button", { name: /Resend in \d+s/ });
      await expect(cooling).toBeDisabled();
      await cooling.click({ force: true });
      expect(sentCodes()).toBe(2);

      await page.clock.fastForward(26_000);
      await expect(page.getByRole("button", { name: "Resend code" })).toBeEnabled();
    } finally {
      // The two sends above landed on the login lockout counter, keyed `login:<email>`
      // (LoginLockoutService.key) — not one of the shapes clearOtpRateLimit() clears.
      exec(
        `DELETE FROM otp_rate_limit WHERE email = ${literal(`login:${normalized}`)}; ` +
          `DELETE FROM otp_codes WHERE email = ${literal(normalized)};`,
      );
    }
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

  // ─── "[Sign Up] Team Member Email and Assigned Role Are Not Clearly Associated" ───
  //
  // Each invitee already had its own row (email + role picker), but the picker's `w-40` lost the
  // stylesheet race to Select's built-in `w-full` (cx() is a plain join), so the picker filled the
  // row and the email beside it collapsed to zero width — a column of unlabeled role pickers.

  /** Signs a brand-new owner in by OTP and creates their workspace, landing on the team step. */
  async function reachTeamStep(page: import("@playwright/test").Page, label: string) {
    const ownerEmail = disposableEmail(label);
    await requestOtpCode(page, ownerEmail);
    seedOtpCode(ownerEmail, "135791");
    await fillOtpCode(page, "135791");
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await page.waitForURL(/\/onboarding/);
    await page.getByLabel("Organization / workspace name *").fill(`E2E Onboarding Roles ${Date.now()}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Invite your team (optional)" })).toBeVisible();
  }

  /** The row holding one invitee: its email and its own role picker. */
  function inviteeRow(page: import("@playwright/test").Page, email: string) {
    return page.getByRole("listitem").filter({ has: page.getByRole("combobox", { name: `Role for ${email}`, exact: true }) });
  }

  async function workspaceInvitations(page: import("@playwright/test").Page): Promise<Array<{ email: string; role: string; status: string }>> {
    return (await page.request.get(`${env.apiBaseUrl}/api/workspace/invitations`)).json();
  }

  test("ONB-UI-01 each invitee's email is shown in the same row as its own role picker, and each invitation keeps the role chosen for it", async ({ page }) => {
    await reachTeamStep(page, "otp-onboarding-roles");
    const managerEmail = disposableEmail("onb-role-manager");
    const qaEmail = disposableEmail("onb-role-qa");
    await page.getByLabel("Team member emails").fill(`${managerEmail}\n${qaEmail}`);

    for (const email of [managerEmail, qaEmail]) {
      const row = inviteeRow(page, email);
      await expect(row, `one row for ${email}`).toHaveCount(1);
      // toBeVisible alone already fails for a zero-width element; the width check names the
      // actual regression (the email squeezed out by a full-width picker) if it ever returns.
      const label = row.getByText(email, { exact: true });
      await expect(label).toBeVisible();
      expect((await label.boundingBox())!.width, `${email} must not be squeezed out by its picker`).toBeGreaterThan(40);
      await expect(row.getByRole("combobox"), "the new row starts on the default role").toHaveValue("qa_engineer");
    }

    await inviteeRow(page, managerEmail).getByRole("combobox").selectOption("manager");
    await expect(inviteeRow(page, qaEmail).getByRole("combobox"), "changing one row must not change another").toHaveValue("qa_engineer");

    // Adding a third address keeps the role already chosen for the first.
    const thirdEmail = disposableEmail("onb-role-third");
    await page.getByLabel("Team member emails").fill(`${managerEmail}\n${qaEmail}\n${thirdEmail}`);
    await expect(inviteeRow(page, managerEmail).getByRole("combobox")).toHaveValue("manager");
    await expect(inviteeRow(page, thirdEmail).getByRole("combobox")).toHaveValue("qa_engineer");

    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/projects/);

    const invites = await workspaceInvitations(page);
    const roleOf = (email: string) => invites.find((i) => i.email === email)?.role;
    expect(roleOf(managerEmail), "the Manager row's invitation").toBe("manager");
    expect(roleOf(qaEmail), "the QA Engineer row's invitation").toBe("qa_engineer");
    expect(roleOf(thirdEmail), "the untouched row's invitation uses the default").toBe("qa_engineer");
  });

  test("ONB-UI-02 rows follow the textarea: every separator, duplicates collapse, removals drop the row, and blank input shows no roles", async ({ page }) => {
    await reachTeamStep(page, "otp-onboarding-rows");
    const a = disposableEmail("onb-rows-a");
    const b = disposableEmail("onb-rows-b");
    const c = disposableEmail("onb-rows-c");
    const emails = page.getByLabel("Team member emails");
    const pickers = page.getByRole("combobox", { name: /^Role for / });

    // Whitespace only: nothing parsed, so no roles section at all.
    await emails.fill("   \n  ");
    await expect(page.getByText("Roles", { exact: true })).toHaveCount(0);

    // Comma, semicolon and newline each split; a repeat — including a different case — is one row.
    await emails.fill(`${a}, ${b};\n${c}\n${a.toUpperCase()}`);
    await expect(pickers).toHaveCount(3);
    for (const email of [a, b, c]) await expect(inviteeRow(page, email).getByText(email, { exact: true })).toBeVisible();

    // Removing an address removes its row.
    await emails.fill(`${a}\n${c}`);
    await expect(pickers).toHaveCount(2);
    await expect(inviteeRow(page, b)).toHaveCount(0);

    // Skipping invites nobody, whatever is typed.
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.waitForURL(/\/projects/);
    expect(await workspaceInvitations(page)).toEqual([]);
  });

  test("ONB-UI-03 a failed invitation shows the error and keeps the user on the team step", async ({ page }) => {
    await reachTeamStep(page, "otp-onboarding-fail");
    await page.route("**/api/workspace/invitations", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, json: { error: "Simulated invitation failure" } })
        : route.continue(),
    );
    const email = disposableEmail("onb-fail");
    await page.getByLabel("Team member emails").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByText(/Simulated invitation failure|Failed to add team members/)).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(inviteeRow(page, email).getByText(email, { exact: true }), "the row is still there to retry").toBeVisible();
  });
});
