import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  createBug,
  createProject,
  createSuite,
  createTestCase,
  deleteProjects,
  getDashboard,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * The project home screen at /projects/:id/dashboard.
 *
 * Every test builds its own project so the arithmetic on the cards is deterministic — the shared
 * base project is read by the theme and navigation suites at the same time.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/**
 * A stat card, located by the label under its value.
 *
 * Filtered on containing a <p> as well as the label: the sidebar's nav entries are also
 * /projects/... links carrying these same words ("Test cases", "Bugs"), and they come first in the
 * DOM — without this the helper silently measures the navigation instead of the dashboard.
 */
function statCard(page: Page, label: string | RegExp): Locator {
  return page
    .locator('a[href*="/projects/"]')
    .filter({ has: page.locator("p") })
    .filter({ hasText: label })
    .first();
}

/** The big number a stat card leads with. */
async function statValue(card: Locator): Promise<string> {
  return card.evaluate((el) => el.querySelector("p")?.textContent?.trim() ?? "");
}

test.describe("project dashboard — header and actions", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("DSH-U-01/02 the header names the project and breadcrumbs back to the list", { tag: '@tesbo.testId("TES-TC-725")' }, async ({ page }) => {
    const described = await createProject(api, { description: "Dashboard header description" });
    const bare = await createProject(api);
    try {
      await page.goto(`/projects/${described.id}/dashboard`);
      await expect(page.getByRole("heading", { name: described.name })).toBeVisible();
      await expect(page.getByText("Dashboard header description")).toBeVisible();
      await expect(page.getByText(described.key, { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Projects", exact: true }).first().click();
      await page.waitForURL("**/projects");

      // With no description there is simply no subtitle — not an empty line or a placeholder.
      await page.goto(`/projects/${bare.id}/dashboard`);
      await expect(page.getByRole("heading", { name: bare.name })).toBeVisible();
      await expect(page.getByText("Dashboard header description")).toHaveCount(0);
    } finally {
      await deleteProjects(api, [described.id, bare.id]);
    }
  });

  test("DSH-U-03 New run opens the create-run form on arrival", { tag: '@tesbo.testId("TES-TC-726")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);
      await page.getByRole("link", { name: "New run" }).click();

      await page.waitForURL(/\/cycles\?create=1$/);
      // The point of the ?create=1 link is that the user lands on an open form, not on the list.
      await expect(page.getByRole("heading", { name: "Create Test Run" })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-04 New test plan opens the create-plan form on arrival", { tag: '@tesbo.testId("TES-TC-727")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);
      await page.getByRole("link", { name: "New test plan" }).click();

      await page.waitForURL(/\/plans\?create=1$/);
      await expect(page.getByPlaceholder("e.g. Sprint 12 Regression")).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-05/06 both actions are keyboard reachable and work on an empty project", { tag: '@tesbo.testId("TES-TC-728")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);

      const newRun = page.getByRole("link", { name: "New run" });
      const newPlan = page.getByRole("link", { name: "New test plan" });
      await expect(newRun).toBeVisible();
      await expect(newPlan).toBeVisible();

      await newPlan.focus();
      await expect(newPlan).toBeFocused();
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/plans\?create=1$/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

test.describe("project dashboard — the stat cards", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("DSH-U-07/08 the test case card counts what the API counts and flags this week's additions", { tag: '@tesbo.testId("TES-TC-729")' }, async ({
    page,
  }) => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      const summary = await getDashboard(api, project.id);

      await page.goto(`/projects/${project.id}/dashboard`);
      const card = statCard(page, "Test cases");
      expect(await statValue(card)).toBe(String(summary.testCases.total));
      await expect(card).toContainText(`+${summary.testCases.addedThisWeek} this week`);

      await card.click();
      await page.waitForURL(/\/testcases$/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-09 the pass rate card shows a percentage and a proportional bar", { tag: '@tesbo.testId("TES-TC-730")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Passed", "Passed", "Failed"], status: "Completed" });
      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.value).toBe(75);

      await page.goto(`/projects/${project.id}/dashboard`);
      const card = statCard(page, "Pass rate");
      expect(await statValue(card)).toBe("75%");

      await card.click();
      await page.waitForURL(/\/reports$/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-09 a project with nothing executed shows a dash and no bar", { tag: '@tesbo.testId("TES-TC-731")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Untested", "Untested"] });

      await page.goto(`/projects/${project.id}/dashboard`);
      // Unlike the projects list, this screen correctly declines to report a rate.
      expect(await statValue(statCard(page, "Pass rate"))).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-09b Execution progress is its own card, separate from Pass rate", { tag: '@tesbo.testId("TES-TC-731-1")' }, async ({ page }) => {
    /*
     * "[Test Runs] Pass Rate is Inconsistent Between Test Run Summary and Details" — Execution
     * Progress (how much of the project has any recorded result, Skipped included) and Pass Rate
     * (how much of what settled came back green, Skipped excluded) answer different questions and
     * must never be shown as one number. Skipped is chosen deliberately: it moves the two cards in
     * opposite directions from a run with nothing but Passed/Failed cases.
     */
    const project = await createProject(api);
    try {
      // 1 Passed, 1 Skipped, 1 Untested: the one settled case passed (100% pass rate), but only
      // 2 of the 3 cases have any result at all (67% execution progress) — the two cards disagree
      // on purpose here, which is the point.
      await seedRun(api, project.id, { statuses: ["Passed", "Skipped", "Untested"], status: "Completed" });
      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.value).toBe(100);
      expect(summary.executionProgress.value).toBe(67);

      await page.goto(`/projects/${project.id}/dashboard`);
      expect(await statValue(statCard(page, "Pass rate"))).toBe("100%");
      expect(await statValue(statCard(page, "Execution progress"))).toBe("67%");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-10 the trend chip is absent until both comparison windows have executions", { tag: '@tesbo.testId("TES-TC-732")' }, async ({
    page,
  }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"], status: "Completed" });
      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.deltaThisWeek).toBeNull();

      await page.goto(`/projects/${project.id}/dashboard`);
      await expect(statCard(page, "Pass rate")).not.toContainText("this week");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-11 the open bugs card totals by severity and calls out criticals", { tag: '@tesbo.testId("TES-TC-733")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createBug(api, project.id, { severity: "Critical" });
      await createBug(api, project.id, { severity: "High" });
      await createBug(api, project.id, { severity: "Low", status: "Closed" });

      await page.goto(`/projects/${project.id}/dashboard`);
      const card = statCard(page, "Open bugs");
      expect(await statValue(card)).toBe("2");
      await expect(card).toContainText("1 critical");

      await card.click();
      await page.waitForURL(/\/bugs$/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-11 with no criticals the card carries no critical chip", { tag: '@tesbo.testId("TES-TC-734")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createBug(api, project.id, { severity: "Medium" });

      await page.goto(`/projects/${project.id}/dashboard`);
      const card = statCard(page, "Open bugs");
      expect(await statValue(card)).toBe("1");
      await expect(card).not.toContainText("critical");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-12 the coverage card explains itself when no requirements are linked", { tag: '@tesbo.testId("TES-TC-735")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);
      const card = statCard(page, "Test coverage");

      expect(await statValue(card)).toBe("—");
      await expect(card).toContainText("Test coverage — no requirements linked");
      await expect(card).not.toContainText("reqs");

      await card.click();
      await page.waitForURL(/\/requirements$/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-13 plans, suites and active runs match the API", { tag: '@tesbo.testId("TES-TC-736")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createSuite(api, project.id);
      await api.post(`/api/projects/${project.id}/plans`, { data: { name: `E2E Dash Plan ${uniqueSuffix()}` } });
      await seedRun(api, project.id, { statuses: ["Passed"], status: "In Progress" });
      const summary = await getDashboard(api, project.id);

      await page.goto(`/projects/${project.id}/dashboard`);
      expect(await statValue(statCard(page, "Test plans"))).toBe(String(summary.plans));
      expect(await statValue(statCard(page, "Suites"))).toBe(String(summary.suites));

      const activeRuns = statCard(page, "Active runs");
      expect(await statValue(activeRuns)).toBe(String(summary.activeRuns));
      await expect(activeRuns).toContainText("running");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-13 the running chip is absent when no run is in progress", { tag: '@tesbo.testId("TES-TC-737")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed"], status: "Completed" });

      await page.goto(`/projects/${project.id}/dashboard`);
      const activeRuns = statCard(page, "Active runs");
      expect(await statValue(activeRuns)).toBe("0");
      await expect(activeRuns).not.toContainText("running");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-14 every stat card links to the screen behind it", { tag: '@tesbo.testId("TES-TC-738")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);

      const expected: [string, string][] = [
        ["Test cases", "/testcases"],
        ["Pass rate", "/reports"],
        ["Open bugs", "/bugs"],
        ["Test coverage", "/requirements"],
        ["Test plans", "/plans"],
        ["Suites", "/testcases"],
        ["Active runs", "/cycles"],
      ];
      for (const [label, target] of expected) {
        await expect(statCard(page, label)).toHaveAttribute("href", `/projects/${project.id}${target}`);
      }
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  /*
   * Basecamp 10226337869 — "[Project Home] Label should be 'Test Plans' not plans".
   *
   * The feature is called Test plans everywhere it is named — the sidebar entry, the /plans screen
   * heading, the activity type filter — and only these two dashboard tiles called it "Plans". The
   * assertion is on the tile's own <p>, exact: hasText matching is case-insensitive substring, so
   * "Test plans" satisfies a filter written for "Plans" and a revert would otherwise pass here.
   *
   * Sentence case, matching the sidebar and the page heading, rather than the card's literal "Test
   * Plans" — the tile sits between "Suites" and "Active runs" and Title Case would be the odd one.
   */
  test("DSH-U-15 the plans tile is labelled Test plans, exactly as the sidebar names it", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);

      const card = statCard(page, "Test plans");
      await expect(card.locator("p", { hasText: /^Test plans$/ })).toHaveCount(1);
      // No tile is left calling it just "Plans".
      await expect(page.locator('a[href*="/projects/"] p', { hasText: /^Plans$/ })).toHaveCount(0);
      // Same words as the navigation entry that leads to the same screen.
      await expect(page.getByRole("link", { name: "Test plans" }).first()).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  /*
   * The workspace dashboard at /dashboard carries the same count cards and had the same problem,
   * reported separately as Basecamp 10226480729 ("[workspace Dashboard] need to update lables").
   *
   * The card asked for "Total Suites", "Test Plans" and "Test Runs", and it was right to: the
   * projects list has used "Total Suites" all along, so that is the product's existing vocabulary
   * and the inconsistency the reporter hit. An earlier pass here used "Test suites" for family
   * consistency, which just moved the inconsistency somewhere else. "Cycles" was the real offender
   * either way — internal vocabulary on screen, when every other surface calls them runs.
   */
  test("DSH-U-15 the workspace dashboard tiles match the vocabulary the rest of the app uses", async ({ page }) => {
    await page.goto("/dashboard");
    for (const label of ["Test cases", "Total Suites", "Test plans", "Test runs"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    // None of the pre-fix wording survives anywhere on the screen.
    for (const stale of [/^Plans$/, /^Suites$/, /^Cycles$/]) {
      await expect(page.getByText(stale)).toHaveCount(0);
    }
  });

  /*
   * Basecamp 10221720616 ("[Dashboard] Executaion progress bar colours are not visible").
   *
   * The workspace dashboard's execution breakdown painted each bar with the same class it used for
   * the status badge — a hardcoded Tailwind 100-level pastel (bg-emerald-100 and friends) on a
   * --surface-tertiary track. The bar was rendered; it simply could not be seen, and in dark mode
   * the pastels did not follow the theme at all. The fill is the solid status dot colour now.
   */
  test("DSH-U-17 the workspace execution bars are painted in a visible status colour", async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Failed", "Blocked"], status: "Completed" });

      await page.goto("/dashboard");
      await expect(page.getByText("Execution status")).toBeVisible();

      const fills = page.locator("div.h-2.overflow-hidden.rounded-full > div");
      const count = await fills.count();
      expect(count, "one bar per execution status").toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const background = await fills.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor);
        // A transparent or unset fill is the original defect; so is a bar that inherits the track.
        expect(background, `bar ${i} has no colour of its own`).not.toBe("rgba(0, 0, 0, 0)");
        expect(background).not.toBe("transparent");
      }

      // The four bars must not all be the same colour either — that was the other half of it.
      const colors = await fills.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
      expect(new Set(colors).size, `every bar shares one colour: ${colors.join(", ")}`).toBeGreaterThan(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-16 a large count doesn't break the card layout", { tag: '@tesbo.testId("TES-TC-739")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      // Not 10,000 real test cases — the layout question is about the rendered string's width.
      await page.goto(`/projects/${project.id}/dashboard`);
      const card = statCard(page, "Test cases");
      await card.evaluate((el) => {
        const value = el.querySelector("p");
        if (value) value.textContent = "123456";
      });

      const box = await card.boundingBox();
      const body = await page.locator("body").boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(body!.width + 1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

test.describe("project dashboard — runs, bugs and activity panels", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("DSH-U-18/24/28 an untouched project says so in each panel rather than showing zeros", { tag: '@tesbo.testId("TES-TC-740")' }, async ({
    page,
  }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);

      await expect(page.getByText("No test runs yet.")).toBeVisible();
      await expect(page.getByText("No open bugs right now.")).toBeVisible();
      await expect(page.getByText("0 open")).toBeVisible();
      // Not "No activity yet." — creating a project writes a project_created entry, so the feed
      // legitimately has one row from the moment the project exists. Note the missing article:
      // ENTITY_LABEL has no "project" key, so describeActivity falls back to the bare entity type
      // and reads "created project" where every other kind reads "created a ...".
      await expect(page.getByText("created project")).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-17 the runs panel shows at most four runs, newest first", { tag: '@tesbo.testId("TES-TC-741")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const names: string[] = [];
      for (let i = 0; i < 5; i++) {
        const run = await seedRun(api, project.id, { statuses: ["Passed"] });
        names.push(run.name);
      }

      await page.goto(`/projects/${project.id}/dashboard`);
      const runLinks = page.locator(`a[href*="/cycles/"]`);
      await expect(runLinks).toHaveCount(4);

      // The oldest of the five is the one left out.
      await expect(page.getByText(names[0], { exact: true })).toHaveCount(0);
      await expect(page.getByText(names[4], { exact: true })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-19/20 a run row reports its status, counts and progress", { tag: '@tesbo.testId("TES-TC-742")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Failed", "Blocked", "Untested"],
        status: "In Progress",
      });

      await page.goto(`/projects/${project.id}/dashboard`);
      const row = page.locator(`a[href*="/cycles/${run.cycleId}"]`);

      await expect(row).toContainText(run.name);
      await expect(row).toContainText("In Progress");
      await expect(row).toContainText("2 passed");
      await expect(row).toContainText("1 failed");
      await expect(row).toContainText("1 blocked");
      // Four of the five have been executed; the untested one has not.
      await expect(row).toContainText("4/5 executed");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-21 a run with no test cases renders without NaN or a negative count", { tag: '@tesbo.testId("TES-TC-743")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: [] });

      await page.goto(`/projects/${project.id}/dashboard`);
      const row = page.locator(`a[href*="/cycles/${run.cycleId}"]`);

      // The backend's LEFT JOIN reports untested: 1 for an empty cycle, so executed would be -1
      // without the clamp in the page.
      await expect(row).toContainText("0/0 executed");
      await expect(row).not.toContainText("NaN");
      await expect(row).not.toContainText("-1");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-22 a run row opens the run, and View all opens the list", { tag: '@tesbo.testId("TES-TC-744")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: ["Passed"] });

      await page.goto(`/projects/${project.id}/dashboard`);
      await page.getByRole("link", { name: "View all" }).click();
      await page.waitForURL(/\/cycles$/);

      await page.goto(`/projects/${project.id}/dashboard`);
      await page.locator(`a[href*="/cycles/${run.cycleId}"]`).click();
      await page.waitForURL(new RegExp(`/cycles/${run.cycleId}$`));
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-23 a long run name is truncated rather than breaking the row", { tag: '@tesbo.testId("TES-TC-745")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const longName = `E2E Dash ${"Very Long Run Name ".repeat(8)}${uniqueSuffix()}`;
      const run = await seedRun(api, project.id, { statuses: ["Passed"], name: longName });

      await page.goto(`/projects/${project.id}/dashboard`);
      const row = page.locator(`a[href*="/cycles/${run.cycleId}"]`);
      const rowBox = await row.boundingBox();
      const bodyBox = await page.locator("body").boundingBox();

      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(bodyBox!.width + 1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-25/26/27 the severity panel lists all four bands against the open total", { tag: '@tesbo.testId("TES-TC-746")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createBug(api, project.id, { severity: "Critical" });
      await createBug(api, project.id, { severity: "Critical" });
      await createBug(api, project.id, { severity: "Medium" });

      await page.goto(`/projects/${project.id}/dashboard`);
      await expect(page.getByText("Bug severity breakdown")).toBeVisible();

      // Exact match: the open-bugs stat card's chip says "2 critical" in lower case, so only the
      // severity rows match these capitalised labels.
      for (const band of ["Critical", "High", "Medium", "Low"]) {
        await expect(page.getByText(band, { exact: true })).toBeVisible();
      }
      await expect(page.getByText("3 open")).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-29/30 the activity feed describes real events and counts what it shows", { tag: '@tesbo.testId("TES-TC-747")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const testcase = await createTestCase(api, project.id, { title: `E2E Dash Activity ${uniqueSuffix()}` });

      await page.goto(`/projects/${project.id}/dashboard`);
      await expect(page.getByText("Recent activity")).toBeVisible();

      // entityName carries the external ID as well as the title ("SCR-TC-1 - <title>"), so the
      // sentence and the title are asserted separately rather than as one concatenation.
      const entry = page.getByText("created a test case:");
      await expect(entry).toBeVisible();
      await expect(entry).toContainText(testcase.title);
      await expect(page.getByText("No activity yet.")).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-35 the activity feed scrolls inside its own panel", { tag: '@tesbo.testId("TES-TC-748")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      for (let i = 0; i < 12; i++) await createTestCase(api, project.id);

      await page.goto(`/projects/${project.id}/dashboard`);
      // The feed is capped at 10 items and max-h-[640px]; the page must not grow to fit them.
      const scroller = page.locator("div.overflow-y-auto").last();
      const box = await scroller.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(640);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-36/45 the dashboard reflects work done elsewhere after a reload", { tag: '@tesbo.testId("TES-TC-749")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);
      expect(await statValue(statCard(page, "Test cases"))).toBe("0");

      await createTestCase(api, project.id);
      await page.reload();

      expect(await statValue(statCard(page, "Test cases"))).toBe("1");
      await expect(page.getByText("No activity yet.")).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

test.describe("project dashboard — loading, errors and navigation", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("DSH-U-37 the loading state is replaced by the dashboard", { tag: '@tesbo.testId("TES-TC-750")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/dashboard`);
      await expect(page.getByText("Recent test runs")).toBeVisible();
      await expect(page.getByText("Loading project…")).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-38 a project that can't be fetched sends the user back to the list", { tag: '@tesbo.testId("TES-TC-751")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.route(
        (url) => new RegExp(`/api/projects/${project.id}$`).test(url.pathname),
        (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
      );
      await page.goto(`/projects/${project.id}/dashboard`);

      await page.waitForURL("**/projects");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-39 an unauthenticated visitor is sent to login", { tag: '@tesbo.testId("TES-TC-752")' }, async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anonymous = await context.newPage();
      await anonymous.goto(`/projects/${tenant!.projectId}/dashboard`);
      await anonymous.waitForURL("**/login");
    } finally {
      await context.close();
    }
  });

  test("DSH-U-40 a project from another workspace leaks nothing", { tag: '@tesbo.testId("TES-TC-753")' }, async ({ page }) => {
    // Account A's smoke project, which this tenant has no access to.
    await page.goto("/projects/00000000-0000-0000-0000-000000000000/dashboard");
    await page.waitForURL("**/projects", { timeout: 15_000 });
  });

  test("DSH-U-41/42 navigating between projects never shows the previous project's data", { tag: '@tesbo.testId("TES-TC-754")' }, async ({
    page,
  }) => {
    const first = await createProject(api);
    const second = await createProject(api);
    try {
      await createTestCase(api, first.id);
      await createTestCase(api, first.id);
      await createTestCase(api, first.id);

      await page.goto(`/projects/${first.id}/dashboard`);
      await expect(page.getByRole("heading", { name: first.name })).toBeVisible();
      expect(await statValue(statCard(page, "Test cases"))).toBe("3");

      // Straight from one dashboard to the other — the page component stays mounted, so the
      // cancelled-request guard is what stops the first project's numbers rendering under the
      // second project's name.
      await page.goto(`/projects/${second.id}/dashboard`);
      await expect(page.getByRole("heading", { name: second.name })).toBeVisible();
      expect(await statValue(statCard(page, "Test cases"))).toBe("0");
      await expect(page.getByRole("heading", { name: first.name })).toHaveCount(0);
    } finally {
      await deleteProjects(api, [first.id, second.id]);
    }
  });

  test("DSH-U-43 going back from a project returns to the projects list", { tag: '@tesbo.testId("TES-TC-755")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await page.locator(`a[href="/projects/${project.id}/dashboard"]`).first().click();
      await page.waitForURL(`**/projects/${project.id}/dashboard`);

      await page.goBack();
      await page.waitForURL("**/projects");
      await expect(page.getByText("Tesbo Test Manager Projects")).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-44 reloading the dashboard renders the same thing", { tag: '@tesbo.testId("TES-TC-756")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id);
      await page.goto(`/projects/${project.id}/dashboard`);
      const before = await statValue(statCard(page, "Test cases"));

      await page.reload();
      await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
      expect(await statValue(statCard(page, "Test cases"))).toBe(before);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-05 the dashboard renders without client-side errors", { tag: '@tesbo.testId("TES-TC-757")' }, async ({ page }) => {
    const project = await createProject(api);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"], status: "Completed" });
      await createBug(api, project.id, { severity: "High" });

      await page.goto(`/projects/${project.id}/dashboard`);
      await expect(page.getByText("Recent test runs")).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-U-15 the cards fit the viewport at common desktop widths", { tag: '@tesbo.testId("TES-TC-758")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      for (const width of [1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/projects/${project.id}/dashboard`);
        await expect(page.getByText("Recent test runs")).toBeVisible();

        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflows, `the dashboard scrolls horizontally at ${width}px`).toBe(false);
      }
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});
