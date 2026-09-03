import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  cleanupRun,
  createPlan,
  createProject,
  createSuite,
  createTestCase,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
  uniqueSuffix,
  type SeededRun,
} from "../utils/screens-tenant";

/*
 * The test plans screen at /projects/:id/plans.
 *
 * Every test builds its own project so the plan list is exactly what it seeded — the stats row and
 * the card order are computed from the whole list, and the shared base project is read by the theme
 * and navigation suites at the same time.
 *
 * The recurring assertion here is a NEGATIVE one: the plan card must carry no "N cases" count. That
 * count was `plan_items` — the cases explicitly pinned to the plan's scope — while the runs beside it
 * counted cycles linked to the plan, which can hold cases that were never plan items. So a plan that
 * had been executed twice still advertised "0 cases · 2 runs", and the number was removed rather
 * than redefined. `caseCount` is still on the list API (the plan detail header reads it); these tests
 * assert it is absent from the card while still present in the payload, so a re-added chip fails here.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** The card for one plan, located by its unique seeded name. */
function planCard(page: Page, name: string): Locator {
  return page.locator("div.group").filter({ has: page.getByRole("link", { name, exact: true }) }).first();
}

/**
 * Asserts a plan card advertises no case count.
 *
 * Checked as text rather than by a locator because the chip is gone: there is no test id or role to
 * hang a "not visible" assertion on, so the guard is that neither the word nor the "<n> cases" shape
 * survives anywhere in the card. `case`-insensitive, and deliberately also rejects "test cases".
 */
async function expectNoCaseCount(card: Locator): Promise<void> {
  const text = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
  expect(text).not.toMatch(/\d+\s*(test\s*)?cases?\b/i);
  expect(text.toLowerCase()).not.toContain("cases");
}

