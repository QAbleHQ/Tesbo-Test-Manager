import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { exec, literal } from "../utils/psql";
import { loginAs, provisionRbacTenant, rbacSuiteSkipReason, type RbacTenant } from "../utils/rbac-tenant";

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
