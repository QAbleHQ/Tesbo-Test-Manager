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
