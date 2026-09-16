import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

async function setUpCycleWithOneCase(title: string) {
  const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
  const cycle = await (
    await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Bug Dialog Cycle ${Date.now()}` } })
  ).json();
  // The inline status <select> only renders when the run's own status is "In Progress"
  // (page.tsx: `const isInProgress = run.status === "In Progress"`) — cycles are created in
  // "Planning" by default (migrations/V9_cycle_status.sql), so this must be set explicitly.
  await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
  const testcase = await (
    await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title } })
  ).json();
  await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
  await api.dispose();
  return { cycle, testcase };
}

async function cleanUp(cycleId: string, testcaseId: string) {
  const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
  try {
    const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
    const bugs = await bugsRes.json();
    for (const bug of bugs) {
      if (bug.links?.some((l: { testcaseId: string }) => l.testcaseId === testcaseId)) {
        await api.delete(`/api/bugs/${bug.id}`);
      }
    }
    await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
    await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
  } finally {
    await api.dispose();
  }
}

test.describe("auto bug-filing on Failed", () => {
  test("marking an execution Failed opens the bug dialog, and filing creates a linked bug", { tag: '@tesbo.testId("TES-TC-667")' }, async ({
    page,
  }) => {
    const title = `UI Bug Dialog Test Case ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("combobox").first().selectOption("Failed");

      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      const titleInput = page.getByPlaceholder("Brief summary of the bug…");
      await expect(titleInput).toHaveValue(`Failed: ${title}`);

      // Severity is mandatory and defaults to Medium so the dialog can always be filed without
      // the reporter having to touch it.
      const severitySelect = page.getByRole("combobox", { name: "Severity" });
      await expect(severitySelect).toHaveValue("Medium");
      await severitySelect.selectOption("Critical");

      await page.getByRole("button", { name: "File Bug" }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
        const bugs = await bugsRes.json();
        const filedBug = bugs.find((b: { title: string }) => b.title === `Failed: ${title}`);
        expect(filedBug).toBeTruthy();
        expect(filedBug.severity).toBe("Critical");
        expect(filedBug.links.some((l: { testcaseId: string; cycleId: string }) =>
          l.testcaseId === testcase.id && l.cycleId === cycle.id,
        )).toBeTruthy();
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });

  test("the severity dropdown offers only the four valid values and resets to Medium for the next dialog", { tag: '@tesbo.testId("TES-TC-1333")' }, async ({
    page,
  }) => {
    const stamp = Date.now();
    const titleA = `UI Bug Severity Reset A ${stamp}`;
    const titleB = `UI Bug Severity Reset B ${stamp}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Bug Severity Reset Cycle ${stamp}` } })
    ).json();
    await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
    const testcaseA = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: titleA } })
    ).json();
    const testcaseB = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: titleB } })
    ).json();
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcaseA.id, testcaseB.id] } });
    await api.dispose();

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);

      // Fail the first case, pick a non-default severity, and skip — the dialog must not carry
      // that choice over into the next execution's report.
      await page.getByRole("combobox").first().selectOption("Failed");
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      const severitySelect = page.getByRole("combobox", { name: "Severity" });

      // Mandatory dropdown: exactly the four backend-accepted values, no blank/empty option.
      const optionValues = await severitySelect.locator("option").allTextContents();
      expect(optionValues).toEqual(["Critical", "High", "Medium", "Low"]);

      await severitySelect.selectOption("Low");
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      // Fail the second case — its dialog must default back to Medium, not inherit "Low".
      await page.getByRole("combobox").nth(1).selectOption("Failed");
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Severity" })).toHaveValue("Medium");
      await page.getByRole("button", { name: "File Bug" }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const verifyApi = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugsRes = await verifyApi.get(`/api/projects/${ctx.projectId}/bugs`);
        const bugs = await bugsRes.json();
        const filedBug = bugs.find((b: { title: string }) => b.title === `Failed: ${titleB}`);
        expect(filedBug).toBeTruthy();
        expect(filedBug.severity).toBe("Medium");
      } finally {
        await verifyApi.dispose();
      }
    } finally {
      const cleanupApi = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugsRes = await cleanupApi.get(`/api/projects/${ctx.projectId}/bugs`);
        const bugs = await bugsRes.json();
        for (const bug of bugs) {
          if (bug.links?.some((l: { testcaseId: string }) => l.testcaseId === testcaseA.id || l.testcaseId === testcaseB.id)) {
            await cleanupApi.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
          }
        }
        await cleanupApi.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
        await cleanupApi.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, { failOnStatusCode: false });
        await cleanupApi.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, { failOnStatusCode: false });
      } finally {
        await cleanupApi.dispose();
      }
    }
  });

  test("skipping the dialog leaves the execution Failed with no bug filed", { tag: '@tesbo.testId("TES-TC-668")' }, async ({ page }) => {
    const title = `UI Bug Dialog Declined Test Case ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("combobox").first().selectOption("Failed");

      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
        const bugs = await bugsRes.json();
        expect(bugs.some((b: { title: string }) => b.title === `Failed: ${title}`)).toBeFalsy();

        const executionsRes = await api.get(`/api/cycles/${cycle.id}/executions`);
        const executions = await executionsRes.json();
        expect(executions[0].status).toBe("Failed");
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });

  /*
   * Root-cause regression for "duplicate bug records created when saving a bug with more than 10
   * attachments": createBug() succeeded, the attachments request that followed it failed (originally
   * because more than ten files hit the server's per-request cap in one shot; here forced directly so
   * the test doesn't depend on file-count timing), and the dialog stayed open with no error shown at
   * all (handleBugSubmit had no catch block) — inviting a retry that called createBug() again and
   * produced a duplicate. LogBugDialog.tsx now shows the failure and remembers the bug id from the
   * failed attempt, so File Bug clicked again resumes the upload instead of filing a second bug.
   */
  test("a retry after a failed attachment upload does not create a duplicate bug", async ({ page }) => {
    const title = `UI Bug Dialog Duplicate Guard ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    let attempt = 0;
    await page.route("**/bugs/*/attachments", (route) => {
      attempt += 1;
      // The first attachment request fails; the retry's requests go through for real.
      if (attempt === 1) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Simulated upload failure" }),
        });
      }
      return route.continue();
    });

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("combobox").first().selectOption("Failed");
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();

      await page.locator('input[type="file"]').setInputFiles(
        Array.from({ length: 12 }, (_, i) => ({
          name: `evidence-${i}.png`,
          mimeType: "image/png",
          buffer: Buffer.from(`file contents ${i}`),
        })),
      );

      const submit = page.getByRole("button", { name: "File Bug" });
      await submit.click();
      await expect(page.getByTestId("log-bug-error")).toBeVisible();
      // The dialog stays open with the same staged files — exactly what invited the original defect.
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();

      await submit.click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugs = await (await api.get(`/api/projects/${ctx.projectId}/bugs`)).json();
        const matches = bugs.filter((b: { title: string }) => b.title === `Failed: ${title}`);
        expect(matches, "the retry must reuse the bug from the failed attempt, not create a second one").toHaveLength(1);

        const bug = await (await api.get(`/api/bugs/${matches[0].id}`)).json();
        expect(bug.attachments, "the retry must still deliver every staged file").toHaveLength(12);
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });

  /*
   * Regression: "Yes, link existing" -> search and pick a real Jira/Linear ticket used to be a
   * dead end. The dialog echoed the picked ticket back as a chip ("PROJ-123 — summary"), but
   * handleBugSubmit() never read it — it always sent integrationIssueKey: null, silently
   * discarding the exact ticket the user just searched for and selected.
   */
  test("linking an already-logged Jira ticket carries its real key/url into the created bug", async ({ page }) => {
    const title = `UI Bug Jira Link ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    await page.route(`**/api/projects/${ctx.projectId}/jira/status`, (route) =>
      route.fulfill({ json: { connected: true } }),
    );
    await page.route(`**/api/projects/${ctx.projectId}/linear/status`, (route) =>
      route.fulfill({ json: { connected: false } }),
    );
    await page.route(`**/api/projects/${ctx.projectId}/jira/search-issues**`, (route) =>
      route.fulfill({
        json: {
          list: [
            { provider: "JIRA", key: "PROJ-4242", summary: "Login button does nothing", status: "Open", url: "https://e2e.atlassian.net/browse/PROJ-4242" },
          ],
        },
      }),
    );

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      // Scoped to the row, not page.getByRole("combobox").first() — the page's own "Filter by
      // priority" combobox sits above the table and is always first in DOM order, so an
      // unscoped .first() silently grabs that instead of this row's status <select>.
      await page.getByRole("row", { name: title }).getByRole("combobox").selectOption("Failed");
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();

      await page.getByRole("button", { name: "Yes, link existing" }).click();
      // exact: true — "Jira ticket" is otherwise a substring match of "Search Jira tickets…" too.
      await page.getByRole("button", { name: "Jira ticket", exact: true }).click();

      // Linking a real ticket needs nothing else — the ticket already carries its own title,
      // description and status, so the new-bug-only fields must not appear alongside it.
      await expect(page.getByText("Bug Title", { exact: true })).toBeHidden();
      await expect(page.getByText("Description", { exact: true })).toBeHidden();
      await expect(page.getByLabel("Severity")).toBeHidden();
      await expect(page.getByLabel("Bug priority")).toBeHidden();
      await expect(page.getByText("Evidence", { exact: true })).toBeHidden();

      await page.getByRole("button", { name: "Search Jira tickets…" }).click();

      await expect(page.getByRole("heading", { name: "Link a Jira ticket" })).toBeVisible();
      const resultButton = page.getByRole("button", { name: "PROJ-4242 — Login button does nothing" });
      await expect(resultButton).toBeVisible();
      await resultButton.click();

      await expect(page.getByText("PROJ-4242 — Login button does nothing")).toBeVisible();
      await page.getByRole("button", { name: "File Bug" }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugs = await (await api.get(`/api/projects/${ctx.projectId}/bugs`)).json();
        const filedBug = bugs.find((b: { title: string }) => b.title === `Failed: ${title}`);
        expect(filedBug, "the bug filed against this execution").toBeTruthy();
        expect(filedBug.integrationProvider).toBe("JIRA");
        expect(filedBug.integrationIssueKey).toBe("PROJ-4242");
        expect(filedBug.externalUrl).toBe("https://e2e.atlassian.net/browse/PROJ-4242");
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });

  /*
   * Regression: IssuePickerModal used to own its own Jira/Linear toggle and default to whichever
   * tracker connected first (Jira), ignoring the tracker the user had just picked on the Report a
   * Bug form ("Jira ticket" vs "Linear ticket"). With both trackers connected, choosing "Linear
   * ticket" and opening the search still searched — and could be switched back to — Jira. The picker
   * must now be locked to the provider already chosen, with no toggle back to the other one, and
   * "File Bug" must stay disabled until a ticket has actually been picked.
   */
  test("choosing Linear ticket only ever searches Linear, even with Jira also connected", async ({ page }) => {
    const title = `UI Bug Linear Link ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    await page.route(`**/api/projects/${ctx.projectId}/jira/status`, (route) =>
      route.fulfill({ json: { connected: true } }),
    );
    await page.route(`**/api/projects/${ctx.projectId}/linear/status`, (route) =>
      route.fulfill({ json: { connected: true } }),
    );
    let jiraSearched = false;
    await page.route(`**/api/projects/${ctx.projectId}/jira/search-issues**`, (route) => {
      jiraSearched = true;
      return route.fulfill({ json: { list: [] } });
    });
    await page.route(`**/api/projects/${ctx.projectId}/linear/search-issues**`, (route) =>
      route.fulfill({
        json: {
          list: [
            { provider: "LINEAR", key: "ENG-77", summary: "Dropdown closes on scroll", status: "Todo", url: "https://linear.app/e2e/issue/ENG-77" },
          ],
        },
      }),
    );

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("row", { name: title }).getByRole("combobox").selectOption("Failed");
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();

      await page.getByRole("button", { name: "Yes, link existing" }).click();
      // exact: true — "Linear ticket" is otherwise a substring match of "Search Linear tickets…" too.
      await page.getByRole("button", { name: "Linear ticket", exact: true }).click();

      // Same new-bug-only fields must stay hidden for the Linear branch too.
      await expect(page.getByText("Bug Title", { exact: true })).toBeHidden();
      await expect(page.getByText("Evidence", { exact: true })).toBeHidden();

      const fileBug = page.getByRole("button", { name: "File Bug" });
      await expect(fileBug, "must not be fileable before a ticket is picked").toBeDisabled();

      await page.getByRole("button", { name: "Search Linear tickets…" }).click();

      await expect(page.getByRole("heading", { name: "Link a Linear ticket" })).toBeVisible();
      // No toggle back to Jira must exist — the choice already made on the Report a Bug form is final.
      await expect(page.getByRole("button", { name: "Jira", exact: true })).toBeHidden();
      const resultButton = page.getByRole("button", { name: "ENG-77 — Dropdown closes on scroll" });
      await expect(resultButton).toBeVisible();
      await resultButton.click();
      expect(jiraSearched, "picking Linear must never hit the Jira search endpoint").toBe(false);

      await expect(page.getByText("ENG-77 — Dropdown closes on scroll")).toBeVisible();
      await expect(fileBug).toBeEnabled();
      await fileBug.click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugs = await (await api.get(`/api/projects/${ctx.projectId}/bugs`)).json();
        const filedBug = bugs.find((b: { title: string }) => b.title === `Failed: ${title}`);
        expect(filedBug, "the bug filed against this execution").toBeTruthy();
        expect(filedBug.integrationProvider).toBe("LINEAR");
        expect(filedBug.integrationIssueKey).toBe("ENG-77");
        expect(filedBug.externalUrl).toBe("https://linear.app/e2e/issue/ENG-77");
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });
});

