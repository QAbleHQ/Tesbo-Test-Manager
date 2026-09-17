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
