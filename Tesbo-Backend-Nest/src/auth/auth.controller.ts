import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { AuthenticatedRequest } from "../common/request.types";
import { AuthService } from "./auth.service";

type EmailBody = { email?: string };
type VerifyOtpBody = { email?: string; code?: string };
type PasswordLoginBody = { email?: string; password?: string };
type ResetPasswordBody = { token?: string; password?: string };
type ChangePasswordBody = { currentPassword?: string; newPassword?: string };
type UpdateProfileBody = { name?: string; mobileNumber?: string };

@Controller("/api/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("/otp/request")
  @HttpCode(204)
  requestOtp(@Body() body: EmailBody, @Req() req: AuthenticatedRequest) {
    return this.auth.requestOtp(body.email, req);
  }

  @Post("/otp/verify")
  verifyOtp(@Body() body: VerifyOtpBody, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.verifyOtp(body.email, body.code, req, res);
  }

  @Post("/password/login")
  loginWithPassword(
    @Body() body: PasswordLoginBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    return this.auth.loginWithPassword(body.email, body.password, req, res);
  }

  @Post("/password/forgot")
  @HttpCode(204)
  forgotPassword(@Body() body: EmailBody, @Req() req: AuthenticatedRequest) {
    return this.auth.forgotPassword(body.email, req);
  }

  @Get("/password/reset/:token")
  checkResetToken(@Param("token") token: string) {
    return this.auth.checkResetToken(token);
  }

  @Post("/password/reset")
  resetPassword(@Body() body: ResetPasswordBody, @Req() req: AuthenticatedRequest) {
    return this.auth.resetPassword(body.token, body.password, req);
  }

  @Post("/password/change")
  @HttpCode(204)
  changePassword(
    @Body() body: ChangePasswordBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ) {
    if (!req.userId) throw new UnauthorizedException("Not authenticated");
    return this.auth.changePassword(req.userId, body.currentPassword, body.newPassword, req, res);
  }

  @Post("/logout")
  @HttpCode(204)
  logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @Get("/me")
  me(@Req() req: AuthenticatedRequest) {
    if (!req.userId) throw new UnauthorizedException("Not authenticated");
    return this.auth.me(req.userId);
  }

  @Patch("/me")
  updateMe(@Body() body: UpdateProfileBody, @Req() req: AuthenticatedRequest) {
    if (!req.userId) throw new UnauthorizedException("Not authenticated");
    return this.auth.updateProfile(req.userId, body.name, body.mobileNumber);
  }
}
