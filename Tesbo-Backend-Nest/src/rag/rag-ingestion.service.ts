import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { DatabaseService } from "../database/database.service";
import { RAG_EMBEDDING_JOB_NAME, RAG_EMBEDDING_QUEUE, RAG_TESTCASE_EMBEDDING_JOB_NAME } from "./rag.constants";
import { EmbeddingJobPayload, TestcaseEmbeddingJobPayload } from "./rag.types";

// Producer side of the embedding pipeline. Enqueue calls are meant to be fired
// fire-and-forget (`void this.ragIngestion.enqueueEmbedding(...).catch(() => undefined)`)
// from the same write sites that already insert/update knowledge_documents/knowledge_files.
@Injectable()
export class RagIngestionService {
  private readonly logger = new Logger(RagIngestionService.name);

  constructor(
    @InjectQueue(RAG_EMBEDDING_QUEUE) private readonly queue: Queue<EmbeddingJobPayload | TestcaseEmbeddingJobPayload>,
    private readonly db: DatabaseService
  ) {}

  async enqueueEmbedding(payload: EmbeddingJobPayload): Promise<void> {
    const table = payload.sourceType === "document" ? "knowledge_documents" : "knowledge_files";
    await this.db
      .query(`UPDATE ${table} SET embedding_status = 'queued' WHERE id = $1 AND project_id = $2`, [payload.sourceId, payload.projectId])
      .catch(() => undefined);

    // Deterministic jobId dedupes concurrent enqueues for the same source while one is
    // already waiting/active — BullMQ silently no-ops a duplicate add. BullMQ job IDs can't
    // contain ":" (used internally as a Redis key delimiter), hence "-" here rather than the
    // ":" used elsewhere in this codebase for composite keys.
    await this.queue.add(RAG_EMBEDDING_JOB_NAME, payload, {
      jobId: `${payload.sourceType}-${payload.sourceId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 }
    }).catch((err) => {
      this.logger.warn(`Failed to enqueue embedding job for ${payload.sourceType}:${payload.sourceId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  // Test-case counterpart of enqueueEmbedding, on the same queue/worker/retry config — see
  // RAG_TESTCASE_EMBEDDING_JOB_NAME's comment for why this doesn't get its own queue. Meant to be
  // called fire-and-forget from LegacyService's testcase write paths (createTestCase/
  // updateTestCase/patchTestCaseFromZyra — see legacy.service.ts's enqueueTestcaseEmbedding
  // wrapper), the same way enqueueEmbedding already is for knowledge_documents/knowledge_files.
  //
  // Deliberately NOT called from bulkCreateTestCases (CSV/API import) or
  // zyraBatchInsertTestCases (staged Zyra drafts, which write to ai_generation_requests, not
  // testcases, until a save is confirmed) — out of scope for this pass. Those paths leave newly
  // created rows at embedding_status='pending' (the column default) until either widened into
  // this hook or covered by a future backfill decision.
  async enqueueTestcaseEmbedding(payload: TestcaseEmbeddingJobPayload): Promise<void> {
    await this.db
      .query(`UPDATE testcases SET embedding_status = 'queued' WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`, [
        payload.testcaseId,
        payload.projectId
      ])
      .catch(() => undefined);

    await this.queue.add(RAG_TESTCASE_EMBEDDING_JOB_NAME, payload, {
      jobId: `testcase-${payload.testcaseId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 }
    }).catch((err) => {
      this.logger.warn(`Failed to enqueue testcase embedding job for testcase:${payload.testcaseId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  // Re-enqueues anything left in an in-progress status after a restart/crash — same
  // self-healing idiom as resumeInterruptedZyraChatPlans (legacy.service.ts). Safe to call
  // repeatedly: the deterministic jobId above means re-enqueuing an already-queued source
  // is a no-op.
  async resumeInterruptedEmbeddings(): Promise<void> {
    const docs = await this.db
      .query<{ id: string; project_id: string; organization_id: string }>(
        "SELECT id, project_id, organization_id FROM knowledge_documents WHERE embedding_status IN ('pending','queued','processing') AND is_deleted = false"
      )
      .catch(() => ({ rows: [] as Array<{ id: string; project_id: string; organization_id: string }> }));
    const files = await this.db
      .query<{ id: string; project_id: string; organization_id: string }>(
        `SELECT id, project_id, organization_id FROM knowledge_files
         WHERE embedding_status IN ('pending','queued','processing') AND is_deleted = false
           AND (extraction_status IN ('ready','unsupported') OR extraction_status IS NULL)`
      )
      .catch(() => ({ rows: [] as Array<{ id: string; project_id: string; organization_id: string }> }));

    for (const row of docs.rows) {
      await this.enqueueEmbedding({ organizationId: row.organization_id, projectId: row.project_id, sourceType: "document", sourceId: row.id, reason: "reindex" });
    }
    for (const row of files.rows) {
      await this.enqueueEmbedding({ organizationId: row.organization_id, projectId: row.project_id, sourceType: "file", sourceId: row.id, reason: "reindex" });
    }
  }
}
