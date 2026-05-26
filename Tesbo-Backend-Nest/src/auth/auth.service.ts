import { BadRequestException, HttpException, HttpStatus, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedRequest } from "../common/request.types";
import { AppConfigService } from "../config/app-config.service";
import { SuperAdminService } from "../admin/super-admin.service";
import { OtpService } from "./otp.service";
import { PasswordService } from "./password.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly otp: OtpService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
    private readonly superAdmin: SuperAdminService
  ) {}

  async requestOtp(email: string | undefined, req: AuthenticatedRequest): Promise<void> {
    if (!email) throw new BadRequestException({ error: "email required" });
    let sent = false;
    try {
      sent = await this.otp.requestOtp(email, this.ip(req), req.get("user-agent"));
    } catch {
      throw new ServiceUnavailableException({ error: "otp_delivery_failed" });
    }
    if (!sent) throw new HttpException({ error: "rate_limited_or_invalid" }, HttpStatus.TOO_MANY_REQUESTS);
    await this.audit.log(null, "otp_requested", "auth", email, "{}", this.ip(req), req.get("user-agent"));
  }

  async verifyOtp(email: string | undefined, code: string | undefined, req: AuthenticatedRequest, res: Response) {
    if (!email || !code) throw new BadRequestException({ error: "email and code required" });
    const token = await this.otp.verifyOtp(email.trim(), code, this.ip(req), req.get("user-agent"));
    if (!token) throw new UnauthorizedException({ error: "invalid_or_expired_otp" });
    const userId = await this.otp.resolveSession(token);
    if (!userId) throw new UnauthorizedException({ error: "invalid_or_expired_otp" });
    await this.audit.log(userId, "login", "auth", email, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
    return { ok: true, userId };
  }

  async loginWithPassword(email: string | undefined, password: string | undefined, req: AuthenticatedRequest, res: Response) {
    if (!email || !password) throw new BadRequestException({ error: "email and password required" });
    const userId = await this.password.verifyLogin(email, password);
    if (!userId) throw new UnauthorizedException({ error: "invalid_email_or_password" });
    const normalizedEmail = email.trim().toLowerCase();
    const token = await this.otp.createSession(userId, this.ip(req), req.get("user-agent"));
    await this.audit.log(userId, "login", "auth", normalizedEmail, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
    return { ok: true, userId };
  }

  async signInUser(userId: string, email: string, req: AuthenticatedRequest, res: Response): Promise<void> {
    const token = await this.otp.createSession(userId, this.ip(req), req.get("user-agent"));
    await this.audit.log(userId, "login", "auth", email, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
  }

  async logout(req: AuthenticatedRequest, res: Response): Promise<void> {
    const token = req.cookies?.[this.config.sessionCookieName];
    if (token) {
      await this.otp.invalidateSession(token);
      this.clearSessionCookie(req, res);
    }
    if (req.userId) {
      await this.audit.log(req.userId, "logout", "auth", null, "{}", this.ip(req), req.get("user-agent"));
    }
  }

  async me(userId: string) {
    return { userId, isPlatformAdmin: await this.superAdmin.isPlatformAdmin(userId) };
  }

  private setSessionCookie(req: AuthenticatedRequest, res: Response, token: string, maxAgeSeconds: number) {
    res.cookie(this.config.sessionCookieName, token, {
      path: "/",
      maxAge: maxAgeSeconds * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: this.isSecureRequest(req)
    });
  }

  private clearSessionCookie(req: AuthenticatedRequest, res: Response) {
    res.cookie(this.config.sessionCookieName, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: this.isSecureRequest(req)
    });
  }

  private isSecureRequest(req: AuthenticatedRequest): boolean {
    const forwardedProto = req.get("x-forwarded-proto");
    return req.secure || forwardedProto?.trim().toLowerCase() === "https" || this.config.frontendUrl.startsWith("https://");
  }

  private ip(req: AuthenticatedRequest): string {
    return req.ip ?? "";
  }
}
