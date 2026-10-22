import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { env } from "../utils/env";
import { NYRA_FAKE_SKIP_REASON, nyraFakeIsWired, startFakeNyraServer, type FakeNyraServer } from "../utils/fake-nyra-server";
import { exec, literal, scalar } from "../utils/psql";
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
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    // The Knowledge Base documents approvals wrote, then the review state and links.
    exec(`DELETE FROM knowledge_documents WHERE id IN (SELECT document_id FROM nyra_kb_documents WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM nyra_item_reviews WHERE project_id IN (${projects});`);
    exec(`DELETE FROM nyra_run_approvals WHERE project_id IN (${projects});`);
    exec(`DELETE FROM nyra_kb_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM nyra_projects WHERE project_id IN (${projects});`);
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

    // Regression: the frame was an <img> whose src changed every 1.5s. A frame slower than that was cancelled
    // before it painted, and NYRA's 204 (no frame yet) fired onError, which removed the card for good.
    test("the live browser waits through 204, shows a frame slower than the poll, and never cancels one", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      const cancelled: string[] = [];
      page.on("requestfailed", (r) => r.url().includes("/live.jpg") && cancelled.push(r.failure()?.errorText ?? ""));
      await page.goto(workspaceUrl());
      const runId = await startScan(page);

      // No frame yet: the card stays and says so, rather than disappearing.
      await expect(page.getByText("Live browser")).toBeVisible();
      await expect(page.getByText("Waiting for the first frame…")).toBeVisible();

      // First frame arrives, and takes longer than the old 1.5s timer.
      fake!.serveFrame(runId, 2500);
      const frame = page.getByRole("img", { name: "NYRA's browser" });
      await expect(frame).toBeVisible({ timeout: 15_000 });
      await expect(frame).toHaveAttribute("src", /^blob:/);
      await expect.poll(() => frame.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
      expect(cancelled).toEqual([]);

      // The scan ends: the last frame stays, relabelled, and polling stops.
      fake!.finishRun(runId);
      await expect(page.getByText("Last frame")).toBeVisible({ timeout: 15_000 });
      await expect(frame).toBeVisible();
      const before = fake!.calls.filter((c) => c.path.endsWith("/live.jpg")).length;
      await page.waitForTimeout(4000);
      // At most the request in flight at the end plus the one that fetches the final frame; a running scan makes about four in 4s.
      expect(fake!.calls.filter((c) => c.path.endsWith("/live.jpg")).length - before).toBeLessThanOrEqual(2);
      // The scan ending must not abort a frame in flight either (it showed as a cancelled live.jpg as the results loaded).
      expect(cancelled).toEqual([]);
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

    // ─── Review and approval ───────────────────────────────────────────────

    /** Opens a finished scan on the Review tab, with every filter widened so decided findings stay visible. */
    async function openReview(page: Page): Promise<void> {
      await page.goto(workspaceUrl());
      const runId = await (async () => {
        const res = await api.post(`/api/projects/${tenant!.mainProjectId}/agents/nyra/projects/${nyraId}/runs`, {
          data: { environmentId: fake!.projects[0].environments[0].id },
        });
        return (await res.json()).id as string;
      })();
      fake!.finishRun(runId);
      await page.reload();
      await expect(page.getByTestId("nyra-run").first()).toContainText("completed");
      await tab(page, "Review").click();
      await page.getByLabel("Show findings that are").selectOption("all");
      await expect(page.getByTestId("nyra-item")).toHaveCount(6);
    }
    const card = (page: Page, title: string) => page.getByTestId("nyra-item").filter({ hasText: title });

    test("an unfinished scan says Review opens when it ends", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(workspaceUrl());
      await page.getByRole("button", { name: "New scan" }).first().click();
      await page.getByRole("button", { name: "Start scan" }).click();
      await tab(page, "Review").click();
      await expect(page.getByText("NYRA saves its findings when the scan finishes. Review opens then.")).toBeVisible();
    });

    test("the Review tab lists only the findings that explain the product, and the report keeps the rest", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      const kinds = page.getByRole("tablist", { name: "Kind of finding" });
      for (const name of ["All 6", "Screens 1", "Features 1", "Workflows 1", "Business rules 1", "Forms 1", "Tech 1"]) {
        await expect(kinds.getByRole("tab", { name, exact: true })).toBeVisible();
      }
      // Test cases, API calls and issues are QA data, not product knowledge: no tab, no cards, nothing to approve.
      for (const gone of [/^Test cases/, /^API calls/, /^Issues/]) await expect(kinds.getByRole("tab", { name: gone })).toHaveCount(0);
      await expect(page.getByTestId("nyra-item").filter({ hasText: "HYPERLINK" })).toHaveCount(0);

      await tab(page, "Report").click();
      await expect(tab(page, "Test cases 1")).toBeVisible();
    });

    test("Correct, Edit, Reject and Undo save immediately and update the counts", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      await expect(page.getByTestId("nyra-count-waiting")).toHaveText("Waiting 6");

      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await expect(page.getByTestId("nyra-count-correct")).toHaveText("Correct 1");
      await expect(page.getByTestId("nyra-count-waiting")).toHaveText("Waiting 5");

      await card(page, "Login flow").getByRole("button", { name: "Reject" }).click();
      await expect(page.getByTestId("nyra-count-rejected")).toHaveText("Rejected 1");

      // Edit: a modal, a changed title, and NYRA's original shown beside it.
      await card(page, "Account sign in").getByRole("button", { name: "Edit" }).click();
      await expect(page.getByRole("heading", { name: "Edit finding" })).toBeVisible();
      await page.locator("#nyra-edit-title").fill("Sign in works");
      await page.locator("#nyra-edit-description").fill("Log in with email and password");
      await page.getByRole("button", { name: "Save edit" }).click();
      await expect(page.getByRole("heading", { name: "Edit finding" })).toHaveCount(0);
      await expect(card(page, "Sign in works")).toContainText("Edited");
      await expect(card(page, "Sign in works")).toContainText("NYRA found:");
      await expect(page.getByTestId("nyra-count-edited")).toHaveText("Edited 1");

      // Undo puts it back to what NYRA found.
      await card(page, "Sign in works").getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("nyra-count-edited")).toHaveText("Edited 0");
      await expect(page.getByTestId("nyra-count-waiting")).toHaveText("Waiting 4");
    });

    test("the Waiting filter hides what has been decided, and bulk Correct covers what is shown", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      await page.getByLabel("Show findings that are").selectOption("waiting");
      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await expect(page.getByTestId("nyra-item")).toHaveCount(5);

      await page.getByRole("button", { name: "Mark 5 shown Correct" }).click();
      await expect(page.getByText("Nothing is waiting for review here.")).toBeVisible();
      await expect(page.getByTestId("nyra-count-correct")).toHaveText("Correct 6");
    });

    test("an edit with a blank title is refused in the form, and saves once fixed", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      await card(page, "Login flow").getByRole("button", { name: "Edit" }).click();
      await page.locator("#nyra-edit-title").fill("   ");
      await page.getByRole("button", { name: "Save edit" }).click();
      await expect(page.getByText("A finding needs a title")).toBeVisible();
      await page.locator("#nyra-edit-title").fill("Same steps");
      await page.locator("#nyra-edit-steps").fill("");
      await page.locator("#nyra-edit-goal").fill("g".repeat(2000));
      await page.getByRole("button", { name: "Save edit" }).click();
      await expect(page.getByRole("heading", { name: "Edit finding" })).toHaveCount(0);
    });

    test("the document preview follows every decision, and hides and shows", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      const doc = page.getByTestId("nyra-doc-preview");
      await expect(doc).toContainText("Nothing is marked Correct yet");

      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await expect(doc.getByRole("region", { name: "Screens" })).toContainText("Purpose: Sign in to the shop");
      await expect(doc).not.toContainText("Nothing is marked Correct yet");

      await card(page, "Login flow").getByRole("button", { name: "Edit" }).click();
      await page.locator("#nyra-edit-title").fill("Getting in");
      await page.getByRole("button", { name: "Save edit" }).click();
      await expect(doc.getByRole("region", { name: "Journeys" })).toContainText("Getting in");
      await expect(doc.getByRole("region", { name: "Journeys" })).toContainText("1. Open /login");

      await card(page, "Sign in").first().getByRole("button", { name: "Reject" }).click();
      await expect(doc.getByRole("region", { name: "Screens" })).toHaveCount(0);

      await page.getByRole("button", { name: "Hide document preview" }).click();
      await expect(doc).toHaveCount(0);
      await page.getByRole("button", { name: "Show document preview" }).click();
      await expect(page.getByTestId("nyra-doc-preview")).toContainText("Getting in");
    });

    test("approving adds the Correct and edited findings to the Knowledge Base as one document", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      const approveButton = page.getByRole("button", { name: "Approve and add to Knowledge Base" });
      await expect(approveButton).toBeDisabled();

      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await card(page, "Login flow").getByRole("button", { name: "Edit" }).click();
      await page.locator("#nyra-edit-title").fill("Login works");
      await page.getByRole("button", { name: "Save edit" }).click();
      await expect(page.getByTestId("nyra-count-edited")).toHaveText("Edited 1");
      await expect(page.getByText("4 findings are still waiting and will not be added.")).toBeVisible();

      const approved = page.waitForResponse((r) => r.url().endsWith("/approve") && r.request().method() === "POST");
      await approveButton.click();
      expect((await approved).status()).toBe(200);

      const status = page.getByRole("status");
      await expect(status).toContainText("2 findings are in the Knowledge Base");
      await expect(status.getByRole("link")).toHaveCount(1);
      const link = status.getByRole("link", { name: /NYRA · .* · Product knowledge/ });
      await expect(link).toBeVisible();

      // It is a real Knowledge Base document, with the approved text in it.
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/`));
      await expect(page.getByText("Purpose: Sign in to the shop")).toBeVisible();
      await expect(page.getByText("Login works").first()).toBeVisible();
    });

    test("Approve stays disabled until a screen, feature, workflow or business rule is marked Correct", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      const approveButton = page.getByRole("button", { name: "Approve and add to Knowledge Base" });
      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await card(page, "Sign in").first().getByRole("button", { name: "Undo" }).click();
      await expect(page.getByTestId("nyra-count-waiting")).toHaveText("Waiting 6");
      await expect(approveButton).toBeDisabled();

      // A form and the tech profile are only the appendix: they cannot be the whole document.
      await card(page, "Login form").getByRole("button", { name: "Correct" }).click();
      await card(page, "Technical profile").getByRole("button", { name: "Correct" }).click();
      await expect(page.getByTestId("nyra-count-correct")).toHaveText("Correct 2");
      await expect(approveButton).toBeDisabled();
      await expect(page.getByText("Mark at least one screen, feature, workflow or business rule Correct to approve.")).toBeVisible();

      await card(page, "Account sign in").getByRole("button", { name: "Correct" }).click();
      await expect(approveButton).toBeEnabled();
    });

    test("a document edited in the Knowledge Base is only replaced after the page asks", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await openReview(page);
      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      const approveButton = page.getByRole("button", { name: "Approve and add to Knowledge Base" });
      await approveButton.click();
      await expect(page.getByRole("status")).toContainText("1 finding is in the Knowledge Base");
      await expect(page.getByTestId("nyra-replace-warning")).toHaveCount(0);

      // A person edits the document in the Knowledge Base.
      exec(`UPDATE knowledge_documents SET content_text = content_text || ' Hand-written note.' WHERE project_id = ${literal(tenant!.mainProjectId)} AND title LIKE 'NYRA · %';`);
      await page.reload();
      await tab(page, "Review").click();
      await page.getByLabel("Show findings that are").selectOption("all");

      const posts: string[] = [];
      page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/approve") && posts.push(r.postData() ?? ""));
      await approveButton.click();
      const warning = page.getByTestId("nyra-replace-warning");
      await expect(warning).toContainText("edited in the Knowledge Base after it was last approved");
      expect(posts).toHaveLength(0);

      // Cancel changes nothing.
      await warning.getByRole("button", { name: "Cancel" }).click();
      await expect(warning).toHaveCount(0);
      expect(posts).toHaveLength(0);
      expect(scalar(`SELECT count(*) FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND content_text LIKE '%Hand-written note.%';`)).toBe("1");

      await approveButton.click();
      const replaced = page.waitForResponse((r) => r.url().endsWith("/approve") && r.request().method() === "POST");
      await warning.getByRole("button", { name: "Replace and approve" }).click();
      expect((await replaced).status()).toBe(200);
      expect(posts.map((p) => JSON.parse(p))).toEqual([{ replaceEdits: true }]);
      await expect(warning).toHaveCount(0);
      expect(scalar(`SELECT count(*) FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND content_text LIKE '%Hand-written note.%';`)).toBe("0");
    });

    test("a QA engineer can review but is not offered approval", async ({ browser }) => {
      const page = await pageAs(browser, "qa");
      await openReview(page);
      await expect(page.getByText("Only owners and managers can approve.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Approve and add to Knowledge Base" })).toHaveCount(0);
      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await expect(page.getByTestId("nyra-count-correct")).toHaveText("Correct 1");
      await expect(page.getByTestId("nyra-doc-preview").getByRole("region", { name: "Screens" })).toBeVisible();
    });

    test("when the preview cannot be built the page says so and review still works", async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.route("**/document-preview", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "NYRA is unreachable. Try again later." }) }));
      await openReview(page);
      await expect(page.getByTestId("nyra-doc-preview")).toHaveCount(0);
      await expect(page.getByText("NYRA is unreachable. Try again later.")).toBeVisible();
      await card(page, "Sign in").first().getByRole("button", { name: "Correct" }).click();
      await expect(page.getByTestId("nyra-count-correct")).toHaveText("Correct 1");
    });

    test("the Review tab says whether approved findings will get vectors", async ({ browser }) => {
      const keys = `organization_id = ${literal(tenant!.organizationId)} AND name LIKE 'E2E NYRA UI embeddings%'`;
      exec(`DELETE FROM workspace_ai_keys WHERE ${keys};`);
      try {
        const page = await pageAs(browser, "owner");
        await openReview(page);
        // A platform VOYAGE_API_KEY on the stack outranks every workspace key: the page names it, and the key tests cannot apply.
        if ((await page.getByTestId("nyra-embeddings").textContent())?.includes("platform")) {
          await expect(page.getByTestId("nyra-embeddings")).toHaveText("Search vectors will be created with the platform's Voyage AI key.");
          return;
        }
        await expect(page.getByTestId("nyra-embeddings")).toContainText("No AI key that can create vectors is set up");
        await expect(page.getByTestId("nyra-embeddings")).toContainText("Add such a key under AI Providers");

        // With an OpenAI key in the workspace, the same screen names the provider after a reload.
        exec(
          `INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, is_active)
           VALUES (${literal(tenant!.organizationId)}, 'E2E NYRA UI embeddings ${Date.now()}', 'openai', 'e2e-not-a-real-key', true);`,
        );
        await page.reload();
        await tab(page, "Review").click();
        await expect(page.getByTestId("nyra-embeddings")).toHaveText("Search vectors will be created with your openai key.");
      } finally {
        exec(`DELETE FROM workspace_ai_keys WHERE ${keys};`);
      }
    });
  });
});
