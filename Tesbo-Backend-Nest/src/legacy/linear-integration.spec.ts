import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
import { decryptSecret, encryptSecret } from "../common/crypto.util";
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

// A key just needs to decode to 32 bytes for aes-256-gcm; this is a throwaway test-only key
// (crypto.util lazily loads it on first encrypt/decrypt call, so setting it at module scope
// before any test runs is sufficient — see src/common/crypto.util.ts).
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * DB double that routes queries to a caller-supplied list of `{ match, rows | handler }` rules,
 * matched by substring against the SQL text (same style as mcp.service.spec.ts / api-token.service.spec.ts).
 * Falls through to an empty result set when nothing matches, and records every call for assertions.
 */
type Route = { match: string; rows?: Record<string, unknown>[]; handler?: (params: unknown[]) => { rows: Record<string, unknown>[] } };

function makeDb(routes: Route[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (sql.includes(route.match)) {
        return Promise.resolve(route.handler ? route.handler(params) : { rows: route.rows ?? [] });
      }
    }
    return Promise.resolve({ rows: [] });
  });
  // Real DatabaseService.transaction hands the callback a PoolClient wrapping BEGIN/COMMIT/ROLLBACK
  // around it; the double only needs to run the callback against the same routed `query` so the
  // routes above and the `calls` log behave identically inside and outside a transaction.
  const transaction = jest.fn((fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  return { db: { query, transaction } as unknown as DatabaseService, query, transaction, calls };
}

/** Route for LegacyService#workspace()'s primary "active organization" lookup. */
function workspaceRoute(role: string, orgId = "org-1"): Route {
  return {
    match: "FROM users u",
    rows: [{ id: orgId, name: "Acme", slug: "acme", role, created_at: "2024-01-01T00:00:00.000Z" }]
  };
}

/**
 * Route for a leftover per-workspace OAuth row. Credentials no longer come from the database, so
 * this exists only to prove such a row is ignored — see the "ignores any leftover" test.
 */
function savedOAuthConfigRoute(row: Record<string, unknown> | null): Route {
  return { match: "FROM integration_oauth_configs", rows: row ? [row] : [] };
}

/** Configures the deployment the only way it can be configured: environment credentials. */
function setEnvCredentials(clientId = "c", clientSecret = "s", redirectUri = "https://app.example.com/cb") {
  for (const prefix of ["JIRA", "LINEAR"]) {
    process.env[`${prefix}_CLIENT_ID`] = clientId;
    process.env[`${prefix}_CLIENT_SECRET`] = clientSecret;
    process.env[`${prefix}_REDIRECT_URI`] = redirectUri;
  }
}

/**
 * Mints a real signed `state` by driving integrationAuthUrl, so callback tests carry the same value
 * the authorize redirect would have — rather than re-implementing the HMAC here and letting the
 * test pass against a signature scheme the service no longer uses.
 */
async function validState(svc: LegacyService, provider: "jira" | "linear"): Promise<string> {
  const { url } = await svc.integrationAuthUrl("user-1", provider);
  return new URL(url).searchParams.get("state")!;
}

function makeLegacy(db: DatabaseService, integrationSync: Partial<IntegrationSyncService> = {}): LegacyService {
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    integrationSync as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    { assertIntegrationAllowed: jest.fn().mockResolvedValue(undefined) } as unknown as PlanLimitsService,
    {} as unknown as CustomFieldsService
  );
}

/** Captures a rejected promise's error without a try/catch block at every call site. */
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