/*
 * "[Test Runs] Unable to assign test cases for execution" — the editable "Assign to" control.
 *
 * Before this change, assignee was read-only everywhere in the UI, and even when set through the
 * API it was silently wiped by the next status change or Save (see api/executions.spec.ts). These
 * cover the same regression at the UI layer, through the controls a person actually uses.
 */
test.describe("assigning a test execution", () => {
  test("assigning via the run drawer persists, and a status-only Save does not clear it", { tag: '@tesbo.testId("TES-TC-1915")' }, async ({ page }) => {
    const title = `UI Assignee Drawer Case ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const me = await (await api.get("/api/auth/me")).json();

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByText(testcase.title).first().click();

      const assignSelect = page.getByRole("combobox", { name: "Assigned to" });
      await expect(assignSelect).toBeVisible();
      await assignSelect.selectOption(me.userId);
      await page.getByRole("button", { name: "Save" }).first().click();
      await expect(page.getByText(testcase.title)).toBeHidden({ timeout: 10_000 });

      const [afterAssign] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(afterAssign.assigneeId).toBe(me.userId);

      // Re-open and Save again with only a status change — the drawer always resends the
      // current selection, but this pins that a plain status edit elsewhere in the product
      // (the inline dropdown) must not silently clear what was just assigned.
      await page.getByText(testcase.title).first().click();
      await expect(page.getByRole("combobox", { name: "Assigned to" })).toHaveValue(me.userId);
      await page.getByRole("button", { name: "Passed", exact: true }).first().click();
      await page.getByRole("button", { name: "Save" }).first().click();
      await expect(page.getByText(testcase.title)).toBeHidden({ timeout: 10_000 });

      const [afterStatus] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(afterStatus.status).toBe("Passed");
      expect(afterStatus.assigneeId, "a status change from the drawer must not clear the assignee").toBe(me.userId);

      // Unassign via the drawer's "Unassigned" option.
      await page.getByText(testcase.title).first().click();
      await page.getByRole("combobox", { name: "Assigned to" }).selectOption("");
      await page.getByRole("button", { name: "Save" }).first().click();
      await expect(page.getByText(testcase.title)).toBeHidden({ timeout: 10_000 });

      const [afterUnassign] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(afterUnassign.assigneeId).toBeNull();
    } finally {
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });

  test("the full-page execute view also offers Assigned to, and persists it", { tag: '@tesbo.testId("TES-TC-1916")' }, async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Assignee Full Page ${Date.now()}`);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const me = await (await api.get("/api/auth/me")).json();
      const [execution] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}/execute/${execution.id}`);
      const assignSelect = page.getByRole("combobox", { name: "Assigned to" });
      await expect(assignSelect).toBeVisible();
      await assignSelect.selectOption(me.userId);
      await page.getByRole("button", { name: "Save" }).first().click();
      await page.waitForURL(`**/projects/${ctx.projectId}/cycles/${cycle.id}`);

      const [after] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(after.assigneeId).toBe(me.userId);
    } finally {
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });
});

test.describe("bulk assignment (run detail)", () => {
  async function setUpCycleWithTwoCases(prefix: string) {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const stamp = Date.now();
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Bulk Assign Cycle ${stamp}` } })
    ).json();
    await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
    const testcaseA = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `${prefix} A ${stamp}` } })
    ).json();
    const testcaseB = await (
      await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `${prefix} B ${stamp}` } })
    ).json();
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcaseA.id, testcaseB.id] } });
    await api.dispose();
    return { cycle, testcaseA, testcaseB };
  }

  /*
   * Before this: the run detail's bulk-selection toolbar offered only "Remove from run" — no way to
   * assign several selected test cases to one person at once, despite the backend's bulk-assign
   * route (executions/bulk-assign, covered at the API level in execution-ops.spec.ts EXO-A-04)
   * already existing and working. This is the UI half: select several rows, assign them together,
   * and the table reflects the new assignee immediately without a reload.
   */
  test("selecting several test cases and assigning them to a member updates all of them at once", async ({ page }) => {
    const { cycle, testcaseA, testcaseB } = await setUpCycleWithTwoCases("UI Bulk Assign Case");
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const me = await (await api.get("/api/auth/me")).json();

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("checkbox", { name: `Select ${testcaseA.title}` }).check();
      await page.getByRole("checkbox", { name: `Select ${testcaseB.title}` }).check();
      await expect(page.getByText("2 selected")).toBeVisible();

      await page.getByRole("button", { name: "Assign to" }).click();
      await page.getByRole("combobox", { name: "Assign selected test cases to" }).selectOption(me.userId);
      await page.getByRole("button", { name: "Assign 2" }).click();

      // Selection clears and the modal closes on success, with no page reload in between.
      await expect(page.getByText("2 selected")).toBeHidden();
      // Scoped to each case's own row, not a bare page-wide text search — the run's own owner badge
      // in the header can carry the same display name (this account both created and is assigned
      // the run), which would otherwise make a page-wide count a false positive.
      const displayName = me.name || me.email;
      await expect(page.getByRole("row").filter({ hasText: testcaseA.title })).toContainText(displayName);
      await expect(page.getByRole("row").filter({ hasText: testcaseB.title })).toContainText(displayName);

      const executions = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(executions.every((e: { assigneeId: string }) => e.assigneeId === me.userId)).toBeTruthy();
    } finally {
      await api.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, { failOnStatusCode: false });
      await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("individual assignment still works after a bulk assignment on the same run", async ({ page }) => {
    const { cycle, testcaseA, testcaseB } = await setUpCycleWithTwoCases("UI Mixed Assign Case");
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const me = await (await api.get("/api/auth/me")).json();

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("checkbox", { name: `Select ${testcaseA.title}` }).check();
      await page.getByRole("checkbox", { name: `Select ${testcaseB.title}` }).check();
      await page.getByRole("button", { name: "Assign to" }).click();
      await page.getByRole("combobox", { name: "Assign selected test cases to" }).selectOption(me.userId);
      await page.getByRole("button", { name: "Assign 2" }).click();
      await expect(page.getByText("2 selected")).toBeHidden();

      // Unassign just one of the two rows through the existing per-row drawer. Waiting on the
      // save request itself (not on the drawer closing/the row text hiding, which is a separate,
      // pre-existing flake unrelated to bulk assignment) keeps this test scoped to what it's
      // actually verifying: that per-row assignment still works the same after a bulk assignment.
      await page.getByText(testcaseA.title).first().click();
      await expect(page.getByRole("combobox", { name: "Assigned to" })).toHaveValue(me.userId);
      await page.getByRole("combobox", { name: "Assigned to" }).selectOption("");
      const [patchRes] = await Promise.all([
        page.waitForResponse((res) => /\/executions\/[0-9a-f-]{36}$/.test(res.url()) && res.request().method() === "PATCH"),
        page.getByRole("button", { name: "Save" }).first().click(),
      ]);
      expect(patchRes.ok()).toBeTruthy();

      const executions = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      const execA = executions.find((e: { testcaseId: string }) => e.testcaseId === testcaseA.id);
      const execB = executions.find((e: { testcaseId: string }) => e.testcaseId === testcaseB.id);
      expect(execA.assigneeId, "the bulk-then-individual case is cleared").toBeNull();
      expect(execB.assigneeId, "the untouched bulk-assigned case keeps its assignee").toBe(me.userId);
    } finally {
      await api.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, { failOnStatusCode: false });
      await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});

