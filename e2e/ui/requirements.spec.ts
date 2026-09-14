import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { dbControlAvailable, exec, literal, scalar } from "../utils/psql";
import {
  createProject,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedJiraRequirements,
  seedLinearRequirements,
  seedProviderKbFolder,
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

/*
 * The Requirements table's Zyra Status column: a persistent, always-on label for where a
 * requirement sits in the Zyra generation pipeline — "Not started" before any task exists,
 * through the in-flight statuses, to "Done" once accepted. Before this column existed, the same
 * information (ai_generation_requests.task_status) only ever appeared next to "View task" in the
 * Action column, and only while a task was neither brand new nor finished — see activeTaskFor in
 * app/(app)/projects/[id]/requirements/page.tsx. This suite exercises exactly the states that used
 * to render nothing at all, plus the one place a copy/paste of that lookup would silently read the
 * wrong provider's map (REQ-U-04).
 */
test.describe("requirements page — Zyra status label", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  let ownerId: string;
  test.beforeAll(async () => {
    api = await screensApi();
    ownerId = scalar(`SELECT id FROM users WHERE email = ${literal(tenant!.email)};`);
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  /** legacy.service.ts ZYRA_AGENT_NAME. zyraTaskStatusesByIssueKey filters on it. */
  const ZYRA_AGENT_NAME = "Zyra the Test Generator";

  /**
   * Seeds a Zyra task-board row (ai_generation_requests) against one issue key, so the
   * Requirements page's persistent Zyra Status column has a real task_status to read instead of
   * falling back to "Not started" — without driving a real AI generation run. Mirrors seedTask()
   * in ui/zyra.spec.ts.
   */
  function seedZyraTaskStatus(projectId: string, source: "jira" | "linear", key: string, status: string): void {
    const column = source === "jira" ? "jira_issue_keys" : "linear_issue_keys";
    const userStory = `E2E Zyra Status ${key} ${uniqueSuffix()}`;
    exec(
      `INSERT INTO ai_generation_requests (project_id, requested_by, provider, user_story, agent_name, task_status, ${column}) ` +
        `VALUES (${literal(projectId)}, ${literal(ownerId)}, 'openai', ${literal(userStory)}, ` +
        `${literal(ZYRA_AGENT_NAME)}, ${literal(status)}, ${literal(JSON.stringify([key]))}::jsonb);`,
    );
  }

  test(
    "REQ-U-02 the Zyra status label is always shown, including before a task starts and after it finishes",
    async ({ page }) => {
      test.skip(!dbControlAvailable(), "needs psql access to seed jira_tickets and ai_generation_requests directly");
      const project = await createProject(api);
      try {
        const notStarted = `E2ESCR-${uniqueSuffix()}`;
        const inProgress = `E2ESCR-${uniqueSuffix()}`;
        const accepted = `E2ESCR-${uniqueSuffix()}`;
        seedJiraRequirements(tenant!.organizationId, project.id, [notStarted, inProgress, accepted]);
        seedZyraTaskStatus(project.id, "jira", inProgress, "in_progress");
        // "accepted" is what the review-accept action actually writes; normalizeTaskStatus maps it
        // to "done" — this is the exact state the badge used to disappear for entirely.
        seedZyraTaskStatus(project.id, "jira", accepted, "accepted");

        await page.goto(`/projects/${project.id}/requirements`);

        const notStartedRow = page.locator("tr", { hasText: notStarted });
        await expect(notStartedRow.getByText("Not started", { exact: true })).toBeVisible();

        const inProgressRow = page.locator("tr", { hasText: inProgress });
        // Only ONE badge with this text renders in the row now — the dedicated column replaced
        // the Action column's own copy rather than sitting alongside it.
        await expect(inProgressRow.getByText("In Progress", { exact: true })).toHaveCount(1);
        await expect(inProgressRow.getByRole("link", { name: "View task" })).toBeVisible();

        const acceptedRow = page.locator("tr", { hasText: accepted });
        await expect(acceptedRow.getByText("Done", { exact: true })).toBeVisible();
        // Done is terminal for activeTaskFor, so the Action column falls back to "Assign to Zyra"
        // (this ticket was never linked to a saved testcase) rather than a stale "View task" link.
        await expect(acceptedRow.getByRole("button", { name: "Assign to Zyra" })).toBeVisible();
      } finally {
        await deleteProjects(api, [project.id]);
      }
    },
  );

  test(
    "REQ-U-03 failed and rejected Zyra tasks still surface a real status, not silence",
    async ({ page }) => {
      test.skip(!dbControlAvailable(), "needs psql access to seed jira_tickets and ai_generation_requests directly");
      const project = await createProject(api);
      try {
        const failed = `E2ESCR-${uniqueSuffix()}`;
        const rejected = `E2ESCR-${uniqueSuffix()}`;
        seedJiraRequirements(tenant!.organizationId, project.id, [failed, rejected]);
        seedZyraTaskStatus(project.id, "jira", failed, "failed");
        // "rejected" normalizes to "todo" (taskStatusLabel -> "Pending") — the reviewer sent the
        // draft back, so the pipeline reads as restarted rather than finished.
        seedZyraTaskStatus(project.id, "jira", rejected, "rejected");

        await page.goto(`/projects/${project.id}/requirements`);

        await expect(page.locator("tr", { hasText: failed }).getByText("Failed", { exact: true })).toBeVisible();
        await expect(page.locator("tr", { hasText: rejected }).getByText("Pending", { exact: true })).toBeVisible();
      } finally {
        await deleteProjects(api, [project.id]);
      }
    },
  );

  test(
    "REQ-U-04 the label reads the matching provider's task map — a Jira and a Linear ticket sharing a key don't cross-contaminate",
    async ({ page }) => {
      test.skip(!dbControlAvailable(), "needs psql access to seed tickets and ai_generation_requests directly");
      const project = await createProject(api);
      try {
        const sharedKey = `E2ESCR-${uniqueSuffix()}`;
        seedJiraRequirements(tenant!.organizationId, project.id, [sharedKey]);
        seedLinearRequirements(tenant!.organizationId, project.id, [sharedKey]);
        seedZyraTaskStatus(project.id, "jira", sharedKey, "in_review");
        seedZyraTaskStatus(project.id, "linear", sharedKey, "failed");

        await page.goto(`/projects/${project.id}/requirements`);
        // Both providers are connected once this test's Linear connection lands, so the page opens
        // on "All Sources" — both rows for the same key sit side by side, told apart only by their
        // source badge. A lookup that read the wrong provider's map would show the same status on
        // both rows, or the right label on the wrong row.
        const rows = page.locator("tr", { hasText: sharedKey });
        await expect(rows).toHaveCount(2);
        await expect(rows.filter({ hasText: "In Review" })).toHaveCount(1);
        await expect(rows.filter({ hasText: "Failed" })).toHaveCount(1);
      } finally {
        await deleteProjects(api, [project.id]);
      }
    },
  );
});

/*
 * "View in Knowledge base" used to always link to the KB root, regardless of which Requirements
 * tab (Jira / Linear / All Sources) was active. It now resolves the provider's own KB folder — the
 * "Jira" / "Linear" folder a real sync creates under the root via ensureProviderFolder — and links
 * straight into it, falling back to the root only when that folder doesn't exist yet (no sync has
 * run) or when "All Sources" is active, since there is no single provider folder to point at there.
 */
test.describe("requirements page — View in Knowledge base follows the active source", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("REQ-U-05 the Jira tab links into the Jira KB folder, not the KB root", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a Jira connection and its KB folder");
    const project = await createProject(api);
    try {
      seedJiraRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
      const jiraFolderId = seedProviderKbFolder(tenant!.organizationId, project.id, "jira");

      // Only Jira is connected, so the page opens straight on that tab — there's no "All Sources"
      // tab to sit under with a single provider.
      await page.goto(`/projects/${project.id}/requirements`);
      const link = page.getByTestId("view-in-knowledge-base-link");
      await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base?folder=${jiraFolderId}`);

      await link.click();
      await expect(page.getByRole("heading", { name: "Jira", exact: true })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("REQ-U-06 the Linear tab links into the Linear KB folder, not the KB root", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a Linear connection and its KB folder");
    const project = await createProject(api);
    try {
      seedLinearRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
      const linearFolderId = seedProviderKbFolder(tenant!.organizationId, project.id, "linear");

      await page.goto(`/projects/${project.id}/requirements`);
      const link = page.getByTestId("view-in-knowledge-base-link");
      await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base?folder=${linearFolderId}`);

      await link.click();
      await expect(page.getByRole("heading", { name: "Linear", exact: true })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test(
    "REQ-U-07 All Sources links to the KB root, and switching tabs repoints the link without a reload",
    async ({ page }) => {
      test.skip(!dbControlAvailable(), "needs psql access to seed both connections and their KB folders");
      const project = await createProject(api);
      try {
        seedJiraRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
        seedLinearRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
        const jiraFolderId = seedProviderKbFolder(tenant!.organizationId, project.id, "jira");
        const linearFolderId = seedProviderKbFolder(tenant!.organizationId, project.id, "linear");

        // Both providers connected -> the page opens on "All Sources".
        await page.goto(`/projects/${project.id}/requirements`);
        const link = page.getByTestId("view-in-knowledge-base-link");
        await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base`);

        await page.getByTestId("requirements-source-tab-jira").click();
        await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base?folder=${jiraFolderId}`);

        await page.getByTestId("requirements-source-tab-linear").click();
        await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base?folder=${linearFolderId}`);

        await page.getByTestId("requirements-source-tab-all").click();
        await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base`);
      } finally {
        await deleteProjects(api, [project.id]);
      }
    },
  );

  test(
    "REQ-U-08 falls back to the KB root when the active provider has no KB folder yet (no sync has run)",
    async ({ page }) => {
      test.skip(!dbControlAvailable(), "needs psql access to seed a Jira connection without its KB folder");
      const project = await createProject(api);
      try {
        seedJiraRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
        // Deliberately no seedProviderKbFolder call: the "Jira" folder doesn't exist yet, exactly
        // as before that project's first sync has ever run.

        await page.goto(`/projects/${project.id}/requirements`);
        const link = page.getByTestId("view-in-knowledge-base-link");
        await expect(link).toHaveAttribute("href", `/projects/${project.id}/knowledge-base`);
      } finally {
        await deleteProjects(api, [project.id]);
      }
    },
  );
});
