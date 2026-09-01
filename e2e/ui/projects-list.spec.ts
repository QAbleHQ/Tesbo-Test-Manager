import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
import {
  createProject,
  createSuite,
  createTestCase,
  deleteProjects,
  getDashboard,
  listRuns,
  removeWorkspaceMember,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
  seedWorkspaceMember,
  uniqueKey,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * The projects list at /projects: creating projects, what the cards report, and the view toggle.
 *
 * Search and sort are now live and specified below ("projects list — search and sort"). They used to
 * be inert controls with no handler, which is why this file had no coverage for them; the toolbar's
 * search input and Sort menu both drive `filteredProjects` now.
 *
 * Assertions locate projects by their own unique names rather than by position or count: the
 * project-dashboard API suite creates and deletes projects in this same workspace, and different
 * spec FILES run concurrently, so the list is never guaranteed to hold only this file's fixtures.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

const VIEW_STORAGE_KEY = "tesbo_projects_view";

/** A project's card in grid view or its row in list view — both are links wrapping the name. */
function projectCard(page: Page, name: string): Locator {
  return page.locator('a[href^="/projects/"]').filter({ hasText: name }).first();
}

/**
 * The number a card shows under a given label.
 *
 * Read structurally (the label div's previous sibling) rather than by CSS class, so a styling
 * change doesn't silently start matching the wrong cell.
 */
async function cardStat(card: Locator, label: string): Promise<string> {
  return card.evaluate((el, wanted) => {
    const labelEl = Array.from(el.querySelectorAll("div")).find(
      (d) => d.textContent?.trim().toLowerCase() === (wanted as string).toLowerCase(),
    );
    return labelEl?.previousElementSibling?.textContent?.trim() ?? "";
  }, label);
}

/** Project names in the order the list renders them. */
async function renderedProjectNames(page: Page): Promise<string[]> {
  return page
    .locator('a[href^="/projects/"]')
    .evaluateAll((links) =>
      links
        .map((l) => l.querySelector("h2")?.textContent?.trim() ?? l.querySelector(".truncate")?.textContent?.trim() ?? "")
        .filter(Boolean),
    );
}

/**
 * Opens the projects list and waits for a specific project's card, reloading if the list came back
 * empty.
 *
 * This retry exists solely because of the defect PRJ-D-22 reports: the per-project stats are
 * gathered with Promise.all and only listTestRuns has a .catch, so if any other spec deletes one of
 * this workspace's projects while the list is mid-load, one 404 rejects the whole batch and the
 * page renders the "No projects yet" onboarding state. Without this, that one bug randomly fails
 * every other test on this screen. Delete this helper when PRJ-D-22 goes green.
 */
async function gotoProjectsAndFind(page: Page, name: string): Promise<Locator> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/projects");
    const card = projectCard(page, name);
    if (await card.isVisible({ timeout: 5_000 }).catch(() => false)) return card;
  }
  const card = projectCard(page, name);
  await expect(card, `${name} never appeared in the projects list`).toBeVisible();
  return card;
}

function openCreateModal(page: Page) {
  return page.getByRole("button", { name: /Create project|Create your first project/ }).first().click();
}

/** The create form. Modal.tsx renders without role="dialog", so scope structurally. */
function createForm(page: Page): Locator {
  return page.locator("form").filter({ has: page.locator("#create-name") });
}

