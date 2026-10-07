import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
import { decryptSecret, encryptSecret } from "../common/crypto.util";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

// Throwaway test-only key, same approach as linear-integration.spec.ts.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

type Route = { match: string; rows?: Record<string, unknown>[]; handler?: (params: unknown[]) => { rows: Record<string, unknown>[] } };

function makeDb(routes: Route[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (sql.includes(route.match)) return Promise.resolve(route.handler ? route.handler(params) : { rows: route.rows ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const transaction = jest.fn((fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  return { db: { query, transaction } as unknown as DatabaseService, query, transaction, calls };
}

function workspaceRoute(role: string, orgId = "org-1"): Route {
  return { match: "FROM users u", rows: [{ id: orgId, name: "Acme", slug: "acme", role, created_at: "2024-01-01T00:00:00.000Z" }] };
}

const CALLER_ID = "5f9c1f2e-6f3a-4a7e-8b21-000000000001";
const PROJECT_ID = "5f9c1f2e-6f3a-4a7e-8b21-000000000002";
const DB_ID = "1429989f-e8ac-4eff-bc8f-57f56486db54";
const PAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function withProjectAccess(routes: Route[]): Route[] {
  return [
    { match: "JOIN organizations o ON o.id = u.active_organization_id", rows: [{ id: "org-1", role: "owner" }] },
    { match: "JOIN project_members pm ON pm.project_id = p.id", rows: [{ id: PROJECT_ID, organization_id: "org-1", caller_role: "owner" }] },
    ...routes
  ];
}

/** A connected Notion workspace: project lookup plus a live (never-expiring, no refresh token) connection row. */
function connectedRoutes(extra: Route[] = [], connection: Record<string, unknown> = {}): Route[] {
  return withProjectAccess([
    { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
    {
      match: "FROM integration_connections WHERE organization_id",
      rows: [{ id: "conn-1", access_token: encryptSecret("secret_tok"), refresh_token: "", token_expires_at: "2999-12-31T00:00:00.000Z", auth_method: "oauth", ...connection }]
    },
    ...extra
  ]);
}

function makeLegacy(db: DatabaseService, integrationSync: Partial<IntegrationSyncService> = {}, planLimits?: Partial<PlanLimitsService>): LegacyService {
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
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
    (planLimits ?? { assertIntegrationAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as PlanLimitsService,
    requestCache,
    new ProjectLookupService(db, requestCache),
    {} as unknown as KbExtractionRunnerService,
    new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService),
    new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService),
    new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService),
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

const ENV_KEYS = ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET", "NOTION_REDIRECT_URI", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NOTION_CLIENT_ID = "notion-client";
  process.env.NOTION_CLIENT_SECRET = "notion-secret";
  process.env.NOTION_REDIRECT_URI = "https://app.example.com/integrations/callback";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

async function validState(svc: LegacyService, provider: "jira" | "linear" | "notion" = "notion"): Promise<string> {
  const { url } = await svc.integrationAuthUrl("user-1", provider);
  return new URL(url).searchParams.get("state")!;
}

describe("Notion OAuth: authorize URL", () => {
  it("points at Notion's authorize endpoint with owner=user and NO scope parameter", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const { url } = await makeLegacy(db).integrationAuthUrl("user-1", "notion");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("notion-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/integrations/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("owner")).toBe("user");
    expect(parsed.searchParams.has("scope")).toBe(false);
    expect(parsed.searchParams.get("state")!.startsWith("notion.")).toBe(true);
  });

  it("forbids a non-owner from starting the redirect", async () => {
    const { db } = makeDb([workspaceRoute("manager")]);
    const err = await rejection(makeLegacy(db).integrationAuthUrl("user-1", "notion"));
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("names the Notion env vars when the deployment is not configured", async () => {
    delete process.env.NOTION_CLIENT_SECRET;
    const { db } = makeDb([workspaceRoute("owner")]);
    const err = await rejection(makeLegacy(db).integrationAuthUrl("user-1", "notion"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/NOTION_CLIENT_ID and NOTION_CLIENT_SECRET/);
  });

  it("reports configured status through the generic config route", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    await expect(makeLegacy(db).integrationConfigStatus("user-1", "notion")).resolves.toMatchObject({
      configured: true,
      clientId: "notion-client"
    });
  });
});

describe("Notion OAuth: state handling on the callback", () => {
  const callback = (svc: LegacyService, body: Record<string, unknown>) => svc.integrationCallback("user-1", "notion", body);

  it("rejects a missing code", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const err = await rejection(callback(makeLegacy(db), { state: "x" }));
    expect(err.getResponse().error).toMatch(/authorization code is required/i);
  });

  it("reports a denied consent screen (error param, no code) as cancelled, not as a missing code", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const fetchSpy = jest.spyOn(global, "fetch");
    const err = await rejection(callback(makeLegacy(db), { error: "access_denied", state: "x" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/cancelled or denied/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a forged state and never contacts Notion", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const fetchSpy = jest.spyOn(global, "fetch");
    const err = await rejection(callback(makeLegacy(db), { code: "c", state: "notion.forged.sig" }));
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a tampered payload", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    const [provider, payload, sig] = (await validState(svc)).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), o: "org-evil" })).toString("base64url");
    const err = await rejection(callback(svc, { code: "c", state: `${provider}.${tampered}.${sig}` }));
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
  });

  it("rejects a state signed for another workspace", async () => {
    const issuer = makeLegacy(makeDb([workspaceRoute("owner", "org-A")]).db);
    const state = await validState(issuer);
    const victim = makeLegacy(makeDb([workspaceRoute("owner", "org-B")]).db);
    const err = await rejection(callback(victim, { code: "c", state }));
    expect(err.getResponse().error).toMatch(/different workspace/i);
  });

  it("rejects a Linear-signed state replayed against the Notion callback", async () => {
    process.env.LINEAR_CLIENT_ID = "l";
    process.env.LINEAR_CLIENT_SECRET = "l";
    const svc = makeLegacy(makeDb([workspaceRoute("owner")]).db);
    const err = await rejection(callback(svc, { code: "c", state: await validState(svc, "linear") }));
    expect(err.getResponse().error).toMatch(/invalid authorization state/i);
  });

  it("rejects an expired state", async () => {
    const svc = makeLegacy(makeDb([workspaceRoute("owner")]).db);
    const state = await validState(svc);
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
    const err = await rejection(callback(svc, { code: "c", state }));
    expect(err.getResponse().error).toMatch(/expired/i);
  });

  it("forbids a non-owner and still enforces the plan check for the notion provider", async () => {
    const { db } = makeDb([workspaceRoute("manager")]);
    const denied = await rejection(callback(makeLegacy(db), { code: "c" }));
    expect(denied).toBeInstanceOf(ForbiddenException);

    const assertIntegrationAllowed = jest.fn().mockRejectedValue(new ForbiddenException({ error: "plan" }));
    const owner = makeLegacy(makeDb([workspaceRoute("owner")]).db, {}, { assertIntegrationAllowed });
    await rejection(callback(owner, { code: "c", state: "x" }));
    expect(assertIntegrationAllowed).toHaveBeenCalledWith("org-1", "notion");
  });
});

describe("Notion OAuth: token exchange and connection upsert", () => {
  function exchangeDb() {
    return makeDb([
      workspaceRoute("owner"),
      { match: "INSERT INTO integration_connections", handler: () => ({ rows: [{ id: "conn-1", site_url: "https://www.notion.so" }] }) }
    ]);
  }

  it("exchanges the code with HTTP Basic auth, a JSON body and the Notion-Version header", async () => {
    const { db } = exchangeDb();
    const svc = makeLegacy(db);
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(res(200, { access_token: "secret_abc", workspace_id: "ws-1", workspace_name: "Acme HQ", bot_id: "bot-1" }));
    await svc.integrationCallback("user-1", "notion", { code: "the-code", state: await validState(svc) });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("notion-client:notion-secret").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Notion-Version"]).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://app.example.com/integrations/callback"
    });
  });

  it("stores the workspace id, an encrypted token, an empty refresh token and a far-future expiry", async () => {
    const { db, calls } = exchangeDb();
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, { access_token: "secret_abc", workspace_id: "ws-1", workspace_name: "Acme HQ" }));
    const out = await svc.integrationCallback("user-1", "notion", { code: "c", state: await validState(svc) });
    expect(out).toEqual({ connectionId: "conn-1", siteUrl: "https://www.notion.so", workspaceName: "Acme HQ" });

    const insert = calls.find((c) => c.sql.includes("INSERT INTO integration_connections"))!;
    expect(insert.sql).toContain("'notion'");
    expect(insert.sql).toContain("ON CONFLICT (organization_id, provider) DO UPDATE");
    // Reconnect clears the soft-disconnect and any recorded refresh refusal.
    expect(insert.sql).toContain("disconnected_at = NULL");
    expect(insert.sql).toMatch(/refresh_token\s*=\s*''/);
    const [orgId, externalId, siteUrl, accessToken, expiresAt, connectedBy] = insert.params as string[];
    expect(orgId).toBe("org-1");
    expect(externalId).toBe("ws-1");
    expect(siteUrl).toBe("https://www.notion.so");
    expect(decryptSecret(accessToken)).toBe("secret_abc");
    expect(new Date(expiresAt).getUTCFullYear()).toBe(2999);
    expect(connectedBy).toBe("user-1");
  });

  it("surfaces a rejected exchange as a 400 without leaking the token or secret", async () => {
    const { db } = exchangeDb();
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValue(res(400, { code: "invalid_grant", message: "bad code" }));
    const err = await rejection(svc.integrationCallback("user-1", "notion", { code: "bad", state: await validState(svc) }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/did not accept the authorization code/i);
    expect(JSON.stringify(err.getResponse())).not.toContain("notion-secret");
  });

  it("surfaces a network failure as a 400", async () => {
    const { db } = exchangeDb();
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const err = await rejection(svc.integrationCallback("user-1", "notion", { code: "c", state: await validState(svc) }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/could not reach notion/i);
  });

  it("rejects a response with no access token or workspace id, writing nothing", async () => {
    const { db, calls } = exchangeDb();
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, { workspace_id: "ws-1" }));
    const err = await rejection(svc.integrationCallback("user-1", "notion", { code: "c", state: await validState(svc) }));
    expect(err.getResponse().error).toMatch(/did not return an OAuth token/i);
    expect(calls.some((c) => c.sql.includes("INSERT INTO integration_connections"))).toBe(false);
  });
});

describe("plan gating", () => {
  function planService(effectivePlan: "launch" | "pro") {
    const svc = new PlanLimitsService({} as never, {} as never, {} as never, {} as never, {} as never);
    jest.spyOn(svc as any, "getEntitlement").mockResolvedValue({ effectivePlan });
    return svc;
  }

  it("allows Notion on the Launch plan, for connect and for the nightly check", async () => {
    const svc = planService("launch");
    await expect(svc.assertIntegrationAllowed("org-1", "notion")).resolves.toBeUndefined();
    await expect(svc.isIntegrationAllowed("org-1", "notion")).resolves.toBe(true);
  });

  it("still blocks Linear on Launch and allows it on Pro", async () => {
    await expect(planService("launch").assertIntegrationAllowed("org-1", "linear")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(planService("pro").assertIntegrationAllowed("org-1", "linear")).resolves.toBeUndefined();
  });
});

describe("LegacyService#connectNotionDatabase", () => {
  const dbPayload = { object: "database", id: DB_ID, title: [{ plain_text: "Product specs" }] };

  it("404s when Notion is not connected", async () => {
    const { db } = makeDb(withProjectAccess([{ match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] }]));
    const err = await rejection(makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, { databaseId: DB_ID }));
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("rejects a missing, blank or malformed databaseId before any Notion call", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    for (const body of [{}, { databaseId: "" }, { databaseId: "../users" }, { databaseId: 42 }]) {
      const { db } = makeDb(connectedRoutes());
      const err = await rejection(makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, body));
      expect(err).toBeInstanceOf(BadRequestException);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("verifies the database, disables the old mapping and links the new one under its dashed id", async () => {
    const { db, calls } = makeDb(connectedRoutes());
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(200, dbPayload));
    const out = await makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, { databaseId: DB_ID.replace(/-/g, "").toUpperCase(), databaseName: "  Specs  " });
    expect(out).toEqual({ linked: 1 });
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`https://api.notion.com/v1/databases/${DB_ID}`);

    const disable = calls.find((c) => c.sql.includes("UPDATE notion_project_mappings SET enabled = false"))!;
    expect(disable.params).toEqual([PROJECT_ID]);
    expect(calls.some((c) => c.sql.trim().toUpperCase().startsWith("DELETE"))).toBe(false);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO notion_project_mappings"))!;
    expect(insert.sql).toContain("ON CONFLICT (integration_connection_id, notion_database_id, project_id)");
    expect(insert.params).toEqual(["conn-1", PROJECT_ID, DB_ID, "Specs"]);
  });

  it("falls back to the database's own title when the caller sends no name", async () => {
    const { db, calls } = makeDb(connectedRoutes());
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, dbPayload));
    await makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, { databaseId: DB_ID });
    expect(calls.find((c) => c.sql.includes("INSERT INTO notion_project_mappings"))!.params[3]).toBe("Product specs");
  });

  it("tells the user to share the database when Notion says it is not found, and writes nothing", async () => {
    const { db, calls } = makeDb(connectedRoutes());
    jest.spyOn(global, "fetch").mockResolvedValue(res(404, { code: "object_not_found", message: "Could not find database" }));
    const err = await rejection(makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, { databaseId: DB_ID }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/no longer shared with the Tesbo integration/i);
    expect(calls.some((c) => c.sql.includes("notion_project_mappings"))).toBe(false);
  });

  it("an explicit null databaseId unlinks without calling Notion", async () => {
    const { db, calls } = makeDb(connectedRoutes());
    const fetchSpy = jest.spyOn(global, "fetch");
    const out = await makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, { databaseId: null });
    expect(out).toEqual({ linked: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("UPDATE notion_project_mappings SET enabled = false"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO notion_project_mappings"))).toBe(false);
  });

  it("returns a clean 409 when two requests race the same project's mapping", async () => {
    const { db, calls } = makeDb(
      connectedRoutes([
        {
          match: "INSERT INTO notion_project_mappings",
          handler: () => {
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
          }
        }
      ])
    );
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, dbPayload));
    const err = await rejection(makeLegacy(db).connectNotionDatabase(PROJECT_ID, CALLER_ID, { databaseId: DB_ID }));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().error).toMatch(/just changed by another action/i);
    expect(calls.some((c) => c.sql.includes("UPDATE notion_project_mappings SET enabled = false"))).toBe(true);
  });

  it("lets the same database be linked from two different Tesbo projects (the uniqueness is per project)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, dbPayload));
    for (const projectId of [PROJECT_ID, "5f9c1f2e-6f3a-4a7e-8b21-000000000003"]) {
      const { db, calls } = makeDb(connectedRoutes());
      await makeLegacy(db).connectNotionDatabase(projectId, CALLER_ID, { databaseId: DB_ID });
      expect(calls.find((c) => c.sql.includes("INSERT INTO notion_project_mappings"))!.params.slice(1, 3)).toEqual([projectId, DB_ID]);
    }
  });
});

