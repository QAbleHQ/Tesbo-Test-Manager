import fs from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { resetToLaunch, setGraceWindow, setProPlan } from "../utils/billing-db";
import { env } from "../utils/env";
import {
  NYRA_FAKE_SKIP_REASON,
  nyraFakeIsWired,
  startFakeNyraServer,
  type FakeNyraServer,
} from "../utils/fake-nyra-server";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The NYRA agent: /api/projects/:projectId/agents/nyra[/projects].
 *
 * Two halves, because one NYRA_API_KEY is bound to one NYRA workspace and the backend reads
 * NYRA_BASE_URL once at boot:
 *   - "refusals and validation" never reaches NYRA, so it runs on any stack: the Pro gate, roles,
 *     tenancy, and every 400 the form can produce (validated before NYRA is called).
 *   - "against the fake NYRA" creates and lists projects, so it runs only when the stack was booted
 *     with NYRA_BASE_URL pointing at utils/fake-nyra-server.ts. Never at a real NYRA.
 *
 * Own workspace ("nyra"), put on Pro by provisionRbacTenant; the plan tests flip it and restore it.
 */

const ctxB = () => path.join(__dirname, "../.auth/state-b.json");
const REFUSED = [400, 401, 403, 404];

test.describe("NYRA agent", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let asOtherTenant: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("nyra");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    asOtherTenant = await request.newContext({ baseURL: env.apiBaseUrl, storageState: ctxB() });
    purge(tenant);
  });

  test.afterAll(async () => {
    if (tenant) {
      purge(tenant);
      setProPlan(tenant.organizationId);
    }
    await Promise.all([asOwner, asManager, asQa, asGuest, asOtherTenant, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  function purge(t: RbacTenant): void {
    exec(`DELETE FROM nyra_projects WHERE project_id IN (${literal(t.mainProjectId)}, ${literal(t.secondProjectId)});`);
  }

  const base = (projectId?: string) => `/api/projects/${projectId ?? tenant!.mainProjectId}/agents/nyra`;
  const name = (label: string) => `E2E NYRA ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const valid = (label = "Shop") => ({ name: name(label), appUrl: "https://staging.example.com" });
  const create = (api: APIRequestContext, body: unknown, projectId?: string) =>
    api.post(`${base(projectId)}/projects`, { data: body as object, failOnStatusCode: false });

  // ─── Refusals and validation: never reaches NYRA ───────────────────────────

  test.describe("refusals and validation", () => {
    test("card state is readable by every project role and says whether NYRA is configured", async () => {
      for (const api of [asOwner, asManager, asQa]) {
        const res = await api.get(base());
        expect(res.status()).toBe(200);
        expect(typeof (await res.json()).configured).toBe("boolean");
      }
    });

    test("a non-member, an anonymous caller and another workspace are all refused", async () => {
      for (const [label, api] of [
        ["guest", asGuest],
        ["anonymous", anon],
        ["other workspace", asOtherTenant],
      ] as const) {
        const calls = [
          api.get(base(), { failOnStatusCode: false }),
          api.get(`${base()}/projects`, { failOnStatusCode: false }),
          create(api, valid()),
        ];
        for (const res of await Promise.all(calls)) {
          expect(REFUSED, `${label}: ${res.url()}`).toContain(res.status());
        }
      }
      // The other workspace gets "not found", the same answer as a project that does not exist.
      expect((await asOtherTenant.get(`${base()}/projects`, { failOnStatusCode: false })).status()).toBe(404);
    });

    test("a malformed project id is a 404, not a 500", async () => {
      const res = await asOwner.get("/api/projects/not-a-uuid/agents/nyra", { failOnStatusCode: false });
      expect(res.status()).toBe(404);
    });

    test("a QA engineer can view but not create", async () => {
      const res = await create(asQa, valid());
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("owners and managers");
      // Listing is allowed (it is not the owner/manager-only half), so it is never a 403.
      expect((await asQa.get(`${base()}/projects`, { failOnStatusCode: false })).status()).not.toBe(403);
    });

    test("a manager is allowed through to validation", async () => {
      const res = await create(asManager, { ...valid(), appUrl: "ftp://nope" });
      expect(res.status()).toBe(400);
    });

    test.describe("field validation", () => {
      const ok = () => valid("Validation");
      const cases: Array<[string, () => Record<string, unknown>, string]> = [
        ["missing name", () => ({ appUrl: ok().appUrl }), "Project name is required"],
        ["whitespace-only name", () => ({ ...ok(), name: "   " }), "Project name is required"],
        ["non-string name", () => ({ ...ok(), name: 42 }), "Project name is required"],
        ["name over 120 characters", () => ({ ...ok(), name: "x".repeat(121) }), "at most 120"],
        ["missing app URL", () => ({ name: ok().name }), "App URL is required"],
        ["app URL that is not a URL", () => ({ ...ok(), appUrl: "not a url" }), "valid URL"],
        ["app URL with a non-http scheme", () => ({ ...ok(), appUrl: "ftp://example.com" }), "http://"],
        ["javascript: app URL", () => ({ ...ok(), appUrl: "javascript:alert(1)" }), "http://"],
        ["app URL over the length cap", () => ({ ...ok(), appUrl: `https://example.com/${"a".repeat(2000)}` }), "at most 2000"],
        ["username without a password", () => ({ ...ok(), testAccount: { username: "qa@example.com" } }), "Password is required"],
        ["password without a username", () => ({ ...ok(), testAccount: { password: "pw" } }), "Username or email is required"],
        ["login URL alone", () => ({ ...ok(), testAccount: { loginUrl: "https://example.com/login" } }), "Username or email is required"],
        [
          "an OTP login method",
          () => ({ ...ok(), testAccount: { username: "qa@example.com", password: "pw", loginMethod: "otp" } }),
          "Only password login",
        ],
        [
          "an over-long username",
          () => ({ ...ok(), testAccount: { username: "u".repeat(256), password: "pw", loginMethod: "password" } }),
          "at most 255",
        ],
        [
          "a bad login page URL",
          () => ({ ...ok(), testAccount: { loginUrl: "ftp://x", username: "qa@example.com", password: "pw" } }),
          "Login page URL",
        ],
      ];
      for (const [label, body, message] of cases) {
        test(`rejects ${label}`, async () => {
          const res = await create(asOwner, body());
          expect(res.status()).toBe(400);
          expect((await res.json()).error).toContain(message);
        });
      }

      test("a non-object body is a 400", async () => {
        const res = await asOwner.post(`${base()}/projects`, { data: "just text", headers: { "content-type": "application/json" }, failOnStatusCode: false });
        expect(REFUSED).toContain(res.status());
      });
    });

    test("without NYRA configured, a valid create and a list answer 503", async () => {
      const state = await (await asOwner.get(base())).json();
      test.skip(state.configured, "NYRA is configured on this stack, so the not-configured answer cannot be observed.");
      expect((await create(asOwner, valid())).status()).toBe(503);
      expect((await asOwner.get(`${base()}/projects`)).status()).toBe(503);
    });

    test("on the Launch plan NYRA is Pro-only, but the card state is still readable", async () => {
      resetToLaunch(tenant!.organizationId);
      try {
        for (const res of [await asOwner.get(`${base()}/projects`, { failOnStatusCode: false }), await create(asOwner, valid())]) {
          expect(res.status()).toBe(403);
          expect((await res.json()).error).toContain("Pro");
        }
        expect((await asOwner.get(base())).status()).toBe(200);
      } finally {
        setProPlan(tenant!.organizationId);
      }
      expect((await asOwner.get(`${base()}/projects`, { failOnStatusCode: false })).status()).not.toBe(403);
    });

    test("a downgraded workspace inside its grace window still has NYRA, and loses it when the window closes", async () => {
      try {
        setGraceWindow(tenant!.organizationId, 5);
        expect((await asOwner.get(`${base()}/projects`, { failOnStatusCode: false })).status()).not.toBe(403);
        setGraceWindow(tenant!.organizationId, -1);
        expect((await asOwner.get(`${base()}/projects`, { failOnStatusCode: false })).status()).toBe(403);
      } finally {
        setProPlan(tenant!.organizationId);
      }
    });
  });

  // ─── Against the fake NYRA ─────────────────────────────────────────────────

  test.describe("against the fake NYRA", () => {
    let fake: FakeNyraServer | null = null;

    test.beforeAll(async () => {
      if (nyraFakeIsWired()) fake = await startFakeNyraServer();
    });

    test.afterAll(async () => {
      await fake?.close().catch(() => undefined);
    });

    test.beforeEach(() => {
      test.skip(!nyraFakeIsWired(), NYRA_FAKE_SKIP_REASON);
      fake?.reset();
    });

    test("creates a project with a test account, sends it to NYRA once, and never returns the password", async () => {
      const body = {
        ...valid("Full"),
        testAccount: { loginUrl: "https://staging.example.com/login", username: "qa@example.com", loginMethod: "password", password: "S3cret-pw!" },
      };
      const res = await create(asOwner, body);
      expect(res.status(), await res.text()).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({
        name: body.name,
        appUrl: "https://staging.example.com",
        hasTestAccount: true,
        username: "qa@example.com",
        loginMethod: "password",
      });
      expect(JSON.stringify(created)).not.toContain("S3cret-pw!");

      const sent = fake!.calls.find((c) => c.method === "POST");
      expect(sent!.authorization).toMatch(/^Bearer .{8,}/);
      expect(sent!.body.environment).toMatchObject({
        base_url: "https://staging.example.com",
        test_account: { login_url: "https://staging.example.com/login", username: "qa@example.com", login_method: "password", password: "S3cret-pw!" },
      });

      // Persisted: the link row exists and holds ids only.
      expect(
        scalar(`SELECT count(*) FROM nyra_projects WHERE project_id = ${literal(tenant!.mainProjectId)} AND nyra_project_id = ${literal(created.id)};`),
      ).toBe("1");
      const listed = await (await asOwner.get(`${base()}/projects`)).json();
      expect(listed.list.map((p: any) => p.id)).toContain(created.id);
      expect(JSON.stringify(listed)).not.toContain("S3cret-pw!");
    });

    test("creates a project with no test account and sends no test_account to NYRA", async () => {
      const res = await create(asManager, valid("Plain"));
      expect(res.status()).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({ hasTestAccount: false, username: null });
      expect(fake!.calls.find((c) => c.method === "POST")!.body.environment.test_account).toBeUndefined();
    });

    test("trims the name and accepts exactly 120 characters", async () => {
      const long = "n".repeat(120);
      const res = await create(asOwner, { name: `  ${long}  `, appUrl: "https://staging.example.com" });
      expect(res.status()).toBe(201);
      expect((await res.json()).name).toBe(long);
    });

    test("lists only the projects this Tesbo project created, in a workspace nobody else can read", async () => {
      const mine = await (await create(asOwner, valid("Mine"))).json();
      // A NYRA project that exists upstream but was never created from this Tesbo project.
      fake!.projects.push({ id: "foreign-1", name: "Someone else's", environments: [] });

      const main = await (await asOwner.get(`${base()}/projects`)).json();
      expect(main.list.map((p: any) => p.id)).toEqual([mine.id]);

      const second = await (await asOwner.get(`${base(tenant!.secondProjectId)}/projects`)).json();
      expect(second.list).toEqual([]);

      expect((await asOtherTenant.get(`${base()}/projects`, { failOnStatusCode: false })).status()).toBe(404);
    });

    test("an empty project lists nothing without calling NYRA", async () => {
      const res = await asOwner.get(`${base(tenant!.secondProjectId)}/projects`);
      expect(await res.json()).toEqual({ list: [] });
      expect(fake!.calls).toHaveLength(0);
    });

    test("a duplicate name is a 409 in the same project, ignoring case, but is fine in another project", async () => {
      const first = valid("Dup");
      expect((await create(asOwner, first)).status()).toBe(201);
      const again = await create(asOwner, { ...first, name: first.name.toUpperCase() });
      expect(again.status()).toBe(409);
      expect(fake!.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect((await create(asOwner, first, tenant!.secondProjectId)).status()).toBe(201);
    });

    test("NYRA's validation error becomes a 400 that does not echo the submitted password", async () => {
      const res = await create(asOwner, {
        name: "force-422",
        appUrl: "https://staging.example.com",
        testAccount: { username: "qa@example.com", password: "Echo-me-not-1", loginMethod: "password" },
      });
      expect(res.status()).toBe(400);
      const text = await res.text();
      expect(text).toContain("Fake NYRA says no");
      expect(text).not.toContain("Echo-me-not-1");
      expect(scalar(`SELECT count(*) FROM nyra_projects WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("NYRA rejecting the key is a 502 that does not leak the key, and nothing is linked", async () => {
      const res = await create(asOwner, { name: "force-401", appUrl: "https://staging.example.com" });
      expect(res.status()).toBe(502);
      const text = await res.text();
      expect(text).toContain("NYRA_API_KEY");
      expect(text).not.toMatch(/nyra_sk_|Bearer/);
      expect(scalar(`SELECT count(*) FROM nyra_projects WHERE project_id = ${literal(tenant!.mainProjectId)};`)).toBe("0");
    });

    test("a NYRA server error is a 502", async () => {
      const res = await create(asOwner, { name: "force-500", appUrl: "https://staging.example.com" });
      expect(res.status()).toBe(502);
    });

    test("when NYRA is unreachable the list is a 502, not a hang or an empty list", async () => {
      // Linked projects force the upstream call; with none, the list is empty without one.
      expect((await create(asOwner, valid("Before outage"))).status()).toBe(201);
      await fake!.close();
      fake = null;
      const res = await asOwner.get(`${base()}/projects`, { failOnStatusCode: false });
      expect(res.status()).toBe(502);
      expect((await res.json()).error).toContain("unreachable");
    });
  });
});
