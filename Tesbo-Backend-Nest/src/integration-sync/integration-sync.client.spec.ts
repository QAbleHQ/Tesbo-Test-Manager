import { DatabaseService } from "../database/database.service";
import { IntegrationConnectionInvalidError, IntegrationSyncClient } from "./integration-sync.client";

// Test-only key — crypto.util lazily loads it on first encrypt/decrypt call (see linear-integration.spec.ts).
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Regression coverage for two related defects:
 *
 * 1. The original "Jira sync failed… 401 Unauthorized" screenshot: refreshJiraToken used to
 *    swallow a failed Atlassian refresh call and hand back the stale connection, which then hit a
 *    real Jira API call and let the raw provider body leak into the run's error field
 *    (SyncStatusPanel.tsx renders it verbatim).
 * 2. Its Linear twin, reported later: loadConnection used to skip refreshing Linear entirely
 *    ("Linear tokens are long-lived, no refresh flow needed") — an assumption Linear's own OAuth
 *    policy has since broken (it now issues ~24h access tokens with a rotating refresh token), so
 *    every Linear connection older than a day 401ed on every future sync, nightly cron included,
 *    with the raw provider body leaking the same way.
 *
 * These tests pin the fixed behavior for both providers — a distinct, curated error, a bounded
 * retry, zero raw-provider text — plus the concurrency guard that keeps two sync jobs sharing one
 * organization's connection from racing the provider's refresh endpoint against each other.
 */

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    organization_id: "org-1",
    provider: "jira",
    access_token: "old-access",
    refresh_token: "refresh-abc",
    // Expired well past loadConnection's 60s buffer, so refresh is always attempted unless overridden.
    token_expires_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides
  };
}

/**
 * `currentRow` is mutated by a successful UPDATE, mirroring real Postgres row-level consistency —
 * this is what lets a test prove the "re-check under the lock" logic: a second loadConnection call
 * (or the FOR UPDATE re-read inside one already in flight) sees the row a prior refresh just wrote,
 * not the stale snapshot the outer, lock-free SELECT first saw.
 */
