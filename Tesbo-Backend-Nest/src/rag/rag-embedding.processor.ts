import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { Job } from "bullmq";
import { DatabaseService } from "../database/database.service";
import { tracedEmbeddingCall } from "../observability/embedding-trace";
import { embedTexts, resolveEmbeddingAllocation } from "./rag-ai-allocation";
import { RagChunkingService } from "./rag-chunking.service";
import { RAG_EMBEDDING_BATCH_SIZE, RAG_EMBEDDING_DIMENSION, RAG_EMBEDDING_QUEUE, RAG_TESTCASE_EMBEDDING_JOB_NAME } from "./rag.constants";
import { EmbeddingJobPayload, TestcaseEmbeddingJobPayload } from "./rag.types";
import { buildTestcaseEmbeddingText } from "./testcase-embedding-text";

// Consumer side of the embedding pipeline. Deliberately resolves its own AI-key allocation
// (via rag-ai-allocation.ts) rather than importing LegacyService, to avoid a circular
// LegacyModule <-> RagModule dependency (LegacyModule needs RagIngestionService/
// RagRetrievalService; this module must not need anything back from LegacyModule).
@Processor(RAG_EMBEDDING_QUEUE)
export class RagEmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(RagEmbeddingProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly chunking: RagChunkingService
  ) {
    super();
  }

  async process(job: Job<EmbeddingJobPayload | TestcaseEmbeddingJobPayload>): Promise<void> {
    if (job.name === RAG_TESTCASE_EMBEDDING_JOB_NAME) {
      return this.processTestcase(job as Job<TestcaseEmbeddingJobPayload>);
    }
    return this.processKnowledgeSource(job as Job<EmbeddingJobPayload>);
  }

  private async processKnowledgeSource(job: Job<EmbeddingJobPayload>): Promise<void> {
    const { projectId, sourceType, sourceId } = job.data;
    const table = sourceType === "document" ? "knowledge_documents" : "knowledge_files";
    const contentColumn = sourceType === "document" ? "content_text" : "extracted_text";

    const sourceRes = await this.db.query<{ id: string; organization_id: string; content: string | null; embedding_content_hash: string | null }>(
      `SELECT id, organization_id, ${contentColumn} AS content, embedding_content_hash FROM ${table} WHERE id = $1 AND project_id = $2 AND is_deleted = false`,
      [sourceId, projectId]
    );
    const source = sourceRes.rows[0];
    // Not found here means soft-deleted (is_deleted=true) or gone since the job was queued —
    // either way there's nothing to embed. Explicitly clear the status rather than leaving it
    // stuck at 'queued' forever (setStatus works fine against a soft-deleted row; it just
    // stays excluded from retrieval via the is_deleted filter regardless of this status).
    if (!source) {
      await this.setStatus(table, sourceId, "unsupported").catch(() => undefined);
      return;
    }

    const content = String(source.content || "").trim();
    if (!content) {
      await this.setStatus(table, sourceId, "unsupported");
      return;
    }

    const { allocation, reason } = await resolveEmbeddingAllocation(this.db, projectId);
    if (!allocation) {
      // Deliberately 'pending', not 'unsupported'. 'unsupported' means *this source* can never
      // be embedded (no extractable text); it is terminal, and resumeInterruptedEmbeddings()
      // never revisits it. A missing workspace key is not a property of the source at all — it
      // is a temporary state of the workspace that ends the moment someone adds a key. Marking
      // it terminal is what left 1,237 documents and 43 files permanently dark once the
      // OpenAI-only allocator started refusing every Anthropic project. Leaving it pending lets
      // the boot-time sweep pick it up for free as soon as a key exists.
      this.logger.warn(`Cannot embed ${sourceType}:${sourceId} — ${reason}`);
      await this.setStatus(table, sourceId, "pending");
      return;
    }

    const contentHash = createHash("sha256").update(content).digest("hex");
    if (contentHash === source.embedding_content_hash) return;

    await this.setStatus(table, sourceId, "processing");

    const chunks = this.chunking.chunk(content);
    if (!chunks.length) {
      await this.setStatus(table, sourceId, "unsupported");
      return;
    }

    // Deterministic per-content-version trace id — recomputable from data already stored
    // (embedding_content_hash), the same "no trace_id column, no backfill" philosophy
    // startZyraTurn uses for chat messages. One batch = one Langfuse observation, all landing
    // under this same trace id, so a multi-batch document shows exactly which batch failed
    // rather than one opaque "job failed" line.
    const traceSeed = `embed-doc:${sourceType}:${sourceId}:${contentHash}`;
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += RAG_EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + RAG_EMBEDDING_BATCH_SIZE);
      const vectors = await tracedEmbeddingCall(
        {
          traceSeed,
          name: "kb-chunk-embedding-batch",
          projectId,
          organizationId: source.organization_id,
          provider: allocation.provider,
          model: allocation.model,
          inputCount: batch.length,
          inputSample: batch[0]?.content
        },
        () => embedTexts(allocation, batch.map((c) => c.content))
      );
      embeddings.push(...vectors);
    }

    await this.db.transaction(async (client) => {
      await client.query("DELETE FROM knowledge_document_chunks WHERE project_id = $1 AND source_type = $2 AND source_id = $3", [
        projectId,
        sourceType,
        sourceId
      ]);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const vector = embeddings[i];
        // Width is checked against the platform constant, which is what the column and its
        // HNSW index are declared at — not against whatever the provider happened to return.
        // A mismatch means the model or its `dimensions` handling is misconfigured; skipping
        // is the only safe response, because slicing a non-Matryoshka vector to fit would
        // store something that indexes cleanly and ranks nonsense.
        if (!vector || vector.length !== RAG_EMBEDDING_DIMENSION) {
          this.logger.warn(
            `Discarding chunk ${chunk.chunkIndex} of ${sourceType}:${sourceId} — ${allocation.provider}/${allocation.model} returned ${vector?.length ?? 0} dimensions, expected ${RAG_EMBEDDING_DIMENSION}.`
          );
          continue;
        }
        await client.query(
          `INSERT INTO knowledge_document_chunks
             (organization_id, project_id, source_type, source_id, chunk_index, heading_path, content, token_count, content_hash, embedding_model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)`,
          [
            source.organization_id,
            projectId,
            sourceType,
            sourceId,
            chunk.chunkIndex,
            chunk.headingPath,
            chunk.content,
            chunk.tokenCount,
            contentHash,
            allocation.model,
            `[${vector.join(",")}]`
          ]
        );
      }
    });

    await this.db.query(`UPDATE ${table} SET embedding_status = 'ready', embedding_content_hash = $2, updated_at = now() WHERE id = $1`, [
      sourceId,
      contentHash
    ]);
  }

  // Test-case counterpart of processKnowledgeSource above. One vector per test case (no
  // chunking — see V106_testcase_embeddings.sql's comment on why), written to
  // testcase_embeddings rather than knowledge_document_chunks. Shares resolveEmbeddingAllocation/
  // embedTexts (rag-ai-allocation.ts) with the document path — same provider, same platform
  // vector width, no second embedding call site.
  private async processTestcase(job: Job<TestcaseEmbeddingJobPayload>): Promise<void> {
    const { projectId, testcaseId } = job.data;

    const sourceRes = await this.db.query<{ id: string; title: string; description: string | null; steps: unknown; embedding_content_hash: string | null }>(
      `SELECT id, title, description, steps, embedding_content_hash FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [testcaseId, projectId]
    );
    const source = sourceRes.rows[0];
    // Not found here means hard-gone or soft-deleted (deleted_at set) since the job was queued —
    // either way there's nothing to embed. Same "clear the status rather than leave it stuck at
    // 'queued' forever" reasoning as the knowledge-source branch above.
    if (!source) {
      await this.setStatus("testcases", testcaseId, "unsupported").catch(() => undefined);
      return;
    }

    const text = buildTestcaseEmbeddingText(source);
    if (!text) {
      await this.setStatus("testcases", testcaseId, "unsupported");
      return;
    }

    const { allocation, reason } = await resolveEmbeddingAllocation(this.db, projectId);
    if (!allocation) {
      // 'pending', not 'unsupported' — same reasoning as the knowledge-source branch: a missing
      // workspace key is a temporary property of the workspace, not a terminal property of this
      // test case. Nothing currently sweeps 'pending' test cases the way
      // resumeInterruptedEmbeddings() sweeps documents/files on boot (see rag-ingestion.service.ts
      // for why that's deliberate), so this status will only clear on the next create/update to
      // this test case, or once a future backfill decision adds that sweep.
      this.logger.warn(`Cannot embed testcase:${testcaseId} — ${reason}`);
      await this.setStatus("testcases", testcaseId, "pending");
      return;
    }

    const contentHash = createHash("sha256").update(text).digest("hex");
    if (contentHash === source.embedding_content_hash) return;

    await this.setStatus("testcases", testcaseId, "processing");

    const traceSeed = `embed-testcase:${testcaseId}:${contentHash}`;
    const [vector] = await tracedEmbeddingCall(
      {
        traceSeed,
        name: "testcase-embedding",
        projectId,
        provider: allocation.provider,
        model: allocation.model,
        inputCount: 1,
        inputSample: text
      },
      () => embedTexts(allocation, [text])
    );
    if (!vector || vector.length !== RAG_EMBEDDING_DIMENSION) {
      this.logger.warn(
        `Discarding embedding for testcase:${testcaseId} — ${allocation.provider}/${allocation.model} returned ${vector?.length ?? 0} dimensions, expected ${RAG_EMBEDDING_DIMENSION}.`
      );
      await this.setStatus("testcases", testcaseId, "failed");
      return;
    }

    // One row per test case, so an UPSERT rather than knowledge_document_chunks' delete+reinsert
    // (which exists there to replace a whole chunk set atomically — no equivalent set to replace
    // here).
    await this.db.query(
      `INSERT INTO testcase_embeddings (project_id, testcase_id, content_hash, embedding_model, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (project_id, testcase_id) DO UPDATE
         SET content_hash = EXCLUDED.content_hash, embedding_model = EXCLUDED.embedding_model,
             embedding = EXCLUDED.embedding, updated_at = now()`,
      [projectId, testcaseId, contentHash, allocation.model, `[${vector.join(",")}]`]
    );

    await this.db.query(`UPDATE testcases SET embedding_status = 'ready', embedding_content_hash = $2, updated_at = now() WHERE id = $1`, [
      testcaseId,
      contentHash
    ]);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<EmbeddingJobPayload | TestcaseEmbeddingJobPayload> | undefined): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;
    if (job.name === RAG_TESTCASE_EMBEDDING_JOB_NAME) {
      const { testcaseId } = job.data as TestcaseEmbeddingJobPayload;
      await this.setStatus("testcases", testcaseId, "failed").catch(() => undefined);
      this.logger.warn(`Embedding job permanently failed for testcase:${testcaseId}`);
      return;
    }
    const data = job.data as EmbeddingJobPayload;
    const table = data.sourceType === "document" ? "knowledge_documents" : "knowledge_files";
    await this.setStatus(table, data.sourceId, "failed").catch(() => undefined);
    this.logger.warn(`Embedding job permanently failed for ${data.sourceType}:${data.sourceId}`);
  }

  private async setStatus(table: string, sourceId: string, status: string): Promise<void> {
    await this.db.query(`UPDATE ${table} SET embedding_status = $2, updated_at = now() WHERE id = $1`, [sourceId, status]);
  }
}
