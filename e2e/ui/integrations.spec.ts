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
 * Notion (INT-U-09 and up) is covered by the blocks at the end of this file, against mocked Notion routes.
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

/*
 * Notion: the same screens as Jira and Linear, driven the same way. Notion's workspace-level
 * `/api/workspace/integrations/notion/*` and project-level `/api/projects/:id/notion/*` responses are
 * mocked, because a real Notion consent screen and a real database picker cannot be driven from
 * Playwright (api.notion.com is compiled in; see docs/e2e-coverage-waves.md). What is under test is
 * Tesbo's own logic: which card shows what, the popup lifecycle, error surfacing, the exact body the
 * picker saves, and settings persistence, which goes to the real backend where it can.
 *
 * Locators come from the final screens: IntegrationsTab.tsx (`integration-card-*`, `integration-
 * configure-*`, `integration-manage-*`, `integration-disconnect-*`, `integration-upgrade-*`),
 * WorkspaceIntegrationConfig.tsx, ProjectIntegrationMapping.tsx (`remote-item`, `remote-items-empty`),
 * the project settings Integrations tab (`notion-project-card`, `notion-project-cta`,
 * `notion-project-settings-link`) and app/integrations/callback/page.tsx.
 *
 * What the screens do NOT have, and so is not asserted: a confirmation step before Disconnect (both
 * the Integrations tab and the Notion page call disconnect on the first click), exactly like Jira.
 */

const NOTION_SETTINGS_URL = "/settings/integrations/notion";
const NOTION_CALLBACK_URL = "/integrations/callback?code=e2e-code&state=notion.e2e.sig";

interface NotionWorkspaceMock {
  callbackCalls: number;
  callbackBodies: Array<{ code?: string; state?: string }>;
  disconnectCalls: number;
  otherProviderDisconnectCalls: number;
  connected: boolean;
}

