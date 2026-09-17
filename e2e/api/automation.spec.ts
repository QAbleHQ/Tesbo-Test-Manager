import fs from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { literal, scalar } from "../utils/psql";

/*
 * Automation ingest -- Basecamp 10189985971, slices 1 and 2.
 *
 * Covers /api/projects/:projectId/automation/*: the run lifecycle, case linking by external id,
 * the wire status vocabulary, idempotency on CI retries, evidence, and the authorization rules
 * that are specific to a machine credential.
 *
 * Fixtures live in account A's smoke project (the same choice executions.spec.ts makes): every
 * test creates its own run and test cases and removes them in a `finally`, and nothing it does is
 * destructive to the workspace, so it does not need a tenant of its own.
 *
 * Names carry Date.now() because the database is persistent and shared -- a re-run must not
 * collide with the previous one, and testcases.external_id is UNIQUE per project.
 */

const ctxA = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const ctxB = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context-b.json"), "utf-8"));

const automationBase = (projectId: string) => `/api/projects/${projectId}/automation`;

/** What counts as a refusal -- same convention as authorization.spec.ts, for the same reasons. */
const REFUSED = [400, 401, 403, 404];

let asB: APIRequestContext;
let anon: APIRequestContext;

test.beforeAll(async () => {
  asB = await request.newContext({
    baseURL: env.apiBaseUrl,
    storageState: path.join(__dirname, "../.auth/state-b.json"),
  });
  // The request fixture inherits account A's storageState from playwright.config.ts; this clears
  // it explicitly to get a genuinely cookie-less context.
  anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: undefined });
});

test.afterAll(async () => {
  await asB?.dispose();
  await anon?.dispose();
});

interface SeededCase {
  id: string;
  externalId: string;
}

/**
 * Creates test cases and returns their Tesbo external ids -- the ids an SDK's
 * `@tesbo.testId("...")` tag would carry.
 *
 * The API assigns external_id itself, so it is read back off the create response rather than
 * chosen here: the point of the linking mechanism is that the SDK uses the id Tesbo shows, and a
 * test that invented its own would be exercising a different contract.
 */
async function seedCases(api: APIRequestContext, count: number, label: string): Promise<SeededCase[]> {
  const cases: SeededCase[] = [];
  for (let index = 0; index < count; index += 1) {
    const res = await api.post(`/api/projects/${ctxA.projectId}/testcases`, {
      data: { title: `E2E Automation ${label} ${index} ${Date.now()}` },
    });
    expect(res.ok(), `seeding test case ${index} for ${label}`).toBeTruthy();
    const body = await res.json();
    expect(body.externalId, "the API must assign an external id -- it is the linking key").toBeTruthy();
    cases.push({ id: body.id, externalId: body.externalId });
  }
  return cases;
}

async function cleanup(api: APIRequestContext, runIds: string[], caseIds: string[]) {
  for (const runId of runIds) {
    await api.delete(`/api/cycles/${runId}`, { failOnStatusCode: false });
  }
  for (const caseId of caseIds) {
    await api.delete(`/api/projects/${ctxA.projectId}/testcases/${caseId}`, { failOnStatusCode: false });
  }
}

async function createRun(api: APIRequestContext, data: Record<string, unknown>) {
  return api.post(`${automationBase(ctxA.projectId)}/runs`, { data, failOnStatusCode: false });
}

async function postResult(api: APIRequestContext, runId: string, data: Record<string, unknown>) {
  return api.post(`${automationBase(ctxA.projectId)}/runs/${runId}/results`, {
    data,
    failOnStatusCode: false,
  });
}

