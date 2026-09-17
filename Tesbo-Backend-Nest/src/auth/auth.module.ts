import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ApiTokenService } from "./api-token.service";
import { AuthController } from "./auth.controller";
import { AuthMiddleware } from "./auth.middleware";
import { AuthService } from "./auth.service";
import { EmailService } from "./email.service";
import { LoginLockoutService } from "./login-lockout.service";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { PasswordService } from "./password.service";
import { AdminModule } from "../admin/admin.module";

@Module({
  imports: [AdminModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthMiddleware,
    EmailService,
    LoginLockoutService,
    OtpService,
    PasswordService,
    PasswordResetService,
    ApiTokenService
  ],
  exports: [AuthService, OtpService, PasswordService, PasswordResetService, AuthMiddleware, EmailService, ApiTokenService]
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes("*");
  }
}
