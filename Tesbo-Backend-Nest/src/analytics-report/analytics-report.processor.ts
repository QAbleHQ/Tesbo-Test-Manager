import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ANALYTICS_REPORT_JOB, ANALYTICS_REPORT_QUEUE } from "./analytics-report.constants";
import { AnalyticsReportService } from "./analytics-report.service";

/** Thin BullMQ boundary; a thrown error here is what makes BullMQ retry (attempts set in the module). */
@Processor(ANALYTICS_REPORT_QUEUE)
export class AnalyticsReportProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyticsReportProcessor.name);

  constructor(private readonly report: AnalyticsReportService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== ANALYTICS_REPORT_JOB) {
      this.logger.warn(`Unknown analytics-report job name: ${job.name}`);
      return null;
    }
    return this.report.run();
  }
}