/** A 1x1 PNG, so an upload carries real bytes with a real content type. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("automation ingest - run lifecycle", () => {
  test("AUT-01 a full session: create a run, report pass/fail/skip, attach evidence, close, read it back", { tag: '@tesbo.testId("TES-TC-1119")' }, async ({
    request: api,
  }) => {
    const cases = await seedCases(api, 3, "lifecycle");
    const runIds: string[] = [];
    try {
      const created = await createRun(api, {
        name: `E2E Automation Run ${Date.now()}`,
        triggeredBy: "github-actions",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
        buildUrl: "https://github.com/acme/web/actions/runs/1",
        environment: "staging",
        caseIds: cases.map((c) => c.externalId),
      });
      expect(created.status(), await created.text()).toBe(201);
      const run = await created.json();
      runIds.push(run.runId);

      // A run is created live, with its clock started: cycles.started_at is otherwise written only
      // by the manual status transition, so an automated run has to set it here or the run list's
      // duration reads as a dash forever.
      expect(run.source).toBe("automation");
      expect(run.status).toBe("In Progress");
      expect(run.startedAt).toBeTruthy();
      expect(run.triggeredBy).toBe("github-actions");
      expect(run.branch).toBe("main");
      expect(run.reused).toBe(false);
      expect(run.unknownCaseIds).toEqual([]);

      /*
       * The cases are actually in the run. This assertion pins the trap: all three cycle-create
       * routes (including /cycles/from-cases, whose name promises exactly this) are wired to the
       * same createCycle(), which never reads testcaseIds -- so the obvious way to build this
       * endpoint returns an empty run and no error.
       */
      expect(run.casesAttached).toBe(3);
      expect(run.summary.total).toBe(3);
      expect(run.summary.untested).toBe(3);

      const passed = await postResult(api, run.runId, {
        caseId: cases[0].externalId,
        status: "pass",
        durationMs: 1234,
      });
      expect(passed.ok(), await passed.text()).toBeTruthy();

      const failed = await postResult(api, run.runId, {
        caseId: cases[1].externalId,
        status: "fail",
        durationMs: 900,
        errorMessage: "expect(received).toBe(expected)",
        errorStack: "at spec.ts:12:3",
      });
      expect(failed.ok(), await failed.text()).toBeTruthy();

      const skipped = await postResult(api, run.runId, { caseId: cases[2].externalId, status: "skip" });
      expect(skipped.ok()).toBeTruthy();

      const evidence = await api.post(
        `${automationBase(ctxA.projectId)}/runs/${run.runId}/results/${cases[1].externalId}/evidence`,
        {
          multipart: {
            kind: "screenshot",
            files: { name: "failure.png", mimeType: "image/png", buffer: PNG_1PX },
          },
          failOnStatusCode: false,
        },
      );
      expect(evidence.status(), await evidence.text()).toBe(201);
      const uploaded = await evidence.json();
      expect(uploaded.total).toBe(1);
      expect(uploaded.skipped).toBeNull();

      const closed = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "completed", summary: { total: 3, passed: 1, failed: 1, skipped: 1 } },
      });
      expect(closed.ok(), await closed.text()).toBeTruthy();
      const closeBody = await closed.json();
      expect(closeBody.status).toBe("Completed");
      expect(closeBody.closeStatus).toBe("completed");
      expect(closeBody.endedAt).toBeTruthy();
      expect(closeBody.alreadyClosed).toBe(false);
      // The SDK's summary agreed with the stored rows, so there is nothing to report.
      expect(closeBody.mismatch).toBeNull();

      const readBack = await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`);
      expect(readBack.ok()).toBeTruthy();
      const detail = await readBack.json();
      expect(detail.summary).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });

      const byCase = new Map<string, any>(detail.results.map((r: any) => [r.caseId, r]));
      expect(byCase.get(cases[0].externalId).status).toBe("Passed");
      expect(byCase.get(cases[0].externalId).durationMs).toBe(1234);
      expect(byCase.get(cases[0].externalId).reportedBy).toBe("automation");
      expect(byCase.get(cases[1].externalId).status).toBe("Failed");
      expect(byCase.get(cases[1].externalId).errorMessage).toContain("expect(received)");
      expect(byCase.get(cases[1].externalId).evidence).toHaveLength(1);
      expect(byCase.get(cases[1].externalId).evidence[0].kind).toBe("screenshot");
      expect(byCase.get(cases[2].externalId).status).toBe("Skipped");

      /*
       * The same rows are visible through the ordinary run screen's endpoint, not only the
       * automation one. This is the whole reason results land on cycles/executions instead of a
       * reporting silo -- an automated result has to appear in the run list, the reports and the
       * traceability matrix, all of which read this projection.
       */
      const viaRunScreen = await api.get(`/api/cycles/${run.runId}/executions`);
      expect(viaRunScreen.ok()).toBeTruthy();
      const executions = await viaRunScreen.json();
      expect(executions).toHaveLength(3);
      const passedRow = executions.find((e: any) => e.externalId === cases[0].externalId);
      expect(passedRow.status).toBe("Passed");
      expect(passedRow.reportedBy).toBe("automation");
      expect(passedRow.durationMs).toBe(1234);
      const failedRow = executions.find((e: any) => e.externalId === cases[1].externalId);
      expect(failedRow.evidenceCount).toBe(1);
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-02 a run with no caseIds still accepts results, attaching each case as it reports", { tag: '@tesbo.testId("TES-TC-1120")' }, async ({
    request: api,
  }) => {
    // A suite that grew a test after the run was opened must still be able to report it. This is
    // not case *creation*: the case already exists and was approved by a person.
    const cases = await seedCases(api, 1, "late-attach");
    const runIds: string[] = [];
    try {
      const created = await createRun(api, { name: `E2E Automation Late ${Date.now()}` });
      const run = await created.json();
      runIds.push(run.runId);
      expect(run.casesAttached).toBe(0);
      expect(run.summary.total).toBe(0);

      const posted = await postResult(api, run.runId, { caseId: cases[0].externalId, status: "pass" });
      expect(posted.ok(), await posted.text()).toBeTruthy();

      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      expect(detail.summary.total).toBe(1);
      expect(detail.results[0].status).toBe("Passed");
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-03 closing twice reports the run as already closed rather than reopening or erroring", { tag: '@tesbo.testId("TES-TC-1121")' }, async ({
    request: api,
  }) => {
    // A retried CI step closes twice. Neither an error nor a silent reopen is right: the second
    // call has to be a no-op that says so.
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Reclose ${Date.now()}` })).json();
      runIds.push(run.runId);
      const first = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "completed" },
      });
      expect((await first.json()).alreadyClosed).toBe(false);

      const second = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "completed" },
      });
      expect(second.ok()).toBeTruthy();
      const body = await second.json();
      expect(body.alreadyClosed).toBe(true);
      expect(body.status).toBe("Completed");
    } finally {
      await cleanup(api, runIds, []);
    }
  });

  test("AUT-04 an incomplete close is recorded as such while the run still reads Completed", { tag: '@tesbo.testId("TES-TC-1122")' }, async ({
    request: api,
  }) => {
    /*
     * cycles.status has exactly three values and the runs list filters and sorts on all three, so
     * an abandoned run cannot get a fourth without dropping out of every existing filter.
     * close_status is where the difference lives.
     */
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Incomplete ${Date.now()}` })).json();
      runIds.push(run.runId);
      const closed = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "incomplete" },
      });
      expect(closed.ok()).toBeTruthy();
      const body = await closed.json();
      expect(body.closeStatus).toBe("incomplete");
      expect(body.status).toBe("Completed");
    } finally {
      await cleanup(api, runIds, []);
    }
  });

  test("AUT-05 a summary that disagrees with the stored rows is reported as a mismatch, not stored", { tag: '@tesbo.testId("TES-TC-1123")' }, async ({
    request: api,
  }) => {
    /*
     * The card asks the SDK to send its own counts. Trusting them would let the run screen
     * contradict its own rows when a result POST failed and was not retried -- and the mismatch is
     * the ONLY place such a dropped result is visible at all.
     */
    const cases = await seedCases(api, 1, "mismatch");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Mismatch ${Date.now()}`,
          caseIds: [cases[0].externalId],
        })
      ).json();
      runIds.push(run.runId);
      await postResult(api, run.runId, { caseId: cases[0].externalId, status: "pass" });

      const closed = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "completed", summary: { total: 5, passed: 5, failed: 0, skipped: 0 } },
      });
      const body = await closed.json();
      expect(body.mismatch).not.toBeNull();
      expect(body.mismatch.total).toEqual({ reported: 5, stored: 1 });
      expect(body.mismatch.passed).toEqual({ reported: 5, stored: 1 });
      // Stored counts win.
      expect(body.summary).toMatchObject({ total: 1, passed: 1 });
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });
});

