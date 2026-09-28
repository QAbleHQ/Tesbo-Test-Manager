import { createHash, randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import type { ApiTokenContext } from "../common/request.types";
import { buildMcpTools } from "./mcp.tools";
import {
  MCP_AGENT_SLUG,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpError,
  RpcCode,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTool,
  type McpToolContext,
  type TokenScope
} from "./mcp.types";

/**
 * Tesbo MCP — protocol engine.
 *
 * Handles a single JSON-RPC 2.0 request against the MCP surface (initialize / tools/list /
 * tools/call / ping) for a project-scoped API token. Two guarantees enforced here, before any
 * tool handler runs, close the gaps left open by the auth foundation (88a2505):
 *   1. Project scope — the token's project must match the project on the request URL.
 *   2. Tool scope    — a write tool requires the token to carry the "write" scope.
 *
 * Writes are attributed to a dedicated "tesbo-mcp" agent actor (seeded in V65) so machine
 * activity is distinguishable from human and Zyra activity in audit history.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly tools: McpTool[] = buildMcpTools();
  private readonly toolsByName = new Map(this.tools.map((t) => [t.name, t]));
  /*
   * A fingerprint of everything a client caches from this server: the tools/list payload and the
   * session instructions. MCP clients fetch tools/list once per session and keep it, and a
   * blue/green deploy swaps the process behind the same URL without breaking anything, so a client
   * connected before a deploy kept calling with the old schemas indefinitely (the "severity still
   * free text on stage" report). Session ids embed this value — see isCurrentSession.
   *
   * A content hash rather than GIT_SHA: it changes exactly when the schemas do (a deploy that
   * leaves MCP untouched does not force every client to reconnect), and it works where GIT_SHA is
   * "local" — local dev, e2e, and prod, whose deploy does not pass GIT_SHA through today.
   */
  private readonly toolsFingerprint = createHash("sha256")
    .update(JSON.stringify({ tools: this.listToolsPayload(), instructions: MCP_SERVER_INSTRUCTIONS }))
    .digest("hex")
    .slice(0, 16);
  /** SemVer build metadata: which deploy (GIT_SHA) and which tool set (fingerprint) this is. */
  readonly serverVersion = `${MCP_SERVER_VERSION}+${process.env.GIT_SHA || "local"}.${this.toolsFingerprint}`;

  // Resolved once and reused — the MCP agent's actor id never changes at runtime.
  private mcpActorIdPromise: Promise<string | null> | null = null;

  constructor(
    private readonly legacy: LegacyService,
    private readonly db: DatabaseService
  ) {}

  /** Actor id for the well-known "tesbo-mcp" agent (V65), used to attribute token-authed writes. */
  async resolveMcpActorId(): Promise<string | null> {
    if (!this.mcpActorIdPromise) {
      this.mcpActorIdPromise = this.db
        .query<{ id: string }>("SELECT a.id FROM actors a JOIN agents g ON g.id = a.id WHERE g.slug = $1", [
          MCP_AGENT_SLUG
        ])
        .then((res) => res.rows[0]?.id || null)
        .catch((err) => {
          this.logger.warn(`Failed to resolve MCP agent actor: ${err instanceof Error ? err.message : err}`);
          return null;
        });
    }
    return this.mcpActorIdPromise;
  }

  listTools(): McpTool[] {
    return this.tools;
  }

  /** A fresh session id bound to the current tool set. */
  newSessionId(): string {
    return `${this.toolsFingerprint}.${randomUUID()}`;
  }

  /** False for an id issued against a different tool set (or not issued by this server at all). */
  isCurrentSession(sessionId: string): boolean {
    return sessionId.startsWith(`${this.toolsFingerprint}.`);
  }

  /** A JSON-RPC notification: no id, so no response is expected (Streamable HTTP answers 202). */
  static isNotification(body: unknown): boolean {
    const req = body as Partial<JsonRpcRequest> | null;
    return !!req && typeof req === "object" && req.jsonrpc === "2.0" && typeof req.method === "string" && req.method.startsWith("notifications/") && req.id === undefined;
  }

  private listToolsPayload() {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  }

  /**
   * Handle one JSON-RPC request for an authenticated, project-scoped token.
   * `urlProjectId` is the project the transport (controller) routed the call to.
   * Always resolves to a JSON-RPC response object (errors are encoded, not thrown).
   */
  async handleRequest(
    body: unknown,
    principal: ApiTokenContext,
    urlProjectId: string
  ): Promise<JsonRpcResponse> {
    const req = body as Partial<JsonRpcRequest> | null;
    const id: JsonRpcId = req && (typeof req.id === "string" || typeof req.id === "number") ? req.id : null;

    try {
      if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        throw new McpError(RpcCode.InvalidRequest, "Invalid JSON-RPC 2.0 request");
      }

      // Project scope: the token may only ever act inside its own project.
      if (!principal.projectId) {
        throw new McpError(RpcCode.ProjectScopeDenied, "API token is not scoped to a project");
      }
      if (principal.projectId !== urlProjectId) {
        throw new McpError(RpcCode.ProjectScopeDenied, "API token is not scoped to this project");
      }

      const params = (req.params ?? {}) as Record<string, unknown>;
      const result = await this.dispatch(req.method, params, principal);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return this.toErrorResponse(id, err);
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    principal: ApiTokenContext
  ): Promise<unknown> {
    switch (method) {
      case "initialize": {
        // Echo the client's version when supported; otherwise answer with the long-standing default
        // (the spec lets the client decide whether it can proceed with that).
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSION;
        return {
          protocolVersion,
          // Still false: this transport has no server-to-client stream to send
          // notifications/tools/list_changed on. Tool-set changes reach clients through session
          // expiry instead (see isCurrentSession / McpController).
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: this.serverVersion },
          instructions: MCP_SERVER_INSTRUCTIONS
        };
      }

      case "ping":
        return {};

      case "tools/list":
        return { tools: this.listToolsPayload() };

      case "tools/call":
        return this.callTool(params, principal);

      default:
        throw new McpError(RpcCode.MethodNotFound, `Unknown method: ${method}`);
    }
  }

  private async callTool(params: Record<string, unknown>, principal: ApiTokenContext): Promise<unknown> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = this.toolsByName.get(name);
    if (!tool) {
      throw new McpError(RpcCode.MethodNotFound, `Unknown tool: ${name || "(missing name)"}`);
    }

    const scopes = (principal.scopes || []) as TokenScope[];
    if (!scopes.includes(tool.requiredScope)) {
      throw new McpError(
        RpcCode.ScopeDenied,
        `Tool "${name}" requires "${tool.requiredScope}" scope; token has [${scopes.join(", ") || "none"}]`
      );
    }

    const rawArgs = params.arguments;
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    // Only resolve/attach the agent actor for writes — reads never touch actor columns.
    const actorId = tool.requiredScope === "write" ? await this.resolveMcpActorId() : null;

    const ctx: McpToolContext = {
      projectId: principal.projectId as string,
      actorId,
      userId: principal.userId ?? null,
      scopes,
      legacy: this.legacy,
      db: this.db
    };

    try {
      const data = await tool.handler(args, ctx);
      // MCP tools/call result shape: content parts + isError flag.
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        isError: false
      };
    } catch (err) {
      if (err instanceof McpError) throw err;
      // Surface underlying service errors (BadRequest/NotFound/etc.) as a tool execution error.
      const message = this.extractMessage(err);
      throw new McpError(RpcCode.ToolExecutionError, message);
    }
  }

  private extractMessage(err: unknown): string {
    const anyErr = err as { getResponse?: () => unknown; message?: string };
    if (anyErr && typeof anyErr.getResponse === "function") {
      const resp = anyErr.getResponse();
      if (resp && typeof resp === "object") {
        const obj = resp as Record<string, unknown>;
        return String(obj.error || obj.message || anyErr.message || "Tool execution failed");
      }
      if (typeof resp === "string") return resp;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private toErrorResponse(id: JsonRpcId, err: unknown): JsonRpcResponse {
    if (err instanceof McpError) {
      return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } };
    }
    this.logger.error(`Unexpected MCP error: ${err instanceof Error ? err.stack : err}`);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: RpcCode.InternalError, message: "Internal error" }
    };
  }
}
