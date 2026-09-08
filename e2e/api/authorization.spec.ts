import fs from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";

// Cross-tenant IDOR regression suite. Every test below calls test.fail() first, asserting the
// SECURE behavior (403/404) — they fail today because legacy.service.ts's requireProjectAccess()
// tenant-scoping check isn't wired up for these resource types (see
// docs/FEATURE_DOCUMENTATION.md Appendix A). The moment a check is added, Playwright reports the
// case as "unexpectedly passing" instead of a normal failure — that's the cue to remove the
// test.fail() call, not a maintenance bug.
//
// Cleanup always runs in a `finally` block: since the assertions below are EXPECTED to fail
// (that's the entire premise of test.fail()), an `expect()` throws mid-test today, and any
// cleanup written after it — outside a `finally` — would never execute, silently leaking
// fixtures (and in the project-members case, real cross-tenant access) into the shared smoke
// project on every run.
//
// `request` (the default fixture) is account A, logged in via playwright.config.ts's default
// storageState. `asB` is a second, fully independent account/org/project (see global-setup.ts).

const ctxA = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const ctxB = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context-b.json"), "utf-8"));

/*
 * The statuses that count as a refusal.
 *
 * Deliberately a set rather than a single code, matching the convention rbac.spec.ts settled on.
 * Two product choices make a bare 403 the wrong assertion here:
 *  - cross-tenant access answers 404, not 403 — requireProjectAccess treats "not yours" and "not
 *    there" identically so that probing ids cannot confirm a resource exists (its own comment says
 *    so). That is the stronger behaviour, so the test follows the product rather than the reverse.
 *  - no session at all answers 400 "Authentication required", because the legacy service's
 *    requireUser raises BadRequest rather than Unauthorized. 401 is the better HTTP semantic and is
 *    worth changing, but it is a separate change across every legacy route, and billing.spec.ts /
 *    import-export.spec.ts / rbac.spec.ts already record the current behaviour.
 * What this suite is actually for is that access is REFUSED. The exact code is pinned elsewhere.
 */
const REFUSED = [400, 401, 403, 404];

let asB: APIRequestContext;
let anon: APIRequestContext;

test.beforeAll(async () => {
  asB = await request.newContext({
    baseURL: env.apiBaseUrl,
    storageState: path.join(__dirname, "../.auth/state-b.json"),
  });
  // Playwright's request fixture otherwise inherits the project's default storageState (account
  // A's session) — clear it explicitly to get a truly anonymous, no-cookie context.
  anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
});

test.afterAll(async () => {
  await asB.dispose();
  await anon.dispose();
});

