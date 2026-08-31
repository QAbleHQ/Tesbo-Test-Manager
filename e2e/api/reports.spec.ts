import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { setGraceWindow, setProPlan } from "../utils/billing-db";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  setProjectRole,
  type RbacTenant,
} from "../utils/rbac-tenant";
import {
  addRunCases,
  listRunExecutions,
  purgeProject,
  seedBug,
  seedPlan,
  seedProject,
  seedRun,
  seedSuite,
  seedTestCase,
  setExecutionResults,
  softDeleteExecution,
  type SeededCase,
  type SeededRun,
} from "../utils/seed";

/*
 * Wave 6 — reports, analytics and the aggregate endpoints behind the Reports & Insights screen.
 *
 * Why this file owns a whole project of its own rather than using account A's smoke project: every
 * assertion here is a project-wide AGGREGATE. "18 passed executions", "6 test cases", "11 runs",
 * "2 flaky tests" are only stable if nothing else is writing to the project while the file runs —
 * and api/testcases.spec.ts, api/cycles.spec.ts and api/executions.spec.ts all create and delete
 * fixtures in account A's project concurrently, across workers. So the fixture below is built in a
 * disposable project inside the "reports" tenant, and purged at the end.
 *
 * Why the timestamps are written directly (utils/seed.ts): these endpoints are almost entirely
 * questions about time — the last 10 runs, the last 12 runs, 30 days of additions, 7 weeks of bug
 * discovery, "since Monday". The API stamps everything now(), so a fixture that only used the API
 * would collapse every window into a single point and could not tell a correct implementation from
 * one that ignores dates altogether.
 */

const ACCOUNT_A = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

/** Every project-scoped report path, for the authorization sweeps. */
function reportPaths(projectId: string): string[] {
  return [
    `/api/projects/${projectId}/analytics`,
    `/api/projects/${projectId}/reports/execution`,
    `/api/projects/${projectId}/reports/requirement-matrix`,
    `/api/projects/${projectId}/reports/repository-summary`,
    `/api/projects/${projectId}/reports/overview`,
    `/api/projects/${projectId}/reports/insights`,
    `/api/projects/${projectId}/reports/trends`,
    // The export is a report read like any other, so it belongs in every sweep below — including
    // RPT-A-54, which is the promise that a downgraded workspace can still get its data out.
    `/api/projects/${projectId}/reports/export/csv?view=overview`,
    `/api/projects/${projectId}/reports/export/xlsx?view=execution`,
  ];
}

/*
 * The seeded history, chosen so that every branch of the reporting code is reachable and every
 * number below is arithmetic rather than a guess:
 *
 *   suites      Alpha (4 cases), Beta (1 case), plus one case with no suite at all
 *   cases       flaky P2 [smoke,regression], stable P1 [smoke], lowFlake P2 (untagged),
 *               untestedP1 P1 (never run — the untested-P1 counter), noSuite P3 [api],
 *               old P2 (created 40 days ago — outside the 30-day addition window)
 *   runs        11, two days apart, oldest 22 days ago — straddles overview's 10-run cap and
 *               trends' 12-run cap, so the two endpoints must disagree about the trend delta
 *   results     flaky alternates P/F across all 11 runs   -> 10 flips, flakiness "High"
 *               stable passes in runs 1-6                 -> not flaky (one distinct status)
 *               lowFlake passes 5 then fails once         -> 1 flip in 6 runs, flakiness "Low"
 *               old is added to run 1 and left Untested   -> the Untested branch
 *   coverage    Alpha 3/4 = 75% (fine), Beta 0/1 = 0% (the one coverage gap), Unassigned 1/1
 *   bugs        one this week, one ~2 weeks back, one 80 days back (outside the 7-week series)
 */
const RUN_AGES_IN_DAYS = [22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2];

interface ReportsFixture {
  projectId: string;
  alphaSuiteId: string;
  betaSuiteId: string;
  planId: string;
  cases: {
    flaky: SeededCase;
    stable: SeededCase;
    lowFlake: SeededCase;
    untestedP1: SeededCase;
    noSuite: SeededCase;
    old: SeededCase;
  };
  runs: SeededRun[];
  /** run name -> the fixture's own view of what that run contains, for cross-checking. */
  expectedRunTotals: Map<string, number>;
  bugTitles: { thisWeek: string; twoWeeksAgo: string; longAgo: string };
}

let tenant: RbacTenant | null = null;
let skipReason: string | null = null;
let asOwner: APIRequestContext;
let asGuest: APIRequestContext;
let asQa: APIRequestContext;
let anon: APIRequestContext;
let fixture: ReportsFixture;

async function buildFixture(api: APIRequestContext, projectId: string): Promise<ReportsFixture> {
  const alphaSuiteId = await seedSuite(api, projectId, "Alpha");
  const betaSuiteId = await seedSuite(api, projectId, "Beta");
  const planId = await seedPlan(api, projectId, "E2E Reports Regression Plan");

  const cases = {
    flaky: await seedTestCase(api, projectId, {
      title: "Checkout flickers between runs",
      suiteId: alphaSuiteId,
      priority: "P2",
      status: "Approved",
      automationTags: "smoke,regression",
    }),
    stable: await seedTestCase(api, projectId, {
      title: "Login always works",
      suiteId: alphaSuiteId,
      priority: "P1",
      status: "Approved",
      automationTags: "smoke",
    }),
    lowFlake: await seedTestCase(api, projectId, {
      title: "Search fails once in six runs",
      suiteId: alphaSuiteId,
      priority: "P2",
      status: "Draft",
    }),
    untestedP1: await seedTestCase(api, projectId, {
      title: "Payment refund has never been run",
      suiteId: betaSuiteId,
      priority: "P1",
      status: "Approved",
    }),
    noSuite: await seedTestCase(api, projectId, {
      title: "Health endpoint responds",
      priority: "P3",
      status: "Approved",
      automationTags: "api",
    }),
    old: await seedTestCase(api, projectId, {
      title: "Legacy case authored six weeks ago",
      suiteId: alphaSuiteId,
      priority: "P2",
      status: "Deprecated",
      createdDaysAgo: 40,
    }),
  };

  const runs: SeededRun[] = [];
  for (let i = 0; i < RUN_AGES_IN_DAYS.length; i++) {
    runs.push(
      await seedRun(api, projectId, {
        // The first run carries the plan so filterBy=plan has both a named group and a "No Plan" one.
        name: `E2E Reports Run ${i + 1}`,
        planId: i === 0 ? planId : undefined,
        createdDaysAgo: RUN_AGES_IN_DAYS[i],
      }),
    );
  }

  const expectedRunTotals = new Map<string, number>();
  const results: { executionId: string; status: string; executedDaysAgo: number; assigneeId?: string | null }[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const caseIds = [cases.flaky.id];
    if (i < 6) caseIds.push(cases.stable.id, cases.lowFlake.id);
    if (i === 0) caseIds.push(cases.old.id);
    if (i === runs.length - 1) caseIds.push(cases.noSuite.id);
    await addRunCases(api, run.id, caseIds);
    expectedRunTotals.set(run.name, caseIds.length);

    const executions = await listRunExecutions(api, run.id);
    const executedDaysAgo = RUN_AGES_IN_DAYS[i];
    for (const execution of executions) {
      if (execution.testcaseId === cases.flaky.id) {
        results.push({ executionId: execution.id, status: i % 2 === 0 ? "Passed" : "Failed", executedDaysAgo });
      } else if (execution.testcaseId === cases.stable.id) {
        // Only this one carries an assignee, so filterBy=person yields a named group next to
        // "Unassigned" rather than one bucket holding everything.
        results.push({
          executionId: execution.id,
          status: "Passed",
          executedDaysAgo,
          assigneeId: tenant!.manager.userId,
        });
      } else if (execution.testcaseId === cases.lowFlake.id) {
        results.push({ executionId: execution.id, status: i === 5 ? "Failed" : "Passed", executedDaysAgo });
      } else if (execution.testcaseId === cases.noSuite.id) {
        results.push({ executionId: execution.id, status: "Passed", executedDaysAgo });
      }
      // cases.old is deliberately left at its auto-created Untested.
    }
  }
  setExecutionResults(results);

  const failedFlakyRun = runs[5];
  const failedFlakyExecutions = await listRunExecutions(api, failedFlakyRun.id);
  const failedFlakyExecution = failedFlakyExecutions.find((e) => e.testcaseId === cases.flaky.id)!;

  const bugTitles = {
    thisWeek: `E2E Reports Bug this week ${Date.now()}`,
    twoWeeksAgo: `E2E Reports Bug two weeks ago ${Date.now()}`,
    longAgo: `E2E Reports Bug long ago ${Date.now()}`,
  };
  await seedBug(api, projectId, {
    title: bugTitles.thisWeek,
    severity: "Critical",
    externalUrl: "https://example.invalid/bugs/E2E-1",
    links: [{ executionId: failedFlakyExecution.id, testcaseId: cases.flaky.id, cycleId: failedFlakyRun.id }],
    createdDaysAgo: 1,
  });
  await seedBug(api, projectId, { title: bugTitles.twoWeeksAgo, severity: "High", createdDaysAgo: 15 });
  await seedBug(api, projectId, { title: bugTitles.longAgo, severity: "Low", status: "Closed", createdDaysAgo: 80 });

  return { projectId, alphaSuiteId, betaSuiteId, planId, cases, runs, expectedRunTotals, bugTitles };
}

