import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ApiTokenService } from "./api-token.service";
import { AuthController } from "./auth.controller";
import { ActivityMiddleware } from "./activity.middleware";
import { AuthMiddleware } from "./auth.middleware";
import { AuthService } from "./auth.service";
import { EmailService } from "./email.service";
import { LoginLockoutService } from "./login-lockout.service";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { PasswordService } from "./password.service";
import { UserActivityService } from "./user-activity.service";
import { AdminModule } from "../admin/admin.module";
import { WelcomeEmailModule } from "../welcome-email/welcome-email.module";

@Module({
  imports: [AdminModule, WelcomeEmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthMiddleware,
    EmailService,
    LoginLockoutService,
    OtpService,
    PasswordService,
    PasswordResetService,
    ApiTokenService,
    ActivityMiddleware,
    UserActivityService
  ],
  exports: [AuthService, OtpService, PasswordService, PasswordResetService, AuthMiddleware, EmailService, ApiTokenService]
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Order matters: ActivityMiddleware reads the userId AuthMiddleware resolves.
    consumer.apply(AuthMiddleware, ActivityMiddleware).forRoutes("*");
  }
}
