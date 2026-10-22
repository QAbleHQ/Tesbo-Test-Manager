import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Logger, Module, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { LegacyModule } from "../legacy/legacy.module";
import { DUE_DATE_SWEEP_CRON, DUE_DATE_SWEEP_JOB, DUE_DATE_SWEEP_QUEUE, DUE_DATE_SWEEP_SCHEDULER_ID, DUE_DATE_SWEEP_TZ } from "./due-date-sweep.constants";
import { DueDateSweepProcessor } from "./due-date-sweep.processor";
import { DueDateSweepService } from "./due-date-sweep.service";

@Module({
  imports: [BullModule.registerQueue({ name: DUE_DATE_SWEEP_QUEUE }), LegacyModule],
  providers: [DueDateSweepService, DueDateSweepProcessor],
  exports: [DueDateSweepService]
})
export class DueDateSweepModule implements OnModuleInit {
  private readonly logger = new Logger(DueDateSweepModule.name);

  constructor(@InjectQueue(DUE_DATE_SWEEP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    // Redis-backed and keyed by id, so re-registering on every boot (or from several instances)
    // confirms the schedule rather than duplicating it — same as ZyraArchiveSweepModule.
    await this.queue
      .upsertJobScheduler(DUE_DATE_SWEEP_SCHEDULER_ID, { pattern: DUE_DATE_SWEEP_CRON, tz: DUE_DATE_SWEEP_TZ }, { name: DUE_DATE_SWEEP_JOB, data: {} })
      .then(() => this.logger.log(`Due-date sweep scheduler registered (${DUE_DATE_SWEEP_CRON} ${DUE_DATE_SWEEP_TZ}).`))
      .catch((err) => this.logger.warn(`Failed to register due-date sweep scheduler: ${err instanceof Error ? err.message : err}`));
  }
}
