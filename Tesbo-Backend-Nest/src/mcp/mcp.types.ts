import type { DatabaseService } from "../database/database.service";
import type { LegacyService } from "../legacy/legacy.service";

/**
 * Tesbo MCP — protocol types.
 *
 * The "Tesbo MCP" card ships an MCP (Model Context Protocol) server as an in-process
 * module inside Tesbo-Backend-Nest, exposed over an HTTP transport (see mcp.controller.ts).
 * MCP is JSON-RPC 2.0; this file defines the small slice of the wire format we implement
 * (initialize / tools/list / tools/call / ping) plus the internal tool-registry shape.
 *
 * Design note: this is a dependency-free implementation of the JSON-RPC/MCP surface rather
 * than a wrapper around @modelcontextprotocol/sdk. The protocol layer is tiny and keeping it
 * in-tree makes the whole thing unit-testable without a running app or DB — which matters
 * because the Playwright e2e suite cannot boot in the build sandbox.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "tesbo-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * Returned in `initialize`'s result as the MCP spec's optional top-level `instructions` field —
 * a hint to the calling model, read once per session, that orients it to the whole server rather
 * than one tool at a time. Individual tool descriptions (mcp.tools.ts) already cover their own
 * required/optional fields and edge cases in detail; this fills the gap above that: the shape of
 * the domain, and the handful of behavioral rules that span multiple tools and would otherwise
 * only be discoverable by trial and error.
 */
export const MCP_SERVER_INSTRUCTIONS = `Tesbo is a test management system. This server exposes one project's test cases, suites (folders), test cycles (test runs), executions (a test case's result within a run), bugs, and a separate Knowledge Base (folders + documents) — always scoped to the project this token was issued for.

Typical shapes:
- Test cases live in suites (list_suites, list_testcases with suiteId).
- A cycle is a test run: create_cycle_from_testcases seeds it with test cases, each becoming one execution; record results with record_execution_result / bulk_record_execution_results.
- A bug can link to a test case, a cycle, and/or a specific execution (create_bug/update_bug's links, link_testcase_to_bug/unlink_testcase_from_bug) — linking a failed execution to a bug sets that execution to Failed.
- The Knowledge Base is a separate document/folder tree, not part of the test-case hierarchy — start with search_knowledge_base or list_knowledge_folders.

Rules worth knowing before calling a write tool:
- To archive/restore a test case, use archive_testcase/restore_testcase rather than setting status directly — restoring always resets status to "Draft" (the prior status isn't retained).
- update_testcase and update_suite only change the fields you pass; every other field keeps its current value.
- bulk_update_testcases only accepts priority, suiteId, status, ownerId, automationStatus — not the full field set update_testcase supports.
- Every id-addressed tool is already scoped to this token's project; passing an id from another project fails with a clear "not found" / "belongs to a different project" error rather than acting on it.

Example workflow: "file a bug for the test case that just failed" → get_testcase_executions or list_executions to find the failing execution, then create_bug with links: [{testcaseId, cycleId, executionId}].`;

/** The well-known agent slug MCP-driven writes are attributed to (seeded in V65). */
export const MCP_AGENT_SLUG = "tesbo-mcp";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** JSON-RPC / MCP error codes. Negatives follow the JSON-RPC spec; we add app codes >= -32000. */
export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Authenticated token is not scoped to the project it is trying to act on. */
  ProjectScopeDenied: -32001,
  /** Authenticated token lacks the scope (read/write) a tool requires. */
  ScopeDenied: -32002,
  /** Tool executed but the underlying operation failed (bad args, not found, etc.). */
  ToolExecutionError: -32003
} as const;

/** A protocol-aware error the engine maps straight onto a JSON-RPC error response. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "McpError";
  }
}

export type TokenScope = "read" | "write";

/**
 * Everything a tool handler needs. `projectId` is always the token's own project (scope is
 * enforced before a handler runs), `actorId` is the dedicated MCP agent actor used for
 * actor-column attribution, and `userId` is the token's creating human (used where a column
 * references users(id) rather than actors(id), e.g. bugs.reported_by).
 */
export interface McpToolContext {
  projectId: string;
  actorId: string | null;
  userId: string | null;
  scopes: TokenScope[];
  legacy: LegacyService;
  db: DatabaseService;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema advertised to clients via tools/list. */
  inputSchema: Record<string, unknown>;
  /** Minimum token scope required to call this tool. */
  requiredScope: TokenScope;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
}
