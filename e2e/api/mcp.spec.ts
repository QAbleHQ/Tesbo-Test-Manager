import fs from "node:fs";
import path from "node:path";
import { expect, test, request as newRequestContext, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
// Account B: a second, fully independent account/org/project (see global-setup.ts and
// api/authorization.spec.ts, which establishes this same fixture pair for cross-tenant checks).
const ctxB = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context-b.json"), "utf-8"));

async function createCase(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
    data: { title: `E2E ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteCase(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
}

async function createSuiteRest(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/suites`, {
    data: { name: `E2E Suite ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteSuiteRest(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/suites/${id}`, { failOnStatusCode: false });
}

async function createBugRest(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/bugs`, {
    data: { title: `E2E Bug ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteBugRest(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/bugs/${id}`, { failOnStatusCode: false });
}

async function createPlanRest(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/plans`, {
    data: { name: `E2E Plan ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deletePlanRest(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/plans/${id}`, { failOnStatusCode: false });
}

async function createCycleRest(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/cycles`, {
    data: { name: `E2E Cycle ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteCycleRest(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/cycles/${id}`, { failOnStatusCode: false });
}

async function addCycleTestCaseRest(request: import("@playwright/test").APIRequestContext, cycleId: string, testcaseId: string) {
  await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseId } });
}

async function getCycleExecutionsRest(request: import("@playwright/test").APIRequestContext, cycleId: string) {
  const res = await request.get(`/api/cycles/${cycleId}/executions`);
  return res.json();
}

async function getKbRootFolderId(request: import("@playwright/test").APIRequestContext, projectId: string = ctx.projectId) {
  const res = await request.get(`/api/projects/${projectId}/knowledge-base/folders/tree`);
  return (await res.json()).id as string;
}

async function createKbDocumentRest(
  request: import("@playwright/test").APIRequestContext,
  folderId: string,
  data: Record<string, unknown> = {},
) {
  const res = await request.post(`/api/projects/${ctx.projectId}/knowledge-base/documents`, {
    data: { title: `E2E KB Doc ${Date.now()}`, folderId, ...data },
  });
  return res.json();
}

async function deleteKbDocumentRest(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/documents/${id}`, { failOnStatusCode: false });
}

async function createKbFolderRest(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/knowledge-base/folders`, {
    data: { name: `E2E KB Folder ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteKbFolderRest(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/folders/${id}`, { failOnStatusCode: false });
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

/** Same call as callMcpTool, but for cases expected to fail — returns the JSON-RPC error object. */
async function callMcpToolExpectError(
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
  expect(body.error).toBeDefined();
  return body.error as { code: number; message: string };
}

test.describe("MCP initialize", () => {
  test("advertises top-level instructions orienting a client to the whole server", async ({ request }) => {
    let tokenId: string | undefined;
    // Same reasoning as callMcpTool: a cookie-free context, since a real MCP client never sends
    // account A's browser session cookie alongside its bearer token.
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

      const res = await mcpApi.post(`/api/projects/${ctx.projectId}/mcp`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { jsonrpc: "2.0", id: 1, method: "initialize" },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      expect(body.error).toBeUndefined();
      // A non-trivial paragraph, not just present-but-empty — this is what a client is expected to
      // surface to its model as a session-level hint, per the MCP spec's `instructions` field.
      expect(typeof body.result.instructions).toBe("string");
      expect(body.result.instructions.length).toBeGreaterThan(100);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await mcpApi.dispose();
    }
  });
});

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

/*
 * MCP's create_testcase gives a calling LLM no schema for the shape of a step object, and unlike
 * Zyra's chat/task-board paths — which run their AI-generated steps through LegacyService's
 * safeSteps() synonym normalizer before persisting — the create path MCP and REST share
 * (insertTestCaseWithClient) stored `steps` verbatim. A step written under a plausible-but-wrong
 * key (`expected` instead of `expectedResult`, `step` instead of `action`) round-tripped through
 * the API untouched but rendered as blank Action/Expected Result text areas in the editor, which
 * only ever reads the literal `action`/`expectedResult` keys (testcases/page.tsx). Fixed by
 * normalizing create_testcase's `steps` argument through the same safeSteps() mapping before the
 * insert, mirroring Zyra.
 */
test.describe("MCP create_testcase normalizes step field synonyms", () => {
  test("a step written under synonym keys still persists with the exact action/expectedResult keys the editor reads", async ({
    request,
  }) => {
    const title = `E2E MCP Steps Synonyms ${Date.now()}`;
    let tokenId: string | undefined;
    let createdId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP Steps token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const created = await callMcpTool(mcpApi, token, "create_testcase", {
        title,
        // Deliberately the synonym keys safeSteps() maps, not the canonical ones — the shape an
        // MCP-calling LLM guessing from an undocumented `steps: array` schema would plausibly send.
        steps: [
          { stepNumber: 1, step: "Open the login page", expected: "Login form is visible" },
          { stepNumber: 2, action: "Submit valid credentials", expectedResult: "User lands on the dashboard" },
        ],
      });
      createdId = created.id;
      expect(createdId).toBeTruthy();

      // `rawSteps` is a JSON-encoded string, not an array — the test case editor's parseSteps()
      // (testcases/page.tsx) only accepts a string for this field, so that's the corrected
      // contract create_testcase's storage now matches (see "MCP create_testcase stores steps in
      // the shape the test case editor can read" below for the regression this fixes).
      function assertNormalized(rawSteps: unknown) {
        expect(typeof rawSteps).toBe("string");
        const steps = JSON.parse(rawSteps as string) as Array<{ stepNumber: number; action: string; expectedResult: string }>;
        expect(steps).toHaveLength(2);
        const [first, second] = steps;
        expect(first.action).toBe("Open the login page");
        expect(first.expectedResult).toBe("Login form is visible");
        // A well-formed step (already using the canonical keys) must pass through unchanged —
        // normalization must not corrupt input that was already correct.
        expect(second.action).toBe("Submit valid credentials");
        expect(second.expectedResult).toBe("User lands on the dashboard");
      }

      // The tool's own response reflects the normalized shape...
      assertNormalized(created.steps);

      // ...and so does what's actually persisted, fetched back through the same REST endpoint the
      // test case editor uses — proving this isn't just an artifact of the tool's return value.
      const fetched = await request.get(`/api/projects/${ctx.projectId}/testcases/${createdId}`);
      expect(fetched.ok()).toBeTruthy();
      assertNormalized((await fetched.json()).steps);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (createdId) await deleteCase(request, createdId);
      await mcpApi.dispose();
    }
  });
});

/*
 * "[Zyra] Test Steps, Actions, and Expected Results Are Missing After Saving Generated Test Cases" —
 * a Zyra/MCP-generated test case saved fine, but its steps showed as one blank Action/Expected
 * Result pair in the Test Case Repository.
 *
 * Root cause: the create/edit modal pre-stringifies `steps` into a JSON string before every save
 * (testcases/page.tsx), and the shared row writers (insertTestCaseWithClient/
 * updateTestCaseWithClient) unconditionally JSON.stringify whatever they're given — so the modal's
 * already-a-string input gets encoded a second time, landing in the jsonb column as a JSON string
 * scalar, which is exactly the one shape the modal's own parseSteps() knows how to read back. MCP's
 * create_testcase instead handed over a real array (via safeSteps()), which got encoded only once
 * and stored as a genuine jsonb array — a shape parseSteps() silently discards, substituting one
 * blank step regardless of how many steps actually exist. Fixed by pre-stringifying steps once in
 * create_testcase (mcp.tools.ts), matching what the modal already sends, without changing the modal,
 * safeSteps' synonym normalization, or anything Zyra generates.
 */
test.describe("MCP create_testcase stores steps in the shape the test case editor can read", () => {
  test("multiple steps — including quotes, backslashes and unicode — persist with the right count, order and content", async ({
    request,
  }) => {
    const title = `E2E MCP Steps Shape ${Date.now()}`;
    let tokenId: string | undefined;
    let createdId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP Steps Shape token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      // Deliberately more than one step (the observed bug always collapsed to exactly one) and
      // content that would break a naive re-encode: an apostrophe, a quote, a literal backslash,
      // and non-ASCII text.
      const steps = [
        { stepNumber: 1, action: `Enter O'Brien's "test" value`, expectedResult: `Rejects with a literal backslash: C:\\temp` },
        { stepNumber: 2, action: "Second step", expectedResult: "Second result" },
        { stepNumber: 3, action: "Third step with unicode: héllo 世界", expectedResult: "Renders unchanged" },
      ];
      const created = await callMcpTool(mcpApi, token, "create_testcase", { title, steps });
      createdId = created.id;
      expect(createdId).toBeTruthy();

      const fetched = await request.get(`/api/projects/${ctx.projectId}/testcases/${createdId}`);
      expect(fetched.ok()).toBeTruthy();
      const rawSteps = (await fetched.json()).steps;
      // The exact contract the editor's parseSteps() requires: a string, not an array.
      expect(typeof rawSteps).toBe("string");
      expect(JSON.parse(rawSteps)).toEqual(steps);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (createdId) await deleteCase(request, createdId);
      await mcpApi.dispose();
    }
  });

  test("an empty steps array persists as an empty, editor-readable list, not the one-blank-step fallback", async ({
    request,
  }) => {
    const title = `E2E MCP Steps Empty ${Date.now()}`;
    let tokenId: string | undefined;
    let createdId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP Steps Empty token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const created = await callMcpTool(mcpApi, token, "create_testcase", { title, steps: [] });
      createdId = created.id;
      expect(createdId).toBeTruthy();

      const fetched = await request.get(`/api/projects/${ctx.projectId}/testcases/${createdId}`);
      const rawSteps = (await fetched.json()).steps;
      expect(typeof rawSteps).toBe("string");
      expect(JSON.parse(rawSteps)).toEqual([]);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (createdId) await deleteCase(request, createdId);
      await mcpApi.dispose();
    }
  });
});

/*
 * "[MCP] Test case created by MCP is not adding Severity" — severity was never dropped: MCP stored
 * whatever string the caller sent, and a calling LLM given a bare `severity: string` schema sent
 * "Major". testcases.severity has no CHECK constraint, so that persisted, and the Test Case Detail
 * Severity dropdown — which only offers Critical/High/Medium/Low — showed its "Select" placeholder
 * because the stored value matches none of its options. The MCP test-case tools now advertise that
 * vocabulary as an enum, map a value onto it case-insensitively, and refuse anything else by name
 * instead of storing it. An omitted severity stays unset exactly as before.
 */
test.describe("MCP test case severity uses the vocabulary Test Case Detail can display", () => {
  async function withWriteToken(
    request: APIRequestContext,
    fn: (mcpApi: APIRequestContext, token: string, createdIds: string[]) => Promise<void>,
  ) {
    const mcpApi = await newRequestContext.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    const createdIds: string[] = [];
    let tokenId: string | undefined;
    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP Severity token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      await fn(mcpApi, tokenBody.token as string, createdIds);
    } finally {
      for (const id of createdIds) await deleteCase(request, id);
      if (tokenId) await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      await mcpApi.dispose();
    }
  }

  async function fetchCase(request: APIRequestContext, id: string) {
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`);
    expect(res.ok()).toBeTruthy();
    return res.json();
  }

  test("create_testcase persists the exact severity given, in the response and in what Test Case Detail reads", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token, createdIds) => {
      for (const severity of ["Critical", "High", "Medium", "Low"]) {
        const created = await callMcpTool(mcpApi, token, "create_testcase", { title: `E2E MCP Severity ${severity} ${Date.now()}`, severity });
        createdIds.push(created.id);
        expect(created.severity).toBe(severity);
        expect((await fetchCase(request, created.id)).severity).toBe(severity);
      }
    });
  });

  test("create_testcase maps a differently-cased severity onto the canonical value", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token, createdIds) => {
      const created = await callMcpTool(mcpApi, token, "create_testcase", { title: `E2E MCP Severity case ${Date.now()}`, severity: "  critical " });
      createdIds.push(created.id);
      expect(created.severity).toBe("Critical");
      expect((await fetchCase(request, created.id)).severity).toBe("Critical");
    });
  });

  test("create_testcase without severity leaves it unset, as before", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token, createdIds) => {
      const omitted = await callMcpTool(mcpApi, token, "create_testcase", { title: `E2E MCP Severity omitted ${Date.now()}` });
      createdIds.push(omitted.id);
      expect(omitted.severity).toBeNull();
      expect((await fetchCase(request, omitted.id)).severity).toBeFalsy();

      const blank = await callMcpTool(mcpApi, token, "create_testcase", { title: `E2E MCP Severity blank ${Date.now()}`, severity: "" });
      createdIds.push(blank.id);
      expect(blank.severity).toBeNull();
    });
  });

  // The regression: before the fix this call succeeded and stored "Major", which Test Case
  // Detail renders as "Select".
  test("create_testcase refuses a severity outside the vocabulary and creates nothing", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token) => {
      const title = `E2E MCP Severity invalid ${Date.now()}`;
      const error = await callMcpToolExpectError(mcpApi, token, "create_testcase", { title, severity: "Major" });
      expect(error.message).toContain("severity");
      expect(error.message).toContain("Critical, High, Medium, Low");
      const list = await (await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: title } })).json();
      expect(list.filter((tc: { title: string }) => tc.title === title)).toHaveLength(0);
    });
  });

  test("create_testcase's other fields are saved exactly as before alongside a severity", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token, createdIds) => {
      const title = `E2E MCP Severity other fields ${Date.now()}`;
      const steps = [{ stepNumber: 1, action: "Open the post", expectedResult: "Post is editable" }];
      const created = await callMcpTool(mcpApi, token, "create_testcase", {
        title,
        description: "desc",
        preconditions: "pre",
        steps,
        testData: "data",
        priority: "P1",
        severity: "High",
        type: "Regression",
        automationStatus: "Automated",
        component: "Buzz",
        status: "In Review",
      });
      createdIds.push(created.id);
      const fetched = await fetchCase(request, created.id);
      expect(fetched).toMatchObject({
        title,
        description: "desc",
        preconditions: "pre",
        testData: "data",
        priority: "P1",
        severity: "High",
        type: "Regression",
        automationStatus: "Automated",
        component: "Buzz",
        status: "In Review",
      });
      expect(JSON.parse(fetched.steps)).toEqual(steps);
    });
  });

  test("bulk_create_testcases applies the same rule per item without failing the rest of the batch", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token, createdIds) => {
      const stamp = Date.now();
      const result = await callMcpTool(mcpApi, token, "bulk_create_testcases", {
        testcases: [
          { title: `E2E MCP Bulk Severity ok ${stamp}`, severity: "medium" },
          { title: `E2E MCP Bulk Severity bad ${stamp}`, severity: "Blocker" },
          { title: `E2E MCP Bulk Severity none ${stamp}` },
        ],
      });
      for (const r of result.results) if (r.ok) createdIds.push(r.testcase.id);
      expect(result).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
      const [ok, bad, none] = result.results;
      expect(ok.ok).toBe(true);
      expect((await fetchCase(request, ok.testcase.id)).severity).toBe("Medium");
      expect(bad).toMatchObject({ index: 1, ok: false });
      expect(bad.error).toContain("severity");
      expect(none.ok).toBe(true);
      expect((await fetchCase(request, none.testcase.id)).severity).toBeFalsy();
    });
  });

  test("update_testcase sets a canonical severity, refuses an unknown one, and leaves it alone when omitted", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token, createdIds) => {
      const created = await callMcpTool(mcpApi, token, "create_testcase", { title: `E2E MCP Severity update ${Date.now()}`, severity: "Low" });
      createdIds.push(created.id);

      const updated = await callMcpTool(mcpApi, token, "update_testcase", { testcaseId: created.id, severity: "high" });
      expect(updated.severity).toBe("High");

      const error = await callMcpToolExpectError(mcpApi, token, "update_testcase", { testcaseId: created.id, severity: "Major" });
      expect(error.message).toContain("severity");
      expect((await fetchCase(request, created.id)).severity).toBe("High");

      const untouched = await callMcpTool(mcpApi, token, "update_testcase", { testcaseId: created.id, component: "Buzz" });
      expect(untouched.severity).toBe("High");
      expect(untouched.component).toBe("Buzz");
    });
  });

  test("tools/list advertises the severity vocabulary on every test case write tool", async ({ request }) => {
    await withWriteToken(request, async (mcpApi, token) => {
      const res = await mcpApi.post(`/api/projects/${ctx.projectId}/mcp`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(res.ok()).toBeTruthy();
      const tools = (await res.json()).result.tools as Array<{ name: string; inputSchema: any }>;
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      const expected = ["Critical", "High", "Medium", "Low"];
      expect(byName.create_testcase.inputSchema.properties.severity.enum).toEqual(expected);
      expect(byName.update_testcase.inputSchema.properties.severity.enum).toEqual(expected);
      expect(byName.bulk_create_testcases.inputSchema.properties.testcases.items.properties.severity.enum).toEqual(expected);
    });
  });
});

