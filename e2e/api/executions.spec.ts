import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

async function makeExecutionFixture(request: import("@playwright/test").APIRequestContext) {
  const cycle = await (
    await request.post(`/api/projects/${ctx.projectId}/cycles`, {
      data: { name: `E2E Execution Cycle ${Date.now()}` },
    })
  ).json();
  const testcase = await (
    await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title: `E2E Execution Test Case ${Date.now()}` },
    })
  ).json();
  await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
  const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
  return { cycle, testcase, execution: executions[0] };
}

async function cleanupExecutionFixture(
  request: import("@playwright/test").APIRequestContext,
  fixture: { cycle: { id: string }; testcase: { id: string } },
) {
  await request.delete(`/api/cycles/${fixture.cycle.id}`, { failOnStatusCode: false });
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${fixture.testcase.id}`, {
    failOnStatusCode: false,
  });
}

test.describe("test execution updates", () => {
  test("adding a test case to a cycle auto-creates an Untested execution with no executedAt", { tag: '@tesbo.testId("TES-TC-191")' }, async ({
    request,
  }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      expect(fixture.execution.status).toBe("Untested");
      expect(fixture.execution.executedAt).toBeFalsy();
      expect(fixture.execution.testcaseId).toBe(fixture.testcase.id);
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("updating status stamps executedAt; updating an unrelated field without status does not", { tag: '@tesbo.testId("TES-TC-192")' }, async ({
    request,
  }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const passRes = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { status: "Passed" } },
      );
      expect(passRes.ok()).toBeTruthy();

      const afterPass = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      const passedExecution = afterPass[0];
      expect(passedExecution.status).toBe("Passed");
      expect(passedExecution.executedAt).toBeTruthy();
      const stampedAt = passedExecution.executedAt;

      // Sending actualResult with no status must leave the existing executedAt stamp untouched
      // (legacy.service.ts:1822's `CASE WHEN $2 IS NULL THEN executed_at ELSE now() END`).
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { actualResult: "Observed behavior differs from expected" },
      });

      const afterUnrelatedUpdate = await (
        await request.get(`/api/cycles/${fixture.cycle.id}/executions`)
      ).json();
      const updatedExecution = afterUnrelatedUpdate[0];
      expect(updatedExecution.actualResult).toBe("Observed behavior differs from expected");
      expect(updatedExecution.status).toBe("Passed");
      expect(updatedExecution.executedAt).toBe(stampedAt);
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("persists assigneeId, defectKey, and defectUrl", { tag: '@tesbo.testId("TES-TC-193")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const meRes = await request.get("/api/auth/me");
      const me = await meRes.json();

      const patchRes = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        {
          data: {
            status: "Failed",
            assigneeId: me.userId,
            defectKey: "BUG-123",
            defectUrl: "https://example.com/BUG-123",
          },
        },
      );
      expect(patchRes.ok()).toBeTruthy();

      const afterUpdate = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      const updatedExecution = afterUpdate[0];
      expect(updatedExecution.assigneeId).toBe(me.userId);
      expect(updatedExecution.defectKey).toBe("BUG-123");
      expect(updatedExecution.defectUrl).toBe("https://example.com/BUG-123");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  /*
   * "[Test Runs] Unable to assign test cases for execution" — the actual defect.
   *
   * assignee_id used to be written unconditionally as `body.assigneeId ?? null` on every PATCH, so a
   * PATCH that only changed status or actualResult — every inline status change, and every quick-view
   * Save — silently wiped whatever assignee bulk-assign (or a previous PATCH) had just set. This test
   * FAILS against the unfixed code: the assignee is gone after the second, status-only PATCH.
   */
  test("a status-only PATCH does not clear a previously set assignee", { tag: '@tesbo.testId("TES-TC-1900")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const me = await (await request.get("/api/auth/me")).json();
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { assigneeId: me.userId },
      });
      const [assigned] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(assigned.assigneeId).toBe(me.userId);

      // The exact shape of the reported bug: a save that only touches status/actualResult.
      const statusOnly = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { status: "Passed", actualResult: "Looks fine" }, failOnStatusCode: false },
      );
      expect(statusOnly.ok(), await statusOnly.text()).toBeTruthy();

      const [afterStatusOnly] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(afterStatusOnly.assigneeId, "a status-only PATCH must not clear the assignee").toBe(me.userId);
      expect(afterStatusOnly.status).toBe("Passed");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("assigneeId: null or \"\" explicitly clears the assignee; omitting the key leaves it alone", { tag: '@tesbo.testId("TES-TC-1901")' }, async ({
    request,
  }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const me = await (await request.get("/api/auth/me")).json();
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { assigneeId: me.userId },
      });

      const cleared = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { assigneeId: null }, failOnStatusCode: false },
      );
      expect(cleared.ok(), await cleared.text()).toBeTruthy();
      let [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(row.assigneeId).toBeNull();

      // Re-assign, then clear via an empty string — the same value an HTML <select>'s "Unassigned"
      // option naturally submits.
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { assigneeId: me.userId },
      });
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { assigneeId: "" },
      });
      [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(row.assigneeId, "an empty string must clear the assignee, same as null").toBeNull();

      // And re-assigning twice in a row is idempotent, not an error.
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { assigneeId: me.userId },
      });
      const reassigned = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { assigneeId: me.userId }, failOnStatusCode: false },
      );
      expect(reassigned.ok()).toBeTruthy();
      [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(row.assigneeId).toBe(me.userId);
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("a malformed assigneeId is refused and nothing is stored", { tag: '@tesbo.testId("TES-TC-1902")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const res = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { assigneeId: "not-a-uuid" }, failOnStatusCode: false },
      );
      expect(res.status()).toBe(404);
      const [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(row.assigneeId).toBeNull();
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("supports every status in the EXEC_STATUSES set the UI offers", { tag: '@tesbo.testId("TES-TC-194")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      for (const status of ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"]) {
        const patchRes = await request.patch(
          `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
          { data: { status } },
        );
        expect(patchRes.ok()).toBeTruthy();

        const afterUpdate = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
        expect(afterUpdate[0].status).toBe(status);
      }
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });
});

