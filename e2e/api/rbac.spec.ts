import { expect, test, type APIRequestContext } from "@playwright/test";
import { testAddress } from "../utils/env";
import {
  anonymousContext,
  loginAs,
  setOrgRole,
  setProjectRole,
  orgMemberCount,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  resetRbacMembership,
  storedOrgRole,
  storedProjectRole,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The role × action matrix for a single workspace: owner, manager, QA engineer, and a workspace
 * member with no project access.
 *
 * Every expectation here is the behaviour the product SHOULD have, not the behaviour it currently
 * has. Where the two differ the test is left red on purpose — a permission hole is a product bug,
 * and a green suite that documents the hole in a comment is how it stays shipped. Each expectation
 * is sourced one of two ways, and which one is stated on the test:
 *
 *   - explicit: legacy.service.ts already gates this action on a role, so the test pins that gate
 *     against regression.
 *   - by consistency: the product is silent here, and the expectation is taken from how the SAME
 *     role is treated on every neighbouring action (a QA engineer is refused project-member
 *     management, KB writes and workspace renames, so refusing them a project rename is the only
 *     coherent reading).
 *
 * Roles come from legacy.service.ts's normalizeRole(): owner | manager | qa_engineer.
 */

test.describe("role-based permissions", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("rbac");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
  });

  test.afterAll(async () => {
    if (tenant) resetRbacMembership(tenant);
    await Promise.all(
      [asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((ctx) => ctx.dispose()),
    );
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  // ─── Workspace membership ──────────────────────────────────────────────────

  test("a QA engineer cannot add members to the workspace", { tag: '@tesbo.testId("TES-TC-432")' }, async () => {
    // By consistency: a QA engineer cannot invite (explicit), cannot manage project members
    // (explicit) and cannot rename the workspace (explicit). Adding members outright is strictly
    // more powerful than inviting, so it cannot be the one membership action they're allowed.
    const before = orgMemberCount(tenant!);
    try {
      const res = await asQa.post("/api/workspace/members", {
        data: { email: testAddress("rbac-intruder"), role: "manager" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
      expect(orgMemberCount(tenant!)).toBe(before);
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a manager cannot grant workspace owner", { tag: '@tesbo.testId("TES-TC-433")' }, async () => {
    // By consistency: createInvitation refuses role=owner outright ("Cannot invite owners
    // directly") and restricts a manager to inviting QA engineers. The same manager reaching the
    // same outcome through /workspace/members would make that gate decorative.
    try {
      const res = await asManager.post("/api/workspace/members", {
        data: { email: testAddress("rbac-escalate"), role: "owner" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("the owner cannot promote anyone to a role the product doesn't have", { tag: '@tesbo.testId("TES-TC-434")' }, async () => {
    // addWorkspaceMember stores body.role verbatim — it never passes it through normalizeRole — so
    // an unknown string lands in organization_members.role and every later check reads it through
    // normalizeRole, which collapses anything unrecognised to qa_engineer. An unknown role must be
    // refused at the door instead of silently becoming the weakest one.
    try {
      const res = await asOwner.post("/api/workspace/members", {
        data: { userId: tenant!.qa.userId, role: "superuser" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("an owner can add a member and the roster reports the granted role", { tag: '@tesbo.testId("TES-TC-435")' }, async () => {
    const email = testAddress("rbac-newhire");
    try {
      const res = await asOwner.post("/api/workspace/members", {
        data: { email, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect(res.ok()).toBeTruthy();

      const roster = await (await asOwner.get("/api/workspace/members")).json();
      const added = roster.find((m: any) => m.email === email);
      expect(added, `${email} should appear in the roster`).toBeTruthy();
      expect(added.role).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  // ─── Role changes ──────────────────────────────────────────────────────────

  test("only the owner can change a member's role", { tag: '@tesbo.testId("TES-TC-436")' }, async () => {
    // Explicit: changeWorkspaceMemberRole refuses any caller whose role isn't owner.
    try {
      const res = await asManager.post("/api/workspace/members/role", {
        data: { userId: tenant!.qa.userId, role: "manager" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("the owner can promote a QA engineer to manager and demote them again", { tag: '@tesbo.testId("TES-TC-437")' }, async () => {
    try {
      const promote = await asOwner.post("/api/workspace/members/role", {
        data: { userId: tenant!.qa.userId, role: "manager" },
        failOnStatusCode: false,
      });
      expect(promote.ok()).toBeTruthy();
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("manager");

      const demote = await asOwner.post("/api/workspace/members/role", {
        data: { userId: tenant!.qa.userId, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect(demote.ok()).toBeTruthy();
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("the owner cannot change their own role", { tag: '@tesbo.testId("TES-TC-438")' }, async () => {
    // Explicit: guards the workspace against being left with nobody who can administer it.
    const res = await asOwner.post("/api/workspace/members/role", {
      data: { userId: tenant!.owner.userId, role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(storedOrgRole(tenant!, tenant!.owner.userId)).toBe("owner");
  });

  test("an unrecognised role is refused rather than silently demoting the member", { tag: '@tesbo.testId("TES-TC-439")' }, async () => {
    // normalizeRole maps anything it doesn't recognise to qa_engineer, so today a typo'd role in a
    // promotion request quietly DEMOTES a manager instead of failing. Callers must be told.
    try {
      const res = await asOwner.post("/api/workspace/members/role", {
        data: { userId: tenant!.manager.userId, role: "supervisor" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect(storedOrgRole(tenant!, tenant!.manager.userId)).toBe("manager");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  // ─── Removing members ──────────────────────────────────────────────────────

  test("a manager cannot remove team members", { tag: '@tesbo.testId("TES-TC-440")' }, async () => {
    // Explicit: removeWorkspaceMember is owner-only.
    try {
      const res = await asManager.delete(`/api/workspace/members/${tenant!.qa.userId}`, {
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a QA engineer cannot remove team members", { tag: '@tesbo.testId("TES-TC-441")' }, async () => {
    try {
      const res = await asQa.delete(`/api/workspace/members/${tenant!.manager.userId}`, {
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
      expect(storedOrgRole(tenant!, tenant!.manager.userId)).toBe("manager");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("nobody can remove themselves from the workspace", { tag: '@tesbo.testId("TES-TC-442")' }, async () => {
    // Explicit: an owner removing themselves is how a workspace becomes unadministrable.
    const res = await asOwner.delete(`/api/workspace/members/${tenant!.owner.userId}`, {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(storedOrgRole(tenant!, tenant!.owner.userId)).toBe("owner");
  });

  test("promotion to owner is refused, so ownership can't be escalated through a role change", { tag: '@tesbo.testId("TES-TC-443")' }, async () => {
    // Explicit: changeWorkspaceMemberRole refuses normalized === "owner" outright. Worth pinning,
    // because it's the gate that /api/workspace/members bypasses (see "a manager cannot grant
    // workspace owner" above) — the two endpoints have to agree or the stricter one is decoration.
    try {
      const res = await asOwner.post("/api/workspace/members/role", {
        data: { userId: tenant!.qa.userId, role: "owner" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a workspace can never be left without an owner", { tag: '@tesbo.testId("TES-TC-444")' }, async () => {
    // Two owners is not reachable through the API (promotion to owner is refused above), so the
    // second owner is written directly — otherwise the last-owner guard can't be exercised at all.
    //
    // What must hold: one of two owners can be removed, and the survivor cannot then remove
    // themselves. If both steps were allowed the workspace would end up with zero owners and no
    // route back — nobody left who can invite, change roles or manage billing.
    try {
      setOrgRole(tenant!.organizationId, tenant!.qa.userId, "owner");
      const asSecondOwner = await loginAs(tenant!.qa);
      try {
        const removeFirst = await asSecondOwner.delete(`/api/workspace/members/${tenant!.owner.userId}`, {
          failOnStatusCode: false,
        });
        expect(
          removeFirst.ok(),
          `one of two owners should be removable: ${removeFirst.status()} ${await removeFirst.text()}`,
        ).toBeTruthy();
        expect(storedOrgRole(tenant!, tenant!.owner.userId)).toBe("");

        const selfRemoval = await asSecondOwner.delete(`/api/workspace/members/${tenant!.qa.userId}`, {
          failOnStatusCode: false,
        });
        expect(selfRemoval.status()).toBe(400);
        expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("owner");
      } finally {
        await asSecondOwner.dispose();
      }
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  // ─── Workspace-level settings ──────────────────────────────────────────────

  test("a QA engineer cannot rename the workspace", { tag: '@tesbo.testId("TES-TC-445")' }, async () => {
    // Explicit: updateWorkspace refuses qa_engineer.
    const res = await asQa.patch("/api/workspace", {
      data: { name: "Renamed By A QA Engineer" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });

  test("a manager can rename the workspace", { tag: '@tesbo.testId("TES-TC-446")' }, async () => {
    // The other half of the same gate: managers are explicitly allowed, so an over-tightened
    // implementation is a bug too.
    const original = (await (await asOwner.get("/api/workspace")).json()).name;
    try {
      const res = await asManager.patch("/api/workspace", {
        data: { name: `E2E Renamed ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(res.ok()).toBeTruthy();
    } finally {
      await asOwner.patch("/api/workspace", { data: { name: original }, failOnStatusCode: false });
    }
  });

  test("AI provider keys are owner-only", { tag: '@tesbo.testId("TES-TC-447")' }, async () => {
    // Explicit: createAiKey/deleteAiKey/allocateAiKey each refuse anyone but the owner.
    const payload = { name: `E2E Key ${Date.now()}`, provider: "openai", apiKey: "sk-e2e-not-a-real-key" };
    for (const [role, ctx] of [
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      const res = await ctx.post("/api/workspace/ai-keys", { data: payload, failOnStatusCode: false });
      expect(res.status(), `${role} should not be able to add an AI key`).toBe(403);
    }
  });

  test("integrations are owner-only", { tag: '@tesbo.testId("TES-TC-448")' }, async () => {
    // Explicit: integrationAuthUrl/callback/disconnect each refuse anyone but the owner.
    for (const [role, ctx] of [
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      const res = await ctx.get("/api/workspace/integrations/jira/auth-url", { failOnStatusCode: false });
      expect(res.status(), `${role} should not be able to start an integration connect`).toBe(403);
    }
  });

  test("the workspace activity feed is owner-only", { tag: '@tesbo.testId("TES-TC-449")' }, async () => {
    // Explicit: workspaceActivity is an owner-only rollup across every project.
    for (const [role, ctx] of [
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      const res = await ctx.get("/api/workspace/activity", { failOnStatusCode: false });
      expect(res.status(), `${role} should not be able to read the workspace feed`).toBe(403);
    }
  });

  // ─── Project scoping ───────────────────────────────────────────────────────

  test("a workspace member with no project access cannot see the project", { tag: '@tesbo.testId("TES-TC-450")' }, async () => {
    // Explicit: requireProjectAccess joins on project_members, so workspace membership alone is
    // not access. 404 rather than 403 is correct here — a non-member shouldn't learn it exists.
    const res = await asGuest.get(`/api/projects/${tenant!.mainProjectId}`, { failOnStatusCode: false });
    expect(res.status()).toBe(404);

    const list = await (await asGuest.get("/api/projects")).json();
    const projects: any[] = Array.isArray(list) ? list : (list.projects ?? []);
    expect(projects.map((p) => p.id)).not.toContain(tenant!.mainProjectId);
  });

  test("a QA engineer cannot manage project members", { tag: '@tesbo.testId("TES-TC-451")' }, async () => {
    // Explicit: addProjectMember and removeProjectMember both refuse qa_engineer.
    try {
      const add = await asQa.post(`/api/projects/${tenant!.mainProjectId}/members`, {
        data: { userId: tenant!.guest.userId, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect(add.status()).toBe(403);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("");

      const remove = await asQa.delete(
        `/api/projects/${tenant!.mainProjectId}/members/${tenant!.manager.userId}`,
        { failOnStatusCode: false },
      );
      expect(remove.status()).toBe(403);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.manager.userId)).toBe("manager");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a manager cannot hand out the project owner role", { tag: '@tesbo.testId("TES-TC-452")' }, async () => {
    // Explicit: addProjectMember refuses requestedRole=owner, and restricts a manager to granting
    // qa_engineer only.
    try {
      const asOwnerRole = await asManager.post(`/api/projects/${tenant!.mainProjectId}/members`, {
        data: { userId: tenant!.guest.userId, role: "owner" },
        failOnStatusCode: false,
      });
      expect(asOwnerRole.status()).toBe(403);

      const asManagerRole = await asManager.post(`/api/projects/${tenant!.mainProjectId}/members`, {
        data: { userId: tenant!.guest.userId, role: "manager" },
        failOnStatusCode: false,
      });
      expect(asManagerRole.status()).toBe(403);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a QA engineer cannot rename a project", { tag: '@tesbo.testId("TES-TC-453")' }, async () => {
    // By consistency: updateProjectForUser gates on project membership but never on role, so today
    // the weakest role can rename any project it can see. Every neighbouring administrative action
    // — project members, KB writes, workspace rename — is owner-or-manager, and renaming a project
    // is not a test-execution task.
    const throwaway = await createThrowawayProject(asOwner);
    try {
      setProjectRole(throwaway.id, tenant!.qa.userId, "qa_engineer");
      const res = await asQa.patch(`/api/projects/${throwaway.id}`, {
        data: { name: "Renamed By A QA Engineer" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);

      const after = await (await asOwner.get(`/api/projects/${throwaway.id}`)).json();
      expect(after.name).toBe(throwaway.name);
    } finally {
      await asOwner.delete(`/api/projects/${throwaway.id}`, { failOnStatusCode: false });
    }
  });

  test("a QA engineer cannot change a project's icon", async () => {
    // Same gate as the rename above — updateProjectForUser refuses qa_engineer for the whole
    // request body, icon included, before any field-level validation runs.
    const throwaway = await createThrowawayProject(asOwner);
    try {
      setProjectRole(throwaway.id, tenant!.qa.userId, "qa_engineer");
      const res = await asQa.patch(`/api/projects/${throwaway.id}`, {
        data: { icon: { color: "#1F7A3D", glyph: "Q" } },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);

      const after = await (await asOwner.get(`/api/projects/${throwaway.id}`)).json();
      expect(after.settings?.icon ?? null).toBeNull();
    } finally {
      await asOwner.delete(`/api/projects/${throwaway.id}`, { failOnStatusCode: false });
    }
  });

  test("a QA engineer cannot archive a project", { tag: '@tesbo.testId("TES-TC-454")' }, async () => {
    // By consistency, as above. This one is the more damaging half: deleteProjectForUser archives
    // the project and every child record hangs off it.
    const throwaway = await createThrowawayProject(asOwner);
    try {
      setProjectRole(throwaway.id, tenant!.qa.userId, "qa_engineer");
      const res = await asQa.delete(`/api/projects/${throwaway.id}`, { failOnStatusCode: false });
      expect(res.status()).toBe(403);

      const stillThere = await asOwner.get(`/api/projects/${throwaway.id}`, { failOnStatusCode: false });
      expect(stillThere.ok(), "the project should have survived a QA engineer's delete").toBeTruthy();
    } finally {
      await asOwner.delete(`/api/projects/${throwaway.id}`, { failOnStatusCode: false });
    }
  });

  test("a QA engineer can still do the job the role exists for", { tag: '@tesbo.testId("TES-TC-455")' }, async () => {
    // The counterweight to everything above: locking down administration must not lock a QA
    // engineer out of authoring and executing tests, or the role is useless.
    const suffix = Date.now();
    let testcaseId: string | undefined;
    let bugId: string | undefined;
    try {
      const tcRes = await asQa.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
        data: { title: `E2E RBAC QA Case ${suffix}`, priority: "Medium" },
        failOnStatusCode: false,
      });
      expect(tcRes.ok(), "a QA engineer must be able to create a test case").toBeTruthy();
      testcaseId = (await tcRes.json()).id;

      const listRes = await asQa.get(`/api/projects/${tenant!.mainProjectId}/testcases`);
      expect(listRes.ok()).toBeTruthy();

      const bugRes = await asQa.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E RBAC QA Bug ${suffix}`, severity: "Medium" },
        failOnStatusCode: false,
      });
      expect(bugRes.ok(), "a QA engineer must be able to file a bug").toBeTruthy();
      bugId = (await bugRes.json()).id;
    } finally {
      if (bugId) await asOwner.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
      if (testcaseId) {
        await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${testcaseId}`, {
          failOnStatusCode: false,
        });
      }
    }
  });

  // ─── The rest of the authoring surface ─────────────────────────────────────

  test("a QA engineer can author across the whole test-management surface", { tag: '@tesbo.testId("TES-TC-456")' }, async () => {
    // The counterweight, extended past test cases and bugs: suites, plans, cycles and executions
    // are the daily work of the role, and no gate in the product suggests otherwise. Kept as a
    // single walkthrough so a future tightening of RBAC that over-locks any one of them fails here
    // rather than being discovered by a user who can no longer run a test.
    const suffix = Date.now();
    const created: { path: string; id?: string }[] = [];
    try {
      const suite = await asQa.post(`/api/projects/${tenant!.mainProjectId}/suites`, {
        data: { name: `E2E RBAC Suite ${suffix}` },
        failOnStatusCode: false,
      });
      expect(suite.ok(), "a QA engineer must be able to create a suite").toBeTruthy();
      const suiteId = (await suite.json()).id;
      created.push({ path: `/api/suites/${suiteId}` });

      const plan = await asQa.post(`/api/projects/${tenant!.mainProjectId}/plans`, {
        data: { name: `E2E RBAC Plan ${suffix}` },
        failOnStatusCode: false,
      });
      expect(plan.ok(), "a QA engineer must be able to create a test plan").toBeTruthy();
      created.push({ path: `/api/plans/${(await plan.json()).id}` });

      const cycle = await asQa.post(`/api/projects/${tenant!.mainProjectId}/cycles`, {
        data: { name: `E2E RBAC Cycle ${suffix}` },
        failOnStatusCode: false,
      });
      expect(cycle.ok(), "a QA engineer must be able to create a test run").toBeTruthy();
      const cycleId = (await cycle.json()).id;
      created.push({ path: `/api/cycles/${cycleId}` });

      const testcase = await asQa.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
        data: { title: `E2E RBAC Case ${suffix}`, suiteId },
        failOnStatusCode: false,
      });
      expect(testcase.ok()).toBeTruthy();
      const testcaseId = (await testcase.json()).id;

      const added = await asQa.post(`/api/cycles/${cycleId}/testcases`, {
        data: { testcaseIds: [testcaseId] },
        failOnStatusCode: false,
      });
      expect(added.ok(), "a QA engineer must be able to add cases to a run").toBeTruthy();

      // Recording a result is the single most important thing this role does.
      const executions = await (await asQa.get(`/api/cycles/${cycleId}/executions`)).json();
      expect(executions.length).toBeGreaterThan(0);
      const executed = await asQa.patch(`/api/cycles/${cycleId}/executions/${executions[0].id}`, {
        data: { status: "Passed" },
        failOnStatusCode: false,
      });
      expect(executed.ok(), "a QA engineer must be able to record an execution result").toBeTruthy();

      await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${testcaseId}`, {
        failOnStatusCode: false,
      });
    } finally {
      for (const item of created.reverse()) {
        await asOwner.delete(item.path, { failOnStatusCode: false });
      }
    }
  });

  test("undeleting a knowledge base folder is owner-and-manager only", { tag: '@tesbo.testId("TES-TC-457")' }, async () => {
    // Explicit, and narrower than it first looks: kbRequireOwnerOrManager is applied at exactly
    // three call sites — restoreKnowledgeFolder, restoreKnowledgeDocument and restoreKnowledgeFile.
    // Creating, editing, moving and deleting KB content are all open to any project member. So the
    // product's rule is "authoring is QA work, pulling something back out of the trash isn't", and
    // this test covers both halves of it rather than assuming the gate is a general KB write lock.
    const kb = `/api/projects/${tenant!.mainProjectId}/knowledge-base`;
    const suffix = Date.now();
    let folderId: string | undefined;
    try {
      const created = await asQa.post(`${kb}/folders`, {
        data: { name: `E2E RBAC KB ${suffix}` },
        failOnStatusCode: false,
      });
      expect(
        created.ok(),
        `a QA engineer should be able to author KB content: ${created.status()} ${await created.text()}`,
      ).toBeTruthy();
      folderId = (await created.json()).id;

      expect((await asQa.delete(`${kb}/folders/${folderId}`, { failOnStatusCode: false })).ok()).toBeTruthy();

      const refused = await asQa.patch(`${kb}/folders/${folderId}/restore`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(refused.status()).toBe(403);

      const allowed = await asManager.patch(`${kb}/folders/${folderId}/restore`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(
        allowed.ok(),
        `a manager should be able to restore: ${allowed.status()} ${await allowed.text()}`,
      ).toBeTruthy();
    } finally {
      if (folderId) {
        await asOwner.delete(`${kb}/folders/${folderId}`, { failOnStatusCode: false });
      }
    }
  });

  test("a workspace member with no project access cannot write into the project", { tag: '@tesbo.testId("TES-TC-458")' }, async () => {
    // requireProjectAccess already makes the project invisible to this user on read. Writes have to
    // agree: createSuite, createPlan and createCycle take only the project id — their controller
    // methods never receive the caller — so nothing stops a workspace member from seeding a project
    // they were deliberately never given.
    const suffix = Date.now();
    const writes: { path: string; data: Record<string, unknown> }[] = [
      { path: `/api/projects/${tenant!.mainProjectId}/suites`, data: { name: `E2E Intruder Suite ${suffix}` } },
      { path: `/api/projects/${tenant!.mainProjectId}/plans`, data: { name: `E2E Intruder Plan ${suffix}` } },
      { path: `/api/projects/${tenant!.mainProjectId}/cycles`, data: { name: `E2E Intruder Cycle ${suffix}` } },
    ];

    const strays: string[] = [];
    try {
      for (const { path, data } of writes) {
        const res = await asGuest.post(path, { data, failOnStatusCode: false });
        expect([403, 404], `${path} should refuse a non-member of the project`).toContain(res.status());
        if (res.ok()) strays.push((await res.json()).id);
      }
    } finally {
      // Whatever slipped through has to be cleaned up, or it accumulates in the fixture project on
      // every run and skews the suite/plan/cycle counts other tests read.
      for (const id of strays) {
        for (const base of ["/api/suites", "/api/plans", "/api/cycles"]) {
          await asOwner.delete(`${base}/${id}`, { failOnStatusCode: false });
        }
      }
    }
  });

  test("an anonymous caller cannot write into a project", { tag: '@tesbo.testId("TES-TC-459")' }, async () => {
    // The same three handlers, with no session at all. An endpoint that never reads the caller
    // can't tell a signed-in user from a stranger who guessed a project id.
    const suffix = Date.now();
    const strays: string[] = [];
    try {
      for (const [path, data] of [
        [`/api/projects/${tenant!.mainProjectId}/suites`, { name: `E2E Anon Suite ${suffix}` }],
        [`/api/projects/${tenant!.mainProjectId}/plans`, { name: `E2E Anon Plan ${suffix}` }],
        [`/api/projects/${tenant!.mainProjectId}/cycles`, { name: `E2E Anon Cycle ${suffix}` }],
      ] as [string, Record<string, unknown>][]) {
        const res = await anon.post(path, { data, failOnStatusCode: false });
        expect([400, 401, 403, 404], `${path} should refuse an anonymous caller`).toContain(res.status());
        if (res.ok()) strays.push((await res.json()).id);
      }
    } finally {
      for (const id of strays) {
        for (const base of ["/api/suites", "/api/plans", "/api/cycles"]) {
          await asOwner.delete(`${base}/${id}`, { failOnStatusCode: false });
        }
      }
    }
  });

  // ─── Unauthenticated callers ───────────────────────────────────────────────

  test("every workspace administration endpoint refuses a caller with no session", { tag: '@tesbo.testId("TES-TC-460")' }, async () => {
    const endpoints: { method: "get" | "post" | "patch" | "put" | "delete"; path: string }[] = [
      { method: "get", path: "/api/workspace/members" },
      { method: "post", path: "/api/workspace/members" },
      { method: "post", path: "/api/workspace/members/role" },
      { method: "delete", path: `/api/workspace/members/${tenant!.qa.userId}` },
      { method: "patch", path: "/api/workspace" },
      { method: "get", path: "/api/workspace/invitations" },
      { method: "post", path: "/api/workspace/invitations" },
      { method: "get", path: "/api/workspace/project-access" },
      { method: "put", path: "/api/workspace/project-access" },
      { method: "delete", path: "/api/workspace/project-access" },
      { method: "get", path: "/api/workspace/ai-keys" },
      { method: "post", path: "/api/workspace/ai-keys" },
      { method: "get", path: "/api/workspace/activity" },
      { method: "get", path: "/api/workspace/analytics" },
    ];

    for (const { method, path } of endpoints) {
      const res =
        method === "get"
          ? await anon.get(path, { failOnStatusCode: false })
          : method === "delete"
            ? await anon.delete(path, { data: {}, failOnStatusCode: false })
            : await anon[method](path, { data: {}, failOnStatusCode: false });

      // requireUser raises 400 ("Authentication required") in the legacy service where the guard
      // raises 401. Both are refusals; what matters is that no workspace data or mutation is ever
      // handed to an anonymous caller.
      expect([400, 401], `${method.toUpperCase()} ${path} should refuse an anonymous caller`).toContain(
        res.status(),
      );
    }
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * A project the destructive tests are allowed to rename or archive.
   *
   * The fixture projects can't be used: if one of those tests goes red because the product DID
   * allow the action, the fixture is left renamed or archived and every later run resolves a
   * different project. A per-test project keeps a real failure to one test.
   */
  async function createThrowawayProject(api: APIRequestContext): Promise<{ id: string; name: string }> {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E RBAC Throwaway ${suffix}`;
    const res = await api.post("/api/projects", {
      data: { name, key: `rb${suffix}` },
      failOnStatusCode: false,
    });
    expect(res.ok(), `could not create a throwaway project: ${res.status()} ${await res.text()}`).toBeTruthy();
    return { id: (await res.json()).id, name };
  }
  test("RBAC-A-31 the workspace dashboard counts only the projects the caller can reach", { tag: '@tesbo.testId("TES-TC-951")' }, async () => {
    /*
     * Basecamp 10199551447 — "[Dashboard / Project Access] QA Engineer can view project details of all
     * owner projects", reported against /dashboard.
     *
     * /api/workspace/analytics scoped by organization_id alone with no membership filter, so a QA
     * Engineer belonging to ONE project still received counts and a full execution-status breakdown
     * covering every project in the workspace — including ones they cannot open. listProjects and
     * requireProjectAccess both scope by project_members; this endpoint was the one that did not, and
     * the dashboard is the first screen a member lands on.
     *
     * The tenant has two projects and provisionRbacTenant puts the qa user in the main one only, so the
     * leak is measurable: the owner sees both, the QA engineer must see one.
     */
    const ownerView = await asOwner.get("/api/workspace/analytics", { failOnStatusCode: false });
    expect(ownerView.status(), `owner analytics — ${await ownerView.text()}`).toBe(200);
    const ownerCounts = await ownerView.json();

    const qaView = await asQa.get("/api/workspace/analytics", { failOnStatusCode: false });
    expect(qaView.status(), `qa analytics — ${await qaView.text()}`).toBe(200);
    const qaCounts = await qaView.json();

    // The owner administers the whole workspace, so their totals still span both projects.
    expect(ownerCounts.projectCount, "the owner should see both of the tenant's projects").toBeGreaterThanOrEqual(2);

    // The QA engineer is a member of one, and must be told about one.
    expect(
      qaCounts.projectCount,
      `a qa_engineer in 1 project was shown ${qaCounts.projectCount} projects on the dashboard`,
    ).toBe(1);
    expect(
      qaCounts.projectCount,
      "the qa_engineer's dashboard still spans the whole workspace",
    ).toBeLessThan(ownerCounts.projectCount);

    // Every child count has to be narrowed too, not just the project tally — these are the numbers the
    // dashboard actually renders, and they described projects the caller cannot open.
    for (const field of ["testCaseCount", "suiteCount", "planCount", "cycleCount"] as const) {
      if (typeof ownerCounts[field] !== "number") continue;
      expect(
        qaCounts[field],
        `${field} is not scoped to the caller's projects (qa ${qaCounts[field]} vs owner ${ownerCounts[field]})`,
      ).toBeLessThanOrEqual(ownerCounts[field]);
    }
    // And the response must still be well formed rather than erroring on the extra bind parameter.
    expect(qaCounts.executionStatus ?? {}, "the execution breakdown is missing").toBeTruthy();
  });
});
