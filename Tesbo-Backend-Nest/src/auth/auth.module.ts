import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthMiddleware } from "./auth.middleware";
import { AuthService } from "./auth.service";
import { EmailService } from "./email.service";
import { OtpService } from "./otp.service";
import { PasswordService } from "./password.service";
import { AdminModule } from "../admin/admin.module";

@Module({
  imports: [AdminModule],
  controllers: [AuthController],
  providers: [AuthService, AuthMiddleware, EmailService, OtpService, PasswordService],
  exports: [AuthService, OtpService, PasswordService, AuthMiddleware]
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes("*");
  }
}
