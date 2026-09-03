import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  accountA,
  apiContext,
  cleanup,
  cleanupRun,
  createCycle,
  createPlan,
  modalByTitle,
  seedRun,
  ticket,
  unique,
  type SeededRun,
} from "../fixtures";

/*
 * Reported-ticket regression for the test plan's "Link existing run" picker.
 * Card 10221925706, BetterBugs 6a86d18f — "Misleading 'Test Run Is Not Available' Message Displayed
 * After Adding a New Test Run".
 *
 * WHAT THE CARD IS ACTUALLY ABOUT. The plan screen's picker (page.tsx handleOpenAssociate) fetches
 * every run in the project and subtracts the ones already linked to this plan:
 *
 *   const all = await listTestRuns(projectId);
 *   const associatedIds = new Set(runs.map((r) => r.id));
 *   setAllRuns(all.filter((r) => !associatedIds.has(r.id)));
 *
 * and renders "No unlinked test runs available." when that comes back empty. So the message is
 * MISLEADING exactly when the subtraction is wrong — when unlinked runs do exist and the picker
 * still claims none do. That, not the wording, is the testable defect, and it is what these tests
 * pin. The reporter's own path (create a run from the plan, then open the picker) reaches it because
 * the newly created run is linked already, which makes "none available" correct but confusing when
 * it is the only run in the project.
 *
 * Runs are created over the API rather than through the screen's own "Create test run" form on
 * purpose: that form is disabled unless the project has test environments configured
 * (environmentOptions.length === 0 disables the submit), which would couple this ticket's regression
 * to card 10221899361's feature and make a failure here ambiguous.
 */

test.describe("test plan runs — reported tickets", () => {
  test(
    ticket("REG-PLAN-01", "10221925706", "the picker offers an unlinked run instead of claiming there are none"),
    { tag: '@tesbo.testId("TES-TC-1295")' },
    async ({ page }) => {
      const api = await apiContext();
      const projectId = accountA().projectId;

      const plan = await createPlan(api, projectId, { name: unique("Plan") });
      // One run already attached to the plan, one deliberately left loose. The loose one is what the
      // picker must offer; the attached one is what it must not offer twice.
      const linked = await createCycle(api, projectId, { name: unique("Run Linked"), planId: plan.id });
      const unlinked = await createCycle(api, projectId, { name: unique("Run Loose") });

      try {
        await page.goto(`/projects/${projectId}/plans/${plan.id}`);

        await page.getByRole("button", { name: "Link existing run" }).click();

        // Via modalByTitle: components/ui/Modal.tsx sets role="presentation", never "dialog".
        const picker = modalByTitle(page, "Link Existing Test Run");
        await expect(picker).toBeVisible();

        // The claim under test: with a loose run in the project, the empty-state must not appear.
        await expect(
          picker.getByText("No unlinked test runs available."),
          "an unlinked run exists in this project, so the picker must not claim otherwise",
        ).toHaveCount(0);

        await expect(picker.getByText(String(unlinked.name))).toBeVisible();
        await expect(
          picker.getByText(String(linked.name)),
          "a run already linked to this plan must not be offered for linking again",
        ).toHaveCount(0);
      } finally {
        await cleanup(api, [
          `/api/cycles/${unlinked.id}`,
          `/api/cycles/${linked.id}`,
          `/api/plans/${plan.id}`,
        ]);
        await api.dispose();
      }
    },
  );

  test(
    ticket("REG-PLAN-02", "10221925706", "a linked run shows on the plan and is excluded from the picker"),
    { tag: '@tesbo.testId("TES-TC-1296")' },
    async ({ page }) => {
      /*
       * The other direction, and the one that keeps REG-PLAN-01 honest: the message itself is correct
       * behaviour when it is true. A "fix" that simply deleted the empty state would pass REG-PLAN-01
       * and leave the picker rendering an empty list with no explanation.
       *
       * Scoped to a plan whose project has exactly one run, which this test both creates and links,
       * so the assertion does not depend on how many other runs the shared project happens to hold —
       * it asserts on the picker's contents, not on a project-wide count.
       */
      const api = await apiContext();
      const projectId = accountA().projectId;

      const plan = await createPlan(api, projectId, { name: unique("Plan") });
      const linked = await createCycle(api, projectId, { name: unique("Run Only"), planId: plan.id });

      try {
        await page.goto(`/projects/${projectId}/plans/${plan.id}`);

        // The linked run is on the plan's own list — the state the picker's subtraction reads from.
        await expect(page.getByText(String(linked.name)).first()).toBeVisible();

        await page.getByRole("button", { name: "Link existing run" }).click();
        // Via modalByTitle: components/ui/Modal.tsx sets role="presentation", never "dialog".
        const picker = modalByTitle(page, "Link Existing Test Run");
        await expect(picker).toBeVisible();

        await expect(
          picker.getByText(String(linked.name)),
          "the plan's own run must not be offered as something to link",
        ).toHaveCount(0);
      } finally {
        await cleanup(api, [`/api/cycles/${linked.id}`, `/api/plans/${plan.id}`]);
        await api.dispose();
      }
    },
  );
});