test.describe("automation ingest - case linking", () => {
  test("AUT-10 cases/resolve separates the ids that exist from the ones that do not", { tag: '@tesbo.testId("TES-TC-1124")' }, async ({
    request: api,
  }) => {
    // Card section 3: this is the call an SDK makes at collection time so a typo fails fast
    // locally instead of silently not reporting hours later.
    const cases = await seedCases(api, 2, "resolve");
    try {
      const res = await api.post(`${automationBase(ctxA.projectId)}/cases/resolve`, {
        data: { caseIds: [cases[0].externalId, "NOPE-99999", cases[1].externalId] },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const body = await res.json();
      expect(body.requested).toBe(3);
      expect(body.known.map((k: any) => k.caseId).sort()).toEqual(
        [cases[0].externalId, cases[1].externalId].sort(),
      );
      expect(body.unknown).toEqual(["NOPE-99999"]);
    } finally {
      await cleanup(api, [], cases.map((c) => c.id));
    }
  });

  test("AUT-11 case ids match case-insensitively", { tag: '@tesbo.testId("TES-TC-1125")' }, async ({ request: api }) => {
    // A developer writing tesbo.testId("tes-1042") means the same case as TES-1042, and the
    // trigram index is on lower(external_id) so the comparison is indexed either way.
    const cases = await seedCases(api, 1, "case-fold");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Fold ${Date.now()}`,
          caseIds: [cases[0].externalId.toLowerCase()],
        })
      ).json();
      runIds.push(run.runId);
      expect(run.casesAttached).toBe(1);
      expect(run.unknownCaseIds).toEqual([]);

      const posted = await postResult(api, run.runId, {
        caseId: cases[0].externalId.toLowerCase(),
        status: "pass",
      });
      expect(posted.ok()).toBeTruthy();
      // The stored id keeps its canonical casing, not the caller's.
      expect((await posted.json()).caseId).toBe(cases[0].externalId);
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-12 an unknown case id is refused and no test case is created for it", { tag: '@tesbo.testId("TES-TC-1126")' }, async ({
    request: api,
  }) => {
    /*
     * The card's positioning note: automation "does not generate or approve test cases". The
     * tempting behaviour -- create the missing case so the result has somewhere to go -- would let
     * a CI pipeline fill a project with unapproved cases nobody wrote.
     */
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Unknown ${Date.now()}` })).json();
      runIds.push(run.runId);

      const posted = await postResult(api, run.runId, { caseId: "AUT12GHOST", status: "pass" });
      expect(posted.status()).toBe(404);
      expect((await posted.json()).error).toContain("never creates them");

      // And nothing was conjured into existence.
      const search = await api.get(
        `/api/projects/${ctxA.projectId}/testcases?search=AUT12GHOST`,
      );
      const found = await search.json();
      expect(found.list ?? found).toHaveLength(0);
    } finally {
      await cleanup(api, runIds, []);
    }
  });

  test("AUT-13 unknown ids at run creation are reported, not fatal", { tag: '@tesbo.testId("TES-TC-1127")' }, async ({ request: api }) => {
    // A stale tag should not stop the run: the SDK gets the list back and warns, and the rest of
    // the suite still reports.
    const cases = await seedCases(api, 1, "partial");
    const runIds: string[] = [];
    try {
      const created = await createRun(api, {
        name: `E2E Automation Partial ${Date.now()}`,
        caseIds: [cases[0].externalId, "GONE-1", "GONE-2"],
      });
      expect(created.status()).toBe(201);
      const run = await created.json();
      runIds.push(run.runId);
      expect(run.casesAttached).toBe(1);
      expect(run.unknownCaseIds.sort()).toEqual(["GONE-1", "GONE-2"]);
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-14 duplicate case ids in one call do not break the unique constraint", { tag: '@tesbo.testId("TES-TC-1128")' }, async ({
    request: api,
  }) => {
    // Two automated tests legitimately covering one manual case would otherwise fail the whole
    // run-creation call on cycle_items (cycle_id, testcase_id).
    const cases = await seedCases(api, 1, "dupe");
    const runIds: string[] = [];
    try {
      const created = await createRun(api, {
        name: `E2E Automation Dupe ${Date.now()}`,
        caseIds: [cases[0].externalId, cases[0].externalId, cases[0].externalId],
      });
      expect(created.status(), await created.text()).toBe(201);
      const run = await created.json();
      runIds.push(run.runId);
      expect(run.casesAttached).toBe(1);
      expect(run.summary.total).toBe(1);
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-15 another tenant's test case is never adopted into this run", { tag: '@tesbo.testId("TES-TC-1129")' }, async ({ request: api }) => {
    /*
     * Tenancy, not convenience. addCycleTestCases had this exact hole: a case resolved by id alone
     * let one workspace's run adopt another's case, copying its title into snapshot_title.
     *
     * Account A and account B number their cases independently, so B's external id may
     * coincidentally exist in A too -- which is why the assertion is on the attached row's TITLE,
     * not on the count.
     */
    const foreignTitle = `E2E Automation Foreign Case ${Date.now()}`;
    const bCase = await (
      await asB.post(`/api/projects/${ctxB.projectId}/testcases`, { data: { title: foreignTitle } })
    ).json();
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Foreign ${Date.now()}`,
          caseIds: [bCase.externalId],
        })
      ).json();
      runIds.push(run.runId);

      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      for (const result of detail.results) {
        expect(result.title).not.toBe(foreignTitle);
      }
    } finally {
      await cleanup(api, runIds, []);
      await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCase.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("automation ingest - status vocabulary", () => {
  const MAPPINGS: Array<[string, string]> = [
    ["pass", "Passed"],
    ["passed", "Passed"],
    ["fail", "Failed"],
    ["failed", "Failed"],
    ["skip", "Skipped"],
    ["skipped", "Skipped"],
    ["blocked", "Blocked"],
    ["Passed", "Passed"],
    // Playwright's own two extra statuses. A test that ran out of time did not pass, and one torn
    // down by --max-failures never reached a verdict of its own, which is what Blocked means.
    ["timedOut", "Failed"],
    ["timed_out", "Failed"],
    ["interrupted", "Blocked"],
  ];

  test("AUT-20 every accepted wire status maps to a stored status the dashboards count", { tag: '@tesbo.testId("TES-TC-1130")' }, async ({
    request: api,
  }) => {
    /*
     * This is the assertion the whole feature turns on. executions.status is a bare VARCHAR(32)
     * and every aggregate in the product counts by exact match ('Passed', 'Failed', ...) -- so a
     * literal "pass" is stored happily and then counted as neither passed nor executed. The card's
     * own draft contract specifies exactly that lowercase vocabulary, so an SDK written to it
     * would have corrupted every run it reported, with no error anywhere.
     */
    const cases = await seedCases(api, MAPPINGS.length, "statuses");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Statuses ${Date.now()}`,
          caseIds: cases.map((c) => c.externalId),
        })
      ).json();
      runIds.push(run.runId);

      for (const [index, [wire, stored]] of MAPPINGS.entries()) {
        const posted = await postResult(api, run.runId, {
          caseId: cases[index].externalId,
          status: wire,
        });
        expect(posted.ok(), `status "${wire}": ${await posted.text()}`).toBeTruthy();
        expect((await posted.json()).status, `status "${wire}" must store as "${stored}"`).toBe(stored);
      }
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-21 an unrecognised, missing, or over-long status is refused, never stored", { tag: '@tesbo.testId("TES-TC-1131")' }, async ({
    request: api,
  }) => {
    // The over-long case is the one that used to be a 500: status is VARCHAR(32), so a
    // 33-character value reached Postgres and failed the length constraint as an unhandled error.
    const cases = await seedCases(api, 1, "bad-status");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Bad Status ${Date.now()}`,
          caseIds: [cases[0].externalId],
        })
      ).json();
      runIds.push(run.runId);

      const bad: Array<Record<string, unknown>> = [
        { status: "banana" },
        { status: "" },
        { status: "   " },
        { status: "x".repeat(40) },
        { status: null },
        { status: 42 },
        {},
      ];
      for (const payload of bad) {
        const posted = await postResult(api, run.runId, {
          caseId: cases[0].externalId,
          ...payload,
        });
        expect(posted.status(), `payload ${JSON.stringify(payload)} must be a 400`).toBe(400);
        expect((await posted.json()).error).toContain("status must be one of");
      }

      // Nothing was written by any of them.
      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      expect(detail.results[0].status).toBe("Untested");
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });
});

test.describe("automation ingest - idempotency", () => {
  test("AUT-30 resubmitting a result updates it in place and counts the retry", { tag: '@tesbo.testId("TES-TC-1132")' }, async ({
    request: api,
  }) => {
    /*
     * "CI reruns and flaky-test retries must not create duplicate results ... Latest attempt wins,
     * but retry count should be stored for visibility."
     *
     * The no-duplicate half is a property of the schema (cycle_items is UNIQUE on
     * (cycle_id, testcase_id), executions on (cycle_item_id)); the retry count is not, so that is
     * what this test is really for.
     */
    const cases = await seedCases(api, 1, "retry");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Retry ${Date.now()}`,
          caseIds: [cases[0].externalId],
        })
      ).json();
      runIds.push(run.runId);

      const first = await postResult(api, run.runId, { caseId: cases[0].externalId, status: "fail" });
      expect((await first.json()).retryCount).toBe(0);

      const second = await postResult(api, run.runId, { caseId: cases[0].externalId, status: "fail" });
      expect((await second.json()).retryCount).toBe(1);

      const third = await postResult(api, run.runId, { caseId: cases[0].externalId, status: "pass" });
      const thirdBody = await third.json();
      expect(thirdBody.retryCount).toBe(2);
      // Latest attempt wins: the case reads Passed, with the retries kept as the flakiness signal.
      expect(thirdBody.status).toBe("Passed");

      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      expect(detail.results, "three submissions must be one result row").toHaveLength(1);
      expect(detail.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-31 a caller-supplied retryCount wins, so a re-report does not inflate it", { tag: '@tesbo.testId("TES-TC-1133")' }, async ({
    request: api,
  }) => {
    // Playwright knows its own attempt index; letting the server increment on top of that would
    // make a re-reported result look flakier than it was.
    const cases = await seedCases(api, 1, "retry-explicit");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Retry Explicit ${Date.now()}`,
          caseIds: [cases[0].externalId],
        })
      ).json();
      runIds.push(run.runId);

      await postResult(api, run.runId, { caseId: cases[0].externalId, status: "fail", retryCount: 2 });
      const again = await postResult(api, run.runId, {
        caseId: cases[0].externalId,
        status: "pass",
        retryCount: 2,
      });
      expect((await again.json()).retryCount).toBe(2);
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-32 the same externalId resolves to the existing run instead of opening a second", { tag: '@tesbo.testId("TES-TC-1134")' }, async ({
    request: api,
  }) => {
    // A GitHub Actions workflow re-run, and every shard of one attempt, present the same key.
    // Without this each shard would open its own run holding a fraction of the results.
    const externalId = `e2e-gha-${Date.now()}`;
    const runIds: string[] = [];
    try {
      const first = await createRun(api, { name: `E2E Automation Idem A ${Date.now()}`, externalId });
      expect(first.status()).toBe(201);
      const runA = await first.json();
      runIds.push(runA.runId);
      expect(runA.reused).toBe(false);

      const second = await createRun(api, { name: `E2E Automation Idem B ${Date.now()}`, externalId });
      expect(second.ok(), await second.text()).toBeTruthy();
      const runB = await second.json();
      expect(runB.runId).toBe(runA.runId);
      expect(runB.reused).toBe(true);
      // The first call's name stands: a shard must not rename the run out from under the others.
      expect(runB.name).toBe(runA.name);
    } finally {
      await cleanup(api, runIds, []);
    }
  });

  test("AUT-33 concurrent shards racing on one externalId converge on a single run", { tag: '@tesbo.testId("TES-TC-1135")' }, async ({
    request: api,
  }) => {
    /*
     * The partial unique index is what makes this safe: the loser's insert violates it and the
     * handler resolves to the winner's run rather than failing that shard's whole session.
     */
    const externalId = `e2e-race-${Date.now()}`;
    const runIds: string[] = [];
    try {
      const responses = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          createRun(api, { name: `E2E Automation Race ${n} ${Date.now()}`, externalId }),
        ),
      );
      const bodies = await Promise.all(responses.map((r) => r.json()));
      for (const [index, res] of responses.entries()) {
        expect(res.ok(), `shard ${index} must not fail: ${JSON.stringify(bodies[index])}`).toBeTruthy();
      }
      const ids = new Set(bodies.map((b) => b.runId));
      expect(ids.size, "all four shards must land on one run").toBe(1);
      runIds.push([...ids][0] as string);
    } finally {
      await cleanup(api, runIds, []);
    }
  });
});

test.describe("automation ingest - validation", () => {
  test("AUT-40 a run needs a name, and an over-long one is a 400 rather than a 500", { tag: '@tesbo.testId("TES-TC-1136")' }, async ({
    request: api,
  }) => {
    // cycles.name is VARCHAR(255).
    for (const data of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(256) }]) {
      const res = await createRun(api, data);
      expect(res.status(), `payload ${JSON.stringify(data)} must be a 400`).toBe(400);
    }
  });

  test("AUT-41 over-long provenance fields are refused by name, not truncated", { tag: '@tesbo.testId("TES-TC-1137")' }, async ({
    request: api,
  }) => {
    // Every field here comes from a CI environment variable whose length the pipeline does not
    // control. Truncating a commit SHA would store one that matches no commit -- worse than
    // refusing it.
    const fields: Array<[string, number]> = [
      ["externalId", 64],
      ["commitSha", 64],
      ["branch", 255],
      ["buildUrl", 1024],
      ["environment", 128],
      ["buildVersion", 128],
      ["releaseName", 128],
    ];
    for (const [field, max] of fields) {
      const res = await createRun(api, {
        name: `E2E Automation Bound ${Date.now()}`,
        [field]: "x".repeat(max + 1),
      });
      expect(res.status(), `${field} over ${max} must be a 400`).toBe(400);
      expect((await res.json()).error).toContain(field);
    }
  });

  test("AUT-42 triggeredBy is bounded, so a typo in a CI config is refused", { tag: '@tesbo.testId("TES-TC-1138")' }, async ({ request: api }) => {
    const res = await createRun(api, {
      name: `E2E Automation Trigger ${Date.now()}`,
      triggeredBy: "githubactions",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("triggeredBy must be one of");
  });

  test("AUT-43 caseIds must be an array, is capped, and rejects ids no case could have", { tag: '@tesbo.testId("TES-TC-1139")' }, async ({
    request: api,
  }) => {
    const notArray = await createRun(api, {
      name: `E2E Automation Cases ${Date.now()}`,
      caseIds: "TES-1",
    });
    expect(notArray.status()).toBe(400);

    const tooMany = await createRun(api, {
      name: `E2E Automation Cases ${Date.now()}`,
      caseIds: Array.from({ length: 2001 }, (_, i) => `TES-${i}`),
    });
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).error).toContain("at most");

    // Longer than testcases.external_id VARCHAR(32) cannot be a Tesbo case id at all.
    const tooLong = await createRun(api, {
      name: `E2E Automation Cases ${Date.now()}`,
      caseIds: ["x".repeat(33)],
    });
    expect(tooLong.status()).toBe(400);
  });

  test("AUT-44 durationMs and retryCount reject values a real test cannot produce", { tag: '@tesbo.testId("TES-TC-1140")' }, async ({
    request: api,
  }) => {
    // duration_ms is INTEGER (about 24.8 days); retry_count is a non-negative count. Neither had
    // a floor or a ceiling on this path before.
    const cases = await seedCases(api, 1, "numbers");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, {
          name: `E2E Automation Numbers ${Date.now()}`,
          caseIds: [cases[0].externalId],
        })
      ).json();
      runIds.push(run.runId);

      for (const durationMs of [-1, 2147483648, "not-a-number"]) {
        const res = await postResult(api, run.runId, {
          caseId: cases[0].externalId,
          status: "pass",
          durationMs,
        });
        expect(res.status(), `durationMs ${durationMs}`).toBe(400);
      }
      for (const retryCount of [-1, 1.5, 10000]) {
        const res = await postResult(api, run.runId, {
          caseId: cases[0].externalId,
          status: "pass",
          retryCount,
        });
        expect(res.status(), `retryCount ${retryCount}`).toBe(400);
      }
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-45 a malformed or unknown run id is a 404, never a 500 from the uuid cast", { tag: '@tesbo.testId("TES-TC-1141")' }, async ({
    request: api,
  }) => {
    // The convention requireProjectAccess set: a typo and a genuinely missing row get the same
    // answer, so probing ids cannot confirm a run exists.
    for (const runId of ["not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      const get = await api.get(`${automationBase(ctxA.projectId)}/runs/${runId}`, {
        failOnStatusCode: false,
      });
      expect(get.status(), `GET ${runId}`).toBe(404);

      const post = await postResult(api, runId, { caseId: "TES-1", status: "pass" });
      expect(post.status(), `POST results ${runId}`).toBe(404);

      const close = await api.patch(`${automationBase(ctxA.projectId)}/runs/${runId}/close`, {
        data: { status: "completed" },
        failOnStatusCode: false,
      });
      expect(close.status(), `close ${runId}`).toBe(404);
    }
  });

  test("AUT-46 close rejects a status outside completed/incomplete", { tag: '@tesbo.testId("TES-TC-1142")' }, async ({ request: api }) => {
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Close Bad ${Date.now()}` })).json();
      runIds.push(run.runId);
      const res = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "finished" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
    } finally {
      await cleanup(api, runIds, []);
    }
  });
});

