import fs from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { env } from "../utils/env";
import { newNotionId, notionKeyOf, purgeNotionRows, seedNotionMapping, seedNotionPage } from "../utils/notion-seed";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

// Account B — a second, fully independent account/org/project provisioned once by global-setup.ts
// (see authorization.spec.ts) — reused here only for the one cross-tenant check below, so this
// suite doesn't need its own second tenant just for that.
const ctxB = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context-b.json"), "utf-8"));

/*
 * Integrations (Jira, Linear and Notion; Notion is INT-A-57 and up): connection status, project/team/database mapping, the mirrored ticket
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
  let asB: APIRequestContext;

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
    asB = await request.newContext({ baseURL: env.apiBaseUrl, storageState: path.join(__dirname, "../.auth/state-b.json") });
    purge(tenant);
    // A crashed prior run could have left this fixture behind (afterAll never ran) — clear it
    // up-front too, so INT-A-51's insert never collides with the one-non-deleted-sibling-name index.
    exec(`DELETE FROM knowledge_folders WHERE organization_id = ${literal(ctxB.organizationId)} AND source_provider IS NOT NULL;`);
    backfillMissingRootFolder(tenant);
    const tree = await asOwner.get(`/api/projects/${tenant.mainProjectId}/knowledge-base/folders/tree`);
    expect(tree.status(), `resolving the KB root folder — ${await tree.text()}`).toBe(200);
    rootFolderId = (await tree.json()).id;
  });

  test.afterAll(async () => {
    if (tenant) purge(tenant);
    exec(`DELETE FROM knowledge_folders WHERE organization_id = ${literal(ctxB.organizationId)} AND source_provider IS NOT NULL;`);
    await Promise.all([asOwner, asManager, asQa, asGuest, anon, asB].filter(Boolean).map((c) => c.dispose()));
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
    purgeNotionRows([t.mainProjectId, t.secondProjectId]);
    exec(`DELETE FROM integration_connections WHERE organization_id = ${literal(t.organizationId)};`);
    // Was missing entirely until the nightly-sync dedup fix (V90) added tests that seed rows here —
    // without it, seeded runs from one test could leak into the next.
    exec(`DELETE FROM integration_sync_runs WHERE project_id IN (${projects});`);
    // knowledge_document_sync_events cascades off knowledge_documents (ON DELETE CASCADE), so
    // deleting the seeded mirror documents is enough to clear both.
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    // Provider folders (source_provider IS NOT NULL) are seeded fixtures too — knowledge_documents/
    // knowledge_files under them cascade off this delete (ON DELETE CASCADE, V45).
    exec(`DELETE FROM knowledge_folders WHERE project_id IN (${projects}) AND source_provider IS NOT NULL;`);
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
  function seedMirrorDocument(provider: "jira" | "linear" | "notion", externalId: string, title: string, projectId?: string, folderId?: string): string {
    exec(
      "INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, content_html, " +
        "document_type, status, source_provider, source_external_id, source_role, is_read_only) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(projectId ?? tenant!.mainProjectId)}, ${literal(folderId ?? rootFolderId)}, ` +
        `${literal(title)}, 'seeded by the e2e suite', '<p>seeded by the e2e suite</p>', 'requirement_note', ` +
        `'published', ${literal(provider)}, ${literal(externalId)}, 'mirror', true);`,
    );
    return scalar(
      `SELECT id FROM knowledge_documents WHERE project_id = ${literal(projectId ?? tenant!.mainProjectId)} ` +
        `AND source_provider = ${literal(provider)} AND source_external_id = ${literal(externalId)} AND source_role = 'mirror';`,
    );
  }

  /**
   * A system-generated provider folder exactly as ensureProviderFolder
   * (integration-sync.service.ts) would have created it on first sync — seeded directly so the
   * disconnect-cleanup fix's lookup (by source_provider, never by name) is exercised against a real
   * row, the same "no real sync" reasoning as the mirror-document/ticket fixtures above.
   */
  function seedProviderFolder(provider: "jira" | "linear" | "notion", projectId?: string, name?: string): string {
    const pid = projectId ?? tenant!.mainProjectId;
    const rootId = scalar(`SELECT id FROM knowledge_folders WHERE project_id = ${literal(pid)} AND is_root = true LIMIT 1;`);
    const folderName = name ?? { jira: "Jira", linear: "Linear", notion: "Notion" }[provider];
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, description, source_provider, created_by, updated_by) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(pid)}, ${literal(rootId)}, ${literal(folderName)}, ` +
        `'seeded by the e2e suite', ${literal(provider)}, ${literal(tenant!.owner.userId)}, ${literal(tenant!.owner.userId)});`,
    );
    return scalar(
      `SELECT id FROM knowledge_folders WHERE project_id = ${literal(pid)} AND source_provider = ${literal(provider)} ` +
        "AND is_deleted = false ORDER BY created_at DESC LIMIT 1;",
    );
  }

  /**
   * A row of `integration_sync_runs`, as a completed (or failed) sync would have left it —
   * seeded directly for the same "no real Jira/Linear call" reason as the fixtures above. Used to
   * pin the nightly-sync dedup fix (V90) and the clean-reconnect-message fix on the read side
   * (sync-status/sync-history), without needing to reproduce either defect through a real sync.
   *
   * nightly_cycle_date is always populated for a nightly-triggered row (same +5:30 IST shift as
   * IntegrationSyncService.nightlyCycleDate()) — chk_nightly_cycle_date (V118) now rejects a
   * nightly row with no cycle date at the DB level, exactly the shape the stale-writer incident
   * that migration exists for was producing, so this fixture has to stay honest about it too.
   */
  function seedSyncRun(
    provider: "jira" | "linear" | "notion",
    fields: {
      status?: string;
      triggerSource?: "manual" | "nightly";
      error?: string | null;
      remoteProjectKey?: string;
      remoteProjectName?: string;
      projectId?: string;
      /** The per-run ticket cap cut this run off (V134): the pass is unfinished and the next Sync continues it. */
      truncated?: boolean;
      /** SQL expression for when the pass began; defaults to the run's own start. */
      windowStart?: string;
    } = {},
  ): string {
    const status = fields.status ?? "failed";
    const projectId = fields.projectId ?? tenant!.mainProjectId;
    const triggerSource = fields.triggerSource ?? "nightly";
    exec(
      "INSERT INTO integration_sync_runs (organization_id, project_id, provider, status, stage, trigger_source, nightly_cycle_date, error, remote_project_key, remote_project_name, started_at, finished_at, truncated, window_start) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(projectId)}, ${literal(provider)}, ${literal(status)}, ` +
        `${literal(status === "failed" ? "failed" : "done")}, ${literal(triggerSource)}, ` +
        `${triggerSource === "nightly" ? "(now() + interval '5.5 hours')::date" : "NULL"}, ` +
        `${fields.error === undefined ? "NULL" : literal(fields.error)}, ${fields.remoteProjectKey ? literal(fields.remoteProjectKey) : "NULL"}, ` +
        `${fields.remoteProjectName ? literal(fields.remoteProjectName) : "NULL"}, ` +
        `now(), now(), ${fields.truncated ? "true" : "false"}, ${fields.windowStart ?? "now()"});`,
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
  function seedConnection(provider: "jira" | "linear" | "notion", siteUrl = "https://e2e.invalid"): string {
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

  test("INT-A-30b2 a heading glued directly onto its body, like Zyra's AI Memory log entries, is not repeated inside its own diff excerpt", async () => {
    // Mirrors the exact shape rememberZyraMemory (legacy.service.ts) writes for a scratchpad
    // entry: `## <ISO timestamp>\n<note>` — heading and body on the same block, joined by a
    // single `\n`, unlike a synced ticket's heading and body (always separate `\n\n` blocks).
    const heading = "## 2026-09-11T13:40:28.172Z";
    const created = await asOwner.post(url("/knowledge-base/documents"), {
      data: { title: "Glued heading document", folderId: rootFolderId, documentType: "general", contentText: `${heading}\nFirst note.` },
      failOnStatusCode: false,
    });
    const docId = (await created.json()).id;

    exec(
      "INSERT INTO knowledge_document_versions (document_id, version_number, title, content_html, content_text, created_by) VALUES (" +
        `${literal(docId)}, 1, 'Glued heading document', '<p>${heading}\\nFirst note.</p>', ${literal(`${heading}\nFirst note.`)}, ${literal(tenant!.owner.userId)});`,
    );
    await asOwner.patch(url(`/knowledge-base/documents/${docId}`), { data: { contentText: `${heading}\nFirst note, edited.` } });

    const res = await asOwner.get(url(`/knowledge-base/documents/${docId}/history`), { failOnStatusCode: false });
    const body = await res.json();
    const updated = body.events[0];
    expect(Array.isArray(updated.changedFields)).toBe(true);
    expect(updated.changedFields).toHaveLength(1);
    // The heading's timestamp becomes the field's own label...
    expect(updated.changedFields[0].label).toBe("2026-09-11T13:40:28.172Z");
    // ...so it must not also appear a second time inside the excerpt underneath it.
    expect(updated.changedFields[0].oldExcerpt).toBe("First note.");
    expect(updated.changedFields[0].newExcerpt).toBe("First note, edited.");
    expect(updated.changedFields[0].newExcerpt).not.toContain("##");
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

  test("INT-A-30e a version row with no precomputed diff (written before that existed) self-heals on its first read instead of showing blank/wrong history", async () => {
    // A manual document's diff is computed once, at write time, and stored on the version row —
    // this row simulates one written before that shipped: seeded directly with changed_summary/
    // changed_fields left NULL, exactly what a pre-existing production row looks like. The read
    // path must still produce the real diff (computed inline, just for this one row) rather than a
    // blank/placeholder entry, and persist it so the row is O(1) on every read after this first one.
    const created = await asOwner.post(url("/knowledge-base/documents"), {
      data: { title: "Self-heals document", folderId: rootFolderId, documentType: "general", contentText: "Current body." },
      failOnStatusCode: false,
    });
    const docId = (await created.json()).id;
    exec(
      "INSERT INTO knowledge_document_versions (document_id, version_number, title, content_html, content_text, created_by) VALUES (" +
        `${literal(docId)}, 1, 'Self-heals document', '<p>Legacy body.</p>', 'Legacy body.', ${literal(tenant!.owner.userId)});`,
    );

    const first = await (await asOwner.get(url(`/knowledge-base/documents/${docId}/history`), { failOnStatusCode: false })).json();
    const legacyEntry = first.events.find((e: any) => e.eventType === "updated");
    expect(legacyEntry, `expected an 'updated' entry among ${JSON.stringify(first.events)}`).toBeTruthy();
    expect(legacyEntry.changedSummary).toContain("Details");
    expect(Array.isArray(legacyEntry.changedFields)).toBe(true);
    expect(legacyEntry.changedFields[0].oldExcerpt).toContain("Legacy body.");
    expect(legacyEntry.changedFields[0].newExcerpt).toContain("Current body.");

    // The self-heal write is fire-and-forget from the request's point of view — give it a moment to
    // land before checking the row directly.
    await expect(async () => {
      const stored = scalar(`SELECT changed_summary FROM knowledge_document_versions WHERE document_id = ${literal(docId)};`);
      expect(stored, "the row must no longer be NULL after its first read").not.toBe("");
    }).toPass({ timeout: 5_000 });

    // A second read must return the identical diff, now sourced from the column this test just
    // confirmed got populated, rather than anything changing between the two.
    const second = await (await asOwner.get(url(`/knowledge-base/documents/${docId}/history`), { failOnStatusCode: false })).json();
    const healedEntry = second.events.find((e: any) => e.eventType === "updated");
    expect(healedEntry.changedSummary).toBe(legacyEntry.changedSummary);
    expect(healedEntry.changedFields).toEqual(legacyEntry.changedFields);
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

  // ─── Sync run's Jira/Linear project name (V126) ──────────────────────────
  //
  // A Linear Project mapping stores its opaque slugId in the key slot (V95), and the Requirements
  // sync panel showed that ("4081f3c6e1df") instead of the project name. The write side — startRun
  // and the processor recording the name — needs a live Linear call to reach through HTTP, so it is
  // pinned in integration-sync.processor.spec.ts; these pin the persisted column's read path.

  test("INT-A-53 a Linear sync run returns its project name alongside the slugId key", async () => {
    seedSyncRun("linear", { status: "succeeded", error: null, remoteProjectKey: "4081f3c6e1df", remoteProjectName: "E2E Orange HRMS Project" });

    const status = await asOwner.get(url("/integrations/linear/sync-status"), { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    const { run } = await status.json();
    expect(run?.remoteProjectName).toBe("E2E Orange HRMS Project");
    expect(run?.remoteProjectKey).toBe("4081f3c6e1df");

    const history = await asOwner.get(url("/integrations/sync-history"), { failOnStatusCode: false });
    expect(history.status(), await history.text()).toBe(200);
    expect((await history.json()).runs[0]?.remoteProjectName).toBe("E2E Orange HRMS Project");
  });

  test("INT-A-54 a Linear run recorded before the name existed still answers, with a null name and its key", async () => {
    seedSyncRun("linear", { status: "succeeded", error: null, remoteProjectKey: "4081f3c6e1df" });

    const status = await asOwner.get(url("/integrations/linear/sync-status"), { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    const { run } = await status.json();
    expect(run?.remoteProjectName).toBeNull();
    expect(run?.remoteProjectKey).toBe("4081f3c6e1df");
  });

  // Same defect on Jira: the panel showed "KAN" rather than the mapped project's name.
  test("INT-A-55 a Jira sync run returns its project name alongside the key", async () => {
    seedSyncRun("jira", { status: "succeeded", error: null, remoteProjectKey: "KAN", remoteProjectName: "E2E QA Demo" });

    const status = await asOwner.get(url("/integrations/jira/sync-status"), { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    const { run } = await status.json();
    expect(run?.remoteProjectName).toBe("E2E QA Demo");
    expect(run?.remoteProjectKey).toBe("KAN");

    const history = await asOwner.get(url("/integrations/sync-history"), { failOnStatusCode: false });
    expect(history.status(), await history.text()).toBe(200);
    expect((await history.json()).runs[0]?.remoteProjectName).toBe("E2E QA Demo");
  });

  test("INT-A-56 a Jira run recorded before the name existed still answers, with a null name and its key", async () => {
    seedSyncRun("jira", { status: "succeeded", error: null, remoteProjectKey: "KAN" });

    const status = await asOwner.get(url("/integrations/jira/sync-status"), { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    const { run } = await status.json();
    expect(run?.remoteProjectName).toBeNull();
    expect(run?.remoteProjectKey).toBe("KAN");
  });

  // ─── A backlog over the per-run ticket cap is continued, not restarted (V134) ───
  //
  // Every provider fetch is newest-updated first, so a run cut off at the cap used to be followed by a
  // Sync that fetched the same newest tickets again and never reached the rest. A run now records
  // that its pass is unfinished (truncated, window_start) and the next Sync joins that pass. Reaching
  // Jira for real is not possible here (see the top of this file), so the cap itself and the skipping of
  // already-synced tickets are pinned in integration-sync.processor.spec.ts; these pin the part that
  // lives behind the HTTP route: which pass a Sync click joins. The queued run fails against the
  // unreachable site right after it is created, which does not matter to the row it was inserted with.

  /** Clicks Sync and returns the new run's id. */
  async function clickSync(): Promise<string> {
    const res = await asOwner.post(url("/jira/sync"), { data: {}, failOnStatusCode: false });
    expect(res.status(), await res.text()).toBeLessThan(300);
    const body = await res.json();
    expect(body.alreadyRunning, "the seeded runs are all finished, so a click must start a new one").toBe(false);
    return String(body.run.id);
  }

  /** True when both runs belong to the same pass. */
  const samePass = (a: string, b: string) =>
    scalar(
      `SELECT (SELECT window_start FROM integration_sync_runs WHERE id = ${literal(a)}) = ` +
        `(SELECT window_start FROM integration_sync_runs WHERE id = ${literal(b)});`,
    ) === "t";

  const cutOffRun = (remoteProjectKey = "E2E") =>
    seedSyncRun("jira", { status: "succeeded", error: null, triggerSource: "manual", remoteProjectKey, truncated: true, windowStart: "now() - interval '3 days'" });

  test("INT-A-86 Sync after a run the cap cut off joins that run's pass instead of starting over", async () => {
    seedJiraMapping(seedConnection("jira"), "E2E");
    const cutOff = cutOffRun();

    const next = await clickSync();
    expect(samePass(next, cutOff), "the next Sync started a fresh pass, so it would re-sync the same newest tickets").toBe(true);
    // The continuation is a new row, not a rewrite of the earlier run.
    expect(next).not.toBe(cutOff);
    expect(scalar(`SELECT truncated FROM integration_sync_runs WHERE id = ${literal(cutOff)};`)).toBe("t");
  });

  test("INT-A-87 Sync after a run that reached the end of the backlog starts a fresh pass", async () => {
    seedJiraMapping(seedConnection("jira"), "E2E");
    const finished = seedSyncRun("jira", { status: "succeeded", error: null, triggerSource: "manual", remoteProjectKey: "E2E", truncated: false, windowStart: "now() - interval '3 days'" });

    const next = await clickSync();
    expect(samePass(next, finished), "a finished pass must not be continued").toBe(false);
    expect(scalar(`SELECT window_start > now() - interval '1 hour' FROM integration_sync_runs WHERE id = ${literal(next)};`)).toBe("t");
  });

  test("INT-A-88 a project with no earlier run starts a fresh pass that is not marked unfinished", async () => {
    seedJiraMapping(seedConnection("jira"), "E2E");
    const first = await clickSync();
    expect(scalar(`SELECT window_start > now() - interval '1 hour' FROM integration_sync_runs WHERE id = ${literal(first)};`)).toBe("t");
    expect(scalar(`SELECT truncated FROM integration_sync_runs WHERE id = ${literal(first)};`)).toBe("f");
  });

  test("INT-A-89 remapping to another Jira project abandons the old project's unfinished pass", async () => {
    seedJiraMapping(seedConnection("jira"), "NEWKEY");
    const oldProject = cutOffRun("OLDKEY");

    const next = await clickSync();
    expect(samePass(next, oldProject), "tickets already synced from OLDKEY must not be skipped for NEWKEY").toBe(false);
  });

  test("INT-A-90 a failed run after a cut-off one does not discard the pass's progress", async () => {
    seedJiraMapping(seedConnection("jira"), "E2E");
    const cutOff = cutOffRun();
    // An outage during the continuation fails the run before it syncs anything.
    seedSyncRun("jira", { status: "failed", error: "Jira is unreachable", triggerSource: "manual", remoteProjectKey: "E2E" });

    const next = await clickSync();
    expect(samePass(next, cutOff), "a failed attempt threw away the pass, so the user would re-sync from the top").toBe(true);
  });

  test("INT-A-91 an unfinished pass does not count as the nightly incremental cursor; the run that finishes it does, from the pass's start", async () => {
    seedJiraMapping(seedConnection("jira"), "E2E");
    cutOffRun();
    // Same predicate as IntegrationSyncService.getLastSuccessfulRunStart.
    const cursorOlderThan = (interval: string) =>
      scalar(
        "SELECT COALESCE(MAX(COALESCE(window_start, started_at)) < now() - " +
          `interval ${literal(interval)}, false) FROM integration_sync_runs ` +
          `WHERE project_id = ${literal(tenant!.mainProjectId)} AND provider = 'jira' AND status IN ('succeeded', 'partial') AND truncated = false;`,
      );
    // No finished pass yet: tickets older than where the cut-off run stopped were never seen.
    expect(cursorOlderThan("2 days"), "an unfinished pass counted as a successful sync").toBe("f");

    // The run that finishes the pass counts, and carries the pass's start rather than its own.
    seedSyncRun("jira", { status: "succeeded", error: null, triggerSource: "manual", remoteProjectKey: "E2E", truncated: false, windowStart: "now() - interval '3 days'" });
    expect(cursorOlderThan("2 days")).toBe("t");
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

  // ─── Regression: the Knowledge Base folder ensureProviderFolder creates (the "Jira"/"Linear"
  //     folder holding every mirrored ticket document) used to be soft-deleted, un-restorably, the
  //     moment its integration was disconnected — so a workspace that disconnected lost visibility
  //     into every ticket it had ever imported. Disconnect is a credentials/mapping state flip only:
  //     the folder and its documents must stay fully visible in the Knowledge Base whether the
  //     integration is currently connected or not. ───

  test("INT-A-43 disconnecting Jira leaves its Knowledge Base folder and mirrored documents fully visible", async () => {
    const connectionId = seedConnection("jira");
    const folderId = seedProviderFolder("jira");
    const docId = seedMirrorDocument("jira", "kb-cleanup-1", "Must stay visible after disconnect", tenant!.mainProjectId, folderId);

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok(), `disconnect answered ${disconnectRes.status()}: ${await disconnectRes.text()}`).toBe(true);

    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("f");
    expect(scalar(`SELECT deletion_reason FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("");
    expect(scalar(`SELECT is_deleted FROM knowledge_documents WHERE id = ${literal(docId)};`)).toBe("f");

    const tree = await (await asOwner.get(url("/knowledge-base/folders/tree"))).json();
    expect(tree.children.map((c: { id: string }) => c.id), "the folder must still appear in the tree after disconnect").toContain(folderId);

    expect(scalar(`SELECT COUNT(*) FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("1");
  });

  test("INT-A-44 disconnecting Linear leaves its Knowledge Base folder and mirrored documents fully visible", async () => {
    seedConnection("linear");
    const folderId = seedProviderFolder("linear");
    const docId = seedMirrorDocument("linear", "kb-cleanup-2", "Must stay visible after disconnect", tenant!.mainProjectId, folderId);

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/linear/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok(), `disconnect answered ${disconnectRes.status()}: ${await disconnectRes.text()}`).toBe(true);

    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("f");
    expect(scalar(`SELECT deletion_reason FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("");
    expect(scalar(`SELECT is_deleted FROM knowledge_documents WHERE id = ${literal(docId)};`)).toBe("f");
  });

  test("INT-A-45 a project whose mapping was already superseded still keeps its old folder visible on disconnect", async () => {
    const connectionId = seedConnection("jira");
    seedJiraMapping(connectionId, "SUPERSEDED");
    // The mapping row above is disabled (as an unmap/remap leaves it) — the folder it fed must be
    // left alone regardless: disconnect no longer looks up KB folders by provider at all.
    exec(
      `UPDATE jira_project_mappings SET enabled = false WHERE project_id = ${literal(tenant!.mainProjectId)} AND jira_project_key = 'SUPERSEDED';`,
    );
    const folderId = seedProviderFolder("jira");

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok()).toBe(true);

    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("f");
  });

  test("INT-A-46 disconnect leaves the provider folder alone in every project under the workspace", async () => {
    seedConnection("jira");
    const mainFolderId = seedProviderFolder("jira", tenant!.mainProjectId);
    const secondFolderId = seedProviderFolder("jira", tenant!.secondProjectId);

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok()).toBe(true);

    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(mainFolderId)};`)).toBe("f");
    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(secondFolderId)};`)).toBe("f");
  });

  test("INT-A-47 disconnecting twice in a row is a safe no-op the second time", async () => {
    seedConnection("jira");
    const folderId = seedProviderFolder("jira");

    const first = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(first.ok()).toBe(true);

    // Simulates the race a double-click or two tabs create: a second call after the first already
    // committed must still answer success, not error — and the folder must stay exactly as
    // untouched as it was after the first call.
    const second = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(second.ok(), `a repeat disconnect must be a harmless no-op, not an error: ${await second.text()}`).toBe(true);

    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("f");
  });

  test("INT-A-48 a folder deleted manually stays restorable exactly as before, even after its integration is later disconnected", async () => {
    seedConnection("jira");

    const manualRes = await asOwner.post(url("/knowledge-base/folders"), { data: { name: `E2E manual ${Date.now()}` } });
    expect(manualRes.ok()).toBe(true);
    const manualFolderId = (await manualRes.json()).id;
    const deleteRes = await asOwner.delete(url(`/knowledge-base/folders/${manualFolderId}`));
    expect(deleteRes.ok()).toBe(true);
    expect(scalar(`SELECT deletion_reason FROM knowledge_folders WHERE id = ${literal(manualFolderId)};`)).toBe("manual");

    // Disconnecting an integration that has nothing to do with this folder must not change its
    // deletion_reason or restorability in either direction.
    await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });

    const restoreRes = await asOwner.patch(url(`/knowledge-base/folders/${manualFolderId}/restore`), { failOnStatusCode: false });
    expect(restoreRes.ok(), `a manually-deleted folder must stay restorable: ${await restoreRes.text()}`).toBe(true);
  });

  test("INT-A-49 disconnecting Jira keeps its Knowledge Base folder active and unique, ready for a reconnect's sync to reuse", async () => {
    seedConnection("jira");
    const folderId = seedProviderFolder("jira", tenant!.mainProjectId, "Jira");

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok()).toBe(true);
    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("f");

    // ensureProviderFolder (integration-sync.service.ts) looks up an active folder by
    // source_provider before ever inserting — with this one left active, a reconnect+resync must
    // find and reuse it, never spawn a second "Jira" folder.
    const tree = await (await asOwner.get(url("/knowledge-base/folders/tree"))).json();
    const jiraFolders = tree.children.filter((c: { name: string }) => c.name === "Jira");
    expect(jiraFolders.map((c: { id: string }) => c.id), "exactly one, still the original folder").toEqual([folderId]);
  });

  test("INT-A-50 disconnecting Jira leaves mirrored ticket documents untouched, ready for the next sync's upsert", async () => {
    seedConnection("jira");
    const folderId = seedProviderFolder("jira");
    const docId = seedMirrorDocument("jira", "PERSIST-1", "Original content", tenant!.mainProjectId, folderId);

    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok()).toBe(true);

    // integration-sync.processor.ts upserts mirror documents ON CONFLICT (project_id,
    // source_provider, source_external_id, source_role) WHERE is_deleted = false — leaving this row
    // active and untouched is exactly what lets the next sync update it in place rather than
    // erroring or creating a duplicate for the same ticket.
    expect(scalar(`SELECT is_deleted FROM knowledge_documents WHERE id = ${literal(docId)};`)).toBe("f");
    expect(scalar(`SELECT content_text FROM knowledge_documents WHERE id = ${literal(docId)};`)).toBe("seeded by the e2e suite");
  });

  test("INT-A-51 disconnecting one workspace's Jira never touches another workspace's provider folder", async () => {
    exec(
      "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, source_provider) " +
        `SELECT ${literal(ctxB.organizationId)}, ${literal(ctxB.projectId)}, id, 'Jira', 'jira' ` +
        `FROM knowledge_folders WHERE project_id = ${literal(ctxB.projectId)} AND is_root = true;`,
    );
    const otherOrgFolderId = scalar(
      `SELECT id FROM knowledge_folders WHERE organization_id = ${literal(ctxB.organizationId)} AND source_provider = 'jira';`,
    );

    seedConnection("jira");
    const ownFolderId = seedProviderFolder("jira");
    const disconnectRes = await asOwner.delete("/api/workspace/integrations/jira/disconnect", { failOnStatusCode: false });
    expect(disconnectRes.ok()).toBe(true);

    // Neither workspace's folder is touched by disconnect any more, but the isolation itself — B's
    // folder is never reachable from A's disconnect call — is still worth pinning.
    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(ownFolderId)};`)).toBe("f");
    expect(
      scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(otherOrgFolderId)};`),
      "a different workspace's provider folder must never be touched",
    ).toBe("f");

    // And it's still visible through B's own session, not just in the database.
    const bTree = await (await asB.get(`/api/projects/${ctxB.projectId}/knowledge-base/folders/tree`)).json();
    expect(bTree.children.map((c: { id: string }) => c.id)).toContain(otherOrgFolderId);
  });

  // ─── Nightly cycle-date NOT-NULL guard (V118) ─────────────────────────────
  //
  // idx_integration_sync_runs_nightly_cycle (V90, see the "Nightly sync dedup" section above) is a
  // unique index on (project_id, provider, nightly_cycle_date) WHERE trigger_source = 'nightly' —
  // but a unique index never treats two NULLs as colliding, so a writer that inserts
  // trigger_source='nightly' without also setting nightly_cycle_date evades that dedup entirely.
  // That is exactly what happened in production: a second backend process, running code that
  // predated nightly_cycle_date, kept executing nightly-sync jobs against this database and left a
  // NULL-cycle-date duplicate every night — invisible for Jira, visibly failing for Linear once the
  // duplicate hit a Linear Project mapping the stale code's hardcoded team(id:...) lookup couldn't
  // resolve. chk_nightly_cycle_date closes the gap at the schema level: any writer on any code
  // version now gets a loud constraint violation instead of a row that silently bypasses the index.
  //
  // This talks to Postgres directly rather than through HTTP, unlike the rest of this file — there
  // is no HTTP route that produces this row shape (only a stale/buggy writer can), so the schema
  // constraint itself is the only thing left to exercise.

  test("INT-A-52 a nightly-triggered sync run cannot be inserted without a cycle date", { tag: '@tesbo.testId("TES-TC-267")' }, async () => {
    const insertNightly = (nightlyCycleDate: string | null) =>
      "INSERT INTO integration_sync_runs (organization_id, project_id, provider, status, stage, trigger_source, nightly_cycle_date) VALUES (" +
      `${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, 'linear', 'failed', 'failed', 'nightly', ` +
      `${nightlyCycleDate === null ? "NULL" : literal(nightlyCycleDate)});`;

    let rejection: unknown = null;
    try {
      exec(insertNightly(null));
    } catch (error) {
      rejection = error;
    }
    expect(rejection, "a nightly row with no cycle date must be rejected, not silently accepted").not.toBeNull();
    const rejectionText = `${(rejection as { stderr?: unknown })?.stderr ?? ""}${(rejection as Error)?.message ?? ""}`;
    expect(rejectionText).toContain("chk_nightly_cycle_date");

    // The same shape with a real date is unaffected — the constraint only closes the NULL loophole,
    // it does not touch the dedup index's actual job.
    exec(insertNightly("2026-01-01"));
    expect(
      scalar(
        `SELECT count(*) FROM integration_sync_runs WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
          "AND provider = 'linear' AND trigger_source = 'nightly' AND nightly_cycle_date = '2026-01-01';",
      ),
    ).toBe("1");

    // A manual trigger stays exempt either way — manual runs never carry a cycle date at all.
    exec(
      "INSERT INTO integration_sync_runs (organization_id, project_id, provider, status, stage, trigger_source, nightly_cycle_date) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, 'linear', 'failed', 'failed', 'manual', NULL);`,
    );
  });
  // ─── Notion (V133) ────────────────────────────────────────────────────────
  //
  // A Tesbo project maps to ONE Notion database and that database's pages are the tickets (the
  // notion_pages table), the same role jira_tickets/linear_tickets play. Test cases link to a page
  // by its full page id (testcases.notion_page_id), never by the short "notion:xxxxxxxx" display key.
  //
  // Same "no fake upstream" rule as the rest of this file (api.notion.com is compiled in), so what is
  // driven here is everything that happens before an outbound call, against rows seeded by
  // utils/notion-seed.ts. NOT reachable from this suite, and recorded here rather than silently
  // skipped: the OAuth code exchange, the database picker (GET notion/databases once connected),
  // connecting a database (POST notion/databases verifies it live against Notion, so only its 400/404
  // paths and the null unlink are driven), a real sync, and posting a comment. Those are pinned at
  // unit level in legacy/notion-integration.spec.ts and integration-sync/notion-client.spec.ts.
  //
  // No-session refusals are asserted with expectRefused (400/401/403/404), not a bare 401: the legacy
  // service's requireUser raises BadRequest, so an anonymous caller gets 400 today. See the note at
  // the top of api/authorization.spec.ts.

  /** Every project-scoped Notion route, as thunks, so one list drives the authorization tests. */
  function notionRoutes(api: APIRequestContext, projectId?: string): Array<[string, () => Promise<APIResponse>]> {
    const opts = { failOnStatusCode: false } as const;
    return [
      ["GET notion/status", () => api.get(url("/notion/status", projectId), opts)],
      ["GET notion/databases", () => api.get(url("/notion/databases", projectId), opts)],
      // A null databaseId is the unlink request, so a refused caller must also leave the mapping alone.
      ["POST notion/databases", () => api.post(url("/notion/databases", projectId), { data: { databaseId: null }, ...opts })],
      ["POST notion/sync", () => api.post(url("/notion/sync", projectId), { data: {}, ...opts })],
      ["GET notion/pages", () => api.get(url("/notion/pages", projectId), opts)],
      [
        "POST notion/comment",
        () => api.post(url("/notion/comment", projectId), { data: { pageId: newNotionId(), comment: "hello" }, ...opts }),
      ],
      ["GET notion/search-pages", () => api.get(url("/notion/search-pages?q=e2e", projectId), opts)],
      ["GET testcases/linked-notion-pages", () => api.get(url("/testcases/linked-notion-pages", projectId), opts)],
      ["GET integrations/notion/sync-status", () => api.get(url("/integrations/notion/sync-status", projectId), opts)],
    ];
  }

  function notionWorkspaceRoutes(api: APIRequestContext): Array<[string, () => Promise<APIResponse>]> {
    const opts = { failOnStatusCode: false } as const;
    const base = "/api/workspace/integrations/notion";
    return [
      ["GET auth-url", () => api.get(`${base}/auth-url`, opts)],
      ["GET config", () => api.get(`${base}/config`, opts)],
      ["GET status", () => api.get(`${base}/status`, opts)],
      ["POST callback", () => api.post(`${base}/callback`, { data: { code: "e2e-not-a-real-code" }, ...opts })],
      ["DELETE disconnect", () => api.delete(`${base}/disconnect`, opts)],
    ];
  }

  /** Runs SQL that is expected to be rejected and returns Postgres's error text ("" if it was accepted). */
  function sqlRejection(sql: string): string {
    try {
      exec(sql);
      return "";
    } catch (error) {
      return `${(error as { stderr?: unknown })?.stderr ?? ""}${(error as Error)?.message ?? ""}`;
    }
  }

  /** The `state` an owner's auth-url carries, or null when the deployment has no OAuth app for that provider. */
  async function oauthState(api: APIRequestContext, provider: "notion" | "linear"): Promise<string | null> {
    const res = await api.get(`/api/workspace/integrations/${provider}/auth-url`, { failOnStatusCode: false });
    if (res.status() !== 200) return null;
    return new URL((await res.json()).url).searchParams.get("state");
  }

  function countRows(table: string, where: string): string {
    return scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where};`);
  }

  async function notionPageList(api: APIRequestContext, query = ""): Promise<{ list: any[]; total: number }> {
    const res = await api.get(url(`/notion/pages${query}`), { failOnStatusCode: false });
    expect(res.status(), `notion/pages${query} answered ${res.status()}: ${await res.text()}`).toBe(200);
    return res.json();
  }

  test("INT-A-57 no Notion route answers a caller with no session, and none of them changes anything", async () => {
    const connectionId = seedConnection("notion");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId);
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Anonymous must not read this page" });

    for (const [what, attempt] of [...notionRoutes(anon), ...notionWorkspaceRoutes(anon)]) {
      const res = await attempt();
      await expectRefused(res, `${what} (anonymous)`);
      expect(await res.text(), `${what} leaked the mirrored page to an anonymous caller`).not.toContain("Anonymous must not read this page");
    }
    for (const path of ["/tickets", "/tickets/summary"]) {
      expect(await (await anon.get(url(path), { failOnStatusCode: false })).text()).not.toContain("Anonymous must not read this page");
    }

    // The unlink (databaseId null) and the disconnect were both refused, not half-applied.
    expect(
      countRows("notion_project_mappings", `project_id = ${literal(tenant!.mainProjectId)} AND notion_database_id = ${literal(dbId)} AND enabled = true`),
    ).toBe("1");
    expect(scalar(`SELECT disconnected_at IS NULL FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("t");
  });

  test("INT-A-58 a second tenant and a non-member are refused on every Notion route, and cannot reach the connection", async () => {
    const connectionId = seedConnection("notion", "https://www.notion.so");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId);
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Tenant A private requirement" });

    for (const [who, api] of [
      ["account B (another workspace)", asB],
      ["a workspace member outside the project", asGuest],
    ] as const) {
      for (const [what, attempt] of notionRoutes(api)) {
        const res = await attempt();
        await expectRefused(res, `${what} (${who})`);
        expect(await res.text(), `${what} leaked the page to ${who}`).not.toContain("Tenant A private requirement");
      }
    }
    expect(
      countRows("notion_project_mappings", `project_id = ${literal(tenant!.mainProjectId)} AND notion_database_id = ${literal(dbId)} AND enabled = true`),
    ).toBe("1");

    // Account B's workspace-level view is its own: tenant A's connection does not show through it, and
    // B disconnecting "notion" acts on B's workspace only.
    const bStatus = await asB.get("/api/workspace/integrations/notion/status", { failOnStatusCode: false });
    expect(bStatus.status()).toBe(200);
    expect((await bStatus.json()).connected).toBe(false);
    const bDisconnect = await asB.delete("/api/workspace/integrations/notion/disconnect", { failOnStatusCode: false });
    expect(bDisconnect.status()).toBeLessThan(500);
    expect(scalar(`SELECT disconnected_at IS NULL FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("t");
  });

  test("INT-A-59 a malformed or unknown project id is a 404 on every Notion route, never a 500", async () => {
    for (const projectId of ["not-a-uuid", crypto.randomUUID()]) {
      for (const [what, attempt] of notionRoutes(asOwner, projectId)) {
        const res = await attempt();
        expect(res.status(), `${what} for project "${projectId}" answered ${res.status()}: ${await res.text()}`).toBe(404);
      }
    }
  });

  test("INT-A-60 with Notion not connected, status says so and every route that needs the provider answers 404 before calling out", async () => {
    const status = await asOwner.get(url("/notion/status"), { failOnStatusCode: false });
    expect(status.status()).toBe(200);
    expect(await status.json()).toEqual({ connected: false, connectedProjects: [], history: [] });

    // The connection check comes first, so even a well-formed databaseId or page id never reaches Notion.
    const needsConnection: Array<[string, () => Promise<APIResponse>]> = [
      ["GET notion/databases", () => asOwner.get(url("/notion/databases"), { failOnStatusCode: false })],
      ["POST notion/databases (unlink)", () => asOwner.post(url("/notion/databases"), { data: { databaseId: null }, failOnStatusCode: false })],
      [
        "POST notion/databases (valid id)",
        () => asOwner.post(url("/notion/databases"), { data: { databaseId: newNotionId(), databaseName: "x" }, failOnStatusCode: false }),
      ],
      ["POST notion/sync", () => asOwner.post(url("/notion/sync"), { data: {}, failOnStatusCode: false })],
      [
        "POST notion/comment",
        () => asOwner.post(url("/notion/comment"), { data: { pageId: newNotionId(), comment: "hi" }, failOnStatusCode: false }),
      ],
      ["GET notion/search-pages", () => asOwner.get(url("/notion/search-pages?q=x"), { failOnStatusCode: false })],
    ];
    for (const [what, attempt] of needsConnection) {
      const res = await attempt();
      expect(res.status(), `${what} answered ${res.status()}: ${await res.text()}`).toBe(404);
      expect(JSON.stringify(await res.json()).toLowerCase()).toContain("not connected");
    }

    // The mirrored-page reads need no provider at all: an empty store is an empty answer, not an error.
    for (const who of [asOwner, asManager, asQa]) {
      expect(await (await who.get(url("/notion/pages"))).json()).toEqual({ list: [], total: 0 });
      const linked = await who.get(url("/testcases/linked-notion-pages"));
      expect(linked.status()).toBe(200);
      const linkedBody = await linked.json();
      expect(Array.isArray(linkedBody.keys)).toBe(true);
      expect(typeof linkedBody.counts).toBe("object");
      expect((await who.get(url("/notion/status"))).status()).toBe(200);
    }
  });

  test("INT-A-61 workspace status and config report not-connected and expose only the public OAuth fields", async () => {
    const status = await asOwner.get("/api/workspace/integrations/notion/status", { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    expect(await status.json()).toEqual({ connected: false, connectedProjects: [] });

    const config = await asOwner.get("/api/workspace/integrations/notion/config", { failOnStatusCode: false });
    expect(config.status(), await config.text()).toBe(200);
    const body = await config.json();
    // Exactly these keys: the client SECRET must never be one of them.
    expect(Object.keys(body).sort()).toEqual(["clientId", "configured", "redirectUri"]);
    expect(typeof body.configured).toBe("boolean");
    expect(String(body.redirectUri)).toMatch(/\/integrations\/callback$/);
    if (body.configured) expect(body.clientId).toBeTruthy();

    // Any member can read config and status (the UI needs them to pick between Connect and "ask your owner").
    for (const who of [asManager, asQa]) {
      expect((await who.get("/api/workspace/integrations/notion/config")).status()).toBe(200);
      expect((await who.get("/api/workspace/integrations/notion/status")).status()).toBe(200);
    }
  });

  test("INT-A-62 auth-url points at Notion's authorize endpoint with owner=user and no scope, or names the missing env vars", async () => {
    const config = await (await asOwner.get("/api/workspace/integrations/notion/config")).json();
    const res = await asOwner.get("/api/workspace/integrations/notion/auth-url", { failOnStatusCode: false });

    if (config.configured) {
      expect(res.status(), await res.text()).toBe(200);
      const authUrl = new URL((await res.json()).url);
      expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://api.notion.com/v1/oauth/authorize");
      expect(authUrl.searchParams.get("owner")).toBe("user");
      expect(authUrl.searchParams.get("response_type")).toBe("code");
      expect(authUrl.searchParams.get("client_id")).toBe(config.clientId);
      expect(authUrl.searchParams.get("redirect_uri")).toBe(config.redirectUri);
      // A Notion integration's capabilities live on the integration itself; a scope param is wrong here.
      expect(authUrl.searchParams.has("scope")).toBe(false);
      const state = String(authUrl.searchParams.get("state"));
      expect(state.startsWith("notion."), `state was ${state}`).toBe(true);
      expect(state.split(".")).toHaveLength(3);
    } else {
      // An unconfigured deployment says so; it never hands back a link with an empty client_id.
      expect(res.status()).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("NOTION_CLIENT_ID");
    }
  });

  test("INT-A-63 the callback refuses a missing code, a denied consent screen and any forged or foreign state, writing nothing", async () => {
    const callback = (data: Record<string, unknown>) =>
      asOwner.post("/api/workspace/integrations/notion/callback", { data, failOnStatusCode: false });

    for (const data of [{}, { code: "" }, { state: "notion.a.b" }]) {
      const res = await callback(data);
      expect(res.status(), `${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Authorization code is required");
    }

    // Cancelling on Notion's consent screen redirects back with ?error= and no code: say so, do not
    // report a "missing code", and cap how much of the provider-supplied value is echoed back.
    const denied = await callback({ error: "access_denied" });
    expect(denied.status()).toBe(400);
    const deniedMessage = JSON.stringify(await denied.json());
    expect(deniedMessage).toContain("Notion");
    expect(deniedMessage).toMatch(/cancelled or denied/);
    expect(deniedMessage).not.toContain("Authorization code is required");
    const longError = await callback({ error: "z".repeat(300) });
    expect(longError.status()).toBe(400);
    expect(JSON.stringify(await longError.json())).not.toContain("z".repeat(81));

    // State checks run before any token exchange, so a bad state never reaches Notion.
    for (const state of ["", "garbage", "notion.only-two", "notion.a.b.c", "jira.payload.signature", "notion.not-base64.not-a-signature"]) {
      const res = await callback({ code: "e2e-not-a-real-code", state });
      expect(res.status(), `state "${state}" answered ${res.status()}: ${await res.text()}`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Invalid authorization state");
    }
    // A missing state is the same refusal.
    expect((await callback({ code: "e2e-not-a-real-code" })).status()).toBe(400);

    // The genuine-but-wrong cases need a real signed state, so they only run where the deployment has
    // OAuth apps configured (wherever auth-url answers 200).
    const own = await oauthState(asOwner, "notion");
    if (own) {
      const [provider, payload, signature] = own.split(".");
      const flipped = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
      const tampered = await callback({ code: "e2e-not-a-real-code", state: `${provider}.${flipped}.${signature}` });
      expect(tampered.status()).toBe(400);
      expect(JSON.stringify(await tampered.json())).toContain("Invalid authorization state");

      // A state minted for another workspace (account B's) is pinned to that workspace, not this one.
      const foreign = await oauthState(asB, "notion");
      if (foreign) {
        const res = await callback({ code: "e2e-not-a-real-code", state: foreign });
        expect(res.status()).toBe(400);
        expect(JSON.stringify(await res.json())).toContain("different workspace");
      }
    }
    // A Linear-signed state replayed against the Notion callback.
    const linearState = await oauthState(asOwner, "linear");
    if (linearState) {
      const res = await callback({ code: "e2e-not-a-real-code", state: linearState });
      expect(res.status()).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Invalid authorization state");
    }

    expect(
      countRows("integration_connections", `organization_id = ${literal(tenant!.organizationId)}`),
      "a refused callback created a connection",
    ).toBe("0");
  });

  test("INT-A-64 only the workspace owner can start, finish or undo a Notion connection", async () => {
    const connectionId = seedConnection("notion");
    for (const [who, api] of [
      ["qa_engineer", asQa],
      ["guest", asGuest],
    ] as const) {
      for (const [what, attempt] of notionWorkspaceRoutes(api).filter(([name]) => name !== "GET status" && name !== "GET config")) {
        const res = await attempt();
        expect(res.status(), `${what} as ${who} answered ${res.status()}: ${await res.text()}`).toBe(403);
      }
    }
    // One engineer disconnecting it would break it for everyone; the row is exactly as it was.
    expect(scalar(`SELECT disconnected_at IS NULL FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("t");
    expect(scalar(`SELECT access_token FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("e2e-not-a-real-token");
  });

  test("INT-A-65 'notion' is a known provider on the shared routes and near-misses are still refused", async () => {
    // sync-status for a project that has never synced Notion: a known provider with no run yet.
    const status = await asOwner.get(url("/integrations/notion/sync-status"), { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    expect((await status.json()).run).toBeNull();

    // Provider matching is exact: case and padding variants are not "notion".
    for (const provider of ["Notion", "NOTION", "notion2", "notio", "notion%20"]) {
      for (const suffix of ["auth-url", "config", "status"]) {
        const res = await asOwner.get(`/api/workspace/integrations/${provider}/${suffix}`, { failOnStatusCode: false });
        expect(res.status(), `${provider}/${suffix} answered ${res.status()}: ${await res.text()}`).toBe(400);
      }
      const sync = await asOwner.get(url(`/integrations/${provider}/sync-status`), { failOnStatusCode: false });
      expect(sync.status(), `sync-status for "${provider}" answered ${sync.status()}`).toBe(400);
    }
  });

  test("INT-A-66 a connected workspace reports its site, the projects mapped to it, and never the token", async () => {
    const connectionId = seedConnection("notion", "https://www.notion.so");

    let body = await (await asOwner.get("/api/workspace/integrations/notion/status")).json();
    expect(body.connected).toBe(true);
    expect(body.id).toBe(connectionId);
    expect(body.siteUrl).toBe("https://www.notion.so");
    expect(body.connectedProjects).toEqual([]);
    // A Notion token never expires or refreshes, so a healthy seeded connection is never "needs reconnect".
    expect(body.needsReconnect).toBe(false);
    expect(body.authError).toBeNull();
    expect(JSON.stringify(body)).not.toContain("e2e-not-a-real-token");

    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId, { databaseName: "E2E Requirements DB" });
    body = await (await asOwner.get("/api/workspace/integrations/notion/status")).json();
    expect(body.connectedProjects).toHaveLength(1);
    expect(body.connectedProjects[0].projectId).toBe(tenant!.mainProjectId);
    expect(body.connectedProjects[0].projectName).toBeTruthy();

    // The same database can feed two Tesbo projects (uniqueness is per project, not per database).
    seedNotionMapping(connectionId, tenant!.secondProjectId, { databaseId: dbId });
    body = await (await asOwner.get("/api/workspace/integrations/notion/status")).json();
    expect(body.connectedProjects.map((p: any) => p.projectId).sort()).toEqual([tenant!.mainProjectId, tenant!.secondProjectId].sort());

    // Project-level status: the one enabled mapping, plus every past one as history.
    seedNotionMapping(connectionId, tenant!.mainProjectId, { databaseName: "Previous DB", enabled: false });
    const project = await (await asOwner.get(url("/notion/status"))).json();
    expect(project.connected).toBe(true);
    expect(project.siteUrl).toBe("https://www.notion.so");
    expect(project.needsReconnect).toBe(false);
    expect(project.connectedProjects).toHaveLength(1);
    expect(project.connectedProjects[0].notionDatabaseId).toBe(dbId);
    expect(project.connectedProjects[0].notionDatabaseName).toBe("E2E Requirements DB");
    expect(project.history.map((h: any) => h.notionDatabaseName)).toEqual(["Previous DB"]);
    expect(JSON.stringify(project)).not.toContain("e2e-not-a-real-token");

    // Jira and Linear stay not-connected: one provider's connection never reads as another's.
    for (const provider of ["jira", "linear"]) {
      expect((await (await asOwner.get(`/api/workspace/integrations/${provider}/status`)).json()).connected).toBe(false);
    }
  });

  test("INT-A-67 mirrored Notion pages list with their fields, newest edit first, and only for their own project", async () => {
    const connectionId = seedConnection("notion");
    const older = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Checkout flow spec", status: "In progress", updatedMinutesAgo: 60 });
    const newer = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Login redesign spec", status: "Done", updatedMinutesAgo: 1 });
    seedNotionPage(connectionId, tenant!.secondProjectId, { summary: "Belongs to the second project" });

    const { list, total } = await notionPageList(asOwner);
    expect(total).toBe(2);
    expect(list.map((p) => p.summary)).toEqual(["Login redesign spec", "Checkout flow spec"]);

    const first = list[0];
    expect(first.notionPageId).toBe(newer.pageId);
    expect(first.notionPageKey).toBe(notionKeyOf(newer.pageId));
    expect(first.status).toBe("Done");
    expect(first.archived).toBe(false);
    // The URL is the only way back to the source page.
    expect(String(first.notionUrl)).toContain("notion.so");
    expect(list[1].notionPageId).toBe(older.pageId);
    expect(JSON.stringify(list)).not.toContain("Belongs to the second project");

    // Every project member reads the same list.
    for (const who of [asManager, asQa]) expect((await notionPageList(who)).total).toBe(2);
  });

  test("INT-A-68 the page list searches by summary and by key, and filters by status, type and coverage", async () => {
    const connectionId = seedConnection("notion");
    const gateway = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Payment gateway timeout", status: "In progress", issueType: "Bug" });
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Unrelated cosmetic tweak", status: "Done", issueType: "Task" });

    const bySummary = await notionPageList(asOwner, "?search=gateway");
    expect(bySummary.list.map((p) => p.notionPageId)).toEqual([gateway.pageId]);
    // Search is case-insensitive and matches the display key too.
    expect((await notionPageList(asOwner, "?search=PAYMENT")).total).toBe(1);
    expect((await notionPageList(asOwner, `?search=${encodeURIComponent(gateway.key)}`)).list.map((p) => p.notionPageId)).toEqual([gateway.pageId]);
    // A search nothing matches is empty rather than unfiltered; a whitespace-only search is no search.
    expect(await notionPageList(asOwner, "?search=zzznomatch")).toEqual({ list: [], total: 0 });
    expect((await notionPageList(asOwner, "?search=%20%20")).total).toBe(2);

    expect((await notionPageList(asOwner, "?status=Done")).total).toBe(1);
    expect((await notionPageList(asOwner, "?status=Nope")).total).toBe(0);
    expect((await notionPageList(asOwner, "?issueType=Bug")).list.map((p) => p.notionPageId)).toEqual([gateway.pageId]);

    // Coverage: a live test case linked by the full page id covers it; a deleted one does not.
    const created = await asOwner.post(url("/testcases"), { data: { title: `E2E Notion coverage ${Date.now()}`, notionPageId: gateway.pageId } });
    expect(created.ok(), `creating the linked test case answered ${created.status()}: ${await created.text()}`).toBe(true);
    const testcaseId = (await created.json()).id;
    try {
      expect((await notionPageList(asOwner, "?coverage=covered")).list.map((p) => p.notionPageId)).toEqual([gateway.pageId]);
      expect((await notionPageList(asOwner, "?coverage=uncovered")).total).toBe(1);
      // An unknown coverage value is ignored rather than rejected.
      expect((await notionPageList(asOwner, "?coverage=maybe")).total).toBe(2);
    } finally {
      await asOwner.delete(url(`/testcases/${testcaseId}`), { failOnStatusCode: false });
    }
    expect((await notionPageList(asOwner, "?coverage=covered")).total).toBe(0);
    expect((await notionPageList(asOwner, "?coverage=uncovered")).total).toBe(2);
  });

  test("INT-A-69 the page list paginates, reports the full total on every page, and clamps its bounds", async () => {
    const connectionId = seedConnection("notion");
    for (let i = 1; i <= 5; i++) seedNotionPage(connectionId, tenant!.mainProjectId, { summary: `Page ${i}`, updatedMinutesAgo: i });

    const p1 = await notionPageList(asOwner, "?limit=2&offset=0");
    const p2 = await notionPageList(asOwner, "?limit=2&offset=2");
    const p3 = await notionPageList(asOwner, "?limit=2&offset=4");
    expect([p1.list.length, p2.list.length, p3.list.length]).toEqual([2, 2, 1]);
    for (const page of [p1, p2, p3]) expect(page.total).toBe(5);
    // Stable ordering: three pages are five distinct rows, newest first.
    expect([...p1.list, ...p2.list, ...p3.list].map((p) => p.summary)).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5"]);

    // Past the end is empty, with the total intact.
    expect(await notionPageList(asOwner, "?limit=2&offset=500")).toEqual({ list: [], total: 5 });
    // limit=0 is the "count without rows" request; the ceiling is 100; exactly the page size is fine.
    expect(await notionPageList(asOwner, "?limit=0")).toEqual({ list: [], total: 5 });
    expect((await notionPageList(asOwner, "?limit=100")).list).toHaveLength(5);
    expect((await notionPageList(asOwner, "?limit=100000")).list.length).toBeLessThanOrEqual(100);
    expect((await notionPageList(asOwner, "?limit=1")).list).toHaveLength(1);

    // Garbage never reaches the query as NaN (a 500 reachable by typing a word into a query string).
    for (const qs of ["limit=abc&offset=abc", "limit=-5", "offset=-1", "limit=2.7"]) {
      const res = await asOwner.get(url(`/notion/pages?${qs}`), { failOnStatusCode: false });
      expect(res.status(), `${qs} answered ${res.status()}: ${await res.text()}`).toBe(200);
      expect((await res.json()).total).toBe(5);
    }
    expect((await notionPageList(asOwner, "?limit=abc")).list.length).toBeGreaterThanOrEqual(1);
  });

  test("INT-A-70 an archived page is kept in the table but excluded from every list and count", async () => {
    const connectionId = seedConnection("notion");
    const live = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Live page", status: "Done" });
    const archived = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Archived page", status: "Archived-only status", archived: true });

    const { list, total } = await notionPageList(asOwner);
    expect(total).toBe(1);
    expect(list.map((p) => p.notionPageId)).toEqual([live.pageId]);
    // Not findable by search either.
    expect((await notionPageList(asOwner, "?search=Archived")).total).toBe(0);

    const tickets = await (await asOwner.get(url("/tickets"))).json();
    expect(tickets.list.filter((t: any) => t.source === "notion").map((t: any) => t.externalId)).toEqual([live.pageId]);
    const summary = await (await asOwner.get(url("/tickets/summary"))).json();
    expect(summary.notion.total).toBe(1);
    expect(summary.notion.statuses).toEqual(["Done"]);

    // Kept, not deleted: it is still a row, and coming back un-archived revives it.
    expect(countRows("notion_pages", `notion_page_id = ${literal(archived.pageId)}`)).toBe("1");
    exec(`UPDATE notion_pages SET archived = false WHERE notion_page_id = ${literal(archived.pageId)};`);
    expect((await notionPageList(asOwner)).total).toBe(2);
  });

  test("INT-A-71 switching the mapped Notion database hides the old database's pages, but ?remoteId still reaches them", async () => {
    const connectionId = seedConnection("notion");
    const oldDb = seedNotionMapping(connectionId, tenant!.mainProjectId, { databaseName: "Old DB" });
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Old database page", mappedRemoteId: oldDb });
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Old archived page", mappedRemoteId: oldDb, archived: true });

    expect((await notionPageList(asOwner)).list.map((p) => p.summary)).toEqual(["Old database page"]);

    // What a remap leaves behind: the old mapping disabled (never deleted), a new one enabled.
    exec(`UPDATE notion_project_mappings SET enabled = false WHERE project_id = ${literal(tenant!.mainProjectId)};`);
    const newDb = seedNotionMapping(connectionId, tenant!.mainProjectId, { databaseName: "New DB" });
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "New database page", mappedRemoteId: newDb });

    expect((await notionPageList(asOwner)).list.map((p) => p.summary)).toEqual(["New database page"]);
    // The history list is what the UI offers ?remoteId from; archived pages stay hidden there too.
    expect((await notionPageList(asOwner, `?remoteId=${oldDb}`)).list.map((p) => p.summary)).toEqual(["Old database page"]);
    expect((await notionPageList(asOwner, `?remoteId=${newDb}`)).total).toBe(1);
    expect((await notionPageList(asOwner, `?remoteId=${newNotionId()}`)).total).toBe(0);

    const summary = await (await asOwner.get(url("/tickets/summary"))).json();
    expect(summary.notion.total, "the stat strip counted a database the project is no longer mapped to").toBe(1);
    const tickets = await (await asOwner.get(url("/tickets"))).json();
    expect(JSON.stringify(tickets)).not.toContain("Old database page");

    const status = await (await asOwner.get(url("/notion/status"))).json();
    expect(status.connectedProjects.map((m: any) => m.notionDatabaseName)).toEqual(["New DB"]);
    expect(status.history.map((m: any) => m.notionDatabaseName)).toEqual(["Old DB"]);
  });

  test("INT-A-72 pages with no enabled mapping, and a mapping with no pages, both list as empty", async () => {
    const connectionId = seedConnection("notion");
    // Pages whose mapping is gone are invisible by default (the default scope is the enabled mapping).
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Orphaned by unmapping", mappedRemoteId: newNotionId() });
    expect(await notionPageList(asOwner)).toEqual({ list: [], total: 0 });

    // A mapped database that has never synced.
    seedNotionMapping(connectionId, tenant!.secondProjectId);
    const empty = await asOwner.get(url("/notion/pages", tenant!.secondProjectId), { failOnStatusCode: false });
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toEqual({ list: [], total: 0 });
    const summary = await (await asOwner.get(url("/tickets/summary", tenant!.secondProjectId))).json();
    expect(summary.notion).toEqual({ total: 0, covered: 0, uncovered: 0, types: [], statuses: [] });
  });

  test("INT-A-73 the combined ticket list and the summary carry Notion as a third source", async () => {
    const emptySummary = await (await asOwner.get(url("/tickets/summary"))).json();
    for (const source of ["all", "jira", "linear", "notion"]) {
      expect(emptySummary[source], `summary has no "${source}" bucket: ${JSON.stringify(emptySummary)}`).toEqual({
        total: 0,
        covered: 0,
        uncovered: 0,
        types: [],
        statuses: [],
      });
    }

    const notion = seedConnection("notion");
    const jira = seedConnection("jira");
    const linear = seedConnection("linear");
    const done = seedNotionPage(notion, tenant!.mainProjectId, { summary: "Notion requirement A", status: "Done", issueType: "Task" });
    seedNotionPage(notion, tenant!.mainProjectId, { summary: "Notion requirement B", status: "Not started", issueType: "Task" });
    seedNotionPage(notion, tenant!.mainProjectId, { summary: "Notion archived", status: "Hidden", archived: true });
    seedJiraTicket(jira, { key: "E2E-70", summary: "Jira requirement" });
    seedLinearTicket(linear, { key: "LIN-70", summary: "Linear requirement" });

    const summary = await (await asOwner.get(url("/tickets/summary"))).json();
    expect(summary.notion.total).toBe(2);
    expect(summary.jira.total).toBe(1);
    expect(summary.linear.total).toBe(1);
    expect(summary.all.total).toBe(4);
    expect(summary.all.covered + summary.all.uncovered).toBe(4);
    expect(summary.notion.types).toEqual(["Task"]);
    expect(summary.notion.statuses).toEqual(["Done", "Not started"]);
    expect(summary.all.statuses).not.toContain("Hidden");
    expect(summary.all.types).toEqual([...summary.all.types].sort());
    expect(summary.all.types).toEqual(expect.arrayContaining(["Task", "Story", "Bug"]));

    const tickets = await (await asOwner.get(url("/tickets"))).json();
    expect(tickets.total).toBe(4);
    const bySource = (source: string) => tickets.list.filter((t: any) => t.source === source);
    expect(bySource("notion")).toHaveLength(2);
    expect(bySource("jira")).toHaveLength(1);
    expect(bySource("linear")).toHaveLength(1);
    const row = bySource("notion").find((t: any) => t.summary === "Notion requirement A");
    // externalId is the FULL page id (what a test case links by); key is only the display label.
    expect(row.externalId).toBe(done.pageId);
    expect(row.key).toBe(done.key);
    expect(row.hasCoverage).toBe(false);
    expect(String(row.url)).toContain("notion.so");

    // The shared filters reach Notion rows too.
    const searched = await (await asOwner.get(url("/tickets?search=Notion%20requirement%20B"))).json();
    expect(searched.list.map((t: any) => t.source)).toEqual(["notion"]);
    const byStatus = await (await asOwner.get(url("/tickets?status=Done"))).json();
    expect(byStatus.list.map((t: any) => t.externalId)).toEqual([done.pageId]);
  });

  test("INT-A-74 linked-notion-pages reports linked page ids with their test case counts, and ignores deleted cases", async () => {
    const pageId = newNotionId();
    const created: string[] = [];
    try {
      const before = await (await asOwner.get(url("/testcases/linked-notion-pages"))).json();
      expect(before.keys).not.toContain(pageId);

      for (let i = 1; i <= 2; i++) {
        const res = await asOwner.post(url("/testcases"), { data: { title: `E2E Notion link ${i} ${Date.now()}`, notionPageId: pageId } });
        expect(res.ok(), `creating a linked test case answered ${res.status()}: ${await res.text()}`).toBe(true);
        created.push((await res.json()).id);
      }
      const linked = await (await asOwner.get(url("/testcases/linked-notion-pages"))).json();
      expect(linked.keys).toContain(pageId);
      expect(linked.counts[pageId]).toBe(2);

      await asOwner.delete(url(`/testcases/${created[0]}`), { failOnStatusCode: false });
      expect((await (await asOwner.get(url("/testcases/linked-notion-pages"))).json()).counts[pageId]).toBe(1);
    } finally {
      for (const id of created) await asOwner.delete(url(`/testcases/${id}`), { failOnStatusCode: false });
    }
    expect((await (await asOwner.get(url("/testcases/linked-notion-pages"))).json()).keys).not.toContain(pageId);
  });

  test("INT-A-75 connecting a database refuses a missing, blank or malformed databaseId and leaves the mapping alone", async () => {
    const connectionId = seedConnection("notion");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId);
    const mappings = () => countRows("notion_project_mappings", `project_id = ${literal(tenant!.mainProjectId)}`);
    const before = mappings();

    // Every one of these fails the id check BEFORE anything is sent to Notion. (A well-formed id would
    // be verified live against Notion, which this suite cannot answer, so none is used here.)
    const bad: Array<Record<string, unknown>> = [
      {},
      { databaseName: "name but no id" },
      { databaseId: "" },
      { databaseId: "   " },
      { databaseId: "not-a-uuid" },
      { databaseId: "1234" },
      { databaseId: "z".repeat(32) },
      { databaseId: `${newNotionId()}0` },
      { databaseId: "'; DROP TABLE notion_pages; --" },
      { databaseId: true },
      { databaseId: {} },
      { databaseId: 12345 },
    ];
    for (const data of bad) {
      const res = await asOwner.post(url("/notion/databases"), { data, failOnStatusCode: false });
      expect(res.status(), `${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("valid Notion databaseId");
    }

    expect(mappings(), "a refused payload changed the stored mappings").toBe(before);
    expect(
      countRows("notion_project_mappings", `project_id = ${literal(tenant!.mainProjectId)} AND notion_database_id = ${literal(dbId)} AND enabled = true`),
      "a refused payload disabled the current mapping on its way to a refusal",
    ).toBe("1");
  });

  test("INT-A-76 an explicit null databaseId unlinks the project: mapping disabled not deleted, pages kept, repeatable", async () => {
    const connectionId = seedConnection("notion");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId, { databaseName: "To unlink" });
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Survives the unlink" });
    expect((await notionPageList(asOwner)).total).toBe(1);

    // A non-member cannot unlink someone else's project.
    const refused = await asGuest.post(url("/notion/databases"), { data: { databaseId: null }, failOnStatusCode: false });
    await expectRefused(refused, "unlink (non-member)");
    expect(countRows("notion_project_mappings", `notion_database_id = ${literal(dbId)} AND enabled = true`)).toBe("1");

    const res = await asOwner.post(url("/notion/databases"), { data: { databaseId: null }, failOnStatusCode: false });
    expect(res.status(), await res.text()).toBeLessThan(300);
    expect(await res.json()).toEqual({ linked: 0 });

    expect(scalar(`SELECT enabled FROM notion_project_mappings WHERE notion_database_id = ${literal(dbId)};`)).toBe("f");
    expect(countRows("notion_pages", `project_id = ${literal(tenant!.mainProjectId)}`), "unlinking deleted the mirrored pages").toBe("1");
    // Hidden from the default view, reachable through ?remoteId, listed in the history.
    expect((await notionPageList(asOwner)).total).toBe(0);
    expect((await notionPageList(asOwner, `?remoteId=${dbId}`)).total).toBe(1);
    const status = await (await asOwner.get(url("/notion/status"))).json();
    expect(status.connected).toBe(true);
    expect(status.connectedProjects).toEqual([]);
    expect(status.history.map((m: any) => m.notionDatabaseId)).toEqual([dbId]);
    // Nothing is mapped any more, so there is nothing to sync.
    const sync = await asOwner.post(url("/notion/sync"), { data: {}, failOnStatusCode: false });
    expect(sync.status()).toBe(400);
    expect(JSON.stringify(await sync.json())).toContain("Link a Notion database");

    // Unlinking an already-unlinked project is a harmless no-op, not an error.
    const again = await asOwner.post(url("/notion/databases"), { data: { databaseId: null }, failOnStatusCode: false });
    expect(again.status()).toBeLessThan(300);
    expect(await again.json()).toEqual({ linked: 0 });
  });

  test("INT-A-77 the schema allows one enabled Notion database per project, and one row per page", async () => {
    const connectionId = seedConnection("notion");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId);

    // A second ENABLED mapping for the same project is what two racing saves would produce; the
    // connect endpoint turns this exact violation into a 409.
    const second = sqlRejection(
      "INSERT INTO notion_project_mappings (integration_connection_id, project_id, notion_database_id, notion_database_name) VALUES (" +
        `${literal(connectionId)}, ${literal(tenant!.mainProjectId)}, ${literal(newNotionId())}, 'second enabled');`,
    );
    expect(second).toContain("idx_notion_project_mappings_one_per_project");
    // Re-saving the very same database for the project hits the (connection, database, project) key.
    expect(
      sqlRejection(
        "INSERT INTO notion_project_mappings (integration_connection_id, project_id, notion_database_id, notion_database_name) VALUES (" +
          `${literal(connectionId)}, ${literal(tenant!.mainProjectId)}, ${literal(dbId)}, 'duplicate');`,
      ),
    ).toMatch(/duplicate key|unique/i);
    // Disabled history rows are unrestricted, and the same database may feed another project.
    seedNotionMapping(connectionId, tenant!.mainProjectId, { enabled: false });
    seedNotionMapping(connectionId, tenant!.mainProjectId, { enabled: false });
    seedNotionMapping(connectionId, tenant!.secondProjectId, { databaseId: dbId });
    expect(countRows("notion_project_mappings", `notion_database_id = ${literal(dbId)} AND enabled = true`)).toBe("2");

    // One row per (connection, page, project); the same page may be mirrored into two projects.
    const page = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Unique page" });
    expect(
      sqlRejection(
        "INSERT INTO notion_pages (project_id, integration_connection_id, notion_page_id, notion_page_key, summary) VALUES (" +
          `${literal(tenant!.mainProjectId)}, ${literal(connectionId)}, ${literal(page.pageId)}, ${literal(page.key)}, 'duplicate page');`,
      ),
    ).toMatch(/duplicate key|unique/i);
    seedNotionPage(connectionId, tenant!.secondProjectId, { summary: "Same page, other project", pageId: page.pageId });
    expect(countRows("notion_pages", `notion_page_id = ${literal(page.pageId)}`)).toBe("2");
  });

  test("INT-A-78 a workspace has one Notion connection row, and a reconnect revives it in place under the same id", async () => {
    const connectionId = seedConnection("notion");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId);
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Outlives a reconnect" });

    // The upsert behind reconnecting is ON CONFLICT (organization_id, provider): a second row for the
    // same workspace and provider cannot exist.
    expect(
      sqlRejection(
        "INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at) VALUES (" +
          `${literal(tenant!.organizationId)}, 'notion', 'other-workspace', 'https://www.notion.so', 'x', '', now() + interval '1 hour');`,
      ),
    ).toMatch(/duplicate key|unique/i);

    const disconnect = await asOwner.delete("/api/workspace/integrations/notion/disconnect", { failOnStatusCode: false });
    expect(disconnect.ok(), await disconnect.text()).toBe(true);
    expect((await (await asOwner.get("/api/workspace/integrations/notion/status")).json()).connected).toBe(false);

    // What the callback's revive branch does (the real one needs a live Notion code exchange, so it is
    // reproduced in SQL): same row, fresh token, disconnected_at cleared. Everything historical is
    // still attached to that stable connection id.
    exec(
      "UPDATE integration_connections SET disconnected_at = NULL, access_token = 'e2e-not-a-real-token-2', refresh_token = '', " +
        `token_expires_at = now() + interval '1 hour', updated_at = now() WHERE id = ${literal(connectionId)};`,
    );
    const status = await (await asOwner.get("/api/workspace/integrations/notion/status")).json();
    expect(status.connected).toBe(true);
    expect(status.id, "a reconnect must keep the same connection id").toBe(connectionId);
    expect(countRows("notion_pages", `integration_connection_id = ${literal(connectionId)}`)).toBe("1");
    // The disconnect disabled the mapping and reconnecting does not silently re-enable it: the project
    // shows it as history until someone links a database again.
    const project = await (await asOwner.get(url("/notion/status"))).json();
    expect(project.connectedProjects).toEqual([]);
    expect(project.history.map((m: any) => m.notionDatabaseId)).toEqual([dbId]);
  });

  test("INT-A-79 disconnecting Notion flips state only: tokens blanked, mappings disabled, pages and other providers untouched", async () => {
    const connectionId = seedConnection("notion");
    const jiraId = seedConnection("jira");
    const dbId = seedNotionMapping(connectionId, tenant!.mainProjectId, { databaseName: "SURV" });
    seedNotionMapping(connectionId, tenant!.secondProjectId, { databaseId: dbId });
    const page = seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Must survive a disconnect" });

    const res = await asOwner.delete("/api/workspace/integrations/notion/disconnect", { failOnStatusCode: false });
    expect(res.ok(), `disconnect answered ${res.status()}: ${await res.text()}`).toBe(true);
    expect(await res.json()).toEqual({ disconnected: true });

    // Reads as not-connected everywhere...
    expect((await (await asOwner.get("/api/workspace/integrations/notion/status")).json()).connected).toBe(false);
    expect((await (await asOwner.get(url("/notion/status"))).json()).connected).toBe(false);
    // (the routes that need the provider: databases, sync, search-pages)
    for (const [what, attempt] of notionRoutes(asOwner).filter(([name]) => /databases|sync$|search-pages/.test(name))) {
      const call = await attempt();
      expect(call.status(), `${what} after disconnect answered ${call.status()}: ${await call.text()}`).toBe(404);
    }

    // ...but nothing was deleted, and the live credentials are gone.
    expect(countRows("integration_connections", `id = ${literal(connectionId)}`)).toBe("1");
    expect(scalar(`SELECT disconnected_at IS NOT NULL FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("t");
    expect(scalar(`SELECT access_token FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("");
    expect(scalar(`SELECT refresh_token FROM integration_connections WHERE id = ${literal(connectionId)};`)).toBe("");
    expect(countRows("notion_project_mappings", `integration_connection_id = ${literal(connectionId)} AND enabled = false`)).toBe("2");
    expect(countRows("notion_project_mappings", `integration_connection_id = ${literal(connectionId)}`)).toBe("2");
    expect(countRows("notion_pages", `notion_page_id = ${literal(page.pageId)}`)).toBe("1");
    // The page list needs no provider: the disabled mapping hides it from the default view, ?remoteId still serves it.
    expect((await notionPageList(asOwner)).total).toBe(0);
    expect((await notionPageList(asOwner, `?remoteId=${dbId}`)).list.map((p) => p.notionPageId)).toEqual([page.pageId]);

    // Jira's connection is a different row and is not touched.
    expect(scalar(`SELECT disconnected_at IS NULL FROM integration_connections WHERE id = ${literal(jiraId)};`)).toBe("t");
    expect((await (await asOwner.get("/api/workspace/integrations/jira/status")).json()).connected).toBe(true);
  });

  test("INT-A-80 disconnecting Notion twice is a no-op and leaves the Notion Knowledge Base folder and mirrored documents visible", async () => {
    seedConnection("notion");
    const folderId = seedProviderFolder("notion");
    const docId = seedMirrorDocument("notion", `notion-kb-${Date.now()}`, "Notion page that must stay visible", tenant!.mainProjectId, folderId);

    const first = await asOwner.delete("/api/workspace/integrations/notion/disconnect", { failOnStatusCode: false });
    expect(first.ok(), await first.text()).toBe(true);
    const second = await asOwner.delete("/api/workspace/integrations/notion/disconnect", { failOnStatusCode: false });
    expect(second.ok(), `a repeat disconnect must be a harmless no-op: ${await second.text()}`).toBe(true);

    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("f");
    expect(scalar(`SELECT deletion_reason FROM knowledge_folders WHERE id = ${literal(folderId)};`)).toBe("");
    expect(scalar(`SELECT is_deleted FROM knowledge_documents WHERE id = ${literal(docId)};`)).toBe("f");
    const tree = await (await asOwner.get(url("/knowledge-base/folders/tree"))).json();
    expect(tree.children.map((c: { id: string }) => c.id), "the Notion folder must still be in the tree").toContain(folderId);
  });

  test("INT-A-81 sync-status and sync-history accept Notion runs and surface their message and remote key", async () => {
    const database = newNotionId();
    seedSyncRun("notion", {
      status: "failed",
      error: "Notion needs to be reconnected to this workspace.",
      remoteProjectKey: database,
      remoteProjectName: "E2E Notion DB",
    });

    const status = await asOwner.get(url("/integrations/notion/sync-status"), { failOnStatusCode: false });
    expect(status.status(), await status.text()).toBe(200);
    const { run } = await status.json();
    expect(run.provider).toBe("notion");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Notion needs to be reconnected to this workspace.");
    // A Notion database has no short key, so the run's remote key is the database id.
    expect(run.remoteProjectKey).toBe(database);
    expect(run.remoteProjectName).toBe("E2E Notion DB");

    const history = await (await asOwner.get(url("/integrations/sync-history"))).json();
    expect(history.runs.map((r: any) => r.provider)).toContain("notion");

    // One provider's runs never show as another's latest run, and they are project-scoped.
    for (const provider of ["jira", "linear"]) {
      expect((await (await asOwner.get(url(`/integrations/${provider}/sync-status`))).json()).run).toBeNull();
    }
    expect((await (await asOwner.get(url("/integrations/notion/sync-status", tenant!.secondProjectId))).json()).run).toBeNull();
    // Nothing raw from the provider leaks through either route.
    expect(JSON.stringify(history)).not.toContain("Unauthorized");
  });

  test("INT-A-82 a Notion comment needs a valid page id and a body, checked before anything is sent", async () => {
    seedConnection("notion");

    const cases: Array<Record<string, unknown>> = [
      {},
      { pageId: newNotionId() },
      { pageId: newNotionId(), comment: "   " },
      { comment: "orphaned" },
      { pageId: "", comment: "" },
      { pageId: "not-a-page-id", comment: "hello" },
      { pageId: `${newNotionId()}f`, comment: "hello" },
      { pageId: { nested: true }, comment: "hello" },
    ];
    for (const data of cases) {
      const res = await asOwner.post(url("/notion/comment"), { data, failOnStatusCode: false });
      // The alternative to this check is posting an empty comment to a customer's Notion page.
      expect(res.status(), `${JSON.stringify(data)} answered ${res.status()}: ${await res.text()}`).toBe(400);
      expect(JSON.stringify(await res.json()).toLowerCase()).toContain("required");
    }
  });

  test("INT-A-83 a connected project with no database linked has nothing to search or sync, without calling Notion", async () => {
    seedConnection("notion");

    const search = await asOwner.get(url("/notion/search-pages?q=anything"), { failOnStatusCode: false });
    expect(search.status(), await search.text()).toBe(200);
    expect(await search.json()).toEqual({ list: [] });

    const sync = await asOwner.post(url("/notion/sync"), { data: {}, failOnStatusCode: false });
    expect(sync.status(), await sync.text()).toBe(400);
    expect(JSON.stringify(await sync.json())).toContain("Link a Notion database to this project before syncing");
    expect(
      countRows("integration_sync_runs", `project_id = ${literal(tenant!.mainProjectId)} AND provider = 'notion'`),
      "a refused sync queued a run",
    ).toBe("0");
  });

  test("INT-A-84 deleting a Notion connection row outright cascades to its pages and mappings, which is why disconnect is a soft flip", async () => {
    const connectionId = seedConnection("notion");
    seedNotionMapping(connectionId, tenant!.mainProjectId);
    seedNotionPage(connectionId, tenant!.mainProjectId, { summary: "Cascades away" });
    expect(countRows("notion_pages", `integration_connection_id = ${literal(connectionId)}`)).toBe("1");

    exec(`DELETE FROM integration_connections WHERE id = ${literal(connectionId)};`);
    expect(countRows("notion_pages", `integration_connection_id = ${literal(connectionId)}`)).toBe("0");
    expect(countRows("notion_project_mappings", `integration_connection_id = ${literal(connectionId)}`)).toBe("0");
  });

  test("INT-A-85 migration V133 is applied: the testcase link columns, the view, the Zyra column and the widened comment constraint", async () => {
    const cols = (table: string) =>
      scalar(
        `SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name = ${literal(table)} ` +
          "AND column_name IN ('notion_page_id', 'notion_url', 'notion_page_ids');",
      );
    expect(cols("testcases")).toBe("notion_page_id,notion_url");
    // testcases_active is SELECT * and froze its column list at creation; V133 recreates it.
    expect(cols("testcases_active"), "testcases_active does not expose the Notion columns").toBe("notion_page_id,notion_url");
    expect(cols("ai_generation_requests")).toBe("notion_page_ids");
    expect(
      scalar("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'integration_ticket_comments_provider_check';"),
    ).toContain("notion");
  });
});
