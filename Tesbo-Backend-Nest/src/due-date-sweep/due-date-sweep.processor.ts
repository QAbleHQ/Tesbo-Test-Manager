import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { DUE_DATE_SWEEP_JOB, DUE_DATE_SWEEP_QUEUE } from "./due-date-sweep.constants";
import { DueDateSweepService } from "./due-date-sweep.service";

/** Thin BullMQ boundary; everything testable lives in DueDateSweepService.run(). */
@Processor(DUE_DATE_SWEEP_QUEUE)
export class DueDateSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(DueDateSweepProcessor.name);

  constructor(private readonly sweep: DueDateSweepService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== DUE_DATE_SWEEP_JOB) {
      this.logger.warn(`Unknown due-date-sweep job name: ${job.name}`);
      return null;
    }
    return this.sweep.run();
  }
}