test.describe("automation ingest - authorization", () => {
  /** Issues a project API token and returns a context that presents it as a bearer credential. */
  async function tokenContext(
    api: APIRequestContext,
    projectId: string,
    scopes: string[],
  ): Promise<{ ctx: APIRequestContext; tokenId: string }> {
    const res = await api.post(`/api/projects/${projectId}/apikeys`, {
      data: { name: `E2E Automation Token ${Date.now()}`, scopes },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await res.json();
    expect(body.token, "the raw token is returned exactly once, at creation").toBeTruthy();
    const ctx = await request.newContext({
      baseURL: env.apiBaseUrl,
      // No storageState: this must authenticate on the bearer token alone, which is all an SDK has.
      storageState: undefined,
      extraHTTPHeaders: { Authorization: `Bearer ${body.token}` },
    });
    return { ctx, tokenId: body.id };
  }

  test("AUT-50 an anonymous caller is refused on every route", { tag: '@tesbo.testId("TES-TC-1143")' }, async ({ request: api }) => {
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Anon ${Date.now()}` })).json();
      runIds.push(run.runId);
      const base = automationBase(ctxA.projectId);

      const responses = await Promise.all([
        anon.post(`${base}/cases/resolve`, { data: { caseIds: [] }, failOnStatusCode: false }),
        anon.post(`${base}/runs`, { data: { name: "nope" }, failOnStatusCode: false }),
        anon.get(`${base}/runs/${run.runId}`, { failOnStatusCode: false }),
        anon.post(`${base}/runs/${run.runId}/results`, {
          data: { caseId: "X", status: "pass" },
          failOnStatusCode: false,
        }),
        anon.patch(`${base}/runs/${run.runId}/close`, {
          data: { status: "completed" },
          failOnStatusCode: false,
        }),
      ]);
      for (const [index, res] of responses.entries()) {
        expect(REFUSED, `anonymous call ${index} answered ${res.status()}`).toContain(res.status());
      }
    } finally {
      await cleanup(api, runIds, []);
    }
  });

  test("AUT-51 a project-scoped API token can drive a whole session", { tag: '@tesbo.testId("TES-TC-1144")' }, async ({ request: api }) => {
    // The credential the SDK actually holds. Nothing here uses a browser session.
    const cases = await seedCases(api, 1, "token");
    const runIds: string[] = [];
    let token: { ctx: APIRequestContext; tokenId: string } | null = null;
    try {
      token = await tokenContext(api, ctxA.projectId, ["read", "write"]);
      const created = await token.ctx.post(`${automationBase(ctxA.projectId)}/runs`, {
        data: { name: `E2E Automation Token Run ${Date.now()}`, caseIds: [cases[0].externalId] },
        failOnStatusCode: false,
      });
      expect(created.status(), await created.text()).toBe(201);
      const run = await created.json();
      runIds.push(run.runId);
      expect(run.casesAttached).toBe(1);

      const posted = await token.ctx.post(
        `${automationBase(ctxA.projectId)}/runs/${run.runId}/results`,
        { data: { caseId: cases[0].externalId, status: "pass" }, failOnStatusCode: false },
      );
      expect(posted.ok(), await posted.text()).toBeTruthy();

      const closed = await token.ctx.patch(
        `${automationBase(ctxA.projectId)}/runs/${run.runId}/close`,
        { data: { status: "completed" }, failOnStatusCode: false },
      );
      expect(closed.ok()).toBeTruthy();
    } finally {
      await token?.ctx.dispose();
      if (token) {
        await api.delete(`/api/projects/${ctxA.projectId}/apikeys/${token.tokenId}`, {
          failOnStatusCode: false,
        });
      }
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-52 a read-only token can read a run but not write one", { tag: '@tesbo.testId("TES-TC-1145")' }, async ({ request: api }) => {
    // Scope enforcement lives in the controller. Without it "read" would be indistinguishable
    // from "write" on this surface.
    let token: { ctx: APIRequestContext; tokenId: string } | null = null;
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Scope ${Date.now()}` })).json();
      runIds.push(run.runId);

      token = await tokenContext(api, ctxA.projectId, ["read"]);
      const write = await token.ctx.post(`${automationBase(ctxA.projectId)}/runs`, {
        data: { name: "nope" },
        failOnStatusCode: false,
      });
      expect(write.status()).toBe(403);
      expect((await write.json()).error).toContain("write");

      const read = await token.ctx.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`, {
        failOnStatusCode: false,
      });
      expect(read.ok(), await read.text()).toBeTruthy();
    } finally {
      await token?.ctx.dispose();
      if (token) {
        await api.delete(`/api/projects/${ctxA.projectId}/apikeys/${token.tokenId}`, {
          failOnStatusCode: false,
        });
      }
      await cleanup(api, runIds, []);
    }
  });

  test("AUT-53 a token scoped to one project cannot reach another in the same workspace", { tag: '@tesbo.testId("TES-TC-1146")' }, async ({
    request: api,
  }) => {
    /*
     * The reason the controller checks this itself. requireProjectAccess authorizes the token's
     * *user*, who may be a member of several projects -- so on its own it would let a token issued
     * for project A drive project B. McpService makes the same check; the rest of the REST surface
     * does not, which is a wider gap recorded in docs/automation-integration-plan.md.
     *
     * Account A is a Launch workspace limited to 2 projects and its smoke project holds one slot,
     * so this skips rather than failing if the allowance is already full.
     */
    let token: { ctx: APIRequestContext; tokenId: string } | null = null;
    let otherProjectId: string | null = null;
    try {
      const created = await api.post("/api/projects", {
        data: { name: `E2E Automation Other ${Date.now()}`, description: "token scope fixture" },
        failOnStatusCode: false,
      });
      test.skip(
        !created.ok(),
        `could not create a second project for the scope check (${created.status()}) - the workspace's project allowance is full`,
      );
      otherProjectId = (await created.json()).id as string;

      token = await tokenContext(api, otherProjectId, ["read", "write"]);
      const crossed = await token.ctx.post(`${automationBase(ctxA.projectId)}/runs`, {
        data: { name: "nope" },
        failOnStatusCode: false,
      });
      expect(crossed.status()).toBe(403);
      expect((await crossed.json()).error).toContain("not scoped to this project");
    } finally {
      await token?.ctx.dispose();
      if (token && otherProjectId) {
        await api.delete(`/api/projects/${otherProjectId}/apikeys/${token.tokenId}`, {
          failOnStatusCode: false,
        });
      }
      if (otherProjectId) {
        await api.delete(`/api/projects/${otherProjectId}`, { failOnStatusCode: false });
      }
    }
  });

  test("AUT-54 account B cannot reach account A's run by id", { tag: '@tesbo.testId("TES-TC-1147")' }, async ({ request: api }) => {
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Tenant ${Date.now()}` })).json();
      runIds.push(run.runId);

      // Through B's own project path (B is not a member of A's project at all).
      const viaOwnProject = await asB.get(`${automationBase(ctxB.projectId)}/runs/${run.runId}`, {
        failOnStatusCode: false,
      });
      expect(viaOwnProject.status()).toBe(404);

      // And through A's project path, which B cannot reach either.
      const viaOtherProject = await asB.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`, {
        failOnStatusCode: false,
      });
      expect(REFUSED).toContain(viaOtherProject.status());
    } finally {
      await cleanup(api, runIds, []);
    }
  });
});

