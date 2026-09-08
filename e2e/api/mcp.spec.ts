import fs from "node:fs";
import path from "node:path";
import { expect, test, request as newRequestContext } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

async function createCase(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
    data: { title: `E2E ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteCase(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
}

/**
 * Calls the MCP JSON-RPC endpoint and unwraps the tool's JSON payload from the
 * `content: [{ type: "text", text }]` envelope every tool response is wrapped in
 * (mcp.service.ts callTool).
 *
 * Takes a cookie-free APIRequestContext, not the suite's shared `request` fixture: AuthMiddleware
 * only falls back to the Authorization bearer header "when there is no valid browser session"
 * (auth.middleware.ts), and the shared fixture carries account A's session cookie from
 * global-setup.ts's storageState. Sent together, the cookie wins, req.apiToken stays null, and
 * McpController rejects the call — a real MCP client never presents a session cookie, so this
 * mirrors what one actually sends.
 */
async function callMcpTool(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  toolName: string,
  args: Record<string, unknown> = {},
) {
  const res = await request.post(`/api/projects/${ctx.projectId}/mcp`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result.content[0].text);
}

test.describe("MCP list_testcases and the repository total agree on Archived cases", () => {
  test("includeArchived lets an MCP caller reach the same total the repository summary counts", async ({
    request,
  }) => {
    const title = `E2E MCP archived ${Date.now()}`;
    const created = await createCase(request, { title, status: "Archived" });
    let tokenId: string | undefined;
    // storageState must be given explicitly and empty: playwright.config.ts's top-level `use`
    // sets a default storageState (account A's session cookie) that @playwright/test's `request`
    // namespace otherwise merges into every newContext() call made during a test run — leaving it
    // unset here silently re-attaches the cookie AuthMiddleware needs this context to not have.
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      // Same call the repository table and the REST list make: Archived is excluded by default,
      // matching legacy.service.ts's listTestCases (shared by the REST endpoint and this tool).
      const withoutArchived = await callMcpTool(mcpApi, token, "list_testcases", { search: title });
      expect(withoutArchived.total).toBe(0);
      expect(withoutArchived.rows.some((r: { id: string }) => r.id === created.id)).toBe(false);

      // includeArchived is the fix under test: previously undeclared on the tool's inputSchema, so
      // no MCP caller could ask for it and there was no way to match the repository header's total.
      const withArchived = await callMcpTool(mcpApi, token, "list_testcases", {
        search: title,
        includeArchived: true,
      });
      expect(withArchived.total).toBe(1);
      expect(withArchived.rows.some((r: { id: string }) => r.id === created.id)).toBe(true);

      // The repository summary total (the UI header tile) already counts this Archived case into its
      // "Archived" bucket — includeArchived:true is what lets an MCP caller see the same dataset.
      const summaryRes = await request.get(`/api/projects/${ctx.projectId}/reports/repository-summary`);
      expect(summaryRes.ok()).toBeTruthy();
      const summary = await summaryRes.json();
      const archivedBucket = summary.byStatus.find((s: { name: string }) => s.name === "Archived");
      expect(archivedBucket?.count ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, created.id);
      await mcpApi.dispose();
    }
  });
});
