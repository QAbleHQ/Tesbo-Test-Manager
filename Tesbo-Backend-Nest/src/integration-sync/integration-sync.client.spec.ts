import { DatabaseService } from "../database/database.service";
import { IntegrationConnectionInvalidError, IntegrationSyncClient } from "./integration-sync.client";

// Test-only key — crypto.util lazily loads it on first encrypt/decrypt call (see linear-integration.spec.ts).
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Regression coverage for the silent-refresh-failure defect behind the reported "Jira sync failed…
 * 401 Unauthorized" screenshot: refreshJiraToken used to swallow a failed Atlassian refresh call and
 * hand back the stale connection, which then hit a real Jira API call and let the raw provider body
 * leak into the run's error field (SyncStatusPanel.tsx renders it verbatim). These tests pin the
 * fixed behavior — a distinct, curated error, a bounded retry, and zero raw-provider text.
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

function makeClient(connection: Record<string, unknown> | null) {
  const updateCalls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT * FROM integration_connections")) {
      return Promise.resolve({ rows: connection ? [connection] : [] });
    }
    if (sql.startsWith("UPDATE integration_connections")) {
      updateCalls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = new IntegrationSyncClient({ query } as unknown as DatabaseService);
  return { client, updateCalls };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

describe("IntegrationSyncClient#loadConnection — Jira token refresh hardening", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JIRA_CLIENT_ID = "client-id";
    process.env.JIRA_CLIENT_SECRET = "client-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("returns the connection unchanged, with no network call, when the token is still valid", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(connectionRow({ token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }));

    const result = await client.loadConnection("org-1", "jira");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.access_token).toBe("old-access");
  });

  it("never attempts a refresh for Linear, even with an expired token", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(connectionRow({ provider: "linear" }));

    const result = await client.loadConnection("org-1", "linear");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.access_token).toBe("old-access");
  });

  it("retries once after a transient failure and succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, false, 503))
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client, updateCalls } = makeClient(connectionRow());

    const result = await client.loadConnection("org-1", "jira");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(1);
    expect(result?.access_token).not.toBe("old-access");
  }, 10_000);

  it("throws a clean IntegrationConnectionInvalidError, with no raw provider body, when both attempts fail", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ code: 401, message: "Unauthorized" }, false, 401));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client, updateCalls } = makeClient(connectionRow());

    await expect(client.loadConnection("org-1", "jira")).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateCalls).toHaveLength(0);

    try {
      await client.loadConnection("org-1", "jira");
      fail("expected loadConnection to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/reconnect/i);
      expect(message).not.toContain("code");
      expect(message).not.toContain("Unauthorized");
      expect(message).not.toContain("401");
    }
  }, 10_000);

  it("throws immediately with zero network calls when no Jira OAuth app is configured", async () => {
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = makeClient(connectionRow());

    await expect(client.loadConnection("org-1", "jira")).rejects.toBeInstanceOf(IntegrationConnectionInvalidError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