test.describe("MCP search_knowledge_base", () => {
  test("finds a Knowledge Base document created via REST, scoped to the token's project", async ({ request }) => {
    const title = `E2E MCP KB ${Date.now()}`;
    let tokenId: string | undefined;
    let documentId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const treeRes = await request.get(`/api/projects/${ctx.projectId}/knowledge-base/folders/tree`);
      expect(treeRes.ok()).toBeTruthy();
      const rootFolderId = (await treeRes.json()).id;

      const docRes = await request.post(`/api/projects/${ctx.projectId}/knowledge-base/documents`, {
        data: { title, folderId: rootFolderId, contentText: "Steps to reset a forgotten password" },
      });
      expect(docRes.ok()).toBeTruthy();
      documentId = (await docRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP KB token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const found = await callMcpTool(mcpApi, token, "search_knowledge_base", { q: title });
      expect(found.list.some((item: { id: string; type: string }) => item.id === documentId && item.type === "document")).toBe(
        true,
      );

      const empty = await callMcpTool(mcpApi, token, "search_knowledge_base", { q: `no-such-title-${Date.now()}` });
      expect(empty.total).toBe(0);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (documentId) {
        await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`, {
          failOnStatusCode: false,
        });
      }
      await mcpApi.dispose();
    }
  });

  test("rejects a call missing the required q argument", async ({ request }) => {
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP KB validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const error = await callMcpToolExpectError(mcpApi, token, "search_knowledge_base", {});
      expect(error.message).toMatch(/"q"/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP write access to Knowledge Base: create/update/move documents and folders. Every tool is a
 * thin passthrough to the same LegacyService methods the REST knowledge-base endpoints already
 * use (mcp.tools.ts), so the role/ownership gate (kbRequireMutateAccess — a qa_engineer may only
 * mutate what they created; owner/manager may mutate anything) and the KB-specific business rules
 * (root folder immovable, no moving a folder into its own subtree, sync-mirror read-only lock,
 * duplicate sibling names) are unchanged and already covered end-to-end at the REST layer in
 * api/knowledge-base.spec.ts. What's new here is the MCP transport and attribution (ctx.userId,
 * since knowledge_documents/knowledge_folders.created_by references users(id) like bugs.reported_by
 * — see mcp.tools.ts's module doc comment), so these tests focus on that: the tools actually
 * persist through to REST, required-argument validation, and not-found/guard handling.
 */
test.describe("MCP Knowledge Base write tools", () => {
  test("creates, updates, and moves a document and a folder, persisted via REST", async ({ request }) => {
    const stamp = Date.now();
    let tokenId: string | undefined;
    let folderAId: string | undefined;
    let folderBId: string | undefined;
    let documentId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const treeRes = await request.get(`/api/projects/${ctx.projectId}/knowledge-base/folders/tree`);
      expect(treeRes.ok()).toBeTruthy();
      const rootFolderId = (await treeRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP KB write token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      // create_knowledge_folder: two sibling folders under root.
      const folderA = await callMcpTool(mcpApi, token, "create_knowledge_folder", {
        name: `E2E MCP KB Folder A ${stamp}`,
        parentFolderId: rootFolderId,
      });
      folderAId = folderA.id;
      const folderB = await callMcpTool(mcpApi, token, "create_knowledge_folder", {
        name: `E2E MCP KB Folder B ${stamp}`,
        parentFolderId: rootFolderId,
      });
      folderBId = folderB.id;

      const fetchedFolderA = await request.get(`/api/projects/${ctx.projectId}/knowledge-base/folders/${folderAId}`);
      expect(fetchedFolderA.ok()).toBeTruthy();
      expect((await fetchedFolderA.json()).name).toBe(`E2E MCP KB Folder A ${stamp}`);

      // create_knowledge_document: inside folder A.
      const doc = await callMcpTool(mcpApi, token, "create_knowledge_document", {
        title: `E2E MCP KB Doc ${stamp}`,
        folderId: folderAId,
        contentText: "Original content",
      });
      documentId = doc.id;
      const fetchedDoc = await request.get(`/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`);
      expect(fetchedDoc.ok()).toBeTruthy();
      let docBody = await fetchedDoc.json();
      expect(docBody.folderId).toBe(folderAId);
      expect(docBody.contentText).toBe("Original content");

      // update_knowledge_document: title and content change, persisted.
      await callMcpTool(mcpApi, token, "update_knowledge_document", {
        documentId,
        title: `E2E MCP KB Doc Updated ${stamp}`,
        contentText: "Updated content",
      });
      docBody = await (await request.get(`/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`)).json();
      expect(docBody.title).toBe(`E2E MCP KB Doc Updated ${stamp}`);
      expect(docBody.contentText).toBe("Updated content");

      // move_knowledge_document: from folder A to folder B.
      await callMcpTool(mcpApi, token, "move_knowledge_document", { documentId, folderId: folderBId });
      docBody = await (await request.get(`/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`)).json();
      expect(docBody.folderId).toBe(folderBId);

      // update_knowledge_folder: rename folder A.
      await callMcpTool(mcpApi, token, "update_knowledge_folder", {
        folderId: folderAId,
        name: `E2E MCP KB Folder A Renamed ${stamp}`,
      });
      const renamedFolderA = await (
        await request.get(`/api/projects/${ctx.projectId}/knowledge-base/folders/${folderAId}`)
      ).json();
      expect(renamedFolderA.name).toBe(`E2E MCP KB Folder A Renamed ${stamp}`);

      // move_knowledge_folder: nest folder A under folder B.
      await callMcpTool(mcpApi, token, "move_knowledge_folder", { folderId: folderAId, parentFolderId: folderBId });
      const movedFolderA = await (
        await request.get(`/api/projects/${ctx.projectId}/knowledge-base/folders/${folderAId}`)
      ).json();
      expect(movedFolderA.parentFolderId).toBe(folderBId);

      // Guard: folder B cannot be moved into its own subtree (folder A is now its child).
      const subtreeError = await callMcpToolExpectError(mcpApi, token, "move_knowledge_folder", {
        folderId: folderBId,
        parentFolderId: folderAId,
      });
      expect(subtreeError.message).toMatch(/cannot be moved into itself or one of its subfolders/i);

      // Guard: the project's root folder cannot be moved at all.
      const rootMoveError = await callMcpToolExpectError(mcpApi, token, "move_knowledge_folder", {
        folderId: rootFolderId,
        parentFolderId: folderAId,
      });
      expect(rootMoveError.message).toMatch(/root folder cannot be moved/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (documentId) {
        await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`, {
          failOnStatusCode: false,
        });
      }
      // Folder A is nested under folder B by the time cleanup runs; delete the child before the parent.
      if (folderAId) {
        await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/folders/${folderAId}`, {
          failOnStatusCode: false,
        });
      }
      if (folderBId) {
        await request.delete(`/api/projects/${ctx.projectId}/knowledge-base/folders/${folderBId}`, {
          failOnStatusCode: false,
        });
      }
      await mcpApi.dispose();
    }
  });

  test("rejects each Knowledge Base write tool call missing its required argument(s)", async ({ request }) => {
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP KB validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, token, "create_knowledge_document", { folderId: "f1" })).message).toMatch(
        /"title"/i,
      );
      expect((await callMcpToolExpectError(mcpApi, token, "create_knowledge_document", { title: "T" })).message).toMatch(
        /"folderId"/i,
      );
      expect((await callMcpToolExpectError(mcpApi, token, "update_knowledge_document", { title: "T" })).message).toMatch(
        /"documentId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, token, "move_knowledge_document", { documentId: "d1" })).message,
      ).toMatch(/"folderId"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "move_knowledge_document", { folderId: "f1" })).message,
      ).toMatch(/"documentId"/i);
      expect((await callMcpToolExpectError(mcpApi, token, "create_knowledge_folder", {})).message).toMatch(/"name"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "update_knowledge_folder", { name: "N" })).message,
      ).toMatch(/"folderId"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "move_knowledge_folder", { folderId: "f1" })).message,
      ).toMatch(/"parentFolderId"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "move_knowledge_folder", { parentFolderId: "f2" })).message,
      ).toMatch(/"folderId"/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await mcpApi.dispose();
    }
  });

  test("rejects update/move on a Knowledge Base document or folder that does not exist", async ({ request }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP KB not-found token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect(
        (
          await callMcpToolExpectError(mcpApi, token, "update_knowledge_document", { documentId: ghostId, title: "x" })
        ).message,
      ).toMatch(/document not found/i);
      expect(
        (
          await callMcpToolExpectError(mcpApi, token, "move_knowledge_document", { documentId: ghostId, folderId: ghostId })
        ).message,
      ).toMatch(/document not found|folder not found/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "update_knowledge_folder", { folderId: ghostId, name: "x" })).message,
      ).toMatch(/folder not found/i);
      expect(
        (
          await callMcpToolExpectError(mcpApi, token, "move_knowledge_folder", {
            folderId: ghostId,
            parentFolderId: ghostId,
          })
        ).message,
      ).toMatch(/folder not found/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP read/write access to a test case by id: get_testcase, update_testcase, archive_testcase,
 * restore_testcase. All four close a create-only gap: MCP could previously create a test case but
 * never read, edit, archive, or restore one after the fact. update/archive/restore all wrap
 * LegacyService methods (updateTestCase, getTestCase) that take no project argument of their own —
 * they derive the project from the row found by id — so, exactly like record_execution_result,
 * the tool itself must check the test case's project against the token before calling them;
 * otherwise a token could reach into another project's test case by id alone.
 */
test.describe("MCP get_testcase", () => {
  test("returns the full detail of a test case created via REST", async ({ request }) => {
    const created = await createCase(request, {
      title: `E2E MCP Get ${Date.now()}`,
      description: "Full description",
      priority: "High",
    });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_testcase token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const fetched = await callMcpTool(mcpApi, token, "get_testcase", { testcaseId: created.id });
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe(created.title);
      expect(fetched.description).toBe("Full description");
      expect(fetched.priority).toBe("High");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, created.id);
      await mcpApi.dispose();
    }
  });

  test("rejects get_testcase missing testcaseId, on a test case that does not exist, and across projects", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Get Cross-Project ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_testcase validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, token, "get_testcase", {})).message).toMatch(/"testcaseId"/i);
      expect((await callMcpToolExpectError(mcpApi, token, "get_testcase", { testcaseId: ghostId })).message).toMatch(
        /not found/i,
      );

      const crossProjectError = await callMcpToolExpectError(mcpApi, token, "get_testcase", { testcaseId: bCaseId });
      expect(crossProjectError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCaseId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP update_testcase", () => {
  test("updates a test case created via REST, persisted through the same REST endpoint", async ({ request }) => {
    const created = await createCase(request, { title: `E2E MCP Update ${Date.now()}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP update token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const newTitle = `E2E MCP Update Retitled ${Date.now()}`;
      const updated = await callMcpTool(mcpApi, token, "update_testcase", {
        testcaseId: created.id,
        title: newTitle,
        priority: "High",
      });
      expect(updated.title).toBe(newTitle);
      expect(updated.priority).toBe("High");

      const fetched = await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`);
      expect(fetched.ok()).toBeTruthy();
      const fetchedBody = await fetched.json();
      expect(fetchedBody.title).toBe(newTitle);
      expect(fetchedBody.priority).toBe("High");

      // Omitted fields keep their current value rather than being cleared (updateTestCaseWithClient's
      // COALESCE contract) — description was never sent above, so it must still be absent, not null-ed.
      expect(fetchedBody.description ?? null).toBe(created.description ?? null);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, created.id);
      await mcpApi.dispose();
    }
  });

  test("rejects update_testcase for a test case belonging to another project", async ({ request }) => {
    // Account B's own session — a token minted against project A must not be able to reach a
    // test case that lives in project B, even though both are addressed by the same MCP endpoint
    // shape. This is the case updateTestCase has no way to catch itself.
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Cross-Project ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP cross-project token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const updateError = await callMcpToolExpectError(mcpApi, token, "update_testcase", {
        testcaseId: bCaseId,
        title: "Retitled by project A's token",
      });
      expect(updateError.code).toBe(-32001); // RpcCode.ProjectScopeDenied

      // Untouched: still readable, under its original title, via account B's own session.
      const stillThere = await asB.get(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`);
      expect(stillThere.ok()).toBeTruthy();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCaseId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects update_testcase missing testcaseId, on a test case that does not exist, and for a read-scoped token", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const created = await createCase(request, { title: `E2E MCP Update Scope ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP update_testcase validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, writeToken, "update_testcase", { title: "x" })).message).toMatch(
        /"testcaseId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "update_testcase", { testcaseId: ghostId, title: "x" })).message,
      ).toMatch(/not found/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP update_testcase read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "update_testcase", {
        testcaseId: created.id,
        title: "Should be refused",
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied

      // Untouched by the refused call.
      const fetched = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)).json();
      expect(fetched.title).toBe(created.title);
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, created.id);
      await mcpApi.dispose();
    }
  });
});