test.beforeAll(async () => {
  // Building eleven runs, twenty-five executions and three bugs through the real API takes well
  // past the 30s per-test default, and a hook that times out reports as an infrastructure failure
  // in every test in the file rather than as one slow setup.
  test.setTimeout(300_000);
  tenant = await provisionRbacTenant("reports");
  skipReason = rbacSuiteSkipReason(tenant);
  if (!tenant) return;

  asOwner = await loginAs(tenant.owner);
  asGuest = await loginAs(tenant.guest);
  asQa = await loginAs(tenant.qa);
  anon = await anonymousContext();

  const projectId = await seedProject(asOwner, `E2E ${Date.now()} Reports Fixture`);
  // The QA engineer is a legitimate member of the fixture project, so the role axis can assert both
  // directions: a project member may read reports, a workspace member without access may not.
  setProjectRole(projectId, tenant.qa.userId, "qa_engineer");
  fixture = await buildFixture(asOwner, projectId);
});

test.afterAll(async () => {
  if (fixture?.projectId) purgeProject(fixture.projectId);
  await Promise.all([asOwner, asGuest, asQa, anon].filter(Boolean).map((ctx) => ctx.dispose()));
});

test.beforeEach(() => {
  test.skip(Boolean(skipReason), skipReason ?? "");
});

/** An empty project, for the "no history at all" branch of every endpoint. Purged by the caller. */
async function withEmptyProject(fn: (projectId: string) => Promise<void>): Promise<void> {
  const projectId = await seedProject(asOwner, `E2E ${Date.now()} Reports Empty`);
  try {
    await fn(projectId);
  } finally {
    purgeProject(projectId);
  }
}

async function getJson(api: APIRequestContext, url: string): Promise<any> {
  const res = await api.get(url);
  expect(res.ok(), `${url} should answer 2xx, got ${res.status()}`).toBeTruthy();
  return await res.json();
}

test.describe("project analytics counters", () => {
  test("RPT-A-01 counts the project's cases, suites, plans, runs and execution statuses", { tag: '@tesbo.testId("TES-TC-461")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/analytics`);
    expect(body.projectCount).toBe(1);
    expect(body.testCaseCount).toBe(6);
    expect(body.suiteCount).toBe(2);
    expect(body.planCount).toBe(1);
    expect(body.cycleCount).toBe(11);
    // 25 cycle items: flaky in all 11 runs, stable and lowFlake in 6 each, old and noSuite in one.
    expect(body.executionTotal).toBe(25);
    expect(body.executionStatus).toEqual({ Passed: 18, Failed: 6, Untested: 1 });
  });

  test("RPT-A-02 a soft-deleted test case leaves the counters, and a soft-deleted execution leaves the status map", { tag: '@tesbo.testId("TES-TC-462")' }, async () => {
    const before = await getJson(asOwner, `/api/projects/${fixture.projectId}/analytics`);

    const throwaway = await seedTestCase(asOwner, fixture.projectId, { title: "E2E Reports soon-deleted case" });
    const run = await seedRun(asOwner, fixture.projectId, { name: `E2E Reports Delete Run ${Date.now()}` });
    await addRunCases(asOwner, run.id, [throwaway.id]);
    const [execution] = await listRunExecutions(asOwner, run.id);
    setExecutionResults([{ executionId: execution.id, status: "Passed" }]);

    try {
      const withExtras = await getJson(asOwner, `/api/projects/${fixture.projectId}/analytics`);
      expect(withExtras.testCaseCount).toBe(before.testCaseCount + 1);
      expect(withExtras.executionStatus.Passed).toBe(before.executionStatus.Passed + 1);

      // testcases_active / executions_active are the soft-delete-aware views these counters read.
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${throwaway.id}`);
      softDeleteExecution(execution.id);

      const after = await getJson(asOwner, `/api/projects/${fixture.projectId}/analytics`);
      expect(after.testCaseCount).toBe(before.testCaseCount);
      expect(after.executionStatus.Passed).toBe(before.executionStatus.Passed);
      expect(after.executionTotal).toBe(before.executionTotal);
    } finally {
      await asOwner.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${throwaway.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("RPT-A-03 an empty project reports zeros rather than nulls or an error", { tag: '@tesbo.testId("TES-TC-463")' }, async () => {
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/analytics`);
      expect(body).toEqual({
        projectCount: 1,
        testCaseCount: 0,
        suiteCount: 0,
        planCount: 0,
        cycleCount: 0,
        executionStatus: {},
        executionTotal: 0,
      });
    });
  });
});