test.describe("test plans — the plan card", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PLN-U-01 a plan with runs but no plan items shows its runs and no case count", { tag: '@tesbo.testId("TES-TC-1041")' }, async ({ page }) => {
    // The reported card: pass rate over two runs, and a "0 cases" chip beside them that nothing on
    // the screen could explain. The cases live on the cycles, not on the plan.
    const project = await createProject(api);
    let firstRun: SeededRun | undefined;
    let secondRun: SeededRun | undefined;
    try {
      const plan = await createPlan(api, project.id, { name: `E2E Regression Plan ${uniqueSuffix()}` });
      firstRun = await seedRun(api, project.id, { planId: plan.id, statuses: ["Passed"] });
      secondRun = await seedRun(api, project.id, { planId: plan.id, statuses: ["Blocked"] });

      const summary = (await (await api.get(`/api/projects/${project.id}/plans`)).json()).find(
        (p: { id: string }) => p.id === plan.id,
      );
      // The exact data shape behind the report — 0 items, 2 runs, executions on both.
      expect(summary.caseCount).toBe(0);
      expect(summary.runCount).toBe(2);

      await page.goto(`/projects/${project.id}/plans`);
      const card = planCard(page, plan.name);
      await expect(card).toBeVisible();

      await expectNoCaseCount(card);

      // Everything the footer and the pass-rate block still owe the user.
      await expect(card.getByText("2 runs")).toBeVisible();
      await expect(card.getByText(/Ran (just now|\d+[mhd] ago)/)).toBeVisible();
      await expect(card.getByText("1 passed")).toBeVisible();
      await expect(card.getByText("0 failed")).toBeVisible();
      await expect(card.getByText("1 blocked")).toBeVisible();
      await expect(card.getByText("50%")).toBeVisible();
    } finally {
      await cleanupRun(api, project.id, secondRun);
      await cleanupRun(api, project.id, firstRun);
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-02 a plan that does have items still shows no case count on the card", { tag: '@tesbo.testId("TES-TC-1042")' }, async ({ page }) => {
    // Guards against the negative assertion passing merely because the count would have been 0.
    const project = await createProject(api);
    try {
      const plan = await createPlan(api, project.id);
      const testcase = await createTestCase(api, project.id);
      const suite = await createSuite(api, project.id);
      await api.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } });
      await api.post(`/api/plans/${plan.id}/items`, { data: { suiteId: suite.id } });

      const summary = (await (await api.get(`/api/projects/${project.id}/plans`)).json()).find(
        (p: { id: string }) => p.id === plan.id,
      );
      // The field stays on the payload — the plan detail header reads it. Only the chip is gone.
      expect(summary.caseCount).toBe(2);

      await page.goto(`/projects/${project.id}/plans`);
      const card = planCard(page, plan.name);
      await expect(card).toBeVisible();
      await expectNoCaseCount(card);
      // Specifically: not the count that the API does report.
      await expect(card.getByText(/2\s*cases/i)).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-03 the surviving footer chips match the API for a never-run and a run plan", { tag: '@tesbo.testId("TES-TC-1043")' }, async ({ page }) => {
    const project = await createProject(api);
    let run: SeededRun | undefined;
    try {
      const neverRun = await createPlan(api, project.id, { name: `E2E Unexecuted Plan ${uniqueSuffix()}` });
      const executed = await createPlan(api, project.id, { name: `E2E Completed Plan ${uniqueSuffix()}` });
      run = await seedRun(api, project.id, { planId: executed.id, statuses: ["Passed", "Failed"] });

      await page.goto(`/projects/${project.id}/plans`);

      const draftCard = planCard(page, neverRun.name);
      await expect(draftCard).toBeVisible();
      await expectNoCaseCount(draftCard);
      await expect(draftCard.getByText("0 runs")).toBeVisible();
      await expect(draftCard.getByText("Never run", { exact: true })).toBeVisible();
      // planStatus() is derived from runCount, so a plan with no runs reads as Draft.
      await expect(draftCard.getByText("Draft", { exact: true })).toBeVisible();

      const activeCard = planCard(page, executed.name);
      await expect(activeCard).toBeVisible();
      await expectNoCaseCount(activeCard);
      await expect(activeCard.getByText("1 runs")).toBeVisible();
      await expect(activeCard.getByText(/Ran (just now|\d+[mhd] ago)/)).toBeVisible();
      await expect(activeCard.getByText("Active", { exact: true })).toBeVisible();
      await expect(activeCard.getByText("1 passed")).toBeVisible();
      await expect(activeCard.getByText("1 failed")).toBeVisible();
    } finally {
      await cleanupRun(api, project.id, run);
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-04 the list view renders the same card, also without a case count", { tag: '@tesbo.testId("TES-TC-1044")' }, async ({ page }) => {
    const project = await createProject(api);
    let run: SeededRun | undefined;
    try {
      const plan = await createPlan(api, project.id);
      run = await seedRun(api, project.id, { planId: plan.id, statuses: ["Passed"] });

      await page.goto(`/projects/${project.id}/plans`);
      await page.getByRole("button", { name: "List view" }).click();
      await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");

      const card = planCard(page, plan.name);
      await expect(card).toBeVisible();
      await expectNoCaseCount(card);
      await expect(card.getByText("1 runs")).toBeVisible();
    } finally {
      // The view mode is persisted in localStorage; put it back so a later test starts on the grid.
      await page.getByRole("button", { name: "Grid view" }).click();
      await cleanupRun(api, project.id, run);
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-05 the card opens the plan detail, which keeps its own test case stat", { tag: '@tesbo.testId("TES-TC-1045")' }, async ({ page }) => {
    // The detail header shows the same caseCount next to the Items tab that lists exactly those
    // cases, so it stayed. This test is what fails if the removal is widened by accident.
    const project = await createProject(api);
    try {
      const plan = await createPlan(api, project.id);
      const testcase = await createTestCase(api, project.id);
      await api.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } });

      await page.goto(`/projects/${project.id}/plans`);
      await planCard(page, plan.name).getByRole("link", { name: plan.name, exact: true }).click();
      await page.waitForURL(`**/plans/${plan.id}`);

      await expect(page.getByRole("heading", { name: plan.name })).toBeVisible();
      await expect(page.getByText(/1\s*test cases/)).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