test.describe("automation ingest - evidence", () => {
  async function runWithResult(api: APIRequestContext, label: string) {
    const cases = await seedCases(api, 1, label);
    const run = await (
      await createRun(api, {
        name: `E2E Automation ${label} ${Date.now()}`,
        caseIds: [cases[0].externalId],
      })
    ).json();
    await postResult(api, run.runId, { caseId: cases[0].externalId, status: "fail" });
    return { cases, run };
  }

  function evidenceUrl(runId: string, caseId: string) {
    return `${automationBase(ctxA.projectId)}/runs/${runId}/results/${caseId}/evidence`;
  }

  test("AUT-60 a Playwright trace .zip is accepted as trace evidence and downloads back", { tag: '@tesbo.testId("TES-TC-1148")' }, async ({
    request: api,
  }) => {
    /*
     * The one deliberate exception to the evidence allowlist. KB_ALLOWED_EXTENSIONS excludes zip
     * on purpose ("a zip hides anything past an extension check"), and a Playwright trace IS a
     * .zip, so section 5's "supported evidence types: ... Playwright trace files" cannot be met by
     * reusing it. The exception is narrow: zip only under kind 'trace' (AUT-61), never opened
     * server-side, and never served inline (AUT-64).
     */
    const { cases, run } = await runWithResult(api, "trace");
    try {
      const res = await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "trace",
          files: {
            name: "trace.zip",
            mimeType: "application/zip",
            buffer: Buffer.from("PK not-a-real-archive"),
          },
        },
        failOnStatusCode: false,
      });
      expect(res.status(), await res.text()).toBe(201);
      expect((await res.json()).total).toBe(1);

      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      const evidence = detail.results[0].evidence;
      expect(evidence).toHaveLength(1);
      expect(evidence[0].kind).toBe("trace");

      // Listable AND retrievable. Before this card the upload and list endpoints existed with no
      // download route at all, so evidence was stored, billed, and unreachable.
      const executionId = detail.results[0].executionId;
      const download = await api.get(
        `/api/cycles/${run.runId}/executions/${executionId}/attachments/${evidence[0].id}/download`,
        { failOnStatusCode: false },
      );
      expect(download.ok(), `download answered ${download.status()}`).toBeTruthy();
      expect(download.headers()["content-disposition"]).toContain("attachment");
    } finally {
      await cleanup(api, [run.runId], cases.map((c) => c.id));
    }
  });

  test("AUT-61 a .zip is refused as a screenshot, so the trace exception cannot be borrowed", { tag: '@tesbo.testId("TES-TC-1149")' }, async ({
    request: api,
  }) => {
    const { cases, run } = await runWithResult(api, "zip-as-shot");
    try {
      const res = await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "screenshot",
          files: { name: "sneaky.zip", mimeType: "application/zip", buffer: Buffer.from("PK") },
        },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const error = (await res.json()).error as string;
      expect(error).toContain("aren't accepted as screenshot evidence");
      expect(error, "the message must name what IS accepted").toContain("png");
    } finally {
      await cleanup(api, [run.runId], cases.map((c) => c.id));
    }
  });

  test("AUT-62 an unknown kind, a missing file, and an empty file are each refused", { tag: '@tesbo.testId("TES-TC-1150")' }, async ({
    request: api,
  }) => {
    const { cases, run } = await runWithResult(api, "bad-evidence");
    try {
      const badKind = await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "hologram",
          files: { name: "shot.png", mimeType: "image/png", buffer: PNG_1PX },
        },
        failOnStatusCode: false,
      });
      expect(badKind.status()).toBe(400);
      expect((await badKind.json()).error).toContain("kind must be one of");

      const noFiles = await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: { kind: "screenshot" },
        failOnStatusCode: false,
      });
      expect(noFiles.status()).toBe(400);

      // A zero-byte file is a failed drag-and-drop or a still-being-written artifact: it stores
      // nothing useful while consuming a row and a storage key.
      const empty = await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "screenshot",
          files: { name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) },
        },
        failOnStatusCode: false,
      });
      expect(empty.status()).toBe(400);
    } finally {
      await cleanup(api, [run.runId], cases.map((c) => c.id));
    }
  });

  test("AUT-63 evidence for a case with no result in the run is refused", { tag: '@tesbo.testId("TES-TC-1151")' }, async ({ request: api }) => {
    // Post the result before its evidence -- otherwise there is no row to attach it to, and
    // silently creating one would invent a result nobody reported.
    const cases = await seedCases(api, 1, "orphan-evidence");
    const runIds: string[] = [];
    try {
      const run = await (await createRun(api, { name: `E2E Automation Orphan ${Date.now()}` })).json();
      runIds.push(run.runId);
      const res = await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "screenshot",
          files: { name: "shot.png", mimeType: "image/png", buffer: PNG_1PX },
        },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(404);
      expect((await res.json()).error).toContain("Post the result before its evidence");
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-64 an image may render inline; a trace never does", { tag: '@tesbo.testId("TES-TC-1152")' }, async ({ request: api }) => {
    /*
     * A trace .zip and a log are served as downloads whatever the caller asks for, so nothing
     * inside a stored archive is ever interpreted by a browser in Tesbo's own origin.
     */
    const { cases, run } = await runWithResult(api, "inline");
    try {
      await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "screenshot",
          files: { name: "shot.png", mimeType: "image/png", buffer: PNG_1PX },
        },
      });
      await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "trace",
          files: { name: "trace.zip", mimeType: "application/zip", buffer: Buffer.from("PKx") },
        },
      });

      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      const executionId = detail.results[0].executionId;
      const shot = detail.results[0].evidence.find((e: any) => e.kind === "screenshot");
      const trace = detail.results[0].evidence.find((e: any) => e.kind === "trace");

      const inlineShot = await api.get(
        `/api/cycles/${run.runId}/executions/${executionId}/attachments/${shot.id}/download?inline=1`,
      );
      expect(inlineShot.headers()["content-disposition"]).toContain("inline");

      const inlineTrace = await api.get(
        `/api/cycles/${run.runId}/executions/${executionId}/attachments/${trace.id}/download?inline=1`,
      );
      expect(
        inlineTrace.headers()["content-disposition"],
        "a trace must be a download even when inline is requested",
      ).toContain("attachment");
    } finally {
      await cleanup(api, [run.runId], cases.map((c) => c.id));
    }
  });

  test("AUT-65 evidence is not readable by another tenant or an anonymous caller", { tag: '@tesbo.testId("TES-TC-1153")' }, async ({
    request: api,
  }) => {
    // An attachment id turning up in a log line or an export must not be enough to hand over the
    // file -- the same rule bug evidence follows.
    const { cases, run } = await runWithResult(api, "evidence-auth");
    try {
      await api.post(evidenceUrl(run.runId, cases[0].externalId), {
        multipart: {
          kind: "screenshot",
          files: { name: "shot.png", mimeType: "image/png", buffer: PNG_1PX },
        },
      });
      const detail = await (await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`)).json();
      const executionId = detail.results[0].executionId;
      const attachmentId = detail.results[0].evidence[0].id;
      const url = `/api/cycles/${run.runId}/executions/${executionId}/attachments/${attachmentId}/download`;

      for (const [label, ctx] of [["account B", asB], ["anonymous", anon]] as const) {
        const res = await ctx.get(url, { failOnStatusCode: false });
        expect(REFUSED, `${label} answered ${res.status()}`).toContain(res.status());
      }
    } finally {
      await cleanup(api, [run.runId], cases.map((c) => c.id));
    }
  });
});

/*
 * Hard-delete remediation, Phase 1 ("Zyra Workflow Agents/hard-delete-remediation-progress-log.md")
 * folded automation.service.ts's requireRun and attachCases into the same phase as the ordinary
 * cycles/executions read paths, specifically so the CI ingest path would not keep reporting
 * against -- or silently no-op'ing into -- a run a person had just deleted through the product UI.
 * Before migrations/V111_cycles_soft_delete.sql, deleting the underlying cycle (DELETE FROM cycles)
 * made these routes 404 for the mechanical reason that the row was gone; now the row survives
 * soft-deleted, so requireRun was given its own `AND deleted_at IS NULL` and attachCases' insert
 * gained an EXISTS guard on the same predicate.
 *
 * Follow-up, migrations/V112_cycles_external_id_partial_index.sql: Phase 1 left createRun's
 * externalId-reuse lookups (and idx_cycles_project_external_id itself) unfiltered on deleted_at,
 * so a CI shard resubmitting the same externalId after the run was deleted resolved back to the
 * dead row and got a "reused" response it could never actually attach a case to (casesAttached
 * always 0) -- a working run for that externalId became permanently unobtainable. V112 makes the
 * index partial on deleted_at IS NULL too, and the reuse lookups (and runSummary) now filter it,
 * so the same resubmit opens a genuine new run instead. AUT-71 below was updated to pin this new
 * behaviour rather than the old "still 0" one.
 */
test.describe("automation ingest - soft-deleted run (hard-delete remediation Phase 1)", () => {
  test("AUT-70 get/results/close on a soft-deleted run's automation surface are all 404, not a stale success", async ({
    request: api,
  }) => {
    const cases = await seedCases(api, 1, "soft-deleted");
    const runIds: string[] = [];
    try {
      const run = await (
        await createRun(api, { name: `E2E Automation SoftDel ${Date.now()}`, caseIds: [cases[0].externalId] })
      ).json();
      runIds.push(run.runId);

      // Deleted the ordinary way -- the product's own DELETE /api/cycles/:id, not a raw SQL fixture.
      const deleteRes = await api.delete(`/api/cycles/${run.runId}`, { failOnStatusCode: false });
      expect(deleteRes.ok(), `deleting the run — ${await deleteRes.text()}`).toBeTruthy();
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM cycles WHERE id = ${literal(run.runId)};`)).toBe("t");

      const getRes = await api.get(`${automationBase(ctxA.projectId)}/runs/${run.runId}`, { failOnStatusCode: false });
      expect(getRes.status(), "a soft-deleted run must not still be readable through the automation surface").toBe(404);

      const postedRes = await postResult(api, run.runId, { caseId: cases[0].externalId, status: "pass" });
      expect(postedRes.status(), "a CI shard reporting against a deleted run must be refused, not silently recorded").toBe(404);

      const closeRes = await api.patch(`${automationBase(ctxA.projectId)}/runs/${run.runId}/close`, {
        data: { status: "completed" },
        failOnStatusCode: false,
      });
      expect(closeRes.status()).toBe(404);

      // And nothing was written by the refused result post.
      expect(
        scalar(`SELECT COUNT(*) FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id
                 WHERE ci.cycle_id = ${literal(run.runId)} AND e.status = 'Passed';`),
      ).toBe("0");
    } finally {
      await cleanup(api, runIds, cases.map((c) => c.id));
    }
  });

  test("AUT-71 resubmitting a soft-deleted run's externalId opens a genuine new run and attaches cases to it, leaving the dead run's history untouched", async ({
    request: api,
  }) => {
    /*
     * Used to pin the opposite: that createRun's externalId-reuse lookup resolving back to a
     * soft-deleted row was harmless because attachCases' EXISTS guard blocked the write, leaving
     * casesAttached stuck at 0 forever for that externalId. That was a real gap, not a safe
     * fallback -- a CI shard had no way to ever get a *working* run for that externalId again.
     * migrations/V112_cycles_external_id_partial_index.sql plus the matching `AND deleted_at IS
     * NULL` on both createRun lookup sites close it: idx_cycles_project_external_id no longer
     * counts a soft-deleted row, so a resubmit after the delete inserts a fresh cycle instead of
     * colliding with (or resolving back to) the dead one. This test now proves the full round
     * trip that replaces the old pin: create -> delete -> resubmit same externalId -> a genuinely
     * new run -> attachCases succeeds against it -> the old dead run's own history is untouched.
     */
    const externalId = `e2e-softdel-reuse-${Date.now()}`;
    const casesA = await seedCases(api, 1, "reuse-a");
    const casesB = await seedCases(api, 1, "reuse-b");
    const runIds: string[] = [];
    try {
      const first = await createRun(api, {
        name: `E2E Automation Reuse A ${Date.now()}`,
        externalId,
        caseIds: [casesA[0].externalId],
      });
      expect(first.status(), await first.text()).toBe(201);
      const runA = await first.json();
      runIds.push(runA.runId);
      expect(runA.casesAttached).toBe(1);

      const deleteRes = await api.delete(`/api/cycles/${runA.runId}`, { failOnStatusCode: false });
      expect(deleteRes.ok()).toBeTruthy();
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM cycles WHERE id = ${literal(runA.runId)};`)).toBe("t");

      // A second shard reports the same externalId after the run was deleted. The reuse lookup no
      // longer resolves back to the dead row -- it filters deleted_at itself now -- so this falls
      // through to a fresh INSERT, which the now-partial unique index lets succeed.
      const second = await createRun(api, {
        name: `E2E Automation Reuse B ${Date.now()}`,
        externalId,
        caseIds: [casesB[0].externalId],
      });
      expect(second.status(), await second.text()).toBe(201);
      const runB = await second.json();
      runIds.push(runB.runId);

      expect(runB.runId, "resubmitting a deleted run's externalId must open a new runId, not the dead one").not.toBe(
        runA.runId,
      );
      expect(runB.reused, "this is a fresh create, not a reuse of an existing live run").toBe(false);
      expect(runB.externalId).toBe(externalId);
      expect(
        runB.casesAttached,
        "attachCases must succeed against the new run, not report 0 the way it did against the dead one",
      ).toBe(1);

      // The new run's case really landed in cycle_items, not just in the response body.
      expect(
        scalar(
          `SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(runB.runId)} AND testcase_id = ${literal(casesB[0].id)} AND deleted_at IS NULL;`,
        ),
      ).toBe("1");

      // The old dead run's own history is untouched: its cycle_item for casesA still exists,
      // still carries its own cycle_id, is still soft-deleted (cascaded by the delete above, not
      // by this resubmit), and never gained casesB's row.
      expect(
        scalar(
          `SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(runA.runId)} AND testcase_id = ${literal(casesA[0].id)} AND deleted_at IS NOT NULL;`,
        ),
        "the original run's cycle_item survives, soft-deleted, as history",
      ).toBe("1");
      expect(
        scalar(
          `SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(runA.runId)} AND testcase_id = ${literal(casesB[0].id)};`,
        ),
        "the new case must not have been attached to the soft-deleted run",
      ).toBe("0");
    } finally {
      await cleanup(api, runIds, [...casesA, ...casesB].map((c) => c.id));
    }
  });

  test("AUT-72 create -> delete cycle -> resubmit externalId -> new run -> attach succeeds: full round trip, direct DB proof at every step", async ({
    request: api,
  }) => {
    /*
     * AUT-71 above already exercises this round trip through the API and pins the same outcomes.
     * This test is the direct-DB-proof companion Yuvraj asked for as a belt-and-suspenders
     * regression: rather than reading the round trip back through createRun's own JSON response
     * (which is exactly the code under test), it re-derives every fact independently from
     * `cycles`/`cycle_items`/`executions`, so a bug that happened to make the response body lie
     * (e.g. a stale in-memory object returned instead of what was actually written) would still be
     * caught here.
     */
    const externalId = `e2e-softdel-roundtrip-${Date.now()}`;
    const casesA = await seedCases(api, 1, "roundtrip-a");
    const casesB = await seedCases(api, 1, "roundtrip-b");
    const runIds: string[] = [];
    try {
      // 1. Create run A with externalId, case A attached.
      const created = await createRun(api, {
        name: `E2E Automation Roundtrip A ${Date.now()}`,
        externalId,
        caseIds: [casesA[0].externalId],
      });
      expect(created.status(), await created.text()).toBe(201);
      const runA = await created.json();
      runIds.push(runA.runId);
      expect(
        scalar(`SELECT COUNT(*) FROM cycles WHERE id = ${literal(runA.runId)} AND external_id = ${literal(externalId)} AND deleted_at IS NULL;`),
      ).toBe("1");

      // 2. Delete its cycle through the ordinary product route.
      const deleteRes = await api.delete(`/api/cycles/${runA.runId}`, { failOnStatusCode: false });
      expect(deleteRes.ok(), `deleting run A — ${await deleteRes.text()}`).toBeTruthy();
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM cycles WHERE id = ${literal(runA.runId)};`)).toBe("t");

      // 3. Resubmit the same externalId.
      const resubmitted = await createRun(api, {
        name: `E2E Automation Roundtrip B ${Date.now()}`,
        externalId,
        caseIds: [casesB[0].externalId],
      });
      expect(resubmitted.status(), await resubmitted.text()).toBe(201);
      const runB = await resubmitted.json();
      runIds.push(runB.runId);

      // 4. A new run really was created: a distinct row, live, sharing the externalId with the
      // now-dead run A -- which is only possible because the unique index is partial on
      // deleted_at IS NULL (V112). Before that migration this INSERT would have violated it.
      expect(runB.runId).not.toBe(runA.runId);
      expect(
        scalar(`SELECT COUNT(*) FROM cycles WHERE id = ${literal(runB.runId)} AND external_id = ${literal(externalId)} AND deleted_at IS NULL;`),
      ).toBe("1");
      expect(
        scalar(`SELECT COUNT(*) FROM cycles WHERE project_id = ${literal(ctxA.projectId)} AND external_id = ${literal(externalId)};`),
        "both the dead run and the new one carry the same externalId -- exactly what the partial index now allows",
      ).toBe("2");

      // 5. attach succeeds against the new run: case B is really in cycle_items/executions under
      // runB, live.
      expect(
        scalar(
          `SELECT COUNT(*) FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
           WHERE ci.cycle_id = ${literal(runB.runId)} AND ci.testcase_id = ${literal(casesB[0].id)}
             AND ci.deleted_at IS NULL AND e.deleted_at IS NULL;`,
        ),
        "case B must be attached to the new run with a live execution opened for it",
      ).toBe("1");

      // 6. The old dead run's data is untouched: case A's cycle_item still belongs to run A only,
      // soft-deleted alongside its parent, never moved and never joined by case B.
      expect(
        scalar(
          `SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(runA.runId)} AND testcase_id = ${literal(casesA[0].id)} AND deleted_at IS NOT NULL;`,
        ),
      ).toBe("1");
      expect(
        scalar(`SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(runA.runId)};`),
        "run A's cycle_items are exactly what it started with -- nothing added by the resubmit",
      ).toBe("1");
    } finally {
      await cleanup(api, runIds, [...casesA, ...casesB].map((c) => c.id));
    }
  });
});
