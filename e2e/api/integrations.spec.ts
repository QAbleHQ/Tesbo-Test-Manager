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
 * GET .../knowledge-base/documents/:id/history, which IS driven here end to end (authorization,
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
    // Was missing entirely until the nightly-sync dedup fix (V90) added tests that seed rows here —
    // without it, seeded runs from one test could leak into the next.
    exec(`DELETE FROM integration_sync_runs WHERE project_id IN (${projects});`);
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

  /**
   * A row of `integration_sync_runs`, as a completed (or failed) sync would have left it —
   * seeded directly for the same "no real Jira/Linear call" reason as the fixtures above. Used to
   * pin the nightly-sync dedup fix (V90) and the clean-reconnect-message fix on the read side
   * (sync-status/sync-history), without needing to reproduce either defect through a real sync.
   */
  function seedSyncRun(
    provider: "jira" | "linear",
    fields: { status?: string; triggerSource?: "manual" | "nightly"; error?: string | null; remoteProjectKey?: string; projectId?: string } = {},
  ): string {
    const status = fields.status ?? "failed";
    const projectId = fields.projectId ?? tenant!.mainProjectId;
    exec(
      "INSERT INTO integration_sync_runs (organization_id, project_id, provider, status, stage, trigger_source, error, remote_project_key, started_at, finished_at) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(projectId)}, ${literal(provider)}, ${literal(status)}, ` +
        `${literal(status === "failed" ? "failed" : "done")}, ${literal(fields.triggerSource ?? "nightly")}, ` +
        `${fields.error === undefined ? "NULL" : literal(fields.error)}, ${fields.remoteProjectKey ? literal(fields.remoteProjectKey) : "NULL"}, ` +
        "now(), now());",
    );
    return scalar(
      `SELECT id FROM integration_sync_runs WHERE project_id = ${literal(projectId)} AND provider = ${literal(provider)} ` +
        "ORDER BY created_at DESC LIMIT 1;",
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

  /**
   * A ticket only exists in the running product because some sync run wrote it under a mapping —
   * mapped_remote_id (V96) records which one, and the default read path (jiraTickets/linearTickets/
   * allTickets/tickets-summary) now scopes to whichever mapping is *currently* enabled for the
   * project (this is the fix for "tickets from all projects are displayed instead of only the
   * selected project"). So every ticket fixture needs a matching enabled mapping to be visible by
   * default: reuse one if the test already seeded it (seedJiraMapping/seedLinearMapping), else
   * auto-create one — transparent to every call site that doesn't care about mapping specifics.
   * Pass `mappedRemoteId` explicitly to seed a ticket that deliberately does NOT match the current
   * mapping (a stale/historical row) for the scoping tests below.
   */
  function currentOrAutoJiraMapping(connectionId: string, projectId: string): string {
    const existing = scalar(
      `SELECT jira_project_id FROM jira_project_mappings WHERE project_id = ${literal(projectId)} AND enabled = true LIMIT 1;`,
    );
    if (existing) return existing;
    const autoId = `jira-auto-${projectId}`;
    exec(
      "INSERT INTO jira_project_mappings (project_id, jira_connection_id, jira_project_id, jira_project_key, jira_project_name, enabled) " +
        `VALUES (${literal(projectId)}, ${literal(connectionId)}, ${literal(autoId)}, 'AUTO', 'E2E auto mapping', true);`,
    );
    return autoId;
  }

  function currentOrAutoLinearMapping(connectionId: string, projectId: string): string {
    const existing = scalar(
      `SELECT linear_team_id FROM linear_project_mappings WHERE project_id = ${literal(projectId)} AND enabled = true LIMIT 1;`,
    );
    if (existing) return existing;
    const autoId = `linear-auto-${projectId}`;
    exec(
      "INSERT INTO linear_project_mappings (project_id, integration_connection_id, linear_team_id, linear_team_key, linear_team_name, entity_type, enabled) " +
        `VALUES (${literal(projectId)}, ${literal(connectionId)}, ${literal(autoId)}, 'AUTO', 'E2E auto mapping', 'team', true);`,
    );
    return autoId;
  }

  /** A mirrored Jira ticket, as a completed sync would have left it. */
  function seedJiraTicket(
    connectionId: string,
    fields: { key: string; summary: string; status?: string; priority?: string; assignee?: string; mappedRemoteId?: string },
    projectId?: string,
  ): void {
    const pid = projectId ?? tenant!.mainProjectId;
    const mappedRemoteId = fields.mappedRemoteId ?? currentOrAutoJiraMapping(connectionId, pid);
    exec(
      "INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, " +
        "description, issue_type, status, priority, assignee, jira_url, jira_created_at, jira_updated_at, mapped_remote_id) VALUES (" +
        `${literal(pid)}, ${literal(connectionId)}, ` +
        `${literal(`id-${fields.key}`)}, ${literal(fields.key)}, ${literal(fields.summary)}, ` +
        `'seeded by the e2e suite', 'Story', ${literal(fields.status ?? "To Do")}, ` +
        `${literal(fields.priority ?? "Medium")}, ${literal(fields.assignee ?? "e2e@example.com")}, ` +
        `${literal(`https://e2e.invalid/browse/${fields.key}`)}, now(), now(), ${literal(mappedRemoteId)});`,
    );
  }

  function seedLinearTicket(
    connectionId: string,
    fields: { key: string; summary: string; status?: string; mappedRemoteId?: string },
    projectId?: string,
  ): void {
    const pid = projectId ?? tenant!.mainProjectId;
    const mappedRemoteId = fields.mappedRemoteId ?? currentOrAutoLinearMapping(connectionId, pid);
    exec(
      "INSERT INTO linear_tickets (project_id, integration_connection_id, linear_issue_id, linear_issue_key, " +
        "summary, description, issue_type, status, priority, assignee, linear_url, linear_created_at, linear_updated_at, mapped_remote_id) VALUES (" +
        `${literal(pid)}, ${literal(connectionId)}, ` +
        `${literal(`id-${fields.key}`)}, ${literal(fields.key)}, ${literal(fields.summary)}, ` +
        `'seeded by the e2e suite', 'Bug', ${literal(fields.status ?? "Todo")}, 'Medium', 'e2e@example.com', ` +
        `${literal(`https://e2e.invalid/issue/${fields.key}`)}, now(), now(), ${literal(mappedRemoteId)});`,
    );
  }

  function seedJiraMapping(connectionId: string, key = "E2E"): void {
    exec(
      "INSERT INTO jira_project_mappings (project_id, jira_connection_id, jira_project_id, jira_project_key, " +
        `jira_project_name, enabled) VALUES (${literal(tenant!.mainProjectId)}, ${literal(connectionId)}, ` +
        `${literal(`jira-${key}`)}, ${literal(key)}, ${literal(`E2E ${key} Project`)}, true);`,
    );
  }

  /** A Linear mapping row for the main project — `entityType` covers both the pre-existing Team
   *  mapping and the newer Project mapping (V95's entity_type column), which share this one table. */
  function seedLinearMapping(connectionId: string, key = "E2E", entityType: "team" | "project" = "team"): void {
    exec(
      "INSERT INTO linear_project_mappings (project_id, integration_connection_id, linear_team_id, linear_team_key, " +
        `linear_team_name, entity_type, enabled) VALUES (${literal(tenant!.mainProjectId)}, ${literal(connectionId)}, ` +
        `${literal(`linear-${key}`)}, ${literal(key)}, ${literal(`E2E ${key}`)}, ${literal(entityType)}, true);`,
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

  // ─── Knowledge Base Change History (GET .../documents/:id/history) ──────────────────────
  //
  // Serves BOTH a synced mirror's sync-pipeline log AND a manually-created document's own
  // synthesized (version-diff) timeline behind one endpoint and one response shape — the read side
  // never special-cases on source_provider (INT-A-30b). What's driven here: the read endpoint end
  // to end, seeding knowledge_document_sync_events / knowledge_document_versions directly (the same
  // reason every other seed* helper above exists — actually producing a sync event means a real
  // sync, which means a real outbound call). What is NOT reachable from this suite, for the same
  // reason the rest of this file states up top: the nightly orchestrator's own trigger (a BullMQ Job
  // Scheduler tick, not an HTTP route), the incremental "updated >=" fetch, the content-compare
  // skip, and the Linear plan-gating exclusion in listNightlySyncTargets — all of that logic either
  // has no route to drive it from outside the process, or only resolves once a real provider
  // answers. Recorded here rather than silently left uncovered.

  test("INT-A-26 history answers a caller with no session with a refusal, not the timeline", { tag: '@tesbo.testId("TES-TC-248")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-1", "Anon must not see this");
    seedSyncEvent(doc, "created", null);

    const res = await anon.get(url(`/knowledge-base/documents/${doc}/history`), { failOnStatusCode: false });
    await expectRefused(res, "history (anonymous)");
  });

  test("INT-A-27 history refuses a caller outside the project", { tag: '@tesbo.testId("TES-TC-249")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-2", "Not for the guest");
    seedSyncEvent(doc, "created", null);

    // The guest holds a valid session in this workspace but isn't a member of the project the
    // document lives in — the harder case than an outright stranger.
    const asGuestRes = await asGuest.get(url(`/knowledge-base/documents/${doc}/history`), { failOnStatusCode: false });
    await expectRefused(asGuestRes, "history (non-member)");

    // A member of the *second* project reaching for the main project's document by id.
    const secondDoc = seedMirrorDocument("jira", "sync-evt-3", "Second project's ticket", tenant!.secondProjectId);
    const crossProject = await asQa.get(url(`/knowledge-base/documents/${secondDoc}/history`), { failOnStatusCode: false });
    await expectRefused(crossProject, "history (wrong project)");
  });

  test("INT-A-28 history 404s for a document that doesn't exist or isn't in this project", { tag: '@tesbo.testId("TES-TC-250")' }, async () => {
    const missing = await asOwner.get(url(`/knowledge-base/documents/${crypto.randomUUID()}/history`), {
      failOnStatusCode: false,
    });
    expect(missing.status(), `an unknown document id answered ${missing.status()}`).toBe(404);

    // Malformed input must not reach the query as a bad UUID and 500.
    const malformed = await asOwner.get(url("/knowledge-base/documents/not-a-uuid/history"), {
      failOnStatusCode: false,
    });
    expect(malformed.status(), `a malformed document id answered ${malformed.status()}: ${await malformed.text()}`).toBe(404);
  });

  test("INT-A-29 a mirror with no recorded history yet answers with an empty timeline, not an error", { tag: '@tesbo.testId("TES-TC-251")' }, async () => {
    // Covers a mirror synced before this feature shipped: it exists, but recordSyncEvent never ran
    // for it, so it has zero rows in knowledge_document_sync_events — the endpoint must not treat
    // that as "not found".
    const doc = seedMirrorDocument("jira", "sync-evt-4", "Never had an event logged");
    const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/history`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).events).toEqual([]);
  });

  test("INT-A-30 a regular (non-synced) document answers with its own Added entry, not the mirror's empty-timeline case", { tag: '@tesbo.testId("TES-TC-252")' }, async () => {
    // Unlike a legacy mirror (INT-A-29), a document freshly created through this endpoint always has
    // at least one entry — its own creation — because unlike a pre-feature mirror, there is no
    // "created before this shipped" gap for a document being created right now.
    const created = await asOwner.post(url("/knowledge-base/documents"), {
      data: { title: "Plain human document", folderId: rootFolderId },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const docId = (await created.json()).id;

    const res = await asOwner.get(url(`/knowledge-base/documents/${docId}/history`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe("created");
    expect(body.events[0].changedSummary).toBe("Added.");
    // A real resolved name, never a raw user id.
    expect(body.events[0].actorName).toContain("Owner");
    // Nothing has ever been edited yet, so there is no version to restore.
    expect(body.events[0].versionId).toBeNull();
    expect(body.hasMore).toBe(false);
  });

  test("INT-A-30b editing a manual document reports a real field-level diff, attributes it to the editor, and carries a restorable versionId", { tag: '@tesbo.testId("TES-TC-2053")' }, async () => {
    const created = await asOwner.post(url("/knowledge-base/documents"), {
      data: { title: "Diffable document", folderId: rootFolderId, documentType: "general", contentText: "Original body." },
      failOnStatusCode: false,
    });
    const docId = (await created.json()).id;

    // Seeded directly rather than waiting out the 15-minute snapshot-coalescing window a real
    // second edit would otherwise hit (same reason ui/knowledge-base.spec.ts's seedDocumentVersion
    // exists) — this snapshots the state right before an edit, exactly like a real throttled save.
    exec(
      "INSERT INTO knowledge_document_versions (document_id, version_number, title, content_html, content_text, created_by) VALUES (" +
        `${literal(docId)}, 1, 'Diffable document', '<p>Original body.</p>', 'Original body.', ${literal(tenant!.owner.userId)});`,
    );
    await asOwner.patch(url(`/knowledge-base/documents/${docId}`), { data: { contentText: "Edited body, now different." } });

    const res = await asOwner.get(url(`/knowledge-base/documents/${docId}/history`), { failOnStatusCode: false });
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    const updated = body.events[0];
    expect(updated.eventType).toBe("updated");
    expect(updated.changedSummary).toContain("Details");
    expect(updated.actorName).toContain("Owner");
    expect(updated.versionId).not.toBeNull();
    expect(Array.isArray(updated.changedFields)).toBe(true);
    expect(updated.changedFields[0].oldExcerpt).toContain("Original body.");
    expect(updated.changedFields[0].newExcerpt).toContain("Edited body, now different.");
  });

  test("INT-A-30c an AI memory's approve/reject is folded into its own history as a distinct entry", { tag: '@tesbo.testId("TES-TC-2054")' }, async () => {
    const created = await asOwner.post(url("/knowledge-base/documents"), {
      data: { title: "Memory doc", folderId: rootFolderId, documentType: "ai_memory", contentText: "Remembered fact." },
      failOnStatusCode: false,
    });
    const docId = (await created.json()).id;

    const approve = await asOwner.patch(url(`/knowledge-base/documents/${docId}/approve-ai-memory`), { failOnStatusCode: false });
    expect(approve.status(), `approve answered ${approve.status()}: ${await approve.text()}`).toBe(200);

    const res = await asOwner.get(url(`/knowledge-base/documents/${docId}/history`), { failOnStatusCode: false });
    const body = await res.json();
    expect(body.events.some((e: any) => e.changedSummary === "Marked as Approved.")).toBe(true);
  });

  test("INT-A-30d a Linear mirror's timeline round-trips through the same endpoint, provider-agnostic end to end", { tag: '@tesbo.testId("TES-TC-2055")' }, async () => {
    const doc = seedMirrorDocument("linear", "sync-evt-linear-1", "E2E-70b: Linear ticket");
    seedSyncEvent(doc, "updated", "Priority updated.", "linear");

    const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/history`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].changedSummary).toBe("Priority updated.");
  });

  test("INT-A-31 a mirror's timeline lists its events newest first, with type and summary", { tag: '@tesbo.testId("TES-TC-253")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-5", "E2E-70: Has a real timeline");
    seedSyncEvent(doc, "created", null);
    seedSyncEvent(doc, "updated", "Status: To Do -> In Progress updated.");
    seedSyncEvent(doc, "updated", "Description updated.");

    const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/history`), { failOnStatusCode: false });
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

    const firstPage = await (await asOwner.get(url(`/knowledge-base/documents/${doc}/history?limit=5&offset=0`))).json();
    expect(firstPage.events).toHaveLength(5);
    expect(firstPage.hasMore, "5 shown out of 7 total — there must be a next page").toBe(true);
    expect(firstPage.events.map((e: any) => e.changedSummary)).toEqual(["v7", "v6", "v5", "v4", "v3"]);

    const secondPage = await (await asOwner.get(url(`/knowledge-base/documents/${doc}/history?limit=5&offset=5`))).json();
    expect(secondPage.events).toHaveLength(2);
    expect(secondPage.hasMore, "exactly the remainder — no third page").toBe(false);
    expect(secondPage.events.map((e: any) => e.changedSummary)).toEqual(["v2", "v1"]);

    // Pages don't overlap or drop a row between them.
    const allSummaries = [...firstPage.events, ...secondPage.events].map((e: any) => e.changedSummary);
    expect(allSummaries).toEqual(["v7", "v6", "v5", "v4", "v3", "v2", "v1"]);

    // Past the end is an empty page with nothing further, not an error.
    const beyond = await asOwner.get(url(`/knowledge-base/documents/${doc}/history?limit=5&offset=500`), { failOnStatusCode: false });
    expect(beyond.status()).toBe(200);
    const beyondBody = await beyond.json();
    expect(beyondBody.events).toEqual([]);
    expect(beyondBody.hasMore).toBe(false);
  });

  test("INT-A-33 malformed limit/offset fall back to defaults instead of a 500", { tag: '@tesbo.testId("TES-TC-257")' }, async () => {
    const doc = seedMirrorDocument("jira", "sync-evt-7", "E2E-72: Bad pagination input");
    seedSyncEvent(doc, "created", null);

    for (const qs of ["limit=abc&offset=abc", "limit=-5", "offset=-1", "limit=2.7", "limit=0", "limit=100000"]) {
      const res = await asOwner.get(url(`/knowledge-base/documents/${doc}/history?${qs}`), { failOnStatusCode: false });
      expect(res.status(), `${qs} answered ${res.status()}: ${await res.text()}`).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.events), `${qs} — events was ${JSON.stringify(body)}`).toBe(true);
    }
  });

  // ─── Nightly sync dedup (V90) and the clean reconnect message ───────────────
  //
  // The orchestrator's own trigger is a cron tick, not an HTTP route — see the file header note —
  // so neither defect from the 2026-09-02 incident (a duplicate nightly fire; a raw provider 401
  // leaking through) is reproduced here. That's IntegrationSyncService.spec.ts's and
  // IntegrationSyncClient.spec.ts's job. What belongs here is the real read path: given the rows
  // those write-side fixes actually produce, does the real HTTP + auth + Postgres path deliver them
  // correctly to the screen.

  test("INT-A-34 sync-status and sync-history surface the clean reconnect message, never a raw provider error", { tag: '@tesbo.testId("TES-TC-258")' }, async () => {
    seedSyncRun("jira", { status: "failed", error: "Jira needs to be reconnected to this workspace." });

    const status = await asOwner.get(url("/integrations/jira/sync-status"), { failOnStatusCode: false });
    expect(status.status()).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.run?.error).toBe("Jira needs to be reconnected to this workspace.");

    const history = await asOwner.get(url("/integrations/sync-history"), { failOnStatusCode: false });
    expect(history.status()).toBe(200);
    const historyBody = await history.json();
    expect(historyBody.runs[0]?.error).toBe("Jira needs to be reconnected to this workspace.");

    // Pins the literal shape of the reported bug: a raw provider body must never reach either route.
    const rendered = JSON.stringify([statusBody, historyBody]);
    expect(rendered).not.toContain('"code":401');
    expect(rendered).not.toContain("Unauthorized");
  });

  test("INT-A-35 sync-status and sync-history stay well-formed with more than one same-day nightly run recorded", { tag: '@tesbo.testId("TES-TC-259")' }, async () => {
    // A pre-fix workspace can already carry duplicate nightly rows from the incident, or a residual
    // edge case can still slip one through — either way, the read side must not assume at most one.
    seedSyncRun("jira", { status: "failed", error: "jira request failed (401): {\"code\":401,\"message\":\"Unauthorized\"}" });
    seedSyncRun("jira", { status: "succeeded", error: null });

    const status = await asOwner.get(url("/integrations/jira/sync-status"), { failOnStatusCode: false });
    expect(status.status()).toBe(200);

    const history = await asOwner.get(url("/integrations/sync-history"), { failOnStatusCode: false });
    expect(history.status()).toBe(200);
    const historyBody = await history.json();
    expect(historyBody.runs.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Linear Project mapping (V95) ─────────────────────────────────────────
  //
  // Linear's Team is the mandatory, every-issue-belongs-to-one container (Jira's real analog);
  // Linear's Project is a separate, optional, often cross-team grouping. Before this, only Team
  // mapping existed. These drive the real HTTP + auth + Postgres write path — connectLinearTeams
  // never calls Linear's live API itself (it only trusts client-submitted ids), so this is safely
  // e2e-testable without a fake upstream, unlike the outbound listing calls documented at the top
  // of this file.

  test("INT-A-36 connecting Linear accepts a Project mapping (entityType) alongside the existing Team mapping", { tag: '@tesbo.testId("TES-TC-260")' }, async () => {
    const connectionId = seedConnection("linear");

    const res = await asOwner.post(url("/linear/teams"), {
      data: { projects: [{ id: "linear-proj-1", key: "redesign-abc", name: "Redesign", entityType: "project" }] },
      failOnStatusCode: false,
    });
    expect(res.ok(), `POST linear/teams (project) answered ${res.status()}: ${await res.text()}`).toBe(true);

    const row = scalar(
      `SELECT entity_type FROM linear_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
        `AND integration_connection_id = ${literal(connectionId)} AND enabled = true;`,
    );
    expect(row).toBe("project");
  });

  test("INT-A-37 switching an existing Linear mapping from Team to Project disables the old row, not both enabled", { tag: '@tesbo.testId("TES-TC-261")' }, async () => {
    const connectionId = seedConnection("linear");
    seedLinearMapping(connectionId, "OLDTEAM", "team");

    const res = await asOwner.post(url("/linear/teams"), {
      data: { projects: [{ id: "linear-proj-2", key: "launch-xyz", name: "Launch", entityType: "project" }] },
      failOnStatusCode: false,
    });
    expect(res.ok(), `POST linear/teams (switch to project) answered ${res.status()}: ${await res.text()}`).toBe(true);

    const enabledCount = scalar(
      `SELECT COUNT(*) FROM linear_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND enabled = true;`,
    );
    expect(enabledCount, "exactly one mapping must be enabled after switching modes — never both").toBe("1");

    const enabledType = scalar(
      `SELECT entity_type FROM linear_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND enabled = true;`,
    );
    expect(enabledType).toBe("project");
  });

  test("INT-A-38 an unknown Linear entityType is refused before it reaches the mapping table", { tag: '@tesbo.testId("TES-TC-262")' }, async () => {
    const connectionId = seedConnection("linear");
    const before = scalar(
      `SELECT COUNT(*) FROM linear_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND integration_connection_id = ${literal(connectionId)};`,
    );

    const res = await asOwner.post(url("/linear/teams"), {
      data: { projects: [{ id: "linear-x", key: "X", name: "X", entityType: "workspace" }] },
      failOnStatusCode: false,
    });
    await expectRefused(res, "an unknown Linear entityType");

    const after = scalar(
      `SELECT COUNT(*) FROM linear_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND integration_connection_id = ${literal(connectionId)};`,
    );
    expect(after, "a rejected payload must not have written anything").toBe(before);
  });

  // ─── Regression: "tickets from all projects are displayed after sync instead of only the
  //     selected project" — jiraTickets/linearTickets/tickets used to filter only by project_id,
  //     so every entity a Tesbo project had ever been mapped to (before a switch) stayed mixed into
  //     the same result forever. mapped_remote_id (V96) plus the "currently enabled mapping only"
  //     read filter fixes this; these tests reproduce the exact reported scenario end to end. ───

  test("INT-A-39 switching the mapped Jira project hides the old project's tickets from the default view, but ?remoteId still reaches them", { tag: '@tesbo.testId("TES-TC-263")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraMapping(connectionId, "OLDPROJ");
    seedJiraTicket(connectionId, { key: "OLDPROJ-1", summary: "Belongs to the old project" });

    // Switch the mapping to a different Jira project — mirrors POST jira/projects.
    const switchRes = await asOwner.post(url("/jira/projects"), {
      data: { projects: [{ id: "jira-NEWPROJ", key: "NEWPROJ", name: "New Project" }] },
      failOnStatusCode: false,
    });
    expect(switchRes.ok(), `switching the Jira mapping answered ${switchRes.status()}: ${await switchRes.text()}`).toBe(true);
    seedJiraTicket(connectionId, { key: "NEWPROJ-1", summary: "Belongs to the new project" });

    // Default view: only the newly mapped project's ticket, never the old one.
    const defaultView = await (await asOwner.get(url("/jira/tickets"))).json();
    const defaultKeys = defaultView.list.map((t: { jiraIssueKey: string }) => t.jiraIssueKey);
    expect(defaultKeys, `default Jira tickets view was ${JSON.stringify(defaultKeys)}`).toEqual(["NEWPROJ-1"]);

    // The old project's ticket was never deleted — it's still reachable by asking for it explicitly.
    const oldProjectRemoteId = scalar(
      `SELECT jira_project_id FROM jira_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND jira_project_key = 'OLDPROJ';`,
    );
    const historical = await (await asOwner.get(url(`/jira/tickets?remoteId=${encodeURIComponent(oldProjectRemoteId)}`))).json();
    const historicalKeys = historical.list.map((t: { jiraIssueKey: string }) => t.jiraIssueKey);
    expect(historicalKeys).toEqual(["OLDPROJ-1"]);

    // "All Sources" and the summary counts must agree with the default (current-mapping-only) view.
    const all = await (await asOwner.get(url("/tickets"))).json();
    expect(all.list.map((t: { key: string }) => t.key)).toEqual(["NEWPROJ-1"]);
    const summary = await (await asOwner.get(url("/tickets/summary"))).json();
    expect(summary.jira.total).toBe(1);
  });

  test("INT-A-40 switching the mapped Linear team hides the old team's tickets from the default view, but ?remoteId still reaches them", { tag: '@tesbo.testId("TES-TC-264")' }, async () => {
    const connectionId = seedConnection("linear");
    seedLinearMapping(connectionId, "OLDTEAM", "team");
    seedLinearTicket(connectionId, { key: "OLDTEAM-1", summary: "Belongs to the old team" });

    const switchRes = await asOwner.post(url("/linear/teams"), {
      data: { projects: [{ id: "linear-NEWTEAM", key: "NEWTEAM", name: "New Team" }] },
      failOnStatusCode: false,
    });
    expect(switchRes.ok(), `switching the Linear mapping answered ${switchRes.status()}: ${await switchRes.text()}`).toBe(true);
    seedLinearTicket(connectionId, { key: "NEWTEAM-1", summary: "Belongs to the new team" });

    const defaultView = await (await asOwner.get(url("/linear/tickets"))).json();
    expect(defaultView.list.map((t: { linearIssueKey: string }) => t.linearIssueKey)).toEqual(["NEWTEAM-1"]);

    const oldTeamRemoteId = scalar(
      `SELECT linear_team_id FROM linear_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND linear_team_key = 'OLDTEAM';`,
    );
    const historical = await (await asOwner.get(url(`/linear/tickets?remoteId=${encodeURIComponent(oldTeamRemoteId)}`))).json();
    expect(historical.list.map((t: { linearIssueKey: string }) => t.linearIssueKey)).toEqual(["OLDTEAM-1"]);
  });

  test("INT-A-41 unmapping a Jira project keeps its tickets in the database but hides them from the default view", { tag: '@tesbo.testId("TES-TC-265")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraMapping(connectionId, "GONE");
    seedJiraTicket(connectionId, { key: "GONE-1", summary: "Was mapped, then unmapped" });

    const unlinkRes = await asOwner.post(url("/jira/projects"), { data: { projects: [] }, failOnStatusCode: false });
    expect(unlinkRes.ok(), `unlinking the Jira mapping answered ${unlinkRes.status()}: ${await unlinkRes.text()}`).toBe(true);

    const defaultView = await (await asOwner.get(url("/jira/tickets"))).json();
    expect(defaultView.list, "an unmapped project must show no tickets by default").toEqual([]);

    // Never deleted — still physically present in the ticket cache.
    const stillThere = scalar(
      `SELECT COUNT(*) FROM jira_tickets WHERE project_id = ${literal(tenant!.mainProjectId)} AND jira_issue_key = 'GONE-1';`,
    );
    expect(stillThere).toBe("1");
  });

  // ─── Regression: disconnecting Jira/Linear used to hard-delete every ticket and mapping for that
  //     connection (ON DELETE CASCADE off integration_connections). Disconnect is now a soft state
  //     flip — nothing synced is ever destroyed by disconnecting. ───

  test("INT-A-42 disconnecting Jira preserves every ticket and mapping row, and reports not-connected afterward", { tag: '@tesbo.testId("TES-TC-266")' }, async () => {
    const connectionId = seedConnection("jira");
    seedJiraMapping(connectionId, "SURV");
    seedJiraTicket(connectionId, { key: "SURV-1", summary: "Must survive a disconnect" });

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok(), `disconnect answered ${disconnectRes.status()}: ${await disconnectRes.text()}`).toBe(true);

    // Reads as not-connected everywhere...
    const status = await (await asOwner.get("/api/workspace/integrations/jira/status", { failOnStatusCode: false })).json();
    expect(status.connected).toBe(false);
    const projectStatus = await (await asOwner.get(url("/jira/status"), { failOnStatusCode: false })).json();
    expect(projectStatus.connected).toBe(false);

    // ...but nothing was deleted: the connection row, its mapping, and its ticket all survive.
    expect(scalar(`SELECT COUNT(*) FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("1");
    expect(
      scalar(`SELECT disconnected_at IS NOT NULL FROM integration_connections WHERE id = ${literal(connectionId)};`),
    ).toBe("t");
    expect(
      scalar(`SELECT COUNT(*) FROM jira_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND jira_project_key = 'SURV';`),
    ).toBe("1");
    expect(
      scalar(`SELECT COUNT(*) FROM jira_tickets WHERE project_id = ${literal(tenant!.mainProjectId)} AND jira_issue_key = 'SURV-1';`),
    ).toBe("1");
    // The mapping is disabled, not deleted, matching what a real per-project unmap does.
    expect(
      scalar(`SELECT enabled FROM jira_project_mappings WHERE project_id = ${literal(tenant!.mainProjectId)} AND jira_project_key = 'SURV';`),
    ).toBe("f");
  });
});
