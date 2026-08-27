import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/*
 * The "Connect Jira" OAuth flow at .../settings/integrations/jira — the new-tab redesign in
 * Tesbo-Frontend/lib/useIntegrationOAuthConnect.ts and Tesbo-Frontend/app/integrations/callback.
 *
 * Root cause this replaced: the flow used to be one same-tab navigation chain (Tesbo → Atlassian
 * consent → redirect back to our callback page), so the callback page's "Go Back" button
 * (`router.back()`) sent a failed connection back into the OAuth provider's own page instead of
 * into the app — the opposite of what it promised. The fix opens the flow in its own tab; the
 * original tab never navigates away and picks up the result on its own.
 *
 * ProjectIntegrationMapping.tsx (a project's Settings → Integrations tab) drives the identical
 * flow through the same shared hook and is not re-tested here.
 *
 * Real Atlassian/Linear consent screens can't be driven from Playwright — see
 * docs/e2e-coverage-waves.md for what that leaves out. Everything below runs against mocked
 * `/api/workspace/integrations/jira/*` responses instead, which is where Tesbo's own logic (popup
 * lifecycle, cross-tab pickup, error/cancel handling) actually lives — nothing here touches Jira
 * or account A's real connection row.
 */

const JIRA_SETTINGS_URL = "/settings/integrations/jira";
const MOCK_AUTHORIZE_URL = "https://example-oauth.invalid/authorize";

interface IntegrationMock {
  callbackCalls: number;
  connected: boolean;
}

