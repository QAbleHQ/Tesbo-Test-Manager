import { parentPort, workerData } from "worker_threads";
import { extractHeavyKnowledgeFileText, type HeavyExtractableExt } from "./kb-file-extraction";

/**
 * worker_threads entry point, spawned fresh per file by KbExtractionRunnerService - not a long-lived
 * pool of persistent workers. One job, one exit: simpler to reason about and verify correct than a
 * job-queue/message-correlation protocol over long-lived threads, at the cost of a per-file worker
 * spawn (accepted - see KbExtractionRunnerService's own comment on why that trade was made).
 *
 * Receives its input once via workerData rather than a postMessage, since there is exactly one job.
 * Buffer bytes are passed as a plain (structured-clone-copied) Buffer, not a transferred ArrayBuffer:
 * a Node Buffer can be a view over a POOLED underlying ArrayBuffer shared with unrelated data
 * (Buffer.allocUnsafe's small-allocation pool), and transferring that ArrayBuffer instead of copying
 * it risks corrupting whatever else happens to share that pool. The copy costs a few milliseconds
 * for a multi-MB file - trivial next to the parse time this whole change exists to get off the main
 * thread - and correctness here is not worth trading for it.
 */
async function run(): Promise<void> {
  const { buffer, ext, textLimit } = workerData as { buffer: Buffer; ext: HeavyExtractableExt; textLimit: number };
  try {
    const text = await extractHeavyKnowledgeFileText(Buffer.from(buffer), ext, textLimit);
    parentPort?.postMessage({ ok: true, text });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

void run();
