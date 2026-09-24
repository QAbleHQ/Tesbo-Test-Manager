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

/*
 * The Linear sync panel's project label. A Linear Project mapping stores its opaque slugId in the
 * key slot (V95), so the panel used to label a completed sync "4081f3c6e1df" — now it shows the
 * mapped name (remote_project_name, V126) and keeps the slugId as the hover tooltip, falling back
 * to the key for runs recorded before the name was stored. The run is seeded directly: a real sync
 * would call Linear's live API (see api/integrations.spec.ts's file header).
 */
test.describe("requirements page — Linear sync panel names the project", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  function seedLinearSyncRun(projectId: string, key: string, name: string | null): void {
    exec(
      "INSERT INTO integration_sync_runs (organization_id, project_id, provider, status, stage, trigger_source, " +
        "remote_project_key, remote_project_name, error, started_at, finished_at) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(projectId)}, 'linear', 'succeeded', 'done', 'manual', ` +
        `${literal(key)}, ${name === null ? "NULL" : literal(name)}, ` +
        `${literal(`No changes in ${name ?? key} since the last sync.`)}, now(), now());`,
    );
  }

  test("REQ-U-09 a Linear sync shows the project name, with the slugId only as the tooltip", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a Linear connection and a sync run");
    const project = await createProject(api);
    const slug = `e2e${uniqueSuffix()}`; // shaped like a Linear slugId: opaque, lowercase, no spaces
    const name = `E2E Orange HRMS ${uniqueSuffix()}`;
    try {
      seedLinearRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
      seedLinearSyncRun(project.id, slug, name);

      await page.goto(`/projects/${project.id}/requirements`);
      const panel = page.getByRole("status").filter({ hasText: "Linear sync complete" });
      const chip = panel.getByTestId("sync-run-remote");
      await expect(chip).toHaveText(name);
      await expect(chip).toHaveAttribute("title", slug);
      await expect(panel).toContainText(`No changes in ${name} since the last sync.`);
      // The reported defect: the opaque slugId was the visible label.
      await expect(panel.getByText(slug, { exact: true })).toHaveCount(0);
    } finally {
      exec(`DELETE FROM integration_sync_runs WHERE project_id = ${literal(project.id)};`);
      await deleteProjects(api, [project.id]);
    }
  });

  test("REQ-U-10 a Linear sync recorded before names were stored falls back to its key", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a Linear connection and a sync run");
    const project = await createProject(api);
    const slug = `e2e${uniqueSuffix()}`; // shaped like a Linear slugId: opaque, lowercase, no spaces
    try {
      seedLinearRequirements(tenant!.organizationId, project.id, [`E2ESCR-${uniqueSuffix()}`]);
      seedLinearSyncRun(project.id, slug, null);

      await page.goto(`/projects/${project.id}/requirements`);
      const panel = page.getByRole("status").filter({ hasText: "Linear sync complete" });
      await expect(panel.getByTestId("sync-run-remote")).toHaveText(slug);
    } finally {
      exec(`DELETE FROM integration_sync_runs WHERE project_id = ${literal(project.id)};`);
      await deleteProjects(api, [project.id]);
    }
  });
});

/*
 * The expanded-row Description used to print Linear's Markdown verbatim ("### LIN-05 ...",
 * "**Module:** Claim"), because Linear stores descriptions as Markdown and the row rendered them
 * as a plain <p>. Linear descriptions now go through lib/markdown.ts renderMarkdown(); Jira's stay
 * plain text, since the backend already flattens Jira's ADF to text (jiraDescriptionToText) and
 * that renderer would turn snake_case into italics.
 *
 * The row is expanded by clicking its summary cell — the key cell is a link that stops propagation,
 * so clicking it opens the provider instead of toggling the detail row.
 */