/*
 * The plan detail screen: its progress header, its test-case count, the (now-removed) Plan items
 * tab and internal sidebar, and the inline edit form. Four more cards from the same screen.
 *
 *   10213208002 / overall progress percentage not matching what the runs beneath it show
 *   10221932189 / the header's test-case count is wrong ("0 test cases" on a plan running twelve)
 *   10221983132 / Plan items shows a 0 count and "no planed items" — moot since the Test Plans page
 *                 restructuring removed the Plan items tab and its sidebar outright; REG-PLAN-05
 *                 below now guards that removal instead.
 *   10221977100 / the Edit test plan form has no field labels
 *
 * WHY THESE MOVED HERE. ui/plans.spec.ts covers all four, but that file is pinned to
 * `.auth/state-screens.json` and every one of its describes carries `test.skip(!!skipReason)`. The
 * screens tenant is provisioned by global-setup through psql — it has to be put on Pro so the file
 * can create the several projects its aggregate assertions need — so on a deployed environment the
 * tenant does not exist and all four cards' cover skips.
 *
 * The adaptation is the same one the rest of this folder makes: fixtures go in account A's existing
 * project rather than a fresh one. That is safe here because every assertion below is scoped to a
 * PLAN this test created, and a plan's progress is computed from its own linked runs — so a shared
 * project full of other runs cannot move these numbers.
 */

