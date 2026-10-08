import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Logger, Module, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { AppConfigService } from "../config/app-config.service";
import {
  ANALYTICS_REPORT_CRON,
  ANALYTICS_REPORT_JOB,
  ANALYTICS_REPORT_QUEUE,
  ANALYTICS_REPORT_SCHEDULER_ID,
  ANALYTICS_REPORT_TZ
} from "./analytics-report.constants";
import { AnalyticsReportProcessor } from "./analytics-report.processor";
import { AnalyticsReportService } from "./analytics-report.service";
import { BasecampClient, missingBasecampConfig } from "./basecamp.client";

@Module({
  imports: [BullModule.registerQueue({ name: ANALYTICS_REPORT_QUEUE })],
  providers: [AnalyticsReportService, AnalyticsReportProcessor, BasecampClient]
})
export class AnalyticsReportModule implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsReportModule.name);

  constructor(
    @InjectQueue(ANALYTICS_REPORT_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService
  ) {}

  async onModuleInit(): Promise<void> {
    // Production only (ANALYTICS_REPORT_ENABLED=true). Anywhere else the schedule is actively REMOVED,
    // not just left unregistered, so a stack that once ran it with the flag on cannot keep firing from
    // a scheduler left behind in its Redis.
    if (!this.config.analyticsReportEnabled) {
      await this.queue.removeJobScheduler(ANALYTICS_REPORT_SCHEDULER_ID).catch(() => undefined);
      return;
    }
    const missing = missingBasecampConfig(this.config);
    if (missing) {
      this.logger.warn(`Analytics report enabled but not scheduled: ${missing}.`);
      return;
    }
    // upsertJobScheduler is idempotent per id, so re-registering on every boot (and on every instance)
    // confirms the schedule rather than duplicating it. 3 attempts with a growing delay ride out a
    // Basecamp blip; the claim in analytics_report_runs stops a retry from double-posting.
    await this.queue
      .upsertJobScheduler(
        ANALYTICS_REPORT_SCHEDULER_ID,
        { pattern: ANALYTICS_REPORT_CRON, tz: ANALYTICS_REPORT_TZ },
        { name: ANALYTICS_REPORT_JOB, data: {}, opts: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } } }
      )
      .then(() => this.logger.log(`Analytics report scheduler registered (${ANALYTICS_REPORT_CRON} ${ANALYTICS_REPORT_TZ}).`))
      .catch((err) => this.logger.warn(`Failed to register analytics report scheduler: ${err instanceof Error ? err.message : err}`));
  }
}
