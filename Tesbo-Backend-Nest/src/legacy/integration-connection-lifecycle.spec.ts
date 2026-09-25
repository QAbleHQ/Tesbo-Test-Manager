import { createHash } from "crypto";
import { LegacyService } from "./legacy.service";
import { encryptSecret } from "../common/crypto.util";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * The Jira/Linear credential lifecycle in getIntegrationConnection (legacy.service.ts) and the
 * ticket-comment path that rides on it (jiraPostComment / linearPostComment).
 *
 * The root cause this pins: a connection whose token was issued to a DIFFERENT Atlassian OAuth app
 * (another Tesbo deployment sharing the row) could never be renewed here, yet every call re-sent the
 * same refresh token, got a 401, recorded nothing, and the status endpoint kept saying connected.
 *
 * integration_connections is simulated by one in-memory row that the SQL handler reads and writes,
 * so what persisted is asserted, not just what was called. fetch is mocked per URL: Atlassian's
 * token endpoint and the comment endpoint are the two outbound calls in scope.
 */

type Body = Record<string, any>;

const OWN_APP = "own-app-client-id";
const OTHER_APP = "other-deployment-client-id";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";

function jwt(clientId: string, label: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ client_id: clientId, jti: label })}.sig`;
}

function fingerprint(stored: string): string {
  return createHash("sha256").update(stored).digest("hex");
}

interface Harness {
  svc: LegacyService;
  row: Body;
  fetchMock: jest.SpyInstance;
  tokenCalls: () => number;
  commentCalls: () => Array<{ auth: string }>;
}

function makeHarness(rowFields: Body = {}, responses: { token?: Array<number | Body>; comment?: Array<number | Body> } = {}): Harness {
  const row: Body = {
    id: "conn-1",
    organization_id: "org-1",
    provider: "jira",
    external_id: "cloud-1",
    site_url: "https://example.atlassian.net",
    access_token: encryptSecret(jwt(OWN_APP, "a1")),
    refresh_token: encryptSecret("refresh-1"),
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    disconnected_at: null,
    auth_error: null,
    auth_error_at: null,
    auth_error_refresh_fingerprint: null,
    ...rowFields
  };
  const handler = async (sql: string, params: unknown[] = []) => {
    if (/SELECT organization_id FROM projects/.test(sql)) return { rows: [{ organization_id: "org-1" }] };
    if (/SELECT \* FROM integration_connections WHERE organization_id/.test(sql)) return { rows: row.disconnected_at ? [] : [{ ...row }] };
    if (/SELECT \* FROM integration_connections WHERE id = \$1 AND disconnected_at IS NULL FOR UPDATE/.test(sql)) return { rows: [{ ...row }] };
    if (/UPDATE integration_connections\s+SET access_token = \$2/.test(sql)) {
      Object.assign(row, { access_token: params[1], refresh_token: params[2], token_expires_at: params[3], auth_error: null, auth_error_at: null, auth_error_refresh_fingerprint: null });
      return { rows: [] };
    }
    if (/UPDATE integration_connections SET auth_error = \$2/.test(sql)) {
      if (row.refresh_token === params[3]) Object.assign(row, { auth_error: params[1], auth_error_at: new Date().toISOString(), auth_error_refresh_fingerprint: params[2] });
      return { rows: [] };
    }
    return { rows: [] };
  };
  const db = {
    query: jest.fn(handler),
    transaction: jest.fn(async (fn: (client: { query: typeof handler }) => Promise<unknown>) => fn({ query: handler }))
  } as unknown as DatabaseService;
  const svc = new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    { frontendUrl: "https://app.example.com" } as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as RequestCacheService,
    {} as unknown as ProjectLookupService,
    {} as unknown as KbExtractionRunnerService,
    {} as unknown as SuitesCacheService,
    {} as unknown as TestcasesListCacheService,
    {} as unknown as ProjectOverviewCacheService,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
  jest.spyOn(svc as unknown as { requireProjectAccess: (...a: unknown[]) => Promise<unknown> }, "requireProjectAccess").mockResolvedValue({});

  const tokenQueue = [...(responses.token ?? [])];
  const commentQueue = [...(responses.comment ?? [])];
  const seen: Array<{ url: string; auth: string }> = [];
  const reply = (spec: number | Body | undefined, fallback: Body) => {
    const status = typeof spec === "number" ? spec : 200;
    const body = typeof spec === "object" ? spec : fallback;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    seen.push({ url, auth: String(init?.headers?.Authorization || "") });
    if (url === TOKEN_URL) {
      return reply(tokenQueue.shift(), { access_token: jwt(OWN_APP, "renewed"), refresh_token: "refresh-2", expires_in: 3600 });
    }
    if (/\/comment$/.test(url)) return reply(commentQueue.shift(), { id: "10001" });
    return reply(200, {});
  });
  return {
    svc,
    row,
    fetchMock,
    tokenCalls: () => seen.filter((s) => s.url === TOKEN_URL).length,
    commentCalls: () => seen.filter((s) => /\/comment$/.test(s.url))
  };
}

type Internals = { jiraPostComment: (projectId: string, key: string, adf: Body) => Promise<string | null> };
const post = (h: Harness) => (h.svc as unknown as Internals).jiraPostComment(PROJECT_ID, "KAN-4", { type: "doc", version: 1, content: [] });

const EXPIRED = new Date(Date.now() - 60_000).toISOString();

describe("Jira credential lifecycle — getIntegrationConnection via the comment path", () => {
  beforeEach(() => {
    process.env.JIRA_CLIENT_ID = OWN_APP;
    process.env.JIRA_CLIENT_SECRET = "own-secret";
  });
  afterEach(() => jest.restoreAllMocks());

  it("valid credentials: posts with the stored token, no renewal", async () => {
    const h = makeHarness();
    await expect(post(h)).resolves.toBe("10001");
    expect(h.tokenCalls()).toBe(0);
    expect(h.commentCalls()).toHaveLength(1);
  });

  it("expired token, same app: renews once, persists the new tokens, and posts with the NEW token", async () => {
    const h = makeHarness({ token_expires_at: EXPIRED });
    await expect(post(h)).resolves.toBe("10001");
    expect(h.tokenCalls()).toBe(1);
    const posted = h.commentCalls()[0].auth;
    expect(posted).toBe(`Bearer ${jwt(OWN_APP, "renewed")}`);
    expect(new Date(h.row.token_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(h.row.auth_error).toBeNull();
  });

  it("expired token issued to ANOTHER app: refuses without contacting Atlassian, and records it", async () => {
    const h = makeHarness({ token_expires_at: EXPIRED, access_token: encryptSecret(jwt(OTHER_APP, "foreign")) });
    await expect(post(h)).rejects.toMatchObject({ response: { error: expect.stringMatching(/different Atlassian OAuth app/) } });
    expect(h.tokenCalls()).toBe(0);
    expect(h.commentCalls()).toHaveLength(0);
    expect(h.row.auth_error).toMatch(/needs to be reconnected/);
    expect(h.row.auth_error_refresh_fingerprint).toBe(fingerprint(h.row.refresh_token));
  });

  it("a refresh token already refused is never sent again — the stored reason comes back, no network", async () => {
    const stored = encryptSecret("refresh-dead");
    const h = makeHarness({ token_expires_at: EXPIRED, refresh_token: stored, auth_error: "Jira needs to be reconnected: recorded earlier.", auth_error_refresh_fingerprint: fingerprint(stored) });
    await expect(post(h)).rejects.toMatchObject({ response: { error: "Jira needs to be reconnected: recorded earlier." } });
    await expect(post(h)).rejects.toMatchObject({ response: { error: "Jira needs to be reconnected: recorded earlier." } });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("a refusal recorded for an OLD refresh token is ignored once the token has changed (reconnect / other deployment renewed)", async () => {
    const h = makeHarness({ token_expires_at: EXPIRED, auth_error: "stale refusal", auth_error_refresh_fingerprint: fingerprint("some-older-token") });
    await expect(post(h)).resolves.toBe("10001");
    expect(h.tokenCalls()).toBe(1);
    expect(h.row.auth_error).toBeNull();
  });

  it.each([
    [401, /rejected this deployment's OAuth app credentials/],
    [403, /revoked or has already been used/]
  ])("token endpoint %i: records the refusal with its own reason, and the next call does not retry it", async (status, reason) => {
    const h = makeHarness({ token_expires_at: EXPIRED }, { token: [status as number] });
    await expect(post(h)).rejects.toMatchObject({ response: { error: expect.stringMatching(reason) } });
    expect(h.row.auth_error).toMatch(reason);
    await expect(post(h)).rejects.toMatchObject({ response: { error: expect.stringMatching(reason) } });
    expect(h.tokenCalls()).toBe(1);
    expect(h.commentCalls()).toHaveLength(0);
  });

  it("a transient token-endpoint failure (500) is surfaced but NOT recorded — the next call may renew", async () => {
    const h = makeHarness({ token_expires_at: EXPIRED }, { token: [500] });
    await expect(post(h)).rejects.toMatchObject({ response: { error: expect.stringMatching(/request failed \(500\)/) } });
    expect(h.row.auth_error).toBeNull();
    await expect(post(h)).resolves.toBe("10001");
    expect(h.tokenCalls()).toBe(2);
  });

  it("401 on the post with an unexpired token: one forced renewal, one retry with the new token", async () => {
    const h = makeHarness({}, { comment: [401] });
    await expect(post(h)).resolves.toBe("10001");
    expect(h.tokenCalls()).toBe(1);
    const calls = h.commentCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).not.toBe(calls[1].auth);
    expect(calls[1].auth).toBe(`Bearer ${jwt(OWN_APP, "renewed")}`);
  });

  it("401 again after the forced renewal: gives up with the 401 — exactly two posts, one renewal, no loop", async () => {
    const h = makeHarness({}, { comment: [401, 401] });
    await expect(post(h)).rejects.toMatchObject({ providerStatus: 401 });
    expect(h.tokenCalls()).toBe(1);
    expect(h.commentCalls()).toHaveLength(2);
  });

  it("401 on the post, but another request already renewed the row: reuses that token without calling Atlassian", async () => {
    const h = makeHarness({}, { comment: [401] });
    const originalQuery = (h.svc as unknown as { db: { transaction: jest.Mock } }).db.transaction.getMockImplementation()!;
    (h.svc as unknown as { db: { transaction: jest.Mock } }).db.transaction.mockImplementationOnce(async (fn: any) => {
      h.row.access_token = encryptSecret(jwt(OWN_APP, "renewed-by-someone-else"));
      return originalQuery(fn);
    });
    await expect(post(h)).resolves.toBe("10001");
    expect(h.tokenCalls()).toBe(0);
    expect(h.commentCalls()[1].auth).toBe(`Bearer ${jwt(OWN_APP, "renewed-by-someone-else")}`);
  });

  it("401 on the post with no refresh token: surfaces the 401, never loops", async () => {
    const h = makeHarness({ refresh_token: "" }, { comment: [401] });
    await expect(post(h)).rejects.toMatchObject({ providerStatus: 401 });
    expect(h.commentCalls()).toHaveLength(1);
    expect(h.tokenCalls()).toBe(0);
  });

  it("a non-auth failure on the post (403) is not retried and does not trigger a renewal", async () => {
    const h = makeHarness({}, { comment: [403] });
    await expect(post(h)).rejects.toMatchObject({ providerStatus: 403 });
    expect(h.commentCalls()).toHaveLength(1);
    expect(h.tokenCalls()).toBe(0);
  });
});

describe("Jira status reports whether this deployment can keep using the connection", () => {
  beforeEach(() => {
    process.env.JIRA_CLIENT_ID = OWN_APP;
    process.env.JIRA_CLIENT_SECRET = "own-secret";
  });
  afterEach(() => jest.restoreAllMocks());

  it("same-app token: connected, no reconnect needed", async () => {
    const h = makeHarness();
    await expect(h.svc.jiraStatus(PROJECT_ID, "u1")).resolves.toMatchObject({ connected: true, needsReconnect: false, authError: null });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("token from another app: connected but needsReconnect, even before it expires", async () => {
    const h = makeHarness({ access_token: encryptSecret(jwt(OTHER_APP, "foreign")) });
    const status = await h.svc.jiraStatus(PROJECT_ID, "u1");
    expect(status).toMatchObject({ connected: true, needsReconnect: true });
    expect(String((status as Body).authError)).toMatch(/different Atlassian OAuth app/);
  });

  it("a recorded refusal for the current refresh token: needsReconnect with that reason; a stale one is ignored", async () => {
    const stored = encryptSecret("refresh-dead");
    const dead = makeHarness({ refresh_token: stored, auth_error: "Jira needs to be reconnected: x", auth_error_refresh_fingerprint: fingerprint(stored) });
    await expect(dead.svc.jiraStatus(PROJECT_ID, "u1")).resolves.toMatchObject({ needsReconnect: true, authError: "Jira needs to be reconnected: x" });
    jest.restoreAllMocks();
    const healed = makeHarness({ auth_error: "old", auth_error_refresh_fingerprint: fingerprint("previous-token") });
    await expect(healed.svc.jiraStatus(PROJECT_ID, "u1")).resolves.toMatchObject({ needsReconnect: false });
  });

  it("existing Jira operations keep working with a valid token: jiraProjects lists without renewing", async () => {
    const h = makeHarness();
    h.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ values: [{ id: "10000", key: "KAN", name: "Kanban" }] }), { status: 200 }));
    await expect(h.svc.jiraProjects(PROJECT_ID, "u1")).resolves.toEqual([expect.objectContaining({ key: "KAN" })]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});
