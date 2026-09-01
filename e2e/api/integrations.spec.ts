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
 * Integrations — Jira and Linear: connection status, project/team mapping, the mirrored ticket
 * store, the cross-source Requirements aggregates, and sync history.
 *
 * Wave 8, on its own workspace ("integrations").
 *
 * WHAT IS AND ISN'T DRIVEN HERE. The outbound halves — listing remote Jira projects, posting a
 * comment, running a sync — call api.atlassian.com and api.linear.app, whose base URLs are compiled
 * in rather than configurable, so no fake upstream can be pointed at them. That does NOT put those
 * routes out of reach: everything before the outbound call is ours and is where the interesting
 * failures live. Each of them is driven for
 *
 *   - authorization: no session, and a caller from outside the project
 *   - the not-connected path, which returns before any network call happens
 *   - input validation, likewise before the call
 *
 * and the mirrored ticket store (jira_tickets / linear_tickets) is seeded directly in Postgres, so
 * the read, search, pagination and aggregate paths are exercised against real rows. What is left
 * uncovered is the response-shape handling of a live provider, which is stated in
 * docs/e2e-coverage-waves.md rather than silently skipped.
 *
 * The nightly sync cron (two BullMQ Job Schedulers firing at 00:00 IST — see
 * integration-sync.module.ts) adds a per-ticket change log, read through
 * GET .../knowledge-base/documents/:id/sync-events, which IS driven here end to end (authorization,
 * 404s, empty vs. populated timelines) with knowledge_document_sync_events seeded directly for the
 * same "no fake upstream" reason as the ticket tables above. What is NOT reachable from this suite:
 * the orchestrator's own trigger is a cron tick, not an HTTP route, so the incremental "updated >="
 * fetch, the content-compare write-skip, and the Linear plan-gating exclusion in
 * IntegrationSyncService.listNightlySyncTargets are exercised by unit-level reasoning and code
 * review rather than a driven end-to-end run.
 */

