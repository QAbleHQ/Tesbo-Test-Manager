import fs from "node:fs";
import path from "node:path";
import { expect, request as newRequestContext, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { backdate, workspaceDays } from "../utils/due-dates";
import { dbControlAvailable, exec, literal, scalar } from "../utils/psql";
import { softDeleteExecutions } from "../utils/screens-tenant";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("test plan CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", { tag: '@tesbo.testId("TES-TC-388")' }, async ({ request }) => {
    const name = `E2E Plan ${Date.now()}`;
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name, description: "Created by the e2e suite", targetRelease: "v1.0" },
      })
    ).json();

    try {
      expect(created.id).toBeTruthy();
      expect(created.name).toBe(name);
      expect(created.targetRelease).toBe("v1.0");

      const getRes = await request.get(`/api/plans/${created.id}`);
      expect(getRes.ok()).toBeTruthy();
      expect((await getRes.json()).description).toBe("Created by the e2e suite");

      const updatedName = `${name} (updated)`;
      const patchRes = await request.patch(`/api/plans/${created.id}`, {
        data: { name: updatedName, targetRelease: "v2.0" },
      });
      expect(patchRes.ok()).toBeTruthy();

      const getAfterUpdateRes = await request.get(`/api/plans/${created.id}`);
      const afterUpdate = await getAfterUpdateRes.json();
      expect(afterUpdate.name).toBe(updatedName);
      expect(afterUpdate.targetRelease).toBe("v2.0");

      const listRes = await request.get(`/api/projects/${ctx.projectId}/plans`);
      const list = await listRes.json();
      expect(list.some((p: { id: string }) => p.id === created.id)).toBeTruthy();
    } finally {
      await request.delete(`/api/plans/${created.id}`, { failOnStatusCode: false });
    }

    const getAfterDeleteRes = await request.get(`/api/plans/${created.id}`, { failOnStatusCode: false });
    expect(getAfterDeleteRes.status()).toBe(404);
  });

  test("supports adding and removing plan items (a direct test case and a whole suite)", { tag: '@tesbo.testId("TES-TC-389")' }, async ({
    request,
  }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Items ${Date.now()}` },
      })
    ).json();
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Plan Items Suite ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Plan Items Test Case ${Date.now()}` },
      })
    ).json();

    try {
      const caseItem = await (
        await request.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } })
      ).json();
      const suiteItem = await (
        await request.post(`/api/plans/${plan.id}/items`, { data: { suiteId: suite.id } })
      ).json();

      const itemsRes = await request.get(`/api/plans/${plan.id}/items`);
      const items = await itemsRes.json();
      expect(items.some((i: { id: string }) => i.id === caseItem.id)).toBeTruthy();
      expect(items.some((i: { id: string }) => i.id === suiteItem.id)).toBeTruthy();

      await request.delete(`/api/plans/${plan.id}/items/${caseItem.id}`);

      const itemsAfterRes = await request.get(`/api/plans/${plan.id}/items`);
      const itemsAfter = await itemsAfterRes.json();
      expect(itemsAfter.some((i: { id: string }) => i.id === caseItem.id)).toBeFalsy();
      expect(itemsAfter.some((i: { id: string }) => i.id === suiteItem.id)).toBeTruthy();
    } finally {
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/suites/${suite.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  // Zyra context integrity, Phase 3/4 (Q10, resolved by Yuvraj): a plan item's suite_id is a
  // snapshot of what the plan targeted when it was built, not a live reference — there is no
  // background job that keeps it in sync with the suite tree the way a testcase's suite_id is kept
  // current. So unlike every LIVE suite listing (which simply stops showing a soft-deleted suite,
  // no behavior change from before this phase), planItemRows deliberately does NOT blank the name
  // out or drop the row: it preserves it as historical record, marked "(deleted)", the same
  // "history, not current state" category audit_logs already is.
  test("a plan item naming a since-deleted suite keeps the suite's name, marked as deleted, rather than blanking it", async ({
    request,
  }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Deleted Suite ${Date.now()}` },
      })
    ).json();
    const suiteName = `E2E Plan Item Deleted Suite ${Date.now()}`;
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })
    ).json();

    try {
      const suiteItem = await (
        await request.post(`/api/plans/${plan.id}/items`, { data: { suiteId: suite.id } })
      ).json();

      const beforeDelete = await (await request.get(`/api/plans/${plan.id}/items`)).json();
      expect(beforeDelete.find((i: { id: string }) => i.id === suiteItem.id).suiteName).toBe(suiteName);

      const deleteRes = await request.delete(`/api/suites/${suite.id}`, { params: { mode: "moveToDefault" } });
      expect(deleteRes.ok(), `deleting the suite — ${await deleteRes.text()}`).toBeTruthy();

      // The suite itself is gone from every live listing (unchanged behavior, asserted elsewhere in
      // suites.spec.ts) — but the plan item naming it must still resolve, with the name preserved
      // and marked, not blanked to null/empty the way a fresh "no suite" plan item would read.
      const afterDelete = await (await request.get(`/api/plans/${plan.id}/items`)).json();
      const itemAfterDelete = afterDelete.find((i: { id: string }) => i.id === suiteItem.id);
      expect(itemAfterDelete, "the plan item itself must survive the suite's deletion").toBeTruthy();
      expect(itemAfterDelete.suiteName).toBe(`${suiteName} (deleted)`);
    } finally {
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
    }
  });

  test("planRuns/planProgress aggregate executions from cycles linked to the plan", { tag: '@tesbo.testId("TES-TC-390")' }, async ({ request }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Progress ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Plan Progress Test Case ${Date.now()}` },
      })
    ).json();
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Progress Cycle ${Date.now()}`, planId: plan.id },
      })
    ).json();

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      await request.patch(`/api/cycles/${cycle.id}/executions/${executions[0].id}`, {
        data: { status: "Passed" },
      });

      const runsRes = await request.get(`/api/plans/${plan.id}/runs`);
      const runs = await runsRes.json();
      expect(runs.some((r: { id: string }) => r.id === cycle.id)).toBeTruthy();

      const progressRes = await request.get(`/api/plans/${plan.id}/progress`);
      const progress = await progressRes.json();
      expect(progress.runCount).toBe(1);
      expect(progress.totalCases).toBe(1);
      expect(progress.passed).toBe(1);
      expect(progress.completionPercent).toBe(100);
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  /*
   * The list summary's caseCount, which the plans screen used to render as a "N cases" chip on each
   * card. It counts plan_items — the cases pinned to the plan's scope — and is independent of the
   * runs beside it, so an executed plan with an empty scope reports 0 cases and >0 runs. The chip was
   * removed for being unexplainable on that screen; the field itself is still read by the plan detail
   * header, so these tests hold the contract.
   */
  test("the plan list summary counts plan items in caseCount, independently of runCount", { tag: '@tesbo.testId("TES-TC-944")' }, async ({
    request,
  }) => {
    const summaryFor = async (planId: string) => {
      const list = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
      return list.find((p: { id: string }) => p.id === planId);
    };

    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Case Count ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Plan Case Count Case ${Date.now()}` },
      })
    ).json();
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Plan Case Count Suite ${Date.now()}` },
      })
    ).json();
    let cycle: { id: string } | undefined;

    try {
      // Before any run exists: runCount counts the cycles LINKED to the plan, so it has to be read
      // before the cycle is created — merely linking one makes it 1, executions or not.
      const fresh = await summaryFor(plan.id);
      expect(fresh.caseCount).toBe(0);
      expect(fresh.runCount).toBe(0);

      // A run linked to the plan, holding a case that was never a plan item: this is the state that
      // produced "0 cases / 1 runs" on the card.
      cycle = await (
        await request.post(`/api/projects/${ctx.projectId}/cycles`, {
          data: { name: `E2E Plan Case Count Cycle ${Date.now()}`, planId: plan.id },
        })
      ).json();
      await request.post(`/api/cycles/${cycle!.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      const withRun = await summaryFor(plan.id);
      expect(withRun.caseCount).toBe(0);
      expect(withRun.runCount).toBe(1);

      const caseItem = await (
        await request.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } })
      ).json();
      expect((await summaryFor(plan.id)).caseCount).toBe(1);

      // A suite item is one plan_item too, whatever its own case count is.
      await request.post(`/api/plans/${plan.id}/items`, { data: { suiteId: suite.id } });
      expect((await summaryFor(plan.id)).caseCount).toBe(2);

      await request.delete(`/api/plans/${plan.id}/items/${caseItem.id}`);
      const afterRemoval = await summaryFor(plan.id);
      expect(afterRemoval.caseCount).toBe(1);
      expect(afterRemoval.runCount).toBe(1);
    } finally {
      if (cycle) await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/suites/${suite.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

/*
 * Hard-delete remediation Phase 2. V111 made `cycles`/`cycle_items` soft-deletable (Phase 1), but
 * three of the plan screen's own read sites — planRunRows (GET /api/plans/:id/runs),
 * planProgressRollup (GET /api/plans/:id/progress) and listPlans' run-count/last-run subquery (GET
 * /api/projects/:id/plans) — kept joining `cycles`/`cycle_items` with no `deleted_at IS NULL` filter.
 * A soft-deleted run therefore kept counting on every one of those three surfaces even though the
 * run itself already 404s (requireCycleAccess, Phase 1) — the plan header, the runs list beneath it,
 * and the plan card's "N runs" chip all going stale in the same way, which is why one test below
 * checks all three together rather than three separate specs drifting apart later.
 */
test.describe("plan roll-ups exclude soft-deleted runs (hard-delete remediation Phase 2)", () => {
  test("deleting a linked run drops it from the plan's run list, its progress roll-up, and the plan card's run/case counts", async ({
    request,
  }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Soft-Deleted Run ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Plan Soft-Deleted Run Case ${Date.now()}` },
      })
    ).json();
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Soft-Deleted Run Cycle ${Date.now()}`, planId: plan.id },
      })
    ).json();
    const summaryFor = async () => {
      const list = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
      return list.find((p: { id: string }) => p.id === plan.id);
    };

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      await request.patch(`/api/cycles/${cycle.id}/executions/${executions[0].id}`, { data: { status: "Passed" } });

      // Before the delete: the run counts everywhere, so the disappearance below is proven to be
      // the delete's effect and not these endpoints failing to find the fixture at all.
      const runsBefore = await (await request.get(`/api/plans/${plan.id}/runs`)).json();
      expect(runsBefore.some((r: { id: string }) => r.id === cycle.id)).toBe(true);
      const progressBefore = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(progressBefore).toMatchObject({ runCount: 1, totalCases: 1, passed: 1 });
      const summaryBefore = await summaryFor();
      expect(summaryBefore).toMatchObject({ runCount: 1, passed: 1 });
      expect(summaryBefore.lastRunAt).toBeTruthy();

      const deleteRes = await request.delete(`/api/cycles/${cycle.id}`);
      expect(deleteRes.ok(), `deleting the run — ${await deleteRes.text()}`).toBeTruthy();
      // Confirms the row genuinely survives soft-deleted underneath, so the three assertions below
      // are exercising the new deleted_at filters, not a run that was hard-deleted (and would
      // disappear from every join trivially, filter or not).
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM cycles WHERE id = ${literal(cycle.id)};`)).toBe("t");

      // #2 planRunRows: the run drops out of the plan's own runs list.
      const runsAfter = await (await request.get(`/api/plans/${plan.id}/runs`)).json();
      expect(runsAfter.some((r: { id: string }) => r.id === cycle.id), "the soft-deleted run must not appear in planRunRows").toBe(false);

      // #3 planProgressRollup: the header roll-up goes back to reporting nothing to execute.
      const progressAfter = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(progressAfter).toMatchObject({ runCount: 0, totalCases: 0, passed: 0 });

      // #4 listPlans: the plan card's run_count/passed/last_run_at all fall back to their empty state.
      const summaryAfter = await summaryFor();
      expect(summaryAfter).toMatchObject({ runCount: 0, passed: 0 });
      expect(summaryAfter.lastRunAt).toBeNull();
    } finally {
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * The plan roll-up: "Overall progress" on the plan detail header, and the per-run rows beneath it.
 *
 * Reported as "Test plan: Overall progress percentage not matching" — a plan whose header read 30%
 * / 7 untested above a single run reading 40% / 6 untested. Three separate defects put those two
 * numbers apart, and the invariant that closes all three is the one every test here asserts:
 *
 *   the header is the sum of the runs the plan lists, and each run's buckets sum to its own total.
 *
 * Anything that breaks that — a bucket a status can fall out of, a row counted on one screen and
 * not the other — shows up as a sum that no longer adds up.
 */
test.describe("test plan progress roll-up", () => {
  /** The header roll-up's own arithmetic: the five buckets must account for every case. */
  function expectBucketsSumToTotal(counts: {
    totalCases: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    untested: number;
  }) {
    expect(counts.passed + counts.failed + counts.blocked + counts.skipped + counts.untested).toBe(
      counts.totalCases,
    );
  }

  test("PLN-A-01 the header roll-up is the sum of the runs the plan lists", { tag: '@tesbo.testId("TES-TC-945")' }, async ({ request }) => {
    const stamp = Date.now();
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Rollup ${stamp}` },
      })
    ).json();

    // Two runs, six cases, one case in every status the product has — including Retest, which has
    // no bucket of its own and belongs with untested (a case sent back for retest has no settled
    // result), and one run left in Planning, the status every run is created with.
    const cases: { status: string; id?: string }[] = [
      { status: "Passed" },
      { status: "Failed" },
      { status: "Blocked" },
      { status: "Skipped" },
      { status: "Retest" },
      { status: "Untested" },
    ];
    const runA = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Rollup Run A ${stamp}`, planId: plan.id },
      })
    ).json();
    const runB = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Rollup Run B ${stamp}`, planId: plan.id },
      })
    ).json();

    try {
      for (const [i, c] of cases.entries()) {
        const testcase = await (
          await request.post(`/api/projects/${ctx.projectId}/testcases`, {
            data: { title: `E2E Plan Rollup Case ${i + 1} ${stamp}` },
          })
        ).json();
        c.id = testcase.id;
      }
      const inA = cases.slice(0, 3);
      const inB = cases.slice(3);
      await request.post(`/api/cycles/${runA.id}/testcases`, {
        data: { testcaseIds: inA.map((c) => c.id) },
      });
      await request.post(`/api/cycles/${runB.id}/testcases`, {
        data: { testcaseIds: inB.map((c) => c.id) },
      });

      for (const [cycleId, group] of [
        [runA.id, inA],
        [runB.id, inB],
      ] as const) {
        const executions: { id: string; testcaseId: string }[] = await (
          await request.get(`/api/cycles/${cycleId}/executions`)
        ).json();
        for (const c of group) {
          if (c.status === "Untested") continue;
          const execution = executions.find((e) => e.testcaseId === c.id)!;
          await request.patch(`/api/cycles/${cycleId}/executions/${execution.id}`, {
            data: { status: c.status },
          });
        }
      }
      await request.patch(`/api/cycles/${runA.id}`, { data: { status: "Completed" } });

      const progress = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(progress.runCount).toBe(2);
      expect(progress.totalCases).toBe(6);
      expect(progress.passed).toBe(1);
      expect(progress.failed).toBe(1);
      expect(progress.blocked).toBe(1);
      expect(progress.skipped).toBe(1);
      // Retest joins Untested here — two cases with nothing settled.
      expect(progress.untested).toBe(2);
      expectBucketsSumToTotal(progress);
      expect(progress.executed).toBe(4);
      expect(progress.completionPercent).toBe(67);
      // Pass Rate = Passed / (Passed + Failed + Blocked) = 1 / 3 = 33%. Skipped and the two
      // untested/retest cases sit outside this ratio entirely — completionPercent (67%) counts
      // Skipped as "done", passRate does not count it as a verdict either way.
      expect(progress.passRate).toBe(33);

      const runs: {
        id: string;
        status: string;
        totalCases: number;
        passed: number;
        failed: number;
        blocked: number;
        skipped: number;
        untested: number;
      }[] = await (await request.get(`/api/plans/${plan.id}/runs`)).json();
      const listed = runs.filter((r) => r.id === runA.id || r.id === runB.id);
      expect(listed).toHaveLength(2);
      // A run in Planning is a run the plan aggregates, so it has to be one the plan lists.
      expect(listed.find((r) => r.id === runB.id)!.status).toBe("Planning");

      for (const run of listed) expectBucketsSumToTotal(run);

      const sum = (key: "totalCases" | "passed" | "failed" | "blocked" | "skipped" | "untested") =>
        listed.reduce((acc, r) => acc + r[key], 0);
      expect(sum("totalCases")).toBe(progress.totalCases);
      expect(sum("passed")).toBe(progress.passed);
      expect(sum("failed")).toBe(progress.failed);
      expect(sum("blocked")).toBe(progress.blocked);
      expect(sum("skipped")).toBe(progress.skipped);
      expect(sum("untested")).toBe(progress.untested);
    } finally {
      await request.delete(`/api/cycles/${runA.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${runB.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      for (const c of cases) {
        if (!c.id) continue;
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${c.id}`, {
          failOnStatusCode: false,
        });
      }
    }
  });

  test("PLN-A-02 a linked run holding no cases adds nothing to the roll-up", { tag: '@tesbo.testId("TES-TC-946")' }, async ({ request }) => {
    /*
     * The defect behind the report. The untested bucket counted rows, not cases, so the row a LEFT
     * JOIN produces for a cycle with no items at all — every column NULL — scored as one untested
     * case. A plan holding one empty run therefore reported one more untested case than it had
     * cases, the header tiles stopped summing to TOTAL, and the run beside them disagreed by
     * exactly one. An empty run is the normal state of a run somebody just created.
     */
    const stamp = Date.now();
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Empty Run ${stamp}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Plan Empty Run Case ${stamp}` },
      })
    ).json();
    const populated = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Empty Run Populated ${stamp}`, planId: plan.id },
      })
    ).json();
    const empty = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Empty Run Empty ${stamp}`, planId: plan.id },
      })
    ).json();

    try {
      await request.post(`/api/cycles/${populated.id}/testcases`, {
        data: { testcaseIds: [testcase.id] },
      });
      const executions = await (await request.get(`/api/cycles/${populated.id}/executions`)).json();
      await request.patch(`/api/cycles/${populated.id}/executions/${executions[0].id}`, {
        data: { status: "Passed" },
      });

      const progress = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(progress.runCount).toBe(2);
      expect(progress.totalCases).toBe(1);
      expect(progress.passed).toBe(1);
      expect(progress.untested).toBe(0);
      expectBucketsSumToTotal(progress);
      expect(progress.completionPercent).toBe(100);
      expect(progress.passRate).toBe(100);

      const runs: { id: string; totalCases: number; untested: number }[] = await (
        await request.get(`/api/plans/${plan.id}/runs`)
      ).json();
      const emptyRow = runs.find((r) => r.id === empty.id)!;
      expect(emptyRow.totalCases).toBe(0);
      expect(emptyRow.untested).toBe(0);
    } finally {
      await request.delete(`/api/cycles/${empty.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${populated.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("PLN-A-03 a plan whose runs are all empty reports nothing to execute", { tag: '@tesbo.testId("TES-TC-947")' }, async ({ request }) => {
    // The boundary of PLN-A-02: with no cases anywhere, every counter is 0 — not one untested case
    // per empty run, which is what a percentage over a zero total would have been computed from.
    const stamp = Date.now();
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan All Empty ${stamp}` },
      })
    ).json();
    const runs: { id: string }[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        runs.push(
          await (
            await request.post(`/api/projects/${ctx.projectId}/cycles`, {
              data: { name: `E2E Plan All Empty Run ${i + 1} ${stamp}`, planId: plan.id },
            })
          ).json(),
        );
      }

      const progress = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(progress.runCount).toBe(2);
      expect(progress.totalCases).toBe(0);
      expect(progress.untested).toBe(0);
      expect(progress.executed).toBe(0);
      expectBucketsSumToTotal(progress);
      expect(progress.completionPercent).toBe(0);
      // Nothing has settled — null (rendered as "—"), not 0%, so an empty plan is never shown as a
      // failing one.
      expect(progress.passRate).toBeNull();
    } finally {
      for (const run of runs) await request.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
    }
  });

  test("PLN-A-04 the plan counts the same live executions the run's own screen renders", { tag: '@tesbo.testId("TES-TC-948")' }, async ({
    request,
  }) => {
    test.skip(!dbControlAvailable(), "needs psql access — executions have no DELETE route");
    /*
     * The plan roll-up used to count cycle_items against the raw executions table, while the run's
     * table and the runs list count live execution rows. A soft-deleted result therefore stayed in
     * the plan's numbers after it had disappeared from the run it belongs to, so the same run
     * carried two different case counts depending on which screen was asking.
     */
    const stamp = Date.now();
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Live Rows ${stamp}` },
      })
    ).json();
    const testcases: { id: string }[] = [];
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Live Rows Run ${stamp}`, planId: plan.id },
      })
    ).json();

    try {
      for (let i = 0; i < 2; i++) {
        testcases.push(
          await (
            await request.post(`/api/projects/${ctx.projectId}/testcases`, {
              data: { title: `E2E Plan Live Rows Case ${i + 1} ${stamp}` },
            })
          ).json(),
        );
      }
      await request.post(`/api/cycles/${cycle.id}/testcases`, {
        data: { testcaseIds: testcases.map((t) => t.id) },
      });
      const executions: { id: string; testcaseId: string }[] = await (
        await request.get(`/api/cycles/${cycle.id}/executions`)
      ).json();
      for (const [i, status] of ["Passed", "Failed"].entries()) {
        const execution = executions.find((e) => e.testcaseId === testcases[i].id)!;
        await request.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, {
          data: { status },
        });
      }

      const failed = executions.find((e) => e.testcaseId === testcases[1].id)!;
      softDeleteExecutions([failed.id]);

      // What the run itself now shows: one case, passed.
      const remaining = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(remaining).toHaveLength(1);

      const progress = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(progress.totalCases).toBe(1);
      expect(progress.passed).toBe(1);
      expect(progress.failed).toBe(0);
      expectBucketsSumToTotal(progress);
      expect(progress.completionPercent).toBe(100);
      expect(progress.passRate).toBe(100);

      const runRow = (await (await request.get(`/api/plans/${plan.id}/runs`)).json()).find(
        (r: { id: string }) => r.id === cycle.id,
      );
      expect(runRow.totalCases).toBe(1);
      expect(runRow.failed).toBe(0);
      expectBucketsSumToTotal(runRow);
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      for (const t of testcases) {
        await request.delete(`/api/projects/${ctx.projectId}/testcases/${t.id}`, {
          failOnStatusCode: false,
        });
      }
    }
  });

  test("PLN-A-05 unlinking a run takes its cases back out of the roll-up", { tag: '@tesbo.testId("TES-TC-949")' }, async ({ request }) => {
    const stamp = Date.now();
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Plan Unlink ${stamp}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Plan Unlink Case ${stamp}` },
      })
    ).json();
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Plan Unlink Run ${stamp}` },
      })
    ).json();

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      await request.patch(`/api/cycles/${cycle.id}/executions/${executions[0].id}`, {
        data: { status: "Failed" },
      });

      const unlinked = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(unlinked.runCount).toBe(0);
      expect(unlinked.totalCases).toBe(0);
      expect(unlinked.completionPercent).toBe(0);
      expect(unlinked.passRate).toBeNull();

      await request.patch(`/api/cycles/${cycle.id}`, { data: { planId: plan.id } });
      const linked = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(linked.runCount).toBe(1);
      expect(linked.totalCases).toBe(1);
      expect(linked.failed).toBe(1);
      expectBucketsSumToTotal(linked);
      expect(linked.completionPercent).toBe(100);
      // A settled-but-failing case is a real 0%, distinct from the null "nothing settled" above.
      expect(linked.passRate).toBe(0);

      await request.patch(`/api/cycles/${cycle.id}`, { data: { clearPlan: true } });
      const after = await (await request.get(`/api/plans/${plan.id}/progress`)).json();
      expect(after.runCount).toBe(0);
      expect(after.totalCases).toBe(0);
      expect(after.failed).toBe(0);
      expect(after.completionPercent).toBe(0);
      expect(after.passRate).toBeNull();
      expect((await (await request.get(`/api/plans/${plan.id}/runs`)).json())).toHaveLength(0);
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

});

/*
 * Hard-delete remediation Phase 4: `plans` and `plan_items` themselves. deletePlan/deletePlanItem
 * issued real DELETEs, and plan_items.plan_id was ON DELETE CASCADE, so deleting a plan destroyed
 * every item in it with no audit trail. V114 converts both to soft-delete, matching
 * testcases/suites/cycles/bugs. These tests prove the rows genuinely survive (not just that the API
 * stops showing them) and that listPlans' case/run counts self-correct.
 */
test.describe("plan and plan-item soft-delete (hard-delete remediation Phase 4)", () => {
  test("deleting a plan soft-deletes it and every one of its items, none of it physically removed", async ({ request }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, { data: { name: `E2E Plan Soft-Delete ${Date.now()}` } })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Plan Soft-Delete Case ${Date.now()}` } })
    ).json();
    try {
      const item = await (
        await request.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } })
      ).json();

      const delRes = await request.delete(`/api/plans/${plan.id}`);
      expect(delRes.ok(), `deleting the plan — ${await delRes.text()}`).toBeTruthy();

      // DB-level proof, not just the API's 404 — both rows must still physically exist, soft-deleted.
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM plans WHERE id = ${literal(plan.id)};`)).toBe("t");
      expect(scalar(`SELECT COUNT(*)::text FROM plans WHERE id = ${literal(plan.id)};`)).toBe("1");
      expect(scalar(`SELECT deleted_at IS NOT NULL FROM plan_items WHERE id = ${literal(item.id)};`)).toBe("t");
      expect(scalar(`SELECT COUNT(*)::text FROM plan_items WHERE id = ${literal(item.id)};`)).toBe("1");

      // Every read path 404s/excludes it, exactly as if it were gone.
      expect((await request.get(`/api/plans/${plan.id}`, { failOnStatusCode: false })).status()).toBe(404);
      const list = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
      expect(list.some((p: { id: string }) => p.id === plan.id)).toBeFalsy();
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("removing a single plan item soft-deletes it and it drops out of listPlans' case count", async ({ request }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, { data: { name: `E2E Plan Item Soft-Delete ${Date.now()}` } })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Plan Item Soft-Delete Case ${Date.now()}` } })
    ).json();
    try {
      const item = await (
        await request.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } })
      ).json();

      const before = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
      expect(before.find((p: { id: string }) => p.id === plan.id).caseCount).toBe(1);

      const delRes = await request.delete(`/api/plans/${plan.id}/items/${item.id}`);
      expect(delRes.ok(), `removing the item — ${await delRes.text()}`).toBeTruthy();

      expect(scalar(`SELECT deleted_at IS NOT NULL FROM plan_items WHERE id = ${literal(item.id)};`)).toBe("t");
      const itemsAfter = await (await request.get(`/api/plans/${plan.id}/items`)).json();
      expect(itemsAfter.some((i: { id: string }) => i.id === item.id)).toBeFalsy();

      const after = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
      expect(after.find((p: { id: string }) => p.id === plan.id).caseCount, "the removed item must not still be counted").toBe(0);
    } finally {
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Start Date / optional Due Date on test plans.
 *
 * Rules pinned here: Start Date is required (the API defaults it to the creation day in the
 * workspace's timezone), Due Date is optional and removable, Due Date may not precede Start Date,
 * and "overdue" is worked out at read time from the stored due date against the workspace's today
 * and from whether the plan is finished (it has runs and every one is Completed) — so moving the
 * date or finishing the runs removes the mark with nothing to clear.
 */
test.describe("plan start / due dates", () => {
  const dateKeys = (p: any) => ({ startDate: p.startDate, dueDate: p.dueDate });

  async function mkPlan(request: APIRequestContext, data: Record<string, unknown>) {
    const res = await request.post(`/api/projects/${ctx.projectId}/plans`, {
      data: { name: `E2E Plan Dates ${Date.now()}-${Math.floor(Math.random() * 1e6)}`, ...data },
      failOnStatusCode: false,
    });
    return { res, body: await res.json().catch(() => ({})) };
  }
  const rm = (request: APIRequestContext, id?: string) => (id ? request.delete(`/api/plans/${id}`, { failOnStatusCode: false }) : Promise.resolve());

  test("PLN-D-01 a plan created with a start and due date returns both as plain days, from get and from the list", async ({ request }) => {
    const d = await workspaceDays(request);
    const { res, body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(7) });
    try {
      expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
      expect(dateKeys(body)).toEqual({ startDate: d.today, dueDate: d.inDays(7) });
      const got = await (await request.get(`/api/plans/${body.id}`)).json();
      expect(dateKeys(got), "a DATE must come back as YYYY-MM-DD, never an ISO timestamp").toEqual({ startDate: d.today, dueDate: d.inDays(7) });
      const listed = (await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json()).find((p: any) => p.id === body.id);
      expect(dateKeys(listed)).toEqual({ startDate: d.today, dueDate: d.inDays(7) });
      expect(scalar(`SELECT due_date::text FROM plans WHERE id = ${literal(body.id)};`)).toBe(d.inDays(7));
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-02 with no dates given the start defaults to today in the workspace timezone and there is no due date", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, {});
    try {
      expect(body.startDate).toBe(d.today);
      expect(body.dueDate).toBeNull();
      expect(body.dueState).toBeNull();
      expect(body.isOverdue).toBe(false);
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-03 a due date before the start date is refused on create, with the field named, and nothing is saved", async ({ request }) => {
    const d = await workspaceDays(request);
    const name = `E2E Plan Inverted ${Date.now()}`;
    const { res, body } = await mkPlan(request, { name, startDate: d.today, dueDate: d.yesterday });
    try {
      expect(res.status()).toBe(400);
      expect(body.field).toBe("dueDate");
      expect(body.error).toMatch(/earlier than the start date/i);
      const list = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
      expect(list.some((p: any) => p.name === name)).toBe(false);
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-04 a due date equal to the start date is allowed (a one-day plan)", async ({ request }) => {
    const d = await workspaceDays(request);
    const { res, body } = await mkPlan(request, { startDate: d.today, dueDate: d.today });
    try {
      expect(res.status()).toBeLessThan(300);
      expect(body.dueState).toBe("due_today");
    } finally {
      await rm(request, body.id);
    }
  });

  for (const bad of ["2026-02-30", "25/10/2026", "2026-1-5", "tomorrow", 20261025]) {
    test(`PLN-D-05 a malformed due date (${JSON.stringify(bad)}) is a 400 on the field, not a 500`, async ({ request }) => {
      const { res, body } = await mkPlan(request, { dueDate: bad });
      try {
        expect(res.status()).toBe(400);
        expect(body.field).toBe("dueDate");
      } finally {
        await rm(request, body.id);
      }
    });
  }

  test("PLN-D-06 a malformed start date is a 400 on the field", async ({ request }) => {
    const { res, body } = await mkPlan(request, { startDate: "not-a-date" });
    try {
      expect(res.status()).toBe(400);
      expect(body.field).toBe("startDate");
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-07 dates can be changed after creation, and an update that names neither leaves them alone", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(3) });
    try {
      // The start moves forward: a start earlier than today is refused (PLN-D-16).
      const patch = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.tomorrow, dueDate: d.inDays(10) } });
      expect(patch.ok(), await patch.text()).toBeTruthy();
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json())).toEqual({ startDate: d.tomorrow, dueDate: d.inDays(10) });

      // A rename must not clear, reset or re-default either date.
      await request.patch(`/api/plans/${body.id}`, { data: { name: `E2E Plan Renamed ${Date.now()}` } });
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json())).toEqual({ startDate: d.tomorrow, dueDate: d.inDays(10) });
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-08 the due date can be cleared back to none with null, or with an empty string; the start date stays", async ({ request }) => {
    const d = await workspaceDays(request);
    for (const clear of [null, ""]) {
      const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(5) });
      try {
        const patch = await request.patch(`/api/plans/${body.id}`, { data: { dueDate: clear } });
        expect(patch.ok(), await patch.text()).toBeTruthy();
        expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json())).toEqual({ startDate: d.today, dueDate: null });
        expect(scalar(`SELECT due_date IS NULL FROM plans WHERE id = ${literal(body.id)};`)).toBe("t");
      } finally {
        await rm(request, body.id);
      }
    }
  });

  test("PLN-D-09 an update that would put the due date before the start date is refused and changes nothing, whichever side moves", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(5) });
    try {
      // Due moved before the STORED start…
      const a = await request.patch(`/api/plans/${body.id}`, { data: { dueDate: d.yesterday }, failOnStatusCode: false });
      expect(a.status()).toBe(400);
      // …and start moved after the STORED due.
      const b = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.inDays(6) }, failOnStatusCode: false });
      expect(b.status()).toBe(400);
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json()), "refused updates must not land").toEqual({ startDate: d.today, dueDate: d.inDays(5) });
      // Both given together are judged together, not each against the old value of the other.
      const c = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.inDays(20), dueDate: d.inDays(25) } });
      expect(c.ok(), await c.text()).toBeTruthy();
      // A start moved past the due date is fine when the due date is cleared in the same call.
      const e = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.inDays(40), dueDate: null } });
      expect(e.ok(), await e.text()).toBeTruthy();
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json())).toEqual({ startDate: d.inDays(40), dueDate: null });
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-10 the start date cannot be removed once given", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today });
    try {
      for (const empty of [null, ""]) {
        const res = await request.patch(`/api/plans/${body.id}`, { data: { startDate: empty }, failOnStatusCode: false });
        expect(res.status()).toBe(400);
        expect((await res.json()).field).toBe("startDate");
      }
      expect((await (await request.get(`/api/plans/${body.id}`)).json()).startDate).toBe(d.today);
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-11 the database itself refuses an inverted range, so no other write path can store one", async ({ request }) => {
    test.skip(!dbControlAvailable(), "needs psql access to the .env database");
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today });
    try {
      expect(() => exec(`UPDATE plans SET due_date = start_date - 1 WHERE id = ${literal(body.id)};`), "the CHECK constraint must reject it").toThrow();
      expect(scalar(`SELECT due_date IS NULL FROM plans WHERE id = ${literal(body.id)};`)).toBe("t");
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-12 a plan with a past due date and no runs is Overdue; moving the date forward removes it; due today and tomorrow are flagged but not overdue", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today });
    // A past start can no longer be created through the API, so seed the already-started plan directly.
    backdate("plans", body.id, d.inDays(-5), d.yesterday);
    const read = async () => {
      const got = await (await request.get(`/api/plans/${body.id}`)).json();
      const listed = (await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json()).find((p: any) => p.id === body.id);
      expect({ dueState: listed.dueState, isOverdue: listed.isOverdue }, "list and detail must agree").toEqual({ dueState: got.dueState, isOverdue: got.isOverdue });
      return got;
    };
    try {
      expect(await read()).toMatchObject({ dueState: "overdue", isOverdue: true });
      await request.patch(`/api/plans/${body.id}`, { data: { dueDate: d.today } });
      expect(await read()).toMatchObject({ dueState: "due_today", isOverdue: false });
      await request.patch(`/api/plans/${body.id}`, { data: { dueDate: d.tomorrow } });
      expect(await read()).toMatchObject({ dueState: "due_soon", isOverdue: false });
      await request.patch(`/api/plans/${body.id}`, { data: { dueDate: d.inDays(30) } });
      expect(await read()).toMatchObject({ dueState: null, isOverdue: false });
      await request.patch(`/api/plans/${body.id}`, { data: { dueDate: d.yesterday } });
      expect((await read()).isOverdue).toBe(true);
      await request.patch(`/api/plans/${body.id}`, { data: { dueDate: null } });
      expect(await read()).toMatchObject({ dueState: null, isOverdue: false });
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-13 a plan whose runs are all Completed is never Overdue; one open run makes it Overdue again", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body: plan } = await mkPlan(request, { startDate: d.today });
    backdate("plans", plan.id, d.inDays(-10), d.yesterday);
    const runIds: string[] = [];
    const caseIds: string[] = [];
    const mkRun = async () => {
      const run = await (
        await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Plan Dates Run ${Date.now()}`, environment: "staging", planId: plan.id } })
      ).json();
      runIds.push(run.id);
      const tc = await (await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `E2E Plan Dates Case ${Date.now()}` } })).json();
      caseIds.push(tc.id);
      await request.post(`/api/cycles/${run.id}/testcases`, { data: { testcaseIds: [tc.id] } });
      return run.id as string;
    };
    const overdue = async () => (await (await request.get(`/api/plans/${plan.id}`)).json()).isOverdue as boolean;
    try {
      const first = await mkRun();
      expect(await overdue(), "a plan with an unfinished run past its due date is overdue").toBe(true);
      await request.patch(`/api/cycles/${first}`, { data: { status: "In Progress" } });
      await request.patch(`/api/cycles/${first}`, { data: { status: "Completed" } });
      expect(await overdue(), "every run Completed means the plan is finished").toBe(false);
      const listed = (await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json()).find((p: any) => p.id === plan.id);
      expect(listed.isOverdue).toBe(false);
      await mkRun();
      expect(await overdue(), "a new open run reopens the plan").toBe(true);
    } finally {
      for (const id of runIds) await request.delete(`/api/cycles/${id}`, { failOnStatusCode: false });
      for (const id of caseIds) await request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await rm(request, plan.id);
    }
  });

  test("PLN-D-14 another tenant, and a caller with no session, cannot read or change a plan's dates", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(4) });
    const asB = await newRequestContext.newContext({ baseURL: env.apiBaseUrl, storageState: path.join(__dirname, "../.auth/state-b.json") });
    const anon = await newRequestContext.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      for (const [who, api] of [["another tenant", asB], ["no session", anon]] as const) {
        const patch = await api.patch(`/api/plans/${body.id}`, { data: { dueDate: d.inDays(99), startDate: d.inDays(90) }, failOnStatusCode: false });
        expect([400, 401, 403, 404], `${who} must be refused`).toContain(patch.status());
        const get = await api.get(`/api/plans/${body.id}`, { failOnStatusCode: false });
        expect([400, 401, 403, 404], `${who} must not read it`).toContain(get.status());
      }
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json()), "the refused writes must not have landed").toEqual({ startDate: d.today, dueDate: d.inDays(4) });
    } finally {
      await asB.dispose();
      await anon.dispose();
      await rm(request, body.id);
    }
  });

  test("PLN-D-15 deleting a plan takes it, and its dates, out of the list", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.yesterday });
    await rm(request, body.id);
    const list = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
    expect(list.some((p: any) => p.id === body.id)).toBe(false);
  });

  /*
   * A start date may not be earlier than today (workspace timezone). On update the rule applies only
   * when the start date is being changed, so an already-started plan stays editable.
   */
  test("PLN-D-16 a start date before today is refused on create, with the field named, and nothing is saved", async ({ request }) => {
    const d = await workspaceDays(request);
    for (const startDate of [d.yesterday, d.inDays(-30)]) {
      const name = `E2E Plan Past Start ${Date.now()}`;
      const { res, body } = await mkPlan(request, { name, startDate });
      try {
        expect(res.status(), `${startDate} must be refused`).toBe(400);
        expect(body.field).toBe("startDate");
        expect(body.error).toMatch(/start date cannot be earlier than today/i);
        const list = await (await request.get(`/api/projects/${ctx.projectId}/plans`)).json();
        expect(list.some((p: any) => p.name === name), "a refused create must not leave a row").toBe(false);
      } finally {
        await rm(request, body.id);
      }
    }
  });

  test("PLN-D-17 today and any future day are accepted as a start date", async ({ request }) => {
    const d = await workspaceDays(request);
    for (const startDate of [d.today, d.tomorrow, d.inDays(365)]) {
      const { res, body } = await mkPlan(request, { startDate });
      try {
        expect(res.status(), JSON.stringify(body)).toBeLessThan(300);
        expect(body.startDate).toBe(startDate);
      } finally {
        await rm(request, body.id);
      }
    }
  });

  test("PLN-D-18 changing the start date to a past day is refused and the stored dates are untouched", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(5) });
    try {
      const patch = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.yesterday }, failOnStatusCode: false });
      expect(patch.status()).toBe(400);
      expect((await patch.json()).field).toBe("startDate");
      // Sent together with a valid due date, the past start must still be the thing that is refused.
      const both = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.inDays(-3), dueDate: d.inDays(9) }, failOnStatusCode: false });
      expect(both.status()).toBe(400);
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json()), "refused updates must not land").toEqual({ startDate: d.today, dueDate: d.inDays(5) });
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-19 a plan that already started in the past stays editable: an unrelated edit, or re-sending its own start date, is not refused", async ({ request }) => {
    const d = await workspaceDays(request);
    const { body } = await mkPlan(request, { startDate: d.today, dueDate: d.inDays(5) });
    try {
      backdate("plans", body.id, d.inDays(-4), d.inDays(5));
      const rename = await request.patch(`/api/plans/${body.id}`, { data: { name: `E2E Plan Started ${Date.now()}` } });
      expect(rename.ok(), await rename.text()).toBeTruthy();
      // The edit form always posts startDate back; an unchanged one must not trip the rule.
      const resend = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.inDays(-4), dueDate: d.inDays(8) } });
      expect(resend.ok(), await resend.text()).toBeTruthy();
      expect(dateKeys(await (await request.get(`/api/plans/${body.id}`)).json())).toEqual({ startDate: d.inDays(-4), dueDate: d.inDays(8) });
      // Moving it to a different past day is a change, and is refused.
      const move = await request.patch(`/api/plans/${body.id}`, { data: { startDate: d.inDays(-2) }, failOnStatusCode: false });
      expect(move.status()).toBe(400);
    } finally {
      await rm(request, body.id);
    }
  });

  test("PLN-D-20 the past-start rule does not mask the other date errors, and a past start with a malformed value is still the malformed error", async ({ request }) => {
    const d = await workspaceDays(request);
    const inverted = await mkPlan(request, { startDate: d.tomorrow, dueDate: d.today });
    try {
      expect(inverted.res.status()).toBe(400);
      expect(inverted.body.field).toBe("dueDate");
    } finally {
      await rm(request, inverted.body.id);
    }
    const bad = await mkPlan(request, { startDate: "2026-02-30" });
    try {
      expect(bad.res.status()).toBe(400);
      expect(bad.body.error).toMatch(/valid date/i);
    } finally {
      await rm(request, bad.body.id);
    }
  });
});
