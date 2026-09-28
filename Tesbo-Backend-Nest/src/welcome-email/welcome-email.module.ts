import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WELCOME_EMAIL_QUEUE } from "./welcome-email.constants";
import { WelcomeEmailProcessor } from "./welcome-email.processor";
import { WelcomeEmailService } from "./welcome-email.service";

/**
 * Imported by LegacyModule (SignupService and LegacyController schedule from here). Depends only on
 * AuthModule for EmailService, which does not depend back on Legacy, so no forwardRef is needed.
 */
@Module({
  imports: [BullModule.registerQueue({ name: WELCOME_EMAIL_QUEUE }), AuthModule],
  providers: [WelcomeEmailService, WelcomeEmailProcessor],
  exports: [WelcomeEmailService]
})
export class WelcomeEmailModule {}