test.describe("requirements page — ticket description rendering", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  async function openDescription(page: import("@playwright/test").Page, projectId: string, key: string) {
    await page.goto(`/projects/${projectId}/requirements`);
    await page.getByText(`Requirement ${key}`, { exact: true }).click();
    return page.getByTestId("ticket-description");
  }

  test("REQ-U-11 a Linear description renders its Markdown instead of printing it raw", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed linear_tickets directly");
    const project = await createProject(api);
    try {
      const key = `E2ESCR-${uniqueSuffix()}`;
      // Shaped like the reported ticket (LIN-05), which is exactly what a Linear sync stores.
      const markdown = [
        "### LIN-05: Submit an Expense Claim",
        "",
        "**Module:** Claim",
        "**Priority:** Medium",
        "",
        "**Acceptance Criteria:**",
        "- Employee can attach a receipt",
        "- Claim total is validated",
        "",
        "See [the spec](https://example.com/spec).",
      ].join("\n");
      seedLinearRequirements(tenant!.organizationId, project.id, [key], { [key]: markdown });

      const desc = await openDescription(page, project.id, key);
      await expect(desc.locator("h3")).toHaveText("LIN-05: Submit an Expense Claim");
      await expect(desc.locator("strong", { hasText: "Module:" })).toBeVisible();
      await expect(desc.locator("strong", { hasText: "Acceptance Criteria:" })).toBeVisible();
      await expect(desc.locator("li")).toHaveText(["Employee can attach a receipt", "Claim total is validated"]);
      const link = desc.getByRole("link", { name: "the spec" });
      await expect(link).toHaveAttribute("href", "https://example.com/spec");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
      // The reported defect: the raw markers were the visible text.
      await expect(desc).not.toContainText("###");
      await expect(desc).not.toContainText("**");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("REQ-U-12 HTML inside a Linear description is shown as text and never executes", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed linear_tickets directly");
    const project = await createProject(api);
    try {
      const key = `E2ESCR-${uniqueSuffix()}`;
      const payload = [
        `<img src=x onerror="window.__reqDescXss=1">`,
        `<script>window.__reqDescXss=1</script>`,
        `[click me](javascript:window.__reqDescXss=1)`,
        `[breakout](https://a.test/" onmouseover="window.__reqDescXss=1" x=")`,
      ].join("\n");
      seedLinearRequirements(tenant!.organizationId, project.id, [key], { [key]: payload });

      const desc = await openDescription(page, project.id, key);
      await expect(desc).toContainText(`<img src=x onerror=`);
      await expect(desc).toContainText(`<script>`);
      await expect(desc.locator("img, script")).toHaveCount(0);
      // renderMarkdown only links http(s) URLs, so the javascript: link must stay plain text.
      await expect(desc.locator('a[href^="javascript:"]')).toHaveCount(0);
      // The quote-breakout attempt must not have produced a live event-handler attribute.
      await expect(desc.locator("[onmouseover], [onerror]")).toHaveCount(0);
      await desc.hover();
      expect(await page.evaluate(() => (window as unknown as { __reqDescXss?: number }).__reqDescXss)).toBeUndefined();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("REQ-U-13 a Jira description stays literal plain text — snake_case is not italicised", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed jira_tickets directly");
    const project = await createProject(api);
    try {
      const key = `E2ESCR-${uniqueSuffix()}`;
      const text = "Validate the user_account_id field\n**kept literally**\nline three";
      seedJiraRequirements(tenant!.organizationId, project.id, [key], { [key]: text });

      const desc = await openDescription(page, project.id, key);
      await expect(desc).toContainText("user_account_id");
      await expect(desc).toContainText("**kept literally**");
      await expect(desc.locator("em, strong, h1, h2, h3, li")).toHaveCount(0);
      // whitespace-pre-wrap keeps Jira's line breaks, which a plain <p> would otherwise collapse.
      expect(await desc.innerText()).toContain("field\n**kept literally**\nline three");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("REQ-U-14 a ticket with no description shows no Description block, but the row still expands", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed linear_tickets directly");
    const project = await createProject(api);
    try {
      const key = `E2ESCR-${uniqueSuffix()}`;
      seedLinearRequirements(tenant!.organizationId, project.id, [key]); // description left NULL

      const desc = await openDescription(page, project.id, key);
      await expect(page.getByRole("link", { name: "Open in Linear →" })).toBeVisible();
      await expect(desc).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Description", exact: true })).toHaveCount(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("REQ-U-15 a long Linear description scrolls inside its capped box instead of stretching the row", async ({ page }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed linear_tickets directly");
    const project = await createProject(api);
    try {
      const key = `E2ESCR-${uniqueSuffix()}`;
      const long = ["### Long ticket", ...Array.from({ length: 80 }, (_, i) => `- Criterion ${i + 1}`)].join("\n");
      seedLinearRequirements(tenant!.organizationId, project.id, [key], { [key]: long });

      const desc = await openDescription(page, project.id, key);
      await expect(desc.locator("li")).toHaveCount(80);
      // max-h-48 = 12rem = 192px.
      const box = await desc.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight }));
      expect(box.h).toBeLessThanOrEqual(192);
      expect(box.sh).toBeGreaterThan(box.h);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});
