import { ForbiddenException, Injectable, NestMiddleware } from "@nestjs/common";
import type { Response, NextFunction } from "express";
import { AppConfigService } from "../config/app-config.service";
import { AuthenticatedRequest } from "../common/request.types";
import { ApiTokenService } from "./api-token.service";
import { denyApiTokenRequest } from "./api-token-policy";
import { LIMITS, RateLimitService, clientKey } from "../rate-limit/rate-limit.service";
import { OtpService } from "./otp.service";

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfigService,
    private readonly otpService: OtpService,
    private readonly apiTokens: ApiTokenService,
    private readonly rateLimit: RateLimitService
  ) {}

  async use(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
    // Primary path: browser session cookie.
    const sessionToken = req.cookies?.[this.config.sessionCookieName];
    req.userId = sessionToken ? await this.otpService.resolveSession(sessionToken) : null;
    req.apiToken = null;

    // Secondary path: API bearer token for machine clients (e.g. the MCP server).
    // Only consulted when there is no valid browser session, so the same API
    // serves both the frontend and token-authenticated automation.
    if (!req.userId) {
      const bearer = this.extractBearerToken(req.headers?.authorization);
      if (bearer) {
        const principal = await this.apiTokens.authenticate(bearer);
        // Only an address that keeps presenting tokens that DO NOT EXIST is held back, and only from
        // presenting more of them: a valid token is never checked against this, nor is a session or any
        // other address. The cap is far above a misconfigured CI retrying an expired token.
        if (!principal) {
          const source = clientKey(req.ip);
          await this.rateLimit.assertAllowed(LIMITS.badTokensPerIp, source);
          await this.rateLimit.recordFailure(LIMITS.badTokensPerIp, source);
        }
        if (principal) {
          const token = {
            tokenId: principal.tokenId,
            userId: principal.userId,
            projectId: principal.projectId,
            scopes: principal.scopes
          };
          // Refused here, before any controller runs, so a token never reaches a route it was not
          // issued for. originalUrl rather than req.path: a middleware mounted on "*" can see a
          // path with its mount prefix stripped.
          const denied = denyApiTokenRequest(req.method, req.originalUrl ?? req.url ?? "", token);
          if (denied) throw new ForbiddenException({ error: denied });
          req.userId = principal.userId;
          req.apiToken = token;
        }
      }
    }

    next();
  }

  private extractBearerToken(header: string | string[] | undefined): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match ? match[1].trim() : null;
  }
}