describe("LegacyService#notionDatabases", () => {
  const database = (id: string, title: string) => ({ object: "database", id, title: [{ plain_text: title }], url: `https://notion.so/${id}` });

  it("lists shared databases alphabetically, follows pagination and marks the connected one", async () => {
    const { db } = makeDb(connectedRoutes([{ match: "FROM notion_project_mappings WHERE project_id", rows: [{ notion_database_id: "db-b" }] }]));
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(res(200, { results: [database("db-b", "Zeta"), database("db-a", "Alpha")], has_more: true, next_cursor: "c2" }))
      .mockResolvedValueOnce(res(200, { results: [{ ...database("db-c", "Gone"), in_trash: true }, { object: "database", id: "db-d", title: [] }], has_more: false }));
    const list = await makeLegacy(db).notionDatabases(PROJECT_ID, CALLER_ID);
    expect(list.map((d) => [d.name, d.connected])).toEqual([
      ["Alpha", false],
      ["Untitled database", false],
      ["Zeta", true]
    ]);
    const first = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(first.filter).toEqual({ property: "object", value: "database" });
    expect(JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body)).start_cursor).toBe("c2");
  });

  it("returns [] (not an error) when nothing is shared with the integration", async () => {
    const { db } = makeDb(connectedRoutes());
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, { results: [], has_more: false }));
    await expect(makeLegacy(db).notionDatabases(PROJECT_ID, CALLER_ID)).resolves.toEqual([]);
  });

  it("never attempts a token refresh, even when the stored expiry is in the past", async () => {
    const { db, transaction } = makeDb(connectedRoutes([], { token_expires_at: "2001-01-01T00:00:00.000Z", refresh_token: "stale" }));
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(200, { results: [], has_more: false }));
    await makeLegacy(db).notionDatabases(PROJECT_ID, CALLER_ID);
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("api.notion.com/v1/search");
  });

  it("asks the user to reconnect on a 401, never echoing the raw Notion body", async () => {
    const { db } = makeDb(connectedRoutes());
    jest.spyOn(global, "fetch").mockResolvedValue(res(401, { code: "unauthorized", message: "API token is invalid." }));
    const err = await rejection(makeLegacy(db).notionDatabases(PROJECT_ID, CALLER_ID));
    expect(err.getResponse().error).toMatch(/needs to be reconnected/i);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/API token is invalid/);
  });

  it("404s when Notion is not connected", async () => {
    const { db } = makeDb(withProjectAccess([{ match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] }]));
    expect(await rejection(makeLegacy(db).notionDatabases(PROJECT_ID, CALLER_ID))).toBeInstanceOf(NotFoundException);
  });
});

