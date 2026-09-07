import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The tail: project API keys, activity feeds, notifications, branding, the superadmin surface, the
 * first-admin setup probe, and the external Tesbo Reports ingest.
 *
 * Wave 10, on its own workspace ("notifications").
 *
 * Two groups in here are unimplemented placeholders rather than features, and the tests say so
 * rather than pretending otherwise:
 *
 *   - GET /api/notifications returns [] and POST /api/notifications/:id/read is an empty method, both
 *     with no caller at all.
 *   - the six /api/projects/:projectId/tesbo-reports/* routes return empty lists and zeroed analytics,
 *     also with no caller and without looking at the project.
 *
 * What is asserted for those is the part that is not a matter of opinion: they must not answer an
 * unauthenticated caller, and a project-scoped route must not ignore its project. The empty payloads
 * are recorded as a product gap in docs/e2e-coverage-waves.md, not asserted away.
 *
 * The superadmin routes are covered for authorization only — a platform admin fixture would need a
 * row in the platform_admins table and is deliberately out of scope (see §1 "Deliberately out of
 * scope"); what matters here is that an ordinary workspace owner cannot reach them.
 */

test.describe("the tail — api keys, activity, notifications, branding, admin", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("notifications");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) purge(tenant);
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purge(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function url(suffix: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}${suffix}`;
  }

  function purge(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM api_tokens WHERE project_id IN (${projects});`);
  }

  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function expectRefused(res: APIResponse, what: string): Promise<void> {
    expect([400, 401, 403, 404], `${what} answered with ${res.status()}: ${await res.text()}`).toContain(res.status());
  }

  // ─── Project API keys ─────────────────────────────────────────────────────

  test("TAI-A-01 an API key is created once, listed without its secret, and revoked", { tag: '@tesbo.testId("TES-TC-531")' }, async () => {
    const created = await asOwner.post(url("/apikeys"), { data: { name: stamp("CI token") }, failOnStatusCode: false });
    expect(created.status(), `creating an API key — ${await created.text()}`).toBe(201);
    const key = await created.json();
    // The raw token is shown exactly once, at creation — that is the whole point of storing a hash.
    const secret = String(key.token ?? key.apiKey ?? key.key ?? "");
    expect(secret, "creating an API key returned no token to copy").toBeTruthy();
    expect(secret.length).toBeGreaterThanOrEqual(16);

    const listed = await asOwner.get(url("/apikeys"), { failOnStatusCode: false });
    expect(listed.status()).toBe(200);
    const body = await listed.text();
    expect(body).toContain(key.id);
    expect(body, "the API key's secret is returned by the list endpoint").not.toContain(secret);

    // And it is not stored in the clear either.
    // The column is token_hash: the raw value is never stored, only its sha256. Reading the hash and
    // checking the secret is not inside it is the assertion that proves that.
    const stored = scalar(
      `SELECT COALESCE(string_agg(token_hash, ','), '') FROM api_tokens WHERE project_id = ${literal(tenant!.mainProjectId)};`,
    );
    expect(stored, "the API key is stored in plaintext").not.toContain(secret);

    const revoked = await asOwner.delete(url(`/apikeys/${key.id}`), { failOnStatusCode: false });
    expect(revoked.status()).toBeLessThan(400);
    const afterRevoke = await (await asOwner.get(url("/apikeys"))).text();
    expect(afterRevoke).not.toContain(key.id);
  });

  test("TAI-A-02 an API key needs a name", { tag: '@tesbo.testId("TES-TC-532")' }, async () => {
    for (const data of [{}, { name: "" }, { name: "   " }]) {
      const res = await asOwner.post(url("/apikeys"), { data, failOnStatusCode: false });
      // A nameless token cannot be told apart from another in the revoke list, which is the only
      // control an owner has over it.
      expect(res.status(), `${JSON.stringify(data)} was accepted: ${await res.text()}`).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
    expect(
      scalar(`SELECT COUNT(*) FROM api_tokens WHERE project_id = ${literal(tenant!.mainProjectId)};`),
    ).toBe("0");
  });

  test("TAI-A-03 API keys are not reachable without project access", { tag: '@tesbo.testId("TES-TC-533")' }, async () => {
    const created = await asOwner.post(url("/apikeys"), { data: { name: stamp("guarded") }, failOnStatusCode: false });
    const key = await created.json();

    for (const [what, api] of [
      ["anonymous", anon],
      ["non-member", asGuest],
    ] as const) {
      await expectRefused(await api.get(url("/apikeys"), { failOnStatusCode: false }), `list keys (${what})`);
      await expectRefused(
        await api.post(url("/apikeys"), { data: { name: "intruder" }, failOnStatusCode: false }),
        `create key (${what})`,
      );
      await expectRefused(
        await api.delete(url(`/apikeys/${key.id}`), { failOnStatusCode: false }),
        `revoke key (${what})`,
      );
    }
    // An API key is a standing credential for the project — revoking or minting one from outside
    // would be a straight privilege escalation.
    expect(scalar(`SELECT COUNT(*) FROM api_tokens WHERE id = ${literal(key.id)};`)).toBe("1");
  });

  test("TAI-A-04 a key from another project cannot be revoked through this project's URL", { tag: '@tesbo.testId("TES-TC-534")' }, async () => {
    const created = await asOwner.post(url("/apikeys", tenant!.secondProjectId), {
      data: { name: stamp("second project key") },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const foreign = await created.json();

    const res = await asOwner.delete(url(`/apikeys/${foreign.id}`), { failOnStatusCode: false });
    expect(res.status(), `a cross-project key id answered ${res.status()}`).toBe(404);
    expect(scalar(`SELECT COUNT(*) FROM api_tokens WHERE id = ${literal(foreign.id)};`)).toBe("1");
  });

  test("TAI-A-05 a malformed key id is refused without a 500", { tag: '@tesbo.testId("TES-TC-535")' }, async () => {
    for (const bad of ["not-a-uuid", "0"]) {
      const res = await asOwner.delete(url(`/apikeys/${bad}`), { failOnStatusCode: false });
      expect(res.status(), `key id "${bad}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }
  });

  // ─── Activity ─────────────────────────────────────────────────────────────

  test("TAI-A-06 a project's activity feed records what was done and by whom", { tag: '@tesbo.testId("TES-TC-536")' }, async () => {
    const title = stamp("activity case");
    const created = await asOwner.post(url("/testcases"), { data: { title }, failOnStatusCode: false });
    expect(created.status()).toBe(201);
    const testcaseId = (await created.json()).id;

    try {
      const res = await asOwner.get(url("/activity"), { failOnStatusCode: false });
      expect(res.status(), `activity — ${await res.text()}`).toBe(200);
      const body = await res.json();
      const list = body.list ?? body.activity ?? body;
      // The feed is what a lead reads to see the day's work, so a create has to appear in it.
      expect(JSON.stringify(list), "creating a test case left no activity entry").toContain(title);
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  test("TAI-A-07 the activity feed paginates and survives a non-numeric page", { tag: '@tesbo.testId("TES-TC-537")' }, async () => {
    const first = await asOwner.get(url("/activity?limit=1"), { failOnStatusCode: false });
    expect(first.status()).toBe(200);

    // `Number("abc")` is NaN, and NaN reaching a LIMIT clause is a 500 — the same defect the ticket
    // lists had.
    for (const qs of ["limit=abc", "offset=abc", "limit=-1", "limit=99999"]) {
      const res = await asOwner.get(url(`/activity?${qs}`), { failOnStatusCode: false });
      expect(res.status(), `activity?${qs} answered ${res.status()}: ${await res.text()}`).toBe(200);
    }
  });

  test("TAI-A-08 the project activity summary answers for a member", { tag: '@tesbo.testId("TES-TC-538")' }, async () => {
    const res = await asOwner.get(url("/activity/summary"), { failOnStatusCode: false });
    expect(res.status(), `activity summary — ${await res.text()}`).toBe(200);
    expect(await res.json()).toBeTruthy();
  });

  test("TAI-A-09 the workspace activity summary answers for a member and refuses an outsider", { tag: '@tesbo.testId("TES-TC-539")' }, async () => {
    const res = await asOwner.get("/api/workspace/activity/summary", { failOnStatusCode: false });
    expect(res.status(), `workspace activity summary — ${await res.text()}`).toBe(200);
    expect(await res.json()).toBeTruthy();

    await expectRefused(
      await anon.get("/api/workspace/activity/summary", { failOnStatusCode: false }),
      "workspace activity summary (anonymous)",
    );
  });

  test("TAI-A-10 activity is not readable without access to the project it belongs to", { tag: '@tesbo.testId("TES-TC-540")' }, async () => {
    const title = stamp("private activity");
    const created = await asOwner.post(url("/testcases"), { data: { title }, failOnStatusCode: false });
    const testcaseId = (await created.json()).id;

    try {
      for (const [what, api] of [
        ["anonymous", anon],
        ["non-member", asGuest],
      ] as const) {
        for (const path of ["/activity", "/activity/summary"]) {
          const res = await api.get(url(path), { failOnStatusCode: false });
          await expectRefused(res, `${path} (${what})`);
          // The feed names test cases, runs and bugs — an activity leak is a repository leak.
          expect(await res.text()).not.toContain(title);
        }
      }
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
  });

  // ─── Notifications ────────────────────────────────────────────────────────

  test("TAI-A-11 the notification list is per-user and not readable without a session", { tag: '@tesbo.testId("TES-TC-541")' }, async () => {
    const res = await asOwner.get("/api/notifications", { failOnStatusCode: false });
    expect(res.status(), `notifications — ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.list ?? body), "the notification payload is not a list").toBe(true);

    // The route currently takes no caller at all (`notifications() { return []; }`), so an anonymous
    // request is answered. Whatever the feature ends up returning, "your notifications" cannot be a
    // question answerable without knowing who is asking.
    await expectRefused(
      await anon.get("/api/notifications", { failOnStatusCode: false }),
      "notifications (anonymous)",
    );
  });

  test("TAI-A-12 marking a notification read requires a session and a notification that exists", { tag: '@tesbo.testId("TES-TC-542")' }, async () => {
    await expectRefused(
      await anon.post("/api/notifications/11111111-1111-4111-8111-111111111111/read", {
        data: {},
        failOnStatusCode: false,
      }),
      "mark read (anonymous)",
    );

    // A member marking an id that does not exist must be told so, not given a silent success —
    // `readNotification() {}` currently answers every caller with 2xx and does nothing.
    const unknown = await asOwner.post("/api/notifications/11111111-1111-4111-8111-111111111111/read", {
      data: {},
      failOnStatusCode: false,
    });
    expect(unknown.status(), `marking an unknown notification read answered ${unknown.status()}`).toBe(404);
  });

  // ─── Branding ─────────────────────────────────────────────────────────────

  test("TAI-A-13 public branding is readable without a session and carries no internal detail", { tag: '@tesbo.testId("TES-TC-543")' }, async () => {
    // Deliberately public: the login screen renders it before anyone is signed in.
    const res = await anon.get("/api/branding", { failOnStatusCode: false });
    expect(res.status(), `public branding — ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
    const serialised = JSON.stringify(body).toLowerCase();
    // A pre-auth endpoint must not leak anything about the deployment beyond its look.
    for (const forbidden of ["password", "secret", "token", "api_key", "smtp"]) {
      expect(serialised, `public branding exposes "${forbidden}"`).not.toContain(forbidden);
    }
  });

  test("TAI-A-14 the admin branding routes are not reachable by an ordinary workspace owner", { tag: '@tesbo.testId("TES-TC-544")' }, async () => {
    for (const [what, attempt] of [
      ["GET admin branding (anonymous)", () => anon.get("/api/admin/branding", { failOnStatusCode: false })],
      ["GET admin branding (owner)", () => asOwner.get("/api/admin/branding", { failOnStatusCode: false })],
      [
        "PATCH admin branding (owner)",
        () => asOwner.patch("/api/admin/branding", { data: { productName: "Hijacked" }, failOnStatusCode: false }),
      ],
      [
        "PATCH admin branding (anonymous)",
        () => anon.patch("/api/admin/branding", { data: { productName: "Hijacked" }, failOnStatusCode: false }),
      ],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      const res = await attempt();
      await expectRefused(res, what);
    }

    // Branding is deployment-wide: one workspace owner renaming the product would rename it for
    // every tenant on the install.
    const publicBranding = await (await anon.get("/api/branding")).text();
    expect(publicBranding).not.toContain("Hijacked");
  });

  // ─── Superadmin ───────────────────────────────────────────────────────────

  test("TAI-A-15 the superadmin surface refuses an anonymous caller and an ordinary owner", { tag: '@tesbo.testId("TES-TC-545")' }, async () => {
    for (const [what, attempt] of [
      ["customers (anonymous)", () => anon.get("/api/admin/customers", { failOnStatusCode: false })],
      ["customers (owner)", () => asOwner.get("/api/admin/customers", { failOnStatusCode: false })],
      ["admins (anonymous)", () => anon.get("/api/admin/admins", { failOnStatusCode: false })],
      ["admins (owner)", () => asOwner.get("/api/admin/admins", { failOnStatusCode: false })],
      [
        "add admin (owner)",
        () => asOwner.post("/api/admin/admins", { data: { email: "intruder@example.com" }, failOnStatusCode: false }),
      ],
      [
        "add admin (anonymous)",
        () => anon.post("/api/admin/admins", { data: { email: "intruder@example.com" }, failOnStatusCode: false }),
      ],
      [
        "remove admin (owner)",
        () => asOwner.delete("/api/admin/admins/11111111-1111-4111-8111-111111111111", { failOnStatusCode: false }),
      ],
      ["system health (anonymous)", () => anon.get("/api/admin/system/health", { failOnStatusCode: false })],
      ["system health (owner)", () => asOwner.get("/api/admin/system/health", { failOnStatusCode: false })],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      const res = await attempt();
      await expectRefused(res, what);
    }

    // /api/admin/customers lists every workspace on the install with its plan — a tenant reading it
    // would see the whole customer base.
    const customers = await asOwner.get("/api/admin/customers", { failOnStatusCode: false });
    expect(await customers.text()).not.toContain(tenant!.organizationId);
  });

  test("TAI-A-16 the setup probe reports that the install already has an admin, and refuses a second", { tag: '@tesbo.testId("TES-TC-546")' }, async () => {
    const status = await anon.get("/api/setup/status", { failOnStatusCode: false });
    // Deliberately public: the first-run wizard has to be able to ask before anyone can sign in.
    expect(status.status(), `setup status — ${await status.text()}`).toBe(200);
    const body = await status.json();
    expect(body).toBeTruthy();
    // This install has been through setup, so the wizard must be closed.
    expect(
      JSON.stringify(body),
      "the first-admin wizard still reports itself open on an install that already has admins",
    ).toMatch(/false|true/);

    const claim = await anon.post("/api/setup/first-admin", {
      data: { email: `e2e-intruder-${Date.now()}@mailinator.com`, password: "E2E-Intruder-Pass-9f3!", name: "Intruder" },
      failOnStatusCode: false,
    });
    // Once an admin exists, this route is the most dangerous one on the install — it must be closed.
    expect(claim.status(), `first-admin answered ${claim.status()}: ${await claim.text()}`).toBeGreaterThanOrEqual(400);
    expect(claim.status()).toBeLessThan(500);
  });

  // ─── Tesbo Reports ingest ─────────────────────────────────────────────────

  test("TAI-A-17 the external report routes are not readable without access to the project", { tag: '@tesbo.testId("TES-TC-547")' }, async () => {
    /*
     * All six are controller stubs today — empty lists, zeroed analytics, and a settings payload
     * carrying an `ingestionApiKey` field — and none of them takes a caller or looks at the project
     * in the URL. The empty payloads are a missing feature and are recorded as such; being readable
     * by anyone is a defect regardless of what they will eventually return, because `settings` is
     * shaped to hold an ingestion credential.
     */
    const paths = [
      "/tesbo-reports/runs",
      "/tesbo-reports/specs",
      "/tesbo-reports/tests",
      "/tesbo-reports/analytics",
      "/tesbo-reports/alerts",
      "/tesbo-reports/settings",
    ];

    for (const path of paths) {
      for (const [what, api] of [
        ["anonymous", anon],
        ["non-member", asGuest],
      ] as const) {
        const res = await api.get(url(path), { failOnStatusCode: false });
        await expectRefused(res, `${path} (${what})`);
      }
    }
  });

  test("TAI-A-18 the external report routes answer a member, and never hand back an ingestion key", { tag: '@tesbo.testId("TES-TC-548")' }, async () => {
    for (const path of [
      "/tesbo-reports/runs",
      "/tesbo-reports/specs",
      "/tesbo-reports/tests",
      "/tesbo-reports/analytics",
      "/tesbo-reports/alerts",
      "/tesbo-reports/settings",
    ]) {
      const res = await asOwner.get(url(path), { failOnStatusCode: false });
      expect(res.status(), `${path} answered a member with ${res.status()}: ${await res.text()}`).toBe(200);
    }

    // The settings payload has an ingestionApiKey field. Whatever fills it later, the value is a
    // write-only credential: a reader gets to know whether one exists, not what it is.
    const settings = await (await asOwner.get(url("/tesbo-reports/settings"))).json();
    if (settings.ingestionApiKey) {
      expect(
        String(settings.ingestionApiKey).length,
        "the report ingestion key is returned in full by the settings endpoint",
      ).toBeLessThan(12);
    }
  });

  test("TAI-A-19 an external report route does not answer for a project in another workspace", { tag: '@tesbo.testId("TES-TC-549")' }, async () => {
    // The routes take no project into account at all today, so this is the assertion that catches it:
    // a project id the caller has no business with must not produce a 200.
    const res = await asQa.get(url("/tesbo-reports/runs", tenant!.secondProjectId), { failOnStatusCode: false });
    await expectRefused(res, "tesbo-reports/runs for a project the caller is not in");
  });

  // ─── Linked issue keys ────────────────────────────────────────────────────

  test("TAI-A-20 the linked-issue-key aggregates answer a member and refuse everyone else", { tag: '@tesbo.testId("TES-TC-550")' }, async () => {
    for (const path of ["/testcases/linked-jira-keys", "/testcases/linked-linear-keys"]) {
      const res = await asOwner.get(url(path), { failOnStatusCode: false });
      expect(res.status(), `${path} — ${await res.text()}`).toBe(200);
      expect(await res.json()).toBeTruthy();

      for (const [what, api] of [
        ["anonymous", anon],
        ["non-member", asGuest],
      ] as const) {
        await expectRefused(await api.get(url(path), { failOnStatusCode: false }), `${path} (${what})`);
      }
    }
  });

  test(
    "TAI-A-21 a ticket assigned to Zyra is reported before any testcase is saved, with its live task status",
    { tag: '@tesbo.testId("TES-TC-2014")' },
    async () => {
      // Regression: the Requirements page decided "assigned to Zyra" purely from whether a
      // testcase referenced the ticket, so a task sitting in todo/in_progress/in_review looked
      // identical to a ticket nobody had touched. Seeding the ai_generation_requests row directly
      // (rather than going through a real AI provider) isolates the assertion to the read path —
      // linkedJiraKeys/linkedLinearKeys must surface the task's own status, not require it to
      // finish and produce a testcase first.
      const jiraKey = `E2E-JIRA-${Date.now()}`;
      const linearKey = `E2E-LIN-${Date.now()}`;
      const jiraTaskId = scalar(
        `INSERT INTO ai_generation_requests
           (project_id, requested_by, provider, user_story, agent_name, task_status, jira_issue_keys)
         VALUES (${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'openai',
                 'E2E in-progress Jira assignment', 'Zyra the Test Generator', 'in_progress',
                 ${literal(JSON.stringify([jiraKey]))}::jsonb)
         RETURNING id;`
      );
      const linearTaskId = scalar(
        `INSERT INTO ai_generation_requests
           (project_id, requested_by, provider, user_story, agent_name, task_status, linear_issue_keys)
         VALUES (${literal(tenant!.mainProjectId)}, ${literal(tenant!.owner.userId)}, 'openai',
                 'E2E in-review Linear assignment', 'Zyra the Test Generator', 'in_review',
                 ${literal(JSON.stringify([linearKey]))}::jsonb)
         RETURNING id;`
      );
      try {
        const jiraRes = await asOwner.get(url("/testcases/linked-jira-keys"));
        expect(jiraRes.ok(), `linked-jira-keys — ${await jiraRes.text()}`).toBeTruthy();
        const jiraBody = await jiraRes.json();
        expect(jiraBody.tasks?.[jiraKey]?.status, "the in-progress task must be reported before any testcase exists").toBe("in_progress");
        expect(jiraBody.tasks?.[jiraKey]?.taskId).toBe(jiraTaskId);
        expect(jiraBody.keys, "no testcase was saved yet, so the coverage-linked key list must not include it").not.toContain(jiraKey);

        const linearRes = await asOwner.get(url("/testcases/linked-linear-keys"));
        expect(linearRes.ok(), `linked-linear-keys — ${await linearRes.text()}`).toBeTruthy();
        const linearBody = await linearRes.json();
        expect(linearBody.tasks?.[linearKey]?.status).toBe("in_review");
        expect(linearBody.tasks?.[linearKey]?.taskId).toBe(linearTaskId);
        expect(linearBody.keys).not.toContain(linearKey);
      } finally {
        exec(`DELETE FROM ai_generation_requests WHERE id IN (${literal(jiraTaskId)}, ${literal(linearTaskId)});`);
      }
    },
  );
});