test.describe("execution report grouping", () => {
  test("RPT-A-04 the default grouping is one row per run, and the counters add up to the run's items", { tag: '@tesbo.testId("TES-TC-464")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
    expect(body.filterBy).toBe("overall");
    expect(body.filterValue).toBeNull();
    expect(body.rows).toHaveLength(11);

    for (const row of body.rows) {
      const expected = fixture.expectedRunTotals.get(row.groupName);
      expect(expected, `unexpected group "${row.groupName}"`).toBeDefined();
      expect(row.total).toBe(expected);
      const summed = ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"].reduce(
        (sum, key) => sum + Number(row[key] || 0),
        0,
      );
      expect(summed, `status counters for ${row.groupName} must add up to its total`).toBe(row.total);
    }

    const totals = body.rows.reduce((sum: number, row: any) => sum + row.total, 0);
    expect(totals).toBe(25);
  });

  test("RPT-A-05 rows come back busiest first", { tag: '@tesbo.testId("TES-TC-465")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
    const totals = body.rows.map((r: any) => r.total);
    expect(totals).toEqual([...totals].sort((a: number, b: number) => b - a));
  });

  test("RPT-A-06 grouping by run is the same report as the default", { tag: '@tesbo.testId("TES-TC-466")' }, async () => {
    const overall = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
    const byRun = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution?filterBy=run`);
    expect(byRun.rows).toEqual(overall.rows);
  });

  test("RPT-A-07 grouping by person names the assignee and buckets the rest as Unassigned", { tag: '@tesbo.testId("TES-TC-467")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution?filterBy=person`);
    const names = body.rows.map((r: any) => r.groupName);
    expect(names).toContain("Unassigned");

    const assigned = body.rows.find((r: any) => r.groupId === tenant!.manager.userId);
    expect(assigned, "the assignee should have a group of their own").toBeTruthy();
    // stable is assigned in all six runs it appears in, and passes every time.
    expect(assigned.total).toBe(6);
    expect(assigned.Passed).toBe(6);

    const unassigned = body.rows.find((r: any) => r.groupId === "unassigned");
    expect(unassigned.total).toBe(25 - 6);
  });

  test("RPT-A-08 filtering by person narrows the report to that person's executions", { tag: '@tesbo.testId("TES-TC-468")' }, async () => {
    const body = await getJson(
      asOwner,
      `/api/projects/${fixture.projectId}/reports/execution?filterBy=person&filterValue=${tenant!.manager.userId}`,
    );
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].groupId).toBe(tenant!.manager.userId);
    expect(body.rows[0].total).toBe(6);
  });

  test("RPT-A-09 grouping by plan separates the planned run from the unplanned ones", { tag: '@tesbo.testId("TES-TC-469")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution?filterBy=plan`);
    const planned = body.rows.find((r: any) => r.groupId === fixture.planId);
    const unplanned = body.rows.find((r: any) => r.groupId === "none");
    expect(planned.groupName).toBe("E2E Reports Regression Plan");
    expect(planned.total).toBe(4); // run 1 holds flaky, stable, lowFlake and old
    expect(unplanned.groupName).toBe("No Plan");
    expect(unplanned.total).toBe(21);
  });

  test("RPT-A-10 grouping by suite covers the suiteless cases under No Suite", { tag: '@tesbo.testId("TES-TC-470")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution?filterBy=suite`);
    const alpha = body.rows.find((r: any) => r.groupId === fixture.alphaSuiteId);
    const noSuite = body.rows.find((r: any) => r.groupId === "none");
    expect(alpha.groupName).toBe("Alpha");
    expect(alpha.total).toBe(24); // flaky 11 + stable 6 + lowFlake 6 + old 1
    expect(noSuite.groupName).toBe("No Suite");
    expect(noSuite.total).toBe(1);
    // Beta's only case has never been added to a run, so the suite has no executions to report.
    expect(body.rows.some((r: any) => r.groupId === fixture.betaSuiteId)).toBeFalsy();
  });

  test("RPT-A-11 grouping by priority reports each priority band separately", { tag: '@tesbo.testId("TES-TC-471")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution?filterBy=priority`);
    const byName = new Map(body.rows.map((r: any) => [r.groupName, r]));
    expect((byName.get("P1") as any).total).toBe(6); // stable
    expect((byName.get("P2") as any).total).toBe(18); // flaky 11 + lowFlake 6 + old 1
    expect((byName.get("P3") as any).total).toBe(1); // noSuite
    for (const row of body.rows) expect(row.groupId).toBe(row.groupName);
  });

  test("RPT-A-12 grouping by tags counts a multi-tagged case under each tag and untagged ones under Untagged", { tag: '@tesbo.testId("TES-TC-472")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution?filterBy=tags`);
    const byName = new Map(body.rows.map((r: any) => [r.groupName, r]));
    expect((byName.get("smoke") as any).total).toBe(17); // flaky 11 + stable 6
    expect((byName.get("regression") as any).total).toBe(11); // flaky only
    expect((byName.get("api") as any).total).toBe(1); // noSuite
    expect((byName.get("Untagged") as any).total).toBe(7); // lowFlake 6 + old 1
  });

  test("RPT-A-13 filtering by one tag still reports the other tags carried by the matching cases", { tag: '@tesbo.testId("TES-TC-473")' }, async () => {
    // Documented, not weakened: a row that matches the tag filter is then added to a group for EVERY
    // tag it carries, so filtering by "regression" also produces a "smoke" group. Pinned so the
    // behaviour can't drift silently — see the finding in docs/e2e-coverage-waves.md.
    const body = await getJson(
      asOwner,
      `/api/projects/${fixture.projectId}/reports/execution?filterBy=tags&filterValue=regression`,
    );
    const byName = new Map(body.rows.map((r: any) => [r.groupName, r]));
    expect((byName.get("regression") as any).total).toBe(11);
    expect((byName.get("smoke") as any).total).toBe(11);
    expect(byName.has("api")).toBeFalsy();
    expect(byName.has("Untagged")).toBeFalsy();
  });

  test("RPT-A-14 a filterValue is ignored when the grouping is overall", { tag: '@tesbo.testId("TES-TC-474")' }, async () => {
    const unfiltered = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
    const withValue = await getJson(
      asOwner,
      `/api/projects/${fixture.projectId}/reports/execution?filterValue=${fixture.planId}`,
    );
    expect(withValue.filterValue).toBe(fixture.planId);
    expect(withValue.rows).toEqual(unfiltered.rows);
  });

  test("RPT-A-15 a filterValue that matches nothing returns an empty report, not an error", { tag: '@tesbo.testId("TES-TC-475")' }, async () => {
    const body = await getJson(
      asOwner,
      `/api/projects/${fixture.projectId}/reports/execution?filterBy=suite&filterValue=00000000-0000-0000-0000-000000000000`,
    );
    expect(body.rows).toEqual([]);
  });

  test("RPT-A-16 an unknown grouping falls back to per-run rows instead of failing", { tag: '@tesbo.testId("TES-TC-476")' }, async () => {
    const res = await asOwner.get(
      `/api/projects/${fixture.projectId}/reports/execution?filterBy=unicorn&filterValue=whatever`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.filterBy).toBe("unicorn");
    expect(body.rows).toHaveLength(11);
  });

  test("RPT-A-17 a status outside the six reported buckets is counted as Untested", { tag: '@tesbo.testId("TES-TC-477")' }, async () => {
    const run = await seedRun(asOwner, fixture.projectId, { name: `E2E Reports Odd Status Run ${Date.now()}` });
    const throwaway = await seedTestCase(asOwner, fixture.projectId, { title: "E2E Reports odd-status case" });
    try {
      await addRunCases(asOwner, run.id, [throwaway.id]);
      const [execution] = await listRunExecutions(asOwner, run.id);
      // The column takes any short string; normalising unknown values is the report's job.
      setExecutionResults([{ executionId: execution.id, status: "Inconclusive" }]);

      const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
      const row = body.rows.find((r: any) => r.groupName === run.name);
      expect(row.total).toBe(1);
      expect(row.Untested).toBe(1);
      expect(row.Passed).toBe(0);
    } finally {
      await asOwner.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${throwaway.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("RPT-A-18 an empty project reports no rows", { tag: '@tesbo.testId("TES-TC-478")' }, async () => {
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/reports/execution`);
      expect(body).toEqual({ filterBy: "overall", filterValue: null, rows: [] });
    });
  });
});

test.describe("traceability matrix", () => {
  test("RPT-A-19 every live test case appears, once per run it belongs to", { tag: '@tesbo.testId("TES-TC-479")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/requirement-matrix`);
    const rowsFor = (testcaseId: string) => body.rows.filter((r: any) => r.testcaseId === testcaseId);

    expect(rowsFor(fixture.cases.flaky.id)).toHaveLength(11);
    expect(rowsFor(fixture.cases.stable.id)).toHaveLength(6);
    // Never added to a run: still present, with the run and execution columns empty.
    const untested = rowsFor(fixture.cases.untestedP1.id);
    expect(untested).toHaveLength(1);
    expect(untested[0].runId).toBeNull();
    expect(untested[0].executionStatus).toBeNull();
    expect(untested[0].suiteName).toBe("Beta");
  });

  test("RPT-A-20 the payload is camelCased and carries the linked bug", { tag: '@tesbo.testId("TES-TC-480")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/requirement-matrix`);
    const withBug = body.rows.find((r: any) => r.bugTitle === fixture.bugTitles.thisWeek);
    expect(withBug, "the bug linked to a failed execution should surface in the matrix").toBeTruthy();
    expect(withBug.bugUrl).toBe("https://example.invalid/bugs/E2E-1");
    expect(withBug.bugStatus).toBe("Open");
    expect(withBug.testcaseId).toBe(fixture.cases.flaky.id);
    expect(withBug.executionStatus).toBe("Failed");
    expect(withBug.executedAt).toBeTruthy();
    expect(withBug.testcaseTitle).toBe(fixture.cases.flaky.title);
    expect(withBug.externalId).toBe(fixture.cases.flaky.externalId);
    // snake_case would mean the frontend's RequirementMatrixRow silently reads undefined everywhere.
    expect(Object.keys(withBug).some((k) => k.includes("_"))).toBeFalsy();
  });

  test("RPT-A-21 rows are ordered by test case id", { tag: '@tesbo.testId("TES-TC-481")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/requirement-matrix`);
    const externalIds = body.rows.map((r: any) => r.externalId);
    expect(externalIds).toEqual([...externalIds].sort());
  });

  test("RPT-A-22 a soft-deleted case leaves the matrix, and a soft-deleted execution empties its result", { tag: '@tesbo.testId("TES-TC-482")' }, async () => {
    const throwaway = await seedTestCase(asOwner, fixture.projectId, {
      title: "E2E Reports matrix soft-delete case",
    });
    const run = await seedRun(asOwner, fixture.projectId, { name: `E2E Reports Matrix Run ${Date.now()}` });
    try {
      await addRunCases(asOwner, run.id, [throwaway.id]);
      const [execution] = await listRunExecutions(asOwner, run.id);
      setExecutionResults([{ executionId: execution.id, status: "Blocked" }]);

      const withResult = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/requirement-matrix`);
      const row = withResult.rows.find((r: any) => r.testcaseId === throwaway.id);
      expect(row.executionStatus).toBe("Blocked");

      softDeleteExecution(execution.id);
      const afterExecutionDelete = await getJson(
        asOwner,
        `/api/projects/${fixture.projectId}/reports/requirement-matrix`,
      );
      const afterRow = afterExecutionDelete.rows.find((r: any) => r.testcaseId === throwaway.id);
      expect(afterRow, "the case itself must still be listed").toBeTruthy();
      expect(afterRow.executionStatus).toBeNull();

      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${throwaway.id}`);
      const afterCaseDelete = await getJson(
        asOwner,
        `/api/projects/${fixture.projectId}/reports/requirement-matrix`,
      );
      expect(afterCaseDelete.rows.some((r: any) => r.testcaseId === throwaway.id)).toBeFalsy();
    } finally {
      await asOwner.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${throwaway.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("RPT-A-23 an empty project returns no rows", { tag: '@tesbo.testId("TES-TC-483")' }, async () => {
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/reports/requirement-matrix`);
      expect(body).toEqual({ rows: [] });
    });
  });
});

test.describe("repository summary", () => {
  test("RPT-A-24 totals, suites, statuses and priorities describe the live test cases", { tag: '@tesbo.testId("TES-TC-484")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/repository-summary`);
    expect(body.totalTestCases).toBe(6);

    const bySuite = new Map(body.bySuite.map((s: any) => [s.name, s.count]));
    expect(bySuite.get("Alpha")).toBe(4);
    expect(bySuite.get("Beta")).toBe(1);
    expect(bySuite.get("Unassigned")).toBe(1);

    // groupTestcases() has no ORDER BY, so these are asserted as sets rather than sequences.
    const byStatus = new Map(body.byStatus.map((s: any) => [s.name, s.count]));
    // flaky, stable, untestedP1 and noSuite are Approved; lowFlake is Draft; old is Deprecated.
    expect(byStatus.get("Approved")).toBe(4);
    expect(byStatus.get("Draft")).toBe(1);
    expect(byStatus.get("Deprecated")).toBe(1);

    const byPriority = new Map(body.byPriority.map((p: any) => [p.name, p.count]));
    expect(byPriority.get("P1")).toBe(2);
    expect(byPriority.get("P2")).toBe(3);
    expect(byPriority.get("P3")).toBe(1);
  });

  test("RPT-A-25 the additions series is exactly 30 ascending daily buckets ending today", { tag: '@tesbo.testId("TES-TC-485")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/repository-summary`);
    expect(body.addedByDate).toHaveLength(30);

    const dates = body.addedByDate.map((d: any) => d.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(30);
    expect(dates[29]).toBe(new Date().toISOString().slice(0, 10));

    // Five of the six cases were created just now; the sixth was backdated 40 days and so falls
    // outside the window while still counting toward totalTestCases.
    const windowTotal = body.addedByDate.reduce((sum: number, d: any) => sum + d.count, 0);
    expect(windowTotal).toBe(5);
    expect(body.totalTestCases).toBe(6);
  });

  test("RPT-A-26 the updated-recently counters follow updated_at, not created_at", { tag: '@tesbo.testId("TES-TC-486")' }, async () => {
    const before = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/repository-summary`);

    const staleCase = await seedTestCase(asOwner, fixture.projectId, {
      title: "E2E Reports untouched for 40 days",
      createdDaysAgo: 40,
      updatedDaysAgo: 40,
    });
    const freshCase = await seedTestCase(asOwner, fixture.projectId, {
      title: "E2E Reports touched an hour ago",
      createdDaysAgo: 40,
      updatedDaysAgo: 0,
    });
    try {
      const after = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/repository-summary`);
      // Only the freshly-updated one moves the counters, even though both were created long ago.
      expect(after.updatedToday).toBe(before.updatedToday + 1);
      expect(after.updatedThisMonth).toBe(before.updatedThisMonth + 1);
      expect(after.totalTestCases).toBe(before.totalTestCases + 2);
    } finally {
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${staleCase.id}`, {
        failOnStatusCode: false,
      });
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${freshCase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("RPT-A-27 an empty project still returns a full 30-day series of zeros", { tag: '@tesbo.testId("TES-TC-487")' }, async () => {
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/reports/repository-summary`);
      expect(body.totalTestCases).toBe(0);
      expect(body.bySuite).toEqual([]);
      expect(body.byStatus).toEqual([]);
      expect(body.byPriority).toEqual([]);
      expect(body.addedByDate).toHaveLength(30);
      expect(body.addedByDate.every((d: any) => d.count === 0)).toBeTruthy();
      expect(body.updatedToday).toBe(0);
      expect(body.updatedThisWeek).toBe(0);
      expect(body.updatedThisMonth).toBe(0);
    });
  });
});