describe("LegacyService#integrationDisconnect / integrationStatus for notion", () => {
  it("soft-disconnects and disables notion mappings, never deleting", async () => {
    const { db, calls } = makeDb([workspaceRoute("owner")]);
    const failActiveRunsForConnection = jest.fn().mockResolvedValue(undefined);
    const out = await makeLegacy(db, { failActiveRunsForConnection }).integrationDisconnect("user-1", "notion");
    expect(out).toEqual({ disconnected: true });
    expect(failActiveRunsForConnection).toHaveBeenCalledWith("org-1", "notion", expect.stringMatching(/disconnected/i));
    const soft = calls.find((c) => c.sql.includes("UPDATE integration_connections SET disconnected_at"))!;
    expect(soft.params).toEqual(["org-1", "notion"]);
    expect(soft.sql).toMatch(/access_token\s*=\s*''/);
    const disable = calls.find((c) => c.sql.includes("UPDATE notion_project_mappings SET enabled = false"))!;
    expect(disable.sql).toContain("integration_connection_id");
    expect(calls.some((c) => c.sql.trim().toUpperCase().startsWith("DELETE"))).toBe(false);
  });

  it("forbids a non-owner from disconnecting", async () => {
    const { db } = makeDb([workspaceRoute("qa_engineer")]);
    expect(await rejection(makeLegacy(db).integrationDisconnect("user-1", "notion"))).toBeInstanceOf(ForbiddenException);
  });

  it("reports connected projects from notion_project_mappings", async () => {
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", site_url: "https://www.notion.so", refresh_token: "" }] },
      { match: "FROM notion_project_mappings m", rows: [{ project_id: "p1", project_name: "Web", project_key: "WEB" }] }
    ]);
    const out: any = await makeLegacy(db).integrationStatus("user-1", "notion");
    expect(out.connected).toBe(true);
    expect(out.connectedProjects).toEqual([{ projectId: "p1", projectName: "Web", projectKey: "WEB" }]);
    expect(calls.some((c) => c.sql.includes("FROM notion_project_mappings m"))).toBe(true);
  });

  it("an unknown provider is still rejected", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    expect(await rejection(makeLegacy(db).integrationStatus("user-1", "github"))).toBeInstanceOf(BadRequestException);
  });
});