test.describe("removing cases from a run", () => {
  /*
   * Basecamp 10199377404 — "[Test Run] Count does not match when deleted test cases from run". The
   * reported screen showed "Total 10" and "Test Cases 10" in the run body while the left panel's badge
   * for that same run still read 11.
   *
   * The API was already right — listCycles counts live execution rows, and api/cycles.spec.ts pins
   * `totalCases === executions.length`. The bug was entirely in the screen: the removal handlers
   * filtered the local `executions` array (which drives the body) but `allRuns` (which drives the
   * panel badge) was only ever fetched by load() on mount, so the badge kept the pre-delete number.
   *
   * The panel has since been removed from the run detail screen altogether: it duplicated navigation
   * the screen already has (the "Test Runs" breadcrumb, the sidebar's Runs entry) while taking ~220px
   * of width from the table the screen exists to show. So this test was updated rather than replaced —
   * it now owns both ends of that change. The badge half became its opposite (the panel and its
   * controls must be absent, and the table must occupy the width they held), and the half that still
   * has a UI — the run body's own count following a removal, and the server agreeing — is unchanged.
   */
  async function setUpCycleWithCases(count: number) {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const stamp = Date.now();
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Run Count ${stamp}` } })
    ).json();
    await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
    const testcaseIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const tc = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `UI Run Count case ${i + 1} ${stamp}` },
        })
      ).json();
      testcaseIds.push(tc.id);
    }
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });
    await api.dispose();
    return { cycle, testcaseIds };
  }

  test("the run detail shows no runs switcher panel, and its own count follows a removal", { tag: '@tesbo.testId("TES-TC-999")' }, async ({
    page,
  }) => {
    const { cycle, testcaseIds } = await setUpCycleWithCases(3);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);

      // The count beside the "Test Cases" heading — the run body's own number.
      const bodyCount = page.getByRole("heading", { name: "Test Cases" }).locator("+ span");

      await expect(bodyCount).toHaveText("3");

      // ── The runs switcher panel is gone ──
      // Its per-run count badge (this testid only ever existed inside it), its "All runs" back-link
      // and its collapse toggle are all absent.
      await expect(page.locator('[data-testid="run-list-count"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: "All runs" })).toHaveCount(0);
      await expect(page.getByTitle("Collapse runs")).toHaveCount(0);
      await expect(page.getByTitle("Show runs")).toHaveCount(0);

      // And the table has the width the panel held. Asserted as geometry rather than a class name
      // because ~220px of horizontal space is precisely what was removed: the run's h1 marks the left
      // edge of the content region, and with the panel present the table started past the panel's full
      // width. Now only the card's own padding separates them.
      const titleBox = await page.getByRole("heading", { level: 1 }).boundingBox();
      const tableBox = await page.getByRole("table").boundingBox();
      expect(titleBox, "the run title did not render").not.toBeNull();
      expect(tableBox, "the test cases table did not render").not.toBeNull();
      expect(
        tableBox!.x - titleBox!.x,
        "the test cases table still starts well right of the run header — a left panel is taking that width",
      ).toBeLessThan(80);

      // Remove one case through the row's own control, the way the reporter did. The control only
      // appears on hover (opacity-0 until group-hover), so the row is hovered first.
      const firstRow = page.getByRole("row").filter({ hasText: "UI Run Count case 1" });
      await expect(firstRow).toBeVisible();
      await firstRow.hover();
      await firstRow.getByTitle("Remove from test run").click();

      // The body drops to 2.
      await expect(bodyCount).toHaveText("2", { timeout: 15_000 });

      // Persisted, not just repainted: the server agrees the run now holds 2.
      const listed = await (await api.get(`/api/projects/${ctx.projectId}/cycles`)).json();
      const thisRun = listed.find((r: { id: string }) => r.id === cycle.id);
      expect(thisRun.totalCases, "the server still reports the pre-delete count").toBe(2);
    } finally {
      await api.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      for (const id of testcaseIds) {
        await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      }
      await api.dispose();
    }
  });
});

/*
 * The run detail screen's progress bar, its defect fields and its Log Bug modal.
 *
 * Three cards: 10221778177 ("Progress not showing correct colours or progress" — blocked, skipped
 * and pending were summed into one amber segment, so a run with 100 of 109 still pending was 92%
 * "blocked"), 10221790207 ("Only failed test case should show defect key and Defect URL") and
 * 10226268634 ("The Log Bug UI should be consistent across both Test Run → Log Bug and Bug Page →
 * Log Bug" — the run's modal collected no severity at all, so every bug filed from a run took the
 * column default).
 */
test.describe("run detail — progress, defects and the bug modal", () => {
  test("EXE-U-30 every status gets its own colour in the run progress bar", { tag: '@tesbo.testId("TES-TC-1334")' }, async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Progress Run ${Date.now()}` } })
    ).json();
    const cases: string[] = [];
    try {
      // One case per status, so every segment has to be painted and none can hide behind another.
      for (const label of ["pass", "fail", "block", "skip", "pending"]) {
        const tc = await (
          await api.post(`/api/projects/${ctx.projectId}/testcases`, {
            data: { title: `UI Progress ${label} ${Date.now()}` },
          })
        ).json();
        cases.push(tc.id);
      }
      await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: cases } });
      const executions = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      const statuses = ["Passed", "Failed", "Blocked", "Skipped"];
      for (let i = 0; i < statuses.length; i++) {
        await api.patch(`/api/cycles/${cycle.id}/executions/${executions[i].id}`, { data: { status: statuses[i] } });
      }

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await expect(page.getByText("Progress", { exact: true })).toBeVisible();

      const segments = page.locator("div.flex.h-2 > div");
      await expect(segments, "one segment per status present in the run").toHaveCount(5);
      const colors = await segments.evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).backgroundColor),
      );
      // Five distinct colours: the defect was three statuses sharing the blocked amber.
      expect(new Set(colors).size, `segments repeated a colour: ${colors.join(", ")}`).toBe(5);
    } finally {
      await api.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      for (const id of cases) {
        await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      }
      await api.dispose();
    }
  });

  test("EXE-U-31 Bug Key/Bug Title fields appear only when the case is Failed AND a bug is actually linked", { tag: '@tesbo.testId("TES-TC-1335")' }, async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Defect Visibility ${Date.now()}`);
    // Driven from the full-page execute screen rather than the run's side panel: the panel opens
    // from a row interaction this file has no established pattern for, and the same rule governs
    // both screens. The execute screen renders its statuses as buttons.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let bugId = "";
    try {
      const [execution] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}/execute/${execution.id}`);
      await expect(page.getByText(testcase.title).first()).toBeVisible();

      // Opens on Untested: a bug reference would be meaningless, so the fields are not offered.
      await expect(page.getByText("Bug Key")).toBeHidden();

      // Marking Failed changes only the execution's status. It must not, on its own, imply a bug
      // exists — the fields stay hidden until a bug is actually logged/linked and persisted.
      await page.getByRole("button", { name: "Failed", exact: true }).first().click();
      await expect(page.getByText("Bug Key")).toBeHidden();
      await expect(page.getByText("Bug Title")).toBeHidden();

      // Persist a real bug link — what a successful "Log bug" / "Link Bug" does server-side. Only
      // now, with an actual bugs/bug_links row behind it, must the fields appear.
      const bugTitle = `E2E Defect Visibility ${Date.now()}`;
      const bug = await (
        await api.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: {
            title: bugTitle,
            integrationProvider: "JIRA",
            integrationIssueKey: "PROJ-4471",
            externalUrl: "https://example.atlassian.net/browse/PROJ-4471",
            links: [{ testcaseId: testcase.id, cycleId: cycle.id, executionId: execution.id }],
          },
        })
      ).json();
      bugId = bug.id;

      await page.reload();
      await expect(page.getByText("Bug Key")).toBeVisible();
      await expect(page.getByText("Bug Title")).toBeVisible();

      // A bug linked while the case was Failed must not keep showing once the case moves to any
      // other status — the fields are Failed-only, not "ever had a bug" only.
      await page.getByRole("button", { name: "Passed", exact: true }).first().click();
      await expect(page.getByText("Bug Key")).toBeHidden();
      await expect(page.getByText("Bug Title")).toBeHidden();
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });

  /*
   * Bug Key/Bug Title used to be free-text "Defect Key"/"Defect URL" inputs bound only to
   * executions.defect_key/defect_url — typing a value there never touched an actual bug, so a bug
   * filed via "Log bug" on this exact screen never showed up here. They now read the real
   * bugs/bug_links relationship (the same one the Test Case Detail Bugs tab reads), and are
   * read-only: there's nothing to type into a field that mirrors an existing bug's own data.
   */
  /*
   * Test-case titles here deliberately avoid the substring "Bug Key" — the run table's row
   * checkbox carries aria-label="Select {title}", and a title containing that phrase makes
   * getByLabel("Bug Key") ambiguously match both the checkbox and the actual input (strict-mode
   * violation). Read-only-ness is asserted purely via the `readonly` attribute rather than by
   * attempting `.fill()` against the field: Playwright's fill() waits for the target to become
   * editable, which a readonly input never does, so it hangs for the whole test timeout instead
   * of failing fast — the attribute check already proves the point.
   */
  test("EXE-U-31b Bug Key and Bug Title reflect the actual linked bug, and are read-only", async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Linked Bug Fields ${Date.now()}`);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const [execution] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      await api.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, { data: { status: "Failed" } });
      const bugTitle = `E2E Execute Linked Bug ${Date.now()}`;
      await api.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: bugTitle,
          integrationProvider: "JIRA",
          integrationIssueKey: "PROJ-5566",
          externalUrl: "https://example.atlassian.net/browse/PROJ-5566",
          links: [{ testcaseId: testcase.id, cycleId: cycle.id, executionId: execution.id }],
        },
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}/execute/${execution.id}`);
      const bugKeyInput = page.getByLabel("Bug Key");
      const bugTitleInput = page.getByLabel("Bug Title");
      // The execute page's own listBugs fetch fires after several other requests on this page
      // (auth, executions, members, jira/linear status) resolve first, so it can genuinely take
      // longer than the default 10s expect timeout under load — confirmed via a direct network
      // trace (the same request returned correct data at 933ms standalone, but took over 6s and
      // under 20s through this page under heavy local load). Longer timeout here, not everywhere.
      await expect(bugKeyInput).toHaveValue("PROJ-5566", { timeout: 20_000 });
      await expect(bugTitleInput).toHaveValue(bugTitle, { timeout: 20_000 });
      await expect(bugKeyInput).toHaveAttribute("readonly", "");
      await expect(bugTitleInput).toHaveAttribute("readonly", "");
    } finally {
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });

  test("EXE-U-31c the run drawer also shows Bug Key/Bug Title, read-only, from the same linked bug", async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Drawer Linked Bug Fields ${Date.now()}`);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const [execution] = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      await api.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, { data: { status: "Failed" } });
      const bugTitle = `E2E Drawer Linked Bug ${Date.now()}`;
      await api.post(`/api/projects/${ctx.projectId}/bugs`, {
        data: {
          title: bugTitle,
          integrationProvider: "LINEAR",
          integrationIssueKey: "ENG-7788",
          externalUrl: "https://linear.app/example/issue/ENG-7788",
          links: [{ testcaseId: testcase.id, cycleId: cycle.id, executionId: execution.id }],
        },
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByText(testcase.title).first().click();

      const bugKeyInput = page.getByLabel("Bug Key");
      const bugTitleInput = page.getByLabel("Bug Title");
      await expect(bugKeyInput).toHaveValue("ENG-7788");
      await expect(bugTitleInput).toHaveValue(bugTitle);
      await expect(bugKeyInput).toHaveAttribute("readonly", "");
      await expect(bugTitleInput).toHaveAttribute("readonly", "");
    } finally {
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });

  /*
   * Regression: loadPanelBug() fired one fetch per panel open with no guard against out-of-order
   * responses. Opening test case A (which has a linked bug) and then quickly switching to test
   * case B (which has none) could let A's slower response land after B's panel was already open,
   * overwriting panelBug with A's bug — so B's panel showed A's Bug Key/Title even though B has no
   * bug of its own. cycles/[cycleId]/page.tsx now stamps each request with the execution id it was
   * made for and drops any response that arrives after the panel has moved on to a different case.
   */
  test("EXE-U-31d the drawer never shows another test case's bug after switching before a slow bugs fetch resolves", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const stamp = Date.now();
    let cycleId = "";
    let bugId = "";
    const testcaseIds: string[] = [];
    try {
      const cycle = await (
        await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Bug Race Cycle ${stamp}` } })
      ).json();
      cycleId = cycle.id;
      await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
      const testcaseA = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `UI Bug Race A ${stamp}` } })
      ).json();
      const testcaseB = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `UI Bug Race B ${stamp}` } })
      ).json();
      testcaseIds.push(testcaseA.id, testcaseB.id);
      await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcaseA.id, testcaseB.id] } });
      const executions = await (await api.get(`/api/cycles/${cycle.id}/executions`)).json();
      const execA = executions.find((e: { testcaseId: string }) => e.testcaseId === testcaseA.id);

      const bugTitle = `E2E Bug Race ${stamp}`;
      const bug = await (
        await api.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: {
            title: bugTitle,
            integrationProvider: "JIRA",
            integrationIssueKey: "RACE-1",
            externalUrl: "https://example.atlassian.net/browse/RACE-1",
            links: [{ testcaseId: testcaseA.id, cycleId: cycle.id, executionId: execA.id }],
          },
        })
      ).json();
      bugId = bug.id;
      // The panel gates Bug Key/Title on Failed too, so A must actually be Failed for this test to
      // exercise the same code path a real "wrong bug leaked through" report would hit.
      await api.patch(`/api/cycles/${cycle.id}/executions/${execA.id}`, { data: { status: "Failed" } });

      // Delay only the GET fetch scoped to test case A, so its response can land after the panel
      // has already moved on to test case B — the exact ordering that used to leak A's bug onto B.
      await page.route(`**/api/projects/${ctx.projectId}/bugs**`, async (route) => {
        const request = route.request();
        const requestUrl = new URL(request.url());
        if (request.method() === "GET" && requestUrl.searchParams.get("testcaseId") === testcaseA.id) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await route.continue();
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);

      // Open A's panel — fires the (delayed) bugs fetch for A — then switch away before it lands.
      await page.getByText(testcaseA.title).first().click();
      await expect(page.getByRole("heading", { name: testcaseA.title })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByText(testcaseB.title).first().click();
      await expect(page.getByRole("heading", { name: testcaseB.title })).toBeVisible();

      // Give A's delayed fetch time to resolve while B's panel is the one open.
      await page.waitForTimeout(2000);

      // B has no bug of its own — A's late response must not have leaked onto B's panel.
      await expect(page.getByText("Bug Key")).toBeHidden();
      await expect(page.getByText("Bug Title")).toBeHidden();
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
      if (cycleId) await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
      for (const id of testcaseIds) {
        await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      }
      await api.dispose();
    }
  });

  /*
   * Regression: marking a case Failed via the drawer's Status buttons and clicking Save closes the
   * drawer and auto-opens the Report a Bug dialog (handlePanelSave). The dialog's onLogged used to
   * read this page's own `panelExecution` state, which handlePanelSave had already set to null
   * before opening the dialog — so a bug filed or linked through that exact path never made it back
   * onto screen: the drawer stayed closed and the user had to manually reopen the row (and even then
   * only saw it once a possibly-slow fetch resolved). onLogged now receives the execution the dialog
   * actually operated on and reopens the panel for it, so both "Log bug" and "Link existing bug"
   * show the real persisted Bug Key/Title immediately, with no page reload.
   */
  test("EXE-U-31e the drawer's Failed+Save auto-prompt reopens the panel with the linked bug after Link Existing Bug", async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Auto Prompt Link Bug ${Date.now()}`);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let existingBugId = "";
    try {
      const existingBugTitle = `E2E Existing Bug To Link ${Date.now()}`;
      const existingBug = await (
        await api.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: {
            title: existingBugTitle,
            integrationProvider: "JIRA",
            integrationIssueKey: "AUTO-99",
            externalUrl: "https://example.atlassian.net/browse/AUTO-99",
          },
        })
      ).json();
      existingBugId = existingBug.id;

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByText(testcase.title).first().click();
      await expect(page.getByRole("heading", { name: testcase.title })).toBeVisible();

      await page.getByRole("button", { name: "Failed", exact: true }).first().click();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      // Marking Failed and saving auto-opens the bug dialog; the drawer closes behind it.
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      await page.getByRole("button", { name: "Yes, link existing" }).click();
      await page.getByRole("button", { name: "Existing Tesbo bug" }).click();
      await page.getByRole("button", { name: "Choose an existing bug…" }).click();
      await expect(page.getByRole("heading", { name: "Link an existing bug" })).toBeVisible();
      await page.getByPlaceholder("Search bugs by title…").fill(existingBugTitle);
      await page.getByText(existingBugTitle, { exact: true }).click();
      await page.getByRole("button", { name: "Link Bug" }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      // The panel must reopen automatically, for this same test case, with the real linked bug's
      // data — no page reload, no manual re-click on the row required.
      await expect(page.getByRole("heading", { name: testcase.title })).toBeVisible();
      const bugKeyInput = page.getByLabel("Bug Key");
      const bugTitleInput = page.getByLabel("Bug Title");
      await expect(bugKeyInput).toHaveValue("AUTO-99", { timeout: 20_000 });
      await expect(bugTitleInput).toHaveValue(existingBugTitle, { timeout: 20_000 });
    } finally {
      if (existingBugId) await api.delete(`/api/bugs/${existingBugId}`, { failOnStatusCode: false });
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });

  /*
   * Regression: clicking the local "Failed" status button and then the "Log bug" footer button
   * directly — without an intervening Save — used to reopen the panel showing "Untested" and no
   * Bug Key/Title. openBugDialogFor(panelExecution) (the footer button's call) snapshots whatever
   * panelExecution.status currently is, which is still the last-*saved* status, not the locally
   * toggled one; onLogged then trusted that stale snapshot when reopening the panel. Since a
   * successful "Log bug"/"Link Bug" always forces the execution to Failed server-side regardless
   * (failLinkedExecutions), the fix reopens with status forced to "Failed" rather than trusting the
   * snapshot, so the case doesn't visibly revert to Untested and the fields it just fetched stay
   * visible instead of being hidden by the (now-wrong) status.
   */
  test("EXE-U-31f clicking Log bug without Save first still ends up Failed with the bug visible, not Untested", async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Log Bug No Save ${Date.now()}`);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByText(testcase.title).first().click();
      await expect(page.getByRole("heading", { name: testcase.title })).toBeVisible();

      // Toggle the local status button but never click Save, then go straight to Log bug — the
      // natural thing to do, since the whole point of marking a case Failed is to report the bug
      // it caused.
      await page.getByRole("button", { name: "Failed", exact: true }).click();
      await page.getByRole("button", { name: "Log bug" }).click();

      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      const bugTitle = `E2E No-Save Log Bug ${Date.now()}`;
      await page.getByPlaceholder("Brief summary of the bug…").fill(bugTitle);
      await page.getByRole("button", { name: "File Bug" }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      // The panel must reopen on this same test case, as Failed, with the bug it just filed —
      // immediately, not reverted to Untested with the fields hidden.
      await expect(page.getByRole("heading", { name: testcase.title })).toBeVisible();
      const bugKeyInput = page.getByLabel("Bug Key");
      const bugTitleInput = page.getByLabel("Bug Title");
      await expect(bugTitleInput).toHaveValue(bugTitle, { timeout: 20_000 });
      await expect(bugKeyInput).toBeVisible();
    } finally {
      const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
      const bugs = await bugsRes.json();
      for (const bug of bugs) {
        if (bug.links?.some((l: { testcaseId: string }) => l.testcaseId === testcase.id)) {
          await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
        }
      }
      await api.dispose();
      await cleanUp(cycle.id, testcase.id);
    }
  });

  test("EXE-U-32 the run Log Bug modal asks for severity and priority, like the Bugs page", { tag: '@tesbo.testId("TES-TC-1336")' }, async ({ page }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Log Bug Fields ${Date.now()}`);
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await expect(page.getByText(testcase.title).first()).toBeVisible();

      // The inline status control is a <select>, and marking Failed is what opens this modal — the
      // same pattern the passing tests at the top of this file use.
      await page.getByRole("combobox").first().selectOption("Failed");

      await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Severity")).toBeVisible();
      await expect(page.getByLabel("Bug priority")).toBeVisible();
      // Same defaults as the Bugs page: severity Medium, priority untriaged.
      await expect(page.getByLabel("Severity")).toHaveValue("Medium");
      await expect(page.getByLabel("Bug priority")).toHaveValue("");
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });
});


/*
 * The evidence viewer, and the automation provenance on a run (Basecamp 10189985971).
 *
 * These are the UI half of section 5. Before this card the backend had served
 * POST/GET /api/cycles/:cycleId/executions/:executionId/attachments since the bug-evidence work
 * and NOTHING in the frontend called either -- so evidence was storable, billed against the
 * workspace's storage allowance, and invisible in the product. There was not even a download route.
 * An automated run's screenshots and traces would have been write-only without this.
 */
test.describe("execution evidence and automation provenance", () => {
  /** Drives the automation ingest to produce a real automated run with a failure and evidence. */
  async function seedAutomatedRun(label: string) {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const testcase = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `UI Automation ${label} ${Date.now()}` },
        })
      ).json();

      const base = `/api/projects/${ctx.projectId}/automation`;
      const run = await (
        await api.post(`${base}/runs`, {
          data: {
            name: `UI Automation Run ${label} ${Date.now()}`,
            triggeredBy: "github-actions",
            branch: "release/ui-evidence",
            commitSha: "abc1234def5678",
            buildUrl: "https://github.com/acme/web/actions/runs/99",
            caseIds: [testcase.externalId],
          },
        })
      ).json();

      await api.post(`${base}/runs/${run.runId}/results`, {
        data: {
          caseId: testcase.externalId,
          status: "fail",
          durationMs: 2500,
          retryCount: 2,
          errorMessage: "AssertionError: expected the cart to be empty",
        },
      });

      // A 1x1 PNG, so the viewer has a real image to render.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
        "base64",
      );
      await api.post(`${base}/runs/${run.runId}/results/${testcase.externalId}/evidence`, {
        multipart: {
          kind: "screenshot",
          files: { name: "cart-failure.png", mimeType: "image/png", buffer: png },
        },
      });
      await api.post(`${base}/runs/${run.runId}/results/${testcase.externalId}/evidence`, {
        multipart: {
          kind: "trace",
          files: { name: "cart-trace.zip", mimeType: "application/zip", buffer: Buffer.from("PKtrace") },
        },
      });
      return { runId: run.runId as string, testcase };
    } finally {
      await api.dispose();
    }
  }

  test("an automated run shows its provenance, and the drawer shows the failure and its evidence", { tag: '@tesbo.testId("TES-TC-1337")' }, async ({
    page,
  }) => {
    const { runId, testcase } = await seedAutomatedRun("evidence");
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${runId}`);

      // Provenance strip: how the run was produced, and the commit it ran against. Renders nothing
      // at all on a manual run, which is why it is asserted on an automated one.
      await expect(page.getByTitle(/reported by an automation SDK/i).first()).toBeVisible();
      await expect(page.getByText("release/ui-evidence")).toBeVisible();
      await expect(page.getByText("abc1234", { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: /^Build/ })).toBeVisible();

      // Open the result's drawer.
      await page.getByText(testcase.title).first().click();

      // The framework's own failure text, kept separate from Actual Result -- that field is the
      // tester's prose and the ingest never writes it.
      await expect(page.getByText("Failure reported by automation")).toBeVisible();
      await expect(page.getByText(/AssertionError: expected the cart to be empty/)).toBeVisible();
      // Retries are a flakiness signal even on a result that eventually passed.
      await expect(page.getByText("2 retries")).toBeVisible();

      // Evidence, grouped by kind: the screenshot renders inline, the trace gets its own viewer.
      await expect(page.getByText("Evidence")).toBeVisible();
      await expect(page.getByRole("img", { name: "cart-failure.png" })).toBeVisible();
      await expect(page.getByText("cart-trace.zip")).toBeVisible();

      /*
       * A trace used to be a named download link, and this assertion pinned that presentation. It
       * is now the viewer card below (a .zip in the Downloads folder needs `npx playwright
       * show-trace` to be worth anything), so the expectation moved with the product — the archive
       * itself is still one click away, which is what this checks.
       */
      const traceDownload = page.getByRole("link", { name: /Download \.zip/ });
      await expect(traceDownload).toHaveAttribute(
        "href",
        new RegExp(`/api/cycles/${runId}/executions/[0-9a-f-]{36}/attachments/[0-9a-f-]{36}/download$`),
      );
    } finally {
      await cleanUp(runId, testcase.id);
    }
  });

  test("opening a result fetches its evidence once, and stops", async ({ page }) => {
    /*
     * The regression for a drawer that never left "Loading evidence…".
     *
     * ExecutionEvidencePanel took its onCountChange prop as a dependency of the fetch callback, and
     * this drawer passes an inline arrow that calls setExecutions(prev => prev.map(...)) — a new
     * array every time. So reporting the count re-rendered the parent, which produced a new
     * callback, a new `load`, and a re-fired effect: fetch, report, re-render, fetch, for as long as
     * the drawer stayed open. Evidence did appear, for the few milliseconds between one fetch
     * resolving and the next starting, which is why the assertions above pass either way and this
     * one is about the request count instead.
     *
     * Counted rather than timed: "still loading after N seconds" would only ever be flaky, while a
     * second request to the same endpoint is the defect itself, unambiguously.
     */
    const { runId, testcase } = await seedAutomatedRun("loop");
    try {
      const evidenceRequests: string[] = [];
      page.on("request", (request) => {
        // The list endpoint only — the download/trace-link calls the panel makes are legitimate.
        if (/\/executions\/[0-9a-f-]{36}\/attachments(\?|$)/.test(request.url())) {
          evidenceRequests.push(request.url());
        }
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${runId}`);
      await page.getByText(testcase.title).first().click();

      // The panel has to have actually loaded before a count of its requests means anything.
      await expect(page.getByRole("img", { name: "cart-failure.png" })).toBeVisible();
      await expect(page.getByText("Loading evidence…")).toHaveCount(0);

      // Long enough for the loop to have made many more: each iteration was one round trip.
      await page.waitForTimeout(3000);
      expect(
        evidenceRequests.length,
        `the drawer refetched evidence ${evidenceRequests.length} times; it must settle after one`,
      ).toBe(1);

      // And it settled showing the evidence, not the spinner.
      await expect(page.getByText("Loading evidence…")).toHaveCount(0);
      await expect(page.getByText("Evidence")).toBeVisible();
    } finally {
      await cleanUp(runId, testcase.id);
    }
  });

  /*
   * "[Test Runs] Evidence section flickers while loading in Test Case Detail View."
   *
   * The loop above is fixed and pinned by the previous test, but `load()` still unconditionally set
   * `loading` back to true on every call, including the refetch that follows every upload — and
   * never cleared `files` first. So each refetch tore the already-rendered evidence back down to the
   * "Loading evidence…" placeholder (with the header's stale count still showing above it) and then
   * rebuilt it, every single time evidence was added. Fixed by only showing that placeholder before
   * the panel's first fetch has completed; a later refetch now leaves whatever is already on screen
   * in place until the new data actually arrives.
   *
   * Each of the three specs below holds the post-upload GET open with page.route so the assertions
   * land while that refetch is actually in flight, rather than racing a real one.
   */
  test("uploading more evidence keeps what's already shown, instead of flashing back to the loading placeholder", async ({
    page,
  }) => {
    const { runId, testcase } = await seedAutomatedRun("upload-no-flicker");
    try {
      let getCount = 0;
      await page.route(/\/executions\/[0-9a-f-]{36}\/attachments(\?|$)/, async (route) => {
        if (route.request().method() === "GET") {
          getCount++;
          if (getCount > 1) await new Promise((resolve) => setTimeout(resolve, 700));
        }
        await route.continue();
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${runId}`);
      await page.getByText(testcase.title).first().click();
      await expect(page.getByRole("img", { name: "cart-failure.png" })).toBeVisible();

      await page.locator('input[type="file"]').setInputFiles({
        name: "extra-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("second file"),
      });

      // The refetch triggered by the upload is held open by the route above. While it's in flight,
      // the evidence already on screen (and the upload's own progress state) must stay put.
      await expect(page.getByText("Uploading…")).toBeVisible();
      await expect(page.getByRole("img", { name: "cart-failure.png" })).toBeVisible();
      await expect(page.getByText("Loading evidence…")).toHaveCount(0);

      await expect(page.getByText("extra-note.txt")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Loading evidence…")).toHaveCount(0);
      expect(getCount, "expected exactly one refetch after the upload").toBe(2);
    } finally {
      await cleanUp(runId, testcase.id);
    }
  });

  test("uploading the first piece of evidence for a result with none does not flash the loading placeholder", async ({
    page,
  }) => {
    const { cycle, testcase } = await setUpCycleWithOneCase(`UI Evidence First Upload ${Date.now()}`);
    try {
      let getCount = 0;
      await page.route(/\/executions\/[0-9a-f-]{36}\/attachments(\?|$)/, async (route) => {
        if (route.request().method() === "GET") {
          getCount++;
          if (getCount > 1) await new Promise((resolve) => setTimeout(resolve, 700));
        }
        await route.continue();
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByText(testcase.title).first().click();
      await expect(page.getByText(/No evidence attached/)).toBeVisible();

      await page.locator('input[type="file"]').setInputFiles({
        name: "first-shot.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
          "base64",
        ),
      });

      // Empty-state edge case of the same defect: the "No evidence attached" message must stay put
      // through the refetch too, rather than flashing to the loading placeholder in between.
      await expect(page.getByText("Uploading…")).toBeVisible();
      await expect(page.getByText(/No evidence attached/)).toBeVisible();
      await expect(page.getByText("Loading evidence…")).toHaveCount(0);

      await expect(page.getByRole("img", { name: "first-shot.png" })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/No evidence attached/)).toHaveCount(0);
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });

  test("a failed refresh after upload keeps existing evidence visible and reports the error, without flickering", async ({
    page,
  }) => {
    const { runId, testcase } = await seedAutomatedRun("upload-refresh-error");
    try {
      let getCount = 0;
      await page.route(/\/executions\/[0-9a-f-]{36}\/attachments(\?|$)/, async (route) => {
        if (route.request().method() === "GET") {
          getCount++;
          if (getCount > 1) {
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "boom" }),
            });
            return;
          }
        }
        await route.continue();
      });

      await page.goto(`/projects/${ctx.projectId}/cycles/${runId}`);
      await page.getByText(testcase.title).first().click();
      await expect(page.getByRole("img", { name: "cart-failure.png" })).toBeVisible();

      // The upload itself (a plain POST) still succeeds; only the follow-up GET that refreshes the
      // list fails, which is the case this error-handling path exists for.
      await page.locator('input[type="file"]').setInputFiles({
        name: "extra-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("second file"),
      });

      await expect(page.getByText("Couldn't load evidence for this result.")).toBeVisible({ timeout: 10_000 });
      // A failed refresh must not discard evidence that was already showing.
      await expect(page.getByRole("img", { name: "cart-failure.png" })).toBeVisible();
      await expect(page.getByText("Loading evidence…")).toHaveCount(0);
    } finally {
      await cleanUp(runId, testcase.id);
    }
  });

  test("a trace opens in the viewer, in place and in a new tab", async ({ page }) => {
    const { runId, testcase } = await seedAutomatedRun("trace");
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${runId}`);
      await page.getByText(testcase.title).first().click();

      const card = page.getByTestId("trace-viewer");
      await expect(card).toBeVisible();
      await expect(card.getByText("Playwright Trace")).toBeVisible();
      await expect(card.getByText("cart-trace.zip")).toBeVisible();

      /*
       * Both controls point at Playwright's hosted viewer, loaded with a signed link back to our
       * own API — the viewer fetches the archive itself, cross-origin and without cookies, so a
       * session-authorized download URL would be no use to it.
       */
      const newTab = card.getByTestId("trace-open-tab");
      await expect(newTab).toBeVisible();
      const href = await newTab.getAttribute("href");
      expect(href).toContain("https://trace.playwright.dev/?trace=");
      expect(decodeURIComponent(href ?? ""), "the viewer must be handed the public trace route").toMatch(
        /\/api\/public\/trace\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      await expect(newTab).toHaveAttribute("target", "_blank");

      // In place: the iframe is only mounted once asked for, so the drawer stays cheap to open.
      await expect(page.getByTestId("trace-iframe")).toHaveCount(0);
      await card.getByTestId("trace-view").click();
      const frame = page.getByTestId("trace-iframe");
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute("src", href ?? "");

      await card.getByTestId("trace-close").click();
      await expect(page.getByTestId("trace-iframe")).toHaveCount(0);
    } finally {
      await cleanUp(runId, testcase.id);
    }
  });

  test("a manual run shows no automation provenance", { tag: '@tesbo.testId("TES-TC-1338")' }, async ({ page }) => {
    // The other direction: every provenance field is null on a manual run, and the components
    // return null rather than an empty shell -- a manually executed run must look exactly as it did
    // before this feature existed.
    const title = `UI Manual Run Case ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await expect(page.getByText(testcase.title).first()).toBeVisible();
      await expect(page.getByTitle(/reported by an automation SDK/i)).toHaveCount(0);

      await page.getByText(testcase.title).first().click();
      await expect(page.getByText("Failure reported by automation")).toHaveCount(0);
      // The evidence panel itself is always present -- a person can attach evidence to a manual
      // result too, which they previously could not do anywhere in the UI.
      await expect(page.getByText("Evidence")).toBeVisible();
      await expect(page.getByText(/No evidence attached/)).toBeVisible();
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });
});
