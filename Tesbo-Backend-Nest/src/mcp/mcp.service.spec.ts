import { McpService } from "./mcp.service";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import type { ApiTokenContext } from "../common/request.types";
import { MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, RpcCode } from "./mcp.types";

/** Minimal LegacyService test double — only the methods the MCP tools call. */
function makeLegacy(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getProject: jest.fn().mockResolvedValue({ id: "proj-1", name: "Demo" }),
    listTestCases: jest.fn().mockResolvedValue({ rows: [{ id: "tc-1" }], total: 1 }),
    createTestCase: jest.fn().mockResolvedValue({ id: "tc-new" }),
    createSuite: jest.fn().mockResolvedValue({ id: "suite-new" }),
    createCycle: jest.fn().mockResolvedValue({ id: "cycle-new" }),
    updateExecution: jest.fn().mockResolvedValue(undefined),
    createBug: jest.fn().mockResolvedValue({ id: "bug-new" }),
    requirementMatrix: jest.fn().mockResolvedValue({ rows: [] }),
    searchKnowledgeBase: jest.fn().mockResolvedValue({ list: [], total: 0 }),
    createKnowledgeDocument: jest.fn().mockResolvedValue({ id: "kb-doc-new" }),
    updateKnowledgeDocument: jest.fn().mockResolvedValue({ id: "kb-doc-1" }),
    moveKnowledgeDocument: jest.fn().mockResolvedValue({ id: "kb-doc-1" }),
    createKnowledgeFolder: jest.fn().mockResolvedValue({ id: "kb-folder-new" }),
    updateKnowledgeFolder: jest.fn().mockResolvedValue({ id: "kb-folder-1" }),
    moveKnowledgeFolder: jest.fn().mockResolvedValue({ id: "kb-folder-1" }),
    ...overrides
  } as unknown as LegacyService;
}

/**
 * DB double. Routes the two queries the engine makes:
 *  - MCP agent actor lookup -> configurable actor id
 *  - execution -> project lookup -> configurable owning project (or none)
 */
function makeDb(opts: { mcpActorId?: string | null; executionProject?: string | null | undefined } = {}) {
  const query = jest.fn((sql: string) => {
    if (sql.includes("FROM actors a JOIN agents g")) {
      return Promise.resolve({ rows: opts.mcpActorId ? [{ id: opts.mcpActorId }] : [] });
    }
    if (sql.includes("FROM executions e")) {
      return Promise.resolve({
        rows: opts.executionProject === undefined ? [] : [{ project_id: opts.executionProject }]
      });
    }
    return Promise.resolve({ rows: [] });
  });
  return { db: { query } as unknown as DatabaseService, query };
}

function principal(over: Partial<ApiTokenContext> = {}): ApiTokenContext {
  return { tokenId: "tok-1", userId: "user-1", projectId: "proj-1", scopes: ["read", "write"], ...over };
}

const rpc = (method: string, params?: Record<string, unknown>, id: number | string = 1) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params
});

