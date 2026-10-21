import type { ApiTokenContext } from "../common/request.types";

/*
 * What an API bearer token may reach. Default-deny.
 *
 * A token used to be the whole of its user: AuthMiddleware set `req.userId` and every route then
 * trusted it, so a token minted for project A could read the owner's other projects, change their
 * workspace, mint more tokens, or reach billing. Only the MCP and automation controllers checked
 * the token's project and scope. A leaked CI token was therefore a leaked account.
 *
 * This runs in the middleware, before any controller, so a route added next month is denied to
 * tokens until someone adds its segment here on purpose.
 *
 * Two kinds of route are allowed, both only under the token's own project:
 *   - SELF_SCOPED: `mcp` and `automation` enforce the token's scope themselves (a POST there can be
 *     a read, e.g. tools/list or cases/resolve), so only the project is checked here.
 *   - REST_SEGMENTS: plain data routes. The scope comes from the method: GET/HEAD need `read`,
 *     everything else needs `write`. These are the routes the repo's own tooling drives with a
 *     token (e2e/scripts/push-to-tesbo.ts).
 * `/api/mcp` is the project-agnostic MCP alias; the token supplies the project.
 *
 * Everything else is refused: other projects, `apikeys` (a token minting tokens), `members`,
 * `ai`, the integrations that hold third-party secrets, `/api/workspace`, billing, admin, auth,
 * and the routes keyed by a bare cycle/bug/suite id, whose project cannot be read off the path.
 * Matching is on the literal path and case-sensitive on purpose: anything that only matches
 * after Express's looser routing (different case, `//`, `;params`) falls through to a refusal.
 */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const MCP_ALIAS = /^\/api\/mcp\/?$/;
const PROJECT_ROUTE = new RegExp(`^/api/projects/(${UUID})/([a-z-]+)(?:/.*)?$`);

const SELF_SCOPED = new Set(["mcp", "automation"]);
const REST_SEGMENTS = new Set(["testcases", "suites", "cycles"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** The reason a token request is refused, or null when it may proceed. */
export function denyApiTokenRequest(method: string, rawPath: string, token: ApiTokenContext): string | null {
  // A token with no project is a personal one. Nothing here lets it act.
  if (!token.projectId) return "This API token is not scoped to a project";

  const path = rawPath.split("?")[0];
  if (MCP_ALIAS.test(path)) return null;

  const match = PROJECT_ROUTE.exec(path);
  if (!match) return "API tokens can only call the MCP and automation endpoints and the test case, suite and cycle routes of their own project";

  const [, projectId, segment] = match;
  if (projectId.toLowerCase() !== token.projectId.toLowerCase()) return "This API token is not scoped to this project";
  if (SELF_SCOPED.has(segment)) return null;
  if (!REST_SEGMENTS.has(segment)) {
    return "API tokens can only call the MCP and automation endpoints and the test case, suite and cycle routes of their own project";
  }

  const required = SAFE_METHODS.has(method.toUpperCase()) ? "read" : "write";
  if (!token.scopes.includes(required)) {
    return `This call requires the "${required}" scope; the token has [${token.scopes.join(", ") || "none"}]`;
  }
  return null;
}
