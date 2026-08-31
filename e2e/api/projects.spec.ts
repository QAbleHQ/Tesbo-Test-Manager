import { expect, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { dbControlAvailable } from "../utils/psql";
import { anonymousContext } from "../utils/rbac-tenant";
import {
  backdate,
  createBug,
  createProject,
  createSuite,
  createTestCase,
  deleteProjects,
  getDashboard,
  listRuns,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedJiraRequirements,
  seedRun,
  softDeleteExecutions,
  uniqueSuffix,
} from "../utils/screens-tenant";

test.describe("project CRUD", () => {
  test("creates a project from just a name and derives a key from it", { tag: '@tesbo.testId("TES-TC-405")' }, async ({ request }) => {
    // projectKey() uppercases, strips non-alphanumerics, then keeps only the first 16 chars —
    // so the name must stay short enough that the full (fast-changing) timestamp survives
    // that truncation. A longer prefix like "E2E Project" would eat the budget and leave only
    // the timestamp's slow-changing leading digits, colliding across reruns within the same
    // ~2.8-hour window (organization_id, key) is uniquely constrained forever, even for
    // archived projects.
    const name = `E2E ${Date.now()}`;
    const createRes = await request.post("/api/projects", { data: { name } });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);
    expect(created.key).toMatch(/^[A-Z0-9]{1,16}$/);
    expect(created.projectType).toBe("tesbox");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("creates a project with an explicit key, description and projectType", { tag: '@tesbo.testId("TES-TC-406")' }, async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Full Project ${suffix}`;
    const createRes = await request.post("/api/projects", {
      data: { name, key: `e2e${suffix}`, description: "Created by the e2e suite", projectType: "manual" },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    // projectKey() uppercases and strips non-alphanumerics before storing.
    expect(created.key).toBe(`E2E${suffix}`);
    expect(created.projectType).toBe("manual");

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect((await getRes.json()).description).toBe("Created by the e2e suite");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("rejects creating a project without a name", { tag: '@tesbo.testId("TES-TC-407")' }, async ({ request }) => {
    const res = await request.post("/api/projects", { data: {}, failOnStatusCode: false });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  test("rejects creating a project with a name over the 30 character max", { tag: '@tesbo.testId("TES-TC-1185")' }, async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const res = await request.post("/api/projects", {
      data: { name: "x".repeat(31), key: `E2ELONG${suffix}` },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/30 characters/);
  });

  test("allows creating a project with a name at exactly the 30 character max", { tag: '@tesbo.testId("TES-TC-1186")' }, async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = "y".repeat(30);
    const createRes = await request.post("/api/projects", { data: { name, key: `E2EMAX${suffix}` } });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.name).toBe(name);

    await request.delete(`/api/projects/${created.id}`);
  });

  test("rejects creating a project whose key collides with an existing one", { tag: '@tesbo.testId("TES-TC-408")' }, async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const key = `DUPE${suffix}`;

    const firstRes = await request.post("/api/projects", { data: { name: `Dup A ${suffix}`, key } });
    expect(firstRes.ok()).toBeTruthy();
    const first = await firstRes.json();

    // Known rough edge, pinned deliberately: (organization_id, key) is unique at the DB level
    // but createProject() doesn't catch that constraint violation, so a collision falls through
    // to the generic unhandled-exception handler as a 500 rather than a clean 4xx. If that's
    // ever fixed, this assertion should be tightened to the new status rather than loosened.
    const secondRes = await request.post("/api/projects", {
      data: { name: `Dup B ${suffix}`, key },
      failOnStatusCode: false,
    });
    expect(secondRes.ok()).toBeFalsy();

    await request.delete(`/api/projects/${first.id}`);
  });

  test("supports the read -> update -> delete lifecycle", { tag: '@tesbo.testId("TES-TC-409")' }, async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Lifecycle Project ${suffix}`;
    // Explicit key: the name alone is too long for projectKey()'s 16-char budget to retain any
    // of the timestamp (see the "derives a key from it" test above for why that matters).
    const createRes = await request.post("/api/projects", { data: { name, key: `E2ELIFE${suffix}` } });
    const created = await createRes.json();

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).name).toBe(name);

    const updatedName = `${name} (renamed)`;
    const patchRes = await request.patch(`/api/projects/${created.id}`, {
      data: { name: updatedName, description: "updated description", settings: { foo: "bar" } },
    });
    expect(patchRes.ok()).toBeTruthy();

    const getAfterUpdateRes = await request.get(`/api/projects/${created.id}`);
    const afterUpdate = await getAfterUpdateRes.json();
    expect(afterUpdate.name).toBe(updatedName);
    expect(afterUpdate.description).toBe("updated description");
    expect(afterUpdate.settings).toMatchObject({ foo: "bar" });

    const listRes = await request.get("/api/projects");
    const list = await listRes.json();
    expect(list.some((p: { id: string }) => p.id === created.id)).toBeTruthy();

    const deleteRes = await request.delete(`/api/projects/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDeleteRes = await request.get(`/api/projects/${created.id}`, {
      failOnStatusCode: false,
    });
    expect(getAfterDeleteRes.status()).toBe(404);

    const listAfterDeleteRes = await request.get("/api/projects");
    const listAfterDelete = await listAfterDeleteRes.json();
    expect(listAfterDelete.some((p: { id: string }) => p.id === created.id)).toBeFalsy();
  });

  test("update validates name and description instead of blanking the name", { tag: '@tesbo.testId("TES-TC-950")' }, async ({ request }) => {
    // This used to assert the opposite: updateProject() had no "name required" check, so
    // PATCH {name: ""} blanked the name (COALESCE only skips null/undefined, and "" is neither),
    // and the spec documented that gap. validateProjectFields() is now shared by
    // createProject/updateProject, so the gap is closed and an empty name is a 400 that changes
    // nothing. Boundaries are asserted here too, so a regression in either direction shows up.
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Validated Project ${suffix}`;
    const createRes = await request.post("/api/projects", { data: { name, key: `E2EVAL${suffix}` } });
    const created = await createRes.json();

    try {
      // Each rejected payload must leave the stored name untouched, not partially applied.
      for (const badName of ["", "   ", "ab"]) {
        const res = await request.patch(`/api/projects/${created.id}`, {
          data: { name: badName },
          failOnStatusCode: false,
        });
        expect(res.status()).toBe(400);
        const getRes = await request.get(`/api/projects/${created.id}`);
        expect((await getRes.json()).name).toBe(name);
      }

      const tooLongName = await request.patch(`/api/projects/${created.id}`, {
        data: { name: "x".repeat(31) },
        failOnStatusCode: false,
      });
      expect(tooLongName.status()).toBe(400);

      const tooLongDescription = await request.patch(`/api/projects/${created.id}`, {
        data: { description: "d".repeat(501) },
        failOnStatusCode: false,
      });
      expect(tooLongDescription.status()).toBe(400);

      // The max-length boundary itself is allowed — 30 passes, 31 (above) does not.
      const atMaxName = `${"y".repeat(30)}`;
      const okRes = await request.patch(`/api/projects/${created.id}`, { data: { name: atMaxName } });
      expect(okRes.ok()).toBeTruthy();
      const afterOk = await request.get(`/api/projects/${created.id}`);
      expect((await afterOk.json()).name).toBe(atMaxName);
    } finally {
      await request.delete(`/api/projects/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("updating or deleting a project that doesn't exist returns 404", { tag: '@tesbo.testId("TES-TC-411")' }, async ({ request }) => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    const patchRes = await request.patch(`/api/projects/${missingId}`, {
      data: { name: "nope" },
      failOnStatusCode: false,
    });
    expect(patchRes.status()).toBe(404);

    const deleteRes = await request.delete(`/api/projects/${missingId}`, { failOnStatusCode: false });
    expect(deleteRes.status()).toBe(404);
  });
});

/*
 * ── GET /api/projects/:projectId/dashboard ──
 *
 * Runs against the disposable screens tenant, not account A: every assertion here is arithmetic
 * over a project's whole contents, which is only deterministic when the project was built by this
 * test and nothing else is writing to it. See utils/screens-tenant.ts.
 */
test.describe("project dashboard summary", () => {
  const tenant = screensTenant();
  const skipReason = screensSuiteSkipReason(tenant);

  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await screensApi();
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test("DSH-A-01/02 a brand-new project reports the full contract, zeroed, with no invented rates", { tag: '@tesbo.testId("TES-TC-412")' }, async () => {
    const project = await createProject(api);
    try {
      const summary = await getDashboard(api, project.id);

      expect(summary).toEqual({
        testCases: { total: 0, addedThisWeek: 0 },
        passRate: { value: null, deltaThisWeek: null },
        executionProgress: { value: 0 },
        openBugs: { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0 } },
        coverage: { pct: null, totalRequirements: 0 },
        plans: 0,
        suites: 0,
        activeRuns: 0,
      });
      // Nothing has been executed, so a rate would be a fabrication — null, never 0.
      expect(summary.passRate.value).toBeNull();
      expect(summary.coverage.pct).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-03 testCases.total matches the list endpoint and excludes soft-deleted cases", { tag: '@tesbo.testId("TES-TC-413")' }, async () => {
    const project = await createProject(api);
    try {
      const kept = await createTestCase(api, project.id);
      const removed = await createTestCase(api, project.id);
      expect((await getDashboard(api, project.id)).testCases.total).toBe(2);

      await api.delete(`/api/projects/${project.id}/testcases/${removed.id}`);

      const summary = await getDashboard(api, project.id);
      const listTotal = Number(
        (await api.get(`/api/projects/${project.id}/testcases`)).headers()["x-total-count"],
      );
      expect(summary.testCases.total).toBe(1);
      expect(summary.testCases.total).toBe(listTotal);
      expect(kept.id).toBeTruthy();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-04 addedThisWeek counts the last 7 days only", { tag: '@tesbo.testId("TES-TC-414")' }, async () => {
    test.skip(!dbControlAvailable(), "needs psql access to backdate a test case past the 7-day window");
    const project = await createProject(api);
    try {
      const recent = await createTestCase(api, project.id);
      const old = await createTestCase(api, project.id);
      backdate("testcases", "created_at", [old.id], "8 days");

      const summary = await getDashboard(api, project.id);
      expect(summary.testCases.total).toBe(2);
      expect(summary.testCases.addedThisWeek).toBe(1);
      expect(recent.id).toBeTruthy();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-05 passRate divides by executed cases, leaving Untested out of the denominator", { tag: '@tesbo.testId("TES-TC-415")' }, async () => {
    const project = await createProject(api);
    try {
      // 3 passed, 1 failed, 2 untested → 3/4 executed = 75%, not 3/6 = 50%.
      await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Passed", "Failed", "Untested", "Untested"],
      });

      expect((await getDashboard(api, project.id)).passRate.value).toBe(75);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-06 a run with nothing executed reports no pass rate rather than 0%", { tag: '@tesbo.testId("TES-TC-416")' }, async () => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Untested", "Untested", "Untested"] });

      expect((await getDashboard(api, project.id)).passRate.value).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-06b Skipped is excluded from the pass rate denominator but counted in execution progress", { tag: '@tesbo.testId("TES-TC-416-1")' }, async () => {
    /*
     * The reported defect's own numbers: 3 Passed, 2 Failed, 2 Blocked, 1 Skipped, 2 Untested.
     * Test Run Details used to read 3/10 = 30% (dividing by every case) while the Test Plan page
     * read 3/7 = 43% (dividing by the settled cases). Pass Rate = Passed / (Passed+Failed+Blocked)
     * = 3/7 = 43% is correct; Execution Progress counts the Skipped case as "done" even though it
     * carries no verdict, so it is 8/10 = 80%, a different number answering a different question.
     */
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Passed", "Failed", "Failed", "Blocked", "Blocked", "Skipped", "Untested", "Untested"],
      });

      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.value).toBe(43);
      expect(summary.executionProgress.value).toBe(80);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-06c a run that is entirely Skipped reports no pass rate but full execution progress", { tag: '@tesbo.testId("TES-TC-416-2")' }, async () => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Skipped", "Skipped"] });

      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.value).toBeNull();
      expect(summary.executionProgress.value).toBe(100);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-07 deltaThisWeek stays null while either comparison window is empty", { tag: '@tesbo.testId("TES-TC-417")' }, async () => {
    const project = await createProject(api);
    try {
      // Everything executed just now: the recent window has data, the prior one has none.
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"] });

      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.value).toBe(50);
      expect(summary.passRate.deltaThisWeek).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-08 deltaThisWeek compares the last 7 days against the 7 before them", { tag: '@tesbo.testId("TES-TC-418")' }, async () => {
    test.skip(!dbControlAvailable(), "needs psql access to place executions in the prior 7-day window");
    const project = await createProject(api);
    try {
      // Prior window: 1 of 2 passed = 50%. Recent window: 2 of 2 passed = 100%. Delta = +50.
      const prior = await seedRun(api, project.id, { statuses: ["Passed", "Failed"] });
      backdate("executions", "executed_at", prior.executionIds, "10 days");
      await seedRun(api, project.id, { statuses: ["Passed", "Passed"] });

      expect((await getDashboard(api, project.id)).passRate.deltaThisWeek).toBe(50);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-09 openBugs counts Open and Reopened, and nothing else", { tag: '@tesbo.testId("TES-TC-419")' }, async () => {
    const project = await createProject(api);
    try {
      await createBug(api, project.id, { severity: "Critical" });
      await createBug(api, project.id, { severity: "High", status: "Reopened" });
      await createBug(api, project.id, { severity: "Low", status: "Closed" });
      await createBug(api, project.id, { severity: "Medium", status: "In Progress" });

      const summary = await getDashboard(api, project.id);
      expect(summary.openBugs.total).toBe(2);
      expect(summary.openBugs.bySeverity).toEqual({ Critical: 1, High: 1, Medium: 0, Low: 0 });
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-10 a severity outside the four buckets is refused with a validation error, not a 500", { tag: '@tesbo.testId("TES-TC-420")' }, async () => {
    const project = await createProject(api);
    try {
      // The dashboard's bySeverity has exactly four buckets, so a fifth severity would be counted
      // by the bugs list and dropped by the dashboard. It can't reach the database — V67 added
      // bugs_severity_check — but the constraint violation surfaces raw: the API answers 500 with
      // "Internal server error" instead of naming the offending field. An unknown enum value is
      // caller error, so this should be a 400 the UI can render against the severity field.
      const res = await api.post(`/api/projects/${project.id}/bugs`, {
        data: { title: `E2E Screens Bad Severity ${uniqueSuffix()}`, severity: "Trivial" },
        failOnStatusCode: false,
      });

      expect(res.status()).toBe(400);
      expect((await getDashboard(api, project.id)).openBugs.total).toBe(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-11 activeRuns counts In Progress runs only", { tag: '@tesbo.testId("TES-TC-421")' }, async () => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed"], status: "In Progress" });
      await seedRun(api, project.id, { statuses: ["Passed"], status: "Completed" });
      await seedRun(api, project.id, { statuses: ["Passed"] }); // Planning, the create default

      expect((await getDashboard(api, project.id)).activeRuns).toBe(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-12 coverage is null with no requirements, and a real percentage once they exist", { tag: '@tesbo.testId("TES-TC-422")' }, async () => {
    test.skip(!dbControlAvailable(), "needs psql access to seed Jira requirements (no API route exists)");
    const project = await createProject(api);
    try {
      const before = await getDashboard(api, project.id);
      expect(before.coverage).toEqual({ pct: null, totalRequirements: 0 });

      const keys = [`E2ESCR-${uniqueSuffix()}`, `E2ESCR-${uniqueSuffix()}`, `E2ESCR-${uniqueSuffix()}`];
      seedJiraRequirements(tenant!.organizationId, project.id, keys);
      // One of the three requirements gets a test case pointing at it.
      await createTestCase(api, project.id, { jiraIssueKey: keys[0] } as never);

      const after = await getDashboard(api, project.id);
      expect(after.coverage.totalRequirements).toBe(3);
      expect(after.coverage.pct).toBe(33);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-13 suites and plans match their own list endpoints", { tag: '@tesbo.testId("TES-TC-423")' }, async () => {
    const project = await createProject(api);
    try {
      await createSuite(api, project.id);
      await createSuite(api, project.id);
      await api.post(`/api/projects/${project.id}/plans`, { data: { name: `E2E Screens Plan ${Date.now()}` } });

      const summary = await getDashboard(api, project.id);
      const suites = await (await api.get(`/api/projects/${project.id}/suites`)).json();
      const plans = await (await api.get(`/api/projects/${project.id}/plans`)).json();

      expect(summary.suites).toBe(suites.length);
      expect(summary.plans).toBe(plans.length);
      expect(summary.plans).toBe(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-14 a caller with no session is refused and gets none of the summary", { tag: '@tesbo.testId("TES-TC-424")' }, async ({ playwright }) => {
    // An explicitly empty storage state, not just an omitted one: playwright.config.ts sets a
    // global `use.storageState`, and leaving it unset here yields account A's cookies rather than
    // an anonymous caller — which would quietly turn this into a second copy of DSH-A-15.
    const anonymous = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await anonymous.get(`/api/projects/${tenant!.projectId}/dashboard`, {
        failOnStatusCode: false,
      });

      // The refusal is what matters, and it holds. The code does not: these legacy project routes
      // answer a sessionless caller with 400 (requireUser rejecting a missing user id) where 401
      // is the correct status — pinned here so changing it to 401 is a deliberate edit.
      expect(res.status()).toBe(400);
      expect(await res.text()).not.toContain("passRate");
    } finally {
      await anonymous.dispose();
    }
  });

  test("DSH-A-15 another tenant cannot read this project's dashboard", { tag: '@tesbo.testId("TES-TC-425")' }, async ({ request }) => {
    // `request` here is account A — a real, fully authenticated caller from a different workspace.
    const res = await request.get(`/api/projects/${tenant!.projectId}/dashboard`, {
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(res.status());
  });

  test("DSH-A-16 a missing or malformed project id fails cleanly, never with a 500", { tag: '@tesbo.testId("TES-TC-426")' }, async () => {
    const missing = await api.get("/api/projects/00000000-0000-0000-0000-000000000000/dashboard", {
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(missing.status());

    const malformed = await api.get("/api/projects/not-a-uuid/dashboard", { failOnStatusCode: false });
    expect(malformed.status()).toBeLessThan(500);
  });

  test("DSH-A-17 the dashboard disappears with the project", { tag: '@tesbo.testId("TES-TC-427")' }, async () => {
    const project = await createProject(api);
    await getDashboard(api, project.id); // readable while it exists
    await api.delete(`/api/projects/${project.id}`);

    const res = await api.get(`/api/projects/${project.id}/dashboard`, { failOnStatusCode: false });
    expect([403, 404]).toContain(res.status());
  });

  test("DSH-A-19 the per-run status counters add up to totalCases", { tag: '@tesbo.testId("TES-TC-428")' }, async () => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, {
        statuses: ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"],
      });

      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      const bucketed =
        listed.passed + listed.failed + listed.blocked + listed.skipped + listed.untested;

      expect(listed.totalCases).toBe(6);
      // Retest is a status the API accepts (see executions.spec.ts) but listCycles has no bucket
      // for, so it lands in totalCases and in none of the counters the UI renders.
      expect(bucketed).toBe(listed.totalCases);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-20 a Retest execution is treated the same way by the run list and the dashboard", { tag: '@tesbo.testId("TES-TC-429")' }, async () => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: ["Passed", "Retest"] });

      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      const summary = await getDashboard(api, project.id);

      /*
       * Two readings of the same two executions, and they now agree: a case sent back for retest
       * has no settled result, so it sits in the run list's untested bucket and stays out of the
       * dashboard's executed denominator. One of the two cases has actually been executed, and it
       * passed, so the headline reads 100%.
       *
       * This previously asserted the divergence instead — 0 in every bucket but passed, and a
       * dashboard reading 1/2 = 50%. That was the defect DSH-A-19 reports from the other side: the
       * counters summed to less than totalCases, and a Retest quietly dragged the pass rate down
       * while changing nothing visible on the run. Fixing one required fixing both.
       */
      expect(listed.passed).toBe(1);
      expect(listed.untested).toBe(1);
      expect(listed.failed + listed.blocked + listed.skipped).toBe(0);
      expect(summary.passRate.value).toBe(100);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-21 a soft-deleted execution disappears from both the dashboard and the run list", { tag: '@tesbo.testId("TES-TC-430")' }, async () => {
    test.skip(!dbControlAvailable(), "needs psql access — executions have no DELETE route");
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: ["Passed", "Failed"] });
      expect((await getDashboard(api, project.id)).passRate.value).toBe(50);

      const failedExecution = run.executionIds[1];
      softDeleteExecutions([failedExecution]);

      const summary = await getDashboard(api, project.id);
      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;

      // The dashboard reads executions_active (the deleted_at IS NULL view from V64), so the row
      // is gone and the rate climbs to 1 of 1 passed.
      expect(summary.passRate.value).toBe(100);
      // The run list agrees now. This used to assert the opposite — listCycles read the raw
      // executions table, so the deleted row stayed in its counters and the two screens disagreed
      // about the same run permanently. listCycles joins `AND e.deleted_at IS NULL` and counts off
      // e.id, and every plan roll-up was moved onto that same rule (EXECUTION_BUCKET_COUNTS) when
      // "Overall progress percentage not matching" was fixed, so a deleted result is now nowhere.
      expect(listed.failed).toBe(0);
      expect(listed.totalCases).toBe(1);
      expect(listed.passed).toBe(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-22 a run with no test cases reports nothing to execute", { tag: '@tesbo.testId("TES-TC-431")' }, async () => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: [] });

      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      expect(listed.totalCases).toBe(0);
      // This used to be pinned at 1, recording the defect: the LEFT JOIN emits one all-NULL row for
      // a cycle with no items, and an untested bucket counted with COUNT(*) FILTER (...) scored that
      // row as a case that does not exist. The pin said fixing it had to be a deliberate change —
      // this is that change, made everywhere at once. Counting the buckets off e.id (see
      // EXECUTION_BUCKET_COUNTS) keeps the placeholder row out, so an empty run claims nothing on
      // the run list, and a plan holding one no longer reports more untested cases than it has
      // cases. That was the "Overall progress percentage not matching" report.
      expect(listed.untested).toBe(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

/*
 * GET /api/projects/overview — the projects-list cards' stats, in one response.
 *
 * The screen used to build these client-side from five calls per project, and held its spinner
 * until all of them returned; at fifteen projects that was seventy-eight requests gating first
 * paint, and it is what made ui/projects-list time out wholesale. The endpoint that replaced the
 * fan-out has to keep agreeing with the endpoints it displaced — a card that disagrees with the
 * screen it links to is worse than a slow card — so each test here pins one field against the
 * endpoint the card used to read it from, rather than against a hardcoded number.
 */
test.describe("projects overview", () => {
  const tenant = screensTenant();
  const skipReason = screensSuiteSkipReason(tenant);

  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await screensApi();
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  type Overview = {
    id: string;
    name: string;
    testCaseCount: number;
    suiteCount: number;
    teamMembers: { userId: string; name: string }[];
    lastActivityAt: string | null;
    status: "setup_required" | "configured" | "active";
    runCounts: { passed: number; failed: number; blocked: number; skipped: number; total: number } | null;
    currentPassRate: number | null;
  };

  async function overviewFor(projectId: string): Promise<Overview> {
    const res = await api.get("/api/projects/overview", { failOnStatusCode: false });
    expect(res.status(), `overview — ${await res.text()}`).toBe(200);
    const list: Overview[] = await res.json();
    const entry = list.find((p) => p.id === projectId);
    expect(entry, `the overview omitted project ${projectId}`).toBeTruthy();
    return entry!;
  }

  test("PVW-A-01 the route is not swallowed as a project id", { tag: '@tesbo.testId("TES-TC-1187")' }, async () => {
    // `/api/projects/:id` is declared right beside this route, and Nest matches in declaration
    // order — get that ordering wrong and "overview" is read as a project id and 404s. This is the
    // cheapest possible regression test for a mistake that is invisible in review.
    const res = await api.get("/api/projects/overview", { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test("PVW-A-02 an anonymous caller is refused", { tag: '@tesbo.testId("TES-TC-1188")' }, async () => {
    const anon = await anonymousContext();
    try {
      const res = await anon.get("/api/projects/overview", { failOnStatusCode: false });
      expect(res.status(), "the overview answered an unauthenticated caller").toBeGreaterThanOrEqual(401);
      expect(res.status()).toBeLessThan(500);
    } finally {
      await anon.dispose();
    }
  });

  test("PVW-A-03 a brand-new project needs setup and claims no run it has not had", { tag: '@tesbo.testId("TES-TC-1189")' }, async () => {
    const project = await createProject(api);
    try {
      const entry = await overviewFor(project.id);
      expect(entry.testCaseCount).toBe(0);
      expect(entry.suiteCount).toBe(0);
      expect(entry.status, "an empty project is not 'setup required'").toBe("setup_required");
      // The distinction the card exists to make: no run at all is not a 0% run. Reporting 0 here is
      // what made a project with an unexecuted run read as a total failure on the list.
      expect(entry.runCounts).toBeNull();
      expect(entry.currentPassRate).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-04 the test case count matches the repository, and excludes archived and deleted cases", { tag: '@tesbo.testId("TES-TC-1190")' }, async () => {
    const project = await createProject(api);
    try {
      const live = await createTestCase(api, project.id, { title: `E2E Overview Live ${uniqueSuffix()}` });
      const archived = await createTestCase(api, project.id, { title: `E2E Overview Archived ${uniqueSuffix()}` });
      const removed = await createTestCase(api, project.id, { title: `E2E Overview Deleted ${uniqueSuffix()}` });
      await api.patch(`/api/projects/${project.id}/testcases/${archived.id}`, { data: { status: "Archived" } });
      await api.delete(`/api/projects/${project.id}/testcases/${removed.id}`);

      // Pinned against listTestCases' own total rather than against "1": that endpoint backs the
      // repository table, and the card's number has to be the same number the table reports.
      const listed = await (
        await api.get(`/api/projects/${project.id}/testcases`, { params: { limit: 1 } })
      ).json();
      const entry = await overviewFor(project.id);
      expect(entry.testCaseCount).toBe(listed.total);
      expect(entry.testCaseCount, "archived or deleted cases are being counted").toBe(1);
      expect(live.id).toBeTruthy();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-05 the suite count includes nested suites, matching the suite tree", { tag: '@tesbo.testId("TES-TC-1191")' }, async () => {
    const project = await createProject(api);
    try {
      const parent = await createSuite(api, project.id, `E2E Overview Parent ${uniqueSuffix()}`);
      // Posted directly rather than through the helper: createSuite takes a name only, and a nested
      // suite is the whole point of this test.
      const child = await api.post(`/api/projects/${project.id}/suites`, {
        data: { name: `E2E Overview Child ${uniqueSuffix()}`, parentId: parent.id },
        failOnStatusCode: false,
      });
      expect(child.status(), `nesting a suite — ${await child.text()}`).toBeLessThan(300);

      // "Total Suites" on the card counts every suite, nested ones included — listSuites returns
      // them as one flat list, so its length is the contract the card's number has to meet.
      const suites = await (await api.get(`/api/projects/${project.id}/suites`)).json();
      const entry = await overviewFor(project.id);
      expect(entry.suiteCount).toBe(suites.length);
      expect(entry.suiteCount, "a nested suite is not being counted").toBe(2);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-06 the members match the project's own member list", { tag: '@tesbo.testId("TES-TC-1192")' }, async () => {
    const project = await createProject(api);
    try {
      const members = await (await api.get(`/api/projects/${project.id}/members`)).json();
      const entry = await overviewFor(project.id);
      expect(entry.teamMembers.map((m) => m.userId).sort()).toEqual(
        members.map((m: { userId: string }) => m.userId).sort(),
      );
      // The card renders initials from this, so an empty name would draw a blank avatar.
      for (const member of entry.teamMembers) expect(member.name.trim()).not.toBe("");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-07 the pass rate divides by executed cases, not by the run's total", { tag: '@tesbo.testId("TES-TC-1193")' }, async () => {
    const project = await createProject(api);
    try {
      // Two passed, one failed, one never executed: 2/3 executed = 67%, not 2/4 = 50%.
      await seedRun(api, project.id, { statuses: ["Passed", "Passed", "Failed", "Untested"] });

      const entry = await overviewFor(project.id);
      expect(entry.runCounts).not.toBeNull();
      expect(entry.runCounts!.total).toBe(4);
      expect(entry.runCounts!.passed).toBe(2);
      expect(entry.runCounts!.failed).toBe(1);
      // Dividing by totalCases is what made a project read 100% on its dashboard and a lower number
      // on the list card for the same run.
      expect(entry.currentPassRate).toBe(67);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-08 a newer unexecuted run does not displace the last executed one", { tag: '@tesbo.testId("TES-TC-1194")' }, async () => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Passed"] });
      // Scheduling an empty run is routine, and ranking by creation date alone let it replace a
      // finished 100% run with an unstarted one — the card then read 0% or "—" for a project whose
      // last real run passed everything.
      await seedRun(api, project.id, { statuses: ["Untested", "Untested"] });

      const entry = await overviewFor(project.id);
      expect(entry.currentPassRate, "an unexecuted run displaced the last executed one").toBe(100);
      expect(entry.runCounts!.total).toBe(2);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-12 the pass rate excludes Skipped from the denominator, matching Test Run Details and Test Plan", { tag: '@tesbo.testId("TES-TC-1198")' }, async () => {
    /*
     * The exact numbers from the reported defect: a run with 3 Passed, 2 Failed, 2 Blocked, 1
     * Skipped and 2 Untested read 30% (3 of 10 total cases) on Test Run Details and 43% (3 of the
     * 7 settled cases) on the Test Plan page. Passed / (Passed + Failed + Blocked) = 3/7 = 43% is
     * the one correct answer, and this project-list card is a third surface that has to agree —
     * runCounts.skipped is exposed precisely so a caller can tell the 1 Skipped case apart from
     * the 2 still-Untested ones instead of both being silently folded into "not counted".
     */
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Passed", "Failed", "Failed", "Blocked", "Blocked", "Skipped", "Untested", "Untested"],
      });

      const entry = await overviewFor(project.id);
      expect(entry.runCounts).not.toBeNull();
      expect(entry.runCounts!.total).toBe(10);
      expect(entry.runCounts!.passed).toBe(3);
      expect(entry.runCounts!.failed).toBe(2);
      expect(entry.runCounts!.blocked).toBe(2);
      expect(entry.runCounts!.skipped).toBe(1);
      expect(entry.currentPassRate).toBe(43);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-13 a run that is entirely Skipped reports no pass rate rather than 0%", { tag: '@tesbo.testId("TES-TC-1199")' }, async () => {
    // Skipped is neither a pass nor a fail — a run with nothing but Skipped cases has no settled
    // verdict, so this must read "—" (null), the same as an all-Untested run, not 0%.
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Skipped", "Skipped"] });

      const entry = await overviewFor(project.id);
      expect(entry.runCounts).not.toBeNull();
      expect(entry.runCounts!.skipped).toBe(2);
      expect(entry.currentPassRate).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-09 a project with cases but no activity is configured, and activity makes it active", { tag: '@tesbo.testId("TES-TC-1195")' }, async () => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id, { title: `E2E Overview Status ${uniqueSuffix()}` });
      const entry = await overviewFor(project.id);
      // Creating a test case is itself logged, so this project has activity — the point of the
      // assertion is that the three states are derived, not that they are constant.
      expect(["configured", "active"]).toContain(entry.status);
      expect(entry.status, "a project with cases still reads as needing setup").not.toBe("setup_required");

      // Whatever lastActivityAt reports has to agree with the feed the Activity screen renders.
      const feed = await (
        await api.get(`/api/projects/${project.id}/activity`, { params: { limit: 1 } })
      ).json();
      if (feed.list.length === 0) {
        expect(entry.lastActivityAt).toBeNull();
      } else {
        expect(entry.lastActivityAt, "the card claims no activity while the feed shows some").not.toBeNull();
        // The feed's outer query drops a testcase_* row when a zyra_* sibling exists within five
        // seconds, so the two timestamps can differ by less than that window but no more.
        const drift = Math.abs(
          new Date(entry.lastActivityAt!).getTime() - new Date(feed.list[0].createdAt).getTime(),
        );
        expect(drift, "last activity disagrees with the feed by more than the dedup window").toBeLessThan(5000);
      }
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-10 an archived project drops out of the overview, as it does from the list", { tag: '@tesbo.testId("TES-TC-1196")' }, async () => {
    const project = await createProject(api);
    let archived = false;
    try {
      expect((await overviewFor(project.id)).id).toBe(project.id);

      // Whatever the list hides, the overview must hide too — otherwise the page would carry stats
      // for a card it never draws.
      const res = await api.delete(`/api/projects/${project.id}`, { failOnStatusCode: false });
      expect(res.status(), `archiving the project — ${await res.text()}`).toBeLessThan(400);
      archived = true;

      const list: Overview[] = await (await api.get("/api/projects/overview")).json();
      expect(list.some((p) => p.id === project.id), "an archived project is still in the overview").toBe(false);
      const projects = await (await api.get("/api/projects")).json();
      expect(projects.some((p: { id: string }) => p.id === project.id)).toBe(false);
    } finally {
      if (!archived) await deleteProjects(api, [project.id]);
    }
  });

  test("PVW-A-11 one response covers every project the caller can see", { tag: '@tesbo.testId("TES-TC-1197")' }, async () => {
    const first = await createProject(api);
    const second = await createProject(api);
    try {
      await createTestCase(api, first.id, { title: `E2E Overview Multi ${uniqueSuffix()}` });

      const list: Overview[] = await (await api.get("/api/projects/overview")).json();
      const projects = await (await api.get("/api/projects")).json();
      // The whole point of the endpoint: one call, every card. If it ever returned a subset the
      // page would silently show stale zeros for the rest.
      expect(list.length).toBe(projects.length);
      expect(list.map((p) => p.id).sort()).toEqual(projects.map((p: { id: string }) => p.id).sort());
      expect(list.find((p) => p.id === first.id)!.testCaseCount).toBe(1);
      expect(list.find((p) => p.id === second.id)!.testCaseCount).toBe(0);
    } finally {
      await deleteProjects(api, [first.id, second.id]);
    }
  });
});