/*
 * archive_testcase/restore_testcase: the dedicated, non-destructive lifecycle tools. Both are thin
 * wrappers over updateTestCase({status: ...}) — the same status change the app's own Archive/
 * Restore buttons make — so no row is ever deleted, only status flips between "Archived" and
 * "Draft" (restore always lands on "Draft"; the app does not remember what status a case had
 * before it was archived, see the tool's own description).
 */
test.describe("MCP archive_testcase and restore_testcase", () => {
  test("archives and then restores a test case, changing only its status and default-list visibility", async ({
    request,
  }) => {
    const title = `E2E MCP Archive ${Date.now()}`;
    const created = await createCase(request, { title, priority: "High" });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const archived = await callMcpTool(mcpApi, token, "archive_testcase", { testcaseId: created.id });
      expect(archived.status).toBe("Archived");
      // Nothing else about the row changed — this is a status flip, not a rewrite.
      expect(archived.priority).toBe("High");

      const fetchedArchived = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)).json();
      expect(fetchedArchived.status).toBe("Archived");

      const withoutArchived = await callMcpTool(mcpApi, token, "list_testcases", { search: title });
      expect(withoutArchived.rows.some((r: { id: string }) => r.id === created.id)).toBe(false);
      const withArchived = await callMcpTool(mcpApi, token, "list_testcases", { search: title, includeArchived: true });
      expect(withArchived.rows.some((r: { id: string }) => r.id === created.id)).toBe(true);

      const restored = await callMcpTool(mcpApi, token, "restore_testcase", { testcaseId: created.id });
      // Matches the app's own Restore/Unarchive action: always back to "Draft", not whatever
      // status the case had before it was archived (there is no stored prior status).
      expect(restored.status).toBe("Draft");
      expect(restored.priority).toBe("High");

      const backInDefaultList = await callMcpTool(mcpApi, token, "list_testcases", { search: title });
      expect(backInDefaultList.rows.some((r: { id: string }) => r.id === created.id)).toBe(true);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, created.id);
      await mcpApi.dispose();
    }
  });

  test("rejects archive_testcase and restore_testcase for a test case belonging to another project", async ({
    request,
  }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Archive Cross-Project ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive cross-project token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const archiveError = await callMcpToolExpectError(mcpApi, token, "archive_testcase", { testcaseId: bCaseId });
      expect(archiveError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const restoreError = await callMcpToolExpectError(mcpApi, token, "restore_testcase", { testcaseId: bCaseId });
      expect(restoreError.code).toBe(-32001);

      const stillThere = await (await asB.get(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`)).json();
      expect(stillThere.status).not.toBe("Archived");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCaseId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects archive_testcase and restore_testcase missing testcaseId, on a test case that does not exist, and for a read-scoped token", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const created = await createCase(request, { title: `E2E MCP Archive Scope ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, writeToken, "archive_testcase", {})).message).toMatch(/"testcaseId"/i);
      expect((await callMcpToolExpectError(mcpApi, writeToken, "restore_testcase", {})).message).toMatch(/"testcaseId"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "archive_testcase", { testcaseId: ghostId })).message,
      ).toMatch(/not found/i);
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "restore_testcase", { testcaseId: ghostId })).message,
      ).toMatch(/not found/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const archiveScopeError = await callMcpToolExpectError(mcpApi, readToken, "archive_testcase", {
        testcaseId: created.id,
      });
      expect(archiveScopeError.code).toBe(-32002); // RpcCode.ScopeDenied
      const restoreScopeError = await callMcpToolExpectError(mcpApi, readToken, "restore_testcase", {
        testcaseId: created.id,
      });
      expect(restoreScopeError.code).toBe(-32002);

      const fetched = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)).json();
      expect(fetched.status).not.toBe("Archived");
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, created.id);
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP read/write access to suites: list_suites, get_suite, update_suite. list_suites/get_suite
 * close a read-only gap (MCP could create a suite but never list or inspect one); update_suite
 * closes the same create-only gap update_testcase closed for test cases. updateSuite() takes no
 * project argument of its own either — it derives the project from the row via requireSuiteAccess
 * — so update_suite (and get_suite, since there is no dedicated getSuite() method) must check
 * project ownership themselves, same as update_testcase.
 */
