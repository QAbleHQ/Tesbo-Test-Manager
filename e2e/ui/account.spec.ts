import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { waitForPasswordResetLinkInLogs, backendLogsAvailable } from "../utils/backend-logs";
import { env, testAddress } from "../utils/env";
import {
  FIXTURE_PASSWORD,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The account screen at /account, and the forgot/reset-password flow that reaches the same stored
 * password from outside a session.
 *
 * Four reported tickets live here:
 *
 *   - BetterBugs 6a840253 — the page's label should read "My Account", not "Account". ACU-01 is
 *     currently RED: app/(app)/account/page.tsx renders `<h1>Account</h1>` and Sidebar.tsx labels
 *     its footer link "Account". Per §3 this is not to be turned green by weakening it — it clears
 *     when the label changes in both places.
 *   - BetterBugs 6a8400e2 — changing a password must confirm it did. Confirmed by redirecting to
 *     /login with a notice rather than a toast, so ACU-02 asserts the redirect and notice.
 *   - "[Change Password] User Session Is Not Logged Out After Password Change in the Same Browser" —
 *     auth.service.ts changePassword used to invalidate every *other* session and deliberately keep
 *     the one making the request alive, so the tab (and any sibling tab sharing its cookie) that
 *     just changed the password stayed signed in. Fixed to invalidate every session, including this
 *     one — the same reasoning password-reset already used (see password-reset.service.ts). ACU-02
 *     and ACU-03 pin this; ACU-12 pins the cross-device half that already worked.
 *   - BetterBugs 6a7b24ef — "Forgot/Reset Password functionality is missing". It exists now, end to
 *     end: a link on /login, POST /password/forgot, an emailed token, /reset-password/:token, and
 *     POST /password/reset. ACU-05..ACU-10 pin the whole path including its refusals.
 *
 * Why its own disposable tenant ("account-ui"): every test below CHANGES a real password. Run
 * against the shared smoke account and the next spec's login — and global-setup's on the following
 * run — would authenticate with a password that no longer exists. The suite also restores
 * FIXTURE_PASSWORD in afterEach so `loginAs()` keeps working for anything that reuses this tenant.
 *
 * The reset link is read out of the backend log, not a mailbox: outside production the backend runs
 * EMAIL_DELIVERY_MODE=log and prints "PASSWORD RESET for <email>: <url>" (EmailService
 * sendPasswordReset keeps that format parseable precisely for this). No real mail is sent.
 *
 * Locator notes: `Field`/`FieldLabel` DO set htmlFor on this screen, so ids are used directly
 * (#current-password, #new-password, #confirm-new-password).
 */

/** Distinct from FIXTURE_PASSWORD, and satisfies validatePasswordValue (upper, lower, digit, 8+). */
const NEW_PASSWORD = "E2E-Account-Next-7k2!";

test.describe("account screen and password reset (UI)", () => {
  let tenant: RbacTenant | null = null;
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("account-ui");
  });

  test.afterAll(async () => {
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(async () => {
    // Put the fixture password back however the test left it, so loginAs()/writeStorageState()
    // still work for this tenant — including on the next run against the persistent volume.
    if (!tenant) return;
    await restoreFixturePassword();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Resets the owner's password to FIXTURE_PASSWORD through the product's own change endpoint.
   *
   * Tries the two passwords a test could have left behind. Deliberately NOT done through psql: the
   * hash format is the password service's business, and a hand-written row would drift from it.
   */
  async function restoreFixturePassword(): Promise<void> {
    for (const candidate of [NEW_PASSWORD, FIXTURE_PASSWORD]) {
      const ctx = await requestContextFor(candidate);
      if (!ctx) continue;
      const res = await ctx.post("/api/auth/password/change", {
        data: { currentPassword: candidate, newPassword: FIXTURE_PASSWORD },
        failOnStatusCode: false,
      });
      await ctx.dispose();
      if (res.ok() || res.status() === 204) return;
    }
  }

  /** A logged-in API context for the owner at a given password, or null if that password is wrong. */
  async function requestContextFor(password: string): Promise<APIRequestContext | null> {
    // storageState cleared explicitly: request.newContext() otherwise inherits account A's session
    // from playwright.config.ts, and the login below would appear to succeed on any password.
    const ctx = await request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    const res = await ctx.post("/api/auth/password/login", {
      data: { email: tenant!.owner.email, password },
      failOnStatusCode: false,
    });
    if (!res.ok()) {
      await ctx.dispose();
      return null;
    }
    return ctx;
  }

  /**
   * A fresh session every call, not one snapshot reused across the file: a successful change now
   * invalidates every session for the user, including whichever one made the request (that's the
   * whole point of ACU-02/ACU-03 below), so a session captured once in beforeAll would already be
   * dead by the second test that performs a real change.
   */
  async function openAccount(browser: Browser): Promise<Page> {
    const state = await writeStorageState(tenant!.owner, `account-ui-owner-${contexts.length}`);
    const ctx = await browser.newContext({ storageState: state });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 2, name: /Change password|Set a password/ })).toBeVisible();
    return page;
  }

  /** A fresh browser with no session, for the signed-out halves of the reset flow. */
  async function anonymousPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    contexts.push(ctx);
    return ctx.newPage();
  }

  async function fillChangePassword(page: Page, current: string, next: string, confirm = next) {
    await page.locator("#current-password").fill(current);
    await page.locator("#new-password").fill(next);
    await page.locator("#confirm-new-password").fill(confirm);
    await page.getByRole("button", { name: /Change password|Set password/ }).click();
  }

  /** Proves a password is the live one by using it, rather than trusting a toast. */
  async function passwordWorks(password: string): Promise<boolean> {
    const ctx = await requestContextFor(password);
    if (!ctx) return false;
    await ctx.dispose();
    return true;
  }

  // ─── The label ─────────────────────────────────────────────────────────────

  test('ACU-01 the account screen is labelled "My Account"', { tag: '@tesbo.testId("TES-TC-986")' }, async ({ browser }) => {
    const page = await openAccount(browser);

    // Both places the label appears: the page heading and the sidebar link that reaches it.
    await expect(page.getByRole("heading", { level: 1, name: "My Account" })).toBeVisible();
    await expect(page.locator('a[href="/account"]')).toContainText("My Account");
  });

  // ─── Changing a password from the account screen ───────────────────────────

  test("ACU-02 a successful change confirms itself and signs the tab out", async ({ browser }) => {
    const page = await openAccount(browser);

    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD);

    // No toast to read on a page that's about to be signed out from under it — the confirmation is
    // the redirect itself, landing on /login with a notice.
    await page.waitForURL(/\/login/);
    await expect(page.getByText(/Password changed\. Sign in with your new password\./i)).toBeVisible();
    expect(await passwordWorks(NEW_PASSWORD), "the new password should authenticate").toBe(true);
    expect(await passwordWorks(FIXTURE_PASSWORD), "the old password must stop working").toBe(false);
  });

  test("ACU-03 the tab that changed the password is itself signed out, not just other sessions", async ({
    browser,
  }) => {
    // Regression cover for "[Change Password] User Session Is Not Logged Out After Password Change
    // in the Same Browser": changePassword used to keep the requesting session alive deliberately,
    // so the tab that submitted the form — and any sibling tab sharing its cookie jar — stayed
    // signed in. A second page in the SAME browser context stands in for that sibling tab.
    const page = await openAccount(browser);
    const siblingTab = await page.context().newPage();
    await siblingTab.goto("/projects");

    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD);
    await page.waitForURL(/\/login/);

    for (const p of [page, siblingTab]) {
      const status = await p.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).status);
      expect(status, "a same-browser session should be signed out after the password change").toBe(401);
    }
  });

  test("ACU-04 a wrong current password, a mismatch, and a weak password are each refused", { tag: '@tesbo.testId("TES-TC-989")' }, async ({
    browser,
  }) => {
    const page = await openAccount(browser);

    // Wrong current password — refused by the server, and nothing about the current session changes.
    await fillChangePassword(page, "E2E-Not-The-Password-1x", NEW_PASSWORD);
    await expect(page.getByText("Current password is incorrect")).toBeVisible();
    expect(page.url(), "a refused change should not sign the tab out").toContain("/account");

    // Mismatched confirmation — refused in the page, before any request.
    await page.reload();
    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD, `${NEW_PASSWORD}-different`);
    await expect(page.getByText(/do not match|don't match/i)).toBeVisible();

    // Too weak for validatePasswordValue (no uppercase, no digit, under 8).
    await page.reload();
    await fillChangePassword(page, FIXTURE_PASSWORD, "short");
    // The full error text, not /at least 8 characters/i: PASSWORD_RULES_HINT ("At least 8
    // characters, with an uppercase letter, …") is rendered under the field at all times, so the
    // loose pattern matched the permanent hint as well as the error and strict mode refused both.
    await expect(page.getByText("Password must be at least 8 characters", { exact: true })).toBeVisible();

    // Through all three refusals the stored password is untouched.
    expect(await passwordWorks(FIXTURE_PASSWORD)).toBe(true);
    expect(await passwordWorks(NEW_PASSWORD)).toBe(false);
  });

  // ─── Forgot password ───────────────────────────────────────────────────────

  test("ACU-05 the login screen offers a way to recover a forgotten password", { tag: '@tesbo.testId("TES-TC-990")' }, async ({ browser }) => {
    const page = await anonymousPage(browser);
    await page.goto("/login");

    const link = page.getByRole("link", { name: /Forgot password/i });
    await expect(link).toBeVisible();

    await link.click();
    await page.waitForURL(/\/forgot-password$/);
    await expect(page.getByText("Forgot password?")).toBeVisible();
  });

  test("ACU-06 requesting a reset link says so without revealing whether the account exists", { tag: '@tesbo.testId("TES-TC-991")' }, async ({
    browser,
  }) => {
    const page = await anonymousPage(browser);
    await page.goto("/forgot-password");

    // A known address and an unknown one must be answered identically — otherwise the screen is an
    // account-existence oracle for anyone who asks, the same reason signup/start answers 204.
    for (const email of [tenant!.owner.email, testAddress("account-no-such-user")]) {
      await page.goto("/forgot-password");
      await page.locator("#email").fill(email);
      await page.getByRole("button", { name: /Send reset link/i }).click();
      await expect(page.getByText("Check your email")).toBeVisible();
      await expect(page.getByText(email, { exact: false })).toBeVisible();
    }
  });

  test("ACU-07 a reset link sets a new password and signs the user in with it", { tag: '@tesbo.testId("TES-TC-992")' }, async ({ browser }) => {
    test.skip(!backendLogsAvailable(), "reads the reset link out of the backend container log");
    const page = await anonymousPage(browser);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(tenant!.owner.email);
    await page.getByRole("button", { name: /Send reset link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetUrl = await waitForPasswordResetLinkInLogs(tenant!.owner.email);
    expect(resetUrl, "the backend should have printed a reset link").toBeTruthy();

    await page.goto(new URL(resetUrl!).pathname);
    await expect(page.getByText("Set a new password")).toBeVisible();
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#confirmPassword").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /^Reset password$/i }).click();

    await expect(page.getByText("Password reset")).toBeVisible();
    expect(await passwordWorks(NEW_PASSWORD), "the reset password should authenticate").toBe(true);
    expect(await passwordWorks(FIXTURE_PASSWORD), "the old password must stop working").toBe(false);
  });

  test("ACU-08 a reset link cannot be used twice", { tag: '@tesbo.testId("TES-TC-993")' }, async ({ browser }) => {
    test.skip(!backendLogsAvailable(), "reads the reset link out of the backend container log");
    const page = await anonymousPage(browser);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(tenant!.owner.email);
    await page.getByRole("button", { name: /Send reset link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetUrl = await waitForPasswordResetLinkInLogs(tenant!.owner.email);
    expect(resetUrl).toBeTruthy();
    const resetPath = new URL(resetUrl!).pathname;

    await page.goto(resetPath);
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#confirmPassword").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText("Password reset")).toBeVisible();

    // Second visit with the same token: the page must report it spent, not offer the form again.
    await page.goto(resetPath);
    await expect(page.getByText("Link expired")).toBeVisible();
    await expect(page.locator("#password")).toHaveCount(0);
  });

  test("ACU-09 an unknown or malformed reset token is reported, never a blank or broken page", { tag: '@tesbo.testId("TES-TC-994")' }, async ({
    browser,
  }) => {
    const page = await anonymousPage(browser);

    for (const token of ["not-a-real-token", "0".repeat(64), "../../etc/passwd"]) {
      await page.goto(`/reset-password/${encodeURIComponent(token)}`);
      await expect(page.getByText("Link expired"), `token ${token} should be refused cleanly`).toBeVisible();
      await expect(page.locator("#password")).toHaveCount(0);
    }
  });

  test("ACU-10 the reset form enforces the same password rules as the account screen", { tag: '@tesbo.testId("TES-TC-995")' }, async ({ browser }) => {
    test.skip(!backendLogsAvailable(), "reads the reset link out of the backend container log");
    const page = await anonymousPage(browser);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(tenant!.owner.email);
    await page.getByRole("button", { name: /Send reset link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetUrl = await waitForPasswordResetLinkInLogs(tenant!.owner.email);
    expect(resetUrl).toBeTruthy();
    await page.goto(new URL(resetUrl!).pathname);

    // Too short.
    await page.locator("#password").fill("short");
    await page.locator("#confirmPassword").fill("short");
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText("Password must be at least 8 characters", { exact: true })).toBeVisible();

    // Long enough but no uppercase and no digit.
    await page.locator("#password").fill("alllowercase");
    await page.locator("#confirmPassword").fill("alllowercase");
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText(/uppercase|number/i)).toBeVisible();

    // Mismatched confirmation.
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#confirmPassword").fill(`${NEW_PASSWORD}-different`);
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText(/do not match|don't match/i)).toBeVisible();

    // None of the refusals changed the stored password.
    expect(await passwordWorks(FIXTURE_PASSWORD)).toBe(true);
  });
  // ─── The profile card ──────────────────────────────────────────────────────

  test("ACU-11 the profile shows the first name and surname captured at signup, not just the email", { tag: '@tesbo.testId("TES-TC-996")' }, async ({ browser }) => {
    /*
     * Basecamp 10212498688 — "Profile page should have user name and surname and mobile number fields
     * fetched during sign up". The Profile card rendered nothing but the email.
     *
     * /signup collects First name and Last name separately, sends them as one `name`, and GET /me now
     * splits that stored value back into firstName/lastName (auth.service.ts `me()`) so the screen can
     * show the two fields signup actually collected instead of one merged string. Asserted against the
     * value the API reports rather than a hard-coded string, so this stays true for any tenant. Both
     * are editable inputs (see ACU-13/ACU-14 below for the PATCH round trip), so this reads `value`
     * rather than text content.
     *
     * The mobile number is asserted only for visibility, not a specific value: signup collects it as
     * optional, so this tenant's user may legitimately have none on file.
     */
    const page = await openAccount(browser);

    const reported = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      return res.ok
        ? ((await res.json()) as { firstName?: string | null; lastName?: string | null; email?: string | null })
        : null;
    });
    expect(reported, "GET /me did not answer").not.toBeNull();
    const expectedFirstName = (reported!.firstName ?? "").trim();
    const expectedLastName = (reported!.lastName ?? "").trim();
    expect(expectedFirstName, "this tenant's user has no first name stored, so the test proves nothing").not.toBe("");
    expect(expectedLastName, "this tenant's user has no last name stored, so the test proves nothing").not.toBe("");

    // First name and last name are on the screen, each labelled — not just present somewhere in the markup.
    const firstNameValue = page.locator("#account-first-name");
    await expect(firstNameValue, "the profile card shows no first name field").toBeVisible();
    await expect(firstNameValue).toHaveValue(expectedFirstName);

    const lastNameValue = page.locator("#account-last-name");
    await expect(lastNameValue, "the profile card shows no last name field").toBeVisible();
    await expect(lastNameValue).toHaveValue(expectedLastName);

    // The email it used to show alone is still there.
    await expect(page.locator("#account-email")).toHaveText((reported!.email ?? "").trim());

    // Mobile number now has a real column and a field on the card — whatever this tenant's value is
    // (signup collects it as optional, so it may legitimately be unset), the field itself must render.
    await expect(page.locator("#account-mobile-number"), "the profile card shows no mobile number field").toBeVisible();
  });

  // ─── Editing the profile ────────────────────────────────────────────────────

  test("ACU-21 each field's pencil unlocks only that field, independently of the others", { tag: '@tesbo.testId("TES-TC-1413")' }, async ({ browser }) => {
    /*
     * Regression cover: all three fields used to share one edit flag, so clicking any single
     * pencil (e.g. Mobile number's) unlocked First name and Last name right along with it. Each
     * field now owns its own flag — this pins that clicking one row's pencil affects only that row.
     */
    const page = await openAccount(browser);
    const firstNameInput = page.locator("#account-first-name");
    const lastNameInput = page.locator("#account-last-name");
    const mobileInput = page.locator("#account-mobile-number");
    const editFirstName = page.getByRole("button", { name: "Edit first name" });
    const editLastName = page.getByRole("button", { name: "Edit last name" });
    const editMobile = page.getByRole("button", { name: "Edit mobile number" });
    const saveButton = page.getByRole("button", { name: "Save profile" });

    await expect(firstNameInput).toHaveAttribute("readonly", "");
    await expect(lastNameInput).toHaveAttribute("readonly", "");
    await expect(mobileInput).toBeDisabled();
    await expect(saveButton).toBeDisabled();

    // First name's pencil unlocks only First name.
    await editFirstName.click();
    await expect(firstNameInput).not.toHaveAttribute("readonly", "");
    await expect(lastNameInput).toHaveAttribute("readonly", "");
    await expect(mobileInput).toBeDisabled();
    await expect(firstNameInput).toBeFocused();
    await expect(editFirstName).toHaveCount(0);
    await expect(editLastName).toBeVisible();
    await expect(editMobile).toBeVisible();
    // Save enables the moment a field is unlocked, even before any value has actually changed.
    await expect(saveButton).toBeEnabled();

    // Last name's pencil unlocks Last name too, without relocking or affecting First name.
    await editLastName.click();
    await expect(lastNameInput).not.toHaveAttribute("readonly", "");
    await expect(lastNameInput).toBeFocused();
    await expect(firstNameInput).not.toHaveAttribute("readonly", "");
    await expect(mobileInput).toBeDisabled();
    await expect(editLastName).toHaveCount(0);
    await expect(editMobile).toBeVisible();

    // Mobile number's pencil unlocks it too, without touching the other two.
    await editMobile.click();
    await expect(mobileInput).toBeEnabled();
    await expect(firstNameInput).not.toHaveAttribute("readonly", "");
    await expect(lastNameInput).not.toHaveAttribute("readonly", "");
    await expect(editMobile).toHaveCount(0);
  });

  test("ACU-22 saving with a field unlocked but unchanged succeeds safely and relocks the form", { tag: '@tesbo.testId("TES-TC-1414")' }, async ({ browser }) => {
    const page = await openAccount(browser);
    const firstNameInput = page.locator("#account-first-name");
    const saveButton = page.getByRole("button", { name: "Save profile" });

    await page.getByRole("button", { name: "Edit first name" }).click();
    await expect(saveButton).toBeEnabled();

    // No typing at all — a pure no-op resubmit of the already-valid, unchanged value must not
    // error or hang.
    await saveButton.click();
    await expect(page.getByText("Profile updated.")).toBeVisible();

    // Back to locked, its pencil restored, and Save disabled again.
    await expect(firstNameInput).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Edit first name" })).toBeVisible();
    await expect(saveButton).toBeDisabled();
  });

  test("ACU-13 the first name, last name and mobile number can be edited and persist after refresh", { tag: '@tesbo.testId("TES-TC-1400")' }, async ({ browser }) => {
    const page = await openAccount(browser);
    const newFirstName = `E2EFirst${Date.now()}`;
    const newLastName = `E2ELast${Date.now()}`;
    // Typed with the formatting a real user would use — the screen strips it before sending, so the
    // value that actually persists (asserted below) is the normalized "+14155550132".
    const typedMobileNumber = "+1 415 555 0132";
    const normalizedMobileNumber = "+14155550132";

    const firstNameInput = page.locator("#account-first-name");
    const lastNameInput = page.locator("#account-last-name");
    const mobileInput = page.locator("#account-mobile-number");
    const saveButton = page.getByRole("button", { name: "Save profile" });

    // No profile picture field of any kind on this screen — that feature was removed.
    await expect(page.getByText(/profile picture/i)).toHaveCount(0);

    // Nothing changed yet, so saving is disabled — this must not be a no-op button on load.
    await expect(saveButton).toBeDisabled();

    // Each field reads read-only until its own pencil button is clicked.
    await expect(firstNameInput).toHaveAttribute("readonly", "");
    await page.getByRole("button", { name: "Edit first name" }).click();
    await page.getByRole("button", { name: "Edit last name" }).click();
    await page.getByRole("button", { name: "Edit mobile number" }).click();
    await expect(firstNameInput).not.toHaveAttribute("readonly", "");

    await firstNameInput.fill(newFirstName);
    await lastNameInput.fill(newLastName);
    await mobileInput.fill(typedMobileNumber);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page.getByText("Profile updated.")).toBeVisible();

    // Persisted server-side, not just in local component state — and normalized, not the raw typed
    // formatting, since that's what the API stores and the CHECK constraint on users.mobile_number
    // requires.
    await page.reload();
    await expect(page.locator("#account-first-name")).toHaveValue(newFirstName);
    await expect(page.locator("#account-last-name")).toHaveValue(newLastName);
    await expect(page.locator("#account-mobile-number")).toHaveValue(normalizedMobileNumber);

    const reported = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      return res.ok
        ? ((await res.json()) as { firstName?: string | null; lastName?: string | null; mobileNumber?: string | null })
        : null;
    });
    expect(reported?.firstName).toBe(newFirstName);
    expect(reported?.lastName).toBe(newLastName);
    expect(reported?.mobileNumber).toBe(normalizedMobileNumber);
  });

  test("ACU-14 an empty first/last name or an out-of-range mobile number is rejected inline", { tag: '@tesbo.testId("TES-TC-1401")' }, async ({ browser }) => {
    const page = await openAccount(browser);

    const firstNameInput = page.locator("#account-first-name");
    const lastNameInput = page.locator("#account-last-name");
    const mobileInput = page.locator("#account-mobile-number");
    const saveButton = page.getByRole("button", { name: "Save profile" });

    await page.getByRole("button", { name: "Edit first name" }).click();
    await page.getByRole("button", { name: "Edit last name" }).click();
    await page.getByRole("button", { name: "Edit mobile number" }).click();

    // Empty / whitespace-only first name.
    await firstNameInput.fill("   ");
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByText("First name is required")).toBeVisible();

    // Empty / whitespace-only last name.
    await firstNameInput.fill("E2E Valid First");
    await lastNameInput.fill("   ");
    await saveButton.click();
    await expect(page.getByText("Last name is required")).toBeVisible();

    // Too few digits to be a real number — rejected rather than silently stored.
    await lastNameInput.fill("E2E Valid Last");
    await mobileInput.fill("12345");
    await saveButton.click();
    await expect(page.getByText(/mobile number/i)).toBeVisible();

    // A plausible-looking number missing its country code — the constraint requires an explicit
    // leading '+', so this is rejected inline rather than silently normalized to one.
    await mobileInput.fill("14155550132");
    await saveButton.click();
    await expect(page.getByText(/country code/i)).toBeVisible();

    // None of the rejected attempts reached the server: GET /me still reports the original values.
    const reported = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      return res.ok
        ? ((await res.json()) as { firstName?: string | null; lastName?: string | null; mobileNumber?: string | null })
        : null;
    });
    expect(reported?.firstName).not.toBe("");
    expect(reported?.lastName).not.toBe("");
    expect(reported?.mobileNumber ?? "").not.toBe("14155550132");
  });

  test("ACU-15 a mobile number is optional — clearing it back to blank is allowed and persists", { tag: '@tesbo.testId("TES-TC-1407")' }, async ({ browser }) => {
    // Existing users (and this tenant's owner before this test) have no mobile number on file —
    // saving the profile must not force one to be entered, and an explicit clear must stick.
    const page = await openAccount(browser);
    const mobileInput = page.locator("#account-mobile-number");
    const saveButton = page.getByRole("button", { name: "Save profile" });

    await page.getByRole("button", { name: "Edit mobile number" }).click();

    await mobileInput.fill("+1 415 555 0199");
    await saveButton.click();
    await expect(page.getByText("Profile updated.")).toBeVisible();

    // A successful save locks the fields again, same as the name fields — re-open before clearing.
    await page.getByRole("button", { name: "Edit mobile number" }).click();
    await mobileInput.fill("");
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByText("Profile updated.")).toBeVisible();

    await page.reload();
    await expect(page.locator("#account-mobile-number")).toHaveValue("");

    const reported = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      return res.ok ? ((await res.json()) as { mobileNumber?: string | null }) : null;
    });
    expect(reported?.mobileNumber).toBeNull();
  });

  // ─── Cross-device session invalidation ─────────────────────────────────────

  test("ACU-12 a different browser's session is signed out too", { tag: '@tesbo.testId("TES-TC-1310")' }, async ({ browser }) => {
    // The half of this behaviour that already worked before the fix — kept as regression cover now
    // that the mechanism changed from "invalidate the others" to "invalidate everything".
    const otherDeviceState = await writeStorageState(tenant!.owner, `account-ui-owner-other-device-${contexts.length}`);
    const otherDeviceCtx = await browser.newContext({ storageState: otherDeviceState });
    contexts.push(otherDeviceCtx);
    const otherDevicePage = await otherDeviceCtx.newPage();
    await otherDevicePage.goto("/projects");

    const page = await openAccount(browser);
    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD);
    await page.waitForURL(/\/login/);

    const status = await otherDevicePage.evaluate(
      async () => (await fetch("/api/auth/me", { credentials: "include" })).status,
    );
    expect(status, "a different device's session should be signed out too").toBe(401);
  });

  // ─── Top bar user menu ──────────────────────────────────────────────────────

  /** Same disposable owner as the rest of this suite, landed on a page other than /account. */
  async function openProjects(browser: Browser): Promise<Page> {
    const state = await writeStorageState(tenant!.owner, `account-ui-owner-topbar-${contexts.length}`);
    const ctx = await browser.newContext({ storageState: state });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto("/projects");
    return page;
  }

  const userMenuTrigger = (page: Page) => page.getByRole("button", { name: "User menu" });
  const userMenu = (page: Page) => page.locator('[role="menu"][aria-label="User menu"]');

  test("ACU-16 the user menu opens on click and contains exactly Profile Settings, Theme, and Logout", { tag: '@tesbo.testId("TES-TC-1408")' }, async ({ browser }) => {
    const page = await openProjects(browser);

    await expect(userMenu(page)).toBeHidden();
    await userMenuTrigger(page).click();
    await expect(userMenu(page)).toBeVisible();

    await expect(userMenu(page).getByRole("menuitem", { name: "Profile Settings" })).toBeVisible();
    await expect(userMenu(page).getByText("Theme", { exact: true })).toBeVisible();
    await expect(userMenu(page).getByRole("button", { name: "Use light theme" })).toBeVisible();
    await expect(userMenu(page).getByRole("button", { name: "Use dark theme" })).toBeVisible();
    await expect(userMenu(page).getByRole("menuitem", { name: "Logout" })).toBeVisible();
    // Exactly the two navigational/action items — the theme switcher is deliberately not a
    // menuitem itself (it holds its own interactive buttons, which nested ARIA menuitems can't).
    await expect(userMenu(page).getByRole("menuitem")).toHaveCount(2);
  });

  test("ACU-17 the user menu closes on outside click and on Escape", { tag: '@tesbo.testId("TES-TC-1409")' }, async ({ browser }) => {
    const page = await openProjects(browser);

    await userMenuTrigger(page).click();
    await expect(userMenu(page)).toBeVisible();
    // Deep inside the main content area — clear of both the sidebar's own links and the menu
    // itself, so this is unambiguously an "outside" click rather than a navigation.
    await page.mouse.click(700, 400);
    await expect(userMenu(page)).toBeHidden();

    await userMenuTrigger(page).click();
    await expect(userMenu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(userMenu(page)).toBeHidden();
  });

  test("ACU-18 Profile Settings navigates to /account and closes the menu", { tag: '@tesbo.testId("TES-TC-1410")' }, async ({ browser }) => {
    const page = await openProjects(browser);

    await userMenuTrigger(page).click();
    await userMenu(page).getByRole("menuitem", { name: "Profile Settings" }).click();

    await page.waitForURL(/\/account$/);
    await expect(userMenu(page)).toBeHidden();
  });

  test("ACU-19 switching theme from the user menu applies dark mode and persists across reload", { tag: '@tesbo.testId("TES-TC-1411")' }, async ({ browser }) => {
    const page = await openProjects(browser);

    await userMenuTrigger(page).click();
    await userMenu(page).getByRole("button", { name: "Use dark theme" }).click();

    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(userMenu(page).getByRole("button", { name: "Use dark theme" })).toHaveAttribute("aria-pressed", "true");

    // The sidebar renders its own separate <ThemeToggle/> instance at the same time as the user
    // menu's — with no shared context between them, this only reflects the change if the two are
    // kept in sync (lib/theme.ts's THEME_CHANGE_EVENT), not just the instance that was clicked.
    const sidebarDarkButton = page.locator("aside").getByRole("button", { name: "Use dark theme" });
    await expect(sidebarDarkButton).toHaveAttribute("aria-pressed", "true");

    // Persists via the app's existing mechanism (localStorage), not a new one, and survives reload.
    const stored = await page.evaluate(() => window.localStorage.getItem("tesbo-theme"));
    expect(stored).toBe("dark");
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Leave it back on light so this disposable context doesn't affect anything reused later.
    await userMenuTrigger(page).click();
    await userMenu(page).getByRole("button", { name: "Use light theme" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("ACU-20 Logout from the user menu signs the session out and redirects to /login", { tag: '@tesbo.testId("TES-TC-1412")' }, async ({ browser }) => {
    const page = await openProjects(browser);

    await userMenuTrigger(page).click();
    await userMenu(page).getByRole("menuitem", { name: "Logout" }).click();

    await page.waitForURL(/\/login/);
    const status = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).status);
    expect(status, "the session should be invalidated server-side, not just redirected client-side").toBe(401);
  });
});
