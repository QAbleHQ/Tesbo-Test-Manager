import { Injectable, Logger } from "@nestjs/common";
import { Worker } from "worker_threads";
import * as path from "path";
import { AppConfigService } from "../config/app-config.service";
import { extractHeavyKnowledgeFileText, type HeavyExtractableExt } from "./kb-file-extraction";

// Resolves next to the compiled JS this file itself becomes: __dirname at runtime is dist/legacy in
// production and in local dev alike (nest-cli's default builder compiles to dist/ either way, then
// runs node dist/main.js — there is no ts-node execution of the running server in this project), so
// this path is correct without a build-time constant or an env var.
const WORKER_ENTRY = path.join(__dirname, "kb-file-extraction.worker.js");

type WorkerResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Runs KB upload's heaviest text extraction (XLSX/PDF/DOCX) off the main event loop, so a large
 * upload no longer blocks every other concurrent request on the process — only the uploader's own
 * response, which already waited for this synchronously before this phase, still does.
 *
 * A fresh worker_threads Worker per file (not a long-lived pool of persistent threads — see
 * kb-file-extraction.worker.ts's own comment on why), bounded to at most
 * config.kbExtractionWorkerPoolSize concurrent workers via a simple counting semaphore; requests
 * beyond that cap queue in FIFO order rather than spawning unboundedly.
 *
 * Every failure mode degrades to a result LegacyService.extractKnowledgeFileText already knows how
 * to handle (null, or a synchronous inline computation) — never a hang, never an unhandled
 * rejection, never worse than this method's own inline fallback.
 */
@Injectable()
export class KbExtractionRunnerService {
  private readonly logger = new Logger(KbExtractionRunnerService.name);
  private activeWorkers = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly config: AppConfigService) {}

  async extract(buffer: Buffer, ext: HeavyExtractableExt, textLimit: number): Promise<string | null> {
    if (!this.config.kbExtractionWorkerThreadsEnabled) {
      return this.extractInline(buffer, ext, textLimit);
    }

    await this.acquireSlot();
    try {
      return await this.runInWorker(buffer, ext, textLimit);
    } catch (err) {
      // The worker itself failed to spawn or crashed before responding (not a parse failure inside
      // it, which the worker already turns into { ok: false } rather than throwing) — degrade to
      // exactly the pre-worker-threads behavior rather than losing the file's text entirely.
      this.logger.warn(
        `KB extraction worker unavailable for .${ext}, falling back to inline extraction: ${err instanceof Error ? err.message : err}`
      );
      // Must be awaited, not just returned: this runs inside a try/catch whose `finally` releases
      // the concurrency slot immediately once this block finishes — an un-awaited return would free
      // the slot before the inline extraction actually completes, defeating the pool bound in
      // exactly the failure mode (workers crashing systemically) it exists to contain.
      return await this.extractInline(buffer, ext, textLimit);
    } finally {
      this.releaseSlot();
    }
  }

  private async extractInline(buffer: Buffer, ext: HeavyExtractableExt, textLimit: number): Promise<string | null> {
    try {
      return await extractHeavyKnowledgeFileText(buffer, ext, textLimit);
    } catch (err) {
      this.logger.warn(`KB inline extraction failed for .${ext}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.activeWorkers < Math.max(1, this.config.kbExtractionWorkerPoolSize)) {
      this.activeWorkers += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.activeWorkers += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeWorkers -= 1;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private runInWorker(buffer: Buffer, ext: HeavyExtractableExt, textLimit: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_ENTRY, { workerData: { buffer, ext, textLimit } });
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.logger.warn(`KB extraction worker timed out for .${ext} after ${this.config.kbExtractionTimeoutMs}ms — terminating it`);
        worker.terminate().catch(() => undefined);
        // A timeout is a strict new protection this codebase had no defense against before (a
        // pathological file could hang the whole process) — resolve to "no extractable text" rather
        // than retrying inline, which would just reproduce the same hang on the main thread.
        resolve(null);
      }, this.config.kbExtractionTimeoutMs);

      const finish = () => {
        settled = true;
        clearTimeout(timeout);
        worker.terminate().catch(() => undefined);
      };

      worker.once("message", (message: WorkerResult) => {
        if (settled) return;
        finish();
        if (message.ok) {
          resolve(message.text);
        } else {
          this.logger.warn(`KB extraction worker reported a failure for .${ext}: ${message.error}`);
          resolve(null);
        }
      });

      worker.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      worker.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`KB extraction worker exited with code ${code} before responding`));
      });
    });
  }
}
