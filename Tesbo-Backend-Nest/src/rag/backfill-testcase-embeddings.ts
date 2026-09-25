import { createHash } from "crypto";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import { embedTexts, resolveEmbeddingAllocation } from "./rag-ai-allocation";
import { RAG_EMBEDDING_DIMENSION } from "./rag.constants";
import { buildTestcaseEmbeddingText } from "./testcase-embedding-text";

/*
 * One-off, explicitly-invoked backfill for test cases left at embedding_status='pending' by
 * V106_testcase_embeddings.sql (every test case that existed before that migration ran — the
 * migration itself does no backfill, on purpose, see its own comment). NOT run automatically:
 * unlike RagIngestionService.resumeInterruptedEmbeddings() (which sweeps knowledge_documents/
 * knowledge_files on every backend boot), this script is never called from onModuleInit or
 * anywhere else in the app — it only runs when a human invokes it.
 *
 * Reuses the exact on-write path: resolveEmbeddingAllocation/embedTexts (rag-ai-allocation.ts,
 * the same provider-resolution and HTTP call the live create/update hook uses) and
 * buildTestcaseEmbeddingText (the same text-construction rule rag-embedding.processor.ts uses),
 * so a backfilled row is embedded identically to a freshly-created one.
 *
 * Defaults to a dry run. Dry run still resolves each project's embedding allocation (a DB-only
 * read of workspace_ai_keys/project_ai_key_allocations — no network call to the provider), so its
 * report distinguishes "would embed now" from "would stay pending — no usable key" without
 * spending anything.
 *
 * Usage (from Tesbo-Backend-Nest/):
 *   npx ts-node src/rag/backfill-testcase-embeddings.ts                              # dry run, all projects
 *   npx ts-node src/rag/backfill-testcase-embeddings.ts --execute                    # real run, all projects
 *   npx ts-node src/rag/backfill-testcase-embeddings.ts --execute --project-id=<uuid> # scope to one project
 *   npx ts-node src/rag/backfill-testcase-embeddings.ts --execute --limit=500        # cap rows this invocation
 *   npx ts-node src/rag/backfill-testcase-embeddings.ts --execute --batch-size=25 --rate-limit-ms=2000
 *
 * package.json wires the same pair migrate/migrate:dev and backfill:encrypt-secrets/:dev already
 * use: `backfill:testcase-embeddings` (node dist/..., prod) and `backfill:testcase-embeddings:dev`
 * (ts-node, this file, dev/local).
 */

const BACKFILL_LOCK_KEY = 87261044;

// Conservative defaults, not tuned against a real provider's rate limits — this sweeps every
// project in the database in one run, unlike the on-write path (one project, one test case, one
// request) or even the document pipeline's per-source batch (RAG_EMBEDDING_BATCH_SIZE=96, but
// that is 96 chunks of ONE document under ONE key, not a cross-tenant sweep). A customer's own
// bring-your-own key may be on a much lower tier than this platform's own usage, so the safer
// starting point is fewer requests per second, not more — widen only after watching a real run's
// error rate.
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_RATE_LIMIT_MS = 2000;

interface Args {
  execute: boolean;
  projectId: string | null;
  limit: number | null;
  batchSize: number;
  rateLimitMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, projectId: null, limit: null, batchSize: DEFAULT_BATCH_SIZE, rateLimitMs: DEFAULT_RATE_LIMIT_MS };
  for (const raw of argv) {
    if (raw === "--execute") args.execute = true;
    else if (raw.startsWith("--project-id=")) args.projectId = raw.slice("--project-id=".length);
    else if (raw.startsWith("--limit=")) args.limit = Number.parseInt(raw.slice("--limit=".length), 10);
    else if (raw.startsWith("--batch-size=")) args.batchSize = Number.parseInt(raw.slice("--batch-size=".length), 10);
    else if (raw.startsWith("--rate-limit-ms=")) args.rateLimitMs = Number.parseInt(raw.slice("--rate-limit-ms=".length), 10);
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) args.batchSize = DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(args.rateLimitMs) || args.rateLimitMs < 0) args.rateLimitMs = DEFAULT_RATE_LIMIT_MS;
  return args;
}

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

function normalizeDatabaseUrl(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("jdbc:postgresql://")) return value.slice("jdbc:".length);
  if (value.startsWith("jdbc:postgres://")) return value.slice("jdbc:".length);
  return value;
}