const ENV_KEYS = ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "JIRA_REDIRECT_URI", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_REDIRECT_URI"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe("LegacyService — deployment-level OAuth config resolution", () => {
  // There is exactly one source of credentials: the backend environment. A workspace cannot
  // override it, so these pin that the DB is never consulted for client credentials.
  it("builds the authorize URL from env credentials", async () => {
    process.env.LINEAR_CLIENT_ID = "env-client";
    process.env.LINEAR_CLIENT_SECRET = "env-secret";
    process.env.LINEAR_REDIRECT_URI = "https://env.example.com/callback";

    const { db } = makeDb([workspaceRoute("owner")]);
    const params = new URL((await makeLegacy(db).integrationAuthUrl("user-1", "linear")).url).searchParams;
    expect(params.get("client_id")).toBe("env-client");
    expect(params.get("redirect_uri")).toBe("https://env.example.com/callback");
  });

  it("ignores any leftover per-workspace OAuth row and never queries for one", async () => {
    process.env.JIRA_CLIENT_ID = "env-client";
    process.env.JIRA_CLIENT_SECRET = "env-secret";

    // A row left behind by an older release must not resurrect the removed override path.
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "stale-db-client", client_secret: encryptSecret("s"), redirect_uri: "https://stale.example.com/cb" })
    ]);
    const params = new URL((await makeLegacy(db).integrationAuthUrl("user-1", "jira")).url).searchParams;
    expect(params.get("client_id")).toBe("env-client");
    expect(calls.some((c) => c.sql.includes("integration_oauth_configs"))).toBe(false);
  });

  it("throws an operator-facing message naming the env vars when nothing is configured", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const err = await rejection(makeLegacy(db).integrationAuthUrl("user-1", "linear"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/not configured on this deployment/i);
    expect(err.getResponse().error).toMatch(/LINEAR_CLIENT_ID/);
    expect(err.getResponse().error).toMatch(/LINEAR_CLIENT_SECRET/);
  });

  it("treats a client id with no secret as unconfigured", async () => {
    process.env.JIRA_CLIENT_ID = "env-client";
    const { db } = makeDb([workspaceRoute("owner")]);
    const err = await rejection(makeLegacy(db).integrationAuthUrl("user-1", "jira"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((await makeLegacy(db).integrationConfigStatus("user-1", "jira")).configured).toBe(false);
  });

  // Only client id + secret are required: the callback path is fixed by the frontend route, so
  // operators shouldn't have to restate it per provider.
  it("derives the redirect URI from FRONTEND_URL when only client id/secret are set", async () => {
    const savedFrontend = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = "https://app.tesbo.io/";
    process.env.JIRA_CLIENT_ID = "env-jira-client";
    process.env.JIRA_CLIENT_SECRET = "env-jira-secret";
    try {
      const { db } = makeDb([workspaceRoute("owner")]);
      const params = new URL((await makeLegacy(db).integrationAuthUrl("user-1", "jira")).url).searchParams;
      expect(params.get("client_id")).toBe("env-jira-client");
      expect(params.get("redirect_uri")).toBe("https://app.tesbo.io/integrations/callback");
    } finally {
      if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = savedFrontend;
    }
  });

  it("reports configured with the callback URL an operator must register", async () => {
    process.env.JIRA_CLIENT_ID = "env-jira-client";
    process.env.JIRA_CLIENT_SECRET = "env-jira-secret";
    process.env.JIRA_REDIRECT_URI = "https://app.example.com/integrations/callback";
    const { db } = makeDb([workspaceRoute("owner")]);
    const status = await makeLegacy(db).integrationConfigStatus("user-1", "jira");
    expect(status).toEqual({
      configured: true,
      clientId: "env-jira-client",
      redirectUri: "https://app.example.com/integrations/callback"
    });
  });

  it("still surfaces a callback URL when unconfigured, so an operator knows what to register", async () => {
    const savedFrontend = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = "https://app.tesbo.io";
    try {
      const { db } = makeDb([workspaceRoute("owner")]);
      const status = await makeLegacy(db).integrationConfigStatus("user-1", "jira");
      expect(status.configured).toBe(false);
      expect(status.redirectUri).toBe("https://app.tesbo.io/integrations/callback");
    } finally {
      if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = savedFrontend;
    }
  });

  it("forbids a non-owner from starting the OAuth redirect", async () => {
    process.env.JIRA_CLIENT_ID = "env-client";
    process.env.JIRA_CLIENT_SECRET = "env-secret";
    const { db } = makeDb([workspaceRoute("manager")]);
    const err = await rejection(makeLegacy(db).integrationAuthUrl("user-1", "jira"));
    expect(err).toBeInstanceOf(ForbiddenException);
  });
});