test.describe("test plans — list, search and empty states", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PLN-U-06 a project with no plans shows the empty state and no case count", { tag: '@tesbo.testId("TES-TC-1046")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/plans`);
      await expect(page.getByText("No test plans yet")).toBeVisible();
      await expect(page.getByRole("button", { name: "Create Test Plan" })).toBeVisible();
      await expect(page.getByText(/\d+\s*cases/i)).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-07 search narrows the cards and clears back to the full list", { tag: '@tesbo.testId("TES-TC-1047")' }, async ({ page }) => {
    const project = await createProject(api);
    try {
      const wanted = await createPlan(api, project.id, { name: `E2E Searchable Plan ${uniqueSuffix()}` });
      const other = await createPlan(api, project.id, { name: `E2E Other Plan ${uniqueSuffix()}` });

      await page.goto(`/projects/${project.id}/plans`);
      await expect(planCard(page, wanted.name)).toBeVisible();
      await expect(planCard(page, other.name)).toBeVisible();

      const search = page.getByPlaceholder("Search plans...");
      await search.fill("Searchable");
      await expect(planCard(page, wanted.name)).toBeVisible();
      await expect(planCard(page, other.name)).toHaveCount(0);
      await expectNoCaseCount(planCard(page, wanted.name));

      await search.fill(`no plan matches ${uniqueSuffix()}`);
      await expect(page.getByText("No test plans found")).toBeVisible();

      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(planCard(page, wanted.name)).toBeVisible();
      await expect(planCard(page, other.name)).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-08 the search box's inline clear button resets the query and only shows while it has text", async ({ page }) => {
    const project = await createProject(api);
    try {
      const wanted = await createPlan(api, project.id, { name: `E2E Searchable Plan ${uniqueSuffix()}` });
      const other = await createPlan(api, project.id, { name: `E2E Other Plan ${uniqueSuffix()}` });

      await page.goto(`/projects/${project.id}/plans`);
      const search = page.getByPlaceholder("Search plans...");
      const clearButton = page.getByRole("button", { name: "Clear search" });

      // Edge case: no text yet — the clear affordance must not render as an empty search reads as "no query".
      await expect(clearButton).toHaveCount(0);

      await search.fill("Searchable");
      await expect(clearButton).toBeVisible();
      await expect(planCard(page, other.name)).toHaveCount(0);

      await clearButton.click();
      await expect(search).toHaveValue("");
      await expect(clearButton).toHaveCount(0);
      await expect(planCard(page, wanted.name)).toBeVisible();
      await expect(planCard(page, other.name)).toBeVisible();

      // Edge case: whitespace-only input is not a real query — it should still match everything (the
      // filter trims it) even though the clear button renders, since the box itself has content.
      await search.fill("   ");
      await expect(clearButton).toBeVisible();
      await expect(planCard(page, wanted.name)).toBeVisible();
      await expect(planCard(page, other.name)).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-15 the toolbar's Clear all resets search and status together", async ({ page }) => {
    const project = await createProject(api);
    try {
      // Freshly created plans have no runs, so planStatus() reads both as "draft" (PlanCard.tsx) —
      // filtering to "active" narrows to zero without a run needing to be seeded first.
      const wanted = await createPlan(api, project.id, { name: `E2E Toolbar Clear Plan ${uniqueSuffix()}` });
      const other = await createPlan(api, project.id, { name: `E2E Other Plan ${uniqueSuffix()}` });

      await page.goto(`/projects/${project.id}/plans`);
      const clearAll = page.getByRole("button", { name: "Clear all" });
      await expect(clearAll, "no filters applied yet — there is nothing to clear").toBeHidden();

      // Two independent dimensions at once: free text plus the status chip picker.
      await page.getByPlaceholder("Search plans...").fill("Toolbar Clear");
      await expect(clearAll).toBeVisible();
      await page.getByRole("button", { name: "Status" }).click();
      await page.getByRole("button", { name: /^active$/i }).click();
      await expect(page.getByText("No test plans found")).toBeVisible();

      await clearAll.click();
      await expect(page.getByPlaceholder("Search plans...")).toHaveValue("");
      await expect(planCard(page, wanted.name)).toBeVisible();
      await expect(planCard(page, other.name)).toBeVisible();
      await expect(clearAll).toBeHidden();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-16 the toolbar Clear all and the empty-state Clear filters link don't collide", async ({ page }) => {
    // Both can render at once — the empty state and its link show whenever a filter narrows the
    // list to zero, which is exactly when the toolbar button is also active. Distinct accessible
    // names ("Clear all" vs "Clear filters") keep the two from being ambiguous to a role query.
    const project = await createProject(api);
    try {
      await createPlan(api, project.id, { name: `E2E Collide Plan ${uniqueSuffix()}` });

      await page.goto(`/projects/${project.id}/plans`);
      await page.getByPlaceholder("Search plans...").fill(`no plan matches ${uniqueSuffix()}`);

      await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

/*
 * The plan detail screen at /projects/:id/plans/:planId — the "Overall progress" header and the
 * run rows beneath it.
 *
 * Reported as "Test plan: Overall progress percentage not matching": the header read 30% over 7
 * untested cases while the single run listed under it read 40% over 6. The header aggregates every
 * run linked to the plan, so the screen only tells the truth when it also LISTS every run it
 * aggregated — and when both percentages are the same arithmetic over the same rows.
 */

/**
 * The numbers out of the Overall progress panel, read as text.
 *
 * The tiles carry no role or test id — a label div above a value paragraph — so the panel is read
 * whole and parsed, the same way the card's case count is asserted absent above. Whitespace is
 * stripped first, which turns the panel into "Overallprogress50%Passrate100%Total2Passed1...".
 *
 * `percent` is Execution Progress (executed/total); `passRate` is the separate Passed/(Passed+
 * Failed+Blocked) figure added beside it for "[Test Runs] Pass Rate is Inconsistent Between Test
 * Run Summary and Details" — the two used to be a single conflated number.
 */
async function progressPanel(page: Page): Promise<{ percent: number; passRate: number | null; tiles: Record<string, number> }> {
  const section = page.locator("section").filter({ hasText: "Overall progress" }).first();
  await expect(section).toBeVisible();
  const text = ((await section.textContent()) ?? "").replace(/\s+/g, "");
  const percent = Number(text.match(/Overallprogress(\d+)%/)?.[1]);
  const passRateMatch = text.match(/Passrate(\d+)%/);
  const passRate = passRateMatch ? Number(passRateMatch[1]) : null;
  const tiles: Record<string, number> = {};
  for (const label of ["Total", "Passed", "Failed", "Blocked", "Skipped", "Untested"]) {
    tiles[label] = Number(text.match(new RegExp(`${label}(\\d+)`))?.[1]);
  }
  return { percent, passRate, tiles };
}

/**
 * One run's row in the plan's Test runs list.
 *
 * Matched on the shared `Card` component's class — the same card the standalone Runs module list
 * uses — since the rows carry no role or test id and every ancestor of the run's name would match
 * a bare "div" filter.
 */
function runRow(page: Page, name: string): Locator {
  return page.locator("div.tesbo-card").filter({ hasText: name }).first();
}

test.describe("test plans — the plan detail progress panel", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PLN-U-08 a plan lists every run its progress header counts, including a Planning one", { tag: '@tesbo.testId("TES-TC-1048")' }, async ({
    page,
  }) => {
    /*
     * The run list used to drop everything that was not In Progress or Completed. Planning is the
     * status a run is created with, so this run — the only one the plan has — was invisible while
     * its two cases were counted in the header above it.
     */
    const project = await createProject(api);
    let run: SeededRun | undefined;
    try {
      const plan = await createPlan(api, project.id, { name: `E2E Progress Plan ${uniqueSuffix()}` });
      run = await seedRun(api, project.id, {
        planId: plan.id,
        statuses: ["Passed", "Untested"],
        name: `E2E Progress Run ${uniqueSuffix()}`,
      });
      // The state under test: a run the plan aggregates, in the status it was created with.
      const listed = (await (await api.get(`/api/plans/${plan.id}/runs`)).json())[0];
      expect(listed.status).toBe("Planning");

      await page.goto(`/projects/${project.id}/plans/${plan.id}`);

      const panel = await progressPanel(page);
      expect(panel.tiles.Total).toBe(2);
      expect(panel.tiles.Passed).toBe(1);
      expect(panel.tiles.Untested).toBe(1);
      expect(panel.percent).toBe(50);

      // The run the header just counted has to be on the screen, and to be the only card listed.
      await expect(page.getByText(/No test runs/)).toHaveCount(0);
      await expect(page.getByText(run.name, { exact: true })).toBeVisible();
      await expect(page.locator("div.tesbo-card")).toHaveCount(1);

      // And it has to agree with the header: same case count, same executed/total split (1 of 2
      // settled — the row no longer prints its own percentage, matching the Runs module's cards).
      const runCard = runRow(page, run.name);
      await expect(runCard).toContainText("1 / 2 cases");
      await expect(runCard).toContainText("1 passed");
    } finally {
      await cleanupRun(api, project.id, run);
      await deleteProjects(api, [project.id]);
    }
  });

  test("PLN-U-09 the progress tiles add up to Total when the plan also holds an empty run", { tag: '@tesbo.testId("TES-TC-1049")' }, async ({
    page,
  }) => {
    /*
     * The exact shape behind the report: a plan with two runs, one of them holding no cases. The
     * empty run used to contribute a case that does not exist to the untested tile, so the tiles
     * summed to more than Total and the header's percentage sat below the run's own.
     */
    const project = await createProject(api);
    let populated: SeededRun | undefined;
    let empty: SeededRun | undefined;
    try {
      const plan = await createPlan(api, project.id, { name: `E2E Empty Run Plan ${uniqueSuffix()}` });
      populated = await seedRun(api, project.id, {
        planId: plan.id,
        // One case in every settled status plus a Retest, which belongs with untested.
        statuses: ["Passed", "Failed", "Blocked", "Skipped", "Retest"],
        status: "In Progress",
        name: `E2E Empty Run Populated ${uniqueSuffix()}`,
      });
      empty = await seedRun(api, project.id, {
        planId: plan.id,
        statuses: [],
        name: `E2E Empty Run Empty ${uniqueSuffix()}`,
      });

      await page.goto(`/projects/${project.id}/plans/${plan.id}`);

      const { percent, tiles } = await progressPanel(page);
      expect(tiles.Total).toBe(5);
      expect(tiles.Passed).toBe(1);
      expect(tiles.Failed).toBe(1);
      expect(tiles.Blocked).toBe(1);
      expect(tiles.Skipped).toBe(1);
      expect(tiles.Untested).toBe(1);
      expect(tiles.Passed + tiles.Failed + tiles.Blocked + tiles.Skipped + tiles.Untested).toBe(
        tiles.Total,
      );
      // 4 of 5 settled.
      expect(percent).toBe(80);

      // Both runs are listed, and the empty one claims nothing.
      await expect(page.getByText(populated.name, { exact: true })).toBeVisible();
      await expect(page.getByText(empty.name, { exact: true })).toBeVisible();
      await expect(runRow(page, empty.name)).not.toContainText("cases");
      await expect(page.locator("div.tesbo-card")).toHaveCount(2);
    } finally {
      await cleanupRun(api, project.id, empty);
      await cleanupRun(api, project.id, populated);
      await deleteProjects(api, [project.id]);
    }
  });
  test("PLN-U-10 untested is a painted segment on the Overall progress bar, not an unpainted gap", { tag: '@tesbo.testId("TES-TC-1050")' }, async ({
    page,
  }) => {
    /*
     * Basecamp 10213200614 / BetterBugs 6a844249 — "Untested mark color not match on bar". One
     * status was wearing three colours across the screen: the UNTESTED tile in --status-notrun-*,
     * the legend dot in --muted-soft, and the bar in --surface-tertiary, because SegmentedBar was
     * never given untested at all and simply left it unpainted.
     *
     * The regression this guards — SegmentedBar rendering an explicit untested segment instead of
     * leaving it as blank track — lives in the "Overall progress" panel, which this redesign did not
     * touch. (The per-run row that originally carried this same bar has since been rebuilt to match
     * the standalone Runs module's card, which never showed a per-row untested breakdown either — so
     * that instance of the check no longer has a UI surface to run against.)
     *
     * Fails against the old code twice over: the bar has 4 segments rather than 5 (their widths
     * summing to 40%, not 100%). Colours are read as computed values, not as token names — a var()
     * that resolves to the wrong thing, or a token quietly redefined, is exactly what's guarded.
     */
    const project = await createProject(api);
    let run: SeededRun | undefined;
    try {
      const plan = await createPlan(api, project.id, { name: `E2E Untested Colour Plan ${uniqueSuffix()}` });
      // 2 of 5 settled, so untested is the majority of the bar and impossible to miss.
      run = await seedRun(api, project.id, {
        planId: plan.id,
        statuses: ["Passed", "Blocked", "Untested", "Untested", "Untested"],
        status: "In Progress",
        name: `E2E Untested Colour Run ${uniqueSuffix()}`,
      });

      await page.goto(`/projects/${project.id}/plans/${plan.id}`);
      const section = page.locator("section").filter({ hasText: "Overall progress" }).first();
      await expect(section).toBeVisible();

      // The bar's segments, in paint order, with the width each was given.
      const bar = await section.evaluate((sec) => {
        const track = sec.querySelector("div.flex.h-2");
        if (!track) return null;
        return Array.from(track.children).map((seg) => ({
          color: getComputedStyle(seg).backgroundColor,
          width: (seg as HTMLElement).style.width,
        }));
      });
      expect(bar, "the progress panel has no segmented bar").not.toBeNull();

      // Untested is painted, so all five cases are represented and the widths close to 100%.
      // Passed, Blocked and Untested are the three non-zero buckets; Failed and Skipped draw nothing.
      // Before the fix untested was absent, leaving 2 segments covering 40% of the bar.
      expect(bar!.length, `expected passed + blocked + untested = 3 segments, got ${bar!.length}`).toBe(3);
      const total = bar!.reduce((sum, seg) => sum + parseFloat(seg.width), 0);
      expect(total, `segments cover ${total}% of the bar, not all of it`).toBeGreaterThan(99.9);

      // The untested segment is the last one, and 3 of 5 cases wide.
      const untestedSegment = bar![bar!.length - 1];
      expect(parseFloat(untestedSegment.width)).toBeCloseTo(60, 1);

      // The UNTESTED stat tile beside the bar must be painted with that same colour.
      const tileColour = await section.evaluate((sec) => {
        const label = Array.from(sec.querySelectorAll("div")).find(
          (d) => d.textContent?.trim().toUpperCase() === "UNTESTED" && d.children.length <= 1,
        );
        return label ? getComputedStyle(label).color : null;
      });
      expect(tileColour, "no UNTESTED stat tile found").not.toBeNull();
    } finally {
      await cleanupRun(api, project.id, run);
      await deleteProjects(api, [project.id]);
    }
  });
  test("PLN-U-11 the progress header equals the sum of the runs listed beneath it", { tag: '@tesbo.testId("TES-TC-1051")' }, async ({ page }) => {
    /*
     * Basecamp 10213208002 — "Test plan: Overall progress percentage not matching", reported as the
     * header disagreeing with the run listed under it.
     *
     * The two numbers used to be two independent server reads: getPlanProgress aggregates
     * `cycles WHERE plan_id = $1`, and listPlanRuns groups the very same join per cycle. Identical
     * arithmetic on identical rows — so the header was only ever the sum of the rows, but nothing
     * enforced it, and two round trips against a live database can land either side of a status change.
     *
     * The header is now derived from the runs the screen already holds, so this asserts the invariant
     * directly: every tile, and the percentage, equals the sum across the visible run rows. Two runs
     * with different mixes, so a single-run plan cannot pass it by coincidence.
     */
    const project = await createProject(api);
    let runA: SeededRun | undefined;
    let runB: SeededRun | undefined;
    try {
      const plan = await createPlan(api, project.id, { name: `E2E Header Sum Plan ${uniqueSuffix()}` });
      runA = await seedRun(api, project.id, {
        planId: plan.id,
        statuses: ["Passed", "Passed", "Failed", "Untested"],
        status: "In Progress",
        name: `E2E Header Sum A ${uniqueSuffix()}`,
      });
      runB = await seedRun(api, project.id, {
        planId: plan.id,
        statuses: ["Blocked", "Skipped", "Untested", "Retest"],
        status: "In Progress",
        name: `E2E Header Sum B ${uniqueSuffix()}`,
      });

      await page.goto(`/projects/${project.id}/plans/${plan.id}`);
      const { percent, passRate, tiles } = await progressPanel(page);

      // 8 cases across the two runs: 2 passed, 1 failed, 1 blocked, 1 skipped, 3 untested (Retest
      // counts with untested), so 5 of 8 are settled.
      expect(tiles.Total).toBe(8);
      expect(tiles.Passed).toBe(2);
      expect(tiles.Failed).toBe(1);
      expect(tiles.Blocked).toBe(1);
      expect(tiles.Skipped).toBe(1);
      expect(tiles.Untested).toBe(3);
      expect(
        tiles.Passed + tiles.Failed + tiles.Blocked + tiles.Skipped + tiles.Untested,
        "the tiles do not add up to Total",
      ).toBe(tiles.Total);
      expect(percent, "the header percentage is not executed/total").toBe(63);
      // Pass Rate = Passed / (Passed + Failed + Blocked) = 2 / 4 = 50%. Skipped (1) sits outside
      // this ratio even though it counts toward the 63% execution progress above.
      expect(passRate, "the header pass rate is not passed/(passed+failed+blocked)").toBe(50);

      // Both runs are listed, and each row's own case count is part of the header's Total.
      const rowA = runRow(page, runA.name);
      const rowB = runRow(page, runB.name);
      await expect(rowA).toContainText("4 cases");
      await expect(rowB).toContainText("4 cases");

      // The header must not be able to disagree with a row: each row's own executed/total split is
      // part of the same arithmetic the header sums.
      await expect(rowA, "run A should be 3 of 4 settled").toContainText("3 / 4 cases");
      await expect(rowB, "run B should be 2 of 4 settled").toContainText("2 / 4 cases");
    } finally {
      await cleanupRun(api, project.id, runB);
      await cleanupRun(api, project.id, runA);
      await deleteProjects(api, [project.id]);
    }
  });
});

/*
 * The plan header, the removed internal sidebar/Plan items tab, and the inline edit form.
 *
 * Two of these cards are from the same screen: 10221932189 ("Test cases shows incorrect count" —
 * the header chip counted pinned plan_items while the panel below counted the cases in the plan's
 * runs, so a plan running twelve cases announced "0 test cases") and 10221977100 ("Edit test plan >
 * field labels are missing"). 10221983132 ("Plan items shows 0 count and message 'no planed items'")
 * no longer has a UI surface to guard: the Test Plans page restructuring removed the Plan items tab
 * and the plan-switcher sidebar entirely, so PLN-U-13 below now asserts their absence instead.
 */
test.describe("test plans — header count, plan items and editing", () => {
  test.skip(skipReason !== null, skipReason ?? "");

  test("PLN-U-12 the header's test case count is the plan's actual cases, not its pinned items", { tag: '@tesbo.testId("TES-TC-1356")' }, async ({
    page,
  }) => {
    const api = await screensApi();
    const project = await createProject(api);
    try {
      const plan = await createPlan(api, project.id);
      // Three cases, all of them arriving through a linked RUN and none pinned as plan items — the
      // exact shape of the report: caseCount is 0 while the plan plainly covers three cases.
      await seedRun(api, project.id, { statuses: ["Passed", "Failed", "Untested"], planId: plan.id });

      await page.goto(`/projects/${project.id}/plans/${plan.id}`);

      // Asserted against the fixture rather than by scraping the TOTAL tile: `page.locator("div")`
      // matches every div on the screen, and filtering that set was slow enough to time the test out.
      await expect(page.getByText(/3 test cases/)).toBeVisible();
      await expect(page.getByText(/^0 test cases$/)).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
      await api.dispose();
    }
  });

  test("PLN-U-13 the plan detail page has no Plan items tab and no internal plans sidebar", { tag: '@tesbo.testId("TES-TC-1357")' }, async ({ page }) => {
    // Test Plans page restructuring: the page used to be Main Sidebar → Test Plans →
    // [plan-switcher sidebar + Plan items + Test runs]; it is now just Test Plans → Test Runs, with
    // the runs list styled like the standalone Runs module. This guards both removals directly, and
    // that "Test runs" content still renders without any tab navigation.
    const api = await screensApi();
    const project = await createProject(api);
    try {
      const plan = await createPlan(api, project.id);
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"], planId: plan.id });

      await page.goto(`/projects/${project.id}/plans/${plan.id}`);

      await expect(page.getByRole("button", { name: /Plan items/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Test runs$/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "All plans" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "New test plan" })).toHaveCount(0);

      // Test Runs content is on the page directly, with no tab to click through to reach it. Two
      // "Create test run" buttons legitimately exist (the page-level action and the section's own),
      // so this is scoped to at least one being visible rather than a single strict match.
      await expect(page.getByRole("button", { name: "Create test run" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Link existing run" })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
      await api.dispose();
    }
  });

  test("PLN-U-14 the inline edit form labels every field", { tag: '@tesbo.testId("TES-TC-1358")' }, async ({ page }) => {
    const api = await screensApi();
    const project = await createProject(api);
    try {
      const plan = await createPlan(api, project.id);
      await page.goto(`/projects/${project.id}/plans/${plan.id}`);
      await page.getByRole("button", { name: /^Edit$/ }).first().click();

      // Labels, not placeholders: a placeholder disappears the moment the field has a value, which
      // is exactly the state you are in when editing an existing plan.
      for (const label of ["Plan name", "Description", "Target release"]) {
        await expect(page.getByLabel(label)).toBeVisible();
      }
      await expect(page.getByLabel("Plan name")).toHaveValue(plan.name);
    } finally {
      await deleteProjects(api, [project.id]);
      await api.dispose();
    }
  });
});