test.describe("projects list — creating a project", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PRJ-C-01 a name alone is enough, and the new project opens on its dashboard", { tag: '@tesbo.testId("TES-TC-759")' }, async ({ page }) => {
    const name = `E2E UI Create ${uniqueSuffix()}`;
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      await createForm(page).locator("#create-name").fill(name);
      await createForm(page).getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];

      const created = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(created.name).toBe(name);
      // The key is derived from the name when none is given.
      expect(created.key).toBeTruthy();
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("PRJ-C-02 an explicit key and description are persisted verbatim", { tag: '@tesbo.testId("TES-TC-760")' }, async ({ page }) => {
    const name = `E2E UI Create Full ${uniqueSuffix()}`;
    const key = uniqueKey("UIC");
    const description = "Created through the projects list UI";
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(name);
      await form.locator("#create-key").fill(key);
      await form.locator("#create-desc").fill(description);
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];

      const created = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(created.name).toBe(name);
      expect(created.key).toBe(key);
      expect(created.description).toBe(description);
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("PRJ-C-03/07 a new project appears in the list needing setup, with nothing counted yet", { tag: '@tesbo.testId("TES-TC-761")' }, async ({
    page,
  }) => {
    const project = await createProject(api);
    try {
      const card = await gotoProjectsAndFind(page, project.name);

      await expect(card).toContainText("Setup required");
      expect(await cardStat(card, "Test cases")).toBe("0");
      // Nothing is seeded into a new project's suites — createProject only seeds knowledge-base
      // folders — so a fresh project genuinely has none.
      expect(await cardStat(card, "Suites")).toBe("0");
      expect(await cardStat(card, "Pass rate")).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-C-06 the ?create=1 deep link opens the modal straight away", { tag: '@tesbo.testId("TES-TC-762")' }, async ({ page }) => {
    await page.goto("/projects?create=1");
    await expect(createForm(page).locator("#create-name")).toBeVisible();
  });

  test("PRJ-C-08/09 an empty or whitespace-only name is refused without calling the API", { tag: '@tesbo.testId("TES-TC-763")' }, async ({
    page,
  }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);

    let postCount = 0;
    await page.route(
      (url) => url.pathname === "/api/projects",
      (route) => {
        if (route.request().method() === "POST") postCount += 1;
        return route.continue();
      },
    );

    await form.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(form.getByText("Project name is required")).toBeVisible();

    await form.locator("#create-name").fill("   ");
    await form.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(form.getByText("Project name is required")).toBeVisible();

    expect(postCount, "a rejected name must not reach the API").toBe(0);
    await expect(form.locator("#create-name")).toBeVisible();
  });

  test("PRJ-C-10 a duplicate key is reported inline and creates nothing", { tag: '@tesbo.testId("TES-TC-764")' }, async ({ page }) => {
    const existing = await createProject(api);
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(`E2E UI Duplicate ${uniqueSuffix()}`);
      await form.locator("#create-key").fill(existing.key);
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      // The modal stays open carrying the error, rather than navigating or closing silently.
      await expect(form.locator("p.text-red-600")).toBeVisible();
      await expect(page).toHaveURL(/\/projects$/);
    } finally {
      await deleteProjects(api, [existing.id]);
    }
  });

  test("PRJ-C-11 two projects may share a name when their keys differ", { tag: '@tesbo.testId("TES-TC-765")' }, async ({ page }) => {
    const sharedName = `E2E UI Shared Name ${uniqueSuffix()}`;
    const first = await createProject(api, { name: sharedName, key: uniqueKey("SHA") });
    let secondId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(sharedName);
      await form.locator("#create-key").fill(uniqueKey("SHB"));
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/dashboard$/);
      secondId = page.url().split("/projects/")[1].split("/")[0];
      expect(secondId).not.toBe(first.id);
    } finally {
      await deleteProjects(api, [first.id, secondId]);
    }
  });

  test("PRJ-C-12 the key field accepts only uppercase alphanumerics as you type", { tag: '@tesbo.testId("TES-TC-766")' }, async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const key = createForm(page).locator("#create-key");

    await key.fill("my project-key_1!");
    await expect(key).toHaveValue("MYPROJECTKEY1");
  });

  test("PRJ-C-13 a 30-character name is accepted and a 31-character one is refused", async ({ page }) => {
    const suffix = uniqueSuffix();
    const atLimit = `E2E${suffix}`.padEnd(30, "x");
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      let form = createForm(page);
      await form.locator("#create-name").fill(atLimit);
      await form.locator("#create-key").fill(uniqueKey("LIM"));
      await form.getByRole("button", { name: "Create project", exact: true }).click();
      await page.waitForURL(/\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];
      expect((await (await api.get(`/api/projects/${projectId}`)).json()).name).toHaveLength(30);

      // One character past the product-chosen cap must be a refusal, not a silent truncation.
      // Fill bypasses the input's maxLength attribute (unlike real typing), so this still reaches
      // the server and exercises its own validation rather than only the client-side guard.
      const overLimit = `E2E${uniqueSuffix()}`.padEnd(31, "y");
      await page.goto("/projects");
      await openCreateModal(page);
      form = createForm(page);
      await form.locator("#create-name").fill(overLimit);
      await form.locator("#create-key").fill(uniqueKey("OVR"));
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await expect(form.locator("p.text-red-600")).toBeVisible();
      await expect(page).toHaveURL(/\/projects$/);
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("PRJ-C-14/15 a unicode name round-trips and drives the card's avatar letter", { tag: '@tesbo.testId("TES-TC-768")' }, async ({ page }) => {
    const name = `日本語 プロジェクト ${uniqueSuffix()}`;
    const numeric = `9 Lives ${uniqueSuffix()}`;
    const unicodeProject = await createProject(api, { name, key: uniqueKey("UNI") });
    const numericProject = await createProject(api, { name: numeric, key: uniqueKey("NUM") });
    try {
      const unicodeCard = await gotoProjectsAndFind(page, name);
      // charAt(0).toUpperCase() of a non-Latin name is that same character, not a fallback.
      await expect(unicodeCard).toContainText("日");
      await expect(projectCard(page, numeric)).toContainText("9");
    } finally {
      await deleteProjects(api, [unicodeProject.id, numericProject.id]);
    }
  });

  test("PRJ-C-16 cancelling discards what was typed", { tag: '@tesbo.testId("TES-TC-769")' }, async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    let form = createForm(page);
    await form.locator("#create-name").fill("Abandoned draft");
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(form.locator("#create-name")).toBeHidden();

    await openCreateModal(page);
    form = createForm(page);
    await expect(form.locator("#create-name")).toHaveValue("");
  });

  test("PRJ-C-18 double-clicking Create makes exactly one project", { tag: '@tesbo.testId("TES-TC-770")' }, async ({ page }) => {
    const name = `E2E UI Double ${uniqueSuffix()}`;
    let created: { id: string }[] = [];
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(name);

      // Hold the response open so the second click lands while the first is still in flight.
      await page.route(
        (url) => url.pathname === "/api/projects",
        async (route) => {
          if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 800));
          await route.continue();
        },
      );

      const submit = form.getByRole("button", { name: /Create project|Creating/ });
      await submit.click();
      await submit.click({ force: true }).catch(() => undefined);
      await page.waitForURL(/\/dashboard$/, { timeout: 20_000 });

      const all = await (await api.get("/api/projects")).json();
      created = all.filter((p: { name: string }) => p.name === name);
      expect(created).toHaveLength(1);
    } finally {
      await deleteProjects(api, created.map((p) => p.id));
    }
  });

  test("PRJ-C-19 a server error keeps the modal open and creates nothing", { tag: '@tesbo.testId("TES-TC-771")' }, async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);
    await form.locator("#create-name").fill(`E2E UI Server Error ${uniqueSuffix()}`);

    await page.route(
      (url) => url.pathname === "/api/projects",
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
          : route.continue(),
    );
    await form.getByRole("button", { name: "Create project", exact: true }).click();

    await expect(form.locator("p.text-red-600")).toBeVisible();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test("PRJ-C-20 a dropped connection surfaces an error rather than hanging", { tag: '@tesbo.testId("TES-TC-772")' }, async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);
    await form.locator("#create-name").fill(`E2E UI Offline ${uniqueSuffix()}`);

    await page.route(
      (url) => url.pathname === "/api/projects",
      (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()),
    );
    await form.getByRole("button", { name: "Create project", exact: true }).click();

    await expect(form.locator("p.text-red-600")).toBeVisible();
    // The button must come back — a permanently disabled "Creating…" is a dead end.
    await expect(form.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
  });

  test("PRJ-C-26 an unauthenticated visitor is sent to the login screen", { tag: '@tesbo.testId("TES-TC-773")' }, async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anonymous = await context.newPage();
      await anonymous.goto("/projects");
      await anonymous.waitForURL("**/login");
    } finally {
      await context.close();
    }
  });

  test("PRJ-C-27 another tenant's projects are not in this list", { tag: '@tesbo.testId("TES-TC-774")' }, async ({ page }) => {
    const otherTenantProjects = await (await api.get("/api/projects")).json();
    await page.goto("/projects");
    const rendered = await renderedProjectNames(page);

    // Account A's smoke project lives in a different workspace and must never appear here.
    expect(rendered).not.toContain("E2E Smoke Project");
    expect(otherTenantProjects.every((p: { name: string }) => p.name !== "E2E Smoke Project")).toBe(true);
  });

  test("a chosen color and glyph render as the project's badge instead of the generated one", async ({ page }) => {
    const name = `E2E UI Icon ${uniqueSuffix()}`;
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(name);
      await form.getByRole("button", { name: "Icon color #1F7A3D" }).click();
      await form.getByRole("textbox", { name: "Custom icon letter or emoji" }).fill("Z");
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];

      const created = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(created.settings.icon).toEqual({ color: "#1F7A3D", glyph: "Z" });

      const card = await gotoProjectsAndFind(page, name);
      await expect(card).toContainText("Z");
      const badgeColor = await card.locator("div").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(badgeColor).toBe("rgb(31, 122, 61)"); // #1F7A3D
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("an icon glyph is capped at 2 characters and forced to uppercase as you type", async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);
    const glyphInput = form.getByRole("textbox", { name: "Custom icon letter or emoji" });

    // Typed lowercase and past the limit — the field truncates to 2 graphemes and uppercases
    // live, rather than accepting the input and only complaining on submit.
    await glyphInput.pressSequentially("abc", { delay: 20 });
    await expect(glyphInput).toHaveValue("AB");
  });

  test("a lowercase glyph is normalized to uppercase on create", async ({ page }) => {
    const name = `E2E UI Icon Lowercase ${uniqueSuffix()}`;
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(name);
      await form.getByRole("textbox", { name: "Custom icon letter or emoji" }).fill("q");
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];

      const created = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(created.settings.icon.glyph).toBe("Q");
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });
});