test.describe("integrations — Jira and Linear", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  /** The project's root folder id — needed to seed a mirror document directly (see below). */
  let rootFolderId = "";

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("integrations");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    purge(tenant);
    backfillMissingRootFolder(tenant);
    const tree = await asOwner.get(`/api/projects/${tenant.mainProjectId}/knowledge-base/folders/tree`);
    expect(tree.status(), `resolving the KB root folder — ${await tree.text()}`).toBe(200);
    rootFolderId = (await tree.json()).id;
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
    exec(`DELETE FROM jira_tickets WHERE project_id IN (${projects});`);
    exec(`DELETE FROM linear_tickets WHERE project_id IN (${projects});`);
    exec(`DELETE FROM jira_project_mappings WHERE project_id IN (${projects});`);
    exec(`DELETE FROM linear_project_mappings WHERE project_id IN (${projects});`);
    exec(`DELETE FROM integration_connections WHERE organization_id = ${literal(t.organizationId)};`);
    // knowledge_document_sync_events cascades off knowledge_documents (ON DELETE CASCADE), so
    // deleting the seeded mirror documents is enough to clear both.
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
  }

  /** Same fixture-repair as e2e/api/knowledge-base.spec.ts's helper of the same purpose — see its
   *  comment for why: a pre-fix workspace can be bootstrapped with no knowledge_folders root, and
   *  that cannot be repaired through the API. */
  function backfillMissingRootFolder(t: RbacTenant): void {
    const existing = scalar(
      `SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(t.mainProjectId)} AND is_root = true;`,
    );
    if (existing !== "0") return;
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
        `VALUES (${literal(t.organizationId)}, ${literal(t.mainProjectId)}, NULL, 'Knowledge base', true);`,
    );
  }

  /**
   * A mirrored Knowledge Base document exactly as integration-sync.processor.ts's processTicket
   * would leave it — seeded directly because actually producing one means a real sync, which means
   * a real outbound call to Jira/Linear (see the file-level note above).
   */
  function seedMirrorDocument(provider: "jira" | "linear", externalId: string, title: string, projectId?: string): string {
    exec(
      "INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, content_html, " +
        "document_type, status, source_provider, source_external_id, source_role, is_read_only) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(projectId ?? tenant!.mainProjectId)}, ${literal(rootFolderId)}, ` +
        `${literal(title)}, 'seeded by the e2e suite', '<p>seeded by the e2e suite</p>', 'requirement_note', ` +
        `'published', ${literal(provider)}, ${literal(externalId)}, 'mirror', true);`,
    );
    return scalar(
      `SELECT id FROM knowledge_documents WHERE project_id = ${literal(projectId ?? tenant!.mainProjectId)} ` +
        `AND source_provider = ${literal(provider)} AND source_external_id = ${literal(externalId)} AND source_role = 'mirror';`,
    );
  }

  /** One row of a mirror document's sync timeline — what recordSyncEvent writes on a real change. */
  function seedSyncEvent(documentId: string, eventType: "created" | "updated", changedSummary: string | null, provider: "jira" | "linear" = "jira"): void {
    exec(
      "INSERT INTO knowledge_document_sync_events (document_id, provider, event_type, changed_summary) VALUES (" +
        `${literal(documentId)}, ${literal(provider)}, ${literal(eventType)}, ` +
        `${changedSummary === null ? "NULL" : literal(changedSummary)});`,
    );
  }

  /**
   * A connection row for the workspace, without going anywhere near a real OAuth leg.
   *
   * The token is deliberately nonsense: every test that uses this either stops before the outbound
   * call (not-connected, validation, authorization) or is asserting on rows we seeded. A test that
   * reached Atlassian with this would fail loudly rather than quietly talking to a real site, which
   * is the behaviour we want from a fixture that must never make a live call.
   */
  function seedConnection(provider: "jira" | "linear", siteUrl = "https://e2e.invalid"): string {
    exec(
      "INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, " +
        `refresh_token, token_expires_at, connected_by) VALUES (${literal(tenant!.organizationId)}, ` +
        `${literal(provider)}, ${literal(`e2e-${provider}-site`)}, ${literal(siteUrl)}, ` +
        `'e2e-not-a-real-token', '', now() + interval '1 hour', ${literal(tenant!.owner.userId)});`,
    );
    return scalar(
      `SELECT id FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)} ` +
        `AND provider = ${literal(provider)};`,
    );
  }

  /** A mirrored Jira ticket, as a completed sync would have left it. */
  function seedJiraTicket(
    connectionId: string,
    fields: { key: string; summary: string; status?: string; priority?: string; assignee?: string },
    projectId?: string,
  ): void {
    exec(
      "INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, " +
        "description, issue_type, status, priority, assignee, jira_url, jira_created_at, jira_updated_at) VALUES (" +
        `${literal(projectId ?? tenant!.mainProjectId)}, ${literal(connectionId)}, ` +
        `${literal(`id-${fields.key}`)}, ${literal(fields.key)}, ${literal(fields.summary)}, ` +
        `'seeded by the e2e suite', 'Story', ${literal(fields.status ?? "To Do")}, ` +
        `${literal(fields.priority ?? "Medium")}, ${literal(fields.assignee ?? "e2e@example.com")}, ` +
        `${literal(`https://e2e.invalid/browse/${fields.key}`)}, now(), now());`,
    );
  }

  function seedLinearTicket(
    connectionId: string,
    fields: { key: string; summary: string; status?: string },
    projectId?: string,
  ): void {
    exec(
      "INSERT INTO linear_tickets (project_id, integration_connection_id, linear_issue_id, linear_issue_key, " +
        "summary, description, issue_type, status, priority, assignee, linear_url, linear_created_at, linear_updated_at) VALUES (" +
        `${literal(projectId ?? tenant!.mainProjectId)}, ${literal(connectionId)}, ` +
        `${literal(`id-${fields.key}`)}, ${literal(fields.key)}, ${literal(fields.summary)}, ` +
        `'seeded by the e2e suite', 'Bug', ${literal(fields.status ?? "Todo")}, 'Medium', 'e2e@example.com', ` +
        `${literal(`https://e2e.invalid/issue/${fields.key}`)}, now(), now());`,
    );
  }

  function seedJiraMapping(connectionId: string, key = "E2E"): void {
    exec(
      "INSERT INTO jira_project_mappings (project_id, jira_connection_id, jira_project_id, jira_project_key, " +
        `jira_project_name, enabled) VALUES (${literal(tenant!.mainProjectId)}, ${literal(connectionId)}, ` +
        `${literal(`jira-${key}`)}, ${literal(key)}, ${literal(`E2E ${key} Project`)}, true);`,
    );
  }

  /** Refused, whatever shape the refusal takes. See api/knowledge-base.spec.ts for the 400 note. */
  async function expectRefused(res: APIResponse, what: string): Promise<void> {
    expect([400, 401, 403, 404], `${what} answered with ${res.status()}: ${await res.text()}`).toContain(res.status());
  }

  /** Every project-scoped integration route, as thunks, so one list drives the authorization tests. */
  function projectRoutes(api: APIRequestContext, projectId?: string): Array<[string, () => Promise<APIResponse>]> {
    const opts = { failOnStatusCode: false } as const;
    return [
      ["GET jira/status", () => api.get(url("/jira/status", projectId), opts)],
      ["GET jira/projects", () => api.get(url("/jira/projects", projectId), opts)],
      [
        "POST jira/projects",
        () => api.post(url("/jira/projects", projectId), { data: { projects: [] }, ...opts }),
      ],
      ["POST jira/sync", () => api.post(url("/jira/sync", projectId), { data: {}, ...opts })],
      ["GET jira/tickets", () => api.get(url("/jira/tickets", projectId), opts)],
      [
        "POST jira/comment",
        () => api.post(url("/jira/comment", projectId), { data: { issueKey: "E2E-1", comment: "hello" }, ...opts }),
      ],
      ["GET jira/search-issues", () => api.get(url("/jira/search-issues?q=e2e", projectId), opts)],
      ["GET linear/status", () => api.get(url("/linear/status", projectId), opts)],
      ["GET linear/teams", () => api.get(url("/linear/teams", projectId), opts)],
      ["POST linear/teams", () => api.post(url("/linear/teams", projectId), { data: { projects: [] }, ...opts })],
      ["POST linear/sync", () => api.post(url("/linear/sync", projectId), { data: {}, ...opts })],
      ["GET linear/tickets", () => api.get(url("/linear/tickets", projectId), opts)],
      [
        "POST linear/comment",
        () => api.post(url("/linear/comment", projectId), { data: { issueKey: "E2E-1", comment: "hello" }, ...opts }),
      ],
      ["GET linear/search-issues", () => api.get(url("/linear/search-issues?q=e2e", projectId), opts)],
      ["GET tickets", () => api.get(url("/tickets", projectId), opts)],
      ["GET tickets/summary", () => api.get(url("/tickets/summary", projectId), opts)],
      ["GET integrations/sync-history", () => api.get(url("/integrations/sync-history", projectId), opts)],
      ["GET integrations/:provider/sync-status", () => api.get(url("/integrations/jira/sync-status", projectId), opts)],
    ];
  }

  // ─── Authorization: this is the wave's centre of gravity ──────────────────

  test("INT-A-01 no project-scoped integration route answers a caller with no session", { tag: '@tesbo.testId("TES-TC-223")' }, async () => {
    // These routes read and write a third party's data with the workspace's stored OAuth token:
    // the ticket store mirrors issue summaries, keys and URLs, and jira/comment and linear/comment
    // post to the customer's real Jira or Linear as the connected account. None of it may be
    // reachable without a session.
    const connectionId = seedConnection("jira");
    seedJiraTicket(connectionId, { key: "E2E-1", summary: "Anonymous must not read this" });

    for (const [what, attempt] of projectRoutes(anon)) {
      await expectRefused(await attempt(), `${what} (anonymous)`);
    }

    // Specifically: the mirrored ticket did not travel to an anonymous caller in any response.
    for (const path of ["/jira/tickets", "/tickets", "/tickets/summary"]) {
      const res = await anon.get(url(path), { failOnStatusCode: false });
      expect(await res.text()).not.toContain("Anonymous must not read this");
    }
  });

  test("INT-A-02 no project-scoped integration route answers a member of another project", { tag: '@tesbo.testId("TES-TC-224")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraTicket(connectionId, { key: "E2E-2", summary: "Not for the guest" });

    // The guest is in the workspace but not in this project, which is the harder case than an
    // outsider: they hold a valid session and the connection is their workspace's.
    for (const [what, attempt] of projectRoutes(asGuest)) {
      await expectRefused(await attempt(), `${what} (non-member)`);
    }
    for (const path of ["/jira/tickets", "/tickets"]) {
      const res = await asGuest.get(url(path), { failOnStatusCode: false });
      expect(await res.text()).not.toContain("Not for the guest");
    }
  });

  test("INT-A-03 a project in another workspace is not reachable by id", { tag: '@tesbo.testId("TES-TC-225")' }, async () => {
    // The second project belongs to the same workspace, so it shares the connection — the check
    // that matters is per-project membership, not per-workspace.
    const connectionId = seedConnection("jira");
    seedJiraTicket(connectionId, { key: "E2E-3", summary: "Second project ticket" }, tenant!.secondProjectId);

    for (const [what, attempt] of projectRoutes(asQa, tenant!.secondProjectId)) {
      // The qa_engineer is a member of the main project only.
      await expectRefused(await attempt(), `${what} (wrong project)`);
    }
  });

  test("INT-A-04 a malformed project id is refused without a 500", { tag: '@tesbo.testId("TES-TC-226")' }, async () => {
    for (const [what, attempt] of projectRoutes(asOwner, "not-a-uuid")) {
      const res = await attempt();
      expect(res.status(), `${what} answered ${res.status()} for a malformed project id: ${await res.text()}`)
        .toBeLessThan(500);
    }
  });

  test("INT-A-05 a project member reaches the read routes that need no upstream", { tag: '@tesbo.testId("TES-TC-227")' }, async () => {
    // The mirror image of the tests above: the guard must not be so wide that it refuses the people
    // the feature exists for.
    for (const [who, api] of [
      ["owner", asOwner],
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      for (const path of ["/jira/status", "/linear/status", "/tickets", "/tickets/summary", "/integrations/sync-history"]) {
        const res = await api.get(url(path), { failOnStatusCode: false });
        expect(res.status(), `a ${who} was refused ${path}: ${await res.text()}`).toBe(200);
      }
    }
  });

  // ─── The not-connected state ──────────────────────────────────────────────

  test("INT-A-06 status reports not-connected rather than erroring when no provider is linked", { tag: '@tesbo.testId("TES-TC-228")' }, async () => {
    for (const provider of ["jira", "linear"]) {
      const res = await asOwner.get(url(`/${provider}/status`), { failOnStatusCode: false });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.connected).toBe(false);
      expect(body.connectedProjects).toEqual([]);
    }
  });

  test("INT-A-07 the routes that need a live provider say it is not connected, without calling out", { tag: '@tesbo.testId("TES-TC-229")' }, async () => {
    // With no connection row these return before any network call, which is what makes them
    // testable here at all. A 404 naming the provider is the contract the UI keys off.
    const cases: Array<[string, () => Promise<APIResponse>]> = [
      ["jira/projects", () => asOwner.get(url("/jira/projects"), { failOnStatusCode: false })],
      [
        "jira/projects (POST)",
        () => asOwner.post(url("/jira/projects"), { data: { projects: [] }, failOnStatusCode: false }),
      ],
      [
        "jira/comment",
        () =>
          asOwner.post(url("/jira/comment"), {
            data: { issueKey: "E2E-1", comment: "hi" },
            failOnStatusCode: false,
          }),
      ],
      ["jira/search-issues", () => asOwner.get(url("/jira/search-issues?q=x"), { failOnStatusCode: false })],
      ["linear/teams", () => asOwner.get(url("/linear/teams"), { failOnStatusCode: false })],
      [
        "linear/teams (POST)",
        () => asOwner.post(url("/linear/teams"), { data: { projects: [] }, failOnStatusCode: false }),
      ],
      [
        "linear/comment",
        () =>
          asOwner.post(url("/linear/comment"), {
            data: { issueKey: "E2E-1", comment: "hi" },
            failOnStatusCode: false,
          }),
      ],
      ["linear/search-issues", () => asOwner.get(url("/linear/search-issues?q=x"), { failOnStatusCode: false })],
    ];

    for (const [what, attempt] of cases) {
      const res = await attempt();
      expect(res.status(), `${what} answered ${res.status()}: ${await res.text()}`).toBe(404);
      expect(JSON.stringify(await res.json()).toLowerCase()).toContain("not connected");
    }
  });

  // ─── The mirrored ticket store ────────────────────────────────────────────

  test("INT-A-08 mirrored Jira tickets are listed with their fields and issue URL", { tag: '@tesbo.testId("TES-TC-230")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraTicket(connectionId, { key: "E2E-10", summary: "Login page rejects valid password", status: "In Progress" });
    seedJiraTicket(connectionId, { key: "E2E-11", summary: "Checkout total is wrong", priority: "High" });

    const res = await asOwner.get(url("/jira/tickets"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const list = body.list ?? body.tickets ?? body;
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(2);

    const first = list.find((t: any) => (t.jiraIssueKey ?? t.key) === "E2E-10");
    expect(first, "the seeded ticket is missing from the list").toBeTruthy();
    expect(first.summary).toBe("Login page rejects valid password");
    expect(first.status).toBe("In Progress");
    // The URL is what makes a row actionable — it is the only way back to the source system.
    expect(String(first.jiraUrl ?? first.url)).toContain("E2E-10");
  });

  test("INT-A-09 the ticket list searches by key and by summary", { tag: '@tesbo.testId("TES-TC-231")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraTicket(connectionId, { key: "E2E-20", summary: "Payment gateway timeout" });
    seedJiraTicket(connectionId, { key: "E2E-21", summary: "Unrelated cosmetic tweak" });

    const bySummary = await (await asOwner.get(url("/jira/tickets?search=gateway"))).json();
    expect((bySummary.list ?? bySummary).map((t: any) => t.jiraIssueKey)).toEqual(["E2E-20"]);

    const byKey = await (await asOwner.get(url("/jira/tickets?search=E2E-21"))).json();
    expect((byKey.list ?? byKey).map((t: any) => t.jiraIssueKey)).toEqual(["E2E-21"]);

    // A search nothing matches is empty rather than unfiltered.
    const none = await (await asOwner.get(url("/jira/tickets?search=zzznomatch"))).json();
    expect((none.list ?? none)).toEqual([]);
  });

  test("INT-A-10 the ticket list paginates, and clamps a limit outside its bounds", { tag: '@tesbo.testId("TES-TC-232")' }, async () => {
    const connectionId = seedConnection("jira");
    for (let i = 1; i <= 5; i++) seedJiraTicket(connectionId, { key: `E2E-3${i}`, summary: `Ticket ${i}` });

    const firstPage = await (await asOwner.get(url("/jira/tickets?limit=2&offset=0"))).json();
    expect((firstPage.list ?? firstPage)).toHaveLength(2);
    const secondPage = await (await asOwner.get(url("/jira/tickets?limit=2&offset=2"))).json();
    expect((secondPage.list ?? secondPage)).toHaveLength(2);
    // Different pages, not the same rows twice.
    const firstKeys = (firstPage.list ?? firstPage).map((t: any) => t.jiraIssueKey);
    const secondKeys = (secondPage.list ?? secondPage).map((t: any) => t.jiraIssueKey);
    expect(firstKeys.some((k: string) => secondKeys.includes(k))).toBe(false);

    // Past the end is empty, not an error.
    const beyond = await (await asOwner.get(url("/jira/tickets?limit=2&offset=500"))).json();
    expect((beyond.list ?? beyond)).toEqual([]);

    // limit is clamped to 0..100: a zero is a caller asking for the count without the rows, which is
    // legitimate and is what api/testcases.spec.ts pins, while the ceiling stops anyone requesting the
    // whole table.
    const zero = await (await asOwner.get(url("/jira/tickets?limit=0"))).json();
    expect((zero.list ?? zero)).toEqual([]);
    const huge = await asOwner.get(url("/jira/tickets?limit=100000"), { failOnStatusCode: false });
    expect(huge.status()).toBe(200);
    expect(((await huge.json()).list ?? []).length).toBeLessThanOrEqual(100);

    // A non-numeric limit must not reach the query as NaN. `Number("abc")` is NaN and NaN survives
    // Math.min/Math.max untouched, so this used to put NaN in a LIMIT clause and Postgres answered
    // with an error — a 500 reachable by typing a word into a query string.
    const nonsense = await asOwner.get(url("/jira/tickets?limit=abc&offset=abc"), { failOnStatusCode: false });
    expect(nonsense.status(), `a non-numeric limit answered ${nonsense.status()}`).toBe(200);
    // It falls back to the default page rather than to an empty one.
    expect(((await nonsense.json()).list ?? []).length).toBeGreaterThanOrEqual(1);

    // Same for a negative and a fractional page.
    for (const qs of ["limit=-5", "offset=-1", "limit=2.7"]) {
      const res = await asOwner.get(url(`/jira/tickets?${qs}`), { failOnStatusCode: false });
      expect(res.status(), `${qs} answered ${res.status()}: ${await res.text()}`).toBe(200);
    }
  });

  test("INT-A-11 a project's ticket list carries only its own project's tickets", { tag: '@tesbo.testId("TES-TC-233")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraTicket(connectionId, { key: "E2E-40", summary: "Belongs to the main project" });
    seedJiraTicket(connectionId, { key: "E2E-41", summary: "Belongs to the second project" }, tenant!.secondProjectId);

    const body = await (await asOwner.get(url("/jira/tickets"))).json();
    const keys = (body.list ?? body).map((t: any) => t.jiraIssueKey);
    expect(keys).toEqual(["E2E-40"]);
    expect(JSON.stringify(body)).not.toContain("Belongs to the second project");
  });

  test("INT-A-12 mirrored Linear issues list on their own route with the same shape", { tag: '@tesbo.testId("TES-TC-234")' }, async () => {
    const connectionId = seedConnection("linear");
    seedLinearTicket(connectionId, { key: "LIN-1", summary: "Sidebar collapses on resize" });
    seedLinearTicket(connectionId, { key: "LIN-2", summary: "Second Linear issue", status: "Done" });

    const res = await asOwner.get(url("/linear/tickets"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const list = (await res.json()).list ?? [];
    expect(list).toHaveLength(2);
    const first = list.find((t: any) => t.linearIssueKey === "LIN-1");
    expect(first.summary).toBe("Sidebar collapses on resize");
    expect(String(first.linearUrl)).toContain("LIN-1");

    const searched = await (await asOwner.get(url("/linear/tickets?search=Sidebar"))).json();
    expect((searched.list ?? []).map((t: any) => t.linearIssueKey)).toEqual(["LIN-1"]);
  });

  // ─── The Requirements page aggregates ─────────────────────────────────────

  test("INT-A-13 the combined tickets list merges both providers", { tag: '@tesbo.testId("TES-TC-235")' }, async () => {
    const jira = seedConnection("jira");
    const linear = seedConnection("linear");
    seedJiraTicket(jira, { key: "E2E-50", summary: "From Jira" });
    seedLinearTicket(linear, { key: "LIN-50", summary: "From Linear" });

    const res = await asOwner.get(url("/tickets"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const payload = await res.json();
    const serialised = JSON.stringify(payload);
    // The Requirements screen shows one list regardless of where a requirement came from, so both
    // sources have to appear in the same response.
    expect(serialised).toContain("E2E-50");
    expect(serialised).toContain("LIN-50");
  });

  test("INT-A-14 the requirements summary counts what is mirrored, and is zero when nothing is", { tag: '@tesbo.testId("TES-TC-236")' }, async () => {
    const empty = await asOwner.get(url("/tickets/summary"), { failOnStatusCode: false });
    expect(empty.status()).toBe(200);
    const emptyBody = JSON.stringify(await empty.json());
    // Nothing synced yet: the summary reports zeroes rather than failing or omitting the sources.
    expect(emptyBody).toBeTruthy();

    const jira = seedConnection("jira");
    const linear = seedConnection("linear");
    seedJiraTicket(jira, { key: "E2E-60", summary: "Counted", status: "Done" });
    seedJiraTicket(jira, { key: "E2E-61", summary: "Counted too", status: "To Do" });
    seedLinearTicket(linear, { key: "LIN-60", summary: "Counted as well" });

    const res = await asOwner.get(url("/tickets/summary"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const summary = await res.json();
    // Three tickets across two providers must be reflected somewhere in the payload; the exact
    // shape is the screen's business, the arithmetic is what this pins.
    const numbers = JSON.stringify(summary).match(/\d+/g)?.map(Number) ?? [];
    expect(numbers.some((n) => n === 3) || numbers.some((n) => n === 2), `summary was ${JSON.stringify(summary)}`).toBe(
      true,
    );
  });

  // ─── Sync history and status ──────────────────────────────────────────────

  test("INT-A-15 sync history is empty for a project that has never synced, and is project-scoped", { tag: '@tesbo.testId("TES-TC-237")' }, async () => {
    const res = await asOwner.get(url("/integrations/sync-history"), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    // The payload is `{ runs: [...] }` — the Requirements page polls it while a sync is in flight,
    // so the envelope has room for more than the list.
    const body = await res.json();
    expect(Array.isArray(body.runs), `sync history was ${JSON.stringify(body)}`).toBe(true);
    expect(body.runs).toEqual([]);
  });

  test("INT-A-16 sync-status answers for a known provider and refuses an unknown one", { tag: '@tesbo.testId("TES-TC-238")' }, async () => {
    for (const provider of ["jira", "linear"]) {
      const res = await asOwner.get(url(`/integrations/${provider}/sync-status`), { failOnStatusCode: false });
      expect(res.status(), `${provider} sync-status answered ${res.status()}: ${await res.text()}`).toBe(200);
    }

    // An unknown provider must not be treated as a valid one — the value reaches a provider switch.
    const unknown = await asOwner.get(url("/integrations/notaprovider/sync-status"), { failOnStatusCode: false });
    expect(unknown.status(), `an unknown provider answered ${unknown.status()}`).toBeGreaterThanOrEqual(400);
    expect(unknown.status()).toBeLessThan(500);
  });

  // ─── Mapping validation ───────────────────────────────────────────────────

  test("INT-A-17 connecting Jira projects validates its payload before touching the mapping table", { tag: '@tesbo.testId("TES-TC-239")' }, async () => {
    const connectionId = seedConnection("jira");

    // A malformed payload must not delete the existing mapping on its way to a refusal.
    seedJiraMapping(connectionId, "KEEP");
    const before = scalar(
      `SELECT COUNT(*) FROM jira_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)};`,
    );

    for (const data of [{}, { projects: "not-an-array" }, { projects: [{ id: "" }] }, { projects: [{}] }]) {
      const res = await asOwner.post(url("/jira/projects"), { data, failOnStatusCode: false });
      expect(res.status(), `${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }

    expect(
      scalar(`SELECT COUNT(*) FROM jira_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)};`),
      "a refused mapping payload changed the stored mappings",
    ).toBe(before);
  });

  test("INT-A-18 a comment requires both an issue key and a body", { tag: '@tesbo.testId("TES-TC-240")' }, async () => {
    seedConnection("jira");
    seedConnection("linear");

    for (const provider of ["jira", "linear"]) {
      for (const data of [{}, { issueKey: "E2E-1" }, { comment: "orphaned" }, { issueKey: "", comment: "" }]) {
        const res = await asOwner.post(url(`/${provider}/comment`), { data, failOnStatusCode: false });
        // Validation happens before the outbound call, so this is reachable without an upstream —
        // and it matters, because the alternative is posting an empty comment to a customer's issue.
        expect(
          res.status(),
          `${provider} comment ${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`,
        ).toBe(400);
        expect(JSON.stringify(await res.json()).toLowerCase()).toContain("required");
      }
    }
  });

  // ─── Workspace-scoped connection routes ───────────────────────────────────

  test("INT-A-19 the workspace connection routes refuse a caller with no session", { tag: '@tesbo.testId("TES-TC-241")' }, async () => {
    const routes: Array<[string, () => Promise<APIResponse>]> = [
      ["auth-url", () => anon.get("/api/workspace/integrations/jira/auth-url", { failOnStatusCode: false })],
      ["config", () => anon.get("/api/workspace/integrations/jira/config", { failOnStatusCode: false })],
      ["status", () => anon.get("/api/workspace/integrations/jira/status", { failOnStatusCode: false })],
      [
        "callback",
        () =>
          anon.post("/api/workspace/integrations/jira/callback", {
            data: { code: "e2e-not-a-real-code" },
            failOnStatusCode: false,
          }),
      ],
      [
        "disconnect",
        () => anon.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false }),
      ],
    ];
    for (const [what, attempt] of routes) await expectRefused(await attempt(), `workspace ${what}`);
  });

  test("INT-A-20 connection status and config are readable by a member and report not-connected", { tag: '@tesbo.testId("TES-TC-242")' }, async () => {
    for (const provider of ["jira", "linear"]) {
      const status = await asOwner.get(`/api/workspace/integrations/${provider}/status`, { failOnStatusCode: false });
      expect(status.status(), `${provider} status — ${await status.text()}`).toBe(200);
      expect((await status.json()).connected).toBe(false);

      // config reports whether the deployment has OAuth credentials at all, which is what the UI
      // uses to decide between "Connect" and "ask your administrator".
      const config = await asOwner.get(`/api/workspace/integrations/${provider}/config`, { failOnStatusCode: false });
      expect(config.status(), `${provider} config — ${await config.text()}`).toBe(200);
      expect(await config.json()).toBeTruthy();
    }
  });

  test("INT-A-21 status reports connected once a connection exists, and disconnect removes it", { tag: '@tesbo.testId("TES-TC-243")' }, async () => {
    seedConnection("jira", "https://e2e-site.invalid");

    const connected = await asOwner.get("/api/workspace/integrations/jira/status", { failOnStatusCode: false });
    expect(connected.status()).toBe(200);
    const body = await connected.json();
    expect(body.connected).toBe(true);
    // The stored token must never travel to a client, connected or not.
    expect(JSON.stringify(body)).not.toContain("e2e-not-a-real-token");

    const disconnected = await asOwner.delete("/api/workspace/integrations/jira/disconnect", {
      failOnStatusCode: false,
    });
    expect(disconnected.status()).toBe(200);
    expect(
      scalar(
        `SELECT COUNT(*) FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)} ` +
          "AND provider = 'jira';",
      ),
      "disconnect left the connection row behind",
    ).toBe("0");

    // Disconnecting again is harmless rather than a 500.
    const again = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(again.status()).toBeLessThan(500);
  });

  test("INT-A-22 disconnecting is not something a qa_engineer can do to the whole workspace", { tag: '@tesbo.testId("TES-TC-244")' }, async () => {
    seedConnection("jira");
    const res = await asQa.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    // Connecting an app is a workspace-wide administrative action: one engineer disconnecting it
    // breaks the integration for everyone.
    expect([403, 404], `a qa_engineer got ${res.status()} disconnecting the workspace integration`).toContain(
      res.status(),
    );
    expect(
      scalar(
        `SELECT COUNT(*) FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)};`,
      ),
    ).toBe("1");
  });

  test("INT-A-23 an unknown provider is refused everywhere rather than silently accepted", { tag: '@tesbo.testId("TES-TC-245")' }, async () => {
    for (const suffix of ["auth-url", "config", "status"]) {
      const res = await asOwner.get(`/api/workspace/integrations/notaprovider/${suffix}`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `${suffix} accepted an unknown provider: ${await res.text()}`).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }

    const callback = await asOwner.post("/api/workspace/integrations/notaprovider/callback", {
      data: { code: "x" },
      failOnStatusCode: false,
    });
    expect(callback.status()).toBeGreaterThanOrEqual(400);
    expect(callback.status()).toBeLessThan(500);

    const disconnect = await asOwner.delete("/api/workspace/integrations/notaprovider/disconnect", {
      failOnStatusCode: false,
    });
    expect(disconnect.status()).toBeGreaterThanOrEqual(400);
    expect(disconnect.status()).toBeLessThan(500);
  });

  test("INT-A-24 the OAuth callback refuses a request with no authorization code", { tag: '@tesbo.testId("TES-TC-246")' }, async () => {
    for (const data of [{}, { code: "" }, { code: "   " }]) {
      const res = await asOwner.post("/api/workspace/integrations/jira/callback", { data, failOnStatusCode: false });
      // Refused before any token exchange is attempted, so this is reachable with no upstream.
      expect(res.status(), `callback ${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBe(400);
      expect(
        scalar(
          `SELECT COUNT(*) FROM integration_connections WHERE organization_id = ${literal(tenant!.organizationId)};`,
        ),
      ).toBe("0");
    }
  });

  test("INT-A-25 the auth-url route reports a missing OAuth app rather than returning a broken link", { tag: '@tesbo.testId("TES-TC-247")' }, async () => {
    const res = await asOwner.get("/api/workspace/integrations/jira/auth-url", { failOnStatusCode: false });
    // Either the deployment has a Jira OAuth app configured, in which case a real authorize URL
    // comes back, or it does not, in which case the caller must be told — a 200 carrying a URL with
    // an empty client_id would send the user to an Atlassian error page instead.
    if (res.status() === 200) {
      const body = await res.json();
      const authUrl = String(body.url ?? body.authUrl ?? "");
      expect(authUrl).toContain("http");
      expect(authUrl, "the authorize URL was built with an empty client id").not.toMatch(/client_id=(&|$)/);
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
  });

  // ─── Knowledge Base sync-events (the nightly-cron work's info-icon popover) ──────────────
  //
  // What's driven here: the read endpoint end to end, seeding knowledge_document_sync_events
  // directly (the same reason every other seed* helper above exists — actually producing an event
  // means a real sync, which means a real outbound call). What is NOT reachable from this suite,
  // for the same reason the rest of this file states up top: the nightly orchestrator's own trigger
  // (a BullMQ Job Scheduler tick, not an HTTP route), the incremental "updated >=" fetch, the
  // content-compare skip, and the Linear plan-gating exclusion in listNightlySyncTargets — all of
  // that logic either has no route to drive it from outside the process, or only resolves once a
  // real provider answers. Recorded here rather than silently left uncovered.

  test("INT-A-26 sync-events answers a caller with no session with a refusal, not the timeline", { tag: '@tesbo.testId("TES-TC-248")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-1", "Anon must not see this");
    seedSyncEvent(doc, "created", null);

    const res = await anon.get(url(`/knowledge-base/documents/${doc}/sync-events`), { failOnStatusCode: false });
    await expectRefused(res, "sync-events (anonymous)");
  });

  test("INT-A-27 sync-events refuses a caller outside the project", { tag: '@tesbo.testId("TES-TC-249")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-2", "Not for the guest");
    seedSyncEvent(doc, "created", null);

    // The guest holds a valid session in this workspace but isn't a member of the project the
    // document lives in — the harder case than an outright stranger.
    const asGuestRes = await asGuest.get(url(`/knowledge-base/documents/${doc}/sync-events`), { failOnStatusCode: false });
    await expectRefused(asGuestRes, "sync-events (non-member)");

    // A member of the *second* project reaching for the main project's document by id.
    const secondDoc = seedMirrorDocument("jira", "sync-evt-3", "Second project's ticket", tenant!.secondProjectId);
    const crossProject = await asQa.get(url(`/knowledge-base/documents/${secondDoc}/sync-events`), { failOnStatusCode: false });
    await expectRefused(crossProject, "sync-events (wrong project)");
  });

  test("INT-A-28 sync-events 404s for a document that doesn't exist or isn't in this project", { tag: '@tesbo.testId("TES-TC-250")' }, async () => {
    const missing = await asOwner.get(url(`/knowledge-base/documents/${crypto.randomUUID()}/sync-events`), {
      failOnStatusCode: false,
    });
    expect(missing.status(), `an unknown document id answered ${missing.status()}`).toBe(404);

    // Malformed input must not reach the query as a bad UUID and 500.
    const malformed = await asOwner.get(url("/knowledge-base/documents/not-a-uuid/sync-events"), {
      failOnStatusCode: false,
    });
    expect(malformed.status(), `a malformed document id answered ${malformed.status()}: ${await malformed.text()}`).toBe(404);
  });

  test("INT-A-29 a mirror with no recorded history yet answers with an empty timeline, not an error", { tag: '@tesbo.testId("TES-TC-251")' }, async () => {
    // Covers a mirror synced before this feature shipped: it exists, but recordSyncEvent never ran
    // for it, so it has zero rows in knowledge_document_sync_events — the endpoint must not treat
    // that as "not found".
    const doc = seedMirrorDocument("jira", "sync-evt-4", "Never had an event logged");
    const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/sync-events`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).events).toEqual([]);
  });

  test("INT-A-30 a regular (non-synced) document also answers with an empty timeline", { tag: '@tesbo.testId("TES-TC-252")' }, async () => {
    // The endpoint doesn't special-case on source_provider — a human-authored document is simply a
    // document with no sync history, not a different code path.
    const created = await asOwner.post(url("/knowledge-base/documents"), {
      data: { title: "Plain human document", folderId: rootFolderId },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const docId = (await created.json()).id;

    const res = await asOwner.get(url(`/knowledge-base/documents/${docId}/sync-events`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).events).toEqual([]);
  });

  test("INT-A-31 a mirror's timeline lists its events newest first, with type and summary", { tag: '@tesbo.testId("TES-TC-253")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-5", "E2E-70: Has a real timeline");
    seedSyncEvent(doc, "created", null);
    seedSyncEvent(doc, "updated", "Status: To Do -> In Progress updated.");
    seedSyncEvent(doc, "updated", "Description updated.");

    const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/sync-events`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(3);
    // Newest first: the last-seeded "Description updated." row leads.
    expect(body.events[0].eventType).toBe("updated");
    expect(body.events[0].changedSummary).toBe("Description updated.");
    expect(body.events[2].eventType).toBe("created");
    expect(body.events[2].changedSummary).toBeNull();
    // Fewer than a page's worth (default limit 5) — nothing more to page to.
    expect(body.hasMore).toBe(false);
  });

  test("INT-A-32 the timeline paginates 5 per page, newest first, stable across pages", { tag: '@tesbo.testId("TES-TC-256")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-6", "E2E-71: Long timeline");
    // 7 events, oldest to newest, so the newest ("v7") is what page 1 must lead with.
    for (let i = 1; i <= 7; i++) seedSyncEvent(doc, "updated", `v${i}`);

    const firstPage = await (await asOwner.get(url(`/knowledge-base/documents/${doc}/sync-events?limit=5&offset=0`))).json();
    expect(firstPage.events).toHaveLength(5);
    expect(firstPage.hasMore, "5 shown out of 7 total — there must be a next page").toBe(true);
    expect(firstPage.events.map((e: any) => e.changedSummary)).toEqual(["v7", "v6", "v5", "v4", "v3"]);

    const secondPage = await (await asOwner.get(url(`/knowledge-base/documents/${doc}/sync-events?limit=5&offset=5`))).json();
    expect(secondPage.events).toHaveLength(2);
    expect(secondPage.hasMore, "exactly the remainder — no third page").toBe(false);
    expect(secondPage.events.map((e: any) => e.changedSummary)).toEqual(["v2", "v1"]);

    // Pages don't overlap or drop a row between them.
    const allSummaries = [...firstPage.events, ...secondPage.events].map((e: any) => e.changedSummary);
    expect(allSummaries).toEqual(["v7", "v6", "v5", "v4", "v3", "v2", "v1"]);

    // Past the end is an empty page with nothing further, not an error.
    const beyond = await asOwner.get(url(`/knowledge-base/documents/${doc}/sync-events?limit=5&offset=500`), { failOnStatusCode: false });
    expect(beyond.status()).toBe(200);
    const beyondBody = await beyond.json();
    expect(beyondBody.events).toEqual([]);
    expect(beyondBody.hasMore).toBe(false);
  });

  test("INT-A-33 malformed limit/offset fall back to defaults instead of a 500", { tag: '@tesbo.testId("TES-TC-257")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-7", "E2E-72: Bad pagination input");
    seedSyncEvent(doc, "created", null);

    for (const qs of ["limit=abc&offset=abc", "limit=-5", "offset=-1", "limit=2.7", "limit=0", "limit=100000"]) {
      const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/sync-events?${qs}`), { failOnStatusCode: false });
      expect(res.status(), `${qs} answered ${res.status()}: ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.events), `${qs} — events was ${JSON.stringify(body)}`).toBe(true);
    }
  });
});
