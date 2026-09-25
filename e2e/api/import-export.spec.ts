import { expect, test, type APIRequestContext } from "@playwright/test";
import * as XLSX from "xlsx";
import { setGraceWindow, setProPlan } from "../utils/billing-db";
import { parseCsv, parseCsvRecords } from "../utils/csv";
import { emailDomain } from "../utils/env";
import { exec, literal } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Getting data out of Tesbo and back into it: the test case CSV/XLSX exports, the import template,
 * the server-side import route, and the run export.
 *
 * Where the import actually happens matters for reading this file: POST testcases/import/preview
 * was never built (the preview is the parsed workbook, held in the browser — see
 * components/ImportTestCasesModal.tsx — and never needed a round trip), but POST testcases/import
 * itself is a real, server-side bulk commit (LegacyService.importTestCases): the browser still
 * parses the workbook and maps columns, then POSTs the whole row set once. That row set names each
 * row's suite/component by NAME, and the endpoint resolves/creates those suites itself — including
 * nesting them under whichever suite the browser had open (`defaultSuiteId`) rather than always at
 * the project root — so the "suite placement on import" section below exercises that endpoint
 * directly rather than through the UI.
 *
 * Runs against its own disposable workspace ("import-export"): the exports assert on the WHOLE
 * project's contents, so a shared project other specs are seeding into would make the row counts
 * race. The plan-lock case additionally rewrites the workspace's plan, which no shared account can
 * absorb.
 */

/** The documented column set of the test case export — LegacyController.TESTCASE_EXPORT_BASE_HEADERS. */
const EXPORT_HEADERS = [
  "externalId",
  "title",
  "description",
  "preconditions",
  "steps",
  "action",
  "expectedResult",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component",
];

/**
 * The import template's base columns — LegacyController.template()'s example row — before any
 * active custom field columns are appended. Corrected to match the endpoint's actual output: this
 * previously omitted "postconditions" and "estimatedDuration", which the endpoint has always
 * included, so TES-TC-210/211/212 were asserting a stale header list rather than the real one.
 *
 * "automationStatus" and "attachments" (labelled "Automation Type" and "Notes" in the Map Columns
 * UI) were added so the template, the import mapping and the Create Test Case form expose the same
 * field set — both already had DB columns and worked through the single-create/update routes, but
 * were silently dropped by the bulk import path (see PreparedImportRow/insertImportChunk).
 *
 * "action" and "expectedResult" were added because the Map Columns screen has always offered them
 * as a plain single-step alternative to the "steps" DSL, but no template ever had headers for them
 * to map to — they always showed "-- Skip --" on the official template. "steps" stays mapped in the
 * same file and still wins on import (ImportTestCasesModal.tsx's handleImport), so this only adds
 * columns; it does not change what importing the unmodified template produces.
 */
const TEMPLATE_HEADERS = [
  "title",
  "description",
  "preconditions",
  "postconditions",
  "steps",
  "action",
  "expectedResult",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component",
  "estimatedDuration",
  "automationStatus",
  "attachments",
];

const RUN_EXPORT_HEADERS = [
  "externalId",
  "title",
  "status",
  "priority",
  "type",
  "actualResult",
  "executedAt",
  "defectKey",
  "defectUrl",
];

interface SeededCase {
  id: string;
  title: string;
  externalId: string;
}