describe("LegacyService#notionComment", () => {
  it("posts a page comment with the page parent and rich_text, chunked under 2000 characters", async () => {
    const { db } = makeDb(connectedRoutes());
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(200, { id: "comment-1" }));
    await makeLegacy(db).notionComment(PROJECT_ID, CALLER_ID, { pageId: PAGE_ID, comment: "y".repeat(4500) });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/comments");
    const body = JSON.parse(String(init.body));
    expect(body.parent).toEqual({ page_id: PAGE_ID });
    expect(body.rich_text.length).toBe(3);
    expect(body.rich_text.every((r: any) => r.text.content.length <= 2000)).toBe(true);
    expect(body.rich_text.map((r: any) => r.text.content).join("")).toBe("y".repeat(4500));
  });

  it("requires a valid page id and a comment", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    for (const body of [{ comment: "hi" }, { pageId: PAGE_ID }, { pageId: "nope", comment: "hi" }]) {
      const { db } = makeDb(connectedRoutes());
      expect(await rejection(makeLegacy(db).notionComment(PROJECT_ID, CALLER_ID, body))).toBeInstanceOf(BadRequestException);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Zyra ticket auto-comment for Notion", () => {
  it("groups committed rows by Notion page id alongside Jira and Linear", () => {
    const svc = makeLegacy(makeDb().db) as any;
    const groups = svc.zyraTicketCommentGroups(
      [
        { id: "t1", notionPageId: PAGE_ID },
        { id: "t2", notionPageId: PAGE_ID, jiraIssueKey: "KAN-1" },
        { id: "t3" }
      ],
      ["add", "update", "add"]
    );
    const notion = groups.find((g: any) => g.provider === "notion");
    expect(notion.issueKey).toBe(PAGE_ID);
    expect(notion.entries.map((e: any) => e.row.id)).toEqual(["t1", "t2"]);
    expect(groups.find((g: any) => g.provider === "jira").entries).toHaveLength(1);
  });

  it("names the page by its title in the comment and posts nothing for an unconnected workspace", async () => {
    const claims: unknown[][] = [];
    const { db } = makeDb([
      { match: "FROM projects WHERE id", rows: [{ id: PROJECT_ID, organization_id: "org-1", settings: { notionAutoComment: true } }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [] },
      { match: "SELECT summary FROM notion_pages", rows: [{ summary: "Checkout spec" }] },
      {
        match: "INSERT INTO integration_ticket_comments",
        handler: (params) => {
          claims.push(params);
          return { rows: [{ id: "claim-1" }] };
        }
      }
    ]);
    const svc = makeLegacy(db) as any;
    jest.spyOn(svc, "getProject").mockResolvedValue({ settings: { notionAutoComment: true } });
    await svc.queueZyraTicketComments(PROJECT_ID, "u", "task-1", "save-1", [{ id: "t1", externalId: "TC-1", title: "Pays", notionPageId: PAGE_ID }], ["add"]);
    expect(claims).toHaveLength(1);
    expect(claims[0][3]).toBe("notion");
    expect(claims[0][4]).toBe(PAGE_ID);
    expect(claims[0][6]).toBe("skipped_not_connected");
    expect(String(claims[0][7])).toContain("Zyra saved 1 test case for Checkout spec in Tesbo.");
  });

  it("records the comment as posted with Notion's comment id", async () => {
    const updates: unknown[][] = [];
    const { db } = makeDb(
      connectedRoutes([
        { match: "UPDATE integration_ticket_comments SET status = 'posted'", handler: (p) => (updates.push(p), { rows: [] }) },
        { match: "SELECT summary FROM notion_pages", rows: [{ summary: "Checkout spec" }] }
      ])
    );
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, { id: "notion-comment-9" }));
    const svc = makeLegacy(db) as any;
    await svc.deliverZyraTicketComment(PROJECT_ID, "task-1", "claim-1", "notion", PAGE_ID, 1, { markdown: "**Generated by Tesbo**\n- [TC-1](https://a.test) Pays", adf: {} });
    expect(updates).toEqual([["claim-1", "notion-comment-9"]]);
  });

  it("records a failed ledger row with a readable reason when the integration lacks the insert-comment capability", async () => {
    const failures: unknown[][] = [];
    const { db } = makeDb(
      connectedRoutes([
        { match: "SET status = 'failed'", handler: (p) => (failures.push(p), { rows: [] }) },
        { match: "SELECT summary FROM notion_pages", rows: [{ summary: "Checkout spec" }] }
      ])
    );
    jest.spyOn(global, "fetch").mockResolvedValue(res(403, { code: "restricted_resource", message: "Insufficient permissions for this endpoint." }));
    const svc = makeLegacy(db) as any;
    await svc.deliverZyraTicketComment(PROJECT_ID, "task-1", "claim-1", "notion", PAGE_ID, 1, { markdown: "hello", adf: {} });
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe("claim-1");
    expect(String(failures[0][1])).toMatch(/no access to this Notion page|Connections/i);
  });

  it("records the capability reason for a non-restricted 403", async () => {
    const failures: unknown[][] = [];
    const { db } = makeDb(
      connectedRoutes([
        { match: "SET status = 'failed'", handler: (p) => (failures.push(p), { rows: [] }) },
        { match: "SELECT summary FROM notion_pages", rows: [] }
      ])
    );
    jest.spyOn(global, "fetch").mockResolvedValue(res(403, { code: "restricted_resource_capability", message: "Insufficient permissions for this endpoint." }));
    await (makeLegacy(db) as any).deliverZyraTicketComment(PROJECT_ID, "task-1", "claim-1", "notion", PAGE_ID, 1, { markdown: "hello", adf: {} });
    expect(String(failures[0][1])).toMatch(/missing a required capability/i);
    expect(String(failures[0][1])).toMatch(/insert comments/i);
  });

  it("records a failure when the page is no longer shared (404)", async () => {
    const failures: unknown[][] = [];
    const { db } = makeDb(
      connectedRoutes([
        { match: "SET status = 'failed'", handler: (p) => (failures.push(p), { rows: [] }) },
        { match: "SELECT summary FROM notion_pages", rows: [] }
      ])
    );
    jest.spyOn(global, "fetch").mockResolvedValue(res(404, { code: "object_not_found", message: "Could not find page" }));
    await (makeLegacy(db) as any).deliverZyraTicketComment(PROJECT_ID, "task-1", "claim-1", "notion", PAGE_ID, 1, { markdown: "hello", adf: {} });
    expect(String(failures[0][1])).toMatch(/no longer shared/i);
  });
});

