import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Logger, Module, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { RagModule } from "../rag/rag.module";
import { IntegrationSyncClient } from "./integration-sync.client";
import { IntegrationSyncDecisions } from "./integration-sync-decisions";
import { IntegrationSyncDocumentBuilder } from "./integration-sync-document.builder";
import { IntegrationSyncProcessor } from "./integration-sync.processor";
import { IntegrationSyncService } from "./integration-sync.service";
import {
  INTEGRATION_SYNC_NIGHTLY_JIRA_JOB,
  INTEGRATION_SYNC_NIGHTLY_JIRA_SCHEDULER_ID,
  INTEGRATION_SYNC_NIGHTLY_LINEAR_JOB,
  INTEGRATION_SYNC_NIGHTLY_LINEAR_SCHEDULER_ID,
  INTEGRATION_SYNC_QUEUE,
  NIGHTLY_SYNC_CRON,
  NIGHTLY_SYNC_TZ
} from "./integration-sync.constants";

/**
 * Ticket-tracker -> Knowledge Base sync pipeline.
 *
 * Imports RagModule (to enqueue embeddings for the documents it writes) and is itself imported by
 * LegacyModule. The dependency arrow only ever points this way: nothing here may import
 * LegacyModule, which is why the module carries its own provider client (integration-sync.client)
 * and AI allocation (integration-sync-decisions) instead of reusing LegacyService's.
 */
@Module({
  imports: [BullModule.registerQueue({ name: INTEGRATION_SYNC_QUEUE }), RagModule, PlanLimitsModule],
  providers: [IntegrationSyncService, IntegrationSyncClient, IntegrationSyncDocumentBuilder, IntegrationSyncDecisions, IntegrationSyncProcessor],
  exports: [IntegrationSyncService]
})
export class IntegrationSyncModule implements OnModuleInit {
  private readonly logger = new Logger(IntegrationSyncModule.name);

  constructor(
    private readonly sync: IntegrationSyncService,
    @InjectQueue(INTEGRATION_SYNC_QUEUE) private readonly queue: Queue
  ) {}

  async onModuleInit(): Promise<void> {
    this.sync.resumeInterruptedRuns().catch((err) => {
      this.logger.warn(`Failed to resume interrupted sync runs on startup: ${err instanceof Error ? err.message : err}`);
    });

    // Job Schedulers are Redis-backed and keyed by id, so re-registering the same schedule on
    // every boot (including across multiple app instances) just confirms it rather than creating
    // duplicates — this is what makes "fires exactly once at midnight IST" hold regardless of how
    // many backend processes are running.
    await this.queue
      .upsertJobScheduler(
        INTEGRATION_SYNC_NIGHTLY_JIRA_SCHEDULER_ID,
        { pattern: NIGHTLY_SYNC_CRON, tz: NIGHTLY_SYNC_TZ },
        { name: INTEGRATION_SYNC_NIGHTLY_JIRA_JOB, data: {} }
      )
      .catch((err) => this.logger.warn(`Failed to register nightly Jira sync scheduler: ${err instanceof Error ? err.message : err}`));

    await this.queue
      .upsertJobScheduler(
        INTEGRATION_SYNC_NIGHTLY_LINEAR_SCHEDULER_ID,
        { pattern: NIGHTLY_SYNC_CRON, tz: NIGHTLY_SYNC_TZ },
        { name: INTEGRATION_SYNC_NIGHTLY_LINEAR_JOB, data: {} }
      )
      .catch((err) => this.logger.warn(`Failed to register nightly Linear sync scheduler: ${err instanceof Error ? err.message : err}`));
  }
}
