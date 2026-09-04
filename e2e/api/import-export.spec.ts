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
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component",
];

/** The import template's columns — LegacyController.template()'s example row. */
const TEMPLATE_HEADERS = [
  "title",
  "description",
  "preconditions",
  "steps",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component",
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
    });
    // The suite column is the joined suite NAME, not its id — that's what makes an export
    // re-importable, since the import maps "Suite" by name.
    expect(records.find((r) => r.title === inSuite.title)!.suite).toBe(suite.name);
  });

  test("serialises each step as \"action => expected result\", joined by \" | \"", { tag: '@tesbo.testId("TES-TC-198")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Steps ${stamp}`);
    const seeded = await seedCase(
      {
        title: `E2E Export Steps ${stamp}`,
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
    expect(records.find((r) => r.title === seeded.title)!.steps).toBe(
      "Open the login page => The form is shown | Submit empty credentials",
    );
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

  test("orders rows by most recently updated", { tag: '@tesbo.testId("TES-TC-200")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Order ${stamp}`);
    const first = await seedCase({ title: `E2E Export Order A ${stamp}` }, project);
    const second = await seedCase({ title: `E2E Export Order B ${stamp}` }, project);
    await asOwner.put(`/api/projects/${project}/testcases/${first.id}`, {
      data: { description: "touched last" },
    });

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    expect(records.map((r) => r.title)).toEqual([first.title, second.title]);
  });

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

  test("adds a cf_<key> column for each active custom field, and drops archived ones", { tag: '@tesbo.testId("TES-TC-203")' }, async () => {
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

    const row = records.find((r) => r.title === seeded.title)!;
    expect(row[`cf_${text.key}`]).toBe("Platform");
    // A select exports its option LABEL, not the option id a raw value column would carry.
    expect(row[`cf_${select.key}`]).toBe("R2");
  });

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
      steps: "Click => It clicks",
    });
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
