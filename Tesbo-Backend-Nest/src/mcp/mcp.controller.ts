import { Body, Controller, Param, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { AuthenticatedRequest } from "../common/request.types";
import { McpService } from "./mcp.service";

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
 */
@Controller()
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post("/api/projects/:projectId/mcp")
  async handle(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: unknown
  ) {
    const principal = this.requirePrincipal(req);
    return this.mcp.handleRequest(body, principal, projectId);
  }

  @Post("/api/mcp")
  async handleForToken(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const principal = this.requirePrincipal(req);
    // No URL project to read, so hand the token's own project straight back to McpService's
    // scope check — it always matches, which is the point: the token is the only source of truth.
    return this.mcp.handleRequest(body, principal, principal.projectId ?? "");
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