describe("McpService", () => {
  describe("protocol handshake & discovery", () => {
    it("initialize advertises protocol version, capabilities and server info", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("initialize"), principal(), "proj-1");
      expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(res.result.serverInfo.name).toBe(MCP_SERVER_NAME);
      expect(res.result.capabilities).toHaveProperty("tools");
      expect(res.id).toBe(1);
    });

    it("ping returns an empty result", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("ping"), principal(), "proj-1");
      expect(res.result).toEqual({});
    });

    it("tools/list returns every registered tool with a name, description and inputSchema", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("tools/list"), principal(), "proj-1");
      const names = res.result.tools.map((t: any) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_projects",
          "list_testcases",
          "create_testcase",
          "create_suite",
          "create_cycle_from_plan",
          "record_execution_result",
          "create_bug",
          "get_requirement_matrix",
          "search_knowledge_base",
          "create_knowledge_document",
          "update_knowledge_document",
          "move_knowledge_document",
          "create_knowledge_folder",
          "update_knowledge_folder",
          "move_knowledge_folder"
        ])
      );
      for (const t of res.result.tools) {
        expect(typeof t.description).toBe("string");
        expect(t.inputSchema).toBeDefined();
      }
    });
  });

  describe("request validation", () => {
    it("rejects a non-2.0 payload with InvalidRequest", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest({ method: "ping" }, principal(), "proj-1");
      expect(res.error.code).toBe(RpcCode.InvalidRequest);
    });

    it("returns MethodNotFound for an unknown method", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("resources/list"), principal(), "proj-1");
      expect(res.error.code).toBe(RpcCode.MethodNotFound);
    });

    it("echoes back the request id on errors", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("nope", {}, 99), principal(), "proj-1");
      expect(res.id).toBe(99);
    });
  });

  describe("project scope enforcement", () => {
    it("denies when the token's project differs from the URL project", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("tools/list"), principal({ projectId: "proj-1" }), "proj-2");
      expect(res.error.code).toBe(RpcCode.ProjectScopeDenied);
    });

    it("denies when the token carries no project scope", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("tools/list"), principal({ projectId: null }), "proj-1");
      expect(res.error.code).toBe(RpcCode.ProjectScopeDenied);
    });
  });

  describe("tool scope enforcement", () => {
    it("blocks a write tool when the token only has read scope", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "create_suite", arguments: { name: "S" } }),
        principal({ scopes: ["read"] }),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ScopeDenied);
      expect((legacy as any).createSuite).not.toHaveBeenCalled();
    });

    it("allows a read tool for a read-only token", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "list_testcases", arguments: {} }),
        principal({ scopes: ["read"] }),
        "proj-1"
      );
      expect(res.result.isError).toBe(false);
    });
  });

  describe("tools/call dispatch & result shape", () => {
    it("returns MethodNotFound for an unknown tool name", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(rpc("tools/call", { name: "delete_everything" }), principal(), "proj-1");
      expect(res.error.code).toBe(RpcCode.MethodNotFound);
    });

    it("wraps a read result as an MCP text content part", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(rpc("tools/call", { name: "list_projects" }), principal(), "proj-1");
      expect((legacy as any).getProject).toHaveBeenCalledWith("proj-1");
      expect(res.result.isError).toBe(false);
      expect(res.result.content[0].type).toBe("text");
      expect(JSON.parse(res.result.content[0].text)).toEqual({ projects: [{ id: "proj-1", name: "Demo" }] });
    });

    it("passes the token's project (not a client-supplied one) into list_testcases", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "list_testcases", arguments: { status: "Active" } }),
        principal(),
        "proj-1"
      );
      expect((legacy as any).listTestCases).toHaveBeenCalledWith("proj-1", { status: "Active" });
    });

    it("passes the token's project and user into search_knowledge_base", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "search_knowledge_base", arguments: { q: "login" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).searchKnowledgeBase).toHaveBeenCalledWith("proj-1", "user-7", { q: "login" });
    });
  });

  describe("Knowledge Base write tools", () => {
    it("attributes create_knowledge_document to the token's user, not the agent actor", async () => {
      // The engine resolves an MCP actor for every write-scope tool regardless of whether the
      // handler uses it (mcp.service.ts callTool) — the assertion that matters here is which id
      // Knowledge Base's created_by/updated_by columns actually receive: the human user, per the
      // module doc comment, since those columns reference users(id) rather than actors(id).
      const { db } = makeDb({ mcpActorId: "mcp-actor-1" });
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "create_knowledge_document", arguments: { title: "Runbook", folderId: "folder-1" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).createKnowledgeDocument).toHaveBeenCalledWith("proj-1", "user-7", {
        title: "Runbook",
        folderId: "folder-1"
      });
    });

    it("rejects create_knowledge_document without folderId", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "create_knowledge_document", arguments: { title: "Runbook" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"folderId"/i);
    });

    it("passes documentId and args through to update_knowledge_document", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "update_knowledge_document", arguments: { documentId: "doc-1", title: "New title" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).updateKnowledgeDocument).toHaveBeenCalledWith("proj-1", "user-7", "doc-1", {
        documentId: "doc-1",
        title: "New title"
      });
    });

    it("rejects update_knowledge_document without documentId", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "update_knowledge_document", arguments: { title: "New title" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"documentId"/i);
    });

    it("surfaces the read-only-mirror rejection from updateKnowledgeDocument as a ToolExecutionError", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy({
        updateKnowledgeDocument: jest.fn().mockRejectedValue({
          getResponse: () => ({ error: "synced from Jira and its body can't be edited" })
        })
      });
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "update_knowledge_document", arguments: { documentId: "doc-1", title: "x" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/synced from Jira/i);
    });

    it("passes documentId and folderId through to move_knowledge_document", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "move_knowledge_document", arguments: { documentId: "doc-1", folderId: "folder-2" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).moveKnowledgeDocument).toHaveBeenCalledWith("proj-1", "user-7", "doc-1", {
        documentId: "doc-1",
        folderId: "folder-2"
      });
    });

    it("rejects move_knowledge_document without folderId", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "move_knowledge_document", arguments: { documentId: "doc-1" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"folderId"/i);
    });

    it("passes the token's user through to create_knowledge_folder", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "create_knowledge_folder", arguments: { name: "Release Notes 2" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).createKnowledgeFolder).toHaveBeenCalledWith("proj-1", "user-7", {
        name: "Release Notes 2"
      });
    });

    it("rejects create_knowledge_folder without name", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "create_knowledge_folder", arguments: {} }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"name"/i);
    });

    it("passes folderId and args through to update_knowledge_folder", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "update_knowledge_folder", arguments: { folderId: "folder-1", name: "Renamed" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).updateKnowledgeFolder).toHaveBeenCalledWith("proj-1", "user-7", "folder-1", {
        folderId: "folder-1",
        name: "Renamed"
      });
    });

    it("rejects update_knowledge_folder without folderId", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "update_knowledge_folder", arguments: { name: "Renamed" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"folderId"/i);
    });

    it("passes folderId and parentFolderId through to move_knowledge_folder", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "move_knowledge_folder", arguments: { folderId: "folder-1", parentFolderId: "folder-2" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).moveKnowledgeFolder).toHaveBeenCalledWith("proj-1", "user-7", "folder-1", {
        folderId: "folder-1",
        parentFolderId: "folder-2"
      });
    });

    it("rejects move_knowledge_folder without parentFolderId", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "move_knowledge_folder", arguments: { folderId: "folder-1" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"parentFolderId"/i);
    });

    it("surfaces a role/ownership rejection (Forbidden) from a KB mutate method as a ToolExecutionError", async () => {
      const { db } = makeDb();
      const legacy = makeLegacy({
        moveKnowledgeFolder: jest.fn().mockRejectedValue({
          getResponse: () => ({ error: "You can only modify items you created" })
        })
      });
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "move_knowledge_folder", arguments: { folderId: "folder-1", parentFolderId: "folder-2" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/only modify items you created/i);
    });
  });

  describe("actor attribution", () => {
    it("attributes create_testcase writes to the resolved MCP agent actor", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1" });
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "create_testcase", arguments: { title: "Login works" } }),
        principal(),
        "proj-1"
      );
      expect((legacy as any).createTestCase).toHaveBeenCalledWith("proj-1", "mcp-actor-1", { title: "Login works" });
    });

    it("does not resolve an actor for read tools", async () => {
      const { db, query } = makeDb({ mcpActorId: "mcp-actor-1" });
      const svc = new McpService(makeLegacy(), db);
      await svc.handleRequest(rpc("tools/call", { name: "get_requirement_matrix" }), principal(), "proj-1");
      const actorLookups = query.mock.calls.filter((c) => String(c[0]).includes("FROM actors a JOIN agents g"));
      expect(actorLookups).toHaveLength(0);
    });

    it("caches the MCP actor lookup across calls", async () => {
      const { db, query } = makeDb({ mcpActorId: "mcp-actor-1" });
      const svc = new McpService(makeLegacy(), db);
      await svc.handleRequest(rpc("tools/call", { name: "create_suite", arguments: { name: "A" } }), principal(), "proj-1");
      await svc.handleRequest(rpc("tools/call", { name: "create_suite", arguments: { name: "B" } }), principal(), "proj-1");
      const actorLookups = query.mock.calls.filter((c) => String(c[0]).includes("FROM actors a JOIN agents g"));
      expect(actorLookups).toHaveLength(1);
    });

    it("reports bugs under the token's user, not the agent actor", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1" });
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      await svc.handleRequest(
        rpc("tools/call", { name: "create_bug", arguments: { title: "Broken" } }),
        principal({ userId: "user-7" }),
        "proj-1"
      );
      expect((legacy as any).createBug).toHaveBeenCalledWith("proj-1", "user-7", { title: "Broken" });
    });
  });

  describe("record_execution_result project scoping", () => {
    it("records a result when the execution belongs to the token's project", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1", executionProject: "proj-1" });
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "record_execution_result", arguments: { executionId: "ex-1", status: "Passed" } }),
        principal(),
        "proj-1"
      );
      expect(res.result.isError).toBe(false);
      // Attributed to the token's user (ctx.userId), NOT the mcp-actor-1 agent actor resolved by
      // makeDb's mcpActorId — updateExecution stores this as executions.executed_by, which
      // references users(id), and the agent actor has no organization_members row to satisfy
      // requireProjectAccess. See mcp.tools.ts's record_execution_result handler comment.
      expect((legacy as any).updateExecution).toHaveBeenCalledWith("ex-1", "user-1", {
        executionId: "ex-1",
        status: "Passed"
      });
    });

    it("denies recording a result for an execution in another project", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1", executionProject: "proj-OTHER" });
      const legacy = makeLegacy();
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "record_execution_result", arguments: { executionId: "ex-1", status: "Passed" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ProjectScopeDenied);
      expect((legacy as any).updateExecution).not.toHaveBeenCalled();
    });

    it("returns a tool error when the execution does not exist", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1", executionProject: undefined });
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "record_execution_result", arguments: { executionId: "ghost", status: "Passed" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/not found/i);
    });
  });

  describe("argument validation & error mapping", () => {
    it("rejects create_testcase without a title", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1" });
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "create_testcase", arguments: {} }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/title/i);
    });

    it("rejects search_knowledge_base without q", async () => {
      const { db } = makeDb();
      const svc = new McpService(makeLegacy(), db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "search_knowledge_base", arguments: {} }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toMatch(/"q"/i);
    });

    it("maps an underlying service exception onto a ToolExecutionError", async () => {
      const { db } = makeDb({ mcpActorId: "mcp-actor-1" });
      const legacy = makeLegacy({
        createSuite: jest.fn().mockRejectedValue({
          getResponse: () => ({ error: "name is required" })
        })
      });
      const svc = new McpService(legacy, db);
      const res: any = await svc.handleRequest(
        rpc("tools/call", { name: "create_suite", arguments: { name: "x" } }),
        principal(),
        "proj-1"
      );
      expect(res.error.code).toBe(RpcCode.ToolExecutionError);
      expect(res.error.message).toBe("name is required");
    });
  });
});