interface PendingRow {
  id: string;
  project_id: string;
  title: string | null;
  description: string | null;
  steps: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL ?? "postgresql://localhost:5432/tesbo");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = new DatabaseService(pool);

  const client = await pool.connect();
  try {
    if (args.execute) {
      // Only the real-write path takes the lock — two dry runs reading the same rows is harmless,
      // but two EXECUTE runs racing over the same pending rows is not something to allow silently.
      await client.query("SELECT pg_advisory_lock($1)", [BACKFILL_LOCK_KEY]);
    }

    const projectFilter = args.projectId ? `AND project_id = $1` : "";
    const params = args.projectId ? [args.projectId] : [];
    const totalPendingRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM testcases WHERE embedding_status = 'pending' AND deleted_at IS NULL ${projectFilter}`,
      params
    );
    const totalPending = Number(totalPendingRes.rows[0]?.count ?? 0);

    const projectsRes = await db.query<{ project_id: string; count: string }>(
      `SELECT project_id, count(*) FROM testcases WHERE embedding_status = 'pending' AND deleted_at IS NULL ${projectFilter}
       GROUP BY project_id ORDER BY count(*) DESC`,
      params
    );

    console.log(`${args.execute ? "EXECUTE" : "DRY RUN"} — ${totalPending} pending test case(s) across ${projectsRes.rows.length} project(s).`);
    if (args.projectId) console.log(`Scoped to project ${args.projectId}.`);
    if (args.limit) console.log(`Capped at ${args.limit} row(s) this invocation.`);
    console.log(`Batch size: ${args.batchSize} test case(s) per embeddings call. Rate limit: ${args.rateLimitMs}ms between calls.`);
    console.log("");

    let wouldEmbedProjects = 0;
    let wouldStayPendingProjects = 0;
    let wouldEmbedRows = 0;
    let wouldStayPendingRows = 0;

    let processed = 0;
    let embedded = 0;
    let failed = 0;
    let apiCalls = 0;

    for (const projectRow of projectsRes.rows) {
      const projectId = projectRow.project_id;
      const pendingInProject = Number(projectRow.count);
      const { allocation, reason } = await resolveEmbeddingAllocation(db, projectId);

      if (!allocation) {
        wouldStayPendingProjects++;
        wouldStayPendingRows += pendingInProject;
        console.log(`  project ${projectId}: ${pendingInProject} pending — NO USABLE KEY (${reason})`);
        continue;
      }
      wouldEmbedProjects++;
      wouldEmbedRows += pendingInProject;
      console.log(`  project ${projectId}: ${pendingInProject} pending — would embed via ${allocation.provider}/${allocation.model}`);

      if (!args.execute) continue;
      if (args.limit && processed >= args.limit) continue;

      // Re-selected per project, in batches, rather than loaded all at once: a 26k-row corpus
      // held in memory at once is unnecessary and this way a crash mid-run loses only the
      // in-flight batch, not the whole invocation's progress (already-embedded rows are no
      // longer 'pending' and drop out of every subsequent SELECT here).
      while (true) {
        if (args.limit && processed >= args.limit) break;
        const batchLimit = args.limit ? Math.min(args.batchSize, args.limit - processed) : args.batchSize;
        const rowsRes = await db.query<PendingRow>(
          `SELECT id, project_id, title, description, steps FROM testcases
           WHERE embedding_status = 'pending' AND deleted_at IS NULL AND project_id = $1
           ORDER BY id LIMIT $2`,
          [projectId, batchLimit]
        );
        if (!rowsRes.rows.length) break;

        const texts = rowsRes.rows.map((row) => buildTestcaseEmbeddingText(row));
        // A test case with no embeddable text at all (blank title+description+steps) shouldn't
        // happen — createTestCase defaults title to "Untitled test case" — but stay honest about
        // it rather than sending an empty string to the provider.
        const embeddableIndexes = texts.reduce<number[]>((acc, text, i) => (text ? [...acc, i] : acc), []);
        if (embeddableIndexes.length) {
          apiCalls++;
          try {
            const vectors = await embedTexts(allocation, embeddableIndexes.map((i) => texts[i]));
            await client.query("BEGIN");
            try {
              for (let k = 0; k < embeddableIndexes.length; k++) {
                const row = rowsRes.rows[embeddableIndexes[k]];
                const vector = vectors[k];
                const text = texts[embeddableIndexes[k]];
                if (!vector || vector.length !== RAG_EMBEDDING_DIMENSION) {
                  await client.query("UPDATE testcases SET embedding_status = 'failed', updated_at = now() WHERE id = $1", [row.id]);
                  failed++;
                  continue;
                }
                const contentHash = createHash("sha256").update(text).digest("hex");
                await client.query(
                  `INSERT INTO testcase_embeddings (project_id, testcase_id, content_hash, embedding_model, embedding)
                   VALUES ($1, $2, $3, $4, $5::vector)
                   ON CONFLICT (project_id, testcase_id) DO UPDATE
                     SET content_hash = EXCLUDED.content_hash, embedding_model = EXCLUDED.embedding_model,
                         embedding = EXCLUDED.embedding, updated_at = now()`,
                  [row.project_id, row.id, contentHash, allocation.model, `[${vector.join(",")}]`]
                );
                await client.query(
                  "UPDATE testcases SET embedding_status = 'ready', embedding_content_hash = $2, updated_at = now() WHERE id = $1",
                  [row.id, contentHash]
                );
                embedded++;
              }
              await client.query("COMMIT");
            } catch (err) {
              await client.query("ROLLBACK");
              throw err;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`    batch embeddings call failed for project ${projectId}: ${message}`);
            await client.query(
              `UPDATE testcases SET embedding_status = 'failed', updated_at = now()
               WHERE id = ANY($1::uuid[])`,
              [embeddableIndexes.map((i) => rowsRes.rows[i].id)]
            );
            failed += embeddableIndexes.length;
          }
        }

        const unembeddable = rowsRes.rows.filter((_, i) => !embeddableIndexes.includes(i));
        for (const row of unembeddable) {
          await client.query("UPDATE testcases SET embedding_status = 'unsupported', updated_at = now() WHERE id = $1", [row.id]);
        }

        processed += rowsRes.rows.length;
        if (args.rateLimitMs > 0) await sleep(args.rateLimitMs);
      }
    }

    console.log("");
    if (!args.execute) {
      console.log(
        `DRY RUN summary: ${wouldEmbedRows} row(s) across ${wouldEmbedProjects} project(s) would be embedded today; ` +
          `${wouldStayPendingRows} row(s) across ${wouldStayPendingProjects} project(s) would stay pending (no usable key). ` +
          "No provider calls were made and nothing was written."
      );
    } else {
      console.log(`EXECUTE summary: processed ${processed} row(s), embedded ${embedded}, failed ${failed}, ${apiCalls} embeddings API call(s) made.`);
    }
  } finally {
    if (args.execute) {
      await client.query("SELECT pg_advisory_unlock($1)", [BACKFILL_LOCK_KEY]).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
