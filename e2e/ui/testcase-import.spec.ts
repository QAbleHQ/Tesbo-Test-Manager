import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import * as XLSX from "xlsx";
import { toCsv } from "../utils/csv";
import { env } from "../utils/env";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

test.describe("test case import", () => {
  test("importing a CSV shows a completion toast that survives closing the import modal", { tag: '@tesbo.testId("TES-TC-824")' }, async ({ page }) => {
    // Regression test for: import completed successfully but no toast notification was
    // ever shown, during or after — see ImportTestCasesModal.tsx / testcases/page.tsx.
    const stamp = Date.now();
    const titleA = `E2E Import ${stamp} A`;
    const titleB = `E2E Import ${stamp} B`;
    const csv = `Title,Description\n${titleA},First imported row\n${titleB},Second imported row\n`;

    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByRole("button", { name: "Import", exact: true }).click();

    // Upload step: "Browse Files" just opens the OS picker, so set the file directly on
    // the underlying (hidden) input instead of clicking through a native file dialog.
    await page.locator('input[type="file"]').setInputFiles({
      name: "import.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Next" }).click();

    // Mapping step: "Title" auto-maps from the CSV header, so the import can proceed as-is.
    await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible();
    await page.getByRole("button", { name: "Import 2 rows" }).click();

    // Result step: the wizard's own in-modal summary confirms the import ran.
    await expect(page.getByText("Import complete.")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Done" }).click();

    // The modal is now closed — a completion toast must still be visible on the page.
    await expect(page.getByText("2 test cases imported successfully")).toBeVisible();

    // The imported rows actually landed, not just the toast text.
    await expect(page.getByRole("button", { name: titleA })).toBeVisible();
    await expect(page.getByRole("button", { name: titleB })).toBeVisible();

    // Clean up via the API so repeat runs don't accumulate test cases in the smoke project.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      for (const title of [titleA, titleB]) {
        const listRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: title },
        });
        const list = await listRes.json();
        const match = list.find((tc: { id: string; title: string }) => tc.title === title);
        if (match) await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`);
      }
    } finally {
      await api.dispose();
    }
  });
});

/*
 * The import wizard in depth, and the export links that sit beside it.
 *
 * Why this needs a browser rather than the API suite: the server-side import routes don't do
 * anything (they were stubs, now removed). The importer IS the wizard — ImportTestCasesModal parses
 * the workbook, decides which column means what, dedupes titles, creates suites, splits steps, and
 * POSTs one createTestCase per row. None of that logic exists anywhere else, so a browser is the
 * only place it can be exercised at all. api/import-export.spec.ts covers the export endpoints and
 * the template.
 *
 * Runs against its own disposable workspace ("import-export-ui"), and each test against a project of
 * its own: the wizard reads the whole project to find duplicate titles and to reuse suites, so a
 * shared project other specs seed into would change what a row is compared against. Archiving the
 * project in teardown takes its cases and suites with it.
 */

const IMPORT_UI_STATE = path.join(__dirname, "../.auth/state-import-export-ui.json");

test.describe("test case import wizard", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("import-export-ui");
    if (!tenant) return;
    await writeStorageState(tenant.owner, "import-export-ui");
    api = await loginAs(tenant.owner);
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /* ─────────────────────────── fixtures ─────────────────────────── */

  interface Fixture {
    page: Page;
    projectId: string;
  }

  let keyCounter = 0;

  /**
   * A fresh project plus a page signed in as the tenant owner.
   *
   * The key is explicit and short because projectKey() truncates a derived key to 16 characters and
   * (organization_id, key) is unique forever — "E2E Import Wizard <stamp>" names would all collapse
   * to the same key and collide (see api/projects.spec.ts).
   */
  async function withProject(browser: Browser, label: string): Promise<Fixture> {
    keyCounter += 1;
    const res = await api.post("/api/projects", {
      data: {
        name: `E2E Import ${label} ${Date.now()}`,
        key: `IEUI${Date.now().toString().slice(-9)}${keyCounter % 10}`.slice(0, 16),
      },
    });
    if (!res.ok()) throw new Error(`Could not create the fixture project (${res.status()}): ${await res.text()}`);
    const projectId = (await res.json()).id as string;

    // browser.newContext() doesn't inherit the ui project's `use` options, so baseURL is explicit —
    // without it every relative goto() resolves against nothing.
    const context = await browser.newContext({ baseURL: env.webBaseUrl, storageState: IMPORT_UI_STATE });
    return { page: await context.newPage(), projectId };
  }

  async function disposeProject(fixture: Fixture | undefined): Promise<void> {
    if (!fixture) return;
    await fixture.page.context().close();
    // DELETE archives the project, which is enough: an archived project is outside every list, count
    // and plan limit, and its test cases and suites go with it.
    await api.delete(`/api/projects/${fixture.projectId}`, { failOnStatusCode: false });
  }

  /** The list payload — deliberately narrow: it carries no description, preconditions or steps. */
  const listCases = async (projectId: string) =>
    (await (await api.get(`/api/projects/${projectId}/testcases`)).json()) as {
      id: string;
      title: string;
      suiteId: string | null;
    }[];

  /** The full record, for the fields the list endpoint doesn't select. */
  const getCase = async (projectId: string, testcaseId: string) =>
    (await (await api.get(`/api/projects/${projectId}/testcases/${testcaseId}`)).json()) as {
      title: string;
      description: string;
      preconditions: string;
      steps: { stepNumber: number; action: string; expectedResult: string }[];
      automationStatus: string;
      attachments: string | null;
    };

  const listSuites = async (projectId: string) =>
    (await (await api.get(`/api/projects/${projectId}/suites`)).json()) as {
      id: string;
      name: string;
      parentId: string | null;
    }[];

  /* ─────────────────────────── wizard drivers ─────────────────────────── */

  /** Opens the wizard from wherever the page already is — does NOT navigate. Use this whenever the
   *  current `?suiteId=` (set by clicking into a suite, not by a fresh goto) needs to be preserved;
   *  openWizard() below re-navigates to the bare URL and would silently drop it. */
  async function clickImport(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("Upload a CSV or Excel file to import test cases.")).toBeVisible();
  }

  async function openWizard(page: Page, projectId: string): Promise<void> {
    await page.goto(`/projects/${projectId}/testcases`);
    await clickImport(page);
  }

  async function chooseFile(page: Page, name: string, buffer: Buffer, mimeType: string): Promise<void> {
    // "Browse Files" opens the OS picker, so the file is set on the hidden input directly.
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
    await page.getByRole("button", { name: "Next" }).click();
  }

  const uploadCsv = (page: Page, csv: string) =>
    chooseFile(page, "import.csv", Buffer.from(csv), "text/csv");

  const uploadWorkbook = (page: Page, sheets: Record<string, string[][]>) => {
    const workbook = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
    }
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return chooseFile(
      page,
      "import.xlsx",
      buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  };

  /**
   * The <select> that maps a field, addressed through its own label.
   *
   * The labels aren't tied to their control with `for`/`id`, so getByLabel can't see them; the
   * required fields also render a "*" inside the label, hence starts-with rather than equality.
   */
  const mappingFor = (page: Page, label: string) =>
    page.locator(`xpath=//label[starts-with(normalize-space(.), "${label}")]/following-sibling::select`);

  async function runImport(page: Page, rows: number): Promise<void> {
    await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible();
    await page.getByRole("button", { name: `Import ${rows} rows` }).click();
    await expect(page.getByText("Import complete.")).toBeVisible({ timeout: 30_000 });
  }

  /* ─────────────────────────── the wizard ─────────────────────────── */

  test("auto-maps the column names other tools export, without any manual mapping", { tag: '@tesbo.testId("TES-TC-825")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Aliases");
      const { page, projectId } = fixture;
      const stamp = Date.now();
      const title = `E2E Alias Case ${stamp}`;
      const suiteName = `Alias Module ${stamp}`;
      // None of these headers is a field name: they're the labels Jira/TestRail/Zephyr exports use,
      // and autoMap's alias table is what turns them into fields.
      const csv = toCsv(
        ["Summary", "Details", "Prerequisites", "Module", "Prio"],
        [[title, "Came from another tool", "Already signed in", suiteName, "P1"]],
      );

      await openWizard(page, projectId);
      await uploadCsv(page, csv);

      await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible();
      await expect(mappingFor(page, "Title"), "Summary maps to Title").toHaveValue("0");
      await expect(mappingFor(page, "Description")).toHaveValue("1");
      await expect(mappingFor(page, "Preconditions")).toHaveValue("2");
      await expect(mappingFor(page, "Suite")).toHaveValue("3");
      await expect(mappingFor(page, "Priority")).toHaveValue("4");

      await runImport(page, 1);
      await expect(page.getByText("1 test case imported successfully")).toBeVisible();

      const cases = await listCases(projectId);
      expect(cases.map((c) => c.title)).toEqual([title]);
      const imported = await getCase(projectId, cases[0].id);
      expect(imported.description).toBe("Came from another tool");
      expect(imported.preconditions).toBe("Already signed in");
      const suites = await listSuites(projectId);
      expect(suites.find((s) => s.id === cases[0].suiteId)?.name).toBe(suiteName);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("finds the header row below leading junk rows, and numbers errors by file line", { tag: '@tesbo.testId("TES-TC-826")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Header Row");
      const { page, projectId } = fixture;
      const stamp = Date.now();
      const title = `E2E Junk Header ${stamp}`;
      // Line 1 is a report banner of the kind exports put above the table; the real header is line 2,
      // line 3 has no title, line 4 is importable.
      const csv = `Exported from another tool,\nTitle,Description\n,missing its title\n${title},fine\n`;

      await openWizard(page, projectId);
      await uploadCsv(page, csv);

      await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible();
      await expect(page.getByText("2 rows found in Sheet1. Map the columns below.")).toBeVisible();
      await expect(mappingFor(page, "Title"), "the banner row is not treated as the header").toHaveValue("0");

      await page.getByRole("button", { name: "Import 2 rows" }).click();
      await expect(page.getByText("Import complete.")).toBeVisible({ timeout: 30_000 });
      // 1 of 2 rows landed, so this is the partial-import state, not the all-clear one — the banner
      // must not say "successfully" while a row was rejected. See ImportTestCasesModal.tsx.
      await expect(page.getByText("1 of 2 test cases imported")).toBeVisible();

      // The error row number must point at the line the user can find in their file — line 3 — not
      // at an index into the rows the parser kept.
      const errorRow = page.getByRole("row").filter({ hasText: "Title is required" });
      await expect(errorRow).toBeVisible();
      await expect(errorRow.getByRole("cell").first()).toHaveText("3");

      expect((await listCases(projectId)).map((c) => c.title)).toEqual([title]);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("will not import until a Title column is mapped", { tag: '@tesbo.testId("TES-TC-827")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "No Title");
      const { page, projectId } = fixture;
      await openWizard(page, projectId);
      await uploadCsv(page, toCsv(["Title", "Description"], [[`E2E Unmapped ${Date.now()}`, "x"]]));

      const importButton = page.getByRole("button", { name: "Import 1 rows" });
      await expect(importButton).toBeEnabled();
      // Title is the one required field: unmapping it must close the door rather than import a
      // project full of "Untitled test case".
      await mappingFor(page, "Title").selectOption("");
      await expect(importButton).toBeDisabled();

      await mappingFor(page, "Title").selectOption("0");
      await expect(importButton).toBeEnabled();
      expect(await listCases(projectId), "nothing was created while mapping").toEqual([]);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("skips titles that already exist and titles repeated inside the file", { tag: '@tesbo.testId("TES-TC-828")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Duplicates");
      const { page, projectId } = fixture;
      const stamp = Date.now();
      const existing = `E2E Duplicate Existing ${stamp}`;
      const fresh = `E2E Duplicate Fresh ${stamp}`;
      await api.post(`/api/projects/${projectId}/testcases`, { data: { title: existing } });

      // Row 2 collides with what's already in the project; rows 3 and 4 collide with each other, and
      // the match is case- and whitespace-insensitive (normalizeTitle), so the trailing spaces and
      // capitalisation must not let the second copy through.
      const csv = toCsv(
        ["Title"],
        [[existing.toUpperCase()], [fresh], [`  ${fresh.toLowerCase()}  `]],
      );

      await openWizard(page, projectId);
      await uploadCsv(page, csv);
      await runImport(page, 3);

      // 1 of 3 rows landed and 2 were duplicates, so this is the partial-import state.
      await expect(page.getByText("1 of 3 test cases imported")).toBeVisible();
      await expect(page.getByText("2 rows had errors and were skipped. See the details below.")).toBeVisible();
      await expect(
        page.getByText("Skipped duplicate title: already exists in this project"),
      ).toBeVisible();
      await expect(
        page.getByText("Skipped duplicate title: repeated in this import file"),
      ).toBeVisible();

      const titles = (await listCases(projectId)).map((c) => c.title).sort();
      expect(titles, "exactly one copy of each title exists").toEqual([existing, fresh].sort());
    } finally {
      await disposeProject(fixture);
    }
  });

  // Regression test for: when every row in the file was rejected, the result step still rendered the
  // green "successfully" banner with a checkmark, reporting "0 test cases imported successfully" — see
  // ImportTestCasesModal.tsx. The banner must switch to the failure treatment instead, and must never
  // say "successfully" when nothing was imported.
  test("shows a failure banner, not a success banner, when every row is rejected", async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "All Rejected");
      const { page, projectId } = fixture;
      const existing = `E2E All Rejected ${Date.now()}`;
      await api.post(`/api/projects/${projectId}/testcases`, { data: { title: existing } });

      // The one row in the file collides with the case already in the project, so 0 of 1 rows import.
      await openWizard(page, projectId);
      await uploadCsv(page, toCsv(["Title"], [[existing]]));
      await runImport(page, 1);

      await expect(page.getByText("No test cases were imported")).toBeVisible();
      await expect(
        page.getByText("All 1 row in the file had errors. Fix the issues below and try again."),
      ).toBeVisible();
      await expect(page.getByText("0 test cases imported successfully")).toBeHidden();
      await expect(page.getByText("Skipped duplicate title: already exists in this project")).toBeVisible();

      // The shortcut back to mapping works, since a wall of identical errors is often a mapping
      // problem rather than genuinely bad data.
      await page.getByRole("button", { name: "Edit column mapping" }).click();
      await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible();

      // Only the pre-existing case is present — the rejected row did not create a duplicate.
      expect((await listCases(projectId)).map((c) => c.title)).toEqual([existing]);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("creates the suite and its component subfolder, and reuses them on a second import", { tag: '@tesbo.testId("TES-TC-829")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Suites");
      const { page, projectId } = fixture;
      const stamp = Date.now();
      const suiteName = `E2E Suite ${stamp}`;
      const componentName = `E2E Component ${stamp}`;
      const first = `E2E Suite Case A ${stamp}`;
      const second = `E2E Suite Case B ${stamp}`;

      await openWizard(page, projectId);
      await uploadCsv(page, toCsv(["Title", "Suite", "Component"], [[first, suiteName, componentName]]));
      await runImport(page, 1);
      await page.getByRole("button", { name: "Done" }).click();

      const suites = await listSuites(projectId);
      const parent = suites.find((s) => s.name === suiteName);
      const child = suites.find((s) => s.name === componentName);
      expect(parent, "the Suite column created a top-level suite").toBeTruthy();
      expect(child, "the Component column created a subfolder").toBeTruthy();
      expect(child!.parentId, "…nested under the suite, not at the root").toBe(parent!.id);
      const cases = await listCases(projectId);
      expect(cases.find((c) => c.title === first)!.suiteId).toBe(child!.id);

      // A second import naming the same suite in a different case must land in the SAME folders —
      // normalizeSuiteName is what stops a project accruing "Checkout"/"checkout " duplicates.
      await openWizard(page, projectId);
      await uploadCsv(
        page,
        toCsv(["Title", "Suite", "Component"], [[second, ` ${suiteName.toUpperCase()} `, componentName]]),
      );
      await runImport(page, 1);

      const afterSuites = await listSuites(projectId);
      expect(afterSuites, "no duplicate folders were created").toHaveLength(suites.length);
      const afterCases = await listCases(projectId);
      expect(afterCases.find((c) => c.title === second)!.suiteId).toBe(child!.id);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("splits steps into actions with their expected results", { tag: '@tesbo.testId("TES-TC-830")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Steps");
      const { page, projectId } = fixture;
      const title = `E2E Steps Case ${Date.now()}`;
      // The convention Tesbo's own export writes: " | " between steps, " => " between an action and
      // its expected result, with the expected result optional. This is what makes an exported file
      // re-importable without losing the expected results.
      const steps = "Open the login page => The form is shown | Submit empty credentials";

      await openWizard(page, projectId);
      await uploadCsv(page, toCsv(["Title", "Steps"], [[title, steps]]));
      await runImport(page, 1);

      const listed = (await listCases(projectId)).find((c) => c.title === title)!;
      const imported = await getCase(projectId, listed.id);
      expect(imported.steps).toEqual([
        { stepNumber: 1, action: "Open the login page", expectedResult: "The form is shown" },
        { stepNumber: 2, action: "Submit empty credentials", expectedResult: "" },
      ]);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("an imported test case's steps still show correctly when reopened for editing", async ({ browser }) => {
    // Regression test for: testcases.steps comes back as a genuine array for a row written by
    // import (steps is a jsonb column and insertImportChunk never stringifies it — see
    // insertImportChunk in legacy.service.ts), but as a JSON-encoded string for a row written by
    // this page's own create/edit save or by Zyra (both double-encode). parseSteps
    // (testcases/page.tsx) used to assume the string shape exclusively, so reopening an IMPORTED
    // case's edit panel silently showed one blank step instead of the steps that were actually
    // imported, even though GET /testcases/:id (asserted above) already returned them correctly.
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Steps Reopen");
      const { page, projectId } = fixture;
      const title = `E2E Steps Reopen Case ${Date.now()}`;
      const steps = "Open the login page => The form is shown | Submit empty credentials => Validation error is shown";

      await openWizard(page, projectId);
      await uploadCsv(page, toCsv(["Title", "Steps"], [[title, steps]]));
      await runImport(page, 1);
      await page.getByRole("button", { name: "Done" }).click();

      await page.getByRole("button", { name: title }).click();
      const panel = page.locator("aside");
      const actionFields = panel.getByPlaceholder("Describe the action to perform");
      await expect(actionFields).toHaveCount(2);
      await expect(actionFields.nth(0)).toHaveValue("Open the login page");
      await expect(actionFields.nth(1)).toHaveValue("Submit empty credentials");
    } finally {
      await disposeProject(fixture);
    }
  });

  test("builds a single step from separate Action/Expected Result columns when Steps isn't mapped", { tag: '@tesbo.testId("TES-TC-2103")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Action Expected Columns");
      const { page, projectId } = fixture;
      const title = `E2E Action Expected Case ${Date.now()}`;

      await openWizard(page, projectId);
      await uploadCsv(
        page,
        toCsv(
          ["Title", "Action", "Expected Result"],
          [[title, "Click the submit button", "The form is submitted"]],
        ),
      );

      await expect(mappingFor(page, "Action"), "auto-maps by its own header, not into Steps").toHaveValue("1");
      await expect(mappingFor(page, "Expected Result")).toHaveValue("2");
      // Steps itself has nothing to map to — a file like this has no combined DSL column at all.
      await expect(mappingFor(page, "Steps")).toHaveValue("");
      await runImport(page, 1);

      const listed = (await listCases(projectId)).find((c) => c.title === title)!;
      const imported = await getCase(projectId, listed.id);
      expect(imported.steps).toEqual([
        { stepNumber: 1, action: "Click the submit button", expectedResult: "The form is submitted" },
      ]);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("a mapped Steps column wins over Action/Expected Result when both are mapped", { tag: '@tesbo.testId("TES-TC-2104")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Steps Priority");
      const { page, projectId } = fixture;
      const title = `E2E Steps Priority Case ${Date.now()}`;

      await openWizard(page, projectId);
      await uploadCsv(
        page,
        toCsv(
          ["Title", "Steps", "Action", "Expected Result"],
          [[title, "Open the app => It loads", "This column must be ignored", "So must this one"]],
        ),
      );
      await runImport(page, 1);

      const listed = (await listCases(projectId)).find((c) => c.title === title)!;
      const imported = await getCase(projectId, listed.id);
      expect(imported.steps).toEqual([{ stepNumber: 1, action: "Open the app", expectedResult: "It loads" }]);
    } finally {
      await disposeProject(fixture);
    }
  });

  test("the downloaded sample CSV template auto-maps its Action and Expected Result columns", { tag: '@tesbo.testId("TES-TC-2105")' }, async ({ browser }) => {
    // Regression test for: the official sample template only ever had a combined "steps" column, so
    // Action and Expected Result had no header to match and always showed "-- Skip --" in Map
    // Columns, even though those two fields are otherwise fully supported (TES-TC-2103/2104).
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Template Automap");
      const { page, projectId } = fixture;

      const templateRes = await page.request.get(
        `${env.apiBaseUrl}/api/projects/${projectId}/testcases/import/template?format=csv`,
      );
      expect(templateRes.status()).toBe(200);
      const templateCsv = await templateRes.text();

      await openWizard(page, projectId);
      await uploadCsv(page, templateCsv);

      await expect(mappingFor(page, "Steps")).not.toHaveValue("");
      await expect(mappingFor(page, "Action"), "the template's own Action column must auto-map").not.toHaveValue("");
      await expect(
        mappingFor(page, "Expected Result"),
        "the template's own Expected Result column must auto-map",
      ).not.toHaveValue("");
    } finally {
      await disposeProject(fixture);
    }
  });

  test("maps Automation Type and Notes columns and imports them", { tag: '@tesbo.testId("TES-TC-2102")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Automation Notes");
      const { page, projectId } = fixture;
      const title = `E2E Automation Notes Case ${Date.now()}`;

      await openWizard(page, projectId);
      await uploadCsv(
        page,
        toCsv(
          ["Title", "Automation Type", "Notes"],
          [[title, "Automated", "Captured a screenshot of the failure"]],
        ),
      );

      await expect(mappingFor(page, "Automation Type"), "the header auto-maps by its exact field label").toHaveValue("1");
      await expect(mappingFor(page, "Notes")).toHaveValue("2");
      await runImport(page, 1);

      const listed = (await listCases(projectId)).find((c) => c.title === title)!;
      const imported = await getCase(projectId, listed.id);
      expect(imported.automationStatus).toBe("Automated");
      expect(imported.attachments).toBe("Captured a screenshot of the failure");
    } finally {
      await disposeProject(fixture);
    }
  });

  test("offers a worksheet picker for a workbook, defaulting to the sheet holding test cases", { tag: '@tesbo.testId("TES-TC-831")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Workbook");
      const { page, projectId } = fixture;
      const stamp = Date.now();
      const title = `E2E Workbook Case ${stamp}`;

      await openWizard(page, projectId);
      await uploadWorkbook(page, {
        // A cover sheet with no Title column, first in the workbook — the wizard must not settle for
        // it just because it comes first.
        "Read Me": [["Generated by", "another tool"], ["Date", "yesterday"]],
        Cases: [["Title", "Description"], [title, "on the second sheet"], [`${title} B`, "also here"]],
      });

      await expect(page.getByText("2 rows found in Cases. Map the columns below.")).toBeVisible();
      const worksheet = page.locator("select").first();
      await expect(worksheet).toHaveValue("Cases");

      // Switching sheets re-reads the headers and re-maps against them.
      await worksheet.selectOption("Read Me");
      await expect(page.getByText("1 row found in Read Me. Map the columns below.")).toBeVisible();
      await expect(mappingFor(page, "Title"), "the cover sheet has no title column").toHaveValue("");

      await worksheet.selectOption("Cases");
      await runImport(page, 2);
      expect((await listCases(projectId)).map((c) => c.title).sort()).toEqual(
        [title, `${title} B`].sort(),
      );
    } finally {
      await disposeProject(fixture);
    }
  });

  test("keeps the user on the upload step when there is nothing readable in the file", { tag: '@tesbo.testId("TES-TC-832")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Unreadable");
      const { page, projectId } = fixture;

      await openWizard(page, projectId);
      await uploadCsv(page, "\n\n\n");

      await expect(page.getByText("No readable sheets or rows were found in this file.")).toBeVisible();
      // Still on step 1, with the file swappable — not advanced into a mapping step with no columns.
      await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
      await expect(page.getByText("Map your file columns to test case fields.")).toBeHidden();
      expect(await listCases(projectId)).toEqual([]);
    } finally {
      await disposeProject(fixture);
    }
  });

  // Regression test for: the wizard let a PDF or image file through to the Map Columns step —
  // the <input accept> attribute only hints at the OS file picker (and not reliably even there;
  // an "All Files" filter or a file manager that ignores it slips past it), and drag-and-drop
  // bypasses it entirely, so it was never a real gate. ImportTestCasesModal.handleFileSelect now
  // checks the file extension itself before ever handing the file to the XLSX parser.
  const UNSUPPORTED_FILES: [name: string, mimeType: string, ext: string][] = [
    ["not-a-spreadsheet.pdf", "application/pdf", ".pdf"],
    ["screenshot.png", "image/png", ".png"],
  ];

  for (const [name, mimeType, ext] of UNSUPPORTED_FILES) {
    test(`rejects a ${ext} file and keeps the user on the upload step`, async ({ browser }) => {
      let fixture: Fixture | undefined;
      try {
        fixture = await withProject(browser, `Bad Format ${ext}`);
        const { page, projectId } = fixture;
        await openWizard(page, projectId);

        await page.locator('input[type="file"]').setInputFiles({
          name,
          mimeType,
          buffer: Buffer.from("not actually a spreadsheet"),
        });

        await expect(
          page.getByText(`Unsupported file format "${ext}". Please upload a .csv, .xlsx, or .xls file.`),
        ).toBeVisible();
        // Nothing to advance with — Next stays disabled and the wizard never reaches Map Columns.
        await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
        await expect(page.getByText("Map your file columns to test case fields.")).toBeHidden();

        // Recovery: picking a real file afterwards clears the error and proceeds normally.
        const title = `E2E Bad Format Recovery ${Date.now()}`;
        await uploadCsv(page, toCsv(["Title"], [[title]]));
        await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible();
        expect(await listCases(projectId)).toEqual([]);
      } finally {
        await disposeProject(fixture);
      }
    });
  }

  test("rejects a file with no extension at all", async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "No Extension");
      const { page, projectId } = fixture;
      await openWizard(page, projectId);

      await page.locator('input[type="file"]').setInputFiles({
        name: "README",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("not a spreadsheet"),
      });

      await expect(
        page.getByText("This file type isn't supported. Please upload a .csv, .xlsx, or .xls file."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    } finally {
      await disposeProject(fixture);
    }
  });

  test("accepts a spreadsheet file whose extension is uppercase", async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Uppercase Ext");
      const { page, projectId } = fixture;
      const title = `E2E Uppercase Ext ${Date.now()}`;
      await openWizard(page, projectId);

      await page.locator('input[type="file"]').setInputFiles({
        name: "IMPORT.CSV",
        mimeType: "text/csv",
        buffer: Buffer.from(toCsv(["Title"], [[title]])),
      });
      await page.getByRole("button", { name: "Next" }).click();
      await runImport(page, 1);

      expect((await listCases(projectId)).map((c) => c.title)).toEqual([title]);
    } finally {
      await disposeProject(fixture);
    }
  });

  // Regression test for: nothing capped upload size, so a huge file could hang the in-browser
  // XLSX parse (parseWorkbook runs entirely client-side — there is no server-side preview to fall
  // back on, see the file banner above). handleFileSelect now rejects anything over 20MB before
  // it ever reaches the parser.
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

  test("rejects a file over the 20MB upload limit", async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Size Limit");
      const { page, projectId } = fixture;
      await openWizard(page, projectId);

      // One byte over the limit is enough to prove the ">" boundary — no need to actually build
      // a huge parseable spreadsheet for the rejection path.
      const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, "a".charCodeAt(0));
      await page.locator('input[type="file"]').setInputFiles({
        name: "oversized.csv",
        mimeType: "text/csv",
        buffer: oversized,
      });

      await expect(
        page.getByText("File is too large (20.0MB). Maximum allowed size is 20MB."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
      await expect(page.getByText("Map your file columns to test case fields.")).toBeHidden();
    } finally {
      await disposeProject(fixture);
    }
  });

  test("accepts a file at exactly the 20MB upload limit", async ({ browser }) => {
    test.setTimeout(60_000);
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Size Boundary");
      const { page, projectId } = fixture;
      const title = `E2E Size Boundary ${Date.now()}`;

      // Padded with blank lines (which the parser already drops via blankrows:false) rather than
      // one huge cell, so the file is exactly MAX_UPLOAD_BYTES without stressing the CSV parser.
      const header = "Title\n";
      const dataLine = `${title}\n`;
      const staticBytes = Buffer.byteLength(header) + Buffer.byteLength(dataLine);
      const filler = "\n".repeat(MAX_UPLOAD_BYTES - staticBytes);
      const csv = header + filler + dataLine;
      expect(Buffer.byteLength(csv)).toBe(MAX_UPLOAD_BYTES);

      await openWizard(page, projectId);
      await page.locator('input[type="file"]').setInputFiles({
        name: "boundary.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
      await page.getByRole("button", { name: "Next" }).click();

      // At exactly the limit, the size check must not reject it — the wizard still reaches mapping.
      await expect(page.getByText("Map your file columns to test case fields.")).toBeVisible({ timeout: 30_000 });
      await runImport(page, 1);
      expect((await listCases(projectId)).map((c) => c.title)).toEqual([title]);
    } finally {
      await disposeProject(fixture);
    }
  });

  /* ─────────────────────────── the export links ─────────────────────────── */

  test("the export menu links to both formats and to both templates", { tag: '@tesbo.testId("TES-TC-833")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Export Menu");
      const { page, projectId } = fixture;
      const title = `E2E Export Menu Case ${Date.now()}`;
      await api.post(`/api/projects/${projectId}/testcases`, { data: { title } });

      await page.goto(`/projects/${projectId}/testcases`);
      await page.getByRole("button", { name: "Export", exact: true }).click();

      const expected: [string, string][] = [
        ["Export as CSV", `${env.apiBaseUrl}/api/projects/${projectId}/testcases/export/csv`],
        ["Export as Excel", `${env.apiBaseUrl}/api/projects/${projectId}/testcases/export/xlsx`],
        ["Download CSV template", `${env.apiBaseUrl}/api/projects/${projectId}/testcases/import/template?format=csv`],
        ["Download Excel template", `${env.apiBaseUrl}/api/projects/${projectId}/testcases/import/template?format=xlsx`],
      ];
      for (const [name, href] of expected) {
        await expect(page.getByRole("link", { name })).toHaveAttribute("href", href);
      }

      // The links are plain hrefs, so what matters is that following one with the page's own session
      // actually downloads something — the browser sends the session cookie on this navigation, which
      // is why these endpoints can require one.
      const csv = await page.request.get(expected[0][1]);
      expect(csv.status()).toBe(200);
      expect(csv.headers()["content-type"]).toContain("text/csv");
      expect(await csv.text()).toContain(title);

      const template = await page.request.get(expected[2][1]);
      expect(template.status()).toBe(200);
      expect(await template.text()).toContain("Example login test");
    } finally {
      await disposeProject(fixture);
    }
  });

  test("the run detail page exports the run as CSV", { tag: '@tesbo.testId("TES-TC-834")' }, async ({ browser }) => {
    let fixture: Fixture | undefined;
    try {
      fixture = await withProject(browser, "Run Export");
      const { page, projectId } = fixture;
      const stamp = Date.now();
      const title = `E2E Run Export Case ${stamp}`;
      const testcase = await (
        await api.post(`/api/projects/${projectId}/testcases`, { data: { title } })
      ).json();
      const cycle = await (
        await api.post(`/api/projects/${projectId}/cycles`, { data: { name: `E2E Run Export ${stamp}` } })
      ).json();
      await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });

      await page.goto(`/projects/${projectId}/cycles/${cycle.id}`);
      const link = page.getByRole("link", { name: "Export CSV" });
      await expect(link).toHaveAttribute("href", `${env.apiBaseUrl}/api/cycles/${cycle.id}/export/csv`);

      const download = await page.request.get(`${env.apiBaseUrl}/api/cycles/${cycle.id}/export/csv`);
      expect(download.status()).toBe(200);
      expect(download.headers()["content-disposition"]).toBe('attachment; filename="test-run.csv"');
      const body = await download.text();
      expect(body.split("\n")[0]).toBe(
        "externalId,title,status,priority,type,actualResult,executedAt,defectKey,defectUrl",
      );
      expect(body).toContain(title);
    } finally {
      await disposeProject(fixture);
    }
  });
});