test.describe("MCP list_suites, get_suite, and update_suite", () => {
  test("lists suites created via REST, scoped to the token's project", async ({ request }) => {
    const stamp = Date.now();
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let suiteId: string | undefined;
    let childSuiteId: string | undefined;
    let bSuiteId: string | undefined;
    let testcaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const suite = await createSuiteRest(request, { name: `E2E MCP List Suite ${stamp}` });
      suiteId = suite.id;
      const childSuite = await createSuiteRest(request, { name: `E2E MCP List Suite Child ${stamp}`, parentId: suiteId });
      childSuiteId = childSuite.id;
      const testcase = await createCase(request, { title: `E2E MCP Suite Count ${stamp}`, suiteId: childSuiteId });
      testcaseId = testcase.id;

      // A suite in account B's own project must never appear in account A's list_suites.
      const bSuiteRes = await asB.post(`/api/projects/${ctxB.projectId}/suites`, {
        data: { name: `E2E MCP Cross-Project Suite ${stamp}` },
      });
      expect(bSuiteRes.ok()).toBeTruthy();
      bSuiteId = (await bSuiteRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP list_suites token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const listed = await callMcpTool(mcpApi, token, "list_suites", {});
      const suites = listed.suites as Array<{ id: string; parentId: string | null; testCaseCount: number; recursiveTestCaseCount: number }>;
      const listedSuite = suites.find((s) => s.id === suiteId);
      const listedChild = suites.find((s) => s.id === childSuiteId);
      expect(listedSuite).toBeTruthy();
      expect(listedChild).toBeTruthy();
      expect(listedChild?.parentId).toBe(suiteId);
      expect(listedChild?.testCaseCount).toBe(1);
      // recursiveTestCaseCount rolls up the whole subtree — the parent's own direct count is 0
      // (its only test case lives on the child), but the subtree total is 1.
      expect(listedSuite?.testCaseCount).toBe(0);
      expect(listedSuite?.recursiveTestCaseCount).toBe(1);
      expect(suites.some((s) => s.id === bSuiteId)).toBe(false);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (testcaseId) await deleteCase(request, testcaseId);
      if (childSuiteId) await deleteSuiteRest(request, childSuiteId);
      if (suiteId) await deleteSuiteRest(request, suiteId);
      if (bSuiteId) await asB.delete(`/api/suites/${bSuiteId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("gets a suite by id, and renaming it does not move it to the project root", async ({ request }) => {
    const stamp = Date.now();
    let tokenId: string | undefined;
    let parentId: string | undefined;
    let suiteId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const parent = await createSuiteRest(request, { name: `E2E MCP Get Suite Parent ${stamp}` });
      parentId = parent.id;
      const suite = await createSuiteRest(request, { name: `E2E MCP Get Suite ${stamp}`, parentId });
      suiteId = suite.id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get/update_suite token ${stamp}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const fetched = await callMcpTool(mcpApi, token, "get_suite", { suiteId });
      expect(fetched.id).toBe(suiteId);
      expect(fetched.parentId).toBe(parentId);

      // The gotcha this tool works around: updateSuite() writes parent_id verbatim, no COALESCE.
      // A rename-only call (no parentId) must NOT un-parent the suite.
      const renamed = await callMcpTool(mcpApi, token, "update_suite", {
        suiteId,
        name: `E2E MCP Get Suite Renamed ${stamp}`,
      });
      expect(renamed.name).toBe(`E2E MCP Get Suite Renamed ${stamp}`);
      expect(renamed.parentId).toBe(parentId);

      // An explicit null does move it to the root.
      const rootedResult = await callMcpTool(mcpApi, token, "update_suite", { suiteId, parentId: null });
      expect(rootedResult.parentId).toBeNull();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (suiteId) await deleteSuiteRest(request, suiteId);
      if (parentId) await deleteSuiteRest(request, parentId);
      await mcpApi.dispose();
    }
  });

  test("rejects get_suite and update_suite for a suite belonging to another project", async ({ request }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bSuiteId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bSuiteRes = await asB.post(`/api/projects/${ctxB.projectId}/suites`, {
        data: { name: `E2E MCP Suite Cross-Project ${Date.now()}` },
      });
      expect(bSuiteRes.ok()).toBeTruthy();
      bSuiteId = (await bSuiteRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP suite cross-project token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const getError = await callMcpToolExpectError(mcpApi, token, "get_suite", { suiteId: bSuiteId });
      expect(getError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const updateError = await callMcpToolExpectError(mcpApi, token, "update_suite", {
        suiteId: bSuiteId,
        name: "Renamed by project A's token",
      });
      expect(updateError.code).toBe(-32001);

      const stillThere = await (await asB.get(`/api/projects/${ctxB.projectId}/suites`)).json();
      expect(stillThere.some((s: { id: string; name: string }) => s.id === bSuiteId && s.name.startsWith("E2E MCP Suite Cross-Project"))).toBe(
        true,
      );
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bSuiteId) await asB.delete(`/api/suites/${bSuiteId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects get_suite and update_suite missing suiteId, on a suite that does not exist, and update_suite for a read-scoped token", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const suite = await createSuiteRest(request, { name: `E2E MCP Suite Scope ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP suite validation token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, writeToken, "get_suite", {})).message).toMatch(/"suiteId"/i);
      expect((await callMcpToolExpectError(mcpApi, writeToken, "update_suite", { name: "x" })).message).toMatch(/"suiteId"/i);
      expect((await callMcpToolExpectError(mcpApi, writeToken, "get_suite", { suiteId: ghostId })).message).toMatch(
        /not found/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "update_suite", { suiteId: ghostId, name: "x" })).message,
      ).toMatch(/not found/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP suite read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "update_suite", {
        suiteId: suite.id,
        name: "Should be refused",
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteSuiteRest(request, suite.id);
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP read/write access to bugs: list_bugs, get_bug, update_bug. list_bugs/get_bug close a
 * read-only gap (MCP could report a bug but never list or inspect one); update_bug closes the
 * same create-only gap update_testcase/update_suite closed elsewhere. updateBug() and getBug()
 * both take no project argument of their own either — getBug() has no ownership check inside it
 * at all, and updateBug() derives the project from the row via requireBugAccess — so both tools
 * must check project ownership themselves before calling in, same as the test case/suite tools.
 */
test.describe("MCP list_bugs, get_bug, and update_bug", () => {
  test("lists and gets bugs created via REST, scoped to the token's project", async ({ request }) => {
    const stamp = Date.now();
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bugId: string | undefined;
    let bBugId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bug = await createBugRest(request, { title: `E2E MCP List Bug ${stamp}`, status: "Open" });
      bugId = bug.id;

      // A bug in account B's own project must never appear in account A's list_bugs.
      const bBugRes = await asB.post(`/api/projects/${ctxB.projectId}/bugs`, {
        data: { title: `E2E MCP Cross-Project Bug ${stamp}` },
      });
      expect(bBugRes.ok()).toBeTruthy();
      bBugId = (await bBugRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP list/get_bug token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const listed = await callMcpTool(mcpApi, token, "list_bugs", { status: "Open" });
      const bugs = listed.bugs as Array<{ id: string }>;
      expect(bugs.some((b) => b.id === bugId)).toBe(true);
      expect(bugs.some((b) => b.id === bBugId)).toBe(false);

      const fetched = await callMcpTool(mcpApi, token, "get_bug", { bugId });
      expect(fetched.id).toBe(bugId);
      expect(fetched.title).toBe(`E2E MCP List Bug ${stamp}`);
      expect(Array.isArray(fetched.links)).toBe(true);
      expect(Array.isArray(fetched.attachments)).toBe(true);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bugId) await deleteBugRest(request, bugId);
      if (bBugId) await asB.delete(`/api/bugs/${bBugId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("updates a bug's fields, including explicitly clearing priority and unassigning", async ({ request }) => {
    const stamp = Date.now();
    const bug = await createBugRest(request, {
      title: `E2E MCP Update Bug ${stamp}`,
      severity: "Low",
      priority: "P3",
    });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP update_bug token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const updated = await callMcpTool(mcpApi, token, "update_bug", {
        bugId: bug.id,
        status: "Closed",
        severity: "Critical",
      });
      expect(updated.status).toBe("Closed");
      expect(updated.severity).toBe("Critical");
      // Omitted priority keeps its current value (not cleared) — the explicit-clear convention
      // is only triggered by null/"", never by omission.
      expect(updated.priority).toBe("P3");

      const fetchedAfterUpdate = await (await request.get(`/api/bugs/${bug.id}`)).json();
      expect(fetchedAfterUpdate.status).toBe("Closed");
      expect(fetchedAfterUpdate.severity).toBe("Critical");

      // Explicit null clears priority back to untriaged — this is what "pass null or "" to clear
      // it" in the tool's description means, and it must not be confused with omitting the field.
      const cleared = await callMcpTool(mcpApi, token, "update_bug", { bugId: bug.id, priority: null });
      expect(cleared.priority).toBeNull();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteBugRest(request, bug.id);
      await mcpApi.dispose();
    }
  });

  test("rejects get_bug and update_bug for a bug belonging to another project", async ({ request }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bBugId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bBugRes = await asB.post(`/api/projects/${ctxB.projectId}/bugs`, {
        data: { title: `E2E MCP Bug Cross-Project ${Date.now()}` },
      });
      expect(bBugRes.ok()).toBeTruthy();
      bBugId = (await bBugRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bug cross-project token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const getError = await callMcpToolExpectError(mcpApi, token, "get_bug", { bugId: bBugId });
      expect(getError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const updateError = await callMcpToolExpectError(mcpApi, token, "update_bug", {
        bugId: bBugId,
        status: "Closed",
      });
      expect(updateError.code).toBe(-32001);

      const stillThere = await (await asB.get(`/api/bugs/${bBugId}`)).json();
      expect(stillThere.status).not.toBe("Closed");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bBugId) await asB.delete(`/api/bugs/${bBugId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects get_bug and update_bug missing bugId, on a bug that does not exist, and update_bug for a read-scoped token", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const bug = await createBugRest(request, { title: `E2E MCP Bug Scope ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bug validation token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, writeToken, "get_bug", {})).message).toMatch(/"bugId"/i);
      expect((await callMcpToolExpectError(mcpApi, writeToken, "update_bug", { status: "Closed" })).message).toMatch(
        /"bugId"/i,
      );
      expect((await callMcpToolExpectError(mcpApi, writeToken, "get_bug", { bugId: ghostId })).message).toMatch(
        /not found/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "update_bug", { bugId: ghostId, status: "Closed" })).message,
      ).toMatch(/not found/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bug read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "update_bug", {
        bugId: bug.id,
        status: "Closed",
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteBugRest(request, bug.id);
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP read access to test cycles: list_test_cycles, get_test_cycle. Both close a read-only gap —
 * MCP could create a cycle (create_cycle_from_plan) but never list or inspect one afterwards.
 * getCycle()/listCycles() both take a real project argument the tool trusts (list_test_cycles), or
 * derive the project from the row via requireCycleAccess (get_test_cycle needs its own ownership
 * check first, same as get_suite/get_bug, since requireCycleAccess checks the caller's org access
 * to whatever project the cycle happens to be in, not that it matches this token's own project).
 */
test.describe("MCP list_test_cycles and get_test_cycle", () => {
  test("lists and gets a test cycle created via REST, with its linked plan attached, scoped to the token's project", async ({
    request,
  }) => {
    const stamp = Date.now();
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let planId: string | undefined;
    let cycleId: string | undefined;
    let bCycleId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const plan = await createPlanRest(request, { name: `E2E MCP Cycle Plan ${stamp}` });
      planId = plan.id;
      const cycle = await createCycleRest(request, {
        name: `E2E MCP Cycle ${stamp}`,
        planId,
        environment: "Staging",
      });
      cycleId = cycle.id;

      // A cycle in account B's own project must never appear in account A's list_test_cycles.
      const bCycleRes = await asB.post(`/api/projects/${ctxB.projectId}/cycles`, {
        data: { name: `E2E MCP Cross-Project Cycle ${stamp}` },
      });
      expect(bCycleRes.ok()).toBeTruthy();
      bCycleId = (await bCycleRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP list/get_test_cycle token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const listed = await callMcpTool(mcpApi, token, "list_test_cycles", {});
      const cycles = listed.cycles as Array<{ id: string; environment: string }>;
      expect(cycles.some((c) => c.id === cycleId && c.environment === "Staging")).toBe(true);
      expect(cycles.some((c) => c.id === bCycleId)).toBe(false);

      const fetched = await callMcpTool(mcpApi, token, "get_test_cycle", { cycleId });
      expect(fetched.id).toBe(cycleId);
      expect(fetched.planId).toBe(planId);
      expect(fetched.plan).toBeTruthy();
      expect(fetched.plan.id).toBe(planId);
      expect(fetched.plan.name).toBe(`E2E MCP Cycle Plan ${stamp}`);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (cycleId) await deleteCycleRest(request, cycleId);
      if (planId) await deletePlanRest(request, planId);
      if (bCycleId) await asB.delete(`/api/cycles/${bCycleId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("gets a test cycle with no plan as plan: null, without failing", async ({ request }) => {
    const cycle = await createCycleRest(request, { name: `E2E MCP Cycle No Plan ${Date.now()}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP no-plan token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const fetched = await callMcpTool(mcpApi, token, "get_test_cycle", { cycleId: cycle.id });
      expect(fetched.planId ?? null).toBeNull();
      expect(fetched.plan).toBeNull();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await mcpApi.dispose();
    }
  });

  test("rejects get_test_cycle missing cycleId, on a cycle that does not exist, and across projects", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCycleId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCycleRes = await asB.post(`/api/projects/${ctxB.projectId}/cycles`, {
        data: { name: `E2E MCP Cycle Cross-Project ${Date.now()}` },
      });
      expect(bCycleRes.ok()).toBeTruthy();
      bCycleId = (await bCycleRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP cycle validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, token, "get_test_cycle", {})).message).toMatch(/"cycleId"/i);
      expect((await callMcpToolExpectError(mcpApi, token, "get_test_cycle", { cycleId: ghostId })).message).toMatch(
        /not found/i,
      );

      const crossProjectError = await callMcpToolExpectError(mcpApi, token, "get_test_cycle", { cycleId: bCycleId });
      expect(crossProjectError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCycleId) await asB.delete(`/api/cycles/${bCycleId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP read/write access to executions: list_executions, get_execution, update_execution_result.
 * list_executions/get_execution close a read-only gap — MCP could record a result
 * (record_execution_result) but never list or inspect an execution first to find its id or see its
 * current state. update_execution_result is the fuller sibling of record_execution_result: same
 * updateExecution() call, same ctx.userId attribution reasoning, but with status made optional and
 * assigneeId added, matching every field the app's own Test Run screen exposes.
 */
test.describe("MCP list_executions, get_execution, and update_execution_result", () => {
  test("lists and gets an execution created via REST, scoped to the token's project", async ({ request }) => {
    const stamp = Date.now();
    const cycle = await createCycleRest(request, { name: `E2E MCP Executions Cycle ${stamp}` });
    const testcase = await createCase(request, { title: `E2E MCP Executions Case ${stamp}` });
    let tokenId: string | undefined;
    let executionId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycle.id, testcase.id);
      const executions = await getCycleExecutionsRest(request, cycle.id);
      executionId = executions[0]?.id;
      expect(executionId).toBeTruthy();

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP list/get_execution token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const listed = await callMcpTool(mcpApi, token, "list_executions", { cycleId: cycle.id });
      const listedExecutions = listed.executions as Array<{ id: string; title: string; status: string; testcaseId: string }>;
      expect(listedExecutions).toHaveLength(1);
      expect(listedExecutions[0].id).toBe(executionId);
      expect(listedExecutions[0].testcaseId).toBe(testcase.id);
      expect(listedExecutions[0].title).toBe(testcase.title);
      expect(listedExecutions[0].status).toBe("Untested");

      const fetched = await callMcpTool(mcpApi, token, "get_execution", { executionId });
      expect(fetched.id).toBe(executionId);
      expect(fetched.title).toBe(testcase.title);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });

  test("updates one execution's result without touching an unrelated execution in a different cycle", async ({
    request,
  }) => {
    const stamp = Date.now();
    const cycle = await createCycleRest(request, { name: `E2E MCP Update Execution Cycle ${stamp}` });
    const testcase = await createCase(request, { title: `E2E MCP Update Execution Case ${stamp}` });
    const otherCycle = await createCycleRest(request, { name: `E2E MCP Unrelated Cycle ${stamp}` });
    const otherTestcase = await createCase(request, { title: `E2E MCP Unrelated Case ${stamp}` });
    let tokenId: string | undefined;
    let executionId: string | undefined;
    let otherExecutionId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycle.id, testcase.id);
      executionId = (await getCycleExecutionsRest(request, cycle.id))[0]?.id;
      expect(executionId).toBeTruthy();

      await addCycleTestCaseRest(request, otherCycle.id, otherTestcase.id);
      otherExecutionId = (await getCycleExecutionsRest(request, otherCycle.id))[0]?.id;
      expect(otherExecutionId).toBeTruthy();

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP update_execution_result token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const updated = await callMcpTool(mcpApi, token, "update_execution_result", {
        executionId,
        status: "Passed",
        actualResult: "Worked as expected",
        assigneeId: null,
      });
      expect(updated.status).toBe("Passed");
      expect(updated.actualResult).toBe("Worked as expected");

      const executionsAfter = await getCycleExecutionsRest(request, cycle.id);
      expect(executionsAfter.find((e: { id: string }) => e.id === executionId)?.status).toBe("Passed");

      // The unrelated cycle's execution must be untouched — update_execution_result must not
      // reach beyond the one execution id it was given.
      const otherExecutionsAfter = await getCycleExecutionsRest(request, otherCycle.id);
      expect(otherExecutionsAfter.find((e: { id: string }) => e.id === otherExecutionId)?.status).toBe("Untested");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await deleteCase(request, testcase.id);
      await deleteCycleRest(request, otherCycle.id);
      await deleteCase(request, otherTestcase.id);
      await mcpApi.dispose();
    }
  });

  test("rejects get_execution and update_execution_result for an execution belonging to another project", async ({
    request,
  }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCycleId: string | undefined;
    let bTestcaseId: string | undefined;
    let bExecutionId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCycleRes = await asB.post(`/api/projects/${ctxB.projectId}/cycles`, {
        data: { name: `E2E MCP Execution Cross-Project Cycle ${Date.now()}` },
      });
      expect(bCycleRes.ok()).toBeTruthy();
      bCycleId = (await bCycleRes.json()).id;
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Execution Cross-Project Case ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bTestcaseId = (await bCaseRes.json()).id;
      await asB.post(`/api/cycles/${bCycleId}/testcases`, { data: { testcaseId: bTestcaseId } });
      const bExecutionsRes = await asB.get(`/api/cycles/${bCycleId}/executions`);
      expect(bExecutionsRes.ok()).toBeTruthy();
      bExecutionId = (await bExecutionsRes.json())[0]?.id;
      expect(bExecutionId).toBeTruthy();

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP execution cross-project token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const getError = await callMcpToolExpectError(mcpApi, token, "get_execution", { executionId: bExecutionId });
      expect(getError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const updateError = await callMcpToolExpectError(mcpApi, token, "update_execution_result", {
        executionId: bExecutionId,
        status: "Passed",
      });
      expect(updateError.code).toBe(-32001);

      const stillThere = await asB.get(`/api/cycles/${bCycleId}/executions`);
      expect((await stillThere.json()).find((e: { id: string }) => e.id === bExecutionId)?.status).toBe("Untested");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCycleId) await asB.delete(`/api/cycles/${bCycleId}`, { failOnStatusCode: false });
      if (bTestcaseId) await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bTestcaseId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects list_executions/get_execution/update_execution_result missing required ids, on ids that do not exist, and update_execution_result for a read-scoped token", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const cycle = await createCycleRest(request, { name: `E2E MCP Execution Scope Cycle ${Date.now()}` });
    const testcase = await createCase(request, { title: `E2E MCP Execution Scope Case ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    let executionId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycle.id, testcase.id);
      executionId = (await getCycleExecutionsRest(request, cycle.id))[0]?.id;
      expect(executionId).toBeTruthy();

      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP execution validation token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, writeToken, "list_executions", {})).message).toMatch(/"cycleId"/i);
      expect((await callMcpToolExpectError(mcpApi, writeToken, "get_execution", {})).message).toMatch(
        /"executionId"/i,
      );
      expect((await callMcpToolExpectError(mcpApi, writeToken, "update_execution_result", {})).message).toMatch(
        /"executionId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "get_execution", { executionId: ghostId })).message,
      ).toMatch(/not found/i);
      expect(
        (
          await callMcpToolExpectError(mcpApi, writeToken, "update_execution_result", {
            executionId: ghostId,
            status: "Passed",
          })
        ).message,
      ).toMatch(/not found/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP execution read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "update_execution_result", {
        executionId,
        status: "Passed",
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP relationship tools: link_testcase_to_bug, unlink_testcase_from_bug, get_testcase_bugs,
 * get_testcase_executions, link_requirement_to_testcase, unlink_requirement_from_testcase.
 *
 * link/unlink_testcase_to_bug wrap addBugLink/removeBugLink (bug_links) — addBugLink already
 * dedupes by (bugId, testcaseId, cycleId) both in application logic and via a DB partial unique
 * index (V117), so linking the same pair twice cannot create two rows. removeBugLink takes the
 * link's own id, not a testcaseId, so unlink_testcase_from_bug resolves it via getBug(bugId).links
 * first and is a graceful no-op (not an error) when nothing matches.
 *
 * link/unlink_requirement_to_testcase set/clear testcases.jiraIssueKey+jiraUrl (or the linear
 * equivalent) directly — there is no separate "requirements" table in this product, confirmed by
 * requirementMatrix/requirementsSummary/linkedJiraKeys all treating that column as the link. The
 * explicit-clear support these tools need (updateTestCaseWithClient, legacy.service.ts) is new:
 * previously an explicit null on these fields was indistinguishable from omitting them.
 */
test.describe("MCP link_testcase_to_bug, unlink_testcase_from_bug, and get_testcase_bugs", () => {
  test("links, duplicate-links, lists, and unlinks a test case and a bug without deleting either", async ({
    request,
  }) => {
    const stamp = Date.now();
    const testcase = await createCase(request, { title: `E2E MCP Link Bug Case ${stamp}` });
    const bug = await createBugRest(request, { title: `E2E MCP Link Bug ${stamp}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link_testcase_to_bug token ${stamp}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const linked = await callMcpTool(mcpApi, token, "link_testcase_to_bug", {
        bugId: bug.id,
        testcaseId: testcase.id,
      });
      expect(linked.links.filter((l: { testcaseId: string }) => l.testcaseId === testcase.id)).toHaveLength(1);

      // Duplicate link: must not create a second row (addBugLink's own dedup, both app-level and
      // the V117 partial unique index).
      const linkedAgain = await callMcpTool(mcpApi, token, "link_testcase_to_bug", {
        bugId: bug.id,
        testcaseId: testcase.id,
      });
      expect(linkedAgain.links.filter((l: { testcaseId: string }) => l.testcaseId === testcase.id)).toHaveLength(1);

      const fetchedBug = await (await request.get(`/api/bugs/${bug.id}`)).json();
      expect(fetchedBug.links.filter((l: { testcaseId: string }) => l.testcaseId === testcase.id)).toHaveLength(1);

      const testcaseBugs = await callMcpTool(mcpApi, token, "get_testcase_bugs", { testcaseId: testcase.id });
      expect(testcaseBugs.bugs.some((b: { id: string }) => b.id === bug.id)).toBe(true);

      const unlinked = await callMcpTool(mcpApi, token, "unlink_testcase_from_bug", {
        bugId: bug.id,
        testcaseId: testcase.id,
      });
      expect(unlinked).toEqual({ ok: true, bugId: bug.id, testcaseId: testcase.id, wasLinked: true });

      const fetchedAfterUnlink = await (await request.get(`/api/bugs/${bug.id}`)).json();
      expect(fetchedAfterUnlink.links.some((l: { testcaseId: string }) => l.testcaseId === testcase.id)).toBe(false);

      const bugsAfterUnlink = await callMcpTool(mcpApi, token, "get_testcase_bugs", { testcaseId: testcase.id });
      expect(bugsAfterUnlink.bugs.some((b: { id: string }) => b.id === bug.id)).toBe(false);

      // Unlinking again is a graceful no-op, not an error — and neither entity was ever deleted.
      const unlinkedAgain = await callMcpTool(mcpApi, token, "unlink_testcase_from_bug", {
        bugId: bug.id,
        testcaseId: testcase.id,
      });
      expect(unlinkedAgain).toEqual({ ok: true, bugId: bug.id, testcaseId: testcase.id, wasLinked: false });

      const stillTestcase = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`);
      expect(stillTestcase.ok()).toBeTruthy();
      const stillBug = await request.get(`/api/bugs/${bug.id}`);
      expect(stillBug.ok()).toBeTruthy();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteBugRest(request, bug.id);
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });

  test("rejects link/unlink/get_testcase_bugs for a test case or bug belonging to another project", async ({
    request,
  }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bTestcaseId: string | undefined;
    let bBugId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Link Cross-Project Case ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bTestcaseId = (await bCaseRes.json()).id;
      const bBugRes = await asB.post(`/api/projects/${ctxB.projectId}/bugs`, {
        data: { title: `E2E MCP Link Cross-Project Bug ${Date.now()}` },
      });
      expect(bBugRes.ok()).toBeTruthy();
      bBugId = (await bBugRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link cross-project token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      // A token scoped to project A must not be able to link/read using either a foreign
      // testcaseId or a foreign bugId, even if the other id is a real one in project A.
      const localCase = await createCase(request, { title: `E2E MCP Link Local Case ${Date.now()}` });
      const localBug = await createBugRest(request, { title: `E2E MCP Link Local Bug ${Date.now()}` });

      try {
        const foreignBugError = await callMcpToolExpectError(mcpApi, token, "link_testcase_to_bug", {
          bugId: bBugId,
          testcaseId: localCase.id,
        });
        expect(foreignBugError.code).toBe(-32001); // RpcCode.ProjectScopeDenied

        const foreignCaseError = await callMcpToolExpectError(mcpApi, token, "link_testcase_to_bug", {
          bugId: localBug.id,
          testcaseId: bTestcaseId,
        });
        expect(foreignCaseError.code).toBe(-32001);

        const unlinkError = await callMcpToolExpectError(mcpApi, token, "unlink_testcase_from_bug", {
          bugId: bBugId,
          testcaseId: localCase.id,
        });
        expect(unlinkError.code).toBe(-32001);

        const getBugsError = await callMcpToolExpectError(mcpApi, token, "get_testcase_bugs", { testcaseId: bTestcaseId });
        expect(getBugsError.code).toBe(-32001);
      } finally {
        await deleteCase(request, localCase.id);
        await deleteBugRest(request, localBug.id);
      }
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bTestcaseId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bTestcaseId}`, { failOnStatusCode: false });
      }
      if (bBugId) await asB.delete(`/api/bugs/${bBugId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects link/unlink/get_testcase_bugs on ids that do not exist, missing required arguments, and for a read-scoped token", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const testcase = await createCase(request, { title: `E2E MCP Link Scope Case ${Date.now()}` });
    const bug = await createBugRest(request, { title: `E2E MCP Link Scope Bug ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link validation token ${Date.now()}`, scopes: ["read", "write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "link_testcase_to_bug", { testcaseId: testcase.id })).message,
      ).toMatch(/"bugId"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "link_testcase_to_bug", { bugId: bug.id })).message,
      ).toMatch(/"testcaseId"/i);
      expect((await callMcpToolExpectError(mcpApi, writeToken, "get_testcase_bugs", {})).message).toMatch(
        /"testcaseId"/i,
      );

      const ghostBugError = await callMcpToolExpectError(mcpApi, writeToken, "link_testcase_to_bug", {
        bugId: ghostId,
        testcaseId: testcase.id,
      });
      expect(ghostBugError.message).toMatch(/not found/i);
      const ghostCaseError = await callMcpToolExpectError(mcpApi, writeToken, "link_testcase_to_bug", {
        bugId: bug.id,
        testcaseId: ghostId,
      });
      expect(ghostCaseError.message).toMatch(/not found/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "link_testcase_to_bug", {
        bugId: bug.id,
        testcaseId: testcase.id,
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteBugRest(request, bug.id);
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP get_testcase_executions", () => {
  test("lists a test case's executions across every cycle it has been added to", async ({ request }) => {
    const stamp = Date.now();
    const testcase = await createCase(request, { title: `E2E MCP Testcase Executions ${stamp}` });
    const cycleA = await createCycleRest(request, { name: `E2E MCP Testcase Executions Cycle A ${stamp}` });
    const cycleB = await createCycleRest(request, { name: `E2E MCP Testcase Executions Cycle B ${stamp}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycleA.id, testcase.id);
      await addCycleTestCaseRest(request, cycleB.id, testcase.id);

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_testcase_executions token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "get_testcase_executions", { testcaseId: testcase.id });
      const executions = result.executions as Array<{ cycleId: string }>;
      expect(executions).toHaveLength(2);
      expect(executions.some((e) => e.cycleId === cycleA.id)).toBe(true);
      expect(executions.some((e) => e.cycleId === cycleB.id)).toBe(true);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycleA.id);
      await deleteCycleRest(request, cycleB.id);
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });

  test("rejects get_testcase_executions missing testcaseId, on a test case that does not exist, and across projects", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Testcase Executions Cross-Project ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_testcase_executions validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, token, "get_testcase_executions", {})).message).toMatch(
        /"testcaseId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, token, "get_testcase_executions", { testcaseId: ghostId })).message,
      ).toMatch(/not found/i);
      const crossProjectError = await callMcpToolExpectError(mcpApi, token, "get_testcase_executions", {
        testcaseId: bCaseId,
      });
      expect(crossProjectError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCaseId) await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP link_requirement_to_testcase and unlink_requirement_from_testcase", () => {
  test("links, duplicate-links, and unlinks a Jira requirement without touching anything else on the test case", async ({
    request,
  }) => {
    const stamp = Date.now();
    const testcase = await createCase(request, { title: `E2E MCP Link Requirement ${stamp}`, priority: "High" });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link_requirement token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const linked = await callMcpTool(mcpApi, token, "link_requirement_to_testcase", {
        testcaseId: testcase.id,
        jiraIssueKey: `E2E-${stamp}`,
        jiraUrl: `https://example.atlassian.net/browse/E2E-${stamp}`,
      });
      expect(linked.jiraIssueKey).toBe(`E2E-${stamp}`);
      expect(linked.jiraUrl).toBe(`https://example.atlassian.net/browse/E2E-${stamp}`);
      expect(linked.priority).toBe("High");

      // Linking the same requirement again just re-sets the same value — no duplication is
      // possible since this is a plain column, not a join table.
      const linkedAgain = await callMcpTool(mcpApi, token, "link_requirement_to_testcase", {
        testcaseId: testcase.id,
        jiraIssueKey: `E2E-${stamp}`,
      });
      expect(linkedAgain.jiraIssueKey).toBe(`E2E-${stamp}`);

      const fetchedLinked = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`)).json();
      expect(fetchedLinked.jiraIssueKey).toBe(`E2E-${stamp}`);

      const unlinked = await callMcpTool(mcpApi, token, "unlink_requirement_from_testcase", {
        testcaseId: testcase.id,
        provider: "jira",
      });
      expect(unlinked.jiraIssueKey ?? null).toBeNull();
      expect(unlinked.jiraUrl ?? null).toBeNull();
      expect(unlinked.priority).toBe("High");

      const fetchedUnlinked = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`)).json();
      expect(fetchedUnlinked.jiraIssueKey ?? null).toBeNull();

      // Unlinking again is a graceful no-op, not an error.
      const unlinkedAgain = await callMcpTool(mcpApi, token, "unlink_requirement_from_testcase", {
        testcaseId: testcase.id,
        provider: "jira",
      });
      expect(unlinkedAgain.jiraIssueKey ?? null).toBeNull();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });

  test("rejects link_requirement_to_testcase with neither or both provider keys, and an invalid unlink provider", async ({
    request,
  }) => {
    const testcase = await createCase(request, { title: `E2E MCP Link Requirement Validation ${Date.now()}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link_requirement validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const neitherError = await callMcpToolExpectError(mcpApi, token, "link_requirement_to_testcase", {
        testcaseId: testcase.id,
      });
      expect(neitherError.message).toMatch(/jiraIssueKey.*linearIssueKey|linearIssueKey.*jiraIssueKey/i);

      const bothError = await callMcpToolExpectError(mcpApi, token, "link_requirement_to_testcase", {
        testcaseId: testcase.id,
        jiraIssueKey: "PROJ-1",
        linearIssueKey: "ENG-1",
      });
      expect(bothError.message).toMatch(/only one of/i);

      const badProviderError = await callMcpToolExpectError(mcpApi, token, "unlink_requirement_from_testcase", {
        testcaseId: testcase.id,
        provider: "github",
      });
      expect(badProviderError.message).toMatch(/"provider" must be "jira" or "linear"/i);

      expect((await callMcpToolExpectError(mcpApi, token, "link_requirement_to_testcase", {})).message).toMatch(
        /"testcaseId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, token, "unlink_requirement_from_testcase", { testcaseId: testcase.id })).message,
      ).toMatch(/"provider"/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, testcase.id);
      await mcpApi.dispose();
    }
  });

  test("rejects link/unlink_requirement_to_testcase for a test case belonging to another project, and for a read-scoped token", async ({
    request,
  }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    const localCase = await createCase(request, { title: `E2E MCP Link Requirement Scope ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Link Requirement Cross-Project ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link_requirement cross-project token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      const linkError = await callMcpToolExpectError(mcpApi, writeToken, "link_requirement_to_testcase", {
        testcaseId: bCaseId,
        jiraIssueKey: "PROJ-1",
      });
      expect(linkError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const unlinkError = await callMcpToolExpectError(mcpApi, writeToken, "unlink_requirement_from_testcase", {
        testcaseId: bCaseId,
        provider: "jira",
      });
      expect(unlinkError.code).toBe(-32001);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP link_requirement read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "link_requirement_to_testcase", {
        testcaseId: localCase.id,
        jiraIssueKey: "PROJ-1",
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      if (bCaseId) await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      await deleteCase(request, localCase.id);
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP read access to the Knowledge Base: list_knowledge_documents, get_knowledge_document,
 * list_knowledge_folders, get_knowledge_folder. All four close a read-only gap — MCP could create/
 * update/move KB documents and folders but never list or inspect one afterwards. Unlike testcases/
 * suites/bugs/cycles, the underlying legacy methods (kbDocument/kbFolder) already filter by
 * project_id internally, so these tools need no extra ownership pre-check of their own — a
 * foreign-project id 404s from inside the call itself, exactly like the REST GET routes that
 * share it (see api/knowledge-base.spec.ts for the REST-level equivalent coverage).
 */
test.describe("MCP list_knowledge_documents and get_knowledge_document", () => {
  test("lists and gets a Knowledge Base document created via REST, scoped to the token's project", async ({
    request,
  }) => {
    const stamp = Date.now();
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let documentId: string | undefined;
    let bDocumentId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const rootFolderId = await getKbRootFolderId(request);
      const doc = await createKbDocumentRest(request, rootFolderId, {
        title: `E2E MCP List KB Doc ${stamp}`,
        contentText: "Steps to reset a forgotten password",
        documentType: "general",
      });
      documentId = doc.id;

      // A document in account B's own project must never appear in account A's
      // list_knowledge_documents.
      const bRootFolderId = await getKbRootFolderId(asB, ctxB.projectId);
      const bDocRes = await asB.post(`/api/projects/${ctxB.projectId}/knowledge-base/documents`, {
        data: { title: `E2E MCP Cross-Project KB Doc ${stamp}`, folderId: bRootFolderId },
      });
      expect(bDocRes.ok()).toBeTruthy();
      bDocumentId = (await bDocRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP list/get_knowledge_document token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const listed = await callMcpTool(mcpApi, token, "list_knowledge_documents", { documentType: "general" });
      const docs = listed.list as Array<{ id: string }>;
      expect(docs.some((d) => d.id === documentId)).toBe(true);
      expect(docs.some((d) => d.id === bDocumentId)).toBe(false);

      const fetched = await callMcpTool(mcpApi, token, "get_knowledge_document", { documentId });
      expect(fetched.id).toBe(documentId);
      expect(fetched.title).toBe(`E2E MCP List KB Doc ${stamp}`);
      expect(fetched.contentText).toBe("Steps to reset a forgotten password");
      expect(Array.isArray(fetched.breadcrumb)).toBe(true);
      expect(fetched.breadcrumb[fetched.breadcrumb.length - 1].id).toBe(rootFolderId);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (documentId) await deleteKbDocumentRest(request, documentId);
      if (bDocumentId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/knowledge-base/documents/${bDocumentId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects get_knowledge_document missing documentId, on a document that does not exist, and across projects", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bDocumentId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bRootFolderId = await getKbRootFolderId(asB, ctxB.projectId);
      const bDocRes = await asB.post(`/api/projects/${ctxB.projectId}/knowledge-base/documents`, {
        data: { title: `E2E MCP Get KB Cross-Project ${Date.now()}`, folderId: bRootFolderId },
      });
      expect(bDocRes.ok()).toBeTruthy();
      bDocumentId = (await bDocRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_knowledge_document validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, token, "get_knowledge_document", {})).message).toMatch(
        /"documentId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, token, "get_knowledge_document", { documentId: ghostId })).message,
      ).toMatch(/document not found/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "get_knowledge_document", { documentId: bDocumentId })).message,
      ).toMatch(/document not found/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bDocumentId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/knowledge-base/documents/${bDocumentId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP list_knowledge_folders and get_knowledge_folder", () => {
  test("lists the folder tree and gets one folder created via REST, scoped to the token's project", async ({
    request,
  }) => {
    const stamp = Date.now();
    let tokenId: string | undefined;
    let folderId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const rootFolderId = await getKbRootFolderId(request);
      const folder = await createKbFolderRest(request, {
        name: `E2E MCP List KB Folder ${stamp}`,
        parentFolderId: rootFolderId,
      });
      folderId = folder.id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP list/get_knowledge_folder token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const tree = await callMcpTool(mcpApi, token, "list_knowledge_folders", {});
      expect(tree.isRoot).toBe(true);
      expect(tree.id).toBe(rootFolderId);
      expect(tree.children.some((c: { id: string; name: string }) => c.id === folderId)).toBe(true);

      const fetched = await callMcpTool(mcpApi, token, "get_knowledge_folder", { folderId });
      expect(fetched.id).toBe(folderId);
      expect(fetched.name).toBe(`E2E MCP List KB Folder ${stamp}`);
      expect(fetched.parentFolderId).toBe(rootFolderId);
      expect(fetched.breadcrumb[fetched.breadcrumb.length - 1].id).toBe(folderId);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (folderId) await deleteKbFolderRest(request, folderId);
      await mcpApi.dispose();
    }
  });

  test("rejects get_knowledge_folder missing folderId, on a folder that does not exist, and across projects", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bFolderId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bRootFolderId = await getKbRootFolderId(asB, ctxB.projectId);
      const bFolderRes = await asB.post(`/api/projects/${ctxB.projectId}/knowledge-base/folders`, {
        data: { name: `E2E MCP Get KB Folder Cross-Project ${Date.now()}`, parentFolderId: bRootFolderId },
      });
      expect(bFolderRes.ok()).toBeTruthy();
      bFolderId = (await bFolderRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_knowledge_folder validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, token, "get_knowledge_folder", {})).message).toMatch(
        /"folderId"/i,
      );
      expect(
        (await callMcpToolExpectError(mcpApi, token, "get_knowledge_folder", { folderId: ghostId })).message,
      ).toMatch(/folder not found/i);
      expect(
        (await callMcpToolExpectError(mcpApi, token, "get_knowledge_folder", { folderId: bFolderId })).message,
      ).toMatch(/folder not found/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bFolderId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/knowledge-base/folders/${bFolderId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

/*
 * archive_knowledge_document/restore_knowledge_document: soft-delete/restore via is_deleted +
 * deleted_at — there is no status="Archived" concept for KB documents the way testcases have one.
 * Deliberately asymmetric, matching deleteKnowledgeDocument/restoreKnowledgeDocument's own real
 * behavior: archiving an already-archived document 404s (kbDocument's own lookup excludes
 * is_deleted rows), but restoring an already-active document is a genuine idempotent no-op.
 * Restoring requires the account's project role to be owner/manager — the smoke tenant's account A
 * is the workspace owner (provisioned by global-setup.ts's signup flow), so this is not specially
 * arranged here.
 */
test.describe("MCP archive_knowledge_document and restore_knowledge_document", () => {
  test("archives and restores a document without touching its content or folder location", async ({ request }) => {
    const stamp = Date.now();
    let tokenId: string | undefined;
    let documentId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const rootFolderId = await getKbRootFolderId(request);
      const doc = await createKbDocumentRest(request, rootFolderId, {
        title: `E2E MCP Archive KB Doc ${stamp}`,
        contentText: "Original content",
      });
      documentId = doc.id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive_knowledge_document token ${stamp}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      await callMcpTool(mcpApi, token, "archive_knowledge_document", { documentId });

      // Archived documents are excluded from lookup the same way a nonexistent one is.
      const fetchedWhileArchived = await request.get(
        `/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`,
        { failOnStatusCode: false },
      );
      expect(fetchedWhileArchived.status()).toBe(404);

      const listedWhileArchived = await callMcpTool(mcpApi, token, "list_knowledge_documents", {});
      expect(listedWhileArchived.list.some((d: { id: string }) => d.id === documentId)).toBe(false);

      // Archiving an already-archived document 404s — not a silent no-op.
      const doubleArchiveError = await callMcpToolExpectError(mcpApi, token, "archive_knowledge_document", {
        documentId,
      });
      expect(doubleArchiveError.message).toMatch(/document not found/i);

      const restored = await callMcpTool(mcpApi, token, "restore_knowledge_document", { documentId });
      expect(restored.id).toBe(documentId);
      expect(restored.isDeleted).toBe(false);

      const fetchedAfterRestore = await (
        await request.get(`/api/projects/${ctx.projectId}/knowledge-base/documents/${documentId}`)
      ).json();
      expect(fetchedAfterRestore.title).toBe(`E2E MCP Archive KB Doc ${stamp}`);
      expect(fetchedAfterRestore.contentText).toBe("Original content");
      expect(fetchedAfterRestore.folderId).toBe(rootFolderId);

      const listedAfterRestore = await callMcpTool(mcpApi, token, "list_knowledge_documents", {});
      expect(listedAfterRestore.list.some((d: { id: string }) => d.id === documentId)).toBe(true);

      // Restoring an already-active document is a genuine idempotent no-op, not an error.
      const restoredAgain = await callMcpTool(mcpApi, token, "restore_knowledge_document", { documentId });
      expect(restoredAgain.isDeleted).toBe(false);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (documentId) await deleteKbDocumentRest(request, documentId);
      await mcpApi.dispose();
    }
  });

  test("rejects archive/restore_knowledge_document for a document belonging to another project", async ({
    request,
  }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bDocumentId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bRootFolderId = await getKbRootFolderId(asB, ctxB.projectId);
      const bDocRes = await asB.post(`/api/projects/${ctxB.projectId}/knowledge-base/documents`, {
        data: { title: `E2E MCP Archive Cross-Project ${Date.now()}`, folderId: bRootFolderId },
      });
      expect(bDocRes.ok()).toBeTruthy();
      bDocumentId = (await bDocRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive cross-project token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const archiveError = await callMcpToolExpectError(mcpApi, token, "archive_knowledge_document", {
        documentId: bDocumentId,
      });
      expect(archiveError.message).toMatch(/document not found/i);
      const restoreError = await callMcpToolExpectError(mcpApi, token, "restore_knowledge_document", {
        documentId: bDocumentId,
      });
      expect(restoreError.message).toMatch(/document not found/i);

      const stillThere = await asB.get(`/api/projects/${ctxB.projectId}/knowledge-base/documents/${bDocumentId}`);
      expect(stillThere.ok()).toBeTruthy();
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bDocumentId) {
        await asB.delete(`/api/projects/${ctxB.projectId}/knowledge-base/documents/${bDocumentId}`, { failOnStatusCode: false });
      }
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects archive/restore_knowledge_document missing documentId, and for a read-scoped token", async ({
    request,
  }) => {
    const rootFolderId = await getKbRootFolderId(request);
    const doc = await createKbDocumentRest(request, rootFolderId, {
      title: `E2E MCP Archive Scope Doc ${Date.now()}`,
    });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect((await callMcpToolExpectError(mcpApi, writeToken, "archive_knowledge_document", {})).message).toMatch(
        /"documentId"/i,
      );
      expect((await callMcpToolExpectError(mcpApi, writeToken, "restore_knowledge_document", {})).message).toMatch(
        /"documentId"/i,
      );

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP archive read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const archiveScopeError = await callMcpToolExpectError(mcpApi, readToken, "archive_knowledge_document", {
        documentId: doc.id,
      });
      expect(archiveScopeError.code).toBe(-32002); // RpcCode.ScopeDenied
      const restoreScopeError = await callMcpToolExpectError(mcpApi, readToken, "restore_knowledge_document", {
        documentId: doc.id,
      });
      expect(restoreScopeError.code).toBe(-32002);

      const fetched = await (
        await request.get(`/api/projects/${ctx.projectId}/knowledge-base/documents/${doc.id}`)
      ).json();
      expect(fetched.isDeleted).toBe(false);
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteKbDocumentRest(request, doc.id);
      await mcpApi.dispose();
    }
  });
});

/*
 * MCP bulk-operation and AI-workflow tools: duplicate_testcase, bulk_create_testcases,
 * bulk_update_testcases, bulk_archive_testcases, bulk_record_execution_results,
 * clone_test_suite, create_cycle_from_testcases, get_test_execution_summary.
 *
 * The four "bulk_*" tools deliberately give per-item results rather than an atomic all-or-nothing
 * outcome (unlike the app's own bulk-import path) — one bad item in a batch must never silently
 * affect, or block, the rest. Every test below that mixes a valid id with an invalid one asserts
 * both halves: the valid items actually persisted, and the invalid one is reported, not just
 * counted.
 */
test.describe("MCP duplicate_testcase", () => {
  test("creates a copy without modifying the original", async ({ request }) => {
    const stamp = Date.now();
    const suite = await createSuiteRest(request, { name: `E2E MCP Duplicate Suite ${stamp}` });
    const original = await createCase(request, {
      title: `E2E MCP Duplicate ${stamp}`,
      suiteId: suite.id,
      priority: "High",
      description: "Original description",
    });
    let tokenId: string | undefined;
    let copyId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP duplicate_testcase token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const copy = await callMcpTool(mcpApi, token, "duplicate_testcase", { testcaseId: original.id });
      copyId = copy.id;
      expect(copyId).not.toBe(original.id);
      expect(copy.title).toBe(`${original.title} (copy)`);
      expect(copy.suiteId).toBe(suite.id);
      expect(copy.priority).toBe("High");
      expect(copy.description).toBe("Original description");
      expect(copy.externalId).not.toBe(original.externalId);

      const fetchedOriginal = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${original.id}`)).json();
      expect(fetchedOriginal.title).toBe(original.title);
      expect(fetchedOriginal.title.endsWith("(copy)")).toBe(false);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (copyId) await deleteCase(request, copyId);
      await deleteCase(request, original.id);
      await deleteSuiteRest(request, suite.id);
      await mcpApi.dispose();
    }
  });

  test("rejects duplicate_testcase for a test case belonging to another project, and on a nonexistent id", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Duplicate Cross-Project ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP duplicate validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const crossProjectError = await callMcpToolExpectError(mcpApi, token, "duplicate_testcase", { testcaseId: bCaseId });
      expect(crossProjectError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const notFoundError = await callMcpToolExpectError(mcpApi, token, "duplicate_testcase", { testcaseId: ghostId });
      expect(notFoundError.message).toMatch(/not found/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCaseId) await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP bulk_create_testcases", () => {
  test("creates every valid item and reports an invalid one separately, without blocking the batch", async ({
    request,
  }) => {
    const stamp = Date.now();
    let tokenId: string | undefined;
    let createdIds: string[] = [];
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_create_testcases token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "bulk_create_testcases", {
        testcases: [
          { title: `E2E MCP Bulk Create A ${stamp}`, priority: "High" },
          { title: "" }, // invalid: empty title
          { title: `E2E MCP Bulk Create B ${stamp}`, priority: "Low" },
        ],
      });
      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results[0].ok).toBe(true);
      expect(result.results[1]).toEqual({ index: 1, ok: false, error: expect.stringMatching(/title/i) });
      expect(result.results[2].ok).toBe(true);
      createdIds = [result.results[0].testcase.id, result.results[2].testcase.id];

      const fetchedA = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${createdIds[0]}`)).json();
      expect(fetchedA.title).toBe(`E2E MCP Bulk Create A ${stamp}`);
      expect(fetchedA.priority).toBe("High");
      const fetchedB = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${createdIds[1]}`)).json();
      expect(fetchedB.title).toBe(`E2E MCP Bulk Create B ${stamp}`);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      for (const id of createdIds) await deleteCase(request, id);
      await mcpApi.dispose();
    }
  });

  test("rejects an empty testcases array, and for a read-scoped token", async ({ request }) => {
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      // Scope is checked before argument validation (mcp.service.ts callTool), so a read-scoped
      // token can never reach the empty-array check — it needs write scope to get there at all.
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_create validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      const emptyError = await callMcpToolExpectError(mcpApi, writeToken, "bulk_create_testcases", { testcases: [] });
      expect(emptyError.message).toMatch(/non-empty array/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_create read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "bulk_create_testcases", {
        testcases: [{ title: "Should be refused" }],
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP bulk_update_testcases and bulk_archive_testcases", () => {
  test("bulk_update_testcases updates only the requested cases, reports an invalid id, and is safe to repeat with duplicates", async ({
    request,
  }) => {
    const stamp = Date.now();
    const tcA = await createCase(request, { title: `E2E MCP Bulk Update A ${stamp}`, priority: "Low" });
    const tcB = await createCase(request, { title: `E2E MCP Bulk Update B ${stamp}`, priority: "Low" });
    const control = await createCase(request, { title: `E2E MCP Bulk Update Control ${stamp}`, priority: "Low" });
    const ghostId = "00000000-0000-0000-0000-000000000000";
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_update_testcases token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      // Deliberately duplicate tcA.id in the input.
      const result = await callMcpTool(mcpApi, token, "bulk_update_testcases", {
        testcaseIds: [tcA.id, tcA.id, tcB.id, ghostId],
        priority: "High",
      });
      expect(result.total).toBe(3); // deduplicated before counting
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results.find((r: { id: string }) => r.id === ghostId)).toEqual({
        id: ghostId,
        ok: false,
        error: "Test case not found in this project",
      });

      const fetchedA = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${tcA.id}`)).json();
      expect(fetchedA.priority).toBe("High");
      const fetchedB = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${tcB.id}`)).json();
      expect(fetchedB.priority).toBe("High");
      // Unrelated case, not named in the batch, is untouched.
      const fetchedControl = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${control.id}`)).json();
      expect(fetchedControl.priority).toBe("Low");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, tcA.id);
      await deleteCase(request, tcB.id);
      await deleteCase(request, control.id);
      await mcpApi.dispose();
    }
  });

  test("bulk_archive_testcases archives without deleting, leaving an invalid id reported and an unrelated case untouched", async ({
    request,
  }) => {
    const stamp = Date.now();
    const title = `E2E MCP Bulk Archive ${stamp}`;
    const tcA = await createCase(request, { title });
    const tcB = await createCase(request, { title: `E2E MCP Bulk Archive B ${stamp}` });
    const control = await createCase(request, { title: `E2E MCP Bulk Archive Control ${stamp}` });
    const ghostId = "00000000-0000-0000-0000-000000000000";
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_archive_testcases token ${stamp}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "bulk_archive_testcases", { testcaseIds: [tcA.id, tcB.id, ghostId] });
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);

      // Archived, not deleted: still a 200 with status Archived, not a 404.
      const fetchedA = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${tcA.id}`)).json();
      expect(fetchedA.status).toBe("Archived");
      const fetchedB = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${tcB.id}`)).json();
      expect(fetchedB.status).toBe("Archived");
      const fetchedControl = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${control.id}`)).json();
      expect(fetchedControl.status).not.toBe("Archived");

      const withoutArchived = await callMcpTool(mcpApi, token, "list_testcases", { search: title });
      expect(withoutArchived.rows.some((r: { id: string }) => r.id === tcA.id)).toBe(false);
      const withArchived = await callMcpTool(mcpApi, token, "list_testcases", { search: title, includeArchived: true });
      expect(withArchived.rows.some((r: { id: string }) => r.id === tcA.id)).toBe(true);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, tcA.id);
      await deleteCase(request, tcB.id);
      await deleteCase(request, control.id);
      await mcpApi.dispose();
    }
  });

  test("rejects bulk_update_testcases and bulk_archive_testcases for a read-scoped token, and an empty testcaseIds array", async ({
    request,
  }) => {
    const tc = await createCase(request, { title: `E2E MCP Bulk Scope ${Date.now()}` });
    let tokenId: string | undefined;
    let writeTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const updateScopeError = await callMcpToolExpectError(mcpApi, token, "bulk_update_testcases", {
        testcaseIds: [tc.id],
        priority: "High",
      });
      expect(updateScopeError.code).toBe(-32002); // RpcCode.ScopeDenied
      const archiveScopeError = await callMcpToolExpectError(mcpApi, token, "bulk_archive_testcases", { testcaseIds: [tc.id] });
      expect(archiveScopeError.code).toBe(-32002);

      // Scope is checked before argument validation, so the empty-array message can only be
      // reached with a token that actually has write scope.
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk empty-array token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "bulk_update_testcases", { testcaseIds: [] })).message,
      ).toMatch(/non-empty array/i);

      const fetched = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${tc.id}`)).json();
      expect(fetched.status).not.toBe("Archived");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, tc.id);
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP bulk_record_execution_results", () => {
  test("records every valid execution and reports an invalid one, without touching an unrelated execution", async ({
    request,
  }) => {
    const stamp = Date.now();
    const cycle = await createCycleRest(request, { name: `E2E MCP Bulk Executions Cycle ${stamp}` });
    const tcA = await createCase(request, { title: `E2E MCP Bulk Exec A ${stamp}` });
    const tcB = await createCase(request, { title: `E2E MCP Bulk Exec B ${stamp}` });
    const otherCycle = await createCycleRest(request, { name: `E2E MCP Bulk Executions Unrelated Cycle ${stamp}` });
    const otherCase = await createCase(request, { title: `E2E MCP Bulk Exec Unrelated ${stamp}` });
    const ghostId = "00000000-0000-0000-0000-000000000000";
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycle.id, tcA.id);
      await addCycleTestCaseRest(request, cycle.id, tcB.id);
      const executions = await getCycleExecutionsRest(request, cycle.id);
      const execA = executions.find((e: { testcaseId: string }) => e.testcaseId === tcA.id);
      const execB = executions.find((e: { testcaseId: string }) => e.testcaseId === tcB.id);
      expect(execA?.id).toBeTruthy();
      expect(execB?.id).toBeTruthy();

      await addCycleTestCaseRest(request, otherCycle.id, otherCase.id);
      const otherExecutionId = (await getCycleExecutionsRest(request, otherCycle.id))[0]?.id;
      expect(otherExecutionId).toBeTruthy();

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_record_execution_results token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "bulk_record_execution_results", {
        results: [
          { executionId: execA.id, status: "Passed", actualResult: "Worked" },
          { executionId: ghostId, status: "Failed" },
          { executionId: execB.id, status: "Blocked" },
        ],
      });
      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results[1].ok).toBe(false);
      expect(result.results[1].error).toMatch(/not found/i);

      const executionsAfter = await getCycleExecutionsRest(request, cycle.id);
      expect(executionsAfter.find((e: { id: string }) => e.id === execA.id)?.status).toBe("Passed");
      expect(executionsAfter.find((e: { id: string }) => e.id === execB.id)?.status).toBe("Blocked");

      const otherExecutionsAfter = await getCycleExecutionsRest(request, otherCycle.id);
      expect(otherExecutionsAfter.find((e: { id: string }) => e.id === otherExecutionId)?.status).toBe("Untested");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await deleteCase(request, tcA.id);
      await deleteCase(request, tcB.id);
      await deleteCycleRest(request, otherCycle.id);
      await deleteCase(request, otherCase.id);
      await mcpApi.dispose();
    }
  });

  test("rejects an execution belonging to another project as a per-item failure, not a whole-call error", async ({
    request,
  }) => {
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    const cycle = await createCycleRest(request, { name: `E2E MCP Bulk Exec Cross-Project Cycle ${Date.now()}` });
    const tc = await createCase(request, { title: `E2E MCP Bulk Exec Cross-Project Case ${Date.now()}` });
    let tokenId: string | undefined;
    let bCycleId: string | undefined;
    let bTestcaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycle.id, tc.id);
      const execution = (await getCycleExecutionsRest(request, cycle.id))[0];
      expect(execution?.id).toBeTruthy();

      const bCycleRes = await asB.post(`/api/projects/${ctxB.projectId}/cycles`, {
        data: { name: `E2E MCP Bulk Exec Foreign Cycle ${Date.now()}` },
      });
      expect(bCycleRes.ok()).toBeTruthy();
      bCycleId = (await bCycleRes.json()).id;
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Bulk Exec Foreign Case ${Date.now()}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bTestcaseId = (await bCaseRes.json()).id;
      await asB.post(`/api/cycles/${bCycleId}/testcases`, { data: { testcaseId: bTestcaseId } });
      const bExecution = (await (await asB.get(`/api/cycles/${bCycleId}/executions`)).json())[0];
      expect(bExecution?.id).toBeTruthy();

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP bulk_record cross-project token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "bulk_record_execution_results", {
        results: [
          { executionId: execution.id, status: "Passed" },
          { executionId: bExecution.id, status: "Passed" },
        ],
      });
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results[1].ok).toBe(false);

      const stillThere = await (await asB.get(`/api/cycles/${bCycleId}/executions`)).json();
      expect(stillThere.find((e: { id: string }) => e.id === bExecution.id)?.status).toBe("Untested");
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await deleteCase(request, tc.id);
      if (bCycleId) await asB.delete(`/api/cycles/${bCycleId}`, { failOnStatusCode: false });
      if (bTestcaseId) await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bTestcaseId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP clone_test_suite", () => {
  test("deep-clones a suite's sub-suite and test cases, leaving the original subtree untouched", async ({ request }) => {
    const stamp = Date.now();
    const sourceParent = await createSuiteRest(request, { name: `E2E MCP Clone Source ${stamp}` });
    const sourceChild = await createSuiteRest(request, { name: `E2E MCP Clone Source Child ${stamp}`, parentId: sourceParent.id });
    const caseInParent = await createCase(request, { title: `E2E MCP Clone Case Parent ${stamp}`, suiteId: sourceParent.id });
    const caseInChild = await createCase(request, { title: `E2E MCP Clone Case Child ${stamp}`, suiteId: sourceChild.id });
    let tokenId: string | undefined;
    let clonedParentId: string | undefined;
    let clonedChildId: string | undefined;
    let clonedCaseIds: string[] = [];
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP clone_test_suite token ${stamp}`, scopes: ["read", "write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "clone_test_suite", { suiteId: sourceParent.id });
      clonedParentId = result.clonedSuiteId;
      expect(clonedParentId).not.toBe(sourceParent.id);
      expect(result.suiteCount).toBe(2);
      expect(result.testcaseCount).toBe(2);
      clonedCaseIds = result.testcases.map((t: { clonedId: string }) => t.clonedId);

      const clonedTree = await callMcpTool(mcpApi, token, "list_suites", {});
      const clonedParentRow = clonedTree.suites.find((s: { id: string }) => s.id === clonedParentId);
      expect(clonedParentRow).toBeTruthy();
      expect(clonedParentRow.name).toBe(`${sourceParent.name} (copy)`);
      const clonedChildRow = clonedTree.suites.find(
        (s: { parentId: string; name: string }) => s.parentId === clonedParentId && s.name === sourceChild.name,
      );
      expect(clonedChildRow).toBeTruthy();
      clonedChildId = clonedChildRow.id;

      // Original suites and test cases are completely unchanged.
      const originalParentCases = await callMcpTool(mcpApi, token, "list_testcases", { suiteId: sourceParent.id });
      expect(originalParentCases.rows.some((r: { id: string }) => r.id === caseInParent.id)).toBe(true);
      const fetchedOriginalChildCase = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${caseInChild.id}`)
      ).json();
      expect(fetchedOriginalChildCase.suiteId).toBe(sourceChild.id);
      expect(fetchedOriginalChildCase.title).toBe(caseInChild.title);

      // The cloned test case in the cloned child suite is a real, independent copy.
      const clonedChildCases = await callMcpTool(mcpApi, token, "list_testcases", { suiteId: clonedChildId });
      expect(clonedChildCases.rows).toHaveLength(1);
      expect(clonedChildCases.rows[0].title).toBe(`${caseInChild.title} (copy)`);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      for (const id of clonedCaseIds) await deleteCase(request, id);
      if (clonedChildId) await deleteSuiteRest(request, clonedChildId);
      if (clonedParentId) await deleteSuiteRest(request, clonedParentId);
      await deleteCase(request, caseInParent.id);
      await deleteCase(request, caseInChild.id);
      await deleteSuiteRest(request, sourceChild.id);
      await deleteSuiteRest(request, sourceParent.id);
      await mcpApi.dispose();
    }
  });

  test("rejects clone_test_suite for a suite belonging to another project, and on a nonexistent id", async ({ request }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bSuiteId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bSuiteRes = await asB.post(`/api/projects/${ctxB.projectId}/suites`, {
        data: { name: `E2E MCP Clone Cross-Project ${Date.now()}` },
      });
      expect(bSuiteRes.ok()).toBeTruthy();
      bSuiteId = (await bSuiteRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP clone validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const crossProjectError = await callMcpToolExpectError(mcpApi, token, "clone_test_suite", { suiteId: bSuiteId });
      expect(crossProjectError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const notFoundError = await callMcpToolExpectError(mcpApi, token, "clone_test_suite", { suiteId: ghostId });
      expect(notFoundError.message).toMatch(/not found/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bSuiteId) await asB.delete(`/api/suites/${bSuiteId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP create_cycle_from_testcases", () => {
  test("creates a cycle with only the valid test cases attached, reporting a foreign-project id separately", async ({
    request,
  }) => {
    const stamp = Date.now();
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    const tcA = await createCase(request, { title: `E2E MCP Cycle From Cases A ${stamp}` });
    const tcB = await createCase(request, { title: `E2E MCP Cycle From Cases B ${stamp}` });
    let tokenId: string | undefined;
    let cycleId: string | undefined;
    let bCaseId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCaseRes = await asB.post(`/api/projects/${ctxB.projectId}/testcases`, {
        data: { title: `E2E MCP Cycle From Cases Foreign ${stamp}` },
      });
      expect(bCaseRes.ok()).toBeTruthy();
      bCaseId = (await bCaseRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP create_cycle_from_testcases token ${stamp}`, scopes: ["write"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const result = await callMcpTool(mcpApi, token, "create_cycle_from_testcases", {
        name: `E2E MCP Cycle From Cases ${stamp}`,
        testcaseIds: [tcA.id, tcB.id, bCaseId],
      });
      cycleId = result.cycle.id;
      expect(result.testcasesRequested).toBe(3);
      expect(result.testcasesAdded).toBe(2);
      expect(result.invalidTestcaseIds).toEqual([bCaseId]);

      const executions = await getCycleExecutionsRest(request, cycleId!);
      expect(executions).toHaveLength(2);
      expect(executions.some((e: { testcaseId: string }) => e.testcaseId === tcA.id)).toBe(true);
      expect(executions.some((e: { testcaseId: string }) => e.testcaseId === tcB.id)).toBe(true);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (cycleId) await deleteCycleRest(request, cycleId);
      await deleteCase(request, tcA.id);
      await deleteCase(request, tcB.id);
      if (bCaseId) await asB.delete(`/api/projects/${ctxB.projectId}/testcases/${bCaseId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });

  test("rejects create_cycle_from_testcases missing name/testcaseIds, and for a read-scoped token", async ({ request }) => {
    const tc = await createCase(request, { title: `E2E MCP Cycle From Cases Scope ${Date.now()}` });
    let writeTokenId: string | undefined;
    let readTokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      // Scope is checked before argument validation, so the "name"/"non-empty array" messages
      // can only be reached with a token that actually has write scope.
      const writeTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP cycle-from-cases validation token ${Date.now()}`, scopes: ["write"] },
      });
      expect(writeTokenRes.ok()).toBeTruthy();
      const writeTokenBody = await writeTokenRes.json();
      writeTokenId = writeTokenBody.id;
      const writeToken = writeTokenBody.token as string;

      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "create_cycle_from_testcases", { testcaseIds: [tc.id] }))
          .message,
      ).toMatch(/"name"/i);
      expect(
        (await callMcpToolExpectError(mcpApi, writeToken, "create_cycle_from_testcases", { name: "Run" })).message,
      ).toMatch(/non-empty array/i);

      const readTokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP cycle-from-cases read-only token ${Date.now()}`, scopes: ["read"] },
      });
      expect(readTokenRes.ok()).toBeTruthy();
      const readTokenBody = await readTokenRes.json();
      readTokenId = readTokenBody.id;
      const readToken = readTokenBody.token as string;

      const scopeError = await callMcpToolExpectError(mcpApi, readToken, "create_cycle_from_testcases", {
        name: "Run",
        testcaseIds: [tc.id],
      });
      expect(scopeError.code).toBe(-32002); // RpcCode.ScopeDenied
    } finally {
      if (writeTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${writeTokenId}`, { failOnStatusCode: false });
      }
      if (readTokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${readTokenId}`, { failOnStatusCode: false });
      }
      await deleteCase(request, tc.id);
      await mcpApi.dispose();
    }
  });
});

test.describe("MCP get_test_execution_summary", () => {
  test("summarizes actual execution data for one cycle from real recorded results", async ({ request }) => {
    const stamp = Date.now();
    const cycle = await createCycleRest(request, { name: `E2E MCP Execution Summary Cycle ${stamp}` });
    const tcA = await createCase(request, { title: `E2E MCP Execution Summary A ${stamp}` });
    const tcB = await createCase(request, { title: `E2E MCP Execution Summary B ${stamp}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      await addCycleTestCaseRest(request, cycle.id, tcA.id);
      await addCycleTestCaseRest(request, cycle.id, tcB.id);
      const executions = await getCycleExecutionsRest(request, cycle.id);
      const execA = executions.find((e: { testcaseId: string }) => e.testcaseId === tcA.id);
      const execB = executions.find((e: { testcaseId: string }) => e.testcaseId === tcB.id);
      await request.patch(`/api/cycles/${cycle.id}/executions/${execA.id}`, { data: { status: "Passed" } });
      await request.patch(`/api/cycles/${cycle.id}/executions/${execB.id}`, { data: { status: "Failed" } });

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP get_test_execution_summary token ${stamp}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const cycleSummary = await callMcpTool(mcpApi, token, "get_test_execution_summary", { cycleId: cycle.id });
      expect(cycleSummary.scope).toBe("cycle");
      expect(cycleSummary.Passed).toBe(1);
      expect(cycleSummary.Failed).toBe(1);
      expect(cycleSummary.total).toBe(2);

      // Project-wide totals can't be asserted exactly (other tests share this project), but the
      // shape must be real and this cycle's contribution must be reflected in cycleCount.
      const projectSummary = await callMcpTool(mcpApi, token, "get_test_execution_summary", {});
      expect(projectSummary.scope).toBe("project");
      expect(typeof projectSummary.total).toBe("number");
      expect(projectSummary.total).toBeGreaterThanOrEqual(2);
      expect(projectSummary.cycleCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await deleteCase(request, tcA.id);
      await deleteCase(request, tcB.id);
      await mcpApi.dispose();
    }
  });

  test("returns all zeros for a freshly created cycle with no executions", async ({ request }) => {
    const cycle = await createCycleRest(request, { name: `E2E MCP Execution Summary Empty ${Date.now()}` });
    let tokenId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP execution summary empty token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const summary = await callMcpTool(mcpApi, token, "get_test_execution_summary", { cycleId: cycle.id });
      expect(summary).toMatchObject({ Passed: 0, Failed: 0, Blocked: 0, Skipped: 0, Untested: 0, Retest: 0, total: 0 });
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      await deleteCycleRest(request, cycle.id);
      await mcpApi.dispose();
    }
  });

  test("rejects get_test_execution_summary for a cycle belonging to another project, and on a nonexistent id", async ({
    request,
  }) => {
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const asB = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: path.join(__dirname, "../.auth/state-b.json"),
    });
    let tokenId: string | undefined;
    let bCycleId: string | undefined;
    const mcpApi = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const bCycleRes = await asB.post(`/api/projects/${ctxB.projectId}/cycles`, {
        data: { name: `E2E MCP Execution Summary Cross-Project ${Date.now()}` },
      });
      expect(bCycleRes.ok()).toBeTruthy();
      bCycleId = (await bCycleRes.json()).id;

      const tokenRes = await request.post(`/api/projects/${ctx.projectId}/apikeys`, {
        data: { name: `E2E MCP execution summary validation token ${Date.now()}`, scopes: ["read"] },
      });
      expect(tokenRes.ok()).toBeTruthy();
      const tokenBody = await tokenRes.json();
      tokenId = tokenBody.id;
      const token = tokenBody.token as string;

      const crossProjectError = await callMcpToolExpectError(mcpApi, token, "get_test_execution_summary", { cycleId: bCycleId });
      expect(crossProjectError.code).toBe(-32001); // RpcCode.ProjectScopeDenied
      const notFoundError = await callMcpToolExpectError(mcpApi, token, "get_test_execution_summary", { cycleId: ghostId });
      expect(notFoundError.message).toMatch(/not found/i);
    } finally {
      if (tokenId) {
        await request.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      }
      if (bCycleId) await asB.delete(`/api/cycles/${bCycleId}`, { failOnStatusCode: false });
      await asB.dispose();
      await mcpApi.dispose();
    }
  });
});