test.describe("reports overview", () => {
  test("RPT-A-28 the pass rate series is capped at the last ten runs, oldest first", { tag: '@tesbo.testId("TES-TC-488")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    expect(body.passRateTrend).toHaveLength(10);
    // Eleven runs exist, so the oldest one is dropped rather than the newest.
    expect(body.passRateTrend[0].name).toBe(fixture.runs[1].name);
    expect(body.passRateTrend[9].name).toBe(fixture.runs[10].name);

    const timestamps = body.passRateTrend.map((p: any) => new Date(p.createdAt).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a: number, b: number) => a - b));
  });

  test("RPT-A-29 each run's pass rate is passed over executed, ignoring untested items", { tag: '@tesbo.testId("TES-TC-489")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    const byName = new Map(body.passRateTrend.map((p: any) => [p.name, p]));

    // Run 6: flaky Failed, stable Passed, lowFlake Failed -> 1 of 3 executed passed.
    const run6 = byName.get(fixture.runs[5].name) as any;
    expect(run6.total).toBe(3);
    expect(run6.executed).toBe(3);
    expect(run6.passRate).toBe(33);

    // Run 11: flaky Passed, noSuite Passed -> everything executed passed.
    const run11 = byName.get(fixture.runs[10].name) as any;
    expect(run11.passRate).toBe(100);
  });

  test("RPT-A-30 a run with nothing executed reports a null pass rate rather than zero", { tag: '@tesbo.testId("TES-TC-490")' }, async () => {
    const run = await seedRun(asOwner, fixture.projectId, { name: `E2E Reports Unrun Run ${Date.now()}` });
    try {
      await addRunCases(asOwner, run.id, [fixture.cases.untestedP1.id]);
      const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
      const row = body.passRateTrend.find((p: any) => p.name === run.name);
      expect(row.total).toBe(1);
      expect(row.executed).toBe(0);
      // null, not 0 — "no results yet" and "everything failed" must not render identically.
      expect(row.passRate).toBeNull();
    } finally {
      await asOwner.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
    }
  });

  test("RPT-A-30b Skipped is executed but not settled, and Retest is neither", { tag: '@tesbo.testId("TES-TC-490-1")' }, async () => {
    /*
     * Before the fix, this endpoint's "executed" counted anything that was not literally Untested
     * — which meant a Retest case (no settled result at all) counted as executed, and a Skipped
     * case counted toward the pass-rate denominator as if it were a missed pass. Both silently
     * dragged the reported pass rate down for a run whose visible results hadn't changed.
     */
    const run = await seedRun(asOwner, fixture.projectId, { name: `E2E Reports Skip Retest Run ${Date.now()}` });
    try {
      await addRunCases(asOwner, run.id, [
        fixture.cases.flaky.id,
        fixture.cases.stable.id,
        fixture.cases.lowFlake.id,
        fixture.cases.untestedP1.id,
      ]);
      const executions = await listRunExecutions(asOwner, run.id);
      const setStatus = (testcaseId: string, status: string) => {
        const execution = executions.find((e) => e.testcaseId === testcaseId)!;
        return asOwner.patch(`/api/cycles/${run.id}/executions/${execution.id}`, { data: { status } });
      };
      await setStatus(fixture.cases.flaky.id, "Passed");
      await setStatus(fixture.cases.stable.id, "Skipped");
      await setStatus(fixture.cases.lowFlake.id, "Retest");
      // untestedP1 stays Untested.

      const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
      const row = body.passRateTrend.find((p: any) => p.name === run.name);
      expect(row.total).toBe(4);
      // Retest and Untested are not executed; Passed and Skipped are.
      expect(row.executed).toBe(2);
      expect(row.executionProgress).toBe(50);
      // Passed / (Passed + Failed + Blocked) = 1/1 = 100% — Skipped never reaches this ratio.
      expect(row.passRate).toBe(100);
    } finally {
      await asOwner.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
    }
  });

  test("RPT-A-31 the trend delta compares the newest run in the window against the oldest", { tag: '@tesbo.testId("TES-TC-491")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    const rated = body.passRateTrend.filter((p: any) => p.passRate !== null);
    expect(body.trendDelta).toBe(rated[rated.length - 1].passRate - rated[0].passRate);
  });

  test("RPT-A-32 suite health reports per-suite percentages and marks a never-run suite as not run", { tag: '@tesbo.testId("TES-TC-492")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    const bySuite = new Map(body.suiteHealth.map((s: any) => [s.suiteName, s]));

    const alpha = bySuite.get("Alpha") as any;
    // Alpha's executed results: flaky 6P/5F, stable 6P, lowFlake 5P/1F -> 17 of 23 passed.
    expect(alpha.executed).toBe(23);
    expect(alpha.passedPct).toBe(74);
    expect(alpha.failedPct).toBe(26);
    expect(alpha.blockedPct).toBe(0);

    const beta = bySuite.get("Beta") as any;
    expect(beta.executed).toBe(0);
    expect(beta.passedPct).toBe(0);

    const unassigned = bySuite.get("Unassigned") as any;
    expect(unassigned.executed).toBe(1);
    expect(unassigned.passedPct).toBe(100);
  });

  test("RPT-A-33 the flaky, coverage-gap and untested-P1 counts reflect the seeded history", { tag: '@tesbo.testId("TES-TC-493")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    // flaky (alternates every run) and lowFlake (one flip in six) — stable is not flaky.
    expect(body.flakyCount).toBe(2);
    // Only Beta is below 70% covered; Alpha sits at 75% and the suiteless case at 100%.
    expect(body.coverageGapCount).toBe(1);
    // The P1 in Beta has never been executed; the other P1 passes in six runs.
    expect(body.untestedP1Count).toBe(1);
  });

  test("RPT-A-34 the AI summary names the flaky suite, the coverage gap and the trend direction", { tag: '@tesbo.testId("TES-TC-494")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    expect(body.aiSummary).toContain("Alpha suite has a flaky test");
    expect(body.aiSummary).toContain(fixture.cases.flaky.externalId);
    expect(body.aiSummary).toContain("Beta suite shows low coverage");
    expect(body.aiSummary).toContain("only 0 of 1 cases executed");
    expect(body.aiSummary).toMatch(/Overall pass rate (improved|declined) \d+% over the last \d+ runs\./);
  });

  test("RPT-A-35 an empty project says there is not enough history instead of inventing insights", { tag: '@tesbo.testId("TES-TC-495")' }, async () => {
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/reports/overview`);
      expect(body.passRateTrend).toEqual([]);
      expect(body.trendDelta).toBe(0);
      expect(body.suiteHealth).toEqual([]);
      expect(body.flakyCount).toBe(0);
      expect(body.coverageGapCount).toBe(0);
      expect(body.untestedP1Count).toBe(0);
      expect(body.aiSummary).toBe("Not enough execution history yet to generate insights.");
    });
  });
});

test.describe("AI insights", () => {
  test("RPT-A-36 flaky tests are ranked by flip count and labelled by flip rate", { tag: '@tesbo.testId("TES-TC-496")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/insights`);
    expect(body.flakyTests).toHaveLength(2);

    const [worst, milder] = body.flakyTests;
    expect(worst.testcaseId).toBe(fixture.cases.flaky.id);
    expect(worst.flipCount).toBe(10);
    expect(worst.flakinessLabel).toBe("High");
    expect(worst.suiteName).toBe("Alpha");
    expect(worst.runs).toHaveLength(11);
    expect(worst.runs.map((r: any) => r.status)).toEqual([
      "Passed", "Failed", "Passed", "Failed", "Passed", "Failed", "Passed", "Failed", "Passed", "Failed", "Passed",
    ]);

    // One flip across six runs is a 0.2 flip rate — below the 0.25 "Medium" threshold.
    expect(milder.testcaseId).toBe(fixture.cases.lowFlake.id);
    expect(milder.flipCount).toBe(1);
    expect(milder.flakinessLabel).toBe("Low");

    expect(body.flakyTests.some((f: any) => f.testcaseId === fixture.cases.stable.id)).toBeFalsy();
  });

  test("RPT-A-37 a case that flips half its runs is labelled Medium", { tag: '@tesbo.testId("TES-TC-497")' }, async () => {
    // Four runs, one flip -> 1/3 = 0.33, which is Medium: between the 0.25 and 0.5 thresholds.
    const mediumCase = await seedTestCase(asOwner, fixture.projectId, {
      title: "E2E Reports medium flake",
      suiteId: fixture.betaSuiteId,
    });
    const runs: SeededRun[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const run = await seedRun(asOwner, fixture.projectId, {
          name: `E2E Reports Medium Flake Run ${i} ${Date.now()}`,
          createdDaysAgo: 1,
        });
        runs.push(run);
        await addRunCases(asOwner, run.id, [mediumCase.id]);
        const [execution] = await listRunExecutions(asOwner, run.id);
        setExecutionResults([{ executionId: execution.id, status: i < 3 ? "Passed" : "Failed" }]);
      }

      const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/insights`);
      const entry = body.flakyTests.find((f: any) => f.testcaseId === mediumCase.id);
      expect(entry.flipCount).toBe(1);
      expect(entry.flakinessLabel).toBe("Medium");
    } finally {
      for (const run of runs) await asOwner.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${fixture.projectId}/testcases/${mediumCase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("RPT-A-38 coverage gaps are the sub-70% slice of coverage by suite", { tag: '@tesbo.testId("TES-TC-498")' }, async () => {
    const body = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/insights`);
    const bySuite = new Map(body.coverageBySuite.map((c: any) => [c.suiteName, c]));
    expect(bySuite.get("Alpha")).toEqual({ suiteName: "Alpha", total: 4, covered: 3, pct: 75 });
    expect(bySuite.get("Beta")).toEqual({ suiteName: "Beta", total: 1, covered: 0, pct: 0 });
    expect(bySuite.get("Unassigned")).toEqual({ suiteName: "Unassigned", total: 1, covered: 1, pct: 100 });

    expect(body.coverageGaps).toEqual([bySuite.get("Beta")]);
    expect(body.coverageGaps.every((c: any) => c.pct < 70)).toBeTruthy();
  });

  test("RPT-A-39 the health score follows the documented weighting and stays inside 0-100", { tag: '@tesbo.testId("TES-TC-499")' }, async () => {
    const insights = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/insights`);
    const overview = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);

    // Recomputed from the endpoint's own inputs rather than hardcoded, so this asserts the formula
    // (60% pass rate + 30% coverage + up to 10 for no untested P1s - 5 per flaky test) instead of
    // re-encoding the fixture's arithmetic.
    const rated = overview.passRateTrend.filter((p: any) => p.passRate !== null);
    const avgPassRate = rated.reduce((sum: number, p: any) => sum + p.passRate, 0) / rated.length;
    const avgCoverage =
      insights.coverageBySuite.reduce((sum: number, c: any) => sum + c.pct, 0) / insights.coverageBySuite.length;
    const untestedPenalty = insights.untestedP1Count === 0 ? 10 : Math.max(0, 10 - insights.untestedP1Count);
    const expected = Math.max(
      0,
      Math.min(
        100,
        Math.round(avgPassRate * 0.6 + avgCoverage * 0.3 + untestedPenalty - insights.flakyTests.length * 5),
      ),
    );

    expect(insights.healthScore).toBe(expected);
    expect(insights.healthScore).toBeGreaterThanOrEqual(0);
    expect(insights.healthScore).toBeLessThanOrEqual(100);
    const expectedLabel =
      insights.healthScore >= 70 ? "Healthy" : insights.healthScore >= 40 ? "Needs attention" : "At risk";
    expect(insights.healthLabel).toBe(expectedLabel);
  });

  test("RPT-A-40 a project with nothing to judge scores 10 and reads as At risk", { tag: '@tesbo.testId("TES-TC-500")' }, async () => {
    // Pinned deliberately: an untouched project is reported as "At risk" with a score of 10, because
    // the heuristic gives a 10-point bonus for having no untested P1s and nothing else applies.
    // Whether that is the right thing to tell a user is a product question — see the finding in
    // docs/e2e-coverage-waves.md — but it must not change by accident.
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/reports/insights`);
      expect(body.healthScore).toBe(10);
      expect(body.healthLabel).toBe("At risk");
      expect(body.flakyTests).toEqual([]);
      expect(body.coverageGaps).toEqual([]);
      expect(body.coverageBySuite).toEqual([]);
      expect(body.untestedP1Count).toBe(0);
    });
  });
});

