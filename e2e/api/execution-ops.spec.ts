import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { column, exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Execution bulk operations, run schedules, and public share links.
 *
 * Wave 7, on its own workspace ("exec-ops") because it deletes runs.
 *
 * READ THIS BEFORE "FIXING" A RED TEST IN HERE. Six of these routes are controller stubs with empty
 * bodies that answer 2xx without doing anything:
 *
 *   POST   /api/cycles/:cycleId/executions/bulk-assign     bulkAssign() {}
 *   POST   /api/cycles/:cycleId/executions/bulk-status     bulkStatus() {}
 *   GET    /api/projects/:projectId/cycles/schedules       returns [] regardless of the project
 *   POST   /api/projects/:projectId/cycles/schedules       returns { id: "local-schedule", ...body }
 *   PATCH  /api/cycles/schedules/:scheduleId               updateSchedule() {}
 *   DELETE /api/cycles/schedules/:scheduleId               deleteSchedule() {}
 *
 * The tests below assert what those routes claim to do, so they are RED until the product either
 * implements them or removes them — the same two valid outcomes §3 bug 15 had for the import stubs.
 * They are deliberately not weakened: a bulk-status call that reports success and changes nothing is
 * exactly the failure a suite exists to catch, and a green test here would convert it into silence.
 */

test.describe("execution bulk operations, schedules and share links", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("exec-ops");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) purge(tenant);
    await Promise.all([asOwner, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purge(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function purge(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(
      "DELETE FROM executions WHERE cycle_item_id IN (SELECT ci.id FROM cycle_items ci JOIN cycles c " +
        `ON c.id = ci.cycle_id WHERE c.project_id IN (${projects}));`,
    );
    exec(`DELETE FROM cycle_items WHERE cycle_id IN (SELECT id FROM cycles WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM cycles WHERE project_id IN (${projects});`);
    exec(`DELETE FROM testcases WHERE project_id IN (${projects}) AND title LIKE 'E2E ExecOps%';`);
  }

  function stamp(label: string): string {
    return `E2E ExecOps ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  /** A run with `count` test cases in it, each with a fresh Untested execution. */
  async function seedRun(count = 3, projectId?: string): Promise<{ cycleId: string; executionIds: string[] }> {
    const project = projectId ?? tenant!.mainProjectId;
    const testcaseIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await asOwner.post(`/api/projects/${project}/testcases`, {
        data: { title: stamp(`case ${i + 1}`) },
        failOnStatusCode: false,
      });
      expect(res.status(), `seeding a test case — ${await res.text()}`).toBe(201);
      testcaseIds.push((await res.json()).id);
    }

    const cycle = await asOwner.post(`/api/projects/${project}/cycles`, {
      data: { name: stamp("run") },
      failOnStatusCode: false,
    });
    expect(cycle.status(), `seeding a run — ${await cycle.text()}`).toBe(201);
    const cycleId = (await cycle.json()).id;

    const added = await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds },
      failOnStatusCode: false,
    });
    expect(added.status()).toBeLessThan(400);

    const executions = await (await asOwner.get(`/api/cycles/${cycleId}/executions`)).json();
    return { cycleId, executionIds: executions.map((e: any) => e.id) };
  }

  async function expectRefused(res: APIResponse, what: string): Promise<void> {
    expect([400, 401, 403, 404], `${what} answered with ${res.status()}: ${await res.text()}`).toContain(res.status());
  }

  function executionStatuses(cycleId: string): string[] {
    return scalar(
      "SELECT COALESCE(string_agg(e.status, ',' ORDER BY e.id), '') FROM executions e JOIN cycle_items ci " +
        `ON ci.id = e.cycle_item_id WHERE ci.cycle_id = ${literal(cycleId)};`,
    )
      .split(",")
      .filter(Boolean);
  }

  // ─── Bulk status ──────────────────────────────────────────────────────────

  test("EXO-A-01 setting the status of several executions at once applies it to all of them", { tag: '@tesbo.testId("TES-TC-174")' }, async () => {
    const { cycleId, executionIds } = await seedRun(3);
    expect(executionStatuses(cycleId)).toEqual(["Untested", "Untested", "Untested"]);

    const res = await asOwner.post(`/api/cycles/${cycleId}/executions/bulk-status`, {
      data: { executionIds, status: "Passed" },
      failOnStatusCode: false,
    });
    expect(res.status(), `bulk-status answered ${res.status()}: ${await res.text()}`).toBeLessThan(400);

    // The assertion the route exists for. `bulkStatus() {}` is an empty controller method, so this
    // is red: the call reports success and every execution is still Untested. Do not relax it — the
    // UI offers this action on a multi-select and tells the user it worked.
    const statuses = executionStatuses(cycleId);
    expect(statuses, "bulk-status reported success but changed nothing").toEqual(["Passed", "Passed", "Passed"]);
  });

  test("EXO-A-02 bulk status leaves executions outside the selection alone", { tag: '@tesbo.testId("TES-TC-175")' }, async () => {
    const { cycleId, executionIds } = await seedRun(3);
    const selected = executionIds.slice(0, 2);

    await asOwner.post(`/api/cycles/${cycleId}/executions/bulk-status`, {
      data: { executionIds: selected, status: "Failed" },
      failOnStatusCode: false,
    });

    const failed = Number(
      scalar(
        "SELECT COUNT(*) FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id " +
          `WHERE ci.cycle_id = ${literal(cycleId)} AND e.status = 'Failed';`,
      ),
    );
    expect(failed, "a partial bulk selection did not apply to exactly the selected executions").toBe(2);
  });

  test("EXO-A-03 bulk status refuses an unknown status value", { tag: '@tesbo.testId("TES-TC-176")' }, async () => {
    const { cycleId, executionIds } = await seedRun(2);
    const res = await asOwner.post(`/api/cycles/${cycleId}/executions/bulk-status`, {
      data: { executionIds, status: "Bananas" },
      failOnStatusCode: false,
    });
    // executions.status has a CHECK constraint, so an unknown value must be refused at the edge
    // rather than reaching Postgres — and it must certainly not be stored.
    expect(res.status(), `an unknown status answered ${res.status()}`).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    expect(executionStatuses(cycleId).every((s) => s === "Untested")).toBe(true);
  });

  test("EXO-A-04 bulk assignment sets the assignee on every selected execution", { tag: '@tesbo.testId("TES-TC-177")' }, async () => {
    const { cycleId, executionIds } = await seedRun(2);
    const res = await asOwner.post(`/api/cycles/${cycleId}/executions/bulk-assign`, {
      data: { executionIds, assigneeId: tenant!.qa.userId },
      failOnStatusCode: false,
    });
    expect(res.status(), `bulk-assign answered ${res.status()}: ${await res.text()}`).toBeLessThan(400);

    // Red for the same reason as EXO-A-01: `bulkAssign() {}` does nothing.
    const assigned = Number(
      scalar(
        "SELECT COUNT(*) FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id " +
          `WHERE ci.cycle_id = ${literal(cycleId)} AND e.assignee_id = ${literal(tenant!.qa.userId)};`,
      ),
    );
    expect(assigned, "bulk-assign reported success but assigned nobody").toBe(2);
  });

  test("EXO-A-05 bulk assignment refuses someone who is not a member of the project", { tag: '@tesbo.testId("TES-TC-178")' }, async () => {
    const { cycleId, executionIds } = await seedRun(1);
    const res = await asOwner.post(`/api/cycles/${cycleId}/executions/bulk-assign`, {
      data: { executionIds, assigneeId: tenant!.guest.userId },
      failOnStatusCode: false,
    });
    // Assigning work to somebody who cannot open the project produces an execution nobody can
    // action, so the guard belongs here rather than in the UI's picker.
    expect(res.status(), `assigning a non-member answered ${res.status()}`).toBeGreaterThanOrEqual(400);
    expect(
      scalar(
        "SELECT COUNT(*) FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id " +
          `WHERE ci.cycle_id = ${literal(cycleId)} AND e.assignee_id IS NOT NULL;`,
      ),
    ).toBe("0");
  });

  test("EXO-A-06 neither bulk route answers a caller with no session or from another project", { tag: '@tesbo.testId("TES-TC-179")' }, async () => {
    const { cycleId, executionIds } = await seedRun(2);

    for (const [what, api] of [
      ["anonymous", anon],
      ["non-member", asGuest],
    ] as const) {
      for (const [route, data] of [
        ["bulk-status", { executionIds, status: "Passed" }],
        ["bulk-assign", { executionIds, assigneeId: tenant!.qa.userId }],
      ] as Array<[string, Record<string, unknown>]>) {
        const res = await api.post(`/api/cycles/${cycleId}/executions/${route}`, { data, failOnStatusCode: false });
        await expectRefused(res, `${route} (${what})`);
      }
    }
    // Whatever the routes do or don't do, an outsider must not be able to rewrite a run's results.
    expect(executionStatuses(cycleId).every((s) => s === "Untested")).toBe(true);
  });

  // ─── Single-execution assignment (the reported bug + its membership gap) ──

  test("EXO-A-08 a single-execution PATCH also refuses a non-member assignee", { tag: '@tesbo.testId("TES-TC-1903")' }, async () => {
    // Unlike bulk-assign (EXO-A-05), the single-execution PATCH used to skip this check entirely —
    // it would accept any UUID as assignee_id with no membership validation at all.
    const { cycleId, executionIds } = await seedRun(1);
    const res = await asOwner.patch(`/api/cycles/${cycleId}/executions/${executionIds[0]}`, {
      data: { assigneeId: tenant!.guest.userId },
      failOnStatusCode: false,
    });
    expect(res.status(), `assigning a non-member via PATCH answered ${res.status()}`).toBeGreaterThanOrEqual(400);
    expect(
      scalar(`SELECT assignee_id FROM executions WHERE id = ${literal(executionIds[0])};`) || null,
    ).toBeNull();
  });

  test("EXO-A-09 a status-only PATCH does not clear an assignee set via bulk-assign", { tag: '@tesbo.testId("TES-TC-1904")' }, async () => {
    // The reported bug, reached through the bulk-assign entry point instead of a direct PATCH: assign
    // via bulk-assign, then touch status only, the way the run detail screen's inline dropdown does.
    const { cycleId, executionIds } = await seedRun(1);
    await asOwner.post(`/api/cycles/${cycleId}/executions/bulk-assign`, {
      data: { executionIds, assigneeId: tenant!.qa.userId },
      failOnStatusCode: false,
    });
    expect(scalar(`SELECT assignee_id FROM executions WHERE id = ${literal(executionIds[0])};`)).toBe(
      tenant!.qa.userId,
    );

    const res = await asOwner.patch(`/api/cycles/${cycleId}/executions/${executionIds[0]}`, {
      data: { status: "Passed" },
      failOnStatusCode: false,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect(
      scalar(`SELECT assignee_id FROM executions WHERE id = ${literal(executionIds[0])};`),
      "a status-only PATCH must not clear an assignee set moments earlier",
    ).toBe(tenant!.qa.userId);
  });

  // ─── Schedules ────────────────────────────────────────────────────────────

  test("EXO-A-07 a created schedule is listed for its project", { tag: '@tesbo.testId("TES-TC-180")' }, async () => {
    const created = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
      data: { name: stamp("nightly"), cron: "0 2 * * *", enabled: true },
      failOnStatusCode: false,
    });
    expect(
      created.status(),
      "MISSING FEATURE: scheduled runs are not implemented — see EXO-A-08b and the Wave 7 entry in " +
        `docs/e2e-coverage-waves.md. Answered ${created.status()}: ${await created.text()}`,
    ).toBeLessThan(400);
    const schedule = await created.json();

    // Red: createSchedule returns `{ id: "local-schedule", ...body }` without writing anything, and
    // the list route returns [] regardless. A schedule the user created and cannot see again is
    // indistinguishable from one that was silently dropped — which is what happens.
    expect(
      schedule.id,
      "MISSING FEATURE: scheduled runs are not implemented — see EXO-A-08b and the Wave 7 entry in " +
        "docs/e2e-coverage-waves.md. This test is the specification, and stays red until it is built.",
    ).not.toBe("local-schedule");

    const listed = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
      failOnStatusCode: false,
    });
    expect(listed.status()).toBe(200);
    const list = await listed.json();
    expect(
      JSON.stringify(list),
      "a schedule that was just created is not in the project's schedule list",
    ).toContain(schedule.id);
  });

  test("EXO-A-08 a schedule is updated and deleted, and the list reflects both", { tag: '@tesbo.testId("TES-TC-181")' }, async () => {
    const created = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
      data: { name: stamp("weekly"), cron: "0 3 * * 1" },
      failOnStatusCode: false,
    });
    const schedule = await created.json();

    const updated = await asOwner.patch(`/api/cycles/schedules/${schedule.id}`, {
      data: { enabled: false },
      failOnStatusCode: false,
    });
    expect(
      updated.status(),
      "MISSING FEATURE: scheduled runs are not implemented — see EXO-A-08b and the Wave 7 entry in " +
        `docs/e2e-coverage-waves.md. Answered ${updated.status()}.`,
    ).toBeLessThan(400);
    const afterUpdate = await (
      await asOwner.get(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`)
    ).json();
    // Red: updateSchedule() is an empty method, so there is nothing to read back.
    expect(JSON.stringify(afterUpdate), "the updated schedule is not readable").toContain(schedule.id);

    const deleted = await asOwner.delete(`/api/cycles/schedules/${schedule.id}`, { failOnStatusCode: false });
    expect(deleted.status()).toBeLessThan(400);
    const afterDelete = await (
      await asOwner.get(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`)
    ).json();
    expect(JSON.stringify(afterDelete)).not.toContain(schedule.id);
  });

  test("EXO-A-08b while scheduled runs are unimplemented, the routes say so instead of faking success", { tag: '@tesbo.testId("TES-TC-922")' }, async () => {
    /*
     * The companion to EXO-A-07/08/10, which stay red on purpose.
     *
     * Scheduled runs need a cron parser, a scheduler and a runner — a feature, not a fix — so they are
     * not implemented. What was fixed is the lie: createSchedule used to answer 201 with
     * `{ id: "local-schedule", ...body }` and store nothing, so the UI told the user their schedule was
     * saved. It now answers 501, which a caller can act on.
     *
     * This test is what stops the honest refusal from silently regressing back to a fake success while
     * the feature is still missing. When scheduling is built, this test is the one to delete — and
     * EXO-A-07/08/10 are the ones that should start passing.
     */
    const created = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
      data: { name: stamp("nightly"), cron: "0 2 * * *" },
      failOnStatusCode: false,
    });
    expect(
      created.status(),
      `creating a schedule answered ${created.status()} — either it works (and EXO-A-07 should be green) ` +
        `or it says it cannot: ${await created.text()}`,
    ).toBe(501);
    expect(await created.text()).not.toContain("local-schedule");

    for (const [what, attempt] of [
      [
        "update",
        () => asOwner.patch("/api/cycles/schedules/11111111-1111-4111-8111-111111111111", {
          data: { enabled: false },
          failOnStatusCode: false,
        }),
      ],
      [
        "delete",
        () => asOwner.delete("/api/cycles/schedules/11111111-1111-4111-8111-111111111111", { failOnStatusCode: false }),
      ],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      const res = await attempt();
      expect(res.status(), `${what} answered ${res.status()}: ${await res.text()}`).toBe(501);
    }

    // The list route is the one honest empty answer: no schedules exist, so [] is true.
    const listed = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
      failOnStatusCode: false,
    });
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toEqual([]);
  });

  test("EXO-A-09 the schedule routes refuse a caller with no session, and a non-member on the project ones", { tag: '@tesbo.testId("TES-TC-183")' }, async () => {
    // Anonymous is refused everywhere. For a signed-in non-member the split is structural: the list
    // and create routes carry a projectId and can check membership, while PATCH/DELETE
    // /api/cycles/schedules/:scheduleId identify a schedule that cannot exist yet — with no schedules
    // table there is nothing to resolve a project from, so "not implemented" is as specific as they
    // can be. When scheduling is built they must check the schedule's project too.
    for (const [what, attempt] of [
      [
        "list (anonymous)",
        () => anon.get(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, { failOnStatusCode: false }),
      ],
      [
        "create (anonymous)",
        () =>
          anon.post(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
            data: { name: "intruder", cron: "* * * * *" },
            failOnStatusCode: false,
          }),
      ],
      [
        "update (anonymous)",
        () =>
          anon.patch("/api/cycles/schedules/11111111-1111-4111-8111-111111111111", {
            data: { enabled: false },
            failOnStatusCode: false,
          }),
      ],
      [
        "delete (anonymous)",
        () => anon.delete("/api/cycles/schedules/11111111-1111-4111-8111-111111111111", { failOnStatusCode: false }),
      ],
      [
        "list (non-member)",
        () => asGuest.get(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, { failOnStatusCode: false }),
      ],
      [
        "create (non-member)",
        () =>
          asGuest.post(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
            data: { name: "intruder", cron: "* * * * *" },
            failOnStatusCode: false,
          }),
      ],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      await expectRefused(await attempt(), `schedule ${what}`);
    }
  });

  test("EXO-A-10 a schedule needs a name and a valid cron expression", { tag: '@tesbo.testId("TES-TC-184")' }, async () => {
    for (const data of [{}, { name: "" }, { name: "no cron" }, { name: "bad cron", cron: "not a cron" }]) {
      const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles/schedules`, {
        data,
        failOnStatusCode: false,
      });
      // A schedule with no cron expression can never fire, and one with a malformed expression is a
      // job that silently never runs — both have to be refused at the edge.
      expect(
        res.status(),
        `${JSON.stringify(data)} was accepted as a schedule: ${await res.text()}`,
      ).toBeGreaterThanOrEqual(400);
      // MISSING FEATURE, same as EXO-A-07/08: with no scheduling implementation there is no validation
      // layer to reach, so this answers 501 rather than a field-level 400. It is the specification for
      // the validation the feature will need, and stays red until then.
      expect(res.status(), "scheduled runs are not implemented — see EXO-A-08b").toBeLessThan(500);
    }
  });

  // ─── Share links ──────────────────────────────────────────────────────────

  test("EXO-A-11 sharing a run mints a token that serves the run publicly", { tag: '@tesbo.testId("TES-TC-185")' }, async () => {
    const { cycleId } = await seedRun(2);

    const shared = await asOwner.post(`/api/cycles/${cycleId}/share`, {
      data: { enabled: true },
      failOnStatusCode: false,
    });
    expect(shared.status(), `sharing a run — ${await shared.text()}`).toBeLessThan(400);
    const body = await shared.json();
    expect(body.shareEnabled).toBe(true);
    expect(body.shareToken, "sharing produced no token").toBeTruthy();
    // 24 random bytes as hex. Short enough to be guessable is the whole risk with an unauthenticated
    // URL, so the length is part of the contract.
    expect(String(body.shareToken).length).toBeGreaterThanOrEqual(32);

    // The public routes are deliberately unauthenticated — that is what a share link is for.
    const publicRun = await anon.get(`/api/public/shared-runs/${body.shareToken}`, { failOnStatusCode: false });
    expect(publicRun.status(), `the public run answered ${publicRun.status()}`).toBe(200);
    expect((await publicRun.json()).id).toBe(cycleId);

    const publicExecutions = await anon.get(`/api/public/shared-runs/${body.shareToken}/executions`, {
      failOnStatusCode: false,
    });
    expect(publicExecutions.status()).toBe(200);
    expect((await publicExecutions.json()).length).toBe(2);
  });

  test("EXO-A-12 revoking a share link stops it serving the run", { tag: '@tesbo.testId("TES-TC-186")' }, async () => {
    const { cycleId } = await seedRun(1);
    const token = (await (await asOwner.post(`/api/cycles/${cycleId}/share`, { data: { enabled: true } })).json())
      .shareToken;
    expect((await anon.get(`/api/public/shared-runs/${token}`, { failOnStatusCode: false })).status()).toBe(200);

    const revoked = await asOwner.post(`/api/cycles/${cycleId}/share`, {
      data: { enabled: false },
      failOnStatusCode: false,
    });
    expect(revoked.status()).toBeLessThan(400);
    expect((await revoked.json()).shareEnabled).toBe(false);

    // The token still exists on the row, so re-enabling gives back the same link — but while it is
    // off, the public route must not serve anything.
    for (const suffix of ["", "/executions"]) {
      const res = await anon.get(`/api/public/shared-runs/${token}${suffix}`, { failOnStatusCode: false });
      expect(res.status(), `a revoked share link still served ${suffix || "the run"}`).toBe(404);
    }

    const reEnabled = await (
      await asOwner.post(`/api/cycles/${cycleId}/share`, { data: { enabled: true }, failOnStatusCode: false })
    ).json();
    expect(reEnabled.shareToken).toBe(token);
    expect((await anon.get(`/api/public/shared-runs/${token}`, { failOnStatusCode: false })).status()).toBe(200);
  });

  test("EXO-A-13 an unknown or absent share token serves nothing", { tag: '@tesbo.testId("TES-TC-187")' }, async () => {
    for (const token of ["not-a-real-token", "00000000000000000000000000000000", "%20"]) {
      for (const suffix of ["", "/executions"]) {
        const res = await anon.get(`/api/public/shared-runs/${token}${suffix}`, { failOnStatusCode: false });
        expect(res.status(), `token "${token}"${suffix} answered ${res.status()}: ${await res.text()}`).toBe(404);
      }
    }
  });

  test("EXO-A-14 only someone inside the project can mint a share link for its run", { tag: '@tesbo.testId("TES-TC-188")' }, async () => {
    const { cycleId } = await seedRun(1);

    // A public URL to a whole run — case titles, results, linked defect keys — must not be
    // creatable by someone who cannot even open the run.
    for (const [what, api] of [
      ["anonymous", anon],
      ["non-member", asGuest],
    ] as const) {
      const res = await api.post(`/api/cycles/${cycleId}/share`, { data: { enabled: true }, failOnStatusCode: false });
      await expectRefused(res, `share (${what})`);
    }
    expect(
      scalar(`SELECT COALESCE(share_token, '') FROM cycles WHERE id = ${literal(cycleId)};`),
      "an outsider minted a share token",
    ).toBe("");
  });

  test("EXO-A-15 a malformed or unknown cycle id is refused without a 500", { tag: '@tesbo.testId("TES-TC-189")' }, async () => {
    for (const bad of ["not-a-uuid", "11111111-1111-4111-8111-111111111111"]) {
      for (const [what, attempt] of [
        ["share", () => asOwner.post(`/api/cycles/${bad}/share`, { data: { enabled: true }, failOnStatusCode: false })],
        [
          "bulk-status",
          () =>
            asOwner.post(`/api/cycles/${bad}/executions/bulk-status`, {
              data: { executionIds: [], status: "Passed" },
              failOnStatusCode: false,
            }),
        ],
        ["executions", () => asOwner.get(`/api/cycles/${bad}/executions`, { failOnStatusCode: false })],
      ] as Array<[string, () => Promise<APIResponse>]>) {
        const res = await attempt();
        expect(res.status(), `${what} on cycle "${bad}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
      }
    }
  });

  // ─── The rest of /api/cycles/*, which the export fix left behind ───────────

  test("EXO-A-16 a run's executions, edits and deletion are not reachable without project access", { tag: '@tesbo.testId("TES-TC-190")' }, async () => {
    /*
     * The comment above exportCycleExecutions in legacy.service.ts records this gap in the product's
     * own words: "the rest of /api/cycles/* still has the original gap — executions(), getCycle(),
     * updateCycle(), deleteCycle() and the cycle_items routes take no @Req() either, so these same
     * rows remain readable through GET /api/cycles/:cycleId/executions."
     *
     * That is the same shape as §3 bugs 1–2 and 11, and it is what this test pins: a run holds case
     * titles, actual results and linked defect keys, and DELETE /api/cycles/:cycleId removes it
     * outright.
     */
    const { cycleId } = await seedRun(1);

    for (const [what, api] of [
      ["anonymous", anon],
      ["non-member", asGuest],
    ] as const) {
      for (const [route, attempt] of [
        ["GET cycle", () => api.get(`/api/cycles/${cycleId}`, { failOnStatusCode: false })],
        ["GET executions", () => api.get(`/api/cycles/${cycleId}/executions`, { failOnStatusCode: false })],
        [
          "PATCH cycle",
          () => api.patch(`/api/cycles/${cycleId}`, { data: { name: "renamed by an outsider" }, failOnStatusCode: false }),
        ],
        ["DELETE cycle", () => api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false })],
      ] as Array<[string, () => Promise<APIResponse>]>) {
        const res = await attempt();
        await expectRefused(res, `${route} (${what})`);
      }
    }

    // And the run is still there, under its own name.
    expect(scalar(`SELECT COUNT(*) FROM cycles WHERE id = ${literal(cycleId)};`)).toBe("1");
    expect(scalar(`SELECT name FROM cycles WHERE id = ${literal(cycleId)};`)).not.toBe("renamed by an outsider");
  });

  // ─── Adding a large selection to a run ────────────────────────────────────

  /*
   * The production incident this covers: a "select all" on a project with a couple of thousand cases
   * POSTed one request that the backend served with three sequential round trips per case. It ran
   * for minutes, Cloudflare cut it off at 100s with a 524, and the rows already committed stayed in
   * the run.
   *
   * Seeded through psql rather than the API — the point is the size of the ADD, and paying 250
   * sequential POSTs to set it up would dwarf the thing under test. This suite owns a disposable
   * tenant, which is the only place bulk-seeding like this is allowed.
   */
  test("EXO-E-01 a large selection is added completely, and fast enough not to hit a proxy timeout", { tag: '@tesbo.testId("TES-TC-923")' }, async () => {
    const BATCH = 250;
    const cycle = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles`, {
      data: { name: stamp("bulk run") },
      failOnStatusCode: false,
    });
    expect(cycle.status()).toBe(201);
    const cycleId = (await cycle.json()).id;

    exec(
      `INSERT INTO testcases (project_id, external_id, title)
       SELECT ${literal(tenant!.mainProjectId)}, 'E2EBULK-' || g, 'E2E ExecOps bulk ' || lpad(g::text, 4, '0')
         FROM generate_series(1, ${BATCH}) AS g;`,
    );
    const testcaseIds = column(
      `SELECT id FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
        "AND title LIKE 'E2E ExecOps bulk %' ORDER BY title;",
    );
    expect(testcaseIds, "seeding the bulk test cases").toHaveLength(BATCH);

    const started = Date.now();
    const res = await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds },
      failOnStatusCode: false,
    });
    const elapsed = Date.now() - started;

    expect(res.status(), `adding ${BATCH} cases answered ${res.status()}: ${await res.text()}`).toBeLessThan(400);

    // Completeness first — the half-imported run is the symptom users actually reported.
    expect(
      scalar(`SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(cycleId)};`),
      "the run did not receive the whole selection",
    ).toBe(String(BATCH));
    expect(
      scalar(
        "SELECT COUNT(*) FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id " +
          `WHERE ci.cycle_id = ${literal(cycleId)};`,
      ),
      "some cycle items were left without an execution",
    ).toBe(String(BATCH));

    // Ordering, over the whole batch. The rows are written by one statement now, so they share a
    // created_at and `position` is the only thing carrying the caller's order — a regression there
    // would leave the run's list shuffled. Asserted here rather than in cycles.spec.ts because these
    // 250 fixtures cost one INSERT instead of 250 API round trips.
    expect(
      column(
        `SELECT testcase_id FROM cycle_items WHERE cycle_id = ${literal(cycleId)} ORDER BY position, created_at;`,
      ),
      "the run's order does not match the order the cases were sent in",
    ).toEqual(testcaseIds);

    /*
     * A generous ceiling, not a benchmark. The add is one statement now, so this lands in well under
     * a second against a local database and a couple of seconds against a hosted one. The old
     * per-case loop needed 3 x 250 = 750 sequential round trips, which blows past 30s on anything
     * with real network latency — the condition that produced the 524. Widening this to make a red
     * run green would be re-admitting exactly that bug.
     */
    expect(elapsed, `adding ${BATCH} cases took ${elapsed}ms`).toBeLessThan(30_000);
  });

  test("EXO-E-02 re-adding a large selection after a partial import does not duplicate it", { tag: '@tesbo.testId("TES-TC-924")' }, async () => {
    const BATCH = 40;
    const cycle = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles`, {
      data: { name: stamp("retry run") },
      failOnStatusCode: false,
    });
    const cycleId = (await cycle.json()).id;

    exec(
      `INSERT INTO testcases (project_id, external_id, title)
       SELECT ${literal(tenant!.mainProjectId)}, 'E2ERETRY-' || g, 'E2E ExecOps retry ' || lpad(g::text, 4, '0')
         FROM generate_series(1, ${BATCH}) AS g;`,
    );
    const testcaseIds = column(
      `SELECT id FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
        "AND title LIKE 'E2E ExecOps retry %' ORDER BY title;",
    );

    // Stand in for the partial import a timed-out request leaves behind: the first half is already
    // in the run when the user hits "add" again with the full selection.
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds: testcaseIds.slice(0, BATCH / 2) },
      failOnStatusCode: false,
    });
    expect(scalar(`SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(cycleId)};`)).toBe(String(BATCH / 2));

    const retry = await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds },
      failOnStatusCode: false,
    });
    expect(retry.status()).toBeLessThan(400);

    // The retry completes the run instead of doubling the half that was already there.
    expect(
      scalar(`SELECT COUNT(*) FROM cycle_items WHERE cycle_id = ${literal(cycleId)};`),
      "retrying after a partial import duplicated the cases that had already landed",
    ).toBe(String(BATCH));
    expect(
      scalar(
        "SELECT COUNT(*) FROM (SELECT 1 FROM cycle_items WHERE cycle_id = " +
          `${literal(cycleId)} GROUP BY testcase_id HAVING COUNT(*) > 1) d;`,
      ),
      "the run holds the same test case more than once",
    ).toBe("0");
  });
});