/*
 * Defect references belong to failures — Basecamp 10221790207 ("Only failed test case should show
 * defect key and Defect URL").
 *
 * The two fields were offered on every status, so a case could pass while still carrying a defect
 * key. That value is not cosmetic: it travels into the run's CSV export and the traceability matrix,
 * where it reads as a bug against a case that passed. The screens hide the inputs unless the status
 * is Failed, and the service clears the stored values when any other status is recorded — hiding
 * alone would have left the stale reference in the database and in every export that reads it.
 */
test.describe("defect fields follow the result", () => {
  test("a defect recorded on a failure is kept while it is still failing", { tag: '@tesbo.testId("TES-TC-1167")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Failed", defectKey: "PROJ-123", defectUrl: "https://tracker.example/PROJ-123" },
      });
      const [failed] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(failed.status).toBe("Failed");
      expect(failed.defectKey).toBe("PROJ-123");
      expect(failed.defectUrl).toBe("https://tracker.example/PROJ-123");

      // Editing the failure without resending them leaves them alone.
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Failed", actualResult: "still broken" },
      });
      const [stillFailed] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(stillFailed.defectKey).toBe("PROJ-123");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("passing the case afterwards clears the defect it used to carry", { tag: '@tesbo.testId("TES-TC-1168")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Failed", defectKey: "PROJ-456", defectUrl: "https://tracker.example/PROJ-456" },
      });
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Passed" },
      });

      const [passed] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(passed.status).toBe("Passed");
      expect(passed.defectKey ?? null, "a passing case must not still point at a defect").toBeNull();
      expect(passed.defectUrl ?? null).toBeNull();
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("the same clearing applies to blocked and skipped, and the export follows", { tag: '@tesbo.testId("TES-TC-1169")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      for (const status of ["Blocked", "Skipped", "Retest", "Untested"]) {
        await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
          data: { status: "Failed", defectKey: "PROJ-789" },
        });
        await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
          data: { status },
        });
        const [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
        expect(row.status).toBe(status);
        expect(row.defectKey ?? null, `${status} should not keep a defect key`).toBeNull();
      }

      // The export reads the same column, which is where a stale key did the real damage.
      const csv = await (await request.get(`/api/cycles/${fixture.cycle.id}/export/csv`)).text();
      expect(csv).not.toContain("PROJ-789");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });
});


/*
 * Regression: PATCH /api/cycles/:cycleId/executions/:executionId never validated `status`.
 *
 * Found while scoping the automation ingest (Basecamp 10189985971). `EXECUTION_STATUSES` was
 * checked in bulkUpdateExecutionStatus and NOT in updateExecution -- which is the single-result
 * path taken by this route, by the MCP `record_execution_result` tool, and now by the automation
 * ingest. `executions.status` is a bare VARCHAR(32), so before the fix:
 *
 *   - {"status": "pass"} stored the literal string `pass`. Every aggregate in the product counts by
 *     exact match ('Passed', 'Failed', ...), so the case displayed a status while being counted as
 *     neither passed nor executed. Silent corruption, no error -- and the ingest's own draft
 *     contract specified exactly that lowercase vocabulary, so an SDK written to it would have
 *     corrupted every run it reported.
 *   - a 33-character status reached Postgres and failed the length constraint, turning user input
 *     into an unhandled 500.
 *
 * Both cases below FAIL against the unfixed code: the first with 200 instead of 400 (and a `pass`
 * row), the second with 500 instead of 400.
 */
test.describe("execution status validation", () => {
  test("a status outside the allowed set is refused, and nothing is written", { tag: '@tesbo.testId("TES-TC-1170")' }, async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const rejected = ["pass", "passed", "PASSED", "banana", "x".repeat(33)];
      for (const status of rejected) {
        const res = await request.patch(
          `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
          { data: { status }, failOnStatusCode: false },
        );
        expect(res.status(), `status ${JSON.stringify(status)} must be a 400`).toBe(400);
        expect((await res.json()).error).toContain("status must be one of");

        const [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
        expect(row.status, `status ${JSON.stringify(status)} must not have been stored`).toBe("Untested");
      }
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("every allowed status is still accepted, and an omitted status still means 'no change'", { tag: '@tesbo.testId("TES-TC-1171")' }, async ({
    request,
  }) => {
    // The other direction of the same fix: the validation must not have closed the door on the
    // legitimate values, and a PATCH that only changes another field must not be read as
    // "status: empty string" and refused.
    const fixture = await makeExecutionFixture(request);
    try {
      for (const status of ["Passed", "Failed", "Blocked", "Skipped", "Retest", "Untested"]) {
        const res = await request.patch(
          `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
          { data: { status }, failOnStatusCode: false },
        );
        expect(res.ok(), `status ${status} must be accepted: ${await res.text()}`).toBeTruthy();
        const [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
        expect(row.status).toBe(status);
      }

      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Passed" },
      });
      const noStatus = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { actualResult: "notes only" }, failOnStatusCode: false },
      );
      expect(noStatus.ok(), await noStatus.text()).toBeTruthy();
      const [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(row.status, "a status-less PATCH must leave the status alone").toBe("Passed");
      expect(row.actualResult).toBe("notes only");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });
});