// Every workspace shares one platform client_id, so `state` is the only thing tying a callback to
// the workspace that started it. These tests pin that binding.
describe("LegacyService — OAuth state signing", () => {
  beforeEach(() => setEnvCredentials());

  function ownerDb(orgId = "org-1") {
    return makeDb([workspaceRoute("owner", orgId)]);
  }

  it("prefixes state with the provider so the callback page can route without trusting the payload", async () => {
    const svc = makeLegacy(ownerDb().db);
    const state = await validState(svc, "jira");
    expect(state.split(".")).toHaveLength(3);
    expect(state.split(".")[0]).toBe("jira");
  });

  it("issues a distinct state each time, so one authorize URL can't be replayed as another", async () => {
    const svc = makeLegacy(ownerDb().db);
    expect(await validState(svc, "jira")).not.toBe(await validState(svc, "jira"));
  });

  it("rejects a callback with no state at all", async () => {
    const svc = makeLegacy(ownerDb().db);
    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
  });

  it("rejects a forged state that was never signed", async () => {
    const svc = makeLegacy(ownerDb().db);
    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state: "jira.eyJwIjoiamlyYSJ9.deadbeef" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
  });

  it("rejects a state whose payload was tampered with after signing", async () => {
    const svc = makeLegacy(ownerDb().db);
    const [provider, payload, signature] = (await validState(svc, "jira")).split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    forged.o = "org-attacker";
    const tampered = `${provider}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state: tampered }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
  });

  it("rejects a validly-signed state minted for a different workspace", async () => {
    // The attacker's own workspace signs a state, then replays it into the victim's session.
    const attackerState = await validState(makeLegacy(ownerDb("org-attacker").db), "jira");
    const victim = makeLegacy(ownerDb("org-1").db);
    const err = await rejection(victim.integrationCallback("user-1", "jira", { code: "abc", state: attackerState }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/different workspace/i);
  });

  it("rejects a Linear-signed state replayed against the Jira callback", async () => {
    const svc = makeLegacy(ownerDb().db);
    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state: await validState(svc, "linear") }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
  });

  it("rejects a state older than its TTL", async () => {
    const svc = makeLegacy(ownerDb().db);
    const state = await validState(svc, "jira");
    const elevenMinutes = 11 * 60 * 1000;
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + elevenMinutes);
    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/expired/i);
  });

  it("verifies state before exchanging the code, so a bad state never reaches the provider", async () => {
    const svc = makeLegacy(ownerDb().db);
    const fetchSpy = jest.spyOn(global, "fetch");
    await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state: "jira.bogus.sig" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("LegacyService#integrationAuthUrl — provider-specific URL construction", () => {
  it("builds the Jira authorize URL with the Jira scope and OAuth params", async () => {
    setEnvCredentials("jira-client");
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "jira");
    expect(url.startsWith("https://auth.atlassian.com/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("audience")).toBe("api.atlassian.com");
    expect(params.get("client_id")).toBe("jira-client");
    expect(params.get("redirect_uri")).toBe("https://app.example.com/cb");
    expect(params.get("scope")).toBe("read:jira-work read:jira-user write:jira-work offline_access");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("state")!.startsWith("jira.")).toBe(true);
  });

  it("builds the Linear authorize URL with the Linear scope and no Jira-only audience param", async () => {
    setEnvCredentials("linear-client");
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "linear");
    expect(url.startsWith("https://linear.app/oauth/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("scope")).toBe("read,write,issues:create,comments:create");
    expect(params.get("state")!.startsWith("linear.")).toBe(true);
    expect(params.has("audience")).toBe(false);
  });

  it("rejects an unsupported provider before ever touching the database", async () => {
    const { db, query } = makeDb();
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationAuthUrl("user-1", "github"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("LegacyService#integrationCallback", () => {
  beforeEach(() => setEnvCredentials());

  it("forbids a non-owner (manager) from completing the OAuth callback", async () => {
    const { db } = makeDb([workspaceRoute("manager")]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc" }));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().error).toMatch(/only the workspace owner/i);
  });

  it("forbids a non-owner (qa_engineer / unrecognized role) from completing the OAuth callback", async () => {
    const { db } = makeDb([workspaceRoute("some-unrecognized-role")]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc" }));
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("requires an authorization code", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "linear", {}));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/authorization code is required/i);
  });

  it("rejects an unsupported provider before checking workspace role", async () => {
    const { db, query } = makeDb();
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "trello", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it("throws when Linear does not return an access token", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({}) } as unknown as Response);

    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc", state: await validState(svc, "linear") }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/linear did not return an oauth token/i);
  });

  it("throws when the connected Linear organization cannot be read", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1" }) } as unknown as Response) // token exchange
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { organization: {} } }) } as unknown as Response); // graphql viewer, no urlKey

    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc", state: await validState(svc, "linear") }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/could not read the connected linear workspace/i);
  });

  it("upserts the Linear connection with encrypted tokens on a successful callback", async () => {
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      { match: "INSERT INTO integration_connections", handler: () => ({ rows: [{ id: "conn-1", site_url: "https://linear.app/acme" }] }) }
    ]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "linear-access-token", refresh_token: "linear-refresh-token", expires_in: 1000 })
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { organization: { id: "org-ext-1", urlKey: "acme" } } }) } as unknown as Response);

    const res = await svc.integrationCallback("user-1", "linear", { code: "abc", state: await validState(svc, "linear") });
    expect(res).toEqual({ connectionId: "conn-1", siteUrl: "https://linear.app/acme" });

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO integration_connections"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain("'linear'");
    expect(insertCall!.sql).toContain("ON CONFLICT (organization_id, provider) DO UPDATE");
    const [organizationId, externalId, siteUrl, accessTokenParam, refreshTokenParam, , connectedBy] = insertCall!.params as string[];
    expect(organizationId).toBe("org-1");
    expect(externalId).toBe("org-ext-1");
    expect(siteUrl).toBe("https://linear.app/acme");
    expect(decryptSecret(accessTokenParam)).toBe("linear-access-token");
    expect(decryptSecret(refreshTokenParam)).toBe("linear-refresh-token");
    expect(connectedBy).toBe("user-1");
  });

  it("throws when Jira omits an access or refresh token", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-only" }) } as unknown as Response);

    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state: await validState(svc, "jira") }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/jira did not return oauth tokens/i);
  });

  it("throws when no accessible Jira site is returned", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at", refresh_token: "rt" }) } as unknown as Response) // token exchange
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response); // accessible-resources: empty

    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc", state: await validState(svc, "jira") }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/no accessible jira site/i);
  });

  it("upserts the Jira connection with encrypted tokens on a successful callback", async () => {
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      { match: "INSERT INTO integration_connections", handler: () => ({ rows: [{ id: "conn-jira-1", external_id: "cloud-1", site_url: "https://acme.atlassian.net" }] }) }
    ]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "jira-access-token", refresh_token: "jira-refresh-token", expires_in: 3600 })
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: "cloud-1", url: "https://acme.atlassian.net" }] } as unknown as Response);

    const res = await svc.integrationCallback("user-1", "jira", { code: "abc", state: await validState(svc, "jira") });
    expect(res).toEqual({ connectionId: "conn-jira-1", cloudId: "cloud-1", siteUrl: "https://acme.atlassian.net" });

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO integration_connections"));
    expect(insertCall!.sql).toContain("'jira'");
    const params = insertCall!.params as string[];
    expect(params[1]).toBe("cloud-1");
    expect(decryptSecret(params[3])).toBe("jira-access-token");
    expect(decryptSecret(params[4])).toBe("jira-refresh-token");
  });
});

describe("LegacyService#linkedLinearKeys — issue-linking aggregate", () => {
  it("aggregates linked Linear issue keys and their testcase counts", async () => {
    const { db, calls } = makeDb([{ match: "FROM testcases WHERE project_id", rows: [{ linear_issue_key: "ENG-1", count: 3 }, { linear_issue_key: "ENG-2", count: 1 }] }]);
    const svc = makeLegacy(db);
    const res = await svc.linkedLinearKeys("proj-1");
    expect(res).toEqual({ keys: ["ENG-1", "ENG-2"], counts: { "ENG-1": 3, "ENG-2": 1 } });
    expect(calls[0].params).toEqual(["proj-1"]);
  });

  it("returns empty keys/counts when no testcase links a Linear issue", async () => {
    const { db } = makeDb([{ match: "FROM testcases WHERE project_id", rows: [] }]);
    const svc = makeLegacy(db);
    expect(await svc.linkedLinearKeys("proj-1")).toEqual({ keys: [], counts: {} });
  });
});

/*
 * connectLinearTeams now takes the caller and resolves the project first — it previously took no
 * caller at all, so anyone holding a project id could rewrite which Linear team feeds it. These
 * tests therefore have to satisfy two queries the method makes before its own work starts: the
 * caller's active workspace, and their membership of the project. Both are answered here so each
 * test can keep saying what it is actually about.
 */
const CALLER_ID = "5f9c1f2e-6f3a-4a7e-8b21-000000000001";
const PROJECT_ID = "5f9c1f2e-6f3a-4a7e-8b21-000000000002";

function withProjectAccess(routes: Route[]): Route[] {
  return [
    { match: "JOIN organizations o ON o.id = u.active_organization_id", rows: [{ id: "org-1", role: "owner" }] },
    { match: "JOIN project_members pm ON pm.project_id = p.id", rows: [{ id: PROJECT_ID, organization_id: "org-1", caller_role: "owner" }] },
    ...routes
  ];
}

describe("LegacyService#connectLinearTeams — per-project team mapping", () => {
  it("throws NotFoundException when Linear isn't connected for the project's workspace", async () => {
    const { db } = makeDb(withProjectAccess([{ match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] }, { match: "FROM integration_connections WHERE organization_id", rows: [] }]));
    const svc = makeLegacy(db);
    const err = await rejection(svc.connectLinearTeams(PROJECT_ID, CALLER_ID, { projects: [{ id: "team-1", key: "ENG", name: "Engineering" }] }));
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("disables the previous mapping and links the one well-formed team (drops entries missing id or key)", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] },
      { match: "UPDATE linear_project_mappings SET enabled = false", rows: [] },
      { match: "INSERT INTO linear_project_mappings", rows: [] }
    ]));
    const svc = makeLegacy(db);
    const res = await svc.connectLinearTeams(PROJECT_ID, CALLER_ID, {
      projects: [
        { id: "team-1", key: "ENG", name: "Engineering" },
        { id: "", key: "BAD" }, // missing id -> dropped
        { id: "team-2", key: "", name: "No key" } // missing key -> dropped
      ]
    });
    expect(res).toEqual({ linked: 1 });

    // Disabled, not deleted: the outgoing mapping's tickets and mirrored KB documents still
    // reference it (V72).
    const disableCall = calls.find((c) => c.sql.includes("UPDATE linear_project_mappings SET enabled = false"));
    expect(disableCall!.params).toEqual([PROJECT_ID]);
    expect(calls.some((c) => c.sql.includes("DELETE FROM linear_project_mappings"))).toBe(false);

    const insertCalls = calls.filter((c) => c.sql.includes("INSERT INTO linear_project_mappings"));
    expect(insertCalls).toHaveLength(1);
    // entityType omitted on the request -> defaults to "team", identical to every pre-feature
    // caller's behavior.
    expect(insertCalls[0].params).toEqual(["conn-1", PROJECT_ID, "team-1", "ENG", "Engineering", "team"]);
  });

  it("links zero teams (and still clears old mappings) when the request has no valid teams", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] },
      { match: "UPDATE linear_project_mappings SET enabled = false", rows: [] }
    ]));
    const svc = makeLegacy(db);
    const res = await svc.connectLinearTeams(PROJECT_ID, CALLER_ID, { projects: [] });
    expect(res).toEqual({ linked: 0 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO linear_project_mappings"))).toBe(false);
  });

  // V72 constrains a Tesbo project to exactly one Linear team (idx_linear_project_mappings_one_per_project),
  // so a multi-team request is rejected outright rather than silently linking the first.
  it("rejects a request carrying more than one team", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] }
    ]));
    const svc = makeLegacy(db);
    const err = await rejection(
      svc.connectLinearTeams(PROJECT_ID, CALLER_ID, {
        projects: [
          { id: "team-1", key: "ENG", name: "Engineering" },
          { id: "team-2", key: "OPS", name: "Operations" }
        ]
      })
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(calls.some((c) => c.sql.includes("UPDATE linear_project_mappings SET enabled = false"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO linear_project_mappings"))).toBe(false);
  });
});

// idx_linear_project_mappings_one_per_project (a partial unique index on project_id WHERE
// enabled=true) rejects a second concurrent save-mapping request for the same project. Before this
// was caught, that unique-violation propagated as a raw 500 instead of the same clean 409 the UI
// already renders for any conflict (lib/api.ts's genericStatusMessage).
describe("LegacyService#connectLinearTeams — concurrent save race", () => {
  it("returns a clean 409 instead of a raw DB error when two requests race the same project's mapping", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] },
      { match: "UPDATE linear_project_mappings SET enabled = false", rows: [] },
      {
        match: "INSERT INTO linear_project_mappings",
        handler: () => {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
      }
    ]));
    const svc = makeLegacy(db);
    const err = await rejection(svc.connectLinearTeams(PROJECT_ID, CALLER_ID, { projects: [{ id: "team-1", key: "ENG", name: "Engineering" }] }));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().error).toMatch(/just changed by another action/i);
    // The disable-then-insert pair runs inside one transaction — the UPDATE still ran even though
    // the INSERT lost the race, so the loser's request didn't leave a half-applied write behind.
    expect(calls.some((c) => c.sql.includes("UPDATE linear_project_mappings SET enabled = false"))).toBe(true);
  });
});

// A sync run is org-scoped, not project-scoped, so it can be queued/running for any project mapped
// to this connection when Disconnect is clicked. Settling it first (rather than letting the
// disconnect UPDATE race the sync processor's own concurrent writes to the same
// integration_sync_runs/*_tickets rows) is what rules out the deadlock shape described in
// IntegrationSyncService#failActiveRunsForConnection's own comment.
//
// Disconnect used to DELETE the integration_connections row, which CASCADEd onto every
// jira_tickets/linear_tickets/*_project_mappings row for that connection — silently destroying
// every synced ticket the moment a workspace disconnected. It's now a soft disconnect: the row is
// marked disconnected_at + credentials cleared, and every mapping it fed is disabled, but nothing
// is ever deleted.
describe("LegacyService#integrationDisconnect", () => {
  it("fails any active sync run before soft-disconnecting, and never issues a DELETE", async () => {
    const order: string[] = [];
    const failActiveRunsForConnection = jest.fn(async () => {
      order.push("guard");
    });
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      {
        match: "UPDATE integration_connections SET disconnected_at",
        handler: () => {
          order.push("soft-disconnect");
          return { rows: [] };
        }
      },
      {
        match: "UPDATE linear_project_mappings SET enabled = false",
        handler: () => {
          order.push("disable-mappings");
          return { rows: [] };
        }
      }
    ]);
    const svc = makeLegacy(db, { failActiveRunsForConnection });
    const res = await svc.integrationDisconnect("user-1", "linear");
    expect(res).toEqual({ disconnected: true });
    expect(failActiveRunsForConnection).toHaveBeenCalledWith("org-1", "linear", expect.stringMatching(/disconnected/i));
    expect(order).toEqual(["guard", "soft-disconnect", "disable-mappings"]);
    // No DELETE anywhere in this flow — every ticket/mapping row this connection ever produced
    // must survive a disconnect intact.
    expect(calls.some((c) => c.sql.trim().toUpperCase().startsWith("DELETE"))).toBe(false);
  });

  it("clears live credentials on the soft-disconnected row", async () => {
    const { db, calls } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db, { failActiveRunsForConnection: jest.fn().mockResolvedValue(undefined) });
    await svc.integrationDisconnect("user-1", "jira");
    const updateCall = calls.find((c) => c.sql.includes("UPDATE integration_connections SET disconnected_at"));
    expect(updateCall).toBeDefined();
    // access_token/refresh_token are cleared so a soft-disconnected row can't be used to make a
    // live API call even if some path forgets to check disconnected_at.
    expect(updateCall!.sql).toMatch(/access_token\s*=\s*''/);
    expect(updateCall!.sql).toMatch(/refresh_token\s*=\s*''/);
    expect(updateCall!.params).toEqual(["org-1", "jira"]);
  });
});

// getIntegrationConnection is the single chokepoint every jiraStatus/linearStatus/
// startIntegrationSync/integrationStatus call through — excluding a soft-disconnected row there
// (rather than at each call site) is what makes every one of them correctly report "not connected"
// again after a disconnect, with no other call site needing a change.
describe("LegacyService#jiraStatus — soft-disconnected connection reads as not connected", () => {
  it("reports connected: false when the stored connection row has disconnected_at set", async () => {
    const { db } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      // getIntegrationConnection's own query already filters on disconnected_at IS NULL, so a
      // disconnected row simply never comes back here — the route below proves the query shape.
      { match: "FROM integration_connections WHERE organization_id = $1 AND provider = $2 AND disconnected_at IS NULL", rows: [] }
    ]));
    const svc = makeLegacy(db);
    const status = await svc.jiraStatus(PROJECT_ID, CALLER_ID);
    expect(status).toEqual({ connected: false, connectedProjects: [], history: [] });
  });
});

/*
 * Regression coverage for the reported nightly-cron defect: getIntegrationConnection used to skip
 * refreshing Linear entirely ("Linear tokens are long-lived, no refresh flow needed") — an
 * assumption Linear's own OAuth policy has since broken (it now issues ~24h access tokens with a
 * rotating refresh token). linearTeams (refresh: true) is the public entrypoint that exercises this
 * private method's refresh branch.
 */
describe("LegacyService#getIntegrationConnection — Linear token refresh (via linearTeams)", () => {
  function expiredLinearConnectionRoutes(): Route[] {
    return withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      {
        match: "FROM integration_connections WHERE organization_id",
        rows: [{ id: "conn-1", access_token: encryptSecret("old-access"), refresh_token: encryptSecret("old-refresh"), token_expires_at: new Date(Date.now() - 60_000).toISOString(), auth_method: "oauth" }]
      },
      // The SELECT ... FOR UPDATE re-check inside the refresh transaction — same row, by id.
      {
        match: "FROM integration_connections WHERE id",
        rows: [{ id: "conn-1", access_token: encryptSecret("old-access"), refresh_token: encryptSecret("old-refresh"), token_expires_at: new Date(Date.now() - 60_000).toISOString(), auth_method: "oauth" }]
      },
      { match: "FROM linear_project_mappings WHERE project_id", rows: [] }
    ]);
  }

  beforeEach(() => {
    process.env.LINEAR_CLIENT_ID = "client-id";
    process.env.LINEAR_CLIENT_SECRET = "client-secret";
  });

  it("refreshes an expired Linear token before listing Teams/Projects, and uses the new token for both calls", async () => {
    const { db, calls } = makeDb(expiredLinearConnectionRoutes());
    const authHeaders: string[] = [];
    // Captures the Authorization header sent to the GraphQL calls specifically, so the assertion
    // below can prove they used the freshly refreshed token, not the stale one.
    jest.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "https://api.linear.app/oauth/token") {
        return { ok: true, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) } as unknown as Response;
      }
      authHeaders.push(String(((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization || ""));
      return { ok: true, json: async () => ({ data: { teams: { nodes: [] }, projects: { nodes: [] } } }) } as unknown as Response;
    });

    const svc = makeLegacy(db);
    const result = await svc.linearTeams(PROJECT_ID, CALLER_ID);

    expect(result).toEqual([]);
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === "Bearer new-access")).toBe(true);
    expect(calls.some((c) => c.sql.includes("UPDATE integration_connections SET access_token"))).toBe(true);
  });

  it("throws a clean reconnect message, not a crash, when the refresh token itself is dead", async () => {
    const { db } = makeDb(expiredLinearConnectionRoutes());
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "invalid_grant" })
    } as unknown as Response);

    const svc = makeLegacy(db);
    const err = await rejection(svc.linearTeams(PROJECT_ID, CALLER_ID));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/reconnect/i);
  });
});

// jiraFetch/linearGraphQL used to forward the raw provider response body (up to 500 chars) into
// what the user sees. That's fine for an uncommon status code, but a 401/403 — the token was
// revoked/expired — is common enough (and the raw body unhelpful enough) to deserve its own clean
// message, mirroring what the queued sync path already does via IntegrationConnectionInvalidError.
describe("LegacyService#linearTeams — provider auth failure", () => {
  it("throws a clean reconnect message on a 401, never the raw provider body", async () => {
    const { db } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      {
        match: "FROM integration_connections WHERE organization_id",
        rows: [{ id: "conn-1", access_token: encryptSecret("at"), auth_method: "oauth" }]
      }
    ]));
    // linearTeams now fires two GraphQL calls in parallel (teams + projects) — both must be mocked
    // or the second would fall through to a real network call.
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ errors: [{ message: "Authentication required, not authenticated" }] })
    } as unknown as Response);

    const svc = makeLegacy(db);
    const err = await rejection(svc.linearTeams(PROJECT_ID, CALLER_ID));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/needs to be reconnected/i);
    expect(err.getResponse().detail).toBeUndefined();
    expect(JSON.stringify(err.getResponse())).not.toMatch(/Authentication required, not authenticated/);
  });
});

/*
 * linearTeams was extended to list Linear Projects alongside Teams (Linear's own docs: every issue
 * belongs to exactly one Team, mandatory; a Project is optional and can span multiple Teams — so a
 * user's "my project" can genuinely mean either). These tests cover the merge, the connected-flag
 * computation, and — the part that's easy to get wrong — that the two independent GraphQL calls
 * degrade gracefully on their own but never paper over a connection-wide auth failure.
 */
function connectionRoutes(connectedTeamIds: string[] = []): Route[] {
  return withProjectAccess([
    { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
    { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", access_token: encryptSecret("at"), auth_method: "oauth" }] },
    { match: "FROM linear_project_mappings WHERE project_id", rows: connectedTeamIds.map((id) => ({ linear_team_id: id })) }
  ]);
}

/** Routes `global.fetch` to a Teams or Projects GraphQL response based on the outgoing query text,
 *  since linearTeams fires both calls concurrently via Promise.allSettled. */
function mockLinearFetch(handler: (isTeamsQuery: boolean) => { ok: boolean; status?: number; body?: unknown }) {
  return jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const parsed = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
    const isTeamsQuery = String(parsed.query || "").includes("teams");
    const result = handler(isTeamsQuery);
    if (!result.ok) {
      return { ok: false, status: result.status ?? 500, text: async () => "" } as unknown as Response;
    }
    return { ok: true, json: async () => ({ data: result.body }) } as unknown as Response;
  });
}

describe("LegacyService#linearTeams — merged Team + Project picker", () => {
  it("merges Teams and Projects into one list, tagged and marked connected correctly", async () => {
    mockLinearFetch((isTeamsQuery) =>
      isTeamsQuery
        ? { ok: true, body: { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } } }
        : { ok: true, body: { projects: { nodes: [{ id: "proj-1", name: "Redesign", slugId: "redesign-abc" }] } } }
    );
    const svc = makeLegacy(makeDb(connectionRoutes(["team-1"])).db);
    const result = await svc.linearTeams(PROJECT_ID, CALLER_ID);
    expect(result).toEqual([
      { id: "team-1", key: "ENG", name: "Engineering", style: "", connected: true, entityType: "team" },
      { id: "proj-1", key: "redesign-abc", name: "Redesign", style: "", connected: false, entityType: "project" }
    ]);
  });

  it("uses Project.slugId as the display key, never the internal/nullable identifier field", async () => {
    mockLinearFetch((isTeamsQuery) =>
      isTeamsQuery
        ? { ok: true, body: { teams: { nodes: [] } } }
        : { ok: true, body: { projects: { nodes: [{ id: "proj-1", name: "No lead team", slugId: "no-lead-team-abc", identifier: null }] } } }
    );
    const svc = makeLegacy(makeDb(connectionRoutes()).db);
    const result = await svc.linearTeams(PROJECT_ID, CALLER_ID);
    expect(result).toEqual([{ id: "proj-1", key: "no-lead-team-abc", name: "No lead team", style: "", connected: false, entityType: "project" }]);
  });

  it("degrades to the Teams half when the Projects query fails for a non-auth reason", async () => {
    mockLinearFetch((isTeamsQuery) =>
      isTeamsQuery ? { ok: true, body: { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } } } : { ok: false, status: 500 }
    );
    const svc = makeLegacy(makeDb(connectionRoutes()).db);
    const result = await svc.linearTeams(PROJECT_ID, CALLER_ID);
    expect(result).toEqual([{ id: "team-1", key: "ENG", name: "Engineering", style: "", connected: false, entityType: "team" }]);
  });

  it("degrades to the Projects half when the Teams query fails for a non-auth reason", async () => {
    mockLinearFetch((isTeamsQuery) =>
      isTeamsQuery ? { ok: false, status: 500 } : { ok: true, body: { projects: { nodes: [{ id: "proj-1", name: "Redesign", slugId: "redesign-abc" }] } } }
    );
    const svc = makeLegacy(makeDb(connectionRoutes()).db);
    const result = await svc.linearTeams(PROJECT_ID, CALLER_ID);
    expect(result).toEqual([{ id: "proj-1", key: "redesign-abc", name: "Redesign", style: "", connected: false, entityType: "project" }]);
  });

  it("still throws the clean reconnect message when only the Projects half is auth-rejected", async () => {
    // An expired/revoked token affects the whole connection — a partial list here would leave the
    // user wondering where their data went instead of telling them to reconnect.
    mockLinearFetch((isTeamsQuery) => (isTeamsQuery ? { ok: true, body: { teams: { nodes: [] } } } : { ok: false, status: 401 }));
    const svc = makeLegacy(makeDb(connectionRoutes()).db);
    const err = await rejection(svc.linearTeams(PROJECT_ID, CALLER_ID));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/needs to be reconnected/i);
  });

  it("returns an empty list, not an error, when the workspace has zero Teams and zero Projects", async () => {
    mockLinearFetch(() => ({ ok: true, body: { teams: { nodes: [] }, projects: { nodes: [] } } }));
    const svc = makeLegacy(makeDb(connectionRoutes()).db);
    expect(await svc.linearTeams(PROJECT_ID, CALLER_ID)).toEqual([]);
  });
});

describe("LegacyService#connectLinearTeams — entityType (team vs project)", () => {
  it("accepts entityType 'project' and writes it", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] },
      { match: "UPDATE linear_project_mappings SET enabled = false", rows: [] },
      { match: "INSERT INTO linear_project_mappings", rows: [] }
    ]));
    const svc = makeLegacy(db);
    const res = await svc.connectLinearTeams(PROJECT_ID, CALLER_ID, {
      projects: [{ id: "proj-1", key: "redesign-abc", name: "Redesign", entityType: "project" }]
    });
    expect(res).toEqual({ linked: 1 });
    const insertCalls = calls.filter((c) => c.sql.includes("INSERT INTO linear_project_mappings"));
    expect(insertCalls[0].params).toEqual(["conn-1", PROJECT_ID, "proj-1", "redesign-abc", "Redesign", "project"]);
  });

  it("rejects an unknown entityType with 400, before touching the database", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] }
    ]));
    const svc = makeLegacy(db);
    const err = await rejection(
      svc.connectLinearTeams(PROJECT_ID, CALLER_ID, { projects: [{ id: "x", key: "X", name: "X", entityType: "workspace" }] })
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(calls.some((c) => c.sql.includes("linear_project_mappings"))).toBe(false);
  });

  it("switching an existing mapping from Team to Project disables the old row and inserts the new one", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] },
      { match: "UPDATE linear_project_mappings SET enabled = false", rows: [] },
      { match: "INSERT INTO linear_project_mappings", rows: [] }
    ]));
    const svc = makeLegacy(db);
    await svc.connectLinearTeams(PROJECT_ID, CALLER_ID, { projects: [{ id: "proj-9", key: "slug-9", name: "Launch", entityType: "project" }] });
    expect(calls.some((c) => c.sql.includes("UPDATE linear_project_mappings SET enabled = false"))).toBe(true);
    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO linear_project_mappings"));
    expect(insertCall!.params[5]).toBe("project");
  });
});

// Same mechanism proven for the Team-only case above (idx_linear_project_mappings_one_per_project,
// a partial unique index on project_id WHERE enabled=true) — this pins that adding entity_type to
// the row doesn't change or bypass it: a Project-mapping save racing an existing mapping hits the
// exact same index and gets the exact same clean 409, not a new/different failure mode.
describe("LegacyService#connectLinearTeams — concurrent save race (team vs project)", () => {
  it("returns a clean 409, not a raw DB error, when a Project-mapping save loses the race", async () => {
    const { db, calls } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "oauth" }] },
      { match: "UPDATE linear_project_mappings SET enabled = false", rows: [] },
      {
        match: "INSERT INTO linear_project_mappings",
        handler: () => {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
      }
    ]));
    const svc = makeLegacy(db);
    const err = await rejection(
      svc.connectLinearTeams(PROJECT_ID, CALLER_ID, { projects: [{ id: "proj-1", key: "redesign-abc", name: "Redesign", entityType: "project" }] })
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().error).toMatch(/just changed by another action/i);
    expect(calls.some((c) => c.sql.includes("UPDATE linear_project_mappings SET enabled = false"))).toBe(true);
  });
});

/*
 * Regression coverage for "tickets from all projects are displayed after sync instead of only the
 * selected project": jiraTickets/linearTickets used to filter only by project_id, so every entity
 * this Tesbo project had ever been mapped to (before a switch) stayed mixed into the same result
 * forever. The default (no remoteId) call must now also scope to whichever mapping is *currently*
 * enabled; passing remoteId explicitly opts into browsing one specific past mapping instead.
 */
describe("LegacyService#jiraTickets / #linearTickets — scoped to the currently mapped entity", () => {
  it("jiraTickets defaults to a mapped_remote_id filter against the currently enabled mapping", async () => {
    const { db, calls } = makeDb(withProjectAccess([{ match: "FROM jira_tickets", rows: [] }]));
    const svc = makeLegacy(db);
    await svc.jiraTickets(PROJECT_ID, CALLER_ID, {});
    const countCall = calls.find((c) => c.sql.includes("SELECT COUNT(*)::int AS count FROM jira_tickets"));
    expect(countCall!.sql).toMatch(
      /mapped_remote_id = \(SELECT jira_project_id FROM jira_project_mappings WHERE project_id = \$1 AND enabled = true LIMIT 1\)/
    );
    // No new bound param — the subquery reuses $1 (projectId) rather than adding one. (`values` is
    // reused and later `.push(limit, offset)`ed for the paginated SELECT, so only its first two
    // slots reflect what this COUNT query itself was called with.)
    expect(countCall!.params.slice(0, 2)).toEqual([PROJECT_ID, 25]);
  });

  it("jiraTickets filters by an explicit remoteId instead, to browse a past mapping's tickets", async () => {
    const { db, calls } = makeDb(withProjectAccess([{ match: "FROM jira_tickets", rows: [] }]));
    const svc = makeLegacy(db);
    await svc.jiraTickets(PROJECT_ID, CALLER_ID, { remoteId: "old-project-9" });
    const countCall = calls.find((c) => c.sql.includes("SELECT COUNT(*)::int AS count FROM jira_tickets"));
    expect(countCall!.sql).toContain("mapped_remote_id = $2");
    expect(countCall!.sql).not.toContain("SELECT jira_project_id FROM jira_project_mappings");
    expect(countCall!.params.slice(0, 2)).toEqual([PROJECT_ID, "old-project-9"]);
  });

  it("linearTickets defaults to a mapped_remote_id filter against the currently enabled mapping", async () => {
    const { db, calls } = makeDb(withProjectAccess([{ match: "FROM linear_tickets", rows: [] }]));
    const svc = makeLegacy(db);
    await svc.linearTickets(PROJECT_ID, CALLER_ID, {});
    const countCall = calls.find((c) => c.sql.includes("SELECT COUNT(*)::int AS count FROM linear_tickets"));
    expect(countCall!.sql).toMatch(
      /mapped_remote_id = \(SELECT linear_team_id FROM linear_project_mappings WHERE project_id = \$1 AND enabled = true LIMIT 1\)/
    );
    expect(countCall!.params.slice(0, 2)).toEqual([PROJECT_ID, 25]);
  });
});

// jiraStatusForProject/linearStatus now also return every disabled (no-longer-current) mapping as
// `history`, so the UI can offer a "previously linked" source picker instead of that history being
// reachable only via direct DB inspection — and so that switching mappings never reads as data loss.
describe("LegacyService#jiraStatus / #linearStatus — mapping history", () => {
  it("jiraStatus returns disabled mappings as history, alongside the current one", async () => {
    const { db } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", cloud_id: "cloud-1" }] },
      {
        match: "FROM jira_project_mappings\n       WHERE project_id = $1 AND enabled = true",
        rows: [{ id: "m-2", jira_project_id: "9", jira_project_key: "NEW", jira_project_name: "New Project" }]
      },
      {
        match: "FROM jira_project_mappings\n       WHERE project_id = $1 AND enabled = false",
        rows: [{ id: "m-1", jira_project_id: "1", jira_project_key: "OLD", jira_project_name: "Old Project" }]
      }
    ]));
    const svc = makeLegacy(db);
    const status = await svc.jiraStatus(PROJECT_ID, CALLER_ID);
    expect(status.connected).toBe(true);
    expect(status.connectedProjects).toEqual([expect.objectContaining({ jiraProjectKey: "NEW" })]);
    expect(status.history).toEqual([expect.objectContaining({ jiraProjectKey: "OLD" })]);
  });

  it("linearStatus returns disabled mappings as history, alongside the current one", async () => {
    const { db } = makeDb(withProjectAccess([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1" }] },
      {
        match: "FROM linear_project_mappings\n       WHERE project_id = $1 AND enabled = true",
        rows: [{ id: "m-2", linear_team_id: "team-2", linear_team_key: "NEW", linear_team_name: "New Team" }]
      },
      {
        match: "FROM linear_project_mappings\n       WHERE project_id = $1 AND enabled = false",
        rows: [{ id: "m-1", linear_team_id: "team-1", linear_team_key: "OLD", linear_team_name: "Old Team" }]
      }
    ]));
    const svc = makeLegacy(db);
    const status = await svc.linearStatus(PROJECT_ID, CALLER_ID);
    expect(status.connected).toBe(true);
    expect(status.connectedProjects).toEqual([expect.objectContaining({ linearTeamKey: "NEW" })]);
    expect(status.history).toEqual([expect.objectContaining({ linearTeamKey: "OLD" })]);
  });
});