test.describe("trends", () => {
  test("RPT-A-41 the trend window holds twelve runs where the overview holds ten", { tag: '@tesbo.testId("TES-TC-501")' }, async () => {
    const trends = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/trends`);
    const overview = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);

    // Eleven runs exist: trends shows all of them, the overview drops the oldest.
    expect(trends.passRateTrend).toHaveLength(11);
    expect(overview.passRateTrend).toHaveLength(10);
    expect(trends.passRateTrend[0].name).toBe(fixture.runs[0].name);
    expect(trends.passRateTrend.slice(1)).toEqual(overview.passRateTrend);

    const rated = trends.passRateTrend.filter((p: any) => p.passRate !== null);
    expect(trends.trendDelta).toBe(rated[rated.length - 1].passRate - rated[0].passRate);
  });

  test("RPT-A-42 execution velocity mirrors the series' executed counts run for run", { tag: '@tesbo.testId("TES-TC-502")' }, async () => {
    const trends = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/trends`);
    expect(trends.executionVelocity).toEqual(
      trends.passRateTrend.map((p: any) => ({ name: p.name, count: p.executed })),
    );
  });

  test("RPT-A-43 bug discovery is seven Monday-aligned weekly buckets, and older bugs fall outside", { tag: '@tesbo.testId("TES-TC-503")' }, async () => {
    const trends = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/trends`);
    expect(trends.bugDiscoveryRate).toHaveLength(7);

    const weeks = trends.bugDiscoveryRate.map((b: any) => b.week);
    expect(weeks).toEqual([...weeks].sort());
    for (const week of weeks) {
      // date_trunc('week', ...) in Postgres starts weeks on Monday.
      expect(new Date(`${week}T00:00:00Z`).getUTCDay(), `${week} should be a Monday`).toBe(1);
    }

    // Two of the three seeded bugs are inside the window; the 80-day-old one is not.
    const total = trends.bugDiscoveryRate.reduce((sum: number, b: any) => sum + b.count, 0);
    expect(total).toBe(2);
    expect(trends.bugDiscoveryRate[trends.bugDiscoveryRate.length - 1].count).toBe(1);
  });

  test("RPT-A-44 an empty project still returns the seven-week skeleton", { tag: '@tesbo.testId("TES-TC-504")' }, async () => {
    await withEmptyProject(async (projectId) => {
      const body = await getJson(asOwner, `/api/projects/${projectId}/reports/trends`);
      expect(body.passRateTrend).toEqual([]);
      expect(body.trendDelta).toBe(0);
      expect(body.executionVelocity).toEqual([]);
      expect(body.bugDiscoveryRate).toHaveLength(7);
      expect(body.bugDiscoveryRate.every((b: any) => b.count === 0)).toBeTruthy();
    });
  });
});

test.describe("cross-endpoint consistency", () => {
  test("RPT-A-45 the counters agree with the repository summary and the matrix", { tag: '@tesbo.testId("TES-TC-505")' }, async () => {
    const analytics = await getJson(asOwner, `/api/projects/${fixture.projectId}/analytics`);
    const repository = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/repository-summary`);
    const matrix = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/requirement-matrix`);
    const execution = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);

    expect(repository.totalTestCases).toBe(analytics.testCaseCount);
    expect(new Set(matrix.rows.map((r: any) => r.testcaseId)).size).toBe(analytics.testCaseCount);
    expect(repository.bySuite.reduce((sum: number, s: any) => sum + s.count, 0)).toBe(analytics.testCaseCount);

    const reported = execution.rows.reduce((sum: number, row: any) => sum + row.total, 0);
    expect(reported).toBe(analytics.executionTotal);
  });

  test("RPT-A-46 the flaky and coverage figures agree between overview and insights", { tag: '@tesbo.testId("TES-TC-506")' }, async () => {
    const overview = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    const insights = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/insights`);
    expect(overview.flakyCount).toBe(insights.flakyTests.length);
    expect(overview.coverageGapCount).toBe(insights.coverageGaps.length);
    expect(overview.untestedP1Count).toBe(insights.untestedP1Count);
  });
});