/** Mocks the four endpoints this screen calls, entirely in-memory — no real Jira, no DB writes. */
async function mockIntegrationRoutes(
  context: BrowserContext,
  opts: { configured?: boolean; failCallback?: string } = {}
): Promise<IntegrationMock> {
  const state: IntegrationMock = { callbackCalls: 0, connected: false };

  await context.route("**/api/workspace/integrations/jira/config", (route) =>
    route.fulfill({
      json: { configured: opts.configured ?? true, clientId: "e2e-client-id", redirectUri: "http://localhost/integrations/callback" },
    })
  );

  await context.route("**/api/workspace/integrations/jira/status", (route) =>
    route.fulfill({ json: { connected: state.connected } })
  );

  await context.route("**/api/workspace/integrations/jira/auth-url", (route) =>
    route.fulfill({ json: { url: `${MOCK_AUTHORIZE_URL}?state=jira.e2e.sig` } })
  );

  await context.route("**/api/workspace/integrations/jira/callback", async (route) => {
    state.callbackCalls += 1;
    if (opts.failCallback) {
      await route.fulfill({ status: 400, json: { error: opts.failCallback } });
      return;
    }
    state.connected = true;
    await route.fulfill({ json: { connectionId: "e2e-connection", siteUrl: "https://e2e.atlassian.net" } });
  });

  // The popup navigates here first (standing in for the real Atlassian consent screen) so the
  // "opens in a new tab" assertion has something real to land on instead of a network error.
  await context.route(`${MOCK_AUTHORIZE_URL}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body><h1>Mock OAuth Consent</h1></body></html>" })
  );

  return state;
}

/**
 * Clicks Connect and returns the popup tab it opens, as soon as it exists. Deliberately does not
 * wait for it to finish navigating — window.open("", name) fires this event on the still-blank
 * tab, before the auth-url fetch resolves and the real navigation starts, and most tests below
 * immediately redirect this popup themselves (to the mocked callback URL) rather than waiting on
 * the mock authorize page it was headed to.
 */
async function clickConnectAndGetPopup(context: BrowserContext, page: Page): Promise<Page> {
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Connect Jira" }).click(),
  ]);
  return popup;
}

// Stands in for "the provider redirected back with a real code" — the mocked callback POST route
// decides success vs. failure, not this query string, so one constant covers both cases.
const CALLBACK_URL = "/integrations/callback?code=e2e-code&state=jira.e2e.sig";

test.describe("Jira integration — Connect flow (UI)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(JIRA_SETTINGS_URL);
    await expect(page.getByRole("heading", { name: "Jira Integration" })).toBeVisible();
  });

  test("INT-U-01 opens the OAuth flow in a new tab and disables Connect while waiting", async ({ page, context }) => {
    await mockIntegrationRoutes(context);

    const originalUrl = page.url();
    const popup = await clickConnectAndGetPopup(context, page);
    await popup.waitForURL(/example-oauth\.invalid/);

    // The tab that triggered the flow never navigates away.
    expect(page.url()).toBe(originalUrl);
    expect(popup.url()).toContain("example-oauth.invalid");

    // And it can't be clicked again mid-flow — the primary defense against a double-click race.
    const button = page.getByRole("button", { name: /Waiting for you to finish in the new tab/ });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();

    await popup.close();
  });

  test("INT-U-02 a blocked popup shows an actionable inline error, not a same-tab redirect", async ({ page, context }) => {
    await mockIntegrationRoutes(context);
    // Simulate the browser's popup blocker: window.open returns null.
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.reload();

    const originalUrl = page.url();
    await page.getByRole("button", { name: "Connect Jira" }).click();

    await expect(page.getByText(/browser blocked the popup/i)).toBeVisible();
    // No same-tab fallback navigation — that would reintroduce the bug being fixed.
    expect(page.url()).toBe(originalUrl);
    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeEnabled();
  });

  test("INT-U-03 a successful connection in the popup is picked up by the original tab automatically", async ({ page, context }) => {
    const mock = await mockIntegrationRoutes(context);
    const popup = await clickConnectAndGetPopup(context, page);

    await popup.goto(CALLBACK_URL);
    await expect(popup.getByRole("heading", { name: "Jira connected to Tesbo" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Return to Tesbo" })).toBeVisible();

    // No manual reload on the original tab — it notices on its own (broadcast, confirmed by a
    // status refetch rather than trusted directly).
    await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible({ timeout: 10_000 });
    expect(mock.callbackCalls).toBe(1);
  });

  test("INT-U-04 closing the popup without finishing is a silent cancel, not an error", async ({ page, context }) => {
    await mockIntegrationRoutes(context);
    const popup = await clickConnectAndGetPopup(context, page);

    await popup.close();

    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeEnabled();
    await expect(page.getByText(/failed|error/i)).toHaveCount(0);
  });

  test("INT-U-05 a success the popup never broadcasts is still caught when the popup closes", async ({ page, context }) => {
    // Proves the close-triggered confirm-poll, independent of the BroadcastChannel fast path:
    // the callback tab succeeds and auto-closes, but with BroadcastChannel unavailable on that
    // tab, only the opener's popup-closed handler can notice.
    const mock = await mockIntegrationRoutes(context);
    const popup = await clickConnectAndGetPopup(context, page);
    await popup.addInitScript(() => {
      // @ts-expect-error — deliberately removing it for this page only
      delete window.BroadcastChannel;
    });

    await popup.goto(CALLBACK_URL);
    await expect(popup.getByRole("heading", { name: "Jira connected to Tesbo" })).toBeVisible();
    await popup.close();

    await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible({ timeout: 10_000 });
    expect(mock.callbackCalls).toBe(1);
  });

  test("INT-U-06 a failed connection shows the reason and offers Try Again — no dead-end back button", async ({ page, context }) => {
    await mockIntegrationRoutes(context, { failCallback: "Jira did not return OAuth tokens." });
    const popup = await clickConnectAndGetPopup(context, page);

    await popup.goto(CALLBACK_URL);
    await expect(popup.getByRole("heading", { name: "Connection Failed" })).toBeVisible();
    await expect(popup.getByText("Jira did not return OAuth tokens.")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Try Again" })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Close this tab" })).toBeVisible();
    // The literal regression: no button routes back into the OAuth provider's own page.
    await expect(popup.getByRole("button", { name: /go back/i })).toHaveCount(0);

    await Promise.all([popup.waitForEvent("close"), popup.getByRole("button", { name: "Close this tab" }).click()]);

    // The specific failure was already shown (and dismissed) in the now-closed tab — the
    // original tab just goes back to idle, it doesn't repeat the error.
    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeVisible({ timeout: 10_000 });
  });
});
