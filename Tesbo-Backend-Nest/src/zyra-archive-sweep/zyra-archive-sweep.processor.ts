import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ZYRA_ARCHIVE_SWEEP_JOB, ZYRA_ARCHIVE_SWEEP_QUEUE } from "./zyra-archive-sweep.constants";
import { ZyraArchiveSweepService } from "./zyra-archive-sweep.service";

/**
 * Thin BullMQ boundary — everything that can be unit-tested without a real queue lives in
 * ZyraArchiveSweepService.run(); this class only exists to give that method a job to fire from,
 * mirroring IntegrationSyncProcessor's own dispatch-on-job.name shape (though this queue currently
 * has only the one job type — no per-ticket fan-out, see the service's own comment on why).
 *
 * No result is thrown on a run-level failure: run() already isolates every per-candidate and
 * per-project failure internally and always resolves with a summary (even an all-failed one is a
 * valid, reportable outcome) — a job.process() throw here would only ever fire for something
 * outside that contract (a bug), and BullMQ's own retry of a full re-sweep for that is no better
 * than next cycle's scheduled run picking it up, so this deliberately doesn't set job `attempts`
 * above the BullMQ default of 1 in the module's queue registration.
 */
@Processor(ZYRA_ARCHIVE_SWEEP_QUEUE)
export class ZyraArchiveSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(ZyraArchiveSweepProcessor.name);

  constructor(private readonly sweep: ZyraArchiveSweepService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== ZYRA_ARCHIVE_SWEEP_JOB) {
      this.logger.warn(`Unknown zyra-archive-sweep job name: ${job.name}`);
      return null;
    }
    return this.sweep.run();
  }
}