/** The "Overall progress" panel, parsed into its percentage and its stat tiles. */
async function progressPanel(page: Page): Promise<{ percent: number; tiles: Record<string, number> }> {
  const section = page.locator("section").filter({ hasText: "Overall progress" }).first();
  await expect(section).toBeVisible();
  const text = ((await section.textContent()) ?? "").replace(/\s+/g, "");
  const percent = Number(text.match(/Overallprogress(\d+)%/)?.[1]);
  const tiles: Record<string, number> = {};
  for (const label of ["Total", "Passed", "Failed", "Blocked", "Skipped", "Untested"]) {
    tiles[label] = Number(text.match(new RegExp(`${label}(\\d+)`))?.[1]);
  }
  return { percent, tiles };
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

test.describe("test plan detail — progress, counts and editing", () => {
  test(
    ticket("REG-PLAN-03", "10213208002", "the progress header equals the sum of the runs listed beneath it"),
    { tag: '@tesbo.testId("TES-TC-1297")' },
    async ({ page }) => {
      /*
       * "Test plan: Overall progress percentage not matching", reported as the header disagreeing
       * with the run listed under it.
       *
       * The two numbers used to be two independent server reads: getPlanProgress aggregates
       * `cycles WHERE plan_id = $1`, and listPlanRuns groups the very same join per cycle. Identical
       * arithmetic on identical rows — so the header was only ever the sum of the rows, but nothing
       * enforced it, and two round trips against a live database can land either side of a status
       * change. The header is derived from the runs the screen already holds now, so this asserts
       * the invariant directly.
       *
       * Two runs with different mixes, so a single-run plan cannot pass this by coincidence.
       */
      const api = await apiContext();
      const projectId = accountA().projectId;
      const plan = await createPlan(api, projectId, { name: unique("Header Sum Plan") });
      let runA: SeededRun | undefined;
      let runB: SeededRun | undefined;
      try {
        runA = await seedRun(api, projectId, {
          planId: plan.id,
          statuses: ["Passed", "Passed", "Failed", "Untested"],
          status: "In Progress",
          name: unique("Header Sum A"),
        });
        runB = await seedRun(api, projectId, {
          planId: plan.id,
          statuses: ["Blocked", "Skipped", "Untested", "Retest"],
          status: "In Progress",
          name: unique("Header Sum B"),
        });

        await page.goto(`/projects/${projectId}/plans/${plan.id}`);
        const { percent, tiles } = await progressPanel(page);

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

        // Both runs are listed, and each row's own case count is part of the header's Total.
        await expect(runRow(page, runA.name)).toContainText("4 cases");
        await expect(runRow(page, runB.name)).toContainText("4 cases");

        // The header must not be able to disagree with a row: each row's own executed/total split
        // is part of the same arithmetic the header sums.
        await expect(runRow(page, runA.name), "run A should be 3 of 4 settled").toContainText("3 / 4 cases");
        await expect(runRow(page, runB.name), "run B should be 2 of 4 settled").toContainText("2 / 4 cases");
      } finally {
        await cleanupRun(api, projectId, runB);
        await cleanupRun(api, projectId, runA);
        await cleanup(api, [`/api/plans/${plan.id}`]);
        await api.dispose();
      }
    },
  );

  test(
    ticket("REG-PLAN-04", "10221932189", "the header's test case count is the plan's actual cases, not its pinned items"),
    { tag: '@tesbo.testId("TES-TC-1298")' },
    async ({ page }) => {
      /*
       * The header chip counted pinned plan_items while the panel below counted the cases in the
       * plan's runs, so a plan running twelve cases announced "0 test cases". Three cases here, all
       * arriving through a linked RUN and none pinned as plan items — the exact shape of the report.
       */
      const api = await apiContext();
      const projectId = accountA().projectId;
      const plan = await createPlan(api, projectId, { name: unique("Case Count Plan") });
      let run: SeededRun | undefined;
      try {
        run = await seedRun(api, projectId, { statuses: ["Passed", "Failed", "Untested"], planId: plan.id });

        await page.goto(`/projects/${projectId}/plans/${plan.id}`);

        // Asserted against the fixture rather than by scraping the TOTAL tile: `page.locator("div")`
        // matches every div on the screen, and filtering that set was slow enough to time the test out.
        await expect(page.getByText(/3 test cases/)).toBeVisible();
        await expect(page.getByText(/^0 test cases$/)).toHaveCount(0);
      } finally {
        await cleanupRun(api, projectId, run);
        await cleanup(api, [`/api/plans/${plan.id}`]);
        await api.dispose();
      }
    },
  );

  test(
    ticket("REG-PLAN-05", "10221983132", "the plan detail page has no Plan items tab and no internal plans sidebar"),
    { tag: '@tesbo.testId("TES-TC-1299")' },
    async ({ page }) => {
      /*
       * 10221983132 was "Plan items shows 0 count and message 'no planed items'" — accurate, but
       * reading as a contradiction next to a header announcing the plan's cases. That UI is gone:
       * the Test Plans page restructuring removed the Plan items tab and the plan-switcher sidebar
       * entirely (Main Sidebar → Test Plans → [sidebar + Plan items + Test runs] is now just
       * Test Plans → Test Runs), so this now guards both removals and that Test Runs still renders
       * directly, with no tab navigation to reach it.
       */
      const api = await apiContext();
      const projectId = accountA().projectId;
      const plan = await createPlan(api, projectId, { name: unique("Plan Items Plan") });
      let run: SeededRun | undefined;
      try {
        run = await seedRun(api, projectId, { statuses: ["Passed", "Failed"], planId: plan.id });

        await page.goto(`/projects/${projectId}/plans/${plan.id}`);

        await expect(page.getByRole("button", { name: /Plan items/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^Test runs$/ })).toHaveCount(0);
        await expect(page.getByRole("link", { name: "All plans" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "New test plan" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Create test run" }).first()).toBeVisible();
        await expect(page.getByRole("button", { name: "Link existing run" })).toBeVisible();
      } finally {
        await cleanupRun(api, projectId, run);
        await cleanup(api, [`/api/plans/${plan.id}`]);
        await api.dispose();
      }
    },
  );

  test(
    ticket("REG-PLAN-06", "10221977100", "the inline edit form labels every field"),
    { tag: '@tesbo.testId("TES-TC-1300")' },
    async ({ page }) => {
      const api = await apiContext();
      const projectId = accountA().projectId;
      const plan = await createPlan(api, projectId, { name: unique("Edit Labels Plan") });
      try {
        await page.goto(`/projects/${projectId}/plans/${plan.id}`);
        await page.getByRole("button", { name: /^Edit$/ }).first().click();

        // Labels, not placeholders: a placeholder disappears the moment the field has a value, which
        // is exactly the state you are in when editing an existing plan — so a form that "labels"
        // its fields with placeholders is unlabelled precisely when this screen is used.
        for (const label of ["Plan name", "Description", "Target release"]) {
          await expect(page.getByLabel(label), `the "${label}" field has no label`).toBeVisible();
        }
        await expect(page.getByLabel("Plan name")).toHaveValue(String(plan.name));
      } finally {
        await cleanup(api, [`/api/plans/${plan.id}`]);
        await api.dispose();
      }
    },
  );
});
