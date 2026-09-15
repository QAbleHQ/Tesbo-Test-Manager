import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Logger, Module, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { LegacyModule } from "../legacy/legacy.module";
import {
  ZYRA_ARCHIVE_SWEEP_CRON,
  ZYRA_ARCHIVE_SWEEP_JOB,
  ZYRA_ARCHIVE_SWEEP_QUEUE,
  ZYRA_ARCHIVE_SWEEP_SCHEDULER_ID,
  ZYRA_ARCHIVE_SWEEP_TZ
} from "./zyra-archive-sweep.constants";
import { ZyraArchiveSweepProcessor } from "./zyra-archive-sweep.processor";
import { ZyraArchiveSweepService } from "./zyra-archive-sweep.service";

/**
 * Archive-sweep sub-task C. No forwardRef needed: this module depends on LegacyModule (for
 * LegacyService's fetchLiveTicketCategory/fetchLiveJiraTicketCategoriesBulk/
 * stageArchiveSweepProposal — sub-tasks A/B/C's work) but nothing in Legacy depends back on it,
 * the identical shape AutomationModule already uses for the same reason (see its own comment).
 */
@Module({
  imports: [BullModule.registerQueue({ name: ZYRA_ARCHIVE_SWEEP_QUEUE }), LegacyModule],
  providers: [ZyraArchiveSweepService, ZyraArchiveSweepProcessor],
  exports: [ZyraArchiveSweepService]
})
export class ZyraArchiveSweepModule implements OnModuleInit {
  private readonly logger = new Logger(ZyraArchiveSweepModule.name);

  constructor(@InjectQueue(ZYRA_ARCHIVE_SWEEP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    // Job Schedulers are Redis-backed and keyed by id, so re-registering the same schedule on every
    // boot (including across multiple backend instances) just confirms it rather than creating
    // duplicates — identical reasoning to IntegrationSyncModule's own onModuleInit.
    await this.queue
      .upsertJobScheduler(ZYRA_ARCHIVE_SWEEP_SCHEDULER_ID, { pattern: ZYRA_ARCHIVE_SWEEP_CRON, tz: ZYRA_ARCHIVE_SWEEP_TZ }, { name: ZYRA_ARCHIVE_SWEEP_JOB, data: {} })
      .then(() => this.logger.log(`Archive sweep scheduler registered (${ZYRA_ARCHIVE_SWEEP_CRON} ${ZYRA_ARCHIVE_SWEEP_TZ}).`))
      .catch((err) => this.logger.warn(`Failed to register archive sweep scheduler: ${err instanceof Error ? err.message : err}`));
  }
}