describe("Notion pages, snapshots and linking", () => {
  it("notionPages scopes to the mapped database, hides archived pages and exposes the page id for linking", async () => {
    const { db, calls } = makeDb(
      withProjectAccess([
        { match: "SELECT COUNT(*)::int AS count FROM notion_pages", rows: [{ count: 1 }] },
        { match: "SELECT * FROM notion_pages", rows: [{ id: "r1", notion_page_id: PAGE_ID, notion_page_key: "notion:aaaaaaaa", summary: "Spec" }] }
      ])
    );
    const out = await makeLegacy(db).notionPages(PROJECT_ID, CALLER_ID, { coverage: "uncovered", search: "spec" });
    expect(out).toEqual({ list: [{ id: "r1", notionPageId: PAGE_ID, notionPageKey: "notion:aaaaaaaa", summary: "Spec" }], total: 1 });
    const list = calls.find((c) => c.sql.includes("SELECT * FROM notion_pages"))!;
    expect(list.sql).toContain("archived = false");
    expect(list.sql).toContain("mapped_remote_id = (SELECT notion_database_id FROM notion_project_mappings");
    expect(list.sql).toContain("t.notion_page_id = notion_pages.notion_page_id");
  });

  it("allTickets and requirementsSummary include a notion source", async () => {
    const { db, calls } = makeDb(withProjectAccess([]));
    const svc = makeLegacy(db);
    await svc.allTickets(PROJECT_ID, CALLER_ID, {});
    expect(calls.find((c) => c.sql.includes("FROM notion_pages"))!.sql).toContain("'notion' AS source");
    const summary: any = await svc.requirementsSummary(PROJECT_ID, CALLER_ID);
    expect(summary.notion).toMatchObject({ total: 0, covered: 0, uncovered: 0 });
    expect(Object.keys(summary)).toEqual(["all", "jira", "linear", "notion"]);
  });

  it("notionSnapshot reads only the cache and falls back for an uncached page", async () => {
    const { db } = makeDb([
      {
        match: "FROM notion_pages",
        rows: [{ notion_page_id: PAGE_ID, notion_page_key: "notion:aaaaaaaa", summary: "Spec", description: "Body", status: "Open", properties_json: { Owner: "Ada" } }]
      }
    ]);
    const fetchSpy = jest.spyOn(global, "fetch");
    const out = await (makeLegacy(db) as any).notionSnapshot(PROJECT_ID, [PAGE_ID, "uncached-id"]);
    expect(out[0]).toEqual({ key: "notion:aaaaaaaa", summary: "Spec", description: "- **Owner:** Ada\n\nBody", status: "Open" });
    expect(out[1].summary).toBe("Selected Notion page");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("zyraTicketFromKnowledgeSelection resolves a Notion mirror document to its page id", async () => {
    const { db, calls } = makeDb([{ match: "FROM knowledge_documents d", rows: [{ provider: "notion", issue_key: PAGE_ID }] }]);
    const out = await (makeLegacy(db) as any).zyraTicketFromKnowledgeSelection(PROJECT_ID, ["5f9c1f2e-6f3a-4a7e-8b21-0000000000aa"]);
    expect(out.linked).toEqual({ provider: "notion", issueKey: PAGE_ID });
    expect(calls[0].sql).toContain("LEFT JOIN notion_pages n");
    expect(calls[0].sql).toContain("'notion'");
  });

  it("linkedNotionPages reports linked page ids with their test case counts", async () => {
    const { db } = makeDb(
      withProjectAccess([
        { match: "FROM testcases WHERE project_id", rows: [{ notion_page_id: PAGE_ID, count: 2 }] },
        { match: "FROM ai_generation_requests", rows: [] }
      ])
    );
    const out = await makeLegacy(db).linkedNotionPages(PROJECT_ID, CALLER_ID);
    expect(out).toEqual({ keys: [PAGE_ID], counts: { [PAGE_ID]: 2 }, tasks: {} });
  });

  it("the KB read-only guard names Notion for a Notion mirror", async () => {
    const { db } = makeDb([]);
    const svc = makeLegacy(db) as any;
    jest.spyOn(svc, "requireUser").mockReturnValue("u");
    jest.spyOn(svc, "requireProjectAccess").mockResolvedValue(undefined);
    jest.spyOn(svc, "kbDocument").mockResolvedValue({ id: "d", title: "Spec", is_read_only: true, source_provider: "notion", created_by: "u" });
    jest.spyOn(svc, "kbProjectRole").mockResolvedValue("owner");
    jest.spyOn(svc, "kbRequireMutateAccess").mockReturnValue(undefined);
    const err = await rejection(svc.updateKnowledgeDocument(PROJECT_ID, "u", "5f9c1f2e-6f3a-4a7e-8b21-0000000000bb", { title: "x" }));
    expect(err.getResponse().error).toMatch(/synced from Notion/);
  });
});

describe("Archive sweep lookup for a Notion page", () => {
  function sweepLegacy(routes: Route[] = []) {
    return makeLegacy(makeDb(connectedRoutes(routes)).db);
  }

  it("treats an archived or trashed page as done", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, { id: PAGE_ID, archived: false, in_trash: true }));
    await expect(sweepLegacy().fetchLiveTicketCategory(PROJECT_ID, "notion", PAGE_ID)).resolves.toMatchObject({ found: true, doneness: "done", rawCategory: "archived", reason: "ok" });
  });

  it("treats a live page as not done", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(res(200, { id: PAGE_ID, archived: false }));
    await expect(sweepLegacy().fetchLiveTicketCategory(PROJECT_ID, "notion", PAGE_ID)).resolves.toMatchObject({ doneness: "not_done", rawCategory: "active" });
  });

  it("reports a 404 as not_found, never as done", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(res(404, { code: "object_not_found", message: "gone" }));
    await expect(sweepLegacy().fetchLiveTicketCategory(PROJECT_ID, "notion", PAGE_ID)).resolves.toMatchObject({ found: false, doneness: null, reason: "not_found" });
  });

  it("reports an unexpected failure as error and a malformed id as not_found without calling Notion", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(500, { message: "boom" }));
    await expect(sweepLegacy().fetchLiveTicketCategory(PROJECT_ID, "notion", PAGE_ID)).resolves.toMatchObject({ reason: "error" });
    fetchSpy.mockClear();
    await expect(sweepLegacy().fetchLiveTicketCategory(PROJECT_ID, "notion", "not-an-id")).resolves.toMatchObject({ reason: "not_found" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not_connected when Notion is not connected", async () => {
    const { db } = makeDb([{ match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] }]);
    await expect(makeLegacy(db).fetchLiveTicketCategory(PROJECT_ID, "notion", PAGE_ID)).resolves.toMatchObject({ reason: "not_connected" });
  });
});

