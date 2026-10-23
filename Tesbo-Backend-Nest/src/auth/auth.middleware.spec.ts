import { ForbiddenException } from "@nestjs/common";
import { AuthMiddleware } from "./auth.middleware";
import type { ApiTokenService } from "./api-token.service";
import type { OtpService } from "./otp.service";
import type { AppConfigService } from "../config/app-config.service";
import { RateLimitedException, type RateLimitService } from "../rate-limit/rate-limit.service";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const principal = { tokenId: "tok-1", userId: "user-1", projectId: PROJECT, scopes: ["read", "write"] };

function makeMiddleware(opts: { session?: string | null; principal?: typeof principal | null; blocked?: boolean } = {}) {
  const apiTokens = { authenticate: jest.fn().mockResolvedValue(opts.principal === undefined ? principal : opts.principal) };
  const otp = { resolveSession: jest.fn().mockResolvedValue(opts.session ?? null) };
  const rateLimit = {
    assertAllowed: jest.fn(async () => {
      if (opts.blocked) throw new RateLimitedException(120);
    }),
    recordFailure: jest.fn().mockResolvedValue(undefined)
  };
  const mw = new AuthMiddleware(
    { sessionCookieName: "tesbo_session" } as AppConfigService,
    otp as unknown as OtpService,
    apiTokens as unknown as ApiTokenService,
    rateLimit as unknown as RateLimitService
  );
  return { mw, apiTokens, rateLimit };
}

function request(path: string, over: Record<string, unknown> = {}) {
  return { method: "GET", originalUrl: path, headers: { authorization: "Bearer tsbo_abc" }, cookies: {}, ...over } as never;
}

describe("AuthMiddleware: bearer tokens", () => {
  it("lets a token through on a route of its own project and attaches it", async () => {
    const { mw } = makeMiddleware();
    const req: any = request(`/api/projects/${PROJECT}/testcases`);
    const next = jest.fn();
    await mw.use(req, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe("user-1");
    expect(req.apiToken).toEqual(principal);
  });

  it.each([
    "/api/workspace",
    "/api/auth/me",
    `/api/projects/${PROJECT}/apikeys`,
    "/api/projects/22222222-2222-4222-8222-222222222222/testcases",
    "/api/cycles/abc/executions"
  ])("answers 403 for %s and never calls next, so no controller runs", async (path) => {
    const { mw } = makeMiddleware();
    const req: any = request(path);
    const next = jest.fn();
    await expect(mw.use(req, {} as never, next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
    // And the request is not left half-authenticated for anything that runs afterwards.
    expect(req.userId).toBeNull();
    expect(req.apiToken).toBeNull();
  });

  it("falls back to the original URL, not a mount-stripped path", async () => {
    const { mw } = makeMiddleware();
    const req: any = request("/", { originalUrl: "/api/workspace" });
    await expect(mw.use(req, {} as never, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("ignores an unknown or expired token exactly as before: unauthenticated, no 403", async () => {
    const { mw } = makeMiddleware({ principal: null });
    const req: any = request("/api/workspace");
    const next = jest.fn();
    await mw.use(req, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBeNull();
    expect(req.apiToken).toBeNull();
  });

  it("does not consult the token at all when a valid browser session is present", async () => {
    const { mw, apiTokens } = makeMiddleware({ session: "user-from-cookie" });
    const req: any = request("/api/workspace", { cookies: { tesbo_session: "cookie" } });
    const next = jest.fn();
    await mw.use(req, {} as never, next);
    expect(apiTokens.authenticate).not.toHaveBeenCalled();
    expect(req.userId).toBe("user-from-cookie");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("accepts the Bearer scheme in any case and ignores other schemes", async () => {
    const { mw, apiTokens } = makeMiddleware();
    await mw.use(request(`/api/projects/${PROJECT}/testcases`, { headers: { authorization: "bearer tsbo_abc" } }), {} as never, jest.fn());
    expect(apiTokens.authenticate).toHaveBeenCalledWith("tsbo_abc");
    apiTokens.authenticate.mockClear();
    await mw.use(request("/api/workspace", { headers: { authorization: "Basic abc" } }), {} as never, jest.fn());
    expect(apiTokens.authenticate).not.toHaveBeenCalled();
  });

  describe("brute-force limit on tokens that do not exist", () => {
    it("counts a bearer token that does not authenticate", async () => {
      const { mw, rateLimit } = makeMiddleware({ principal: null });
      const req: any = request("/api/workspace", { ip: "203.0.113.9" });
      await mw.use(req, {} as never, jest.fn());
      expect(rateLimit.recordFailure).toHaveBeenCalledTimes(1);
      expect((rateLimit.recordFailure.mock.calls[0] as unknown[])[1]).toBe("203.0.113.9");
    });

    it("answers 429 once an address has used up its allowance, and never reaches a controller", async () => {
      const { mw } = makeMiddleware({ principal: null, blocked: true });
      const next = jest.fn();
      await expect(mw.use(request("/api/workspace"), {} as never, next)).rejects.toBeInstanceOf(RateLimitedException);
      expect(next).not.toHaveBeenCalled();
    });

    it("never consults the limit for a valid token, so a penalised address cannot lock out a working token", async () => {
      const { mw, rateLimit } = makeMiddleware({ blocked: true });
      const next = jest.fn();
      await mw.use(request(`/api/projects/${PROJECT}/testcases`), {} as never, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(rateLimit.assertAllowed).not.toHaveBeenCalled();
      expect(rateLimit.recordFailure).not.toHaveBeenCalled();
    });

    it("never consults the limit for a session or for a request with no token", async () => {
      const { mw, rateLimit } = makeMiddleware({ session: "u", blocked: true });
      await mw.use(request("/api/workspace", { cookies: { tesbo_session: "c" } }), {} as never, jest.fn());
      await mw.use(request("/api/workspace", { headers: {} }), {} as never, jest.fn());
      expect(rateLimit.assertAllowed).not.toHaveBeenCalled();
      expect(rateLimit.recordFailure).not.toHaveBeenCalled();
    });
  });
});
