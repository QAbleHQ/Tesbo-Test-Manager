import path from "node:path";
import { expect, request as pwRequest, test, type BrowserContext, type Page } from "@playwright/test";
import { env } from "../utils/env";

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
  disconnectCalls: number;
}

/** Mocks the four endpoints this screen calls, entirely in-memory — no real Jira, no DB writes. */
async function mockIntegrationRoutes(
  context: BrowserContext,
  opts: { configured?: boolean; failCallback?: string; connectedInitially?: boolean; disconnectDelayMs?: number } = {}
): Promise<IntegrationMock> {
  const state: IntegrationMock = { callbackCalls: 0, connected: opts.connectedInitially ?? false, disconnectCalls: 0 };

  await context.route("**/api/workspace/integrations/jira/disconnect", async (route) => {
    state.disconnectCalls += 1;
    // A real disconnect isn't instant (advisory lock + the Knowledge Base cleanup, per
    // legacy.service.ts's integrationDisconnect) — the delay gives a rapid double-click a real
    // window to fire a second request before React's state update disables the button.
    if (opts.disconnectDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.disconnectDelayMs));
    state.connected = false;
    await route.fulfill({ json: { disconnected: true } });
  });

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

/*
 * Disconnect — regression coverage for the fast-double-click race handleDisconnect's synchronous
 * guard exists for (see WorkspaceIntegrationConfig.tsx): React's `disabled={disconnecting}` only
 * takes effect on the next render, so two clicks landing before that render both used to reach
 * `disconnectIntegration()`. What that disconnect call does server-side (soft-deleting the Jira/
 * Linear Knowledge Base folder, never restorable, never a hard delete) is covered in
 * e2e/api/integrations.spec.ts (INT-A-43..51) — this file only drives the button itself.
 */
test.describe("Jira integration — Disconnect (UI)", () => {
  test("INT-U-07 a rapid double-click on Disconnect fires exactly one request and the page still settles", async ({ page, context }) => {
    const mock = await mockIntegrationRoutes(context, { connectedInitially: true, disconnectDelayMs: 300 });
    await page.goto(JIRA_SETTINGS_URL);
    await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();

    const button = page.getByRole("button", { name: "Disconnect Jira" });
    await expect(button).toBeEnabled();
    // Two native clicks dispatched synchronously in the page's own JS, before Playwright hands
    // control back — this is what a real fast double-click looks like from the browser's side:
    // both fire before React's re-render has a chance to add the `disabled` attribute. A plain
    // second Playwright `.click()` would instead wait for the button to become actionable again,
    // which defeats the point of this test.
    await button.evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });

    await expect(page.getByRole("heading", { name: "Connect Jira" })).toBeVisible({ timeout: 10_000 });
    expect(mock.disconnectCalls, "the synchronous guard must stop the second click before it ever reaches the network").toBe(1);
    // Not left disabled/stuck once settled.
    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeEnabled();
  });

  test("INT-U-08 disconnecting from two tabs at once never gets stuck or shows an error in either", async ({ page, context }) => {
    // The backend's advisory-lock idempotency (legacy.service.ts's integrationDisconnect) means a
    // second disconnect for the same workspace+provider — the loser of the race between two open
    // tabs — always answers success too, never an error; this mock mirrors that by always
    // fulfilling regardless of current state, the same way the real route does.
    const mock = await mockIntegrationRoutes(context, { connectedInitially: true, disconnectDelayMs: 200 });
    const pageB = await context.newPage();

    await Promise.all([
      page.goto(JIRA_SETTINGS_URL),
      pageB.goto(JIRA_SETTINGS_URL),
    ]);
    await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "Connected" })).toBeVisible();

    await Promise.all([
      page.getByRole("button", { name: "Disconnect Jira" }).click(),
      pageB.getByRole("button", { name: "Disconnect Jira" }).click(),
    ]);

    await expect(page.getByRole("heading", { name: "Connect Jira" })).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByRole("heading", { name: "Connect Jira" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/failed|error/i)).toHaveCount(0);
    await expect(pageB.getByText(/failed|error/i)).toHaveCount(0);
    expect(mock.disconnectCalls).toBe(2);

    await pageB.close();
  });
});

