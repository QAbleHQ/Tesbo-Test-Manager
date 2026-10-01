import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { EmailService } from "../auth/email.service";
import { WELCOME_EMAIL_QUEUE } from "./welcome-email.constants";
import { WelcomeEmailProcessor } from "./welcome-email.processor";
import { WelcomeEmailService } from "./welcome-email.service";

/**
 * Imported by AuthModule (passwordless OTP signup) and LegacyModule (self-serve and invite signup).
 *
 * Provides its own EmailService rather than importing AuthModule for it, because AuthModule imports
 * this module — the other way round would be a cycle. EmailService holds no state (its only deps are
 * the global AppConfigService and EmailDeliveryPolicy), so a second instance is harmless.
 */
@Module({
  imports: [BullModule.registerQueue({ name: WELCOME_EMAIL_QUEUE })],
  providers: [WelcomeEmailService, WelcomeEmailProcessor, EmailService],
  exports: [WelcomeEmailService]
})
export class WelcomeEmailModule {}