test.describe("the per-run report summary endpoint", () => {
  test("RPT-A-47 returns a hardcoded all-zero summary regardless of the run's real results", { tag: '@tesbo.testId("TES-TC-507")' }, async () => {
    // KNOWN STUB (documented, not test.fail()): legacy.controller.ts's cycleSummary() takes no
    // parameters at all and returns a fixed object. Run 6 below really does hold three results, so
    // if this endpoint ever starts reporting them this assertion is the thing that notices. It has
    // no frontend consumer today — recorded as a finding rather than a red test.
    const run = fixture.runs[5];
    const res = await asOwner.get(`/api/cycles/${run.id}/report/summary`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0 });

    const overview = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/overview`);
    const realRun = overview.passRateTrend.find((p: any) => p.name === run.name);
    expect(realRun.executed).toBe(3);
  });

  test("RPT-A-48 answers the same zeros for a run id that doesn't exist", { tag: '@tesbo.testId("TES-TC-508")' }, async () => {
    const res = await asOwner.get("/api/cycles/00000000-0000-0000-0000-000000000000/report/summary", {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).total).toBe(0);
  });
});

/*
 * Basecamp 10218723531 — "Reports & Insights > Export buttons are not working".
 *
 * The button was never wired to anything (no onClick, title="Coming soon"), so this endpoint is new
 * rather than fixed. Six views, two formats. The contract worth holding: the file is the same numbers
 * the screen shows, which is why these cases compare the export against the JSON endpoint behind the
 * same tab instead of restating the fixture's arithmetic a second time.
 */
test.describe("report export", () => {
  const EXPORT_VIEWS = ["overview", "execution", "matrix", "repository", "insights", "trends"] as const;

  function exportUrl(view: string, format: "csv" | "xlsx", extra = ""): string {
    return `/api/projects/${fixture.projectId}/reports/export/${format}?view=${view}${extra}`;
  }

  /** CSV split into rows, respecting the quoting rowsToCsv applies. */
  function csvRows(body: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quoted) {
        if (ch === '"' && body[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cell += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (ch !== "\r") cell += ch;
    }
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  for (const view of EXPORT_VIEWS) {
    test(`RPT-A-55 the ${view} view exports a CSV named after itself`, async () => {
      const res = await asOwner.get(exportUrl(view, "csv"), { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/csv");
      // The filename matters: six views downloading as one name is how you end up with
      // report(3).csv and no idea which tab it came from.
      expect(res.headers()["content-disposition"]).toContain(`filename="report-${view}.csv"`);

      const rows = csvRows(await res.text());
      expect(rows.length, "an export with no header row is an empty file with extra steps").toBeGreaterThan(0);
      const header = rows[0];
      if (view === "execution") {
        expect(header).toEqual(["groupName", "Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest", "total"]);
      } else if (view === "matrix") {
        expect(header[0]).toBe("externalId");
        expect(header).toContain("bugUrl");
      } else {
        // The four dashboard views share the long form — one parseable table instead of stacked
        // mini-tables with conflicting headers.
        expect(header).toEqual(["section", "label", "metric", "value"]);
      }
      // Every data row has to have the same width as the header, or nothing can parse it.
      for (const row of rows.slice(1)) expect(row.length).toBe(header.length);
    });
  }

  for (const view of EXPORT_VIEWS) {
    test(`RPT-A-56 the ${view} view exports a workbook`, async () => {
      const res = await asOwner.get(exportUrl(view, "xlsx"), { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()["content-disposition"]).toContain(`filename="report-${view}.xlsx"`);
      const body = Buffer.from(await res.body());
      // xlsx is a zip: "PK" or it is not a workbook, whatever the headers claim.
      expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(body.length).toBeGreaterThan(0);
    });
  }

  test("RPT-A-57 the execution export is the execution report, row for row", { tag: '@tesbo.testId("TES-TC-1200")' }, async () => {
    const json = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
    const rows = csvRows(await (await asOwner.get(exportUrl("execution", "csv"))).text());

    expect(rows.length - 1).toBe(json.rows.length);
    const exported = new Map(rows.slice(1).map((row) => [row[0], row]));
    for (const jsonRow of json.rows) {
      const row = exported.get(String(jsonRow.groupName));
      expect(row, `${jsonRow.groupName} is missing from the export`).toBeTruthy();
      expect(row![1]).toBe(String(jsonRow.Passed));
      expect(row![2]).toBe(String(jsonRow.Failed));
      expect(row![7]).toBe(String(jsonRow.total));
    }
  });

  test("RPT-A-58 the export carries the tab's filter, not the whole project", { tag: '@tesbo.testId("TES-TC-1201")' }, async () => {
    // The screen filters by plan/run/suite/person/priority/tag. Exporting while looking at one run
    // and getting every run back would be a quietly wrong file — worse than no export at all.
    const run = fixture.runs[5];
    const filter = `&filterBy=run&filterValue=${run.id}`;
    const filtered = await getJson(
      asOwner,
      `/api/projects/${fixture.projectId}/reports/execution?filterBy=run&filterValue=${run.id}`,
    );
    const rows = csvRows(await (await asOwner.get(exportUrl("execution", "csv", filter))).text());

    expect(rows.length - 1).toBe(filtered.rows.length);
    const unfiltered = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/execution`);
    expect(filtered.rows.length, "the fixture must actually be narrowed for this to prove anything").toBeLessThan(
      unfiltered.rows.length,
    );
  });

  test("RPT-A-59 the traceability export matches the matrix row for row", { tag: '@tesbo.testId("TES-TC-1202")' }, async () => {
    const json = await getJson(asOwner, `/api/projects/${fixture.projectId}/reports/requirement-matrix`);
    const rows = csvRows(await (await asOwner.get(exportUrl("matrix", "csv"))).text());
    expect(rows.length - 1).toBe(json.rows.length);
  });

  test("RPT-A-60 a title carrying commas, quotes and newlines survives the CSV", { tag: '@tesbo.testId("TES-TC-1203")' }, async () => {
    // rowsToCsv quotes and doubles quotes; the risk is a cell that silently becomes two columns and
    // shifts every field after it on that row.
    //
    // Seeded in a throwaway project rather than the fixture: every other test in this file asserts
    // exact aggregates over fixture.projectId, and an extra test case — even a deleted one — is
    // exactly the kind of contamination this file's header warns about.
    const nasty = `E2E Export "quoted", comma\nand newline ${Date.now()}`;
    const projectId = await seedProject(asOwner, `E2E Export Quoting ${Date.now()}`);
    try {
      await seedTestCase(asOwner, projectId, { title: nasty, priority: "P3" });
      const res = await asOwner.get(`/api/projects/${projectId}/reports/export/csv?view=matrix`);
      const rows = csvRows(await res.text());
      const header = rows[0];
      const titleIndex = header.indexOf("testcaseTitle");
      const match = rows.slice(1).find((row) => row[titleIndex]?.includes("and newline"));
      expect(match, "the awkward title never made it into the export").toBeTruthy();
      expect(match![titleIndex]).toBe(nasty);
      expect(match!.length, "a quoted cell must not widen its row").toBe(header.length);
    } finally {
      purgeProject(projectId);
    }
  });

  test("RPT-A-61 an unknown view is refused, naming the ones that exist", { tag: '@tesbo.testId("TES-TC-1204")' }, async () => {
    const res = await asOwner.get(exportUrl("everything", "csv"), { failOnStatusCode: false });
    expect(res.status()).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("everything");
    for (const view of EXPORT_VIEWS) expect(error).toContain(view);
  });

  test("RPT-A-62 an unsupported format is refused", { tag: '@tesbo.testId("TES-TC-1205")' }, async () => {
    for (const format of ["pdf", "json", "csv.exe"]) {
      const res = await asOwner.get(
        `/api/projects/${fixture.projectId}/reports/export/${format}?view=overview`,
        { failOnStatusCode: false },
      );
      expect(res.status(), `${format} should be refused, not guessed at`).toBe(400);
    }
  });

  test("RPT-A-63 no view at all falls back to the overview rather than failing", { tag: '@tesbo.testId("TES-TC-1206")' }, async () => {
    const res = await asOwner.get(`/api/projects/${fixture.projectId}/reports/export/csv`, {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain('filename="report-overview.csv"');
  });

  test("RPT-A-64 an empty project exports headers and no rows", { tag: '@tesbo.testId("TES-TC-1207")' }, async () => {
    // The empty-result edge: a brand new project has no runs, no cases and no bugs, and every view
    // still has to produce a file a spreadsheet can open.
    const emptyId = await seedProject(asOwner, `E2E Export Empty ${Date.now()}`);
    try {
      for (const view of EXPORT_VIEWS) {
        const res = await asOwner.get(
          `/api/projects/${emptyId}/reports/export/csv?view=${view}`,
          { failOnStatusCode: false },
        );
        expect(res.status(), `${view} on an empty project answered ${res.status()}`).toBe(200);
        const rows = csvRows(await res.text());
        expect(rows[0].length, `${view} produced no header row`).toBeGreaterThan(1);
      }
    } finally {
      purgeProject(emptyId);
    }
  });
});

