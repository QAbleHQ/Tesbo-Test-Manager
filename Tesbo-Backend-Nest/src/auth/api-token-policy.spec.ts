import { denyApiTokenRequest } from "./api-token-policy";
import type { ApiTokenContext } from "../common/request.types";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const token = (over: Partial<ApiTokenContext> = {}): ApiTokenContext => ({
  tokenId: "tok-1",
  userId: "user-1",
  projectId: PROJECT,
  scopes: ["read", "write"],
  ...over
});

describe("denyApiTokenRequest: what a token may reach", () => {
  describe("allowed", () => {
    it.each([
      ["POST", "/api/mcp"],
      ["POST", "/api/mcp/"],
      ["POST", `/api/projects/${PROJECT}/mcp`],
      ["POST", `/api/projects/${PROJECT}/automation/runs`],
      ["GET", `/api/projects/${PROJECT}/automation/runs/abc`],
      ["GET", `/api/projects/${PROJECT}/testcases`],
      ["GET", `/api/projects/${PROJECT}/testcases?limit=500&offset=0`],
      ["POST", `/api/projects/${PROJECT}/testcases/bulk-create`],
      ["PATCH", `/api/projects/${PROJECT}/testcases/abc`],
      ["DELETE", `/api/projects/${PROJECT}/suites/abc`],
      ["GET", `/api/projects/${PROJECT}/cycles`],
      ["HEAD", `/api/projects/${PROJECT}/testcases`],
      ["get", `/api/projects/${PROJECT}/testcases`]
    ])("%s %s", (method, path) => {
      expect(denyApiTokenRequest(method, path, token())).toBeNull();
    });

    it("compares the project id case-insensitively", () => {
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT.toUpperCase()}/testcases`, token())).toBeNull();
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT}/testcases`, token({ projectId: PROJECT.toUpperCase() }))).toBeNull();
    });
  });

  describe("another project", () => {
    it.each(["mcp", "automation/runs", "testcases", "suites", "cycles"])("refuses %s on a different project", (rest) => {
      expect(denyApiTokenRequest("GET", `/api/projects/${OTHER}/${rest}`, token())).toMatch(/not scoped to this project/);
    });
  });

  describe("routes a token must never reach", () => {
    it.each([
      ["POST", `/api/projects/${PROJECT}/apikeys`, "a token minting tokens"],
      ["GET", `/api/projects/${PROJECT}/apikeys`, "listing tokens"],
      ["DELETE", `/api/projects/${PROJECT}/apikeys/abc`, "revoking tokens"],
      ["POST", `/api/projects/${PROJECT}/members`, "adding members"],
      ["DELETE", `/api/projects/${PROJECT}/members/abc`, "removing members"],
      ["GET", `/api/projects/${PROJECT}/ai/keys`, "AI keys"],
      ["GET", `/api/projects/${PROJECT}/jira/status`, "integration secrets"],
      ["GET", `/api/projects/${PROJECT}/knowledge-base/files/abc/download`, "knowledge base"],
      ["GET", `/api/projects/${PROJECT}/agents/zyra`, "agents"],
      ["DELETE", `/api/projects/${PROJECT}`, "deleting the project itself"],
      ["GET", `/api/projects/${PROJECT}`, "the bare project"],
      ["GET", "/api/projects", "listing every project"],
      ["POST", "/api/projects", "creating a project"],
      ["GET", "/api/workspace", "the workspace"],
      ["POST", "/api/workspace/members", "workspace members"],
      ["POST", "/api/workspace/ai-keys", "workspace AI keys"],
      ["GET", "/api/plans/current", "billing plans"],
      ["POST", "/api/auth/password/change", "changing the password"],
      ["GET", "/api/auth/me", "identity"],
      ["POST", "/api/admin/anything", "platform admin"],
      ["GET", "/api/cycles/abc/executions", "resource-keyed cycles (project not in the path)"],
      ["GET", "/api/bugs/abc", "resource-keyed bugs"],
      ["GET", "/api/suites/abc", "resource-keyed suites"],
      ["POST", "/api/setup/first-admin", "platform setup"]
    ])("%s %s (%s)", (method, path) => {
      expect(denyApiTokenRequest(method, path, token())).toBeTruthy();
    });
  });

  describe("path tricks fail closed", () => {
    it.each([
      ["upper-case prefix", `/API/projects/${PROJECT}/testcases`],
      ["upper-case segment", `/api/projects/${PROJECT}/TestCases`],
      ["double slash", `//api/projects/${PROJECT}/testcases`],
      ["double slash inside", `/api/projects//${PROJECT}/testcases`],
      ["path parameter", `/api/projects/${PROJECT}/testcases;x=1/../../../workspace`],
      ["segment suffix", `/api/projects/${PROJECT}/testcases-admin`],
      ["segment prefix", `/api/projects/${PROJECT}/xtestcases`],
      ["encoded slash", `/api/projects/${PROJECT}%2Fapikeys`],
      ["encoded segment", `/api/projects/${PROJECT}/test%63ases`],
      ["project id with a suffix", `/api/projects/${PROJECT}x/testcases`],
      ["short project id", "/api/projects/1234/testcases"],
      ["empty path", ""],
      ["mcp alias with suffix", "/api/mcp/extra"],
      ["mcp lookalike", "/api/mcpx"]
    ])("refuses %s", (_label, path) => {
      expect(denyApiTokenRequest("GET", path, token())).toBeTruthy();
    });

    it("does not let a query string smuggle an allowed path onto a denied route", () => {
      expect(denyApiTokenRequest("GET", `/api/workspace?x=/api/projects/${PROJECT}/testcases`, token())).toBeTruthy();
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT}/apikeys?next=/testcases`, token())).toBeTruthy();
    });
  });

  describe("scope by method on the REST routes", () => {
    it("a read-only token may read and may not write", () => {
      const readOnly = token({ scopes: ["read"] });
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT}/testcases`, readOnly)).toBeNull();
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(denyApiTokenRequest(method, `/api/projects/${PROJECT}/testcases`, readOnly)).toMatch(/requires the "write" scope/);
      }
    });

    it("a write-only token may write and may not read (scopes are not cumulative)", () => {
      const writeOnly = token({ scopes: ["write"] });
      expect(denyApiTokenRequest("POST", `/api/projects/${PROJECT}/testcases`, writeOnly)).toBeNull();
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT}/testcases`, writeOnly)).toMatch(/requires the "read" scope/);
    });

    it("a token with no scopes can do nothing on the REST routes", () => {
      const none = token({ scopes: [] });
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT}/testcases`, none)).toBeTruthy();
      expect(denyApiTokenRequest("POST", `/api/projects/${PROJECT}/testcases`, none)).toBeTruthy();
    });

    it("leaves mcp and automation to their own scope checks, so a read token can still POST tools/list", () => {
      const readOnly = token({ scopes: ["read"] });
      expect(denyApiTokenRequest("POST", `/api/projects/${PROJECT}/mcp`, readOnly)).toBeNull();
      expect(denyApiTokenRequest("POST", `/api/projects/${PROJECT}/automation/cases/resolve`, readOnly)).toBeNull();
    });
  });

  describe("tokens with no project", () => {
    it.each([null, ""])("refuses a token whose project is %p, even on the MCP alias", (projectId) => {
      expect(denyApiTokenRequest("POST", "/api/mcp", token({ projectId: projectId as unknown as string | null }))).toMatch(/not scoped to a project/);
      expect(denyApiTokenRequest("GET", `/api/projects/${PROJECT}/testcases`, token({ projectId: projectId as unknown as string | null }))).toBeTruthy();
    });
  });
});