/*
 * Regression: the project-level Jira integration page has a "Jira + AI Generation" settings
 * section with an "Auto-comment on Jira ticket" checkbox, persisted into the project's own
 * `settings` JSON blob. Linear's equivalent page had no such section at all — not a missing
 * backend capability (settings storage, the read/write API, and the `settingsPanel` slot on the
 * shared ProjectIntegrationMapping are all already provider-generic), just a component that was
 * never built and wired in for Linear.
 *
 * IntegrationAiGenerationSettings.tsx is the single component behind both providers' pages —
 * keyed dynamically off its `provider` prop (`project.settings.${provider}AutoComment`) rather
 * than a hardcoded Jira file and a hardcoded Linear file — so the two providers' settings persist
 * independently on a project that has both linked.
 *
 * The workspace-level OAuth connection can't be driven for real here (see this file's own header
 * comment), so `.../status` and `.../teams`/`.../projects` are mocked just enough to get past
 * ProjectIntegrationMapping's "not connected" early return — everything below that point (the
 * settings panel itself) talks to the real backend via getProject/updateProject, same as
 * projects.spec.ts's other project-settings coverage.
 */
test.describe("Jira/Linear + AI Generation project settings", () => {
  function apiContext() {
    return pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: path.join(__dirname, "../.auth/state.json") });
  }

  async function createProject(api: Awaited<ReturnType<typeof apiContext>>, label: string): Promise<string> {
    const suffix = Date.now().toString().slice(-8);
    const created = await (
      await api.post("/api/projects", { data: { name: `${label} ${suffix}`, key: `E2E${label.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 5)}${suffix}` } })
    ).json();
    return created.id;
  }

  /** Stands in for a real OAuth connection so ProjectIntegrationMapping renders its connected
   *  state (and therefore the settingsPanel below it) instead of the "not connected" screen. */
  async function mockConnected(context: BrowserContext, projectId: string, provider: "jira" | "linear") {
    const remotePath = provider === "jira" ? "projects" : "teams";
    await context.route(`**/api/projects/${projectId}/${provider}/status`, (route) =>
      route.fulfill({ json: { connected: true, siteUrl: `https://e2e.${provider}.invalid` } })
    );
    await context.route(`**/api/projects/${projectId}/${provider}/${remotePath}`, (route) => route.fulfill({ json: [] }));
  }

  test("the Linear integration page shows a 'Linear + AI Generation' section with an Auto-comment checkbox, matching Jira's", { tag: '@tesbo.testId("TES-TC-2070")' }, async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Linear AI Gen Parity");
      await mockConnected(context, projectId, "linear");

      await page.goto(`/projects/${projectId}/settings/integrations/linear`);
      await expect(page.getByRole("heading", { name: "Linear + AI Generation" })).toBeVisible();

      const autoComment = page.getByRole("checkbox", { name: /Auto-comment on Linear ticket/ });
      await expect(autoComment).toBeVisible();
      await expect(autoComment).not.toBeChecked();
      // The ticket-selector checkbox was deliberately dropped from both providers — never shipped.
      await expect(page.getByText("ticket selector", { exact: false })).toHaveCount(0);
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("saving Linear's Auto-comment setting persists independently of Jira's on the same project", { tag: '@tesbo.testId("TES-TC-2071")' }, async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Both AI Gen Settings");
      await mockConnected(context, projectId, "jira");
      await mockConnected(context, projectId, "linear");

      // Jira: turn Auto-comment ON.
      await page.goto(`/projects/${projectId}/settings/integrations/jira`);
      await page.getByRole("checkbox", { name: /Auto-comment on Jira ticket/ }).check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Jira settings saved.")).toBeVisible();

      // Linear: leave Auto-comment OFF — the opposite of Jira's, so a bug that wrote both
      // providers' settings under the same key (or clobbered the other provider's half of the
      // blob on save) would show up as a wrong combination below.
      const fetched = await (await api.get(`/api/projects/${projectId}`)).json();
      const settings = typeof fetched.settings === "string" ? JSON.parse(fetched.settings) : fetched.settings || {};
      expect(settings.jiraAutoComment).toBe(true);
      expect(settings.linearAutoComment).toBeFalsy();

      // Reload and confirm both panels read their own state back correctly, independently.
      await page.goto(`/projects/${projectId}/settings/integrations/linear`);
      await expect(page.getByRole("checkbox", { name: /Auto-comment on Linear ticket/ })).not.toBeChecked();

      await page.goto(`/projects/${projectId}/settings/integrations/jira`);
      await expect(page.getByRole("checkbox", { name: /Auto-comment on Jira ticket/ })).toBeChecked();
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});
