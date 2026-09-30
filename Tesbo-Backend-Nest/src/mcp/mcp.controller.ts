import { Body, Controller, Delete, Get, Param, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../common/request.types";
import { McpService } from "./mcp.service";
import { MCP_SESSION_HEADER, RpcCode, type JsonRpcId } from "./mcp.types";

/**
 * Tesbo MCP — HTTP transport.
 *
 * A single JSON-RPC 2.0 endpoint per project, plus a project-agnostic alias. Authentication is
 * the API bearer token resolved by AuthMiddleware (req.apiToken); browser-session callers are
 * rejected because MCP is a machine-client surface. The project is always the token's own
 * project (ApiTokenContext.projectId) — McpService never trusts a client-supplied value for it.
 *
 * Project-scoped form (kept for existing clients that pin a project in the URL):
 *   POST /api/projects/<projectId>/mcp
 *   Authorization: Bearer tsbo_...
 *   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
 * Here the URL's projectId is cross-checked against the token's own project inside McpService
 * (still required to match), so a token can never drive another project's data.
 *
 * Dynamic form (one shared URL for every user/project — nothing to edit per token):
 *   POST /api/mcp
 *   Authorization: Bearer tsbo_...
 * The project is read straight off the token, so this is exactly the project-scoped form with
 * the URL's projectId always equal to the token's own — same guarantee, no URL to keep in sync.
 *
 * Streamable HTTP, the parts that keep a client's tool list current after a deploy:
 *   - `initialize` answers with an Mcp-Session-Id bound to the current tool set.
 *   - A later request carrying an id from a different tool set gets HTTP 404, which the MCP spec
 *     requires a client to answer by re-initializing — so the first call after a deploy that
 *     changed a schema re-fetches tools/list, with no restart and no client-side change.
 *   - A request with no session id is served exactly as before, so a client that never adopted
 *     sessions keeps working (it just keeps its cached tool list until it reconnects).
 *   - Notifications get 202 with no body; GET/DELETE get 405 (no server stream, no explicit
 *     session termination — both allowed by the spec).
 * The response is written here rather than returned because Nest would otherwise overwrite the
 * 202/404 with the route's default 201, which ordinary replies keep.
 */
@Controller()
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post("/api/projects/:projectId/mcp")
  async handle(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Body() body: unknown
  ) {
    const principal = this.requirePrincipal(req);
    await this.respond(req, res, body, () => this.mcp.handleRequest(body, principal, projectId));
  }

  @Post("/api/mcp")
  async handleForToken(@Req() req: AuthenticatedRequest, @Res() res: Response, @Body() body: unknown) {
    const principal = this.requirePrincipal(req);
    // No URL project to read, so hand the token's own project straight back to McpService's
    // scope check — it always matches, which is the point: the token is the only source of truth.
    await this.respond(req, res, body, () => this.mcp.handleRequest(body, principal, principal.projectId ?? ""));
  }

  // Two handlers, not two decorators on one: Nest keeps a single route-method per handler.
  @Get(["/api/mcp", "/api/projects/:projectId/mcp"])
  getNotAllowed(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    this.methodNotAllowed(req, res);
  }

  @Delete(["/api/mcp", "/api/projects/:projectId/mcp"])
  deleteNotAllowed(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    this.methodNotAllowed(req, res);
  }

  private methodNotAllowed(req: AuthenticatedRequest, res: Response) {
    this.requirePrincipal(req);
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "The Tesbo MCP endpoint accepts POST only (no server-sent event stream, no session termination)." });
  }

  private async respond(
    req: AuthenticatedRequest,
    res: Response,
    body: unknown,
    handle: () => ReturnType<McpService["handleRequest"]>
  ) {
    const rpc = (body && typeof body === "object" ? body : {}) as { id?: unknown; method?: unknown };
    const id: JsonRpcId = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null;
    const isInitialize = rpc.method === "initialize";
    const sessionId = req.header(MCP_SESSION_HEADER);

    // initialize is exempt: it is how a client recovers from exactly this 404.
    if (sessionId && !isInitialize && !this.mcp.isCurrentSession(sessionId)) {
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: RpcCode.SessionExpired, message: "Session expired: the Tesbo MCP tool set changed. Re-initialize to load the current tools." }
      });
      return;
    }
    if (McpService.isNotification(body)) {
      res.status(202).end();
      return;
    }
    const result = await handle();
    if (isInitialize && "result" in result) {
      res.setHeader(MCP_SESSION_HEADER, this.mcp.newSessionId());
    }
    res.status(201).json(result);
  }

  private requirePrincipal(req: AuthenticatedRequest) {
    const principal = req.apiToken;
    if (!principal) {
      // Machine surface: must present a valid API bearer token (not a browser session).
      throw new UnauthorizedException({ error: "MCP requires a valid API token (Authorization: Bearer <token>)" });
    }
    return principal;
  }
}
