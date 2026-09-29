import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { WELCOME_EMAIL_JOB, WELCOME_EMAIL_QUEUE } from "./welcome-email.constants";
import { WelcomeEmailJobData, WelcomeEmailService } from "./welcome-email.service";

/** Thin BullMQ boundary, same shape as ZyraArchiveSweepProcessor: all logic is in the service. */
@Processor(WELCOME_EMAIL_QUEUE)
export class WelcomeEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(WelcomeEmailProcessor.name);

  constructor(private readonly welcome: WelcomeEmailService) {
    super();
  }

  async process(job: Job<WelcomeEmailJobData>): Promise<void> {
    if (job.name !== WELCOME_EMAIL_JOB) {
      this.logger.warn(`Unknown welcome-email job name: ${job.name}`);
      return;
    }
    await this.welcome.send(job.data.userId);
  }
}
