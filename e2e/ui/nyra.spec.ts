import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { env } from "../utils/env";
import { NYRA_FAKE_SKIP_REASON, nyraFakeIsWired, startFakeNyraServer, type FakeNyraServer } from "../utils/fake-nyra-server";
import { exec, literal } from "../utils/psql";
import { loginAs, provisionRbacTenant, rbacSuiteSkipReason, writeStorageState, type RbacTenant } from "../utils/rbac-tenant";

/*
 * The NYRA agent screens: the card on the Agent List, and the NYRA page with its "New project" form.
 *
 * What a browser adds over api/nyra.spec.ts: the API decides what is allowed, the screen decides what
 * is offered. A QA engineer shown a "New project" button that 403s, a Launch workspace shown a form
 * instead of the Pro prompt, or a failed create that closes the modal and loses what was typed are
 * all bugs the API suite cannot see.
 *
 * Own workspace ("nyra-ui"), on Pro; the Launch test downgrades it and restores it in `finally`.
 * The create-succeeds test needs the stack booted against the fake NYRA (see utils/fake-nyra-server.ts)
 * and is skipped with that reason otherwise.
 */

test.describe("NYRA agent (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  let configured = false;
  const states = new Map<string, string>();
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("nyra-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    states.set("owner", await writeStorageState(tenant.owner, "nyra-ui-owner"));
    states.set("qa", await writeStorageState(tenant.qa, "nyra-ui-qa"));
    configured = (await (await api.get(`/api/projects/${tenant.mainProjectId}/agents/nyra`)).json()).configured === true;
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) {
      purge(tenant);
      setProPlan(tenant.organizationId);
    }
    if (api) await api.dispose();
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  function purge(t: RbacTenant): void {
    exec(`DELETE FROM nyra_projects WHERE project_id IN (${literal(t.mainProjectId)}, ${literal(t.secondProjectId)});`);
  }

  async function pageAs(browser: Browser, label: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: env.webBaseUrl, storageState: states.get(label)! });
    contexts.push(context);
    return context.newPage();
  }

  const agentsUrl = () => `/projects/${tenant!.mainProjectId}/agents`;
  const nyraUrl = () => `${agentsUrl()}/nyra`;
  const newProjectButton = (page: Page) => page.getByRole("button", { name: "New project" });
  // The modal renders without role="dialog", so it is found by its title heading.
  const modalTitle = (page: Page) => page.getByRole("heading", { name: "New project" });

  async function openForm(page: Page): Promise<void> {
    await page.goto(nyraUrl());
    await newProjectButton(page).click();
    await expect(modalTitle(page)).toBeVisible();
  }

  test("the Agent List shows a NYRA card that opens the NYRA page", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(agentsUrl());
    const card = page.getByTestId("agent-card-nyra");
    await expect(card).toBeVisible();
    await expect(card).toContainText("NYRA");
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/agents/nyra$`));
    await expect(page.getByRole("heading", { name: "NYRA", level: 1 })).toBeVisible();
  });

  test("on the Launch plan the page shows the Pro prompt and no form", async ({ browser }) => {
    resetToLaunch(tenant!.organizationId);
    try {
      const page = await pageAs(browser, "owner");
      await page.goto(nyraUrl());
      await expect(page.getByText("NYRA is a Pro plan feature")).toBeVisible();
      await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
      await expect(newProjectButton(page)).toHaveCount(0);
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  test("a QA engineer sees the list but is not offered New project", async ({ browser }) => {
    const page = await pageAs(browser, "qa");
    await page.goto(nyraUrl());
    await expect(page.getByRole("heading", { name: "NYRA", level: 1 })).toBeVisible();
    // Wait for the screen to settle on its final state before asserting something is absent.
    await expect(page.getByText(/No NYRA projects yet|NYRA is not configured/)).toBeVisible();
    await expect(newProjectButton(page)).toHaveCount(0);
  });

  test("an unconfigured server says so instead of offering a form", async ({ browser }) => {
    test.skip(configured, "NYRA is configured on this stack, so the not-configured screen cannot be observed.");
    const page = await pageAs(browser, "owner");
    await page.goto(nyraUrl());
    await expect(page.getByText("NYRA is not configured")).toBeVisible();
    await expect(newProjectButton(page)).toHaveCount(0);
  });

  test.describe("New project form", () => {
    test.beforeEach(() => {
      test.skip(!configured, "needs NYRA configured on the stack (NYRA_API_KEY and NYRA_BASE_URL) for the form to be offered.");
    });

    test("an empty submit shows field errors and sends nothing", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      const posts: string[] = [];
      page.on("request", (r) => r.method() === "POST" && r.url().includes("/agents/nyra/") && posts.push(r.url()));
      await openForm(page);
      await page.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByText("Project name is required")).toBeVisible();
      await expect(page.getByText("App URL is required")).toBeVisible();
      expect(posts).toHaveLength(0);
    });

    test("a bad URL and a half-filled test account are caught before any request", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      const posts: string[] = [];
      page.on("request", (r) => r.method() === "POST" && r.url().includes("/agents/nyra/") && posts.push(r.url()));
      await openForm(page);
      await page.locator("#nyra-name").fill("   ");
      await page.locator("#nyra-app-url").fill("ftp://example.com");
      await page.locator("#nyra-username").fill("qa@example.com");
      await page.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByText("Project name is required")).toBeVisible();
      await expect(page.getByText("Enter a valid URL starting with http:// or https://")).toBeVisible();
      await expect(page.getByText("Password is required for the test account")).toBeVisible();
      expect(posts).toHaveLength(0);
    });

    test("Cancel closes the form and a reopened form starts empty, with no leftover password", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openForm(page);
      await page.locator("#nyra-name").fill("Leftover");
      await page.locator("#nyra-password").fill("do-not-keep-me");
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(modalTitle(page)).toHaveCount(0);
      await newProjectButton(page).click();
      await expect(page.locator("#nyra-name")).toHaveValue("");
      await expect(page.locator("#nyra-password")).toHaveValue("");
    });

    test("the login method offers password only", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openForm(page);
      await expect(page.locator("#nyra-login-method option")).toHaveText(["Password"]);
    });

    test("when NYRA fails, the error is shown in the form and what was typed is kept", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      // Stubbed at the network edge: this checks what the screen does with a failure, whatever the cause.
      await page.route("**/agents/nyra/projects", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "NYRA is unreachable. Try again later." }) })
          : route.continue(),
      );
      await openForm(page);
      await page.locator("#nyra-name").fill("Will fail");
      await page.locator("#nyra-app-url").fill("https://staging.example.com");
      await page.getByRole("button", { name: "Create project" }).click();
      await expect(page.getByText("NYRA is unreachable. Try again later.")).toBeVisible();
      await expect(modalTitle(page)).toBeVisible();
      await expect(page.locator("#nyra-name")).toHaveValue("Will fail");
      // The button recovers, so the user can retry.
      await expect(page.getByRole("button", { name: "Create project" })).toBeEnabled();
    });

    test.describe("against the fake NYRA", () => {
      let fake: FakeNyraServer | null = null;

      test.beforeAll(async () => {
        // May wait for the other NYRA spec file to release the fake (see startFakeNyraServer).
      test.setTimeout(11 * 60_000);
      if (nyraFakeIsWired()) fake = await startFakeNyraServer();
      });
      test.afterAll(async () => {
        await fake?.close();
      });
      test.beforeEach(() => {
        test.skip(!nyraFakeIsWired(), NYRA_FAKE_SKIP_REASON);
        fake?.reset();
      });

      test("creating a project closes the form, shows the new card, and persists", async ({ browser }) => {
        const page = await pageAs(browser, "owner");
        const projectName = `E2E NYRA UI ${Date.now()}`;
        await openForm(page);
        await page.locator("#nyra-name").fill(projectName);
        await page.locator("#nyra-app-url").fill("https://staging.example.com");
        await page.locator("#nyra-username").fill("qa@example.com");
        await page.locator("#nyra-password").fill("S3cret-ui-pw!");

        const created = page.waitForResponse((r) => r.url().endsWith("/agents/nyra/projects") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Create project" }).click();
        expect((await created).status()).toBe(201);

        await expect(modalTitle(page)).toHaveCount(0);
        const card = page.getByTestId("nyra-project").filter({ hasText: projectName });
        await expect(card).toBeVisible();
        await expect(card).toContainText("Test account");
        await expect(card).toContainText("qa@example.com");
        await expect(page.getByText("S3cret-ui-pw!")).toHaveCount(0);

        // Persisted state, not just the optimistic card: a reload still lists it.
        await page.reload();
        await expect(page.getByTestId("nyra-project").filter({ hasText: projectName })).toBeVisible();
      });

      test("submitting twice quickly creates one project", async ({ browser }) => {
        const page = await pageAs(browser, "owner");
        await openForm(page);
        await page.locator("#nyra-name").fill(`E2E NYRA Double ${Date.now()}`);
        await page.locator("#nyra-app-url").fill("https://staging.example.com");
        const button = page.getByRole("button", { name: "Create project" });
        await button.dblclick();
        await expect(modalTitle(page)).toHaveCount(0);
        expect(fake!.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      });
    });
  });

  // ─── The NYRA project workspace: scans, live view, results ─────────────────

  test.describe("NYRA project workspace", () => {
    let fake: FakeNyraServer | null = null;
    let nyraId = "";

    test.beforeAll(async () => {
      // May wait for the other NYRA spec file to release the fake (see startFakeNyraServer).
      test.setTimeout(11 * 60_000);
      if (nyraFakeIsWired()) fake = await startFakeNyraServer();
    });
    test.afterAll(async () => {
      await fake?.close();
    });
    test.beforeEach(async () => {
      test.skip(!nyraFakeIsWired(), NYRA_FAKE_SKIP_REASON);
      fake!.reset();
      purge(tenant!);
      const res = await api.post(`/api/projects/${tenant!.mainProjectId}/agents/nyra/projects`, {
        data: { name: `E2E NYRA Workspace ${Date.now()}`, appUrl: "https://staging.example.com", testAccount: { username: "qa@example.com", password: "S3cret-ws-pw!", loginMethod: "password" } },
      });
      expect(res.status(), await res.text()).toBe(201);
      nyraId = (await res.json()).id;
    });

    const workspaceUrl = () => `${nyraUrl()}/${nyraId}`;
    const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

    /** Starts a scan through the modal and returns once it is listed. */
    async function startScan(page: Page): Promise<string> {
      await page.getByRole("button", { name: "New scan" }).first().click();
      const started = page.waitForResponse((r) => r.url().endsWith(`/projects/${nyraId}/runs`) && r.request().method() === "POST");
      await page.getByRole("button", { name: "Start scan" }).click();
      const response = await started;
      expect(response.status()).toBe(201);
      return (await response.json()).id;
    }

    test("the list card opens the workspace, which starts empty", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(nyraUrl());
      await page.getByTestId("nyra-project").first().click();
      await expect(page).toHaveURL(new RegExp(`/agents/nyra/${nyraId}$`));
      await expect(page.getByText("No scans yet")).toBeVisible();
      await expect(page.getByText("https://staging.example.com")).toBeVisible();
    });

    test("the New scan form offers NYRA's defaults and rejects values outside its limits", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      const posts: string[] = [];
      page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/runs") && posts.push(r.url()));
      await page.goto(workspaceUrl());
      await page.getByRole("button", { name: "New scan" }).first().click();
      await expect(page.locator("#nyra-scan-maxPages")).toHaveValue("25");
      await expect(page.locator("#nyra-scan-maxMinutes")).toHaveValue("10");
      await expect(page.locator("#nyra-scan-maxDepth")).toHaveValue("4");

      await page.locator("#nyra-scan-maxPages").fill("501");
      await page.locator("#nyra-scan-maxMinutes").fill("0");
      await page.locator("#nyra-scan-maxDepth").fill("abc");
      await page.getByRole("button", { name: "Start scan" }).click();
      await expect(page.getByText("Max pages must be a whole number from 1 to 500")).toBeVisible();
      await expect(page.getByText("Max minutes must be a whole number from 1 to 120")).toBeVisible();
      await expect(page.getByText("Max depth must be a whole number from 1 to 20")).toBeVisible();
      expect(posts).toHaveLength(0);
    });

    test("a scan runs live, then ends, and its results fill every tab", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(workspaceUrl());
      const runId = await startScan(page);

      // Live: the run is listed as running, with Stop, and NYRA's stream shows up as findings and a log.
      const row = page.getByTestId("nyra-run").first();
      await expect(row).toContainText("running");
      await expect(page.getByRole("button", { name: "Stop scan" })).toBeVisible();
      await expect(page.getByText("What the agent is reading")).toBeVisible();
      await tab(page, "Findings").click();
      await expect(page.getByRole("region", { name: "Screens" }).getByText("Sign in")).toBeVisible();
      await tab(page, "Log").click();
      await expect(page.getByText(`Starting scan ${runId}`)).toBeVisible();

      // NYRA saves results, then sets the status. The page learns that from the run, not from the stream.
      fake!.finishRun(runId);
      await expect(row).toContainText("completed", { timeout: 15_000 });
      await tab(page, "Overview").click();
      await expect(page.getByRole("button", { name: "Stop scan" })).toHaveCount(0);
      await expect(page.getByText("Ended because")).toHaveCount(0);

      await tab(page, "Findings").click();
      for (const [region, text] of [
        ["Screens", "Sign in"],
        ["Features", "Account sign in"],
        ["Workflows", "Login flow"],
        ["Business rules", '"Email" is required'],
      ] as const) {
        await expect(page.getByRole("region", { name: region }).getByText(text)).toBeVisible();
      }

      await tab(page, "Knowledge file").click();
      await expect(page.getByText("# Fake: knowledge file")).toBeVisible();
      await tab(page, "Business rules").click();
      await expect(page.getByText("# Fake: business rules")).toBeVisible();

      await tab(page, "Recording").click();
      const video = page.locator("video");
      await expect(video).toBeVisible();
      await expect(video).toHaveAttribute("src", new RegExp(`/runs/${runId}/files/recordings/session-1\\.webm$`));
    });

    test("the report filters by kind and search, and the CSV it downloads cannot run a formula", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(workspaceUrl());
      const runId = await startScan(page);
      fake!.finishRun(runId);
      await expect(page.getByTestId("nyra-run").first()).toContainText("completed", { timeout: 15_000 });

      await tab(page, "Report").click();
      await expect(tab(page, "Screens 1")).toBeVisible();
      await expect(page.getByTestId("nyra-item")).toHaveCount(1);
      await page.getByLabel("Search the report").fill("nothing like this");
      await expect(page.getByText("Nothing matches that search.")).toBeVisible();
      await page.getByLabel("Search the report").fill("");

      await tab(page, "Test cases 1").click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "CSV" }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(`nyra-${runId.slice(0, 8)}-test-cases.csv`);
      const text = await (await import("node:fs/promises")).readFile((await file.path())!, "utf8");
      expect(text).toContain(`"'=HYPERLINK(`);
    });

    test("Stop asks NYRA to stop, and starting a second scan while one runs is refused with the reason", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(workspaceUrl());
      await startScan(page);

      await page.getByRole("button", { name: "New scan" }).first().click();
      await page.getByRole("button", { name: "Start scan" }).click();
      await expect(page.getByText("A scan is already running on this environment.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Start scan" })).toBeEnabled();
      await page.getByRole("button", { name: "Cancel" }).click();

      const stop = page.waitForResponse((r) => r.url().endsWith("/stop"));
      await page.getByRole("button", { name: "Stop scan" }).click();
      expect((await stop).status()).toBe(202);
      expect(fake!.runs).toHaveLength(1);
    });

    test("a QA engineer can scan but is not offered Settings", async ({ browser }) => {
      const page = await pageAs(browser, "qa");
      await page.goto(workspaceUrl());
      await expect(page.getByRole("button", { name: "New scan" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(0);
    });

    test("Settings saves the environment, keeps the saved password when none is typed, and shows NYRA's refusal", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(workspaceUrl());
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.locator("#nyra-env-url")).toHaveValue("https://staging.example.com");
      await expect(page.locator("#nyra-env-password")).toHaveAttribute("placeholder", /keep the saved password/);

      // Client-side checks, with nothing sent.
      await page.locator("#nyra-env-domains").fill("com");
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByText("Each domain must be a full hostname")).toBeVisible();
      expect(fake!.calls.some((c) => c.method === "PATCH")).toBe(false);

      await page.locator("#nyra-env-domains").fill("accounts.example.com");
      await page.locator("#nyra-env-mode").selectOption("sandbox");
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
      expect(fake!.projects[0].environments[0]).toMatchObject({ mode: "sandbox", allowed_domains: ["accounts.example.com"], has_password: true });

      // NYRA refusing is shown in the form, and the form stays open.
      await page.getByRole("button", { name: "Settings" }).click();
      await page.locator("#nyra-env-name").fill("force-422");
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByText("Fake NYRA says no")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    });

    test("on the Launch plan the workspace shows the Pro prompt and no scan controls", async ({ browser }) => {
      resetToLaunch(tenant!.organizationId);
      try {
        const page = await pageAs(browser, "owner");
        await page.goto(workspaceUrl());
        await expect(page.getByText("NYRA is a Pro plan feature")).toBeVisible();
        await expect(page.getByRole("button", { name: "New scan" })).toHaveCount(0);
      } finally {
        setProPlan(tenant!.organizationId);
      }
    });

    test("a project this Tesbo project did not create shows an error, not someone else's scans", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(`${nyraUrl()}/00000000-0000-4000-8000-000000000000`);
      await expect(page.getByText("NYRA project not found").first()).toBeVisible();
      await expect(page.getByTestId("nyra-run")).toHaveCount(0);
    });
  });
});