describe("startIntegrationSync for notion", () => {
  it("queues a run keyed by the mapped database id", async () => {
    const startRun = jest.fn().mockResolvedValue({ run: { id: "run-1" }, alreadyRunning: false });
    const { db } = makeDb(connectedRoutes([{ match: "FROM notion_project_mappings WHERE project_id", rows: [{ remote_key: DB_ID }] }]));
    const out = await makeLegacy(db, { startRun }).syncNotion(CALLER_ID, PROJECT_ID);
    expect(startRun).toHaveBeenCalledWith("org-1", PROJECT_ID, "notion", CALLER_ID, DB_ID);
    expect(out.alreadyRunning).toBe(false);
  });

  it("asks the user to link a database first when none is mapped", async () => {
    const { db } = makeDb(connectedRoutes());
    const err = await rejection(makeLegacy(db, { startRun: jest.fn() }).syncNotion(CALLER_ID, PROJECT_ID));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/Link a Notion database/);
  });
});

describe("test case writes carry the Notion link", () => {
  /** Highest $N placeholder in a statement, to prove the parameter array was extended in step with the SQL. */
  const maxPlaceholder = (sql: string) => Math.max(...Array.from(sql.matchAll(/\$(\d+)/g), (m) => Number(m[1])));

  function capturingClient(row: Record<string, unknown> = { id: "tc-1", project_id: PROJECT_ID }) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        return { rows: [row] };
      })
    };
    return { client, statements };
  }

  function serviceWithStubs() {
    const svc = makeLegacy(makeDb().db) as any;
    svc.customFields = { setValuesForTestCase: jest.fn().mockResolvedValue(undefined) };
    svc.customTags = { setTagsForTestCase: jest.fn().mockResolvedValue(undefined), copyTags: jest.fn() };
    svc.ragIngestion = { enqueueTestcaseEmbedding: jest.fn().mockResolvedValue(undefined), enqueueEmbedding: jest.fn().mockResolvedValue(undefined) };
    return svc;
  }

  it("insert writes notion_page_id and notion_url with matching placeholders", async () => {
    const { client, statements } = capturingClient();
    await serviceWithStubs().insertTestCaseWithClient(client, PROJECT_ID, CALLER_ID, { externalId: "TC-1", title: "t", notionPageId: PAGE_ID, notionUrl: "https://www.notion.so/p" });
    const insert = statements.find((s) => s.sql.includes("INSERT INTO testcases"))!;
    expect(insert.sql).toContain("notion_page_id, notion_url");
    expect(maxPlaceholder(insert.sql)).toBe(insert.params.length);
    expect(insert.params.slice(-2)).toEqual([PAGE_ID, "https://www.notion.so/p"]);
  });

  it("update sets the link, and an explicit null or empty id clears both columns", async () => {
    const svc = serviceWithStubs();
    for (const [body, link, clears] of [
      [{ notionPageId: PAGE_ID, notionUrl: "u" }, [PAGE_ID, "u"], false],
      [{ notionPageId: null }, [null, null], true],
      [{ notionPageId: "" }, ["", null], true], // the CASE WHEN clear flag wins over the bound value
      [{ title: "untouched" }, [null, null], false]
    ] as const) {
      const { client, statements } = capturingClient();
      await svc.updateTestCaseWithClient(client, PROJECT_ID, "tc-1", CALLER_ID, body);
      const update = statements.find((s) => s.sql.includes("UPDATE testcases SET"))!;
      expect(maxPlaceholder(update.sql)).toBe(update.params.length);
      expect(update.params.slice(-3)).toEqual([...link, clears]);
    }
  });

  it("duplicate copies the link", async () => {
    const svc = serviceWithStubs();
    const { client, statements } = capturingClient();
    jest.spyOn(svc, "nextExternalId").mockResolvedValue("TC-2");
    (svc.db as any).transaction = async (fn: (c: unknown) => unknown) => fn(client);
    (svc.db as any).query = jest.fn().mockResolvedValue({ rows: [{ id: "tc-1", project_id: PROJECT_ID, title: "t", notion_page_id: PAGE_ID, notion_url: "u", deleted_at: null }] });
    jest.spyOn(svc, "logProjectActivity").mockResolvedValue(undefined);
    jest.spyOn(svc, "requireUser").mockReturnValue(CALLER_ID);
    jest.spyOn(svc, "requireProjectAccess").mockResolvedValue(undefined);
    jest.spyOn(svc.suitesCache, "invalidate").mockResolvedValue(undefined);
    jest.spyOn(svc.testcasesListCache, "invalidate").mockResolvedValue(undefined);
    svc.customFields.copyValues = jest.fn();
    await svc.duplicateTestCase(CALLER_ID, "tc-1").catch(() => undefined);
    const insert = statements.find((s) => s.sql.includes("INSERT INTO testcases"));
    expect(insert).toBeDefined();
    expect(maxPlaceholder(insert!.sql)).toBe(insert!.params.length);
    expect(insert!.params.slice(-2)).toEqual([PAGE_ID, "u"]);
  });

  it("the Zyra batch insert writes the link on every new row", async () => {
    const svc = serviceWithStubs();
    const { client, statements } = capturingClient();
    jest.spyOn(svc, "externalIdPrefix").mockResolvedValue("TC");
    jest.spyOn(svc, "maxExternalIdSeq").mockResolvedValue(0);
    await svc.zyraBatchInsertTestCases(client, PROJECT_ID, CALLER_ID, [{ title: "a", notionPageId: PAGE_ID, notionUrl: "u" }, { title: "b" }]).catch(() => undefined);
    const insert = statements.find((s) => s.sql.includes("INSERT INTO testcases"))!;
    const rows = JSON.parse(String(insert.params[2]));
    expect(rows.map((r: any) => r.notion_page_id)).toEqual([PAGE_ID, null]);
    expect(insert.sql).toContain("notion_page_id text, notion_url text");
  });
});
