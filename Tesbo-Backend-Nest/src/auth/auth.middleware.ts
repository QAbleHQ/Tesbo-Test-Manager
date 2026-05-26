import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Response, NextFunction } from "express";
import { AppConfigService } from "../config/app-config.service";
import { AuthenticatedRequest } from "../common/request.types";
import { OtpService } from "./otp.service";

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfigService,
    private readonly otpService: OtpService
  ) {}

  async use(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
    const token = req.cookies?.[this.config.sessionCookieName];
    req.userId = token ? await this.otpService.resolveSession(token) : null;
    next();
  }
}