/** Mocks the five workspace endpoints for Notion, in memory only: no real Notion, no DB writes. */
async function mockNotionWorkspaceRoutes(
  context: BrowserContext,
  opts: {
    configured?: boolean;
    connectedInitially?: boolean;
    failCallback?: string;
    disconnectDelayMs?: number;
    /** Merged over the connected status body, e.g. needsReconnect. */
    statusExtra?: Record<string, unknown>;
  } = {}
): Promise<NotionWorkspaceMock> {
  const state: NotionWorkspaceMock = {
    callbackCalls: 0,
    callbackBodies: [],
    disconnectCalls: 0,
    otherProviderDisconnectCalls: 0,
    connected: opts.connectedInitially ?? false,
  };

  await context.route("**/api/workspace/integrations/notion/disconnect", async (route) => {
    state.disconnectCalls += 1;
    if (opts.disconnectDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.disconnectDelayMs));
    state.connected = false;
    await route.fulfill({ json: { disconnected: true } });
  });
  // Any other provider's disconnect during a Notion test is a defect: counted, never expected.
  for (const other of ["jira", "linear"]) {
    await context.route(`**/api/workspace/integrations/${other}/disconnect`, async (route) => {
      state.otherProviderDisconnectCalls += 1;
      await route.fulfill({ json: { disconnected: true } });
    });
  }

  await context.route("**/api/workspace/integrations/notion/config", (route) =>
    route.fulfill({
      json: { configured: opts.configured ?? true, clientId: "e2e-notion-client-id", redirectUri: "http://localhost/integrations/callback" },
    })
  );

  await context.route("**/api/workspace/integrations/notion/status", (route) =>
    route.fulfill({
      json: state.connected
        ? {
            connected: true,
            siteUrl: "https://www.notion.so",
            needsReconnect: false,
            authError: null,
            connectedProjects: [{ projectId: "e2e-project", projectName: "E2E Project", projectKey: "E2EK" }],
            ...(opts.statusExtra ?? {}),
          }
        : { connected: false, connectedProjects: [] },
    })
  );

  await context.route("**/api/workspace/integrations/notion/auth-url", (route) =>
    route.fulfill({ json: { url: `${MOCK_AUTHORIZE_URL}?state=notion.e2e.sig` } })
  );

  await context.route("**/api/workspace/integrations/notion/callback", async (route) => {
    state.callbackCalls += 1;
    state.callbackBodies.push(route.request().postDataJSON());
    if (opts.failCallback) {
      await route.fulfill({ status: 400, json: { error: opts.failCallback } });
      return;
    }
    state.connected = true;
    await route.fulfill({ json: { connectionId: "e2e-connection", siteUrl: "https://www.notion.so", workspaceName: "E2E Workspace" } });
  });

  await context.route(`${MOCK_AUTHORIZE_URL}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body><h1>Mock OAuth Consent</h1></body></html>" })
  );

  return state;
}

async function clickConnectNotionAndGetPopup(context: BrowserContext, page: Page): Promise<Page> {
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Connect Notion" }).click(),
  ]);
  return popup;
}

test.describe("Notion integration: workspace Integrations tab (UI)", () => {
  const TAB_URL = "/settings?tab=integrations";

  /** Mocks all three providers' workspace status plus the plan, so the card states are deterministic. */
  async function mockTab(
    context: BrowserContext,
    opts: {
      plan?: "launch" | "pro";
      notion?: Record<string, unknown>;
      jira?: Record<string, unknown>;
      linear?: Record<string, unknown>;
    } = {}
  ) {
    const calls = { disconnect: [] as string[] };
    await context.route("**/api/billing", (route) =>
      route.fulfill({
        json: {
          plan: opts.plan ?? "pro",
          billingInterval: null,
          status: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          paymentFailedAt: null,
          graceEndsAt: null,
          inGracePeriod: false,
          limitsEnforced: false,
        },
      })
    );
    const bodies = { jira: opts.jira ?? { connected: false }, linear: opts.linear ?? { connected: false }, notion: opts.notion ?? { connected: false } };
    for (const provider of ["jira", "linear", "notion"] as const) {
      await context.route(`**/api/workspace/integrations/${provider}/status`, (route) => route.fulfill({ json: bodies[provider] }));
      await context.route(`**/api/workspace/integrations/${provider}/disconnect`, async (route) => {
        calls.disconnect.push(provider);
        bodies[provider] = { connected: false };
        await route.fulfill({ json: { disconnected: true } });
      });
    }
    return calls;
  }

  test("INT-U-09 the Notion card is open to a Launch workspace with no Pro lock, while Linear shows its lock", async ({ page, context }) => {
    await mockTab(context, { plan: "launch" });
    await page.goto(TAB_URL);

    const notion = page.getByTestId("integration-card-notion");
    await expect(notion).toBeVisible();
    await expect(notion.getByRole("heading", { name: "Notion" })).toBeVisible();
    // The plan allow-list is {jira, notion}: no badge, no upgrade button, a normal Configure entry.
    await expect(notion.getByText("Requires Pro")).toHaveCount(0);
    await expect(page.getByTestId("integration-upgrade-notion")).toHaveCount(0);
    const configure = page.getByTestId("integration-configure-notion");
    await expect(configure).toBeVisible();
    await expect(configure).toHaveAttribute("href", "/settings/integrations/notion");
    // Not connected: nothing claims it is.
    await expect(notion.getByText("Connected", { exact: true })).toHaveCount(0);

    // Regression: Jira stays open and Linear stays locked on the same plan.
    await expect(page.getByTestId("integration-card-jira").getByText("Requires Pro")).toHaveCount(0);
    await expect(page.getByTestId("integration-configure-jira")).toBeVisible();
    await expect(page.getByTestId("integration-card-linear").getByText("Requires Pro")).toBeVisible();
    await expect(page.getByTestId("integration-upgrade-linear")).toBeVisible();

    await configure.click();
    await expect(page).toHaveURL(/\/settings\/integrations\/notion$/);
    await expect(page.getByRole("heading", { name: "Notion Integration" })).toBeVisible();
  });

  test("INT-U-10 a connected Notion card shows its site, how many projects use it, and Manage, without touching Jira or Linear", async ({ page, context }) => {
    await mockTab(context, {
      plan: "launch",
      notion: {
        connected: true,
        siteUrl: "https://www.notion.so",
        connectedProjects: [{ projectId: "p1", projectName: "Checkout", projectKey: "CHK" }],
      },
    });
    await page.goto(TAB_URL);

    const notion = page.getByTestId("integration-card-notion");
    await expect(notion.getByText("Connected", { exact: true })).toBeVisible();
    await expect(notion.getByRole("link", { name: "https://www.notion.so" })).toHaveAttribute("href", "https://www.notion.so");
    await expect(notion.getByText("Used by 1 project: CHK")).toBeVisible();
    await expect(page.getByTestId("integration-manage-notion")).toHaveAttribute("href", "/settings/integrations/notion");
    await expect(page.getByTestId("integration-disconnect-notion")).toBeEnabled();
    // Connected replaces Configure; it does not sit beside it.
    await expect(page.getByTestId("integration-configure-notion")).toHaveCount(0);

    // Jira's card is unaffected by Notion being connected.
    const jira = page.getByTestId("integration-card-jira");
    await expect(jira.getByText("Connected", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("integration-configure-jira")).toBeVisible();
  });

  test("INT-U-11 disconnecting Notion from the tab calls only Notion's route, then offers Configure again", async ({ page, context }) => {
    const calls = await mockTab(context, {
      notion: { connected: true, siteUrl: "https://www.notion.so", connectedProjects: [] },
      jira: { connected: true, siteUrl: "https://e2e.atlassian.invalid", connectedProjects: [] },
    });
    await page.goto(TAB_URL);
    await expect(page.getByTestId("integration-card-notion").getByText("Connected", { exact: true })).toBeVisible();

    await page.getByTestId("integration-disconnect-notion").click();

    await expect(page.getByText("Notion disconnected.")).toBeVisible();
    await expect(page.getByTestId("integration-configure-notion")).toBeVisible();
    await expect(page.getByTestId("integration-disconnect-notion")).toHaveCount(0);
    expect(calls.disconnect, "only the Notion disconnect route may be called").toEqual(["notion"]);
    // Jira is still connected, untouched.
    await expect(page.getByTestId("integration-card-jira").getByText("Connected", { exact: true })).toBeVisible();
  });
});

test.describe("Notion integration: workspace connect flow (UI)", () => {
  test("INT-U-12 Connect Notion opens the authorize URL in a new tab and disables the button while waiting", async ({ page, context }) => {
    await mockNotionWorkspaceRoutes(context);
    await page.goto(NOTION_SETTINGS_URL);
    await expect(page.getByRole("heading", { name: "Notion Integration" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connect Notion" })).toBeVisible();

    const originalUrl = page.url();
    const popup = await clickConnectNotionAndGetPopup(context, page);
    await popup.waitForURL(/example-oauth\.invalid/);

    // The authorize URL the popup lands on is the one the backend's auth-url answered (with its state).
    expect(popup.url()).toContain("state=notion.e2e.sig");
    expect(page.url()).toBe(originalUrl);
    const waiting = page.getByRole("button", { name: /Waiting for you to finish in the new tab/ });
    await expect(waiting).toBeVisible();
    await expect(waiting).toBeDisabled();

    await popup.close();
    // Closing without finishing is a silent cancel, not an error.
    await expect(page.getByRole("button", { name: "Connect Notion" })).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByText(/failed|error/i)).toHaveCount(0);
  });

  test("INT-U-13 a deployment with no Notion OAuth app says which variables to set and offers no Connect button", async ({ page, context }) => {
    await mockNotionWorkspaceRoutes(context, { configured: false });
    await page.goto(NOTION_SETTINGS_URL);

    await expect(page.getByText("Notion isn't set up on this deployment yet.")).toBeVisible();
    await expect(page.getByText("NOTION_CLIENT_ID", { exact: true })).toBeVisible();
    await expect(page.getByText("NOTION_CLIENT_SECRET", { exact: true })).toBeVisible();
    await expect(page.getByText("http://localhost/integrations/callback")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Notion" })).toHaveCount(0);
  });

  test("INT-U-14 a connected Notion page shows its site and projects, and a rapid double-click on Disconnect fires one request", async ({ page, context }) => {
    const mock = await mockNotionWorkspaceRoutes(context, { connectedInitially: true, disconnectDelayMs: 300 });
    await page.goto(NOTION_SETTINGS_URL);

    await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();
    await expect(page.getByRole("link", { name: "https://www.notion.so" })).toBeVisible();
    await expect(page.getByText("1 project(s) currently map to this Notion connection.")).toBeVisible();
    await expect(page.getByText("E2EK")).toBeVisible();
    await expect(page.getByText(/Notion database feeds a Tesbo project/)).toBeVisible();

    const button = page.getByRole("button", { name: "Disconnect Notion" });
    await expect(button).toBeEnabled();
    // Two native clicks in the page's own JS, before React can disable the button (see INT-U-07).
    await button.evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });

    await expect(page.getByRole("heading", { name: "Connect Notion" })).toBeVisible({ timeout: 10_000 });
    expect(mock.disconnectCalls).toBe(1);
    expect(mock.otherProviderDisconnectCalls).toBe(0);
    await expect(page.getByText("Notion disconnected.")).toBeVisible();
  });

  test("INT-U-15 a connection that needs reconnecting shows a warning with the reason, on the workspace page", async ({ page, context }) => {
    await mockNotionWorkspaceRoutes(context, {
      connectedInitially: true,
      statusExtra: { needsReconnect: true, authError: "Notion rejected this workspace's token." },
    });
    await page.goto(NOTION_SETTINGS_URL);

    const alert = page.getByRole("alert").filter({ hasText: "needs to be reconnected" });
    await expect(alert).toBeVisible();
    await expect(alert.getByText("Notion needs to be reconnected")).toBeVisible();
    await expect(alert.getByText("Notion rejected this workspace's token.")).toBeVisible();
    // The way out is on the same page.
    await expect(page.getByRole("button", { name: "Disconnect Notion" })).toBeEnabled();
  });
});

test.describe("Notion integration: OAuth callback page (UI)", () => {
  test("INT-U-16 a successful Notion callback posts the code and signed state to Notion's route and says Notion connected", async ({ page, context }) => {
    const mock = await mockNotionWorkspaceRoutes(context);
    await page.goto(NOTION_CALLBACK_URL);

    await expect(page.getByRole("heading", { name: "Notion connected to Tesbo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to Tesbo" })).toBeVisible();
    expect(mock.callbackCalls).toBe(1);
    // The state goes back verbatim: the backend verifies it, the page must not rewrite it.
    expect(mock.callbackBodies[0]).toEqual({ code: "e2e-code", state: "notion.e2e.sig" });
  });

  test("INT-U-17 a denied consent screen (error param, no code) is reported without calling the backend", async ({ page, context }) => {
    const mock = await mockNotionWorkspaceRoutes(context);
    // What Notion redirects to when the user cancels: ?error=access_denied, no code.
    await page.goto("/integrations/callback?error=access_denied&state=notion.e2e.sig");

    await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible();
    await expect(page.getByText("Notion authorization was denied or failed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
    await expect(page.getByRole("button", { name: /go back/i })).toHaveCount(0);
    expect(mock.callbackCalls, "a denied authorization must not burn a token exchange").toBe(0);
  });

  test("INT-U-18 a server-side rejection of the Notion callback shows the server's message", async ({ page, context }) => {
    const mock = await mockNotionWorkspaceRoutes(context, {
      failCallback: "Notion did not accept the authorization code. Start the connection again.",
    });
    await page.goto(NOTION_CALLBACK_URL);

    await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible();
    await expect(page.getByText("Notion did not accept the authorization code. Start the connection again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try Again" })).toBeVisible();
    expect(mock.callbackCalls).toBe(1);
  });

  test("INT-U-19 a callback with no code, or a state naming no known provider, never calls the backend", async ({ page, context }) => {
    const mock = await mockNotionWorkspaceRoutes(context);

    await page.goto("/integrations/callback?state=notion.e2e.sig");
    await expect(page.getByText("Missing authorization code or integration context.")).toBeVisible();

    await page.goto("/integrations/callback?code=e2e-code&state=bogus.e2e.sig");
    await expect(page.getByText("Missing authorization code or integration context.")).toBeVisible();
    // No provider means no Try Again: there is nothing to restart.
    await expect(page.getByRole("button", { name: "Try Again" })).toHaveCount(0);
    expect(mock.callbackCalls).toBe(0);
  });
});

test.describe("Notion integration: project screens (UI)", () => {
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

  const DB_PRODUCT = { id: "11111111-1111-1111-1111-111111111111", name: "Product Specs", url: "https://www.notion.so/product", connected: false };
  const DB_ROADMAP = { id: "22222222-2222-2222-2222-222222222222", name: "Roadmap", url: "https://www.notion.so/roadmap", connected: false };

  interface ProjectMock {
    saves: Array<Record<string, unknown>>;
    syncCalls: number;
  }

  /** Mocks the project-level Notion endpoints. GET and POST share the databases URL, split by method. */
  async function mockNotionProject(
    context: BrowserContext,
    projectId: string,
    opts: {
      status?: Record<string, unknown>;
      databases?: Array<typeof DB_PRODUCT>;
      saveError?: { status: number; error: string };
      syncError?: { status: number; error: string };
    } = {}
  ): Promise<ProjectMock> {
    const state: ProjectMock = { saves: [], syncCalls: 0 };
    await context.route(`**/api/projects/${projectId}/notion/status`, (route) =>
      route.fulfill({
        json: opts.status ?? { connected: true, siteUrl: "https://www.notion.so", needsReconnect: false, authError: null, connectedProjects: [], history: [] },
      })
    );
    await context.route(`**/api/projects/${projectId}/notion/databases`, async (route) => {
      if (route.request().method() === "POST") {
        state.saves.push(route.request().postDataJSON());
        if (opts.saveError) {
          await route.fulfill({ status: opts.saveError.status, json: { error: opts.saveError.error } });
          return;
        }
        await route.fulfill({ json: { linked: 1 } });
        return;
      }
      await route.fulfill({ json: opts.databases ?? [] });
    });
    await context.route(`**/api/projects/${projectId}/notion/sync`, async (route) => {
      state.syncCalls += 1;
      if (opts.syncError) {
        await route.fulfill({ status: opts.syncError.status, json: { error: opts.syncError.error } });
        return;
      }
      await route.fulfill({ json: { run: null, alreadyRunning: false } });
    });
    await context.route(`**/api/projects/${projectId}/integrations/notion/sync-status`, (route) => route.fulfill({ json: { run: null } }));
    return state;
  }

  test("INT-U-20 the project's Integrations tab shows Notion connected with its gear link, or a Connect-in-Workspace-Settings CTA", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Card");
      await mockNotionProject(context, projectId, {
        status: {
          connected: true,
          siteUrl: "https://www.notion.so",
          needsReconnect: false,
          connectedProjects: [{ id: "m1", notionDatabaseId: DB_ROADMAP.id, notionDatabaseName: "Roadmap", createdAt: new Date().toISOString() }],
          history: [],
        },
      });
      // Pin the neighbours' state so the regression half does not depend on what account A has connected.
      for (const provider of ["jira", "linear"]) {
        await context.route(`**/api/projects/${projectId}/${provider}/status`, (route) =>
          route.fulfill({ json: { connected: false, connectedProjects: [], history: [] } })
        );
      }
      await page.goto(`/projects/${projectId}/settings?tab=integrations`);

      const card = page.getByTestId("notion-project-card");
      await expect(card).toBeVisible();
      await expect(card.getByText("Workspace connected")).toBeVisible();
      await expect(card.getByText("Notion database linked to this project: Roadmap")).toBeVisible();
      const gear = page.getByTestId("notion-project-settings-link");
      await expect(gear).toHaveAttribute("href", `/projects/${projectId}/settings/integrations/notion`);
      await expect(page.getByTestId("notion-project-cta")).toHaveCount(0);

      // Regression: Jira and Linear cards are still on the page, each with their own entry.
      await expect(page.getByRole("heading", { name: "Jira", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Linear", exact: true })).toBeVisible();
      await expect(page.getByTestId("linear-project-cta")).toBeVisible();
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-21 with Notion not connected the project card sends the user to Workspace Settings, and a reconnect warning shows when needed", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Disc");
      await mockNotionProject(context, projectId, { status: { connected: false, connectedProjects: [], history: [] } });
      await page.goto(`/projects/${projectId}/settings?tab=integrations`);

      const card = page.getByTestId("notion-project-card");
      await expect(card.getByText("Not connected for this workspace yet.")).toBeVisible();
      const cta = page.getByTestId("notion-project-cta");
      await expect(cta).toHaveText("Connect in Workspace Settings");
      await expect(cta).toHaveAttribute("href", "/settings/integrations/notion");
      await expect(page.getByTestId("notion-project-settings-link")).toHaveCount(0);
      // Never an upgrade prompt: Notion is on every plan.
      await expect(card.getByText(/Upgrade to Pro|Pro plan/)).toHaveCount(0);

      // Connected but needing a reconnect: the card says so.
      await context.unroute(`**/api/projects/${projectId}/notion/status`);
      await context.route(`**/api/projects/${projectId}/notion/status`, (route) =>
        route.fulfill({ json: { connected: true, needsReconnect: true, authError: "revoked", connectedProjects: [], history: [] } })
      );
      await page.reload();
      await expect(page.getByTestId("notion-project-card").getByText("Needs to be reconnected in Workspace Settings.")).toBeVisible();
      await expect(page.getByTestId("notion-project-card").getByText("No Notion database linked to this project yet.")).toBeVisible();
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-22 a workspace with nothing shared with Tesbo shows the share-with-integration guidance and cannot save", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Empty");
      const mock = await mockNotionProject(context, projectId, { databases: [] });
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);

      await expect(page.getByRole("heading", { name: "Notion Integration" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Select a Notion database" })).toBeVisible();
      const empty = page.getByTestId("remote-items-empty");
      await expect(empty.getByText("No databases are shared with Tesbo yet.")).toBeVisible();
      await expect(empty.getByText(/Connections/)).toBeVisible();
      await expect(empty.getByRole("link", { name: "Workspace Settings" })).toHaveAttribute("href", "/settings/integrations/notion");
      await expect(page.getByTestId("remote-item")).toHaveCount(0);
      // Nothing to select, so nothing to save, and nothing was sent.
      await expect(page.getByRole("button", { name: "Link Notion database" })).toBeDisabled();
      expect(mock.saves).toEqual([]);
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-23 picking a shared database saves exactly { databaseId, databaseName } and reports it linked", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Pick");
      const mock = await mockNotionProject(context, projectId, { databases: [DB_PRODUCT, DB_ROADMAP] });
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);

      await expect(page.getByTestId("remote-item")).toHaveCount(2);
      const save = page.getByRole("button", { name: "Link Notion database" });
      await expect(save).toBeDisabled();

      await page.getByRole("radio", { name: /Roadmap/ }).check();
      await expect(save).toBeEnabled();
      await save.click();

      await expect(page.getByText("Roadmap linked to this project.")).toBeVisible();
      // The request body is the whole contract with POST /notion/databases: no key, no extras.
      expect(mock.saves).toEqual([{ databaseId: DB_ROADMAP.id, databaseName: "Roadmap" }]);
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-24 an already-linked database is preselected, and the sync card appears only once a database is linked", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Linked");
      const mock = await mockNotionProject(context, projectId, {
        databases: [DB_PRODUCT, { ...DB_ROADMAP, connected: true }],
        status: {
          connected: true,
          siteUrl: "https://www.notion.so",
          connectedProjects: [{ id: "m1", notionDatabaseId: DB_ROADMAP.id, notionDatabaseName: "Roadmap", createdAt: new Date().toISOString() }],
          history: [],
        },
        syncError: { status: 400, error: "Notion could not be reached. Try again in a moment." },
      });
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);

      await expect(page.getByRole("radio", { name: /Roadmap/ })).toBeChecked();
      await expect(page.getByRole("radio", { name: /Product Specs/ })).not.toBeChecked();
      await expect(page.getByRole("heading", { name: "Sync Pages" })).toBeVisible();

      // A failed sync start shows the server's reason and leaves Sync Now usable.
      await page.getByRole("button", { name: "Sync Now" }).click();
      await expect(page.getByText("Notion could not be reached. Try again in a moment.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sync Now" })).toBeEnabled();
      expect(mock.syncCalls).toBe(1);

      // Clearing the selection turns Link into a no-op: it cannot be saved with nothing chosen.
      await page.getByRole("button", { name: "Clear selection" }).click();
      await expect(page.getByRole("button", { name: "Link Notion database" })).toBeDisabled();
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-25 a 'not shared' error from saving surfaces the server's message and leaves the page usable", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Err");
      const message = "Notion could not find that database. Share it with the Tesbo integration in Notion, then try again.";
      const mock = await mockNotionProject(context, projectId, { databases: [DB_PRODUCT], saveError: { status: 400, error: message } });
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);

      await page.getByRole("radio", { name: /Product Specs/ }).check();
      await page.getByRole("button", { name: "Link Notion database" }).click();

      await expect(page.getByText(message)).toBeVisible();
      // Not reported as linked, and not stuck on "Saving…".
      await expect(page.getByText("linked to this project.")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Link Notion database" })).toBeEnabled();
      await expect(page.getByRole("radio", { name: /Product Specs/ })).toBeChecked();
      expect(mock.saves).toHaveLength(1);
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-26 the project mapping page warns when the connection needs reconnecting and links to Workspace Settings", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion Reco");
      await mockNotionProject(context, projectId, {
        databases: [DB_PRODUCT],
        status: { connected: true, siteUrl: "https://www.notion.so", needsReconnect: true, authError: "Notion rejected this token.", connectedProjects: [], history: [] },
      });
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);

      const alert = page.getByRole("alert").filter({ hasText: "needs to be reconnected" });
      await expect(alert.getByText("Notion needs to be reconnected")).toBeVisible();
      await expect(alert.getByText("Notion rejected this token.")).toBeVisible();
      await expect(alert.getByRole("link", { name: "Reconnect Notion in workspace settings" })).toHaveAttribute(
        "href",
        `/settings/integrations/notion?returnProjectId=${projectId}`
      );
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-27 a project whose workspace has not connected Notion is sent to Workspace Settings with a way back", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion NoConn");
      await mockNotionProject(context, projectId, { status: { connected: false, connectedProjects: [], history: [] } });
      // Not configured on the deployment: the page cannot offer an inline Connect, so it links out.
      await context.route("**/api/workspace/integrations/notion/config", (route) =>
        route.fulfill({ json: { configured: false, clientId: "", redirectUri: "http://localhost/integrations/callback" } })
      );
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);

      await expect(page.getByRole("heading", { name: "Notion is not connected for this workspace" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Go to Workspace Settings → Integrations" })).toHaveAttribute(
        "href",
        `/settings/integrations/notion?returnProjectId=${projectId}`
      );
      await expect(page.getByTestId("remote-item")).toHaveCount(0);
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("INT-U-28 Notion's Auto-comment setting persists independently of Jira's and Linear's on the same project", async ({ page, context }) => {
    const api = await apiContext();
    let projectId: string | undefined;
    try {
      projectId = await createProject(api, "UI Notion AI Gen");
      // Notion: connected, nothing shared (the settings panel renders below the mapping card either way).
      await mockNotionProject(context, projectId, { databases: [] });
      // Same stand-in the Jira/Linear block uses, so their pages get past "not connected".
      for (const [provider, remote] of [["jira", "projects"], ["linear", "teams"]] as const) {
        await context.route(`**/api/projects/${projectId}/${provider}/status`, (route) =>
          route.fulfill({ json: { connected: true, siteUrl: `https://e2e.${provider}.invalid` } })
        );
        await context.route(`**/api/projects/${projectId}/${provider}/${remote}`, (route) => route.fulfill({ json: [] }));
      }
      const readSettings = async () => {
        const fetched = await (await api.get(`/api/projects/${projectId}`)).json();
        return typeof fetched.settings === "string" ? JSON.parse(fetched.settings) : fetched.settings || {};
      };

      // Notion: turn Auto-comment ON.
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);
      await expect(page.getByRole("heading", { name: "Notion + AI Generation" })).toBeVisible();
      const notionBox = page.getByRole("checkbox", { name: /Auto-comment on Notion ticket/ });
      await expect(notionBox).not.toBeChecked();
      await notionBox.check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Notion settings saved.")).toBeVisible();

      let settings = await readSettings();
      expect(settings.notionAutoComment).toBe(true);
      expect(settings.jiraAutoComment).toBeFalsy();
      expect(settings.linearAutoComment).toBeFalsy();

      // The other two providers' panels read their own (off) state, not Notion's.
      await page.goto(`/projects/${projectId}/settings/integrations/linear`);
      await expect(page.getByRole("checkbox", { name: /Auto-comment on Linear ticket/ })).not.toBeChecked();
      await page.goto(`/projects/${projectId}/settings/integrations/jira`);
      await expect(page.getByRole("checkbox", { name: /Auto-comment on Jira ticket/ })).not.toBeChecked();

      // Turn Jira ON: saving it must not clobber Notion's half of the settings blob.
      await page.getByRole("checkbox", { name: /Auto-comment on Jira ticket/ }).check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Jira settings saved.")).toBeVisible();
      settings = await readSettings();
      expect(settings.jiraAutoComment).toBe(true);
      expect(settings.notionAutoComment).toBe(true);
      expect(settings.linearAutoComment).toBeFalsy();

      // And turning Notion OFF leaves Jira's ON: reload and read both back.
      await page.goto(`/projects/${projectId}/settings/integrations/notion`);
      await expect(page.getByRole("checkbox", { name: /Auto-comment on Notion ticket/ })).toBeChecked();
      await page.getByRole("checkbox", { name: /Auto-comment on Notion ticket/ }).uncheck();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Notion settings saved.")).toBeVisible();
      settings = await readSettings();
      expect(settings.notionAutoComment).toBe(false);
      expect(settings.jiraAutoComment).toBe(true);
      await page.goto(`/projects/${projectId}/settings/integrations/jira`);
      await expect(page.getByRole("checkbox", { name: /Auto-comment on Jira ticket/ })).toBeChecked();
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});
