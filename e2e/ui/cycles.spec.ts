import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

/**
 * Creates a run, adds one Approved test case per entry in `statuses`, and sets each execution to
 * the requested status (an "Untested" entry is left alone since that is already the default on
 * creation). Cycles are created in "Planning" by default (migrations/V9_cycle_status.sql).
 */
async function seedRunWithStatuses(api: APIRequestContext, namePrefix: string, statuses: string[]) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const cycle = await (
    await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `${namePrefix} ${stamp}` } })
  ).json();

  let testcaseIds: string[] = [];
  if (statuses.length > 0) {
    const created = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases/bulk-create`, {
        data: {
          testcases: statuses.map((_, i) => ({ title: `${namePrefix} Case ${stamp}-${i}`, status: "Approved" })),
        },
      })
    ).json();
    testcaseIds = created.created.map((c: { id: string }) => c.id);
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });

    const executions = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
    for (let i = 0; i < statuses.length; i++) {
      if (statuses[i] === "Untested") continue;
      await api.patch(`/api/cycles/${cycle.id}/executions/${executions[i].id}`, { data: { status: statuses[i] } });
    }
  }

  return { cycleId: cycle.id as string, testcaseIds };
}

async function cleanUpRun(api: APIRequestContext, cycleId: string, testcaseIds: string[]) {
  await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
  if (testcaseIds.length > 0) {
    await api.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
      data: { testcaseIds },
      failOnStatusCode: false,
    });
  }
}

/** The Test Runs list card for one run, found by the link to its details page. */
function runCard(page: Page, cycleId: string): Locator {
  return page.locator(`a[href$="/cycles/${cycleId}"]`).locator("xpath=ancestor::div[contains(@class,'p-0')]").first();
}

/** The value of a summary StatTile ("Total Runs", "Pass Rate", "Open Failures", ...) by its label. */
function statTileValue(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator("xpath=following-sibling::div[1]");
}

/** The value span of a StatPill on the Test Run Details page, by its label. */
function statPillValue(page: Page, label: string): Locator {
  return page
    .locator("section", { hasText: "Skipped" })
    .first()
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::span[1]");
}

/**
 * The Execution Progress / Pass Rate value on the Test Run Details page, by its label. The two are
 * rendered as separate rows (label span, value span as its sibling) since the fix for "[Test Runs]
 * Pass Rate is Inconsistent Between Test Run Summary and Details" split what used to be one
 * conflated "X% pass rate" line into these two distinct metrics.
 */
function runMetricValue(page: Page, label: "Execution Progress" | "Pass Rate"): Locator {
  return page.getByText(label, { exact: true }).locator("xpath=following-sibling::span[1]");
}

test.describe("Test Runs — Pass Rate and Skipped consistency", () => {
  test("the Run Details page reports Pass Rate and Execution Progress as two distinct numbers", { tag: '@tesbo.testId("TES-TC-1329")' }, async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    /*
     * Reproduces "[Test Runs] Pass Rate is Inconsistent Between Test Run Summary and Details":
     * this run's Test Run Details page used to read Passed/Total = 5/25 = 20%, while a Test Plan
     * built on the same run read Passed/(Passed+Failed+Blocked) = 5/15 = 33%. Pass Rate is now
     * always the second formula everywhere, and Execution Progress — (Passed+Failed+Blocked+
     * Skipped)/Total = 20/25 = 80% — is its own, separately labelled number rather than being
     * folded into "pass rate".
     */
    const statuses = [
      ...Array(5).fill("Passed"),
      ...Array(5).fill("Failed"),
      ...Array(5).fill("Blocked"),
      ...Array(5).fill("Skipped"),
      ...Array(5).fill("Untested"),
    ];
    const { cycleId, testcaseIds } = await seedRunWithStatuses(api, "E2E PassRate Mixed", statuses);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles`);
      const card = runCard(page, cycleId);
      await expect(card).toBeVisible();
      await expect(card).toContainText("5 passed");
      await expect(card).toContainText("5 failed");
      await expect(card).toContainText("5 blocked");
      await expect(card).toContainText("5 skipped");
      await expect(card).toContainText("5 untested");
      await expect(card).toContainText("20 / 25 cases");

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      await expect(statPillValue(page, "Total")).toHaveText("25");
      await expect(statPillValue(page, "Passed")).toHaveText("5");
      await expect(statPillValue(page, "Failed")).toHaveText("5");
      await expect(statPillValue(page, "Blocked")).toHaveText("5");
      await expect(statPillValue(page, "Skipped")).toHaveText("5");
      await expect(statPillValue(page, "Pending")).toHaveText("5");
      await expect(runMetricValue(page, "Execution Progress")).toHaveText("80% executed");
      await expect(runMetricValue(page, "Pass Rate")).toHaveText("33%");
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });

  test("a run where every case is Skipped shows no pass rate but full execution progress, never NaN", { tag: '@tesbo.testId("TES-TC-1330")' }, async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const statuses = Array(5).fill("Skipped");
    const { cycleId, testcaseIds } = await seedRunWithStatuses(api, "E2E PassRate AllSkipped", statuses);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles`);
      const card = runCard(page, cycleId);
      await expect(card).toContainText("0 passed");
      await expect(card).toContainText("5 skipped");
      await expect(card).toContainText("5 / 5 cases");

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      // Skipped is neither a pass nor a fail — nothing has settled, so Pass Rate reads "no cases
      // executed" (not 0%, which would claim every case was run and failed). Execution Progress is
      // a real 100%: every case in the run has an outcome, even though none of them settled.
      await expect(runMetricValue(page, "Execution Progress")).toHaveText("100% executed");
      await expect(page.getByText("No cases executed yet")).toBeVisible();
      await expect(statPillValue(page, "Skipped")).toHaveText("5");
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });

  test("a run with zero assigned cases renders with no breakdown row and does not break the list", { tag: '@tesbo.testId("TES-TC-1331")' }, async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const { cycleId, testcaseIds } = await seedRunWithStatuses(api, "E2E PassRate ZeroCases", []);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles`);
      const card = runCard(page, cycleId);
      await expect(card).toBeVisible();
      await expect(card).not.toContainText("cases");

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      await expect(statPillValue(page, "Total")).toHaveText("0");
      await expect(page.getByText("No cases executed yet")).toBeVisible();
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });

  test("the summary Pass Rate tile is Passed over settled cases for the currently filtered runs, matching the Test Plan formula", { tag: '@tesbo.testId("TES-TC-1332")' }, async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    // Freshly created cycles default to "Planning" — filtering to that status isolates this
    // fixture from any run another spec has already moved to In Progress or Completed.
    const statuses = [...Array(1).fill("Passed"), ...Array(3).fill("Untested")];
    const { cycleId, testcaseIds } = await seedRunWithStatuses(api, "E2E PassRate Scope", statuses);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles`);
      await page.getByRole("button", { name: "Planning" }).click();
      await expect(runCard(page, cycleId)).toBeVisible();

      // Computed from a live snapshot of exactly the runs the "Planning" filter shows, taken
      // right after the page's own data has settled, so the expected value tracks whatever else
      // is concurrently Planning in this shared project rather than assuming this fixture is the
      // only one — the point being tested is the formula (Passed / (Passed+Failed+Blocked), the
      // same one the Test Plan page uses), not a fixed number.
      const runs: Array<{ status: string; passed: number; failed: number; blocked: number }> = await (
        await api.get(`/api/projects/${ctx.projectId}/cycles`)
      ).json();
      const planningRuns = runs.filter((r) => r.status === "Planning");
      const totalPassed = planningRuns.reduce((sum, r) => sum + r.passed, 0);
      const totalFailed = planningRuns.reduce((sum, r) => sum + r.failed, 0);
      const totalBlocked = planningRuns.reduce((sum, r) => sum + r.blocked, 0);
      const settled = totalPassed + totalFailed + totalBlocked;
      const expectedPassRate = settled > 0 ? Math.round((totalPassed / settled) * 100) : null;

      await expect(statTileValue(page, "Total Runs")).toHaveText(String(planningRuns.length));
      await expect(statTileValue(page, "Pass Rate")).toHaveText(
        expectedPassRate !== null ? `${expectedPassRate}%` : "—",
      );
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });
});

/*
 * "[Test Run] Priority, Type, and Assignee filters are not available": the run's own test-case
 * table previously exposed only a Status filter. The new filters are applied entirely client-side
 * (app/(app)/projects/[id]/cycles/[cycleId]/page.tsx) against the executions this page already
 * holds in memory — the same mechanism the existing Status tabs and search box already use — so
 * there is no new API surface to cover in e2e/api/; GET /api/cycles/:cycleId/executions is
 * unchanged and its cross-tenant authorization is already covered by api/authorization.spec.ts.
 *
 * Type has no DB-level enum (VARCHAR, free text) and the "Add Test Cases" picker's own canonical
 * Type list doesn't even match the Test Cases page's list, so the run's Type filter options are
 * derived from the data actually on the run rather than a hardcoded list — TC-07/08 below pin that
 * a value outside any "canonical" list is still filterable rather than silently dropped.
 */
test.describe("Test Run — Priority/Type/Assignee filters", () => {
  let api: APIRequestContext;
  let cycleId: string;
  let testcaseIds: string[] = [];
  let executionIds: string[] = [];
  let memberId: string;
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const LEGACY_TYPE = `LegacyImportedType${stamp}`;
  const LEGACY_PRIORITY = `P9Legacy${stamp}`;
  const titles = Array.from({ length: 6 }, (_, i) => `E2E RunFilters ${stamp}-${i}`);

  test.beforeAll(async () => {
    api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E RunFilters ${stamp}` } })
    ).json();
    cycleId = cycle.id;

    const members: { userId: string; name: string; email: string }[] = await (
      await api.get(`/api/projects/${ctx.projectId}/members`)
    ).json();
    memberId = members[0].userId;

    // [0] P0/Security, assigned      [1] P1/Functional, assigned    [2] P1/Functional, unassigned
    // [3] P2/Regression, unassigned  [4] legacy priority string     [5] legacy type string
    const created = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases/bulk-create`, {
        data: {
          testcases: [
            { title: titles[0], priority: "P0", type: "Security", status: "Approved" },
            { title: titles[1], priority: "P1", type: "Functional", status: "Approved" },
            { title: titles[2], priority: "P1", type: "Functional", status: "Approved" },
            { title: titles[3], priority: "P2", type: "Regression", status: "Approved" },
            { title: titles[4], priority: LEGACY_PRIORITY, type: "Functional", status: "Approved" },
            { title: titles[5], priority: "P2", type: LEGACY_TYPE, status: "Approved" },
          ],
        },
      })
    ).json();
    testcaseIds = created.created.map((c: { id: string }) => c.id);
    await api.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });

    const executions: { id: string }[] = await (await api.get(`/api/cycles/${cycleId}/executions`)).json();
    executionIds = executions.map((e) => e.id);
    await api.patch(`/api/cycles/${cycleId}/executions/${executionIds[0]}`, { data: { assigneeId: memberId } });
    await api.patch(`/api/cycles/${cycleId}/executions/${executionIds[1]}`, { data: { assigneeId: memberId } });
  });

  test.afterAll(async () => {
    if (api) {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
    await expect(page.getByTestId("run-filter-priority")).toBeVisible();
  });

  test("filtering by Priority alone narrows the table to matching rows", { tag: '@tesbo.testId("TES-TC-2001")' }, async ({ page }) => {
    await page.getByTestId("run-filter-priority").selectOption("P1");
    await expect(page.getByText(titles[1], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[2], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[0], { exact: true })).toHaveCount(0);
    await expect(page.getByText(titles[3], { exact: true })).toHaveCount(0);
  });

  test("filtering by Type alone narrows the table to matching rows", { tag: '@tesbo.testId("TES-TC-2002")' }, async ({ page }) => {
    await page.getByTestId("run-filter-type").selectOption("Security");
    await expect(page.getByText(titles[0], { exact: true })).toBeVisible();
    for (const i of [1, 2, 3, 4, 5]) {
      await expect(page.getByText(titles[i], { exact: true })).toHaveCount(0);
    }
  });

  test("filtering by Assignee narrows the table, including the Unassigned bucket", { tag: '@tesbo.testId("TES-TC-2003")' }, async ({ page }) => {
    await page.getByTestId("run-filter-assignee").selectOption(memberId);
    await expect(page.getByText(titles[0], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[1], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[2], { exact: true })).toHaveCount(0);

    await page.getByTestId("run-filter-assignee").selectOption("__unassigned__");
    await expect(page.getByText(titles[2], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[3], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[0], { exact: true })).toHaveCount(0);
    await expect(page.getByText(titles[1], { exact: true })).toHaveCount(0);
  });

  test("Priority, Type and Assignee combine with AND logic, and with the Status tab and search box", { tag: '@tesbo.testId("TES-TC-2004")' }, async ({ page }) => {
    // Only [1] is P1 + Functional + assigned to the member — [2] is P1/Functional but unassigned,
    // so this pins that the three filters intersect rather than union.
    await page.getByTestId("run-filter-priority").selectOption("P1");
    await page.getByTestId("run-filter-type").selectOption("Functional");
    await page.getByTestId("run-filter-assignee").selectOption(memberId);
    await expect(page.getByText(titles[1], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[2], { exact: true })).toHaveCount(0);

    // Layer the pre-existing Status tab on top: [1]'s execution is still Untested, so the
    // "Failed" tab must hide it even though the three new filters still match it.
    await page.getByRole("button", { name: "Failed", exact: false }).click();
    await expect(page.getByText(titles[1], { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();

    // And the pre-existing search box on top of that.
    await page.getByPlaceholder("Search test cases…").fill("no-such-case-title");
    await expect(page.getByText(titles[1], { exact: true })).toHaveCount(0);
    await expect(page.getByText("No test cases match")).toBeVisible();
  });

  test("a filter combination with zero matches shows the empty state, not a broken table", { tag: '@tesbo.testId("TES-TC-2005")' }, async ({ page }) => {
    // No seeded case is both P0 and Regression.
    await page.getByTestId("run-filter-priority").selectOption("P0");
    await page.getByTestId("run-filter-type").selectOption("Regression");
    await expect(page.getByText("No test cases match")).toBeVisible();
    await expect(page.getByText("Try adjusting the filter or search query.")).toBeVisible();
    for (const title of titles) {
      await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    }
  });

  test("Clear filters resets all three selects and the affordance disappears", { tag: '@tesbo.testId("TES-TC-2006")' }, async ({ page }) => {
    await page.getByTestId("run-filter-priority").selectOption("P0");
    await page.getByTestId("run-filter-type").selectOption("Security");
    await page.getByTestId("run-filter-assignee").selectOption(memberId);
    const clearButton = page.getByTestId("run-filter-clear");
    await expect(clearButton).toContainText("3");

    await clearButton.click();
    await expect(clearButton).toHaveCount(0);
    await expect(page.getByTestId("run-filter-priority")).toHaveValue("");
    await expect(page.getByTestId("run-filter-type")).toHaveValue("");
    await expect(page.getByTestId("run-filter-assignee")).toHaveValue("");
    for (const title of titles) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    }
  });

  test("a Type value outside any canonical list is offered and filterable, not hidden", { tag: '@tesbo.testId("TES-TC-2007")' }, async ({ page }) => {
    const typeSelect = page.getByTestId("run-filter-type");
    await expect(typeSelect.locator("option", { hasText: LEGACY_TYPE })).toHaveCount(1);
    await typeSelect.selectOption(LEGACY_TYPE);
    await expect(page.getByText(titles[5], { exact: true })).toBeVisible();
    for (const i of [0, 1, 2, 3, 4]) {
      await expect(page.getByText(titles[i], { exact: true })).toHaveCount(0);
    }
  });

  test("a Priority value outside P0-P3 is offered and filterable, not hidden", { tag: '@tesbo.testId("TES-TC-2008")' }, async ({ page }) => {
    const prioritySelect = page.getByTestId("run-filter-priority");
    await expect(prioritySelect.locator("option", { hasText: LEGACY_PRIORITY })).toHaveCount(1);
    await prioritySelect.selectOption(LEGACY_PRIORITY);
    await expect(page.getByText(titles[4], { exact: true })).toBeVisible();
    for (const i of [0, 1, 2, 3, 5]) {
      await expect(page.getByText(titles[i], { exact: true })).toHaveCount(0);
    }
  });

  test("filters set on the run table do not leak into the Add Test Cases picker's own filters", { tag: '@tesbo.testId("TES-TC-2009")' }, async ({ page }) => {
    await page.getByTestId("run-filter-priority").selectOption("P0");
    await page.getByRole("button", { name: "Add Test Cases" }).click();
    await expect(page.getByText("Add Test Cases to Run")).toBeVisible();
    // The picker's own Priority select is a separate, un-testid'd <select> distinguished by its
    // own option copy ("P0 - Critical" vs. the run filter's bare "P0") — see filterPriority/
    // runFilterPriority in the page component. It must still read its own default, unaffected by
    // the run-table filter set moments earlier.
    const pickerPrioritySelect = page.locator("select:has(option:text-is('P0 - Critical'))");
    await expect(pickerPrioritySelect).toHaveValue("");
  });

  /*
   * Rapid, effectively-simultaneous filter changes: fired together via Promise.all rather than
   * awaited one at a time, so their change events can interleave at the React-state level. The
   * product code has no debounce/lock around these selects, so the only guarantee worth pinning is
   * that the UI settles on a state consistent with the LAST value of each control — never a stuck
   * or half-applied combination — and stays responsive to further input afterward.
   */
  test("rapid, interleaved filter changes settle to the final selection with no stale intermediate state", { tag: '@tesbo.testId("TES-TC-2010")' }, async ({ page }) => {
    await Promise.all([
      page.getByTestId("run-filter-priority").selectOption("P1"),
      page.getByTestId("run-filter-type").selectOption("Functional"),
      page.getByTestId("run-filter-assignee").selectOption(memberId),
    ]);

    await expect(page.getByTestId("run-filter-priority")).toHaveValue("P1");
    await expect(page.getByTestId("run-filter-type")).toHaveValue("Functional");
    await expect(page.getByTestId("run-filter-assignee")).toHaveValue(memberId);
    // Only [1] satisfies all three at once.
    await expect(page.getByText(titles[1], { exact: true })).toBeVisible();
    await expect(page.getByText(titles[2], { exact: true })).toHaveCount(0);

    // The UI is still responsive — not deadlocked — after the burst: one more change is picked up.
    await page.getByTestId("run-filter-priority").selectOption("");
    await expect(page.getByTestId("run-filter-priority")).toHaveValue("");
    // Type still matches [2] (Functional) but Assignee is still set to the member, and [2] is
    // unassigned — so it stays excluded until Assignee is cleared too, below.
    await expect(page.getByText(titles[2], { exact: true })).toHaveCount(0);

    await page.getByTestId("run-filter-assignee").selectOption("");
    await expect(page.getByText(titles[2], { exact: true })).toBeVisible();
  });
});

test.describe("Test Run filters — concurrent updates, pagination boundary, and zero-case runs", () => {
  test("an execution reassigned by a concurrent caller is reflected correctly under the Assignee filter after reload", { tag: '@tesbo.testId("TES-TC-2011")' }, async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const { cycleId, testcaseIds } = await seedRunWithStatuses(api, "E2E RunFiltersRace", ["Untested"]);
    try {
      const members: { userId: string }[] = await (
        await api.get(`/api/projects/${ctx.projectId}/members`)
      ).json();
      const memberId = members[0].userId;
      const executionsBefore: { id: string; title: string }[] = await (
        await api.get(`/api/cycles/${cycleId}/executions`)
      ).json();
      const title = executionsBefore[0].title;

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      await page.getByTestId("run-filter-assignee").selectOption("__unassigned__");
      await expect(page.getByText(title, { exact: true })).toBeVisible();

      // Simulated second tab / concurrent caller reassigning the same execution while this one
      // is filtered to "Unassigned" — the page took a single snapshot on load and does not poll.
      const executions: { id: string }[] = await (await api.get(`/api/cycles/${cycleId}/executions`)).json();
      await api.patch(`/api/cycles/${cycleId}/executions/${executions[0].id}`, { data: { assigneeId: memberId } });

      await page.reload();
      await page.getByTestId("run-filter-assignee").selectOption("__unassigned__");
      await expect(page.getByText("No test cases match")).toBeVisible();

      await page.getByTestId("run-filter-assignee").selectOption(memberId);
      await expect(page.getByText("No test cases match")).toHaveCount(0);
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });

  test("applying a filter that leaves fewer results than the current page resets to page 1", { tag: '@tesbo.testId("TES-TC-2012")' }, async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E RunFiltersPage ${stamp}` } })
    ).json();
    const cycleId = cycle.id as string;
    // 11 cases at P2 (page size is 10, so this run spans two pages) plus one P1 case that lands
    // last, i.e. alone on page 2 in the default unfiltered order.
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => ({ title: `E2E RunFiltersPage ${stamp}-${i}`, priority: "P2", status: "Approved" })),
      { title: `E2E RunFiltersPage ${stamp}-lone-p1`, priority: "P1", status: "Approved" },
    ];
    const created = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases/bulk-create`, { data: { testcases: rows } })
    ).json();
    const testcaseIds: string[] = created.created.map((c: { id: string }) => c.id);
    try {
      await api.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      await expect(page.getByText("Page 1 of 2")).toBeVisible();
      await page.getByRole("button", { name: "Next page" }).click();
      await expect(page.getByText("Page 2 of 2")).toBeVisible();
      await expect(page.getByText(`${stamp}-lone-p1`)).toBeVisible();

      // Filtering to P1 leaves exactly one match — the page must not stay stuck on the now
      // out-of-range page 2, which would render nothing despite a real match existing.
      await page.getByTestId("run-filter-priority").selectOption("P1");
      await expect(page.getByText(`${stamp}-lone-p1`)).toBeVisible();
      await expect(page.getByText(/Page \d+ of \d+/)).toHaveCount(0); // pageCount is 1: pager hides
      await expect(page.getByText(/Showing 1.1 of 1 cases/)).toBeVisible();
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });

  test("the filter controls render without error on a run with zero test cases", { tag: '@tesbo.testId("TES-TC-2013")' }, async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const { cycleId, testcaseIds } = await seedRunWithStatuses(api, "E2E RunFiltersEmpty", []);
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      await expect(page.getByText(/No test cases added yet/)).toBeVisible();
      // The Type option list is derived from the (empty) executions array — this run has no test
      // cases, so it must render as just its "All types" default with no crash. Assignee's list is
      // the project's member roster (loaded independently of the run), so only its two fixed
      // entries are pinned, not an exact total.
      await expect(page.getByTestId("run-filter-type").locator("option")).toHaveCount(1);
      await expect(page.getByTestId("run-filter-assignee").locator("option", { hasText: "All assignees" })).toHaveCount(1);
      await expect(page.getByTestId("run-filter-assignee").locator("option", { hasText: "Unassigned" })).toHaveCount(1);
      await page.getByTestId("run-filter-priority").selectOption("P0");
      await expect(page.getByText(/No test cases added yet/)).toBeVisible();
    } finally {
      await cleanUpRun(api, cycleId, testcaseIds);
      await api.dispose();
    }
  });
});
