import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import type { Response } from "express";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedRequest } from "../common/request.types";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { SuperAdminService } from "../admin/super-admin.service";
import { EmailService } from "./email.service";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { PasswordService } from "./password.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly db: DatabaseService,
    private readonly otp: OtpService,
    private readonly password: PasswordService,
    private readonly passwordReset: PasswordResetService,
    private readonly email: EmailService,
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
    if (!sent) throw new BadRequestException({ error: "email required" });
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
    const normalizedEmail = email.trim().toLowerCase();

    const result = await this.password.verifyLogin(email, password);
    if (result.outcome === "not_found") {
      throw new UnauthorizedException({ error: "No account found with that email address" });
    }
    if (result.outcome === "invalid_password") {
      throw new UnauthorizedException({ error: "invalid_email_or_password" });
    }
    const userId = result.userId;

    const token = await this.otp.createSession(userId, this.ip(req), req.get("user-agent"));
    await this.audit.log(userId, "login", "auth", normalizedEmail, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
    return { ok: true, userId };
  }

  async forgotPassword(email: string | undefined, req: AuthenticatedRequest): Promise<void> {
    if (!email) throw new BadRequestException({ error: "email required" });
    const outcome = await this.passwordReset.requestReset(email);
    if (outcome === "not_found") throw new NotFoundException({ error: "No account found with that email address" });
    await this.audit.log(null, "password_reset_requested", "auth", email.trim().toLowerCase(), "{}", this.ip(req), req.get("user-agent"));
  }

  async checkResetToken(token: string | undefined): Promise<{ valid: boolean }> {
    if (!token) return { valid: false };
    return { valid: await this.passwordReset.verifyResetToken(token) };
  }

  async resetPassword(token: string | undefined, password: string | undefined, req: AuthenticatedRequest): Promise<{ ok: true }> {
    if (!token || !password) throw new BadRequestException({ error: "token and password required" });
    this.password.assertValidPassword(password);
    const userId = await this.passwordReset.resetPassword(token, password);
    if (!userId) throw new UnauthorizedException({ error: "invalid_or_expired_token" });
    await this.audit.log(userId, "password_reset", "auth", null, "{}", this.ip(req), req.get("user-agent"));
    return { ok: true };
  }

  async changePassword(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string | undefined,
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    if (!newPassword) throw new BadRequestException({ error: "new password required" });
    this.password.assertValidPassword(newPassword);

    // A user who signed up via OTP and never set a password has nothing to verify against —
    // this doubles as "set a password for the first time" for them. Anyone with a password
    // already must prove they know it before it can be changed.
    if (await this.password.hasPassword(userId)) {
      if (!currentPassword) throw new BadRequestException({ error: "current password required" });
      const valid = await this.password.verifyCurrentPassword(userId, currentPassword);
      if (!valid) throw new UnauthorizedException({ error: "invalid_current_password" });
      if (newPassword === currentPassword) {
        throw new BadRequestException({ error: "New password must be different from your current password" });
      }
    }

    await this.password.setPassword(userId, newPassword);

    // Every session is invalidated, including the one making this request — same reasoning as
    // a password reset: whoever just changed the password must prove they know the new one
    // before continuing, rather than riding out the old session that already knew the old one.
    await this.otp.invalidateAllSessions(userId);
    this.clearSessionCookie(req, res);

    const userRow = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    const email = userRow.rows[0]?.email;
    if (email) await this.email.sendPasswordChanged(email);

    await this.audit.log(userId, "password_changed", "auth", null, "{}", this.ip(req), req.get("user-agent"));
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
    const [isPlatformAdmin, userRow, hasPassword] = await Promise.all([
      this.superAdmin.isPlatformAdmin(userId),
      this.db.query<{
        email: string;
        name: string | null;
        first_name: string | null;
        last_name: string | null;
        mobile_number: string | null;
        profile_completed_at: Date | null;
      }>(
        "SELECT email, name, first_name, last_name, mobile_number, profile_completed_at FROM users WHERE id = $1",
        [userId]
      ),
      this.password.hasPassword(userId)
    ]);
    const row = userRow.rows[0];
    return {
      userId,
      isPlatformAdmin,
      email: row?.email ?? null,
      name: row?.name ?? null,
      firstName: row?.first_name ?? null,
      lastName: row?.last_name ?? null,
      mobileNumber: row?.mobile_number ?? null,
      // false only for a passwordless-OTP first-time account that hasn't been through
      // /auth/complete-profile yet (see OtpService.findOrCreateUser and SignupService.insertUser).
      profileComplete: row?.profile_completed_at != null,
      hasPassword
    };
  }

  /**
   * Finishes the one-time profile step for an account created via passwordless OTP sign-in, which
   * collects no name/mobile up front (OtpService.findOrCreateUser). Every other account-creation path
   * already sets profile_completed_at at INSERT time, so this only ever succeeds once per account —
   * it is not a general "edit your profile" endpoint (there is deliberately no PATCH /me for that).
   */
  async completeProfile(userId: string, firstName: string, lastName: string, mobileNumber: string | null) {
    const name = `${firstName} ${lastName}`;
    const result = await this.db.query<{ id: string }>(
      `UPDATE users
       SET first_name = $1, last_name = $2, mobile_number = $3, name = $4, profile_completed_at = now(), updated_at = now()
       WHERE id = $5 AND profile_completed_at IS NULL
       RETURNING id`,
      [firstName, lastName, mobileNumber, name, userId]
    );
    if (!result.rows[0]) {
      throw new BadRequestException({ error: "Profile is already complete" });
    }
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