test.describe("malformed and unknown identifiers", () => {
  for (const badId of ["not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
    test(`RPT-A-49 no report endpoint 500s on "${badId}"`, async () => {
      for (const path of reportPaths(badId)) {
        const res = await asOwner.get(path, { failOnStatusCode: false });
        expect(res.status(), `${path} answered ${res.status()}`).toBeLessThan(500);
      }
    });
  }
});

test.describe("authorization", () => {
  test("RPT-A-50 a project member can read every report", { tag: '@tesbo.testId("TES-TC-511")' }, async () => {
    for (const path of reportPaths(fixture.projectId)) {
      const res = await asQa.get(path, { failOnStatusCode: false });
      expect(res.status(), `${path} should be readable by a project member`).toBe(200);
    }
  });

  test("RPT-A-51 an anonymous caller is refused everywhere", { tag: '@tesbo.testId("TES-TC-512")' }, async () => {
    for (const path of reportPaths(fixture.projectId)) {
      const res = await anon.get(path, { failOnStatusCode: false });
      expect([400, 401, 403, 404], `${path} should refuse a caller with no session`).toContain(res.status());
    }
  });

  test("RPT-A-52 a workspace member with no access to the project is refused everywhere", { tag: '@tesbo.testId("TES-TC-513")' }, async () => {
    for (const path of reportPaths(fixture.projectId)) {
      const res = await asGuest.get(path, { failOnStatusCode: false });
      expect([401, 403, 404], `${path} should refuse a non-member of the project`).toContain(res.status());
    }
  });

  test("RPT-A-53 another tenant's project leaks nothing", { tag: '@tesbo.testId("TES-TC-514")' }, async () => {
    for (const path of reportPaths(ACCOUNT_A.projectId)) {
      const res = await asOwner.get(path, { failOnStatusCode: false });
      expect([401, 403, 404], `${path} should refuse a caller from another workspace`).toContain(res.status());
    }
  });

  test("RPT-A-54 the reports of a project locked by a downgrade stay readable", { tag: '@tesbo.testId("TES-TC-515")' }, async () => {
    // ProjectWriteLockGuard exempts safe methods on purpose: "customers can always see and export
    // their data". This is the test of that promise — a project past the Launch allowance with its
    // grace window closed refuses writes but must still answer every report.
    const organizationId = tenant!.organizationId;
    try {
      setGraceWindow(organizationId, -1);

      const write = await asOwner.post(`/api/projects/${fixture.projectId}/testcases`, {
        data: { title: `E2E Reports locked write ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(write.status(), "the lock has to actually be in force for this test to mean anything").toBe(403);

      for (const path of reportPaths(fixture.projectId)) {
        const res = await asOwner.get(path, { failOnStatusCode: false });
        expect(res.status(), `${path} must stay readable while the project is locked`).toBe(200);
      }
    } finally {
      setProPlan(organizationId);
    }
  });
});
