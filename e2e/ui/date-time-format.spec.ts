import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  createBug,
  createProject,
  createTestCase,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * Sitewide date/time display format (Tesbo-Frontend/lib/date.ts): "05 Oct 2026" / "06:21 PM" /
 * "05 Oct 2026, 06:21 PM" everywhere a timestamp is shown to a user, replacing what used to be a
 * different format per screen — DD/MM/YYYY on the Knowledge Base history, a bare
 * toLocaleDateString() (locale-dependent shape) on bugs/cycles/test cases/members/requirements,
 * "October 6, 2026" on Billing, and three separately-reimplemented relative-time helpers across
 * dashboard/activity/comments.
 *
 * A consistency concern that spans screens rather than belonging to one feature's spec file — same
 * shape as theme.spec.ts — so it gets its own file instead of being scattered across seven others.
 * This isn't exhaustive over every call site lib/date.ts touched; it spot-checks one representative
 * screen per shared helper (formatDate, formatDateTime, formatRelative/formatAbsolute) so a
 * regression in the shared utility, or a future call site bypassing it, is caught here first.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** "05 Oct 2026" — day always zero-padded, month a 3-letter name, 4-digit year. */
const DATE_RE = /\b\d{2} [A-Z][a-z]{2} \d{4}\b/;
/** "05 Oct 2026, 06:21 PM" */
const DATETIME_RE = /\b\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM)\b/;

test.describe("sitewide date/time format", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("DTF-01 the bugs list's Reported column renders the standard date shape", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E DTF Bug ${uniqueSuffix()}` });
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: bug.title });
    await expect(row).toBeVisible();
    await expect(row).toHaveText(DATE_RE);
  });

  test("DTF-02 a bug's detail panel shows Reported On as the standard date+time shape", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E DTF Bug ${uniqueSuffix()}` });
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.locator("tbody tr").filter({ hasText: bug.title }).click();
    const body = page.getByRole("region", { name: "Bug details" });
    await expect(body).toBeVisible();
    // "Reported On" is a label <p>; its value sits in a sibling <span> under the same parent <div>.
    const reportedRow = body.getByText("Reported On", { exact: true }).locator("xpath=..");
    await expect(reportedRow).toHaveText(DATETIME_RE);
  });

  test("DTF-03 a test run's detail page shows its Created date in the standard shape", async ({ page }) => {
    const suffix = uniqueSuffix();
    const cycle = await (
      await api.post(`/api/projects/${projectId}/cycles`, { data: { name: `E2E DTF Run ${suffix}` } })
    ).json();
    await page.goto(`/projects/${projectId}/cycles/${cycle.id}`);
    await expect(page.getByText(/Created \d{2} [A-Z][a-z]{2} \d{4}/)).toBeVisible();
  });

  test("DTF-04 the test case repository's Updated column shows the standard date shape", async ({ page }) => {
    const testcase = await createTestCase(api, projectId, { title: `E2E DTF Case ${uniqueSuffix()}` });
    await page.goto(`/projects/${projectId}/testcases`);
    await expect(page.getByRole("heading", { name: "Test case repository", level: 1 })).toBeVisible();
    const row = page.locator("tbody tr").filter({ hasText: testcase.title });
    await expect(row).toBeVisible();
    await expect(row).toHaveText(DATE_RE);
  });

  test("DTF-05 the project activity feed shows the standard date+time shape next to each entry", async ({ page }) => {
    await createTestCase(api, projectId, { title: `E2E DTF Activity ${uniqueSuffix()}` });
    await page.goto(`/projects/${projectId}/activity`);
    await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
    // ActivityRow (components/activity/activityShared.tsx) is the only thing on this page using
    // font-mono — the relative-time label beside it and the absolute one below it both go through
    // formatRelative/formatAbsolute, which are themselves thin re-exports of lib/date.ts.
    await expect(page.locator(".font-mono").first()).toHaveText(DATETIME_RE);
  });
});
