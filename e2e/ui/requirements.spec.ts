import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
import {
  createProject,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedJiraRequirements,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * The project Requirements page at /projects/:id/requirements — Jira/Linear ticket sync and the
 * cross-source coverage view.
 *
 * Regression coverage only, for now: a Jira connection is seeded straight into Postgres (the same
 * way DSH-A-12 in api/projects.spec.ts does) since there is no API route to connect one and a real
 * OAuth round trip can't be driven from Playwright. The rest of the page's happy path is exercised
 * indirectly by api/integrations.spec.ts (the aggregates it reads) and by navigation.spec.ts /
 * theme.spec.ts (that the screen renders and is reachable).
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

test.describe("requirements page — sync error banner", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("REQ-U-01 Dismiss actually clears a sync failure, not just a state nothing reads", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a Jira connection (no API route connects one)");
    const project = await createProject(api);
    try {
      // Gives the project a connected Jira source, so the page renders the Sync button and takes
      // the error path this test exercises, without a real OAuth connection or a live Jira account.
      seedJiraRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);

      let syncAttempts = 0;
      const syncPath = `/api/projects/${project.id}/jira/sync`;
      // route.abort("failed") reproduces the exact browser-level transport failure production
      // fetch() throws when a sync call can't complete (see ZYU-33/34 in zyra.spec.ts) — this is
      // what actually sets useSyncRun's own `error` state, the state the bug left Dismiss unable
      // to reach.
      await page.route(
        (url) => url.pathname === syncPath,
        async (route) => {
          syncAttempts++;
          await route.abort("failed");
        },
      );

      await page.goto(`/projects/${project.id}/requirements`);
      await page.getByRole("button", { name: "Sync Jira" }).click();

      const errorBanner = page.getByText(/browser blocked or could not reach the API/);
      await expect(errorBanner).toBeVisible();
      // fetchWithNetworkErrorMessage (lib/api.ts) retries once before surfacing anything, so this
      // also confirms the mock actually engaged both attempts rather than being bypassed.
      expect(syncAttempts).toBe(2);

      await page.getByRole("button", { name: "Dismiss" }).click();
      // The regression: Dismiss used to clear only a `syncError` state nothing here ever set — the
      // error actually on screen came from useSyncRun's own `error`, which had no way to be cleared.
      await expect(errorBanner).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});