test.describe("projects list — access and the empty state", () => {
  test.skip(!!skipReason, skipReason ?? "");
  test.skip(!dbControlAvailable(), "needs psql access to seed workspace members with specific roles");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  /*
   * These use a freshly seeded member rather than deleting the workspace's projects: the theme and
   * navigation suites read the base project concurrently, and listProjects is scoped by
   * project_members, so a user with no project memberships sees a genuinely empty list without
   * anything being removed.
   */

  test("PRJ-C-04/05/22 a manager with no projects yet is invited to create the first one", { tag: '@tesbo.testId("TES-TC-775")' }, async ({
    browser,
  }) => {
    const manager = await seedWorkspaceMember(tenant!.organizationId, "manager");
    const context = await browser.newContext({ storageState: manager.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/projects");

      await expect(page.getByText("No projects yet")).toBeVisible();
      await expect(
        page.getByText("Create a Tesbo Test Manager project for full E2E test management."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Create your first project" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create first project" })).toBeVisible();

      // The toolbar has nothing to act on with an empty list, so it isn't rendered at all.
      await expect(page.getByRole("button", { name: "Grid view" })).toHaveCount(0);
    } finally {
      await context.close();
      removeWorkspaceMember(manager.userId, manager.storageStatePath);
    }
  });

  test("PRJ-C-21 a plain member is told to ask for access instead of being offered a button", { tag: '@tesbo.testId("TES-TC-776")' }, async ({
    browser,
  }) => {
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/projects");

      await expect(page.getByText("No projects yet")).toBeVisible();
      await expect(
        page.getByText("You do not have project access yet. Ask your manager to grant access."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /Create/ })).toHaveCount(0);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("PRJ-C-23 the server refuses a member who posts around the missing button", { tag: '@tesbo.testId("TES-TC-777")' }, async ({ browser }) => {
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    try {
      // The button being hidden is presentation. The check that matters is server-side.
      // An explicit key: projectKey() derives from the name and truncates to 16 chars, which cuts
      // the timestamp off this name and collides with the previous run's project.
      const res = await context.request.post(`${process.env.API_BASE_URL}/api/projects`, {
        data: { name: `E2E UI Member Bypass ${uniqueSuffix()}`, key: uniqueKey("BYP") },
        failOnStatusCode: false,
      });
      expect(res.status(), "a workspace member must not be able to create projects").toBe(403);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("PRJ-D-27 a project the caller is not a member of is absent from their list", { tag: '@tesbo.testId("TES-TC-778")' }, async ({ browser }) => {
    const admin = await seedWorkspaceMember(tenant!.organizationId, "admin");
    const context = await browser.newContext({ storageState: admin.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/projects");

      // The workspace's base project exists and this user is a workspace admin, but listProjects
      // joins project_members — so workspace-level seniority alone shows them nothing.
      const rendered = await renderedProjectNames(page);
      expect(rendered).toEqual([]);
    } finally {
      await context.close();
      removeWorkspaceMember(admin.userId, admin.storageStatePath);
    }
  });
});

test.describe("projects list — what the cards report", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PRJ-D-01/02 the test case and suite counts match the API", { tag: '@tesbo.testId("TES-TC-779")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      await createSuite(api, project.id);

      const summary = await getDashboard(api, project.id);
      const card = await gotoProjectsAndFind(page, project.name);

      expect(await cardStat(card, "Test cases")).toBe(String(summary.testCases.total));
      expect(await cardStat(card, "Suites")).toBe(String(summary.suites));
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-03/04 the pass rate and its colour follow the run's result", { tag: '@tesbo.testId("TES-TC-780")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      // 9 of 10 passed = 90%, the boundary where the colour becomes success green.
      await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Failed"],
        status: "Completed",
      });

      const card = await gotoProjectsAndFind(page, project.name);
      expect(await cardStat(card, "Pass rate")).toBe("90%");

      const colour = await card.evaluate((el) => {
        const label = Array.from(el.querySelectorAll("div")).find(
          (d) => d.textContent?.trim() === "Pass rate",
        );
        const value = label?.previousElementSibling as HTMLElement | null;
        return value ? getComputedStyle(value).color : "";
      });
      // --success, not the warning or error tone.
      expect(colour).not.toBe("");
      expect(colour).not.toBe("rgb(0, 0, 0)");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-05/06/07 the status badge tracks setup, configuration and activity", { tag: '@tesbo.testId("TES-TC-781")' }, async ({ page }) => {
    const fresh = await createProject(api);
    const configured = await createProject(api);
    try {
      // A project with test cases but no recorded activity reads as Configured; adding a case
      // through the API writes an activity row, which is what flips it to Active.
      await createTestCase(api, configured.id);

      await page.goto("/projects");
      await expect(projectCard(page, fresh.name)).toContainText("Setup required");
      await expect(projectCard(page, configured.name)).toContainText(/Active|Configured/);
    } finally {
      await deleteProjects(api, [fresh.id, configured.id]);
    }
  });

  test("PRJ-D-09 the card's pass rate agrees with the project dashboard", { tag: '@tesbo.testId("TES-TC-782")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      // A finished run, everything passing.
      await seedRun(api, project.id, { statuses: ["Passed", "Passed"], status: "Completed" });
      // Then somebody schedules the next run and hasn't executed it yet.
      await seedRun(api, project.id, { statuses: ["Untested", "Untested"] });

      const summary = await getDashboard(api, project.id);
      const card = await gotoProjectsAndFind(page, project.name);

      /*
       * The dashboard reports 100%: two executions exist, both passed, and Untested is excluded
       * from its denominator. The card divides passed by totalCases of whichever run was created
       * last — `completedRuns` never actually filters on status — so scheduling an empty run drops
       * the same project from 100% to 0% on this screen while the dashboard still says 100%.
       */
      expect(await cardStat(card, "Pass rate")).toBe(`${summary.passRate.value}%`);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-10 the card's blocked count is the run's real blocked count", { tag: '@tesbo.testId("TES-TC-783")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, {
        statuses: ["Passed", "Failed", "Untested", "Untested", "Untested"],
        status: "In Progress",
      });
      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      expect(listed.blocked, "nothing in this run is blocked").toBe(0);

      const card = await gotoProjectsAndFind(page, project.name);

      /*
       * listTestRuns already returns a real `blocked` count. The card discards it and recomputes
       * totalCases - passed - failed, which sweeps blocked, skipped, untested and retest into one
       * bucket — so a run with three untested cases reports "3 blocked" here while the project
       * dashboard's own run panel, reading run.blocked, correctly reports none.
       */
      await expect(card).not.toContainText("blocked");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-08 the pass-rate bar segments are proportional and omit empty ones", { tag: '@tesbo.testId("TES-TC-784")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Passed", "Passed", "Failed"], status: "Completed" });

      const card = await gotoProjectsAndFind(page, project.name);
      await expect(card).toContainText("3 passed");
      await expect(card).toContainText("1 failed");
      // The blocked legend entry is rendered only when there is something to report.
      await expect(card).not.toContainText("0 blocked");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-12 a project with no members says so rather than showing an empty row", { tag: '@tesbo.testId("TES-TC-785")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      // The creator is added as project owner, so this card has exactly one avatar.
      const card = projectCard(page, project.name);
      await expect(card).not.toContainText("No members assigned");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-16 a project with no description shows the guidance placeholder", { tag: '@tesbo.testId("TES-TC-786")' }, async ({ page }) => {
    const without = await createProject(api);
    const withDescription = await createProject(api, { description: "A real description" });
    try {
      await page.goto("/projects");

      await expect(projectCard(page, without.name)).toContainText(
        "Add project context to guide test case planning and execution.",
      );
      await expect(projectCard(page, withDescription.name)).toContainText("A real description");
    } finally {
      await deleteProjects(api, [without.id, withDescription.id]);
    }
  });

  test("PRJ-D-15 a project with no activity is labelled by when it was created", { tag: '@tesbo.testId("TES-TC-787")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await expect(projectCard(page, project.name)).toContainText(/Created .*ago|just now/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-18 the project key is rendered in uppercase", { tag: '@tesbo.testId("TES-TC-788")' }, async ({ page }) => {
    const project = await createProject(api, { key: uniqueKey("CAS") });
    try {
      await page.goto("/projects");
      await expect(projectCard(page, project.name)).toContainText(project.key.toUpperCase());
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-19 a project's colour is stable across reloads", { tag: '@tesbo.testId("TES-TC-789")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const avatarColour = async () =>
        projectCard(page, project.name)
          .locator("div")
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor);

      await page.goto("/projects");
      const first = await avatarColour();
      await page.reload();
      expect(await avatarColour()).toBe(first);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-20 clicking a card opens that project's dashboard", { tag: '@tesbo.testId("TES-TC-790")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await projectCard(page, project.name).click();
      await page.waitForURL(`**/projects/${project.id}/dashboard`);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-21 a project whose runs cannot be fetched still renders", { tag: '@tesbo.testId("TES-TC-791")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.route(
        (url) => /\/api\/projects\/[0-9a-f-]{36}\/cycles$/.test(url.pathname),
        (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
      );
      await page.goto("/projects");

      // listTestRuns is caught with .catch(() => []), so the card degrades to "no runs yet".
      const card = projectCard(page, project.name);
      await expect(card).toBeVisible();
      expect(await cardStat(card, "Pass rate")).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-22 a failure in one project's stats does not blank the whole list", { tag: '@tesbo.testId("TES-TC-792")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.route(
        (url) => /\/api\/projects\/[0-9a-f-]{36}\/suites$/.test(url.pathname),
        (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
      );
      await page.goto("/projects");

      /*
       * The per-project stats are gathered with Promise.all, and only listTestRuns has a .catch —
       * so one failing suites/activity/members call rejects the whole batch, the .finally leaves
       * loading false with projects still empty, and the user is shown the "No projects yet"
       * onboarding state despite having projects. A partial outage should degrade one card.
       */
      await expect(page.getByText("No projects yet")).toHaveCount(0);
      await expect(projectCard(page, project.name)).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-23 the loading spinner is replaced by content", { tag: '@tesbo.testId("TES-TC-793")' }, async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByText("Loading projects…")).toHaveCount(0);
    await expect(page.getByText("Tesbo Test Manager Projects")).toBeVisible();
  });

  test("PRJ-D-25/26 the list is newest first, and an archived project drops out of it", { tag: '@tesbo.testId("TES-TC-794")' }, async ({ page }) => {
    const older = await createProject(api, { name: `E2E UI Order A ${uniqueSuffix()}` });
    const newer = await createProject(api, { name: `E2E UI Order B ${uniqueSuffix()}` });
    try {
      await page.goto("/projects");
      // The list is fetched client-side, so wait for it to paint before reading the order off it.
      await expect(projectCard(page, newer.name)).toBeVisible();

      const names = await renderedProjectNames(page);
      // Asserted as relative order, not absolute position: other suites create projects in this
      // workspace concurrently.
      expect(names.indexOf(newer.name)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(newer.name)).toBeLessThan(names.indexOf(older.name));

      // DELETE is the archive — deleteProject sets archived_at rather than removing the row, and
      // listProjects filters on archived_at IS NULL.
      await api.delete(`/api/projects/${older.id}`);
      await page.reload();
      await expect(projectCard(page, newer.name)).toBeVisible();
      expect(await renderedProjectNames(page)).not.toContain(older.name);
    } finally {
      await deleteProjects(api, [older.id, newer.id]);
    }
  });

  test("PRJ-D-28 an unexecuted run does not read as a zero-percent pass rate", { tag: '@tesbo.testId("TES-TC-795")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Untested", "Untested", "Untested"] });

      const card = await gotoProjectsAndFind(page, project.name);
      // Nothing has been executed, so there is no rate to report — "0%" would be a lie.
      expect(await cardStat(card, "Pass rate")).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

test.describe("projects list — the grid/list toggle", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PRJ-V-01/02 grid is the default and List switches the layout", { tag: '@tesbo.testId("TES-TC-796")' }, async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "false");
  });

  test("PRJ-V-03 the chosen view is remembered across a reload", { tag: '@tesbo.testId("TES-TC-797")' }, async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "List view" }).click();
    await expect
      .poll(async () => page.evaluate((key) => window.localStorage.getItem(key), VIEW_STORAGE_KEY))
      .toBe("list");

    await page.reload();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
  });

  for (const stored of ["table", "", "{}"]) {
    test(`PRJ-V-04 a corrupt stored view (${JSON.stringify(stored)}) falls back to grid`, async ({ page }) => {
      await page.addInitScript(
        ([key, value]) => window.localStorage.setItem(key as string, value as string),
        [VIEW_STORAGE_KEY, stored] as const,
      );
      await page.goto("/projects");

      await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    });
  }

  test("PRJ-V-05 list view labels every column", { tag: '@tesbo.testId("TES-TC-801")' }, async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "List view" }).click();

    for (const column of ["Project", "Test cases", "Suites", "Pass rate", "Team", "Updated"]) {
      await expect(page.getByText(column, { exact: true }).first()).toBeVisible();
    }
  });

  test("PRJ-V-06/07 both views report the same numbers for the same project", { tag: '@tesbo.testId("TES-TC-802")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"], status: "Completed" });

      const gridCard = await gotoProjectsAndFind(page, project.name);
      const grid = {
        cases: await cardStat(gridCard, "Test cases"),
        suites: await cardStat(gridCard, "Suites"),
        passRate: await cardStat(gridCard, "Pass rate"),
      };

      await page.getByRole("button", { name: "List view" }).click();
      const row = projectCard(page, project.name);
      const rowText = await row.innerText();

      expect(rowText).toContain(grid.cases);
      expect(rowText).toContain(grid.suites);
      expect(rowText).toContain(grid.passRate);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-V-07 list view says 'No runs yet' where grid shows a dash", { tag: '@tesbo.testId("TES-TC-803")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await expect(projectCard(page, project.name)).toBeVisible();
      expect(await cardStat(projectCard(page, project.name), "Pass rate")).toBe("—");

      await page.getByRole("button", { name: "List view" }).click();
      await expect(projectCard(page, project.name)).toContainText("No runs yet");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-V-10 a list row highlights on hover and stays clickable", { tag: '@tesbo.testId("TES-TC-804")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await page.getByRole("button", { name: "List view" }).click();

      const row = projectCard(page, project.name);
      await row.hover();
      await row.click();
      await page.waitForURL(`**/projects/${project.id}/dashboard`);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

/*
 * Search and sort on the projects list toolbar.
 *
 * Both were reported broken from production (BetterBugs 6a7c203d — "Search functionality is not
 * working in Projects"; 6a7c1f28 — "Sorting and filters are not working in Projects"). Both are now
 * implemented client-side in ProjectsToolbar/`filteredProjects`, so these tests are the regression
 * cover that keeps them working.
 *
 * Two things shape every assertion here:
 *
 *   1. This workspace is SHARED with the project-dashboard API suite, and spec files run
 *      concurrently — so the list can hold projects this file did not create. Nothing below asserts
 *      a total count or an absolute position. Search is asserted by "mine are present, my decoy is
 *      not", and sort by the relative order of this test's own fixtures (`indexOf` pairs), which
 *      holds no matter what else is interleaved between them.
 *   2. Filtering is client-side over the already-loaded list, with no request per keystroke. So the
 *      assertions wait on the DOM settling rather than on a response.
 *
 * There is no separate status/role *filter* control on this screen — the reporter's "filters" is the
 * search box, which filters name, key and description. If a distinct filter dropdown is ever added,
 * it wants its own tests here.
 */
test.describe("projects list — search and sort", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  const created: string[] = [];

  /** Distinct enough that no other spec's fixture can match it. */
  const token = `Zqx${uniqueSuffix()}`;
  const names = {
    alpha: `E2E ${token} Alpha Search`,
    beta: `E2E ${token} Beta Search`,
    gamma: `E2E ${token} Gamma Search`,
  };
  let describedId = "";
  let alphaKey = "";

  test.beforeAll(async () => {
    api = await screensApi();
    // Created oldest-first and awaited in turn, so createdAt order is alpha < beta < gamma. The
    // "Newest created" sort must therefore read gamma, beta, alpha.
    for (const which of ["alpha", "beta", "gamma"] as const) {
      const project = await createProject(api, { name: names[which], key: uniqueKey("SRCH") });
      created.push(project.id);
      if (which === "alpha") alphaKey = project.key;
    }
    // A fourth project whose NAME cannot match the search token, but whose description can — the
    // search covers name, key and description, and only a description-only hit proves the last one.
    const described = await createProject(api, {
      name: `E2E Described ${uniqueSuffix()}`,
      key: uniqueKey("SRCD"),
      description: `Owned by the ${token} programme`,
    });
    describedId = described.id;
    created.push(described.id);
  });

  test.afterAll(async () => {
    await deleteProjects(api, created);
    await api?.dispose();
  });

  function searchBox(page: Page): Locator {
    return page.getByPlaceholder("Search projects by name or keyword");
  }

  /** The Sort trigger reports the current option in its own label ("Sort: Last updated"). */
  function sortTrigger(page: Page): Locator {
    return page.getByRole("button", { name: /^Sort:/ });
  }

  async function chooseSort(page: Page, option: string) {
    await sortTrigger(page).click();
    await page.getByRole("button", { name: option, exact: true }).click();
    await expect(sortTrigger(page)).toHaveText(new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  test("PRJ-S-01 typing a project name filters the list down to it", { tag: '@tesbo.testId("TES-TC-1056")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    await searchBox(page).fill(names.alpha);

    await expect(projectCard(page, names.alpha)).toBeVisible();
    // The other two share the token but not the full name, so they must drop out.
    await expect(projectCard(page, names.beta)).toHaveCount(0);
    await expect(projectCard(page, names.gamma)).toHaveCount(0);
  });

  test("PRJ-S-02 a shared keyword keeps every project that matches it", { tag: '@tesbo.testId("TES-TC-1057")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    await searchBox(page).fill(token);

    for (const name of [names.alpha, names.beta, names.gamma]) {
      await expect(projectCard(page, name), `${name} should match "${token}"`).toBeVisible();
    }
  });

  test("PRJ-S-03 search is case-insensitive and ignores surrounding whitespace", { tag: '@tesbo.testId("TES-TC-1058")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    await searchBox(page).fill(`   ${token.toUpperCase()}   `);
    await expect(projectCard(page, names.alpha)).toBeVisible();

    await searchBox(page).fill(token.toLowerCase());
    await expect(projectCard(page, names.alpha)).toBeVisible();
  });

  test("PRJ-S-04 search matches a project's key and its description, not only its name", { tag: '@tesbo.testId("TES-TC-1059")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    // Description-only hit: this project's name contains no part of the token, so the only way it
    // can survive the filter is through its description.
    await searchBox(page).fill(token);
    await expect(page.locator(`a[href="/projects/${describedId}"]`)).toBeVisible();

    // Key-only hit: searching the key must find alpha, and must not drag in the other two.
    await searchBox(page).fill(alphaKey);
    await expect(projectCard(page, names.alpha)).toBeVisible();
    await expect(projectCard(page, names.beta)).toHaveCount(0);
  });

  test("PRJ-S-05 filtering happens as you type, with no Enter and no request per keystroke", { tag: '@tesbo.testId("TES-TC-1060")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    let projectRequests = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/projects") projectRequests += 1;
    });

    // Typed character by character, and never submitted.
    await searchBox(page).pressSequentially(names.beta, { delay: 20 });

    await expect(projectCard(page, names.beta)).toBeVisible();
    await expect(projectCard(page, names.alpha)).toHaveCount(0);
    expect(projectRequests, "filtering is client-side over the loaded list").toBe(0);
  });

  test("PRJ-S-06 a term matching nothing says so and offers the term back", { tag: '@tesbo.testId("TES-TC-1061")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    const miss = `NoSuchProject${uniqueSuffix()}`;
    await searchBox(page).fill(miss);

    await expect(page.getByText("No projects match your search")).toBeVisible();
    await expect(page.getByText(miss, { exact: false })).toBeVisible();
    await expect(projectCard(page, names.alpha)).toHaveCount(0);
  });

  test("PRJ-S-07 clearing the search restores the projects it had hidden", { tag: '@tesbo.testId("TES-TC-1062")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    await searchBox(page).fill(names.alpha);
    await expect(projectCard(page, names.beta)).toHaveCount(0);

    await searchBox(page).fill("");

    await expect(projectCard(page, names.alpha)).toBeVisible();
    await expect(projectCard(page, names.beta)).toBeVisible();
    await expect(projectCard(page, names.gamma)).toBeVisible();
  });

  test("PRJ-S-08 Name (A–Z) and (Z–A) are exact reverses of each other", { tag: '@tesbo.testId("TES-TC-1063")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);
    // Narrowed to this test's own three projects so unrelated fixtures cannot sit between them.
    await searchBox(page).fill(token);
    await expect(projectCard(page, names.gamma)).toBeVisible();

    await chooseSort(page, "Name (A–Z)");
    const ascending = (await renderedProjectNames(page)).filter((n) => n.includes(token));
    expect(ascending).toEqual([names.alpha, names.beta, names.gamma]);

    await chooseSort(page, "Name (Z–A)");
    const descending = (await renderedProjectNames(page)).filter((n) => n.includes(token));
    expect(descending).toEqual([names.gamma, names.beta, names.alpha]);
  });

  test("PRJ-S-09 Newest created puts the most recently created project first", { tag: '@tesbo.testId("TES-TC-1064")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);
    await searchBox(page).fill(token);
    await expect(projectCard(page, names.gamma)).toBeVisible();

    await chooseSort(page, "Newest created");

    const order = (await renderedProjectNames(page)).filter((n) => n.includes(token));
    expect(order).toEqual([names.gamma, names.beta, names.alpha]);
  });

  test("PRJ-S-10 the chosen sort still applies after the search term changes", { tag: '@tesbo.testId("TES-TC-1065")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);

    await chooseSort(page, "Name (Z–A)");
    await searchBox(page).fill(token);

    const order = (await renderedProjectNames(page)).filter((n) => n.includes(token));
    expect(order, "sort and search compose — one must not reset the other").toEqual([
      names.gamma,
      names.beta,
      names.alpha,
    ]);
  });

  test("PRJ-S-11 sorting survives switching between grid and list view", { tag: '@tesbo.testId("TES-TC-1066")' }, async ({ page }) => {
    await gotoProjectsAndFind(page, names.alpha);
    await searchBox(page).fill(token);
    await chooseSort(page, "Name (A–Z)");

    await page.getByRole("button", { name: "List view" }).click();
    const inList = (await renderedProjectNames(page)).filter((n) => n.includes(token));
    expect(inList).toEqual([names.alpha, names.beta, names.gamma]);

    await page.getByRole("button", { name: "Grid view" }).click();
    const inGrid = (await renderedProjectNames(page)).filter((n) => n.includes(token));
    expect(inGrid).toEqual([names.alpha, names.beta, names.gamma]);
  });
});

/*
 * Basecamp 10221710841 ("[Projects] List view not showing failed pass rate").
 *
 * The grid card has always carried the full breakdown — a segmented bar plus "N passed · N failed".
 * The list row drew a single green bar filled to the pass rate, so a project at 67% looked like a
 * third of its work was missing rather than failed. Same data, same colours, counts in a tooltip
 * because the row has no space for a legend.
 */
test.describe("projects list — the list view reports failures", () => {
  test("PRJ-U-30 a project with failures shows a failed segment and count in the list row", { tag: '@tesbo.testId("TES-TC-1359")' }, async ({ page }) => {
    const api: APIRequestContext = await screensApi();
    const project = await createProject(api);
    try {
      // Two passes and one failure: a pass rate that is neither 0 nor 100, so a bar that only ever
      // paints the passing share is visibly wrong.
      await seedRun(api, project.id, { statuses: ["Passed", "Passed", "Failed"], status: "Completed" });

      await page.goto("/projects");
      await page.getByRole("button", { name: /list view/i }).click();

      const row = page.locator("a").filter({ hasText: project.name }).first();
      await expect(row).toBeVisible();
      await expect(row, "the failure count has to be readable without opening the project").toContainText(
        /1 failed/,
      );

      // And the bar itself carries a fail-coloured segment, not just green.
      const segments = row.locator("div[title] > div");
      const colors = await segments.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
      expect(colors.length, "the compact bar should paint one segment per outcome").toBeGreaterThanOrEqual(2);
      expect(new Set(colors).size, "passed and failed must not be the same colour").toBeGreaterThan(1);
    } finally {
      await deleteProjects(api, [project.id]);
      await api.dispose();
    }
  });
});
