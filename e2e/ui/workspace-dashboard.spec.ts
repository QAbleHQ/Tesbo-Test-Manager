import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { screensSuiteSkipReason, screensTenant } from "../utils/screens-tenant";

/*
 * The workspace dashboard at /dashboard — how its counts are written.
 *
 * "[Workspace & Project all pages] Add comma to show proper number format like 5,65,010": counts
 * were printed raw, so 565010 executions read as one unbroken run of digits. They are grouped the
 * Indian way (lib/number.ts, a fixed locale so every viewer sees the same thing).
 *
 * The analytics response is stubbed: real counts this large cannot be seeded, and the value under
 * test is purely how a number is displayed. The stubbed body keeps the real response's shape.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

type Analytics = {
  projectCount: number;
  testCaseCount: number;
  suiteCount: number;
  planCount: number;
  cycleCount: number;
  executionStatus: Record<string, number>;
  executionStatusPercent: Record<string, number>;
  executionTotal: number;
};

const STATUSES = ["Untested", "Passed", "Failed", "Blocked", "Skipped", "Retest"];

function analytics(counts: Partial<Analytics> & { status?: Partial<Record<string, number>> }): Analytics {
  const executionStatus = Object.fromEntries(STATUSES.map((s) => [s, counts.status?.[s] ?? 0]));
  const executionTotal = counts.executionTotal ?? Object.values(executionStatus).reduce((a, b) => a + b, 0);
  return {
    projectCount: counts.projectCount ?? 0,
    testCaseCount: counts.testCaseCount ?? 0,
    suiteCount: counts.suiteCount ?? 0,
    planCount: counts.planCount ?? 0,
    cycleCount: counts.cycleCount ?? 0,
    executionStatus,
    executionStatusPercent: Object.fromEntries(STATUSES.map((s) => [s, executionTotal ? Math.round((executionStatus[s] / executionTotal) * 100) : 0])),
    executionTotal,
  };
}

async function openDashboard(page: Page, body: Analytics): Promise<void> {
  await page.route("**/api/workspace/analytics", (route) => route.fulfill({ json: body }));
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
}

/** The overview card for a label, e.g. "Test cases" -> the number printed above it. */
function overviewValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::p[1]");
}

test.describe("workspace dashboard number format", () => {
  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("DASH-U-01 large overview counts and execution totals are grouped with commas", async ({ page }) => {
    await openDashboard(
      page,
      analytics({
        projectCount: 10,
        testCaseCount: 4448,
        suiteCount: 250,
        planCount: 0,
        cycleCount: 123456,
        status: { Untested: 18661, Passed: 565010, Failed: 121379, Skipped: 24, Retest: 8 },
      }),
    );

    await expect(overviewValue(page, "Projects")).toHaveText("10");
    await expect(overviewValue(page, "Test cases")).toHaveText("4,448");
    await expect(overviewValue(page, "Total Suites")).toHaveText("250");
    await expect(overviewValue(page, "Test plans")).toHaveText("0");
    await expect(overviewValue(page, "Test runs")).toHaveText("1,23,456");

    // The example from the card: 565010 reads 5,65,010.
    await expect(page.getByText("5,65,010 of 7,05,082", { exact: true })).toBeVisible();
    await expect(page.getByText("18,661 of 7,05,082", { exact: true })).toBeVisible();
    await expect(page.getByText("1,21,379 of 7,05,082", { exact: true })).toBeVisible();
    await expect(page.getByText("0 of 7,05,082", { exact: true })).toBeVisible();
    await expect(page.getByText("24 of 7,05,082", { exact: true })).toBeVisible();
    await expect(page.getByText("Total executions across all projects:")).toContainText("7,05,082");

    // Nothing is left as an unbroken run of digits.
    await expect(page.getByText(/\b\d{4,}\b/)).toHaveCount(0);
  });

  test("DASH-U-02 numbers below a thousand are unchanged, and the grouping starts exactly at 1,000", async ({ page }) => {
    await openDashboard(
      page,
      analytics({ projectCount: 999, testCaseCount: 1000, suiteCount: 99999, planCount: 100000, cycleCount: 1, status: { Passed: 999, Failed: 1 } }),
    );
    await expect(overviewValue(page, "Projects")).toHaveText("999");
    await expect(overviewValue(page, "Test cases")).toHaveText("1,000");
    await expect(overviewValue(page, "Total Suites")).toHaveText("99,999");
    await expect(overviewValue(page, "Test plans")).toHaveText("1,00,000");
    await expect(overviewValue(page, "Test runs")).toHaveText("1");
    await expect(page.getByText("999 of 1,000", { exact: true })).toBeVisible();
    await expect(page.getByText("1 of 1,000", { exact: true })).toBeVisible();
  });

  test("DASH-U-03 the empty workspace still shows zeros and its empty state", async ({ page }) => {
    await openDashboard(page, analytics({}));
    await expect(overviewValue(page, "Projects")).toHaveText("0");
    await expect(page.getByText("No executions yet.", { exact: false })).toBeVisible();
  });
});
