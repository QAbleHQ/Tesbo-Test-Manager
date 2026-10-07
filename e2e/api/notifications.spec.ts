import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { env, testAddress } from "../utils/env";
import { exec, literal, scalar } from "../utils/psql";
import {
  clearInvitations,
  detachUserByEmail,
  loginAs,
  mintInviteToken,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  resetRbacMembership,
  seedFixtureUser,
  setOrgRole,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * GET /api/notifications and POST /api/notifications/:id/read.
 *
 * The bell icon in TopBar.tsx had no onClick at all (BetterBugs "Notification Icon Does Not
 * Respond When Clicked") — fixed by wiring it to a dropdown panel that calls these two routes.
 *
 * Both routes were hardcoded stubs at first (no notifications table wired up: GET always answered
 * an empty list, POST always 404'd) — this spec originally pinned only that stub contract. The
 * archive-sweep notification work (ZYRA_IMPLEMENTATION_LOG.md) gave the table its first real
 * writer/readers; NOTIF-A-01..05 below turned out to describe the real implementation's contract
 * too (an authenticated 200 array, a 400 for anonymous callers, 404 for a nonexistent/malformed
 * id) by coincidence, not by re-verification at the time, so they were left as-is. NOTIF-A-06/07
 * add the part the stub-era version had no way to cover: real content shape and the
 * mark-read round trip against a genuinely persisted row.
 */

test.describe("notifications", () => {
  test("NOTIF-A-01 an authenticated caller gets a 200 array", { tag: '@tesbo.testId("TES-TC-1178")' }, async ({ request }) => {
    const res = await request.get("/api/notifications", { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), `expected an array, got ${JSON.stringify(body)}`).toBe(true);
  });

  test("NOTIF-A-02 an unauthenticated caller is refused, not served an empty list", { tag: '@tesbo.testId("TES-TC-1179")' }, async () => {
    const anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      const res = await anon.get("/api/notifications", { failOnStatusCode: false });
      // requireSession raises BadRequest ("Authentication required"), matching the rest of the
      // legacy service — see authorization.spec.ts's note on this being 400 rather than 401.
      expect(res.status(), await res.text()).toBe(400);
    } finally {
      await anon.dispose();
    }
  });

  test("NOTIF-A-03 marking a nonexistent notification read answers 404, not a silent success", { tag: '@tesbo.testId("TES-TC-1180")' }, async ({
    request,
  }) => {
    const res = await request.post(`/api/notifications/${crypto.randomUUID()}/read`, {
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(404);
  });

  test("NOTIF-A-04 a malformed id is still a clean 404, not a 500", { tag: '@tesbo.testId("TES-TC-1181")' }, async ({ request }) => {
    for (const id of ["not-a-uuid", "", "..%2F..", "1 OR 1=1"]) {
      const res = await request.post(`/api/notifications/${encodeURIComponent(id)}/read`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `id=${JSON.stringify(id)} — ${await res.text()}`).toBeLessThan(500);
    }
  });

  test("NOTIF-A-05 an unauthenticated caller cannot mark a notification read", { tag: '@tesbo.testId("TES-TC-1182")' }, async () => {
    const anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      const res = await anon.post(`/api/notifications/${crypto.randomUUID()}/read`, {
        failOnStatusCode: false,
      });
      expect(res.status(), await res.text()).toBe(400);
    } finally {
      await anon.dispose();
    }
  });
});

/*
 * A real, persisted notification row — the part NOTIF-A-01..05 can't reach, since the smoke
 * account (account A) never has one naturally. The rows below are inserted directly (no writer
 * currently in the product creates a *generic* notification through the API — the archive sweep's
 * own writer, LegacyService.notifyProjectMembers, is exercised at the unit level in
 * zyra-notifications.spec.ts and zyra-archive-sweep.service.spec.ts; this suite is about the two
 * HTTP routes any notification's row flows through, whoever wrote it), matching TopBar.tsx's own
 * resolveNotificationHref() convention (`link_entity_type: "zyra_task_board"`,
 * `link_entity_id: <projectId>`) so this also pins the shape the frontend's click-to-navigate
 * depends on.
 */
test.describe("notifications — real rows", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("notifications");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
  });

  test.afterAll(async () => {
    await Promise.all([asOwner, asManager].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /** Inserts a notification row for `userId` and returns its id. Caller deletes it in `finally`. */
  function seedNotification(userId: string, projectId: string): string {
    const id = crypto.randomUUID();
    exec(
      `INSERT INTO notifications (id, user_id, type, title, body, link_entity_type, link_entity_id) ` +
        `VALUES (${literal(id)}, ${literal(userId)}, 'zyra_archive_sweep', 'Zyra found 2 archive candidates', ` +
        `'Review them on the Zyra task board.', 'zyra_task_board', ${literal(projectId)});`,
    );
    return id;
  }

  function deleteNotification(id: string): void {
    exec(`DELETE FROM notifications WHERE id = ${literal(id)};`);
  }

  test("NOTIF-A-06 a real row's full shape comes back, including the link fields the frontend navigates on", { tag: '@tesbo.testId("TES-TC-1356")' }, async () => {
    const id = seedNotification(tenant!.owner.userId, tenant!.mainProjectId);
    try {
      const res = await asOwner.get("/api/notifications", { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      const row = body.find((n: { id: string }) => n.id === id);
      expect(row, `seeded notification ${id} not found in ${JSON.stringify(body)}`).toBeTruthy();
      expect(row).toMatchObject({
        type: "zyra_archive_sweep",
        title: "Zyra found 2 archive candidates",
        link_entity_type: "zyra_task_board",
        link_entity_id: tenant!.mainProjectId,
        read_at: null,
      });
    } finally {
      deleteNotification(id);
    }
  });

  test("NOTIF-A-07 marking it read persists, and a repeat call is a harmless no-op rather than an error or a moved read_at", { tag: '@tesbo.testId("TES-TC-1357")' }, async () => {
    const id = seedNotification(tenant!.owner.userId, tenant!.mainProjectId);
    try {
      // 201, not 200: readNotification has no @HttpCode() decorator, so it gets NestJS's default
      // status for a @Post() handler. Confirmed against legacy.controller.ts rather than assumed.
      const first = await asOwner.post(`/api/notifications/${id}/read`, { failOnStatusCode: false });
      expect(first.status(), await first.text()).toBe(201);

      const afterFirst = await asOwner.get("/api/notifications", { failOnStatusCode: false });
      const rowAfterFirst = (await afterFirst.json()).find((n: { id: string }) => n.id === id);
      expect(rowAfterFirst.read_at, "read_at should be set after the first mark-read").toBeTruthy();
      const readAt = rowAfterFirst.read_at;

      // Simulates the double-click / second-tab race TopBar.tsx's own comment calls out: the
      // COALESCE(read_at, now()) in markNotificationRead must re-affirm, not error or move the
      // timestamp forward.
      const second = await asOwner.post(`/api/notifications/${id}/read`, { failOnStatusCode: false });
      expect(second.status(), await second.text()).toBe(201);

      const afterSecond = await asOwner.get("/api/notifications", { failOnStatusCode: false });
      const rowAfterSecond = (await afterSecond.json()).find((n: { id: string }) => n.id === id);
      expect(rowAfterSecond.read_at, "a second mark-read moved read_at instead of leaving it alone").toBe(readAt);
    } finally {
      deleteNotification(id);
    }
  });

  test("NOTIF-A-09 mark all as read clears every unread row of the caller — and only the caller's", async () => {
    const mine = [seedNotification(tenant!.owner.userId, tenant!.mainProjectId), seedNotification(tenant!.owner.userId, tenant!.mainProjectId)];
    const theirs = seedNotification(tenant!.manager.userId, tenant!.mainProjectId);
    try {
      // One already read before the call: its timestamp must stay where it was.
      expect((await asOwner.post(`/api/notifications/${mine[0]}/read`)).status()).toBe(201);
      const readAt = (await (await asOwner.get("/api/notifications")).json()).find((n: { id: string }) => n.id === mine[0]).read_at;

      const res = await asOwner.post("/api/notifications/read-all", { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(201);
      expect(await res.json()).toMatchObject({ ok: true });

      const owner = await (await asOwner.get("/api/notifications")).json();
      for (const id of mine) expect(owner.find((n: { id: string }) => n.id === id).read_at, `${id} should be read`).toBeTruthy();
      expect(owner.find((n: { id: string }) => n.id === mine[0]).read_at, "an already-read row keeps its timestamp").toBe(readAt);

      // A teammate's unread row is not the caller's to clear.
      const manager = await (await asManager.get("/api/notifications")).json();
      expect(manager.find((n: { id: string }) => n.id === theirs).read_at).toBeNull();

      // Nothing left to mark: a repeat is a harmless no-op.
      const again = await asOwner.post("/api/notifications/read-all", { failOnStatusCode: false });
      expect(again.status()).toBe(201);
      expect((await again.json()).updated).toBe(0);
    } finally {
      [...mine, theirs].forEach(deleteNotification);
    }
  });

  test("NOTIF-A-10 an unauthenticated caller cannot mark all as read", async () => {
    const anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      const res = await anon.post("/api/notifications/read-all", { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(400);
    } finally {
      await anon.dispose();
    }
  });

  test("NOTIF-A-08 a teammate in the same workspace does not see another member's notification", { tag: '@tesbo.testId("TES-TC-1358")' }, async () => {
    const id = seedNotification(tenant!.owner.userId, tenant!.mainProjectId);
    try {
      const res = await asManager.get("/api/notifications", { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.find((n: { id: string }) => n.id === id), "a teammate's own notification row leaked to another member").toBeUndefined();

      // The route-level 404 (NOTIF-A-03) is "doesn't exist at all"; this is the sharper case —
      // it DOES exist, just not for this caller — and markNotificationRead scopes its UPDATE to
      // `id AND user_id`, so a non-owner's attempt finds no matching row either.
      const readRes = await asManager.post(`/api/notifications/${id}/read`, { failOnStatusCode: false });
      expect(readRes.status(), await readRes.text()).toBe(404);
    } finally {
      deleteNotification(id);
    }
  });
});

/*
 * The Phase 1 notification matrix: workspace + project membership, test runs, bugs.
 *
 * Messages are asserted verbatim — they are the product matrix's wording, so a reworded string is a
 * behaviour change. Every scenario also pins who does NOT hear about it: the actor (never notified
 * of their own action), and members of the same workspace who have no reason to care.
 *
 * Own tenant ("notification-events"): these tests change roles, remove members and accept
 * invitations. Fixtures carry a unique stamp in their names and everything is purged in afterEach,
 * so re-runs against the persistent volume don't collide.
 */
test.describe("notifications — Phase 1 matrix", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let workspaceName = "";
  const PROJECT_NAME = "RBAC Main Project";
  const SECOND_PROJECT_NAME = "RBAC Second Project";

  type Row = { id: string; type: string; title: string; link_entity_type: string | null; link_entity_id: string | null; read_at: string | null };

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("notification-events");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    workspaceName = (await (await asOwner.get("/api/workspace")).json()).name;
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) {
      purge(tenant);
      resetRbacMembership(tenant);
    }
    await Promise.all([asOwner, asManager, asQa, asGuest].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) {
      purge(tenant);
      resetRbacMembership(tenant);
      clearInvitations(tenant);
    }
  });

  function purge(t: RbacTenant): void {
    const users = [t.owner, t.manager, t.qa, t.guest].map((u) => literal(u.userId)).join(", ");
    exec(`DELETE FROM notifications WHERE user_id IN (${users});`);
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM bug_comments WHERE project_id IN (${projects});`);
    exec(`DELETE FROM bug_links WHERE bug_id IN (SELECT id FROM bugs WHERE project_id IN (${projects}) AND title LIKE 'E2E Notif%');`);
    exec(`DELETE FROM bugs WHERE project_id IN (${projects}) AND title LIKE 'E2E Notif%';`);
    exec(
      "DELETE FROM executions WHERE cycle_item_id IN (SELECT ci.id FROM cycle_items ci JOIN cycles c " +
        `ON c.id = ci.cycle_id WHERE c.project_id IN (${projects}) AND c.name LIKE 'E2E Notif%');`,
    );
    exec(`DELETE FROM cycle_items WHERE cycle_id IN (SELECT id FROM cycles WHERE project_id IN (${projects}) AND name LIKE 'E2E Notif%');`);
    exec(`DELETE FROM cycles WHERE project_id IN (${projects}) AND name LIKE 'E2E Notif%';`);
    exec(`DELETE FROM testcases WHERE project_id IN (${projects}) AND title LIKE 'E2E Notif%';`);
  }

  const stamp = (label: string) => `E2E Notif ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

  async function inbox(api: APIRequestContext): Promise<Row[]> {
    const res = await api.get("/api/notifications");
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }

  /** Titles in a user's inbox, newest first. */
  async function titles(api: APIRequestContext): Promise<string[]> {
    return (await inbox(api)).map((r) => r.title);
  }

  async function newBug(data: Record<string, unknown> = {}): Promise<{ id: string; externalId: string }> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, { data: { title: stamp("bug"), ...data }, failOnStatusCode: false });
    expect(res.status(), `creating a bug — ${await res.text()}`).toBeLessThan(300);
    return res.json();
  }

  async function seedRun(count = 2): Promise<{ cycleId: string; cycleName: string; executionIds: string[]; tcIds: string[] }> {
    const testcaseIds: string[] = [];
    const tcIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, { data: { title: stamp(`case ${i + 1}`) } });
      expect(res.status(), await res.text()).toBe(201);
      const tc = await res.json();
      testcaseIds.push(tc.id);
      tcIds.push(tc.externalId);
    }
    const cycleName = stamp("run");
    // ownerId: the run owner is one of the two recipients of a failed / blocked case.
    const cycle = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/cycles`, { data: { name: cycleName, ownerId: tenant!.owner.userId } });
    expect(cycle.status(), await cycle.text()).toBe(201);
    const cycleId = (await cycle.json()).id;
    expect((await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } })).status()).toBeLessThan(400);
    const executions = await (await asOwner.get(`/api/cycles/${cycleId}/executions`)).json();
    return { cycleId, cycleName, executionIds: executions.map((e: { id: string }) => e.id), tcIds };
  }

  // ─── Workspace ─────────────────────────────────────────────────────────────

  test("NOTIF-P1-01 a workspace role change tells the affected user, once, and only on a real change", async () => {
    const change = (role: string) => asOwner.post("/api/workspace/members/role", { data: { userId: tenant!.qa.userId, role }, failOnStatusCode: false });
    expect((await change("manager")).ok()).toBeTruthy();

    const qa = await inbox(asQa);
    expect(qa.map((n) => n.title)).toEqual([`Your role in ${workspaceName} has been changed to Manager.`]);
    expect(qa[0]).toMatchObject({ type: "workspace_role_changed", read_at: null });
    // The actor is never told about their own action, and a bystander has no reason to be.
    expect(await titles(asOwner)).toEqual([]);
    expect(await titles(asManager)).toEqual([]);

    // Re-submitting the role they already hold is not a change.
    expect((await change("manager")).ok()).toBeTruthy();
    expect(await titles(asQa)).toHaveLength(1);
  });

  test("NOTIF-P1-02 removing someone from the workspace tells them, with a link they can still click", async () => {
    const res = await asOwner.delete(`/api/workspace/members/${tenant!.qa.userId}`, { failOnStatusCode: false });
    expect(res.ok(), await res.text()).toBeTruthy();

    // Read straight from the table: the removed user can no longer reach the workspace through the
    // API, and the notification is the only thing that tells them why.
    const rows = scalar(
      `SELECT COALESCE(string_agg(title || '|' || COALESCE(link_entity_type, ''), ';'), '') FROM notifications WHERE user_id = ${literal(tenant!.qa.userId)};`,
    );
    expect(rows).toBe(`You have been removed from ${workspaceName}.|projects_list`);
    expect(await titles(asOwner)).toEqual([]);
  });

  test("NOTIF-P1-03 a workspace invitation reaches an existing user once, and the acceptance reaches the inviter once", async () => {
    const email = testAddress(`notif-invite-${Date.now()}`);
    const invitee = seedFixtureUser(email, "E2E Notif Invitee");
    const asInvitee = await loginAs(invitee);
    try {
      const created = await asOwner.post("/api/workspace/invitations", { data: { email, role: "qa_engineer", projectIds: [tenant!.secondProjectId] } });
      expect(created.ok(), await created.text()).toBeTruthy();
      const { id } = await created.json();

      // An invitation that includes a project is two invitations: one to the workspace, one to the project.
      expect((await titles(asInvitee)).sort()).toEqual(
        [`You've been invited to join ${SECOND_PROJECT_NAME}.`, `You've been invited to join ${workspaceName}.`].sort(),
      );
      // Both open the accept page the invitation email links to: /invite/<token>.
      const created1 = await inbox(asInvitee);
      expect(created1.every((n) => n.link_entity_type === "invitation" && /^[0-9a-f]{64}$/.test(n.link_entity_id ?? ""))).toBe(true);
      const firstToken = created1[0].link_entity_id;

      // Resending reuses the invitation's dedupe key: still one of each. It also rotates the token,
      // so the existing notifications must now carry the new one, not a dead link.
      expect((await asOwner.post(`/api/workspace/invitations/${id}/resend`, { failOnStatusCode: false })).ok()).toBeTruthy();
      const afterResend = await inbox(asInvitee);
      expect(afterResend).toHaveLength(2);
      expect(afterResend[0].link_entity_id).not.toBe(firstToken);
      expect(new Set(afterResend.map((n) => n.link_entity_id)).size).toBe(1);

      // If the original send never produced a notification, resending is the repair.
      exec(`DELETE FROM notifications WHERE user_id = ${literal(invitee.userId)};`);
      expect(await inbox(asInvitee)).toHaveLength(0);
      expect((await asOwner.post(`/api/workspace/invitations/${id}/resend`, { failOnStatusCode: false })).ok()).toBeTruthy();
      const repaired = await inbox(asInvitee);
      expect(repaired.map((n) => n.title).sort()).toEqual(
        [`You've been invited to join ${SECOND_PROJECT_NAME}.`, `You've been invited to join ${workspaceName}.`].sort(),
      );
      expect(repaired.every((n) => n.link_entity_type === "invitation")).toBe(true);

      const token = mintInviteToken(id);
      const accept = await asInvitee.post(`/api/invitations/${token}/accept`, { data: {}, failOnStatusCode: false });
      expect(accept.ok(), await accept.text()).toBeTruthy();

      // The owner is both the inviter and a workspace/project owner, and still gets exactly one of each.
      const owner = await titles(asOwner);
      expect(owner.filter((t) => t === `E2E Notif Invitee accepted your invitation to ${workspaceName}.`)).toHaveLength(1);
      expect(owner.filter((t) => t === `E2E Notif Invitee accepted your invitation to ${SECOND_PROJECT_NAME}.`)).toHaveLength(1);
      // Not the inviter, not an owner: no notification.
      expect(await titles(asManager)).toEqual([]);
      expect(await titles(asQa)).toEqual([]);
      // The accepting user is the actor of the acceptance.
      expect((await titles(asInvitee)).some((t) => t.includes("accepted your invitation"))).toBe(false);
    } finally {
      await asInvitee.dispose();
      exec(`DELETE FROM notifications WHERE user_id = ${literal(invitee.userId)};`);
      detachUserByEmail(email);
    }
  });

  test("NOTIF-P1-04 inviting an email with no account writes no notification and does not fail the invite", async () => {
    const email = testAddress(`notif-noaccount-${Date.now()}`);
    const res = await asOwner.post("/api/workspace/invitations", { data: { email, role: "qa_engineer" }, failOnStatusCode: false });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect(
      scalar(
        `SELECT COUNT(*) FROM notifications WHERE title LIKE ${literal(`%invited to join ${workspaceName}%`)} ` +
          `AND user_id IN (SELECT id FROM users WHERE lower(email) = ${literal(email.toLowerCase())});`,
      ),
    ).toBe("0");
  });

  // ─── Project ───────────────────────────────────────────────────────────────

  test("NOTIF-P1-05 adding, re-roling and removing a project member each tell that member", async () => {
    const base = `/api/projects/${tenant!.mainProjectId}/members`;
    const added = await asOwner.post(base, { data: { userId: tenant!.guest.userId, role: "qa_engineer" }, failOnStatusCode: false });
    expect(added.ok(), await added.text()).toBeTruthy();
    expect(await titles(asGuest)).toEqual([`You've been invited to join ${PROJECT_NAME}.`]);

    // Same role again: not a change.
    expect((await asOwner.post(base, { data: { userId: tenant!.guest.userId, role: "qa_engineer" }, failOnStatusCode: false })).ok()).toBeTruthy();
    expect(await titles(asGuest)).toHaveLength(1);

    expect((await asOwner.post(base, { data: { userId: tenant!.guest.userId, role: "manager" }, failOnStatusCode: false })).ok()).toBeTruthy();
    expect((await titles(asGuest))[0]).toBe(`Your role in ${PROJECT_NAME} has been changed to Manager.`);

    const removed = await asOwner.delete(`${base}/${tenant!.guest.userId}`, { failOnStatusCode: false });
    expect(removed.ok(), await removed.text()).toBeTruthy();
    expect((await titles(asGuest))[0]).toBe(`You have been removed from ${PROJECT_NAME}.`);

    // The actor and an uninvolved member hear nothing.
    expect(await titles(asOwner)).toEqual([]);
    expect(await titles(asQa)).toEqual([]);
  });

  // ─── Bugs ──────────────────────────────────────────────────────────────────

  test("NOTIF-P1-06 a bug filed with an assignee tells the assignee, links to the bug, and read state persists", async () => {
    const bug = await newBug({ assigneeId: tenant!.qa.userId });
    const [row] = await inbox(asQa);
    expect(row.title).toBe(`Bug ${bug.externalId} has been assigned to you.`);
    expect(row).toMatchObject({ type: "bug_assigned", link_entity_type: "bug", link_entity_id: `${tenant!.mainProjectId}:${bug.id}`, read_at: null });
    expect(await titles(asOwner)).toEqual([]);

    // 201, not 200: see NOTIF-A-07.
    expect((await asQa.post(`/api/notifications/${row.id}/read`)).status()).toBe(201);
    expect((await inbox(asQa))[0].read_at).toBeTruthy();
  });

  test("NOTIF-P1-07 assigning, reassigning and self-assigning a bug notify the right person", async () => {
    const bug = await newBug();
    expect(await titles(asQa)).toEqual([]);

    expect((await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.qa.userId } })).ok()).toBeTruthy();
    expect(await titles(asQa)).toEqual([`Bug ${bug.externalId} has been assigned to you.`]);

    expect((await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.manager.userId } })).ok()).toBeTruthy();
    expect(await titles(asManager)).toEqual([`Bug ${bug.externalId} has been reassigned to you.`]);
    expect(await titles(asQa)).toHaveLength(1); // the previous assignee is not told

    // Assigning it to yourself is your own action on your own item.
    expect((await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.owner.userId } })).ok()).toBeTruthy();
    expect(await titles(asOwner)).toEqual([]);

    // Saving without changing the assignee notifies nobody new.
    expect((await asOwner.patch(`/api/bugs/${bug.id}`, { data: { title: stamp("renamed") } })).ok()).toBeTruthy();
    expect(await titles(asManager)).toHaveLength(1);
  });

  test("NOTIF-P1-08 a bug status change goes to the reporter and the assignee, never the person who made it", async () => {
    const bug = await newBug({ assigneeId: tenant!.manager.userId }); // reporter: owner, assignee: manager
    expect((await asQa.patch(`/api/bugs/${bug.id}`, { data: { status: "Closed" } })).ok()).toBeTruthy();

    const expected = `Bug ${bug.externalId} status changed to Closed.`;
    expect(await titles(asOwner)).toEqual([expected]);
    expect((await titles(asManager)).includes(expected)).toBe(true);
    expect(await titles(asQa)).toEqual([]);

    // The assignee closing their own bug: the reporter hears it, the assignee does not.
    const other = await newBug({ assigneeId: tenant!.manager.userId });
    expect((await asManager.patch(`/api/bugs/${other.id}`, { data: { status: "Closed" } })).ok()).toBeTruthy();
    expect((await titles(asOwner)).includes(`Bug ${other.externalId} status changed to Closed.`)).toBe(true);
    expect((await titles(asManager)).includes(`Bug ${other.externalId} status changed to Closed.`)).toBe(false);

    // A no-op status save is not a change.
    const count = (await titles(asOwner)).length;
    expect((await asManager.patch(`/api/bugs/${other.id}`, { data: { status: "Closed" } })).ok()).toBeTruthy();
    expect(await titles(asOwner)).toHaveLength(count);
  });

  test("NOTIF-P1-09 an @mention in a bug comment notifies the mentioned member only — not the author, not a non-member", async () => {
    const bug = await newBug();
    const res = await asQa.post(`/api/projects/${tenant!.mainProjectId}/bugs/${bug.id}/comments`, {
      // The guest is a workspace member but not a project member: never mentionable, never notified.
      data: { body: "@E2E notification-events Manager please look. cc @E2E notification-events Guest and @E2E notification-events QA" },
    });
    expect(res.status(), await res.text()).toBe(201);

    const [row] = await inbox(asManager);
    expect(row.title).toBe(`E2E notification-events QA mentioned you on bug ${bug.externalId}.`);
    expect(row).toMatchObject({ type: "bug_mentioned", link_entity_type: "bug", link_entity_id: `${tenant!.mainProjectId}:${bug.id}` });
    expect(await titles(asQa)).toEqual([]);
    expect(await titles(asGuest)).toEqual([]);
  });

  // ─── Comment replies ───────────────────────────────────────────────────────

  test("NOTIF-P1-09b a reply notifies everyone already in the thread — never the replier, never someone outside it", async () => {
    const bug = await newBug();
    const comments = `/api/projects/${tenant!.mainProjectId}/bugs/${bug.id}/comments`;
    const top = await asQa.post(comments, { data: { body: "Reproduced on build 42" } });
    expect(top.status(), await top.text()).toBe(201);
    const topId = (await top.json()).id;

    const reply = await asManager.post(comments, { data: { body: "Thanks, looking", parentCommentId: topId } });
    expect(reply.status(), await reply.text()).toBe(201);

    const [row] = await inbox(asQa);
    expect(row.title).toBe("E2E notification-events Manager replied to your comment.");
    expect(row).toMatchObject({ type: "comment_reply", link_entity_type: "bug", link_entity_id: `${tenant!.mainProjectId}:${bug.id}` });
    expect(await titles(asManager)).toEqual([]); // the replier
    expect(await titles(asOwner)).toEqual([]); // a bystander

    // The thread continues: the UI's Reply on a reply also sends the top comment as the parent, so the
    // earlier replier (manager) is told, and the author replying to their own thread is not.
    expect((await asQa.post(comments, { data: { body: "Adding detail", parentCommentId: topId } })).status()).toBe(201);
    expect(await titles(asQa)).toHaveLength(1);
    expect(await titles(asManager)).toEqual(["E2E notification-events QA replied to your comment."]);
    expect(await titles(asOwner)).toEqual([]);

    // A third person joining the thread tells both earlier participants, once each.
    expect((await asOwner.post(comments, { data: { body: "Same here", parentCommentId: topId } })).status()).toBe(201);
    expect(await titles(asQa)).toHaveLength(2);
    expect(await titles(asManager)).toHaveLength(2);
    expect(await titles(asOwner)).toEqual([]);

    // A top-level comment (not a reply) tells nobody.
    expect((await asManager.post(comments, { data: { body: "Unrelated note" } })).status()).toBe(201);
    expect(await titles(asQa)).toHaveLength(2);
    expect(await titles(asManager)).toHaveLength(2);
  });

  test("NOTIF-P1-09c a reply that also @mentions the author sends the mention, not a second notification", async () => {
    const bug = await newBug();
    const comments = `/api/projects/${tenant!.mainProjectId}/bugs/${bug.id}/comments`;
    const topId = (await (await asQa.post(comments, { data: { body: "First" } })).json()).id;
    const reply = await asManager.post(comments, { data: { body: "@E2E notification-events QA agreed", parentCommentId: topId } });
    expect(reply.status(), await reply.text()).toBe(201);
    expect(await titles(asQa)).toEqual([`E2E notification-events Manager mentioned you on bug ${bug.externalId}.`]);
  });

  test("NOTIF-P1-09d a reply to a knowledge base comment notifies its author and opens the document", async () => {
    const created = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { title: stamp("kb doc"), contentText: "Body", contentHtml: "<p>Body</p>", documentType: "general" },
      failOnStatusCode: false,
    });
    expect(created.ok(), `creating a document — ${await created.text()}`).toBeTruthy();
    const docId = (await created.json()).id;
    try {
      const comments = `/api/projects/${tenant!.mainProjectId}/knowledge-base/documents/${docId}/comments`;
      const top = await asQa.post(comments, { data: { body: "Is this still current?" } });
      expect(top.ok(), await top.text()).toBeTruthy();
      const topId = (await top.json()).id;
      expect((await asManager.post(comments, { data: { body: "Yes", parentCommentId: topId } })).ok()).toBeTruthy();

      const [row] = await inbox(asQa);
      expect(row.title).toBe("E2E notification-events Manager replied to your comment.");
      expect(row).toMatchObject({ type: "comment_reply", link_entity_type: "knowledge_document", link_entity_id: `${tenant!.mainProjectId}:${docId}` });
      expect(await titles(asManager)).toEqual([]);
    } finally {
      await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents/${docId}`, { failOnStatusCode: false });
    }
  });

  // ─── Test runs ─────────────────────────────────────────────────────────────

  test("NOTIF-P1-10 assigning a whole run is one notification, not one per case", async () => {
    const run = await seedRun(3);
    const res = await asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-assign`, { data: { executionIds: run.executionIds, assigneeId: tenant!.qa.userId } });
    expect(res.ok(), await res.text()).toBeTruthy();

    const rows = await inbox(asQa);
    expect(rows.map((r) => r.title)).toEqual([`You've been assigned to test run ${run.cycleName}.`]);
    expect(rows[0]).toMatchObject({ type: "test_run_assigned", link_entity_type: "test_run", link_entity_id: `${tenant!.mainProjectId}:${run.cycleId}` });
    expect(await titles(asOwner)).toEqual([]);
    expect(await titles(asManager)).toEqual([]);
  });

  test("NOTIF-P1-10b a run that has an ID is named with it, in the assigned and failed messages", async () => {
    const run = await seedRun(1);
    // cycles.external_id is only set by automation ingest, so a UI-made run has none; give this one
    // an ID the way ingest would, to see it carried into the message.
    const runId = `E2E-TR-${Date.now()}`;
    exec(`UPDATE cycles SET external_id = ${literal(runId)} WHERE id = ${literal(run.cycleId)};`);
    const label = `${runId} (${run.cycleName})`;

    expect((await asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-assign`, { data: { executionIds: run.executionIds, assigneeId: tenant!.qa.userId } })).ok()).toBeTruthy();
    expect(await titles(asQa)).toEqual([`You've been assigned to test run ${label}.`]);

    expect((await asManager.patch(`/api/cycles/${run.cycleId}/executions/${run.executionIds[0]}`, { data: { status: "Failed" } })).ok()).toBeTruthy();
    expect(await titles(asOwner)).toEqual([`${run.tcIds[0]} failed in test run ${label}.`]);
  });

  test("NOTIF-P1-11 a case failing or becoming blocked goes to the run owner and the case assignee, once per transition", async () => {
    const run = await seedRun(2);
    expect(
      (await asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-assign`, { data: { executionIds: [run.executionIds[0]], assigneeId: tenant!.qa.userId } })).ok(),
    ).toBeTruthy();
    exec(`DELETE FROM notifications WHERE user_id = ${literal(tenant!.qa.userId)};`);

    const setStatus = (executionId: string, status: string) => asManager.patch(`/api/cycles/${run.cycleId}/executions/${executionId}`, { data: { status } });
    expect((await setStatus(run.executionIds[0], "Failed")).ok()).toBeTruthy();

    const failed = `${run.tcIds[0]} failed in test run ${run.cycleName}.`;
    expect(await titles(asQa)).toEqual([failed]); // the case's assignee
    expect(await titles(asOwner)).toEqual([failed]); // the run's owner
    expect(await titles(asManager)).toEqual([]); // the actor
    expect(await titles(asGuest)).toEqual([]);

    // Saving Failed again is not a new failure.
    expect((await setStatus(run.executionIds[0], "Failed")).ok()).toBeTruthy();
    expect(await titles(asQa)).toHaveLength(1);

    expect((await setStatus(run.executionIds[1], "Blocked")).ok()).toBeTruthy();
    expect(await titles(asOwner)).toContain(`${run.tcIds[1]} is blocked in test run ${run.cycleName}.`);
    // Passing an unassigned case: the run owner is only told about Failed / Blocked (NOTIF-P1-13
    // covers an assignee being told about the rest).
    expect((await setStatus(run.executionIds[1], "Passed")).ok()).toBeTruthy();
    expect(await titles(asOwner)).toHaveLength(2);
  });

  test("NOTIF-P1-13 any other status change on a case tells its assignee — not the actor, not the run owner, and nobody when the case is unassigned", async () => {
    const run = await seedRun(2);
    expect(
      (await asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-assign`, { data: { executionIds: [run.executionIds[0]], assigneeId: tenant!.qa.userId } })).ok(),
    ).toBeTruthy();
    exec(`DELETE FROM notifications WHERE user_id IN (${literal(tenant!.qa.userId)}, ${literal(tenant!.owner.userId)});`);

    const setStatus = (api: APIRequestContext, executionId: string, status: string) =>
      api.patch(`/api/cycles/${run.cycleId}/executions/${executionId}`, { data: { status } });

    expect((await setStatus(asManager, run.executionIds[0], "Passed")).ok()).toBeTruthy();
    expect(await titles(asQa)).toEqual([`${run.tcIds[0]} status changed to Passed in test run ${run.cycleName}.`]);
    expect((await inbox(asQa))[0]).toMatchObject({ type: "test_case_status_changed", link_entity_type: "test_run", link_entity_id: `${tenant!.mainProjectId}:${run.cycleId}` });
    expect(await titles(asManager)).toEqual([]); // the actor
    expect(await titles(asOwner)).toEqual([]); // the run owner is told about Failed / Blocked, not every change

    // Saving the same status again is not a change.
    expect((await setStatus(asManager, run.executionIds[0], "Passed")).ok()).toBeTruthy();
    expect(await titles(asQa)).toHaveLength(1);

    // The assignee changing their own case's status is their own action.
    expect((await setStatus(asQa, run.executionIds[0], "Skipped")).ok()).toBeTruthy();
    expect(await titles(asQa)).toHaveLength(1);

    // A case nobody is assigned to has nobody to tell.
    expect((await setStatus(asManager, run.executionIds[1], "Passed")).ok()).toBeTruthy();
    expect(await titles(asQa)).toHaveLength(1);

    // Failed still reaches the assignee through its own matrix message — once, not twice.
    expect((await setStatus(asManager, run.executionIds[0], "Failed")).ok()).toBeTruthy();
    const qa = await titles(asQa);
    expect(qa).toHaveLength(2);
    expect(qa[0]).toBe(`${run.tcIds[0]} failed in test run ${run.cycleName}.`);
  });

  test("NOTIF-P1-14 a bulk status change is one summary per assignee, not one notification per case", async () => {
    const run = await seedRun(3);
    const assign = (executionIds: string[], assigneeId: string) =>
      asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-assign`, { data: { executionIds, assigneeId } });
    expect((await assign([run.executionIds[0], run.executionIds[1]], tenant!.qa.userId)).ok()).toBeTruthy();
    expect((await assign([run.executionIds[2]], tenant!.manager.userId)).ok()).toBeTruthy();
    exec(`DELETE FROM notifications WHERE user_id IN (${literal(tenant!.qa.userId)}, ${literal(tenant!.manager.userId)});`);

    const res = await asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-status`, { data: { executionIds: run.executionIds, status: "Passed" } });
    expect(res.ok(), await res.text()).toBeTruthy();

    expect(await titles(asQa)).toEqual([`2 of your test cases in test run ${run.cycleName} were marked Passed.`]);
    // One case: the same per-case wording as a single change.
    expect(await titles(asManager)).toEqual([`${run.tcIds[2]} status changed to Passed in test run ${run.cycleName}.`]);
    expect(await titles(asOwner)).toEqual([]); // the actor

    // Nothing changed the second time, so nothing is sent.
    const again = await asOwner.post(`/api/cycles/${run.cycleId}/executions/bulk-status`, { data: { executionIds: run.executionIds, status: "Passed" } });
    expect(again.ok()).toBeTruthy();
    expect(await titles(asQa)).toHaveLength(1);
    expect(await titles(asManager)).toHaveLength(1);
  });

  // ─── Phase 2: Knowledge Base, Zyra, integrations ───────────────────────────

  test("NOTIF-P2-01 editing or deleting a KB document tells its creator and commenters — not the actor — and edits are limited to one an hour", async () => {
    const title = stamp("kb");
    const created = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { title, contentText: "v1", contentHtml: "<p>v1</p>", documentType: "general" },
      failOnStatusCode: false,
    });
    expect(created.ok(), `creating a document — ${await created.text()}`).toBeTruthy();
    const docId = (await created.json()).id;
    const doc = `/api/projects/${tenant!.mainProjectId}/knowledge-base/documents/${docId}`;
    try {
      // qa joins the people with a stake in it by commenting.
      expect((await asQa.post(`${doc}/comments`, { data: { body: "Looks right" } })).ok()).toBeTruthy();
      exec(`DELETE FROM notifications WHERE user_id IN (${literal(tenant!.owner.userId)}, ${literal(tenant!.qa.userId)});`);

      const edit = (text: string) => asManager.patch(doc, { data: { contentText: text, contentHtml: `<p>${text}</p>` } });
      expect((await edit("v2")).ok()).toBeTruthy();
      expect(await titles(asOwner)).toEqual([`${title} has been updated.`]); // the creator
      expect(await titles(asQa)).toEqual([`${title} has been updated.`]); // a commenter
      expect(await titles(asManager)).toEqual([]); // the editor
      expect((await inbox(asOwner))[0]).toMatchObject({ type: "kb_document_updated", link_entity_type: "knowledge_document", link_entity_id: `${tenant!.mainProjectId}:${docId}` });

      // Another edit in the same hour does not add to the bell.
      expect((await edit("v3")).ok()).toBeTruthy();
      expect(await titles(asOwner)).toHaveLength(1);
      // Saving without changing anything is no edit at all.
      expect((await edit("v3")).ok()).toBeTruthy();
      expect(await titles(asQa)).toHaveLength(1);

      const removed = await asManager.delete(doc, { failOnStatusCode: false });
      expect(removed.ok(), await removed.text()).toBeTruthy();
      expect((await titles(asOwner))[0]).toBe(`${title} has been deleted from the Knowledge Base.`);
      expect((await inbox(asOwner))[0]).toMatchObject({ type: "kb_document_deleted", link_entity_type: "knowledge_base", link_entity_id: tenant!.mainProjectId });
      expect((await titles(asQa))[0]).toBe(`${title} has been deleted from the Knowledge Base.`);
    } finally {
      await asOwner.delete(doc, { failOnStatusCode: false });
    }
  });

  test("NOTIF-P2-02 closing a Zyra review tells whoever requested the generation — unless they closed it themselves", async () => {
    const seedTask = (): string => {
      const id = crypto.randomUUID();
      exec(
        "INSERT INTO ai_generation_requests (id, project_id, requested_by, provider, user_story, requested_count, generated_count, " +
          `generated_payload, agent_name, task_status) VALUES (${literal(id)}, ${literal(tenant!.mainProjectId)}, ${literal(tenant!.qa.userId)}, ` +
          "'openai', 'E2E Notif zyra story', 1, 1, '[]'::jsonb, 'Zyra the Test Generator', 'in_review');",
      );
      return id;
    };
    const ids = [seedTask(), seedTask()];
    try {
      const close = (api: APIRequestContext, id: string) =>
        api.post(`/api/projects/${tenant!.mainProjectId}/agents/zyra/tasks/${id}/close`, { data: {}, failOnStatusCode: false });

      expect((await close(asManager, ids[0])).ok()).toBeTruthy();
      const [row] = await inbox(asQa);
      expect(row.title).toBe("Review completed for Zyra-generated test cases.");
      expect(row).toMatchObject({ type: "zyra_review_completed", link_entity_type: "zyra_task", link_entity_id: `${tenant!.mainProjectId}:${ids[0]}` });
      expect(await titles(asManager)).toEqual([]);

      // Closing it again is a no-op, not a second notification.
      expect((await close(asManager, ids[0])).ok()).toBeTruthy();
      expect(await titles(asQa)).toHaveLength(1);

      // The requester closing their own review is their own action.
      expect((await close(asQa, ids[1])).ok()).toBeTruthy();
      expect(await titles(asQa)).toHaveLength(1);
    } finally {
      exec(`DELETE FROM ai_generation_requests WHERE id IN (${ids.map(literal).join(", ")});`);
    }
  });

  test("NOTIF-P2-03 disconnecting an integration tells the other workspace owners, not the owner who did it", async () => {
    // A second owner: promotion to owner is refused through the API, so it is written directly.
    setOrgRole(tenant!.organizationId, tenant!.manager.userId, "owner");
    exec(
      "INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at, connected_by) VALUES (" +
        `${literal(tenant!.organizationId)}, 'jira', 'e2e-jira-site', 'https://e2e.invalid', 'e2e-not-a-real-token', '', now() + interval '1 hour', ${literal(tenant!.owner.userId)}) ` +
        "ON CONFLICT (organization_id, provider) DO UPDATE SET disconnected_at = NULL;",
    );
    try {
      const res = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
      expect(res.ok(), await res.text()).toBeTruthy();
      const [row] = await inbox(asManager);
      expect(row.title).toBe("Jira has been disconnected.");
      expect(row).toMatchObject({ type: "integration_disconnected", link_entity_type: "integrations_settings", link_entity_id: tenant!.organizationId });
      expect(await titles(asOwner)).toEqual([]);
      expect(await titles(asQa)).toEqual([]); // not an owner
    } finally {
      exec(`DELETE FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)} AND provider = 'jira';`);
    }
  });

  test("NOTIF-P2-04 linking an issue to a test case tells its creator, not the person who linked it, and not twice", async () => {
    const tc = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/testcases`, { data: { title: stamp("link case") } });
    expect(tc.status(), await tc.text()).toBe(201);
    const tcId = (await tc.json()).id;
    const put = (api: APIRequestContext, jiraIssueKey: string) =>
      api.put(`/api/projects/${tenant!.mainProjectId}/testcases/${tcId}`, { data: { jiraIssueKey }, failOnStatusCode: false });

    expect((await put(asManager, "E2E-123")).ok()).toBeTruthy();
    const [row] = await inbox(asOwner);
    expect(row.title).toBe("E2E-123 has been linked successfully.");
    expect(row).toMatchObject({ type: "integration_issue_linked", link_entity_type: "testcase", link_entity_id: `${tenant!.mainProjectId}:${tcId}` });
    expect(await titles(asManager)).toEqual([]);

    // The same key again is not a new link.
    expect((await put(asManager, "E2E-123")).ok()).toBeTruthy();
    expect(await titles(asOwner)).toHaveLength(1);
    // The creator linking their own case's issue is their own action.
    expect((await put(asOwner, "E2E-456")).ok()).toBeTruthy();
    expect(await titles(asOwner)).toHaveLength(1);
  });

  // ─── Isolation ─────────────────────────────────────────────────────────────

  test("NOTIF-P1-12 notifications never cross tenants or reach a workspace member outside the project", async ({ request }) => {
    const bug = await newBug({ assigneeId: tenant!.qa.userId });
    expect(await titles(asGuest)).toEqual([]);
    // Account A (the shared smoke tenant) is in a different workspace entirely.
    const smoke = await (await request.get("/api/notifications")).json();
    expect(smoke.some((n: Row) => n.link_entity_id === `${tenant!.mainProjectId}:${bug.id}`)).toBe(false);

    // Someone outside the project cannot be made an assignee in the first place (the recipient
    // filter is a second line of defence, not the only one).
    const refused = await asOwner.patch(`/api/bugs/${bug.id}`, { data: { assigneeId: tenant!.guest.userId }, failOnStatusCode: false });
    expect(refused.status()).toBe(400);
    expect(await titles(asGuest)).toEqual([]);
  });
});
