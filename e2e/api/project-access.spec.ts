import { expect, test, type APIRequestContext } from "@playwright/test";
import { testAddress } from "../utils/env";
import { literal, scalar } from "../utils/psql";
import {
  detachUserByEmail,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  resetRbacMembership,
  seedFixtureUser,
  setProjectRole,
  storedProjectRole,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Per-project access: who can see which project, and who can change that.
 *
 * /api/workspace/project-access is the settings screen's view of the same project_members table
 * that requireProjectAccess reads on every project-scoped request, so a mistake here is not a
 * cosmetic one — it is the difference between a workspace member seeing one project and seeing all
 * of them. The PUT and DELETE both delegate to addProjectMember/removeProjectMember, which is why
 * the role rules are asserted through this path too rather than assumed from api/rbac.spec.ts.
 */

test.describe("project access", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("access");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
  });

  test.afterAll(async () => {
    if (tenant) resetRbacMembership(tenant);
    await Promise.all([asOwner, asManager, asQa, asGuest].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  // ─── The access matrix ─────────────────────────────────────────────────────

  test("the access matrix reports which projects each member can actually reach", { tag: '@tesbo.testId("TES-TC-391")' }, async () => {
    // The screen exists to answer "who has access to what", and it's the only place an owner can
    // see that. Today the endpoint hands back `projectRoles: {}` for every member — a hard-coded
    // empty object, so the matrix renders as "nobody has access to anything" while the manager and
    // QA engineer both hold real roles on the main project.
    const res = await asOwner.get("/api/workspace/project-access");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(Array.isArray(body.projects), "the matrix needs the workspace's projects").toBeTruthy();
    expect(body.projects.map((p: any) => p.id)).toContain(tenant!.mainProjectId);

    const manager = body.members.find((m: any) => m.email === tenant!.manager.email);
    const qa = body.members.find((m: any) => m.email === tenant!.qa.email);
    const guest = body.members.find((m: any) => m.email === tenant!.guest.email);
    expect(manager, "every workspace member belongs in the matrix").toBeTruthy();

    expect(manager.projectRoles[tenant!.mainProjectId]).toBe("manager");
    expect(qa.projectRoles[tenant!.mainProjectId]).toBe("qa_engineer");
    // The guest is in the workspace but in no project, which must read as "no access" rather than
    // being indistinguishable from a member whose roles simply weren't loaded.
    expect(guest.projectRoles[tenant!.mainProjectId]).toBeUndefined();
  });

  test("the access matrix is owner-and-manager territory, not a QA engineer's", { tag: '@tesbo.testId("TES-TC-392")' }, async () => {
    // By consistency: the roster it exposes is the same one /workspace/members administration is
    // gated on, and a QA engineer is refused every other membership view of the workspace.
    const res = await asQa.get("/api/workspace/project-access", { failOnStatusCode: false });
    expect(res.status()).toBe(403);
  });

  // ─── Granting ──────────────────────────────────────────────────────────────

  test("granting access makes a previously invisible project reachable", { tag: '@tesbo.testId("TES-TC-393")' }, async () => {
    try {
      const before = await asGuest.get(`/api/projects/${tenant!.secondProjectId}`, {
        failOnStatusCode: false,
      });
      expect(before.status(), "the guest should start with no access").toBe(404);

      const grant = await asOwner.put("/api/workspace/project-access", {
        data: {
          projectId: tenant!.secondProjectId,
          userId: tenant!.guest.userId,
          role: "qa_engineer",
        },
        failOnStatusCode: false,
      });
      expect(grant.ok(), `grant failed: ${grant.status()} ${await grant.text()}`).toBeTruthy();
      expect(storedProjectRole(tenant!.secondProjectId, tenant!.guest.userId)).toBe("qa_engineer");

      const after = await asGuest.get(`/api/projects/${tenant!.secondProjectId}`, {
        failOnStatusCode: false,
      });
      expect(after.ok(), "the granted project should now be readable").toBeTruthy();

      const list = await (await asGuest.get("/api/projects")).json();
      const projects: any[] = Array.isArray(list) ? list : (list.projects ?? []);
      expect(projects.map((p) => p.id)).toContain(tenant!.secondProjectId);
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("revoking access takes the project away again", { tag: '@tesbo.testId("TES-TC-394")' }, async () => {
    try {
      await asOwner.put("/api/workspace/project-access", {
        data: { projectId: tenant!.secondProjectId, userId: tenant!.guest.userId, role: "qa_engineer" },
      });
      expect((await asGuest.get(`/api/projects/${tenant!.secondProjectId}`)).ok()).toBeTruthy();

      const revoke = await asOwner.delete("/api/workspace/project-access", {
        data: { projectId: tenant!.secondProjectId, userId: tenant!.guest.userId },
        failOnStatusCode: false,
      });
      expect(revoke.ok(), `revoke failed: ${revoke.status()} ${await revoke.text()}`).toBeTruthy();
      expect(storedProjectRole(tenant!.secondProjectId, tenant!.guest.userId)).toBe("");

      // The revocation has to bite on the very next request — a session that keeps working until
      // the user signs out is how a removed contractor keeps reading a project.
      const after = await asGuest.get(`/api/projects/${tenant!.secondProjectId}`, {
        failOnStatusCode: false,
      });
      expect(after.status()).toBe(404);
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("re-granting access changes the role instead of adding a second row", { tag: '@tesbo.testId("TES-TC-395")' }, async () => {
    try {
      await asOwner.put("/api/workspace/project-access", {
        data: { projectId: tenant!.secondProjectId, userId: tenant!.guest.userId, role: "qa_engineer" },
      });
      const promote = await asOwner.put("/api/workspace/project-access", {
        data: { projectId: tenant!.secondProjectId, userId: tenant!.guest.userId, role: "manager" },
        failOnStatusCode: false,
      });
      expect(promote.ok()).toBeTruthy();
      expect(storedProjectRole(tenant!.secondProjectId, tenant!.guest.userId)).toBe("manager");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("access cannot be granted to someone outside the workspace", { tag: '@tesbo.testId("TES-TC-396")' }, async () => {
    // addProjectMember resolves the target with `SELECT ... FROM users WHERE u.id = $1` — no
    // workspace scoping at all — so any user id in the system can be dropped into this project.
    // Workspace membership has to be a precondition of project access, or an owner can hand a
    // project to an account that was never invited (and the invitation flow becomes optional).
    const email = testAddress("access-outsider");
    const outsider = seedFixtureUser(email, "E2E Outsider");
    try {
      const res = await asOwner.put("/api/workspace/project-access", {
        data: { projectId: tenant!.mainProjectId, userId: outsider.userId, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect([400, 403, 404], `granting a non-member access should be refused`).toContain(res.status());
      expect(storedProjectRole(tenant!.mainProjectId, outsider.userId)).toBe("");
    } finally {
      detachUserByEmail(email);
      resetRbacMembership(tenant!);
    }
  });

  test("a QA engineer cannot grant or revoke project access", { tag: '@tesbo.testId("TES-TC-397")' }, async () => {
    try {
      const grant = await asQa.put("/api/workspace/project-access", {
        data: { projectId: tenant!.mainProjectId, userId: tenant!.guest.userId, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect(grant.status()).toBe(403);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("");

      const revoke = await asQa.delete("/api/workspace/project-access", {
        data: { projectId: tenant!.mainProjectId, userId: tenant!.manager.userId },
        failOnStatusCode: false,
      });
      expect(revoke.status()).toBe(403);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.manager.userId)).toBe("manager");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a manager cannot grant more than a QA engineer's access", { tag: '@tesbo.testId("TES-TC-398")' }, async () => {
    // Explicit: addProjectMember restricts a manager to granting qa_engineer, and refuses the
    // owner role to everyone.
    try {
      for (const role of ["owner", "manager"]) {
        const res = await asManager.put("/api/workspace/project-access", {
          data: { projectId: tenant!.mainProjectId, userId: tenant!.guest.userId, role },
          failOnStatusCode: false,
        });
        expect(res.status(), `a manager should not be able to grant "${role}"`).toBe(403);
      }
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("the last project owner cannot be removed", { tag: '@tesbo.testId("TES-TC-399")' }, async () => {
    // Explicit: removeProjectMember protects the final owner. Without it a project can be left
    // with nobody who can administer its members.
    const res = await asOwner.delete("/api/workspace/project-access", {
      data: { projectId: tenant!.mainProjectId, userId: tenant!.owner.userId },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(storedProjectRole(tenant!.mainProjectId, tenant!.owner.userId)).toBe("owner");
  });

  // ─── Assignment cascade on removal ─────────────────────────────────────────
  /*
   * "[Test Runs] Unable to assign test cases for execution" edge case: a member removed from a
   * project must not leave executions/bugs still pointing at them as assignee. That assignment would
   * be dangling — visible, but to nobody who can act on it. removeProjectMember clears both in the
   * same transaction as the membership delete.
   */
  test("removing a project member clears their execution and bug assignments in that project", { tag: '@tesbo.testId("TES-TC-1912")' }, async () => {
    const stamp = Date.now();
    const testcase = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
        data: { title: `E2E Cascade Case ${stamp}` },
      })
    ).json();
    const cycle = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles`, { data: { name: `E2E Cascade Run ${stamp}` } })
    ).json();
    await asOwner.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
    const [execution] = await (await asOwner.get(`/api/cycles/${cycle.id}/executions`)).json();
    await asOwner.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, { data: { assigneeId: tenant!.qa.userId } });

    const bug = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Cascade Bug ${stamp}`, assigneeId: tenant!.qa.userId },
      })
    ).json();

    try {
      expect(scalar(`SELECT assignee_id FROM executions WHERE id = ${literal(execution.id)};`)).toBe(tenant!.qa.userId);
      expect(scalar(`SELECT assignee_id FROM bugs WHERE id = ${literal(bug.id)};`)).toBe(tenant!.qa.userId);

      const removed = await asOwner.delete("/api/workspace/project-access", {
        data: { projectId: tenant!.mainProjectId, userId: tenant!.qa.userId },
        failOnStatusCode: false,
      });
      expect(removed.ok(), await removed.text()).toBeTruthy();

      expect(
        scalar(`SELECT COALESCE(assignee_id::text, 'null') FROM executions WHERE id = ${literal(execution.id)};`),
        "the execution must not still point at a member who was just removed",
      ).toBe("null");
      expect(
        scalar(`SELECT COALESCE(assignee_id::text, 'null') FROM bugs WHERE id = ${literal(bug.id)};`),
        "the bug must not still point at a member who was just removed",
      ).toBe("null");
    } finally {
      resetRbacMembership(tenant!);
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("removing a member with no assignments is a no-op, not an error", { tag: '@tesbo.testId("TES-TC-1913")' }, async () => {
    const res = await asOwner.delete("/api/workspace/project-access", {
      data: { projectId: tenant!.mainProjectId, userId: tenant!.qa.userId },
      failOnStatusCode: false,
    });
    try {
      expect(res.ok(), await res.text()).toBeTruthy();
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("the cascade is scoped to the removed project — an assignment in a different project survives", { tag: '@tesbo.testId("TES-TC-1914")' }, async () => {
    // qa is a member of mainProjectId only by default; grant secondProjectId too so an assignment
    // there exists to prove it's untouched by a removal scoped to mainProjectId.
    setProjectRole(tenant!.secondProjectId, tenant!.qa.userId, "qa_engineer");
    const bug = await (
      await asOwner.post(`/api/projects/${tenant!.secondProjectId}/bugs`, {
        data: { title: `E2E Cascade Cross-Project Bug ${Date.now()}`, assigneeId: tenant!.qa.userId },
      })
    ).json();

    try {
      const removed = await asOwner.delete("/api/workspace/project-access", {
        data: { projectId: tenant!.mainProjectId, userId: tenant!.qa.userId },
        failOnStatusCode: false,
      });
      expect(removed.ok(), await removed.text()).toBeTruthy();

      expect(
        scalar(`SELECT assignee_id FROM bugs WHERE id = ${literal(bug.id)};`),
        "removing a member from Project A must not clear their assignment in Project B",
      ).toBe(tenant!.qa.userId);
    } finally {
      resetRbacMembership(tenant!);
      await asOwner.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  // ─── Malformed and cross-tenant input ──────────────────────────────────────

  test("a missing or malformed target fails cleanly, never with a 500", { tag: '@tesbo.testId("TES-TC-400")' }, async () => {
    const payloads: Record<string, unknown>[] = [
      {},
      { userId: tenant!.guest.userId },
      { projectId: tenant!.mainProjectId },
      { projectId: "not-a-uuid", userId: tenant!.guest.userId },
      { projectId: tenant!.mainProjectId, userId: "not-a-uuid" },
      { projectId: null, userId: null },
    ];

    for (const data of payloads) {
      const put = await asOwner.put("/api/workspace/project-access", { data, failOnStatusCode: false });
      expect(put.status(), `PUT ${JSON.stringify(data)} should fail cleanly`).toBeLessThan(500);
      expect(put.ok(), `PUT ${JSON.stringify(data)} should not succeed`).toBeFalsy();

      const del = await asOwner.delete("/api/workspace/project-access", { data, failOnStatusCode: false });
      expect(del.status(), `DELETE ${JSON.stringify(data)} should fail cleanly`).toBeLessThan(500);
      expect(del.ok(), `DELETE ${JSON.stringify(data)} should not succeed`).toBeFalsy();
    }
  });

  test("an unrecognised role is refused rather than silently becoming QA Engineer", { tag: '@tesbo.testId("TES-TC-1184")' }, async () => {
    // Mirrors api/rbac.spec.ts's workspace-level version of this test. addProjectMember's
    // parseRole refuses unknown strings outright, but that guarantee was never exercised through
    // this endpoint — only assumed from the workspace-member path, which is a different call site.
    try {
      const res = await asOwner.put("/api/workspace/project-access", {
        data: { projectId: tenant!.mainProjectId, userId: tenant!.guest.userId, role: "supervisor" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a project in another workspace cannot be granted away", { tag: '@tesbo.testId("TES-TC-401")' }, async () => {
    const foreign = "00000000-0000-0000-0000-000000000000";
    const res = await asOwner.put("/api/workspace/project-access", {
      data: { projectId: foreign, userId: tenant!.guest.userId, role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
    expect(storedProjectRole(foreign, tenant!.guest.userId)).toBe("");
  });
});