test.describe("test suites", () => {
  test("a different account can rename and delete another project's suite by ID", { tag: '@tesbo.testId("TES-TC-31")' }, async ({ request }) => {
    // KNOWN GAP: updateSuite/deleteSuite (legacy.service.ts:1357,1362) take no userId at all —
    // not even a session is required, let alone project membership.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/suites`, {
        data: { name: `E2E IDOR Suite ${Date.now()}` },
      })
    ).json();

    try {
      const renameRes = await asB.patch(`/api/suites/${created.id}`, {
        data: { name: "Renamed by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(renameRes.status());

      const deleteRes = await asB.delete(`/api/suites/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(deleteRes.status());
    } finally {
      // deleteSuite() has no existence check, so a second delete of an already-gone suite is a
      // harmless no-op — this always runs, whether or not account B's delete above succeeded.
      await request.delete(`/api/suites/${created.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("test cases", () => {
  test("a different account can read, update, and delete another project's test case by ID", { tag: '@tesbo.testId("TES-TC-32")' }, async ({
    request,
  }) => {
    // KNOWN GAP: getTestCase has no auth at all; updateTestCase/deleteTestCase only call
    // requireUser (any valid session), never checking the case's project against the caller.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/testcases`, {
        data: { title: `E2E IDOR Test Case ${Date.now()}` },
      })
    ).json();

    try {
      const getRes = await asB.get(`/api/projects/${ctxB.projectId}/testcases/${created.id}`, {
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(getRes.status());

      const updateRes = await asB.put(`/api/projects/${ctxB.projectId}/testcases/${created.id}`, {
        data: { title: "Retitled by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(updateRes.status());

      const deleteRes = await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${created.id}`, {
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(deleteRes.status());
    } finally {
      await request.delete(`/api/projects/${ctxA.projectId}/testcases/${created.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("test cases — cross-tenant suiteId parameter", () => {
  /*
   * Not the KNOWN GAP shape the rest of this file documents (account B reaching for account A's
   * resource by id): here account A calls its OWN authorized project, but supplies account B's
   * suite id as a filter value, with includeDescendants=true — the new recursive-rollup query
   * added for the parent-suite bug fix. This is what the CTE's own `project_id = $1` re-scoping
   * (legacy.service.ts listTestCases) exists to defend: without it, a foreign suite id that happens
   * to exist (just in another tenant's project) could anchor the recursive walk and pull rows that
   * were never supposed to be reachable from project A's request at all.
   */
  test("a suiteId belonging to a different project's suite matches nothing, recursively or not", { tag: '@tesbo.testId("TES-TC-905")' }, async ({
    request,
  }) => {
    const bSuite = await (
      await asB.post(`/api/projects/${ctxB.projectId}/suites`, {
        data: { name: `E2E Cross-Tenant Suite ${Date.now()}` },
      })
    ).json();
    const bCase = await (
      await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E Cross-Tenant Case ${Date.now()}`, suiteId: bSuite.id },
      })
    ).json();

    try {
      for (const includeDescendants of [undefined, "true"]) {
        const res = await request.get(`/api/projects/${ctxA.projectId}/testcases`, {
          params: { suiteId: bSuite.id, ...(includeDescendants ? { includeDescendants } : {}), limit: 500 },
          failOnStatusCode: false,
        });
        // A foreign suiteId isn't an auth failure to refuse — it's a filter value that happens to
        // match nothing in the caller's own project. What must never happen is B's case leaking in.
        expect(res.ok(), `answered ${res.status()} for a foreign suiteId`).toBeTruthy();
        const ids = (await res.json()).map((tc: { id: string }) => tc.id);
        expect(ids, "a different tenant's test case leaked through a foreign suiteId").not.toContain(bCase.id);
      }
    } finally {
      await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCase.id}`, { failOnStatusCode: false });
      await asB.delete(`/api/suites/${bSuite.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("test plans", () => {
  test("a different account can read, update, and delete another project's test plan by ID", { tag: '@tesbo.testId("TES-TC-33")' }, async ({
    request,
  }) => {
    // KNOWN GAP: getPlan/updatePlan/deletePlan (legacy.service.ts:1658-1673) take no userId
    // at all — reachable with no session and no project-membership check.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/plans`, {
        data: { name: `E2E IDOR Plan ${Date.now()}` },
      })
    ).json();

    try {
      const getRes = await asB.get(`/api/plans/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(getRes.status());

      const updateRes = await asB.patch(`/api/plans/${created.id}`, {
        data: { name: "Renamed by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(updateRes.status());

      const deleteRes = await asB.delete(`/api/plans/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(deleteRes.status());
    } finally {
      await request.delete(`/api/plans/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("the plan progress roll-up is refused to another tenant and to no session at all", { tag: '@tesbo.testId("TES-TC-903")' }, async ({
    request,
  }) => {
    // Not a known gap: planProgress/planRuns both go through requirePlanAccess, unlike the
    // getPlan/updatePlan/deletePlan trio above. These assert the guard stays wired up — the
    // roll-up carries a workspace's case counts and run names.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/plans`, {
        data: { name: `E2E Plan Progress IDOR ${Date.now()}` },
      })
    ).json();

    try {
      for (const path of [`/api/plans/${created.id}/progress`, `/api/plans/${created.id}/runs`]) {
        const asBRes = await asB.get(path, { failOnStatusCode: false });
        expect(REFUSED, `must refuse another tenant: ${path}`).toContain(asBRes.status());

        const anonRes = await anon.get(path, { failOnStatusCode: false });
        expect(REFUSED, `must refuse an anonymous caller: ${path}`).toContain(anonRes.status());
      }
    } finally {
      await request.delete(`/api/plans/${created.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("test cycles / runs", () => {
  test("a different account can read, update, and delete another project's test cycle by ID", { tag: '@tesbo.testId("TES-TC-41")' }, async ({
    request,
  }) => {
    // KNOWN GAP: getCycle/updateCycle/deleteCycle (legacy.service.ts:1729-1789) take no userId
    // at all — same shape of gap as test plans.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/cycles`, {
        data: { name: `E2E IDOR Cycle ${Date.now()}` },
      })
    ).json();

    try {
      const getRes = await asB.get(`/api/cycles/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(getRes.status());

      const updateRes = await asB.patch(`/api/cycles/${created.id}`, {
        data: { name: "Renamed by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(updateRes.status());

      const deleteRes = await asB.delete(`/api/cycles/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(deleteRes.status());
    } finally {
      await request.delete(`/api/cycles/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("account B's own run cannot adopt a test case belonging to account A", { tag: '@tesbo.testId("TES-TC-904")' }, async ({ request }) => {
    /*
     * A different shape from the rest of this file: account B is not reaching for account A's run,
     * it is naming account A's TEST CASE while adding to a run it legitimately owns.
     *
     * addCycleTestCases used to resolve each id with `SELECT title FROM testcases WHERE id = $1`,
     * scoped to nothing, even though requireCycleAccess had already established which project the
     * run belonged to. The caller passed the run check, so the foreign case was inserted and its
     * title copied into cycle_items.snapshot_title — a readable field from another tenant.
     */
    const foreignCase = await (
      await request.post(`/api/projects/${ctxA.projectId}/testcases`, {
        data: { title: `E2E IDOR Adopted Case ${Date.now()}` },
      })
    ).json();

    const bRun = await (
      await asB.post(`/api/projects/${ctxB.projectId}/cycles`, {
        data: { name: `E2E IDOR Adopting Run ${Date.now()}` },
      })
    ).json();

    try {
      const addRes = await asB.post(`/api/cycles/${bRun.id}/testcases`, {
        data: { testcaseIds: [foreignCase.id] },
        failOnStatusCode: false,
      });
      // Skipping the foreign id is a valid answer, as is refusing outright — what must not happen is
      // the case landing in B's run. Assert the state rather than the status code.
      expect(addRes.status(), `answered ${addRes.status()}: ${await addRes.text()}`).toBeLessThan(500);

      const executions = await (await asB.get(`/api/cycles/${bRun.id}/executions`)).json();
      expect(
        executions,
        "account B's run adopted a test case from account A, snapshot title and all",
      ).toHaveLength(0);
    } finally {
      await asB.delete(`/api/cycles/${bRun.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctxA.projectId}/testcases/${foreignCase.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("test executions", () => {
  test("a different account can update another project's test execution by ID", { tag: '@tesbo.testId("TES-TC-35")' }, async ({ request }) => {
    // KNOWN GAP: updateExecution (legacy.service.ts:1822) calls requireUser (any valid
    // session) but never checks the execution's cycle/project against the caller.
    const cycle = await (
      await request.post(`/api/projects/${ctxA.projectId}/cycles`, {
        data: { name: `E2E IDOR Execution Cycle ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctxA.projectId}/testcases`, {
        data: { title: `E2E IDOR Execution Test Case ${Date.now()}` },
      })
    ).json();

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, {
        data: { testcaseIds: [testcase.id] },
      });
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      const execution = executions[0];

      const updateRes = await asB.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, {
        data: { status: "Failed", actualResult: "Overwritten by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(updateRes.status());
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctxA.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("bugs", () => {
  test("a different account can read, update, and delete another project's bug by ID", { tag: '@tesbo.testId("TES-TC-36")' }, async ({ request }) => {
    // KNOWN GAP: getBug/updateBug/deleteBug (legacy.service.ts:2044-2096) don't even call
    // requireUser — no session and no project-membership check.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/bugs`, {
        data: { title: `E2E IDOR Bug ${Date.now()}` },
      })
    ).json();

    try {
      const getRes = await asB.get(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(getRes.status());

      const updateRes = await asB.patch(`/api/bugs/${created.id}`, {
        data: { title: "Retitled by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(updateRes.status());

      const deleteRes = await asB.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(deleteRes.status());
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("a completely unauthenticated request (no session at all) can read another project's bug", { tag: '@tesbo.testId("TES-TC-37")' }, async ({
    request,
  }) => {
    // Worse than the cross-tenant case above: these routes don't require ANY session, so an
    // anonymous caller with no account at all can read/write bugs purely by guessing a UUID.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/bugs`, {
        data: { title: `E2E IDOR Anon Bug ${Date.now()}` },
      })
    ).json();

    try {
      const getRes = await anon.get(`/api/bugs/${created.id}`, { failOnStatusCode: false });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(getRes.status());
    } finally {
      await request.delete(`/api/bugs/${created.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("public share links", () => {
  test("a different account can toggle public sharing on another project's cycle", { tag: '@tesbo.testId("TES-TC-38")' }, async ({ request }) => {
    // KNOWN GAP: shareCycle (legacy.service.ts:1735) takes no userId at all.
    const cycle = await (
      await request.post(`/api/projects/${ctxA.projectId}/cycles`, {
        data: { name: `E2E IDOR Share Cycle ${Date.now()}` },
      })
    ).json();

    try {
      const shareRes = await asB.post(`/api/cycles/${cycle.id}/share`, {
        data: { enabled: true },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(shareRes.status());
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
    }
  });

  test("the public share executions endpoint exposes internal fields the share page never displays", { tag: '@tesbo.testId("TES-TC-39")' }, async ({
    request,
  }) => {
    // KNOWN GAP: publicCycleExecutions (legacy.service.ts:1756) reuses the same internal
    // executions() query as the authenticated route — full row data, not the 5 columns
    // /share/:token actually renders (externalId/title/priority/type/status).
    const cycle = await (
      await request.post(`/api/projects/${ctxA.projectId}/cycles`, {
        data: { name: `E2E IDOR Public Exposure Cycle ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctxA.projectId}/testcases`, {
        data: { title: `E2E IDOR Public Exposure Test Case ${Date.now()}` },
      })
    ).json();

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      await request.patch(`/api/cycles/${cycle.id}/executions/${executions[0].id}`, {
        data: { status: "Failed", actualResult: "Sensitive actual-result text" },
      });
      const share = await (
        await request.post(`/api/cycles/${cycle.id}/share`, { data: { enabled: true } })
      ).json();

      const publicRes = await anon.get(`/api/public/shared-runs/${share.shareToken}/executions`);
      const publicExecutions = await publicRes.json();

      const exposedFields = Object.keys(publicExecutions[0] ?? {});
      for (const sensitiveField of ["actualResult", "assigneeId", "steps", "preconditions", "testData"]) {
        expect(exposedFields).not.toContain(sensitiveField);
      }
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctxA.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("requirements / traceability", () => {
  test("a different account can read another project's requirement matrix and ticket summary", { tag: '@tesbo.testId("TES-TC-40")' }, async ({
    request,
  }) => {
    // KNOWN GAP: requirementMatrix/requirementsSummary (legacy.service.ts:2276,5054) take a
    // projectId with no check that the caller belongs to it. Read-only — no fixture to clean up.
    const matrixRes = await asB.get(`/api/projects/${ctxA.projectId}/reports/requirement-matrix`, {
      failOnStatusCode: false,
    });
    expect(REFUSED, "must refuse a caller from another tenant").toContain(matrixRes.status());

    const summaryRes = await asB.get(`/api/projects/${ctxA.projectId}/tickets/summary`, {
      failOnStatusCode: false,
    });
    expect(REFUSED, "must refuse a caller from another tenant").toContain(summaryRes.status());
  });
});

test.describe("knowledge base v1 (legacy)", () => {
  test("a different account can read, update, and delete another project's legacy knowledge base item", { tag: '@tesbo.testId("TES-TC-54")' }, async ({
    request,
  }) => {
    // KNOWN GAP: getKnowledge/updateKnowledge/deleteKnowledge (legacy.service.ts:2961-2978)
    // take no project/userId context at all — superseded by KB v2, which does check.
    const created = await (
      await request.post(`/api/projects/${ctxA.projectId}/knowledge-base`, {
        data: { title: `E2E IDOR Knowledge Item ${Date.now()}` },
      })
    ).json();

    try {
      const getRes = await asB.get(`/api/projects/${ctxB.projectId}/knowledge-base/${created.id}`, {
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(getRes.status());

      const updateRes = await asB.patch(`/api/projects/${ctxB.projectId}/knowledge-base/${created.id}`, {
        data: { title: "Retitled by account B" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(updateRes.status());

      const deleteRes = await asB.delete(`/api/projects/${ctxB.projectId}/knowledge-base/${created.id}`, {
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(deleteRes.status());
    } finally {
      await request.delete(`/api/projects/${ctxA.projectId}/knowledge-base/${created.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("project members", () => {
  test("a caller can add themselves as owner of another project with no permission check", { tag: '@tesbo.testId("TES-TC-42")' }, async ({
    request,
  }) => {
    // KNOWN GAP, worse than the rest: addProjectMember's controller method
    // (legacy.controller.ts:211) doesn't even take @Req() — it never looks at the caller's
    // identity, so this isn't even gated behind having a valid login session. Cleanup here
    // matters more than anywhere else in this file: an un-cleaned failure leaves account B with
    // real, persistent "owner" access to account A's project, not just a stray fixture row.
    const meRes = await asB.get("/api/auth/me");
    const me = await meRes.json();

    try {
      const addRes = await asB.post(`/api/projects/${ctxA.projectId}/members`, {
        data: { userId: me.userId, role: "owner" },
        failOnStatusCode: false,
      });
      expect(REFUSED, "must refuse a caller from another tenant").toContain(addRes.status());
    } finally {
      await request.delete(`/api/projects/${ctxA.projectId}/members/${me.userId}`, {
        failOnStatusCode: false,
      });
    }
  });
});