function makeClient(connection: Record<string, unknown> | null) {
  const updateCalls: Array<{ sql: string; params: unknown[] }> = [];
  let currentRow = connection;
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT * FROM integration_connections")) {
      return Promise.resolve({ rows: currentRow ? [currentRow] : [] });
    }
    if (sql.startsWith("UPDATE integration_connections")) {
      updateCalls.push({ sql, params });
      currentRow = { ...currentRow, access_token: params[1], refresh_token: params[2], token_expires_at: params[3] };
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  // Real DatabaseService.transaction hands the callback a PoolClient wrapping BEGIN/COMMIT/ROLLBACK
  // around it; this double only needs to run the callback against the same routed `query`, matching
  // the pattern already established in linear-integration.spec.ts's makeDb.
  const transaction = jest.fn((fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  const client = new IntegrationSyncClient({ query, transaction } as unknown as DatabaseService);
  return { client, updateCalls, query, transaction };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

describe.each<{ provider: "jira" | "linear"; providerLabel: string; tokenUrl: string; envPrefix: string }>([
  { provider: "jira", providerLabel: "Jira", tokenUrl: "https://auth.atlassian.com/oauth/token", envPrefix: "JIRA" },
  { provider: "linear", providerLabel: "Linear", tokenUrl: "https://api.linear.app/oauth/token", envPrefix: "LINEAR" }
])("IntegrationSyncClient#loadConnection — $provider token refresh hardening", ({ provider, providerLabel, tokenUrl, envPrefix }) => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env[`${envPrefix}_CLIENT_ID`] = "client-id";
    process.env[`${envPrefix}_CLIENT_SECRET`] = "client-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("returns the connection unchanged, with no network call, when the token is still valid", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client, transaction } = makeClient(connectionRow({ provider, token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }));

    const result = await client.loadConnection("org-1", provider);

    expect(fetchMock).not.toHaveBeenCalled();
    // The fast, lock-free path: a valid token never opens a transaction at all.
    expect(transaction).not.toHaveBeenCalled();
    expect(result?.access_token).toBe("old-access");
  });

  it("refreshes an expired token and persists the new value", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client, updateCalls } = makeClient(connectionRow({ provider }));

    const result = await client.loadConnection("org-1", provider);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(tokenUrl);
    expect(updateCalls).toHaveLength(1);
    expect(result?.access_token).not.toBe("old-access");
  });

  it("retries once after a transient failure and succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, false, 503))
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client, updateCalls } = makeClient(connectionRow({ provider }));

    const result = await client.loadConnection("org-1", provider);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(1);
    expect(result?.access_token).not.toBe("old-access");
  }, 10_000);

  it("throws a clean IntegrationConnectionInvalidError, with no raw provider body, when both attempts fail", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: 401, message: "Unauthorized" }, false, 401));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client, updateCalls } = makeClient(connectionRow({ provider }));

    await expect(client.loadConnection("org-1", provider)).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(0);

    try {
      await client.loadConnection("org-1", provider);
      fail("expected loadConnection to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/reconnect/i);
      expect(message).not.toContain("code");
      expect(message).not.toContain("Unauthorized");
      expect(message).not.toContain("401");
    }
  }, 10_000);

  it(`throws immediately with zero network calls when no ${providerLabel} OAuth app is configured`, async () => {
    delete process.env[`${envPrefix}_CLIENT_ID`];
    delete process.env[`${envPrefix}_CLIENT_SECRET`];
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(connectionRow({ provider }));

    await expect(client.loadConnection("org-1", provider)).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a second call after a refresh already landed reuses the fresh token, with no second refresh call", async () => {
    // Simulates the concurrency guard's effect (not literal thread concurrency, which Jest can't
    // exercise against a real Postgres lock): the SELECT ... FOR UPDATE re-check inside the
    // transaction always reads the CURRENT row, so a job that reaches the lock after another job's
    // refresh already committed sees a fresh token and skips refreshing again — exactly what
    // prevents two concurrent jobs from racing the provider's refresh endpoint (which both
    // Linear's and Atlassian's OAuth apps answer by rotating the refresh token, breaking whichever
    // call loses the race).
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(connectionRow({ provider }));

    const first = await client.loadConnection("org-1", provider);
    const second = await client.loadConnection("org-1", provider);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second?.access_token).toBe(first?.access_token);
  });
});

describe("IntegrationSyncClient — auth failures from the actual data-fetch calls are never leaked as raw provider text", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("fetchLinearTickets surfaces an HTTP 401 as IntegrationConnectionInvalidError, not a raw Error", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "Authentication required" }] }, false, 401));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(null);

    const connection = connectionRow({ provider: "linear", token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    await expect(client.fetchLinearTickets(connection, "team-1", async () => undefined)).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
  });

  it("fetchLinearTickets surfaces an HTTP 200 GraphQL-level AUTHENTICATION_ERROR as IntegrationConnectionInvalidError", async () => {
    // The exact shape from the reported run failure: 401 at the GraphQL layer, not the transport
    // layer — res.ok is true, but payload.errors carries extensions.code "AUTHENTICATION_ERROR".
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        errors: [
          {
            message: "Authentication required, not authenticated",
            extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", statusCode: 401 }
          }
        ]
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(null);

    const connection = connectionRow({ provider: "linear", token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    await expect(client.fetchLinearTickets(connection, "team-1", async () => undefined)).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
  });

  it("fetchJiraTickets surfaces an HTTP 401 as IntegrationConnectionInvalidError, not a raw Error", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: 401, message: "Unauthorized" }, false, 401));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(null);

    const connection = connectionRow({ provider: "jira", token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), external_id: "cloud-1" });
    await expect(client.fetchJiraTickets(connection, "ENG", async () => undefined)).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
  });
});
