import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
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