test.describe("import / export", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asGuest: APIRequestContext;
  let asOutsider: APIRequestContext;
  let anon: APIRequestContext;

  /** A project of this suite's own, so an export's row count is exactly what a test seeded. */
  let projectId: string;
  const createdCaseIds: string[] = [];
  const createdCycleIds: string[] = [];
  const createdProjectIds: string[] = [];

  const seedCase = async (
    data: Record<string, unknown>,
    project = projectId,
  ): Promise<SeededCase> => {
    const res = await asOwner.post(`/api/projects/${project}/testcases`, { data });
    if (!res.ok()) throw new Error(`Could not seed a test case (${res.status()}): ${await res.text()}`);
    const created = await res.json();
    createdCaseIds.push(created.id);
    return { id: created.id, title: created.title, externalId: created.externalId };
  };

  /*
   * Every content assertion here reads a WHOLE project's export, so each such test gets a project of
   * its own rather than filtering rows out of a shared one.
   *
   * The explicit key is not decoration: projectKey() derives a key from the name, uppercases it,
   * strips non-alphanumerics and truncates to 16 characters, and (organization_id, key) is unique
   * forever — including for archived projects. Names like "E2E Export Contents <stamp>" all collapse
   * to the same key, and the collision surfaces as a 500 (pinned in api/projects.spec.ts). So keys
   * are short and carry the varying part themselves.
   */
  let keyCounter = 0;
  const newProject = async (name: string): Promise<string> => {
    keyCounter += 1;
    const key = `IE${Date.now().toString().slice(-9)}${keyCounter % 10}`;
    const res = await asOwner.post("/api/projects", { data: { name, key } });
    if (!res.ok()) throw new Error(`Could not create ${name} (${res.status()}): ${await res.text()}`);
    const id = (await res.json()).id;
    createdProjectIds.push(id);
    return id;
  };

  const exportCsv = async (api: APIRequestContext, project = projectId) =>
    api.get(`/api/projects/${project}/testcases/export/csv`, { failOnStatusCode: false });

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("import-export");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asGuest = await loginAs(tenant.guest);
    asOutsider = await loginAs(
      seedFixtureUser(`e2e-import-export-outsider@${emailDomain}`, "E2E Import Export Outsider"),
    );
    anon = await anonymousContext();
    projectId = await newProject(`E2E Export Project ${Date.now()}`);
  });

  test.afterAll(async () => {
    if (tenant) {
      // Back to Pro: the plan-lock test flips this workspace to Launch, and a tenant left on Launch
      // would have its fixture projects refused by the next run's provisioning.
      setProPlan(tenant.organizationId);
      for (const id of createdCycleIds) {
        await asOwner.delete(`/api/cycles/${id}`, { failOnStatusCode: false });
      }
      for (const id of createdCaseIds) {
        await asOwner.delete(`/api/projects/${projectId}/testcases/${id}`, { failOnStatusCode: false });
      }
      // Projects are archived rather than deleted by the API, which is enough: an archived project is
      // outside every list, count and plan limit these suites read.
      for (const id of createdProjectIds) {
        await asOwner.delete(`/api/projects/${id}`, { failOnStatusCode: false });
      }
    }
    await Promise.all([asOwner, asGuest, asOutsider, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /* ───────────────────────── test case CSV export ───────────────────────── */

  test("exports every live test case under the documented header row", { tag: '@tesbo.testId("TES-TC-197")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Contents ${stamp}`);
    const suite = await (
      await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Suite ${stamp}` } })
    ).json();

    const kept = await seedCase(
      {
        title: `E2E Export Kept ${stamp}`,
        description: "Exported description",
        preconditions: "Signed in",
        testData: "user@example.com",
        priority: "P1",
        severity: "High",
        type: "Regression",
        status: "Approved",
        component: "Billing",
      },
      project,
    );
    const inSuite = await seedCase(
      { title: `E2E Export In Suite ${stamp}`, suiteId: suite.id },
      project,
    );
    const removed = await seedCase({ title: `E2E Export Removed ${stamp}` }, project);
    await asOwner.delete(`/api/projects/${project}/testcases/${removed.id}`);

    const res = await exportCsv(asOwner, project);
    expect(res.status()).toBe(200);
    const { headers, records } = parseCsvRecords(await res.text());

    expect(headers, "the CSV header row is the documented column set, in order").toEqual(EXPORT_HEADERS);
    expect(records.map((r) => r.title).sort()).toEqual([kept.title, inSuite.title].sort());

    const keptRow = records.find((r) => r.title === kept.title)!;
    expect(keptRow).toMatchObject({
      externalId: kept.externalId,
      description: "Exported description",
      preconditions: "Signed in",
      testData: "user@example.com",
      priority: "P1",
      severity: "High",
      type: "Regression",
      status: "Approved",
      component: "Billing",
      suite: "",
      // `kept` was seeded with no steps at all — action/expectedResult must come out as empty
      // strings, not "undefined" text or a missing column.
      steps: "",
      action: "",
      expectedResult: "",
    });
    // The suite column is the joined suite NAME, not its id — that's what makes an export
    // re-importable, since the import maps "Suite" by name.
    expect(records.find((r) => r.title === inSuite.title)!.suite).toBe(suite.name);
  });

  test("exports a single step's Action/Expected Result into their own columns, not steps", { tag: '@tesbo.testId("TES-TC-198")' }, async () => {
    // Action/Expected Result only take a case with EXACTLY one step: the importer's own Action/
    // Expected Result columns (ImportTestCasesModal.tsx's handleImport) build exactly one step from
    // them with no " | " splitting, so anything exported there for more than one step could never
    // round-trip back through a re-import correctly. A single-step case is unambiguous either way,
    // so it gets the plain columns instead of the "action => expected" DSL, and `steps` must not
    // carry a duplicate copy of the same text.
    const stamp = Date.now();
    const project = await newProject(`E2E Export Steps ${stamp}`);
    const seeded = await seedCase(
      {
        title: `E2E Export Steps ${stamp}`,
        // No expected result on the one step — must come out as "", not undefined/missing.
        steps: [{ stepNumber: 1, action: "Open the login page" }],
      },
      project,
    );

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    const row = records.find((r) => r.title === seeded.title)!;
    expect(row.action).toBe("Open the login page");
    expect(row.expectedResult).toBe("");
    expect(row.steps, "a single step must not also be duplicated into the steps column").toBe("");
  });

  test("exports 2+ steps into the steps column as \"action => expected\", joined by \" | \" — never into Action/Expected Result", async () => {
    // The DSL column (not Action/Expected Result) is what the importer's Steps mapping already
    // splits on both "|" and "=>" regardless of step count, so this is the only shape that survives
    // a re-import unscathed once there's more than one step.
    const stamp = Date.now();
    const project = await newProject(`E2E Export Multi Steps ${stamp}`);
    const seeded = await seedCase(
      {
        title: `E2E Export Multi Steps ${stamp}`,
        steps: [
          { stepNumber: 1, action: "Open the login page", expectedResult: "The form is shown" },
          // No expected result: the separator must not be emitted for an absent half, or a
          // re-import would read a trailing "=>" as an empty expected result.
          { stepNumber: 2, action: "Submit empty credentials" },
        ],
      },
      project,
    );

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    const row = records.find((r) => r.title === seeded.title)!;
    expect(row.steps).toBe("Open the login page => The form is shown | Submit empty credentials");
    expect(row.action, "2+ steps must not land in Action/Expected Result — a re-import can't split them back apart").toBe("");
    expect(row.expectedResult).toBe("");
  });

  test("still exports a legacy plain-string step into the steps column, not Action/Expected Result", async () => {
    // A step can also be a bare string with no action/expectedResult of its own (older data, or a
    // synonym-key shape safeSteps() didn't recognize) — that text belongs in `steps`, the one column
    // built for it, and must not surface as a bogus Action or Expected Result value.
    const stamp = Date.now();
    const project = await newProject(`E2E Export Steps Legacy ${stamp}`);
    const seeded = await seedCase(
      { title: `E2E Export Steps Legacy ${stamp}`, steps: ["Open the app and sign in"] },
      project,
    );

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    const row = records.find((r) => r.title === seeded.title)!;
    expect(row.steps).toBe("Open the app and sign in");
    expect(row.action).toBe("");
    expect(row.expectedResult).toBe("");
  });

  test("still exports Action/Expected Result when steps were stored as a JSON-encoded string, not a genuine array", async () => {
    /*
     * "[Zyra] Test Steps, Actions, and Expected Results Are Missing After Saving Generated Test
     * Cases" — the create/edit modal pre-stringifies `steps` before every save (testcases/page.tsx
     * `steps: JSON.stringify(steps)`), and insertTestCaseWithClient encodes it a second time, so the
     * jsonb column ends up holding a JSON string scalar rather than a genuine array. The editor's own
     * parseSteps() expects exactly that string, but exportTestcases' `normalizeJsonArray(row.steps)`
     * was `Array.isArray(value) ? value : []` — the mirror-image assumption — so this shape (which is
     * what every modal-created test case, and now every Zyra/MCP-created one, actually persists)
     * exported as a blank Steps/Action/Expected Result column instead of silently failing to save.
     * One step here (not several): safeSteps() has to see through the JSON-string wrapper before
     * the single-vs-multi-step decision above it can even run.
     */
    const stamp = Date.now();
    const project = await newProject(`E2E Export Steps Shape ${stamp}`);
    const steps = [{ stepNumber: 1, action: "Open the login page", expectedResult: "The form is shown" }];
    const seeded = await seedCase(
      { title: `E2E Export Steps Shape ${stamp}`, steps: JSON.stringify(steps) },
      project,
    );

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    const row = records.find((r) => r.title === seeded.title)!;
    expect(row.action).toBe("Open the login page");
    expect(row.expectedResult).toBe("The form is shown");
    expect(row.steps).toBe("");
  });

  test("quotes values containing commas, quotes and newlines so they survive the round trip", { tag: '@tesbo.testId("TES-TC-199")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Quoting ${stamp}`);
    const title = `E2E Export "quoted", comma ${stamp}`;
    const description = `line one\nline two, with a comma and a "quote"`;
    await seedCase({ title, description }, project);

    const body = await (await exportCsv(asOwner, project)).text();
    const { records } = parseCsvRecords(body);
    const row = records.find((r) => r.title === title);
    expect(row, "a title containing a comma must not be split across columns").toBeTruthy();
    expect(row!.description).toBe(description);
    // The raw body must actually be quoted, not merely parse back by luck.
    expect(body).toContain('"E2E Export ""quoted"", comma');
  });

  test(
    "orders rows the same way the repository shows them by default (newest first, ID sequence), not by last-updated",
    { tag: '@tesbo.testId("TES-TC-200")' },
    async () => {
      /*
       * Was: "orders rows by most recently updated" — export deliberately used `updated_at DESC`
       * while the repository list used `created_at DESC` (ID sequence), on the theory that the two
       * were allowed to diverge (see the removed comment in LegacyService.exportTestCases). That is
       * exactly what "[Test Cases] Exported Test Cases Lose Their Original Sequence" reported:
       * editing an old case silently moved it to the top of every future export while its position on
       * screen never changed. Export's default now matches the repository's own default order, via
       * the shared LegacyService.buildTestcaseOrderBySql.
       */
      const stamp = Date.now();
      const project = await newProject(`E2E Export Order ${stamp}`);
      const first = await seedCase({ title: `E2E Export Order A ${stamp}` }, project);
      const second = await seedCase({ title: `E2E Export Order B ${stamp}` }, project);
      // Editing the OLDER case must NOT move it in the export — that was the exact reported defect.
      await asOwner.put(`/api/projects/${project}/testcases/${first.id}`, {
        data: { description: "touched last" },
      });

      const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
      // Newest-created first, same as the repository's own default (unsorted) view — unaffected by
      // which one was edited more recently.
      expect(records.map((r) => r.title)).toEqual([second.title, first.title]);
    },
  );

  test(
    "an export can be sorted by the same ID/title/priority columns the repository table offers",
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Export Sort ${stamp}`);
      const alpha = await seedCase({ title: `E2E Export Sort Alpha ${stamp}`, priority: "P0" }, project);
      const zebra = await seedCase({ title: `E2E Export Sort Zebra ${stamp}`, priority: "P3" }, project);

      const byTitleAsc = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { sortBy: "title", sortDir: "asc" },
      });
      expect(parseCsvRecords(await byTitleAsc.text()).records.map((r) => r.title)).toEqual([
        alpha.title,
        zebra.title,
      ]);

      const byTitleDesc = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { sortBy: "title", sortDir: "desc" },
      });
      expect(parseCsvRecords(await byTitleDesc.text()).records.map((r) => r.title)).toEqual([
        zebra.title,
        alpha.title,
      ]);

      const byPriorityAsc = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { sortBy: "priority", sortDir: "asc" },
      });
      // P0 (Critical) ranks ahead of P3 (Low) ascending — the same ranking the priority filter and
      // the on-screen sort use, not alphabetical.
      expect(parseCsvRecords(await byPriorityAsc.text()).records.map((r) => r.title)).toEqual([
        alpha.title,
        zebra.title,
      ]);
    },
  );

  test("a project with no test cases exports the header row and nothing else", { tag: '@tesbo.testId("TES-TC-201")' }, async () => {
    const project = await newProject(`E2E Export Empty ${Date.now()}`);
    const res = await exportCsv(asOwner, project);
    expect(res.status()).toBe(200);
    const rows = parseCsv(await res.text());
    expect(rows).toEqual([EXPORT_HEADERS]);
  });

  test("sends the CSV as a named attachment", { tag: '@tesbo.testId("TES-TC-202")' }, async () => {
    const res = await exportCsv(asOwner);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="testcases.csv"');
  });

  test("adds a cf_<key> column for each active custom field, and drops archived or deleted ones", { tag: '@tesbo.testId("TES-TC-203")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Custom Fields ${stamp}`);
    const text = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: { name: `Owner Team ${stamp}`, fieldType: "text" },
      })
    ).json();
    const select = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: {
          name: `Release ${stamp}`,
          fieldType: "single_select",
          config: { options: [{ label: "R1" }, { label: "R2" }] },
        },
      })
    ).json();
    const retired = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: { name: `Retired ${stamp}`, fieldType: "text" },
      })
    ).json();
    await asOwner.patch(
      `/api/projects/${project}/custom-fields/definitions/${retired.id}/status`,
      { data: { status: "archived" } },
    );
    const removed = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: { name: `Removed ${stamp}`, fieldType: "text" },
      })
    ).json();
    await asOwner.delete(`/api/projects/${project}/custom-fields/definitions/${removed.id}`);

    const r2 = select.config.options.find((o: { label: string }) => o.label === "R2");
    const seeded = await seedCase(
      {
        title: `E2E Export Custom Field Values ${stamp}`,
        customFieldValues: { [text.id]: "Platform", [select.id]: r2.id },
      },
      project,
    );

    const { headers, records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    expect(headers.slice(0, EXPORT_HEADERS.length)).toEqual(EXPORT_HEADERS);
    expect(headers).toContain(`cf_${text.key}`);
    expect(headers).toContain(`cf_${select.key}`);
    expect(headers, "an archived definition is not a column").not.toContain(`cf_${retired.key}`);
    expect(headers, "a soft-deleted definition is not a column either").not.toContain(`cf_${removed.key}`);

    const row = records.find((r) => r.title === seeded.title)!;
    expect(row[`cf_${text.key}`]).toBe("Platform");
    // A select exports its option LABEL, not the option id a raw value column would carry.
    expect(row[`cf_${select.key}`]).toBe("R2");
  });

  /* ───────────────────────── test case export filtering ─────────────────────────
   *
   * Basecamp-style report: "Exporting a specific suite exports all test cases" — LegacyController's
   * exportCsv/exportXlsx took no @Query() at all, and LegacyService.exportTestCases ran a query
   * filtered only by project_id, so selecting a suite (or any other repository filter) on screen had
   * no effect on the downloaded file; it always contained the whole project. Fixed by having export
   * build its WHERE clause the same way listTestCasesForUser already does (suite/status/priority/
   * type/automationStatus/jira/linear/search/customFieldFilters), via a shared
   * LegacyService.buildTestcaseFilterFragments helper, and by threading the frontend's active
   * filters into the export link (Tesbo-Frontend testcases/page.tsx's getExportUrl calls).
   *
   * One behavior change rides along with reusing the list's filter logic: an export with NO filters
   * at all now excludes Archived cases by default, the same as the on-screen list — previously the
   * unfiltered export's query had no status predicate whatsoever and returned every status. That is
   * asserted explicitly below rather than left as an undocumented side effect.
   */

  test(
    "exporting a specific suite only exports that suite's test cases, not the whole project",
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Export Suite Filter ${stamp}`);
      const suiteA = await (
        await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Suite A ${stamp}` } })
      ).json();
      const suiteB = await (
        await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Suite B ${stamp}` } })
      ).json();
      const inA = await seedCase({ title: `E2E Export In A ${stamp}`, suiteId: suiteA.id }, project);
      const inB = await seedCase({ title: `E2E Export In B ${stamp}`, suiteId: suiteB.id }, project);
      const unfiled = await seedCase({ title: `E2E Export Unfiled ${stamp}` }, project);

      const res = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { suiteId: suiteA.id },
      });
      const { records } = parseCsvRecords(await res.text());
      expect(records.map((r) => r.title)).toEqual([inA.title]);
      expect(records.map((r) => r.title), "another suite's cases must not leak into the export").not.toContain(inB.title);
      expect(records.map((r) => r.title), "unfiled cases must not leak into a suite-scoped export").not.toContain(
        unfiled.title,
      );

      // The unfiltered export (no suiteId at all) is unchanged: it still returns everything.
      const wholeProject = await asOwner.get(`/api/projects/${project}/testcases/export/csv`);
      const { records: allRecords } = parseCsvRecords(await wholeProject.text());
      expect(allRecords.map((r) => r.title).sort()).toEqual([inA.title, inB.title, unfiled.title].sort());
    },
  );

  test("the XLSX export also honors a suite filter", async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Suite Filter Xlsx ${stamp}`);
    const suite = await (
      await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Xlsx Suite ${stamp}` } })
    ).json();
    const inSuite = await seedCase({ title: `E2E Export Xlsx In Suite ${stamp}`, suiteId: suite.id }, project);
    const outsideSuite = await seedCase({ title: `E2E Export Xlsx Outside ${stamp}` }, project);

    const res = await asOwner.get(`/api/projects/${project}/testcases/export/xlsx`, {
      params: { suiteId: suite.id },
    });
    expect(res.status()).toBe(200);
    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Test Cases"]);
    expect(rows.map((r) => r.title)).toEqual([inSuite.title]);
    expect(rows.map((r) => r.title)).not.toContain(outsideSuite.title);
  });

  test(
    "exporting a suite also includes cases nested in its descendant suites, matching the on-screen list",
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Export Suite Descendants ${stamp}`);
      const parent = await (
        await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Parent ${stamp}` } })
      ).json();
      const child = await (
        await asOwner.post(`/api/projects/${project}/suites`, {
          data: { name: `E2E Export Child ${stamp}`, parentId: parent.id },
        })
      ).json();
      const inParent = await seedCase({ title: `E2E Export In Parent ${stamp}`, suiteId: parent.id }, project);
      const inChild = await seedCase({ title: `E2E Export In Child ${stamp}`, suiteId: child.id }, project);
      const elsewhere = await seedCase({ title: `E2E Export Elsewhere ${stamp}` }, project);

      // Without includeDescendants, only the exact suite's own cases come out — same as the list.
      const exact = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { suiteId: parent.id },
      });
      expect(parseCsvRecords(await exact.text()).records.map((r) => r.title)).toEqual([inParent.title]);

      // With it, the child's cases are included too.
      const withDescendants = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { suiteId: parent.id, includeDescendants: "true" },
      });
      const { records } = parseCsvRecords(await withDescendants.text());
      expect(records.map((r) => r.title).sort()).toEqual([inChild.title, inParent.title].sort());
      expect(records.map((r) => r.title)).not.toContain(elsewhere.title);
    },
  );

  test('exporting suiteId="none" exports only test cases filed under no suite', async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Unfiled Filter ${stamp}`);
    const suite = await (
      await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Unfiled Suite ${stamp}` } })
    ).json();
    const filed = await seedCase({ title: `E2E Export Filed ${stamp}`, suiteId: suite.id }, project);
    const unfiled = await seedCase({ title: `E2E Export Truly Unfiled ${stamp}` }, project);

    const res = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
      params: { suiteId: "none" },
    });
    const { records } = parseCsvRecords(await res.text());
    expect(records.map((r) => r.title)).toEqual([unfiled.title]);
    expect(records.map((r) => r.title)).not.toContain(filed.title);
  });

  test(
    "a malformed suiteId is refused with 400, not silently ignored into an unfiltered export",
    async () => {
      const res = await asOwner.get(`/api/projects/${projectId}/testcases/export/csv`, {
        params: { suiteId: "not-a-uuid" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
    },
  );

  test(
    "an export can be scoped by status, priority, type and automationStatus together, matching only the intersection",
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Export Field Filters ${stamp}`);
      const match = await seedCase(
        {
          title: `E2E Export Match ${stamp}`,
          status: "Approved",
          priority: "P1",
          type: "Regression",
          automationStatus: "Automated",
        },
        project,
      );
      const wrongStatus = await seedCase({ title: `E2E Export Wrong Status ${stamp}`, priority: "P1", type: "Regression" }, project);
      const wrongPriority = await seedCase(
        { title: `E2E Export Wrong Priority ${stamp}`, status: "Approved", type: "Regression" },
        project,
      );

      const res = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { status: "Approved", priority: "P1", type: "Regression", automationStatus: "Automated" },
      });
      const { records } = parseCsvRecords(await res.text());
      expect(records.map((r) => r.title)).toEqual([match.title]);
      expect(records.map((r) => r.title)).not.toContain(wrongStatus.title);
      expect(records.map((r) => r.title)).not.toContain(wrongPriority.title);
    },
  );

  test("an export can be scoped by the same free-text search the repository search box uses", async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Search Filter ${stamp}`);
    const matching = await seedCase({ title: `E2E Export Zebra Findable ${stamp}` }, project);
    const other = await seedCase({ title: `E2E Export Other Case ${stamp}` }, project);

    const res = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
      params: { search: "zebra findable" },
    });
    const { records } = parseCsvRecords(await res.text());
    expect(records.map((r) => r.title)).toEqual([matching.title]);
    expect(records.map((r) => r.title)).not.toContain(other.title);
  });

  test("an export can be scoped by a custom field filter, matching only the rows that satisfy it", async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Custom Field Filter ${stamp}`);
    const text = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: { name: `Platform ${stamp}`, fieldType: "text" },
      })
    ).json();
    const matching = await seedCase(
      { title: `E2E Export CF Match ${stamp}`, customFieldValues: { [text.id]: "Chrome regression" } },
      project,
    );
    const other = await seedCase(
      { title: `E2E Export CF Other ${stamp}`, customFieldValues: { [text.id]: "Safari smoke" } },
      project,
    );

    const conditions = [{ definitionId: text.id, operator: "contains", value: "chrome" }];
    const res = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
      params: { customFieldFilters: JSON.stringify(conditions) },
    });
    const { records } = parseCsvRecords(await res.text());
    expect(records.map((r) => r.title)).toEqual([matching.title]);
    expect(records.map((r) => r.title)).not.toContain(other.title);
  });

  test(
    "excludes Archived cases from an unfiltered export by default; status=Archived / includeArchived=true still reach them",
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Export Archived ${stamp}`);
      const active = await seedCase({ title: `E2E Export Active ${stamp}` }, project);
      const archived = await seedCase({ title: `E2E Export Archived Case ${stamp}`, status: "Archived" }, project);

      const unfiltered = await asOwner.get(`/api/projects/${project}/testcases/export/csv`);
      const { records: unfilteredRecords } = parseCsvRecords(await unfiltered.text());
      expect(unfilteredRecords.map((r) => r.title)).toEqual([active.title]);

      const byStatus = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { status: "Archived" },
      });
      expect(parseCsvRecords(await byStatus.text()).records.map((r) => r.title)).toEqual([archived.title]);

      const includeArchived = await asOwner.get(`/api/projects/${project}/testcases/export/csv`, {
        params: { includeArchived: "true" },
      });
      expect(
        parseCsvRecords(await includeArchived.text()).records.map((r) => r.title).sort(),
      ).toEqual([active.title, archived.title].sort());
    },
  );

  /* ───────────────────────── test case XLSX export ───────────────────────── */

  test("exports a workbook whose \"Test Cases\" sheet matches the CSV", { tag: '@tesbo.testId("TES-TC-204")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Workbook ${stamp}`);
    const seeded = await seedCase(
      {
        title: `E2E Export Workbook Case ${stamp}`,
        description: "In the workbook",
        priority: "P3",
        steps: [{ stepNumber: 1, action: "Click", expectedResult: "It clicks" }],
      },
      project,
    );

    const res = await asOwner.get(`/api/projects/${project}/testcases/export/xlsx`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="testcases.xlsx"');

    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    expect(workbook.SheetNames).toContain("Test Cases");
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Test Cases"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: seeded.externalId,
      title: seeded.title,
      description: "In the workbook",
      priority: "P3",
      action: "Click",
      expectedResult: "It clicks",
    });
    // Action/Expected Result must not also be duplicated into `steps` — an empty `steps` cell reads
    // back as either "" or an absent key depending on how the sheet library round-trips a blank
    // string, so accept either rather than pinning one.
    expect(rows[0].steps || "").toBe("");
  });

  test("a project with no test cases still exports a workbook carrying the header row", { tag: '@tesbo.testId("TES-TC-205")' }, async () => {
    // Red: sendWorkbook builds the sheet with XLSX.utils.json_to_sheet(rows), which derives its
    // header from the first row's keys — so with no rows there is no header either, and the
    // downloaded file opens as a completely blank sheet with no columns to fill in. The CSV export
    // of the same empty project does emit its header row (asserted above), so this is an
    // inconsistency between the two formats, not the intended contract.
    const project = await newProject(`E2E Export Empty Workbook ${Date.now()}`);
    const res = await asOwner.get(`/api/projects/${project}/testcases/export/xlsx`);
    expect(res.status()).toBe(200);

    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    const sheet = workbook.Sheets["Test Cases"];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false });
    expect(rows[0], "the empty workbook has no header row at all").toEqual(EXPORT_HEADERS);
  });

  /* ───────────────────────── export authorization ───────────────────────── */

  for (const format of ["csv", "xlsx"] as const) {
    test(`the ${format} export refuses callers without access to the project`, async () => {
      const path = `/api/projects/${projectId}/testcases/export/${format}`;

      const anonRes = await anon.get(path, { failOnStatusCode: false });
      // requireUser raises 400 ("Authentication required") rather than 401 — see rbac.spec.ts.
      expect([400, 401], "an anonymous caller must not be handed an export").toContain(anonRes.status());

      const guestRes = await asGuest.get(path, { failOnStatusCode: false });
      expect(guestRes.status(), "a workspace member with no project access is refused").toBe(404);

      const outsiderRes = await asOutsider.get(path, { failOnStatusCode: false });
      expect(outsiderRes.status(), "a caller from outside the workspace is refused").toBe(404);
    });

    test(`the ${format} export answers a malformed project id with 404, not 500`, async () => {
      const res = await asOwner.get(`/api/projects/not-a-uuid/testcases/export/${format}`, {
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(404);
    });
  }

  /* ───────────────────────── import template ───────────────────────── */

  test("the CSV template documents every importable column with a worked example", { tag: '@tesbo.testId("TES-TC-210")' }, async () => {
    const res = await asOwner.get(`/api/projects/${projectId}/testcases/import/template`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toBe(
      'attachment; filename="testcase-import-template.csv"',
    );

    const { headers, records } = parseCsvRecords(await res.text());
    expect(headers).toEqual(TEMPLATE_HEADERS);
    expect(records).toHaveLength(1);
    // The example must teach the two conventions the importer relies on, or a user filling the
    // template in cannot produce steps with expected results at all: " | " between steps, " => "
    // between an action and its expected result.
    expect(records[0].steps).toContain(" => ");
    expect(records[0].steps).toContain(" | ");
    expect(records[0].title).toBeTruthy();
    // The Action/Expected Result pair must also carry a worked example — otherwise Map Columns still
    // shows them as unmapped the moment a user removes the "steps" column to try the plain-column
    // style instead.
    expect(records[0].action).toBeTruthy();
    expect(records[0].expectedResult).toBeTruthy();
    // A worked value for every base column, so filling the template in unmodified round-trips —
    // in particular Automation Type must be one of TESTCASE_AUTOMATION_TYPES, since the importer
    // stores whatever string it's given with no server-side enum check.
    expect(records[0].automationStatus).toBe("Not Automated");
    expect(records[0].attachments).toBeTruthy();
  });

  test("format=xlsx returns the same template as a workbook", { tag: '@tesbo.testId("TES-TC-211")' }, async () => {
    const res = await asOwner.get(
      `/api/projects/${projectId}/testcases/import/template?format=xlsx`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers()["content-disposition"]).toBe(
      'attachment; filename="testcase-import-template.xlsx"',
    );

    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    expect(workbook.SheetNames).toContain("Test Cases");
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Test Cases"]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(TEMPLATE_HEADERS);
  });

  test("an unrecognised format falls back to the CSV template", { tag: '@tesbo.testId("TES-TC-212")' }, async () => {
    const res = await asOwner.get(
      `/api/projects/${projectId}/testcases/import/template?format=json`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(parseCsv(await res.text())[0]).toEqual(TEMPLATE_HEADERS);
  });

  test("the template is project-scoped and needs a session", { tag: '@tesbo.testId("TES-TC-213")' }, async () => {
    // Red: template() takes neither @Req() nor a look at the project id, so it serves the same file
    // to an anonymous caller and to a request naming a project that doesn't exist. Nothing tenant-
    // specific leaks — the payload is a constant — but it is the only route under
    // /api/projects/:id/ that answers with no session, and the frontend links to it from a
    // signed-in screen only. Either it should authorize like its siblings or it should not be
    // project-scoped.
    const anonRes = await anon.get(`/api/projects/${projectId}/testcases/import/template`, {
      failOnStatusCode: false,
    });
    expect([400, 401], "the template must not be served without a session").toContain(
      anonRes.status(),
    );

    const unknownRes = await asOwner.get(
      "/api/projects/00000000-0000-0000-0000-000000000000/testcases/import/template",
      { failOnStatusCode: false },
    );
    expect(unknownRes.status(), "a project that doesn't exist has no template").toBe(404);
  });

  /* ───────────────────────── import template × custom fields ─────────────────────────
   *
   * Basecamp-style report: mandatory custom fields never appeared as columns in the downloaded
   * template, so a user filling it in and importing it back had no way to supply them — every row
   * failed the importer's own required-field check (reported case: 0/128 imported, each row
   * rejected with "<field name> is required"). Fixed in LegacyController.template() by reusing the
   * same customFields.listActiveDefinitionsForColumns(...) call exportCsv/exportXlsx already made.
   */

  test(
    "adds a column and a valid worked example for each active custom field, and none for archived/inactive ones",
    { tag: '@tesbo.testId("TES-TC-223")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Template Custom Fields ${stamp}`);
      const text = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: { name: `Owner Team ${stamp}`, fieldType: "text", required: true, config: { maxLength: 5 } },
        })
      ).json();
      const boolean = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: { name: `Automatable ${stamp}`, fieldType: "boolean" },
        })
      ).json();
      const select = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: {
            name: `Release ${stamp}`,
            fieldType: "single_select",
            config: { options: [{ label: "R1" }, { label: "R2" }] },
          },
        })
      ).json();
      const inactive = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: { name: `Dormant ${stamp}`, fieldType: "text", active: false },
        })
      ).json();
      const archived = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: { name: `Retired ${stamp}`, fieldType: "text" },
        })
      ).json();
      await asOwner.patch(`/api/projects/${project}/custom-fields/definitions/${archived.id}/status`, {
        data: { status: "archived" },
      });

      const { headers, records } = parseCsvRecords(
        await (await asOwner.get(`/api/projects/${project}/testcases/import/template`)).text(),
      );
      expect(headers).toContain(text.name);
      expect(headers).toContain(boolean.name);
      expect(headers).toContain(select.name);
      expect(headers, "an inactive definition is not a column").not.toContain(inactive.name);
      expect(headers, "an archived definition is not a column").not.toContain(archived.name);

      const row = records[0];
      // The required text field's config caps it at 5 characters — the worked example must respect
      // that, or filling the template in unmodified would itself fail validation.
      expect(row[text.name].length).toBeLessThanOrEqual(5);
      expect(row[text.name]).toBeTruthy();
      expect(["Yes", "No"]).toContain(row[boolean.name]);
      expect(["R1", "R2"]).toContain(row[select.name]);
    },
  );

  test(
    "a required custom field missing from the template makes every row fail; present, it imports cleanly",
    { tag: '@tesbo.testId("TES-TC-224")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Template Required Field ${stamp}`);
      const required = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: { name: `Compliance ${stamp}`, fieldType: "boolean", required: true },
        })
      ).json();

      // Reproduces the reported defect directly: this is exactly what happened when the field had
      // no column to map to at all, and it must still be true after the fix — the field only ever
      // fails to validate when a value is genuinely missing, not because it can't be supplied.
      const withoutValueRes = await asOwner.post(`/api/projects/${project}/testcases/import`, {
        data: { rows: [{ rowNumber: 1, title: `E2E Missing Required ${stamp}` }] },
      });
      const withoutValue = await withoutValueRes.json();
      expect(withoutValue.imported).toBe(0);
      expect(withoutValue.errors[0].message).toContain(`${required.name} is required`);

      // What downloading the (now-fixed) template and re-importing it unmodified actually sends:
      // the template's own worked example value for this field.
      const { records } = parseCsvRecords(
        await (await asOwner.get(`/api/projects/${project}/testcases/import/template`)).text(),
      );
      const sample = records[0][required.name];
      expect(sample, "the template must have a column to read a value from").toBeTruthy();

      const withValueRes = await asOwner.post(`/api/projects/${project}/testcases/import`, {
        data: {
          rows: [
            {
              rowNumber: 1,
              title: `E2E Present Required ${stamp}`,
              customFieldValues: { [required.id]: sample.toLowerCase() === "yes" },
            },
          ],
        },
      });
      const withValue = await withValueRes.json();
      expect(withValue.errors).toEqual([]);
      expect(withValue.imported).toBe(1);
    },
  );

  test(
    "a required select field with no active options still returns a template, with an empty sample cell",
    { tag: '@tesbo.testId("TES-TC-225")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Template No Active Options ${stamp}`);
      const select = await (
        await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
          data: {
            name: `Environment ${stamp}`,
            fieldType: "single_select",
            required: true,
            config: { options: [{ label: "Staging" }] },
          },
        })
      ).json();
      const optionId = select.config.options[0].id;
      await asOwner.patch(`/api/projects/${project}/custom-fields/definitions/${select.id}`, {
        data: { config: { options: [{ id: optionId, label: "Staging", active: false }] } },
      });

      const res = await asOwner.get(`/api/projects/${project}/testcases/import/template`, {
        failOnStatusCode: false,
      });
      expect(res.status(), "a field with no active option must not 500 the template").toBe(200);
      const { headers, records } = parseCsvRecords(await res.text());
      expect(headers).toContain(select.name);
      expect(records[0][select.name]).toBe("");
    },
  );

  /* ───────────────────────── the server-side import route ───────────────────────── */

  test("the import routes refuse an anonymous caller", { tag: '@tesbo.testId("TES-TC-214")' }, async () => {
    // /import/preview was never built (see the file header) so it 404s regardless of auth; /import
    // is the real bulk-commit route (requireUser inside LegacyService.importTestCases) and must
    // reject an unauthenticated caller before it ever looks at the body.
    for (const path of [
      `/api/projects/${projectId}/testcases/import/preview`,
      `/api/projects/${projectId}/testcases/import`,
    ]) {
      const res = await anon.post(path, { data: {}, failOnStatusCode: false });
      expect([400, 401, 404], `${path} must not answer an anonymous caller with a success`).toContain(
        res.status(),
      );
    }
  });

  test("a legacy-shaped import body is rejected, not silently accepted as zero rows", { tag: '@tesbo.testId("TES-TC-215")' }, async () => {
    // The endpoint's real contract is { rows: [...] } (see "imports rows..." below for the happy
    // path). A caller still sending the older preview/columnMapping shape has no `rows` array, so
    // `rows` normalizes to [] and importTestCases refuses it outright — it must never come back as
    // a 2xx claiming an empty success, which is what a client polling `imported` would otherwise
    // read as "nothing needed importing" instead of "the request was malformed."
    const before = await (await asOwner.get(`/api/projects/${projectId}/testcases`)).json();
    const countBefore = Array.isArray(before) ? before.length : before.total;

    const res = await asOwner.post(`/api/projects/${projectId}/testcases/import`, {
      data: { uploadId: "local-upload", columnMapping: { title: 0 } },
      failOnStatusCode: false,
    });

    expect(res.status(), "a body with no rows array must be refused, not treated as zero rows").toBe(400);
    const after = await (await asOwner.get(`/api/projects/${projectId}/testcases`)).json();
    const countAfter = Array.isArray(after) ? after.length : after.total;
    expect(countAfter, "a refused request must not create anything").toBe(countBefore);
  });

  test(
    "imports Automation Type and Notes, which the bulk endpoint used to silently drop",
    { tag: '@tesbo.testId("TES-TC-2100")' },
    async () => {
      // Both columns already had real DB support and worked through the single create/update
      // routes (LegacyService.insertTestCaseWithClient/updateTestCaseWithClient) — PreparedImportRow
      // and insertImportChunk just never carried them, so a file mapping "Automation Type" or "Notes"
      // imported every other column correctly and quietly discarded these two.
      const stamp = Date.now();
      const project = await newProject(`E2E Import Automation Notes ${stamp}`);
      const title = `E2E Import Automation Notes ${stamp}`;

      const res = await asOwner.post(`/api/projects/${project}/testcases/import`, {
        data: {
          rows: [
            {
              rowNumber: 1,
              title,
              automationStatus: "Automated",
              attachments: "Screenshot attached: login.png",
            },
          ],
        },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.errors).toEqual([]);
      expect(body.imported).toBe(1);

      const list = await (
        await asOwner.get(`/api/projects/${project}/testcases`, { params: { search: title } })
      ).json();
      const created = list.find((tc: { title: string }) => tc.title === title);
      expect(created, "the row must have actually been created").toBeTruthy();

      const full = await (await asOwner.get(`/api/projects/${project}/testcases/${created.id}`)).json();
      expect(full.automationStatus).toBe("Automated");
      expect(full.attachments).toBe("Screenshot attached: login.png");
    },
  );

  test(
    "an unmapped Automation Type/Notes row still imports, defaulting Automation Type and leaving Notes blank",
    { tag: '@tesbo.testId("TES-TC-2101")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Automation Notes Default ${stamp}`);
      const title = `E2E Import Automation Notes Default ${stamp}`;

      const res = await asOwner.post(`/api/projects/${project}/testcases/import`, {
        data: { rows: [{ rowNumber: 1, title }] },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const list = await (
        await asOwner.get(`/api/projects/${project}/testcases`, { params: { search: title } })
      ).json();
      const created = list.find((tc: { title: string }) => tc.title === title);
      const full = await (await asOwner.get(`/api/projects/${project}/testcases/${created.id}`)).json();
      expect(full.automationStatus).toBe("Not Automated");
      expect(full.attachments ?? "").toBe("");
    },
  );

  /* ───────────────────────── suite placement on import ─────────────────────────
   *
   * Basecamp-style report: importing while a suite/sub-suite is open should land the file's test
   * cases in that suite; instead LegacyService.resolveImportSuites always resolved a row's own Suite
   * column as a project-ROOT suite, only ever consulting the open suite (`defaultSuiteId`) as the
   * fallback for rows that left the column blank. Fixed by resolving/creating a named suite as a
   * CHILD of `defaultSuiteId` instead of the root — the same name+parent scoping the code already
   * used for Component nesting. Every test below runs against its own project: several assert on the
   * project's whole suite list, which a shared project would make ambiguous once more than one test
   * has created same-named suites in it.
   */

  interface ImportSuiteRow {
    id: string;
    parentId: string | null;
    name: string;
    testCaseCount: number;
  }

  const createSuite = async (name: string, parentId: string | undefined, project: string): Promise<ImportSuiteRow> => {
    const res = await asOwner.post(`/api/projects/${project}/suites`, { data: { name, parentId } });
    if (!res.ok()) throw new Error(`Could not create suite ${name} (${res.status()}): ${await res.text()}`);
    return res.json();
  };

  const suitesOf = async (project: string): Promise<ImportSuiteRow[]> =>
    (await (await asOwner.get(`/api/projects/${project}/suites`)).json()) as ImportSuiteRow[];

  const casesInSuite = async (suiteId: string, project: string) =>
    (await (await asOwner.get(`/api/projects/${project}/testcases?suiteId=${suiteId}`)).json()) as {
      rows: { id: string; title: string }[];
      total: number;
    };

  const importRows = async (
    project: string,
    rows: Record<string, unknown>[],
    defaultSuiteId?: string,
    failOnStatusCode = true,
  ) =>
    asOwner.post(`/api/projects/${project}/testcases/import`, {
      data: { rows, defaultSuiteId },
      failOnStatusCode,
    });

  test(
    "a row with a blank Suite column lands directly in the suite Import was launched from",
    { tag: '@tesbo.testId("TES-TC-2000")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Blank ${stamp}`);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const title = `E2E Import Blank Suite ${stamp}`;

      const res = await importRows(project, [{ rowNumber: 1, title }], open.id);
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const cases = await casesInSuite(open.id, project);
      expect(cases.rows.map((r) => r.title)).toContain(title);
    },
  );

  test(
    "a row naming a new suite nests it under the suite Import was launched from, not the project root",
    { tag: '@tesbo.testId("TES-TC-2001")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest New ${stamp}`);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const namedSuite = `E2E Named ${stamp}`;

      const res = await importRows(project, [{ rowNumber: 1, title: `E2E Import Named Suite ${stamp}`, suite: namedSuite }], open.id);
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const suites = await suitesOf(project);
      const matches = suites.filter((s) => s.name === namedSuite);
      expect(matches, "exactly one suite must be created for the name — not one at root and one nested").toHaveLength(1);
      expect(
        matches[0].parentId,
        "the named suite must nest under the suite Import was launched from, not sit at the project root",
      ).toBe(open.id);
    },
  );

  test(
    "a row naming a suite that already exists as a child of the open suite reuses it, not duplicates it",
    { tag: '@tesbo.testId("TES-TC-2002")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Reuse ${stamp}`);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const childName = `E2E Existing Child ${stamp}`;
      const existingChild = await createSuite(childName, open.id, project);
      const title = `E2E Import Reuse Child ${stamp}`;

      const res = await importRows(project, [{ rowNumber: 1, title, suite: childName }], open.id);
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const suites = await suitesOf(project);
      expect(suites.filter((s) => s.name === childName), "no second suite of the same name+parent").toHaveLength(1);
      const cases = await casesInSuite(existingChild.id, project);
      expect(cases.rows.map((r) => r.title)).toContain(title);
    },
  );

  test(
    "a row naming a suite that exists elsewhere in the project does not reuse it across parents",
    { tag: '@tesbo.testId("TES-TC-2003")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Cross ${stamp}`);
      const sharedName = `E2E Shared Name ${stamp}`;
      const rootSuite = await createSuite(sharedName, undefined, project);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const title = `E2E Import Cross Parent ${stamp}`;

      const res = await importRows(project, [{ rowNumber: 1, title, suite: sharedName }], open.id);
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const suites = await suitesOf(project);
      const matches = suites.filter((s) => s.name === sharedName);
      expect(matches, "the pre-existing root suite and a new nested one, not a single shared node").toHaveLength(2);
      expect(matches.some((s) => s.id === rootSuite.id && s.parentId === null)).toBe(true);
      expect(matches.some((s) => s.parentId === open.id)).toBe(true);

      // The pre-existing root suite must not have gained the imported row.
      const rootCases = await casesInSuite(rootSuite.id, project);
      expect(rootCases.total).toBe(0);
    },
  );

  test(
    "Suite and Component columns together nest two levels under the open suite",
    { tag: '@tesbo.testId("TES-TC-2004")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Component ${stamp}`);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const suiteName = `E2E Two Level Suite ${stamp}`;
      const componentName = `E2E Two Level Component ${stamp}`;
      const title = `E2E Import Two Level ${stamp}`;

      const res = await importRows(project, [{ rowNumber: 1, title, suite: suiteName, component: componentName }], open.id);
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const suites = await suitesOf(project);
      const suiteNode = suites.find((s) => s.name === suiteName && s.parentId === open.id);
      expect(suiteNode, "the Suite column nests under the open suite").toBeTruthy();
      const componentNode = suites.find((s) => s.name === componentName && s.parentId === suiteNode!.id);
      expect(componentNode, "the Component column nests one level further, under the resolved suite").toBeTruthy();

      const cases = await casesInSuite(componentNode!.id, project);
      expect(cases.rows.map((r) => r.title)).toContain(title);
    },
  );

  test(
    "with no suite open, a row naming a suite still lands it at the project root (unchanged)",
    { tag: '@tesbo.testId("TES-TC-2005")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Root ${stamp}`);
      const namedSuite = `E2E Root Named ${stamp}`;

      // No defaultSuiteId at all — the "All test cases" / project-root view.
      const res = await importRows(project, [{ rowNumber: 1, title: `E2E Import Root Suite ${stamp}`, suite: namedSuite }]);
      expect(res.status()).toBe(200);
      expect((await res.json()).imported).toBe(1);

      const suites = await suitesOf(project);
      const created = suites.find((s) => s.name === namedSuite);
      expect(created, "the suite must still be created").toBeTruthy();
      expect(created!.parentId, "with nothing open, a named suite still lands at the project root").toBeNull();
    },
  );

  test(
    "an invalid or cross-project defaultSuiteId is refused, not silently used or crossing projects",
    { tag: '@tesbo.testId("TES-TC-2006")' },
    async () => {
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Invalid ${stamp}`);
      const otherProject = await newProject(`E2E Import Nest Foreign ${stamp}`);
      const foreignSuite = await createSuite(`E2E Foreign Suite ${stamp}`, undefined, otherProject);

      const bogusRes = await importRows(
        project,
        [{ rowNumber: 1, title: `E2E Import Bogus Default ${stamp}` }],
        "00000000-0000-0000-0000-000000000000",
        false,
      );
      expect(bogusRes.status(), "a defaultSuiteId that names no suite at all must be refused").toBe(400);

      const foreignRes = await importRows(
        project,
        [{ rowNumber: 1, title: `E2E Import Foreign Default ${stamp}` }],
        foreignSuite.id,
        false,
      );
      expect(
        foreignRes.status(),
        "a defaultSuiteId belonging to a different project must be refused, not accepted cross-project",
      ).toBe(400);

      const foreignCases = await casesInSuite(foreignSuite.id, otherProject);
      expect(foreignCases.total, "nothing must have landed in the other project's suite").toBe(0);
    },
  );

  test(
    "an import spanning multiple 1000-row chunks creates exactly one suite for a name repeated across chunks",
    { tag: '@tesbo.testId("TES-TC-2007")' },
    async () => {
      test.setTimeout(120_000);
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Chunked ${stamp}`);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const namedSuite = `E2E Chunked Suite ${stamp}`;
      // CHUNK_SIZE in importTestCases is 1000, so this exercises the cache carried across chunk 1
      // and chunk 2 rather than just the single-statement path every other test here takes.
      const rowCount = 1500;
      const rows = Array.from({ length: rowCount }, (_, i) => ({
        rowNumber: i + 1,
        title: `E2E Chunk Row ${stamp} ${i}`,
        suite: namedSuite,
      }));

      const res = await importRows(project, rows, open.id);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.imported, "every row across both chunks must land").toBe(rowCount);
      expect(body.errors).toEqual([]);

      const suites = await suitesOf(project);
      const matches = suites.filter((s) => s.name === namedSuite);
      expect(matches, "one suite for the whole import, not one recreated per chunk").toHaveLength(1);
      expect(matches[0].parentId).toBe(open.id);
      expect(matches[0].testCaseCount).toBe(rowCount);
    },
  );

  test(
    "two concurrent imports naming the same new suite under the same open suite do not create duplicate suites",
    { tag: '@tesbo.testId("TES-TC-2008")' },
    async () => {
      // Closes a race the request-lifetime suiteIdByKey snapshot otherwise leaves open: two imports
      // for the same project, each starting from a snapshot that predates the other's commit, both
      // deciding the same new suite name is missing. resolveImportSuites now re-checks the database
      // for the specific candidate parent(s) after the per-project advisory lock is already held, so
      // whichever request commits first is visible to the second before it decides to insert.
      const stamp = Date.now();
      const project = await newProject(`E2E Import Nest Concurrent ${stamp}`);
      const open = await createSuite(`E2E Open ${stamp}`, undefined, project);
      const namedSuite = `E2E Concurrent Suite ${stamp}`;

      const [resA, resB] = await Promise.all([
        importRows(project, [{ rowNumber: 1, title: `E2E Concurrent Row A ${stamp}`, suite: namedSuite }], open.id, false),
        importRows(project, [{ rowNumber: 1, title: `E2E Concurrent Row B ${stamp}`, suite: namedSuite }], open.id, false),
      ]);
      expect(resA.status(), "both concurrent imports must succeed").toBe(200);
      expect(resB.status(), "both concurrent imports must succeed").toBe(200);
      expect((await resA.json()).imported).toBe(1);
      expect((await resB.json()).imported).toBe(1);

      const suites = await suitesOf(project);
      const matches = suites.filter((s) => s.name === namedSuite);
      expect(
        matches,
        "two concurrent imports naming the same new suite under the same parent must not race into two siblings",
      ).toHaveLength(1);
      expect(matches[0].parentId).toBe(open.id);
      expect(matches[0].testCaseCount, "both rows must have landed in the single suite").toBe(2);
    },
  );

  /* ───────────────────────── run (cycle) CSV export ───────────────────────── */

  const seedRun = async (name: string, project = projectId) => {
    const cycle = await (
      await asOwner.post(`/api/projects/${project}/cycles`, { data: { name } })
    ).json();
    createdCycleIds.push(cycle.id);
    return cycle.id as string;
  };

  const executionsOf = async (cycleId: string) =>
    (await (await asOwner.get(`/api/cycles/${cycleId}/executions`)).json()) as {
      id: string;
      testcaseId: string;
    }[];

  test("exports one row per execution with the result that was recorded", { tag: '@tesbo.testId("TES-TC-216")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Run Export ${stamp}`);
    const passed = await seedCase({ title: `E2E Run Export Passed ${stamp}`, priority: "P1", type: "Smoke" }, project);
    const failed = await seedCase({ title: `E2E Run Export Failed ${stamp}` }, project);
    const cycleId = await seedRun(`E2E Run Export ${stamp}`, project);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds: [passed.id, failed.id] },
    });

    const executions = await executionsOf(cycleId);
    const passedExecution = executions.find((e) => e.testcaseId === passed.id)!;
    const failedExecution = executions.find((e) => e.testcaseId === failed.id)!;
    await asOwner.patch(`/api/cycles/${cycleId}/executions/${passedExecution.id}`, {
      data: { status: "Passed", actualResult: "As expected" },
    });
    await asOwner.patch(`/api/cycles/${cycleId}/executions/${failedExecution.id}`, {
      data: {
        status: "Failed",
        actualResult: "Threw a 500",
        defectKey: "BUG-1",
        defectUrl: "https://tracker.invalid/BUG-1",
      },
    });

    const res = await asOwner.get(`/api/cycles/${cycleId}/export/csv`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="test-run.csv"');

    const { headers, records } = parseCsvRecords(await res.text());
    expect(headers).toEqual(RUN_EXPORT_HEADERS);
    // Rows come out in cycle_items order (position, then created_at) — the order the cases were added.
    expect(records.map((r) => r.title)).toEqual([passed.title, failed.title]);
    expect(records[0]).toMatchObject({
      externalId: passed.externalId,
      status: "Passed",
      priority: "P1",
      type: "Smoke",
      actualResult: "As expected",
      defectKey: "",
      defectUrl: "",
    });
    expect(records[0].executedAt, "a recorded result carries its timestamp").not.toBe("");
    expect(records[1]).toMatchObject({
      status: "Failed",
      actualResult: "Threw a 500",
      defectKey: "BUG-1",
      defectUrl: "https://tracker.invalid/BUG-1",
    });
  });

  test("keeps the snapshot title of a case that was deleted after the run was built", { tag: '@tesbo.testId("TES-TC-217")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Run Export Snapshot ${stamp}`);
    const seeded = await seedCase({ title: `E2E Run Export Snapshot Case ${stamp}` }, project);
    const cycleId = await seedRun(`E2E Run Export Snapshot ${stamp}`, project);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: [seeded.id] } });
    await asOwner.delete(`/api/projects/${project}/testcases/${seeded.id}`);

    const { records } = parseCsvRecords(await (await asOwner.get(`/api/cycles/${cycleId}/export/csv`)).text());
    expect(records).toHaveLength(1);
    // The run keeps reporting what was run, even though the case is gone from the project.
    expect(records[0].title).toBe(seeded.title);
    expect(records[0].externalId, "the case's own columns are empty once it's deleted").toBe("");
  });

  test("excludes soft-deleted executions", { tag: '@tesbo.testId("TES-TC-218")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Run Export Deleted ${stamp}`);
    const kept = await seedCase({ title: `E2E Run Export Kept ${stamp}` }, project);
    const dropped = await seedCase({ title: `E2E Run Export Dropped ${stamp}` }, project);
    const cycleId = await seedRun(`E2E Run Export Deleted ${stamp}`, project);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds: [kept.id, dropped.id] },
    });

    const executions = await executionsOf(cycleId);
    const droppedExecution = executions.find((e) => e.testcaseId === dropped.id)!;
    // There is no DELETE route for an execution — the product only ever soft-deletes them from
    // cycle edits, so the fixture writes the column the export's WHERE clause reads.
    exec(`UPDATE executions SET deleted_at = now() WHERE id = ${literal(droppedExecution.id)};`);

    const { records } = parseCsvRecords(await (await asOwner.get(`/api/cycles/${cycleId}/export/csv`)).text());
    expect(records.map((r) => r.title)).toEqual([kept.title]);
  });

  test("a run with no cases exports the header row and nothing else", { tag: '@tesbo.testId("TES-TC-219")' }, async () => {
    const cycleId = await seedRun(`E2E Run Export Empty ${Date.now()}`);
    const res = await asOwner.get(`/api/cycles/${cycleId}/export/csv`);
    expect(res.status()).toBe(200);
    expect(parseCsv(await res.text())).toEqual([RUN_EXPORT_HEADERS]);
  });

  test("the run export refuses callers without access to the run", { tag: '@tesbo.testId("TES-TC-220")' }, async () => {
    // Red: exportCycle() takes no @Req() at all, so the whole run — case titles, external ids,
    // actual results, and the linked defect keys and URLs — is readable by anyone holding a cycle
    // id, with no session and from any workspace. This is the same "the controller method never
    // takes @Req()" pattern as the attachment reads.
    const stamp = Date.now();
    const seeded = await seedCase({ title: `E2E Run Export Authz ${stamp}` });
    const cycleId = await seedRun(`E2E Run Export Authz ${stamp}`);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: [seeded.id] } });
    const path = `/api/cycles/${cycleId}/export/csv`;

    const anonRes = await anon.get(path, { failOnStatusCode: false });
    expect([400, 401], "an anonymous caller must not be able to export a run").toContain(
      anonRes.status(),
    );
    // Belt and braces: if it does answer, prove the leak rather than only the status code.
    if (anonRes.status() === 200) {
      expect(await anonRes.text(), "…and the body is the real run").not.toContain(seeded.title);
    }

    const guestRes = await asGuest.get(path, { failOnStatusCode: false });
    expect([403, 404], "a workspace member with no project access is refused").toContain(
      guestRes.status(),
    );

    const outsiderRes = await asOutsider.get(path, { failOnStatusCode: false });
    expect([403, 404], "a caller from another workspace is refused").toContain(outsiderRes.status());
  });

  test("answers an unresolvable run id with 404", { tag: '@tesbo.testId("TES-TC-221")' }, async () => {
    // Red on both counts: a malformed id reaches Postgres as a uuid cast and 500s, and a
    // well-formed id for a run that doesn't exist returns 200 with a header-only CSV — so a typo
    // in a run id downloads an empty "report" instead of saying the run isn't there.
    const malformed = await asOwner.get("/api/cycles/not-a-uuid/export/csv", {
      failOnStatusCode: false,
    });
    expect(malformed.status(), "a malformed run id must not 500").toBe(404);

    const unknown = await asOwner.get(
      "/api/cycles/00000000-0000-0000-0000-000000000000/export/csv",
      { failOnStatusCode: false },
    );
    expect(unknown.status(), "a run that doesn't exist is a 404, not an empty CSV").toBe(404);
  });

  /* ───────────────────────── plan gating ───────────────────────── */

  test("a read-only locked project can still be exported, but not imported into", { tag: '@tesbo.testId("TES-TC-222")' }, async () => {
    // ProjectWriteLockGuard is documented as deliberately narrow: "locked projects stay fully
    // READABLE. Customers can always see and export their data." Both halves of that promise are
    // load-bearing for a workspace trying to get its data out after a downgrade, so both are
    // asserted here — the export must keep working, and the write the importer performs must not.
    const stamp = Date.now();
    const locked = await newProject(`E2E Export Locked ${stamp}`);
    const seeded = await seedCase({ title: `E2E Export Locked Case ${stamp}` }, locked);

    try {
      // The oldest 2 active projects stay writable on Launch; this workspace's fixture projects are
      // older, so the project created just above is the one that locks.
      setGraceWindow(tenant!.organizationId, -1);

      const exportRes = await exportCsv(asOwner, locked);
      expect(exportRes.status(), "a locked project must stay exportable").toBe(200);
      const { records } = parseCsvRecords(await exportRes.text());
      expect(records.map((r) => r.title)).toContain(seeded.title);

      const workbookRes = await asOwner.get(`/api/projects/${locked}/testcases/export/xlsx`, {
        failOnStatusCode: false,
      });
      expect(workbookRes.status(), "…in both formats").toBe(200);

      // The single-create route the wizard used before the bulk endpoint existed.
      const importRes = await asOwner.post(`/api/projects/${locked}/testcases`, {
        data: { title: `E2E Export Locked Import ${stamp}` },
        failOnStatusCode: false,
      });
      expect(importRes.status(), "importing into a locked project is refused").toBe(403);
      expect((await importRes.json()).error).toContain("read-only");

      // ProjectWriteLockGuard is applied globally by path pattern, not per-route, so the real bulk
      // import endpoint the wizard actually calls today must be refused the same way — checked
      // explicitly rather than assumed, since it's the exact route the suite-nesting fix touches.
      const bulkImportRes = await asOwner.post(`/api/projects/${locked}/testcases/import`, {
        data: { rows: [{ title: `E2E Export Locked Bulk Import ${stamp}` }] },
        failOnStatusCode: false,
      });
      expect(bulkImportRes.status(), "bulk-importing into a locked project is refused").toBe(403);
      expect((await bulkImportRes.json()).error).toContain("read-only");
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });
});
