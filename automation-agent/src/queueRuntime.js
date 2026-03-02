import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { runExecutionWithProvider } from "./providers/index.js";

const cancelledRuns = new Map();
let connectionRef = null;
let queueRef = null;

function callbackHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.backendSharedToken) {
    headers["x-automation-token"] = config.backendSharedToken;
  }
  return headers;
}

async function notifyBackend(path, payload) {
  const response = await fetch(`${config.backendBaseUrl}${path}`, {
    method: "POST",
    headers: callbackHeaders(),
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`callback failed (${response.status}): ${body}`);
  }
}

function ensureQueue() {
  if (!config.queueEnabled) {
    throw new Error("Automation queue is disabled");
  }
  if (!connectionRef) {
    connectionRef = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  if (!queueRef) {
    queueRef = new Queue(config.queueName, { connection: connectionRef });
  }
  return queueRef;
}

function rememberCancelledRun(runId) {
  cancelledRuns.set(String(runId), Date.now());
}

function isCancelledRun(runId) {
  const key = String(runId);
  const at = cancelledRuns.get(key);
  if (!at) return false;
  const ttlMs = 60 * 60 * 1000;
  if (Date.now() - at > ttlMs) {
    cancelledRuns.delete(key);
    return false;
  }
  return true;
}

function pruneCancelledRuns() {
  const ttlMs = 60 * 60 * 1000;
  const now = Date.now();
  for (const [runId, at] of cancelledRuns.entries()) {
    if (now - at > ttlMs) cancelledRuns.delete(runId);
  }
}

function startHeartbeatLoop(jobId) {
  const intervalMs = Math.max(1000, Number(config.queueHeartbeatMs || 5000));
  const timer = setInterval(() => {
    void notifyBackend(`/api/internal/automation/jobs/${jobId}/heartbeat`, {
      workerId: config.workerId,
    }).catch((error) => {
      logError("queue_job_heartbeat_failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export async function enqueueExecutionJob(payload) {
  const queue = ensureQueue();
  const maxRetries = Number.isFinite(Number(payload.maxRetries))
    ? Number(payload.maxRetries)
    : config.queueDefaultRetries;
  const job = await queue.add("execution", payload, {
    jobId: payload.jobId,
    attempts: Math.max(1, maxRetries + 1),
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
  return { queueJobId: String(job.id), state: "queued" };
}

export async function cancelRun(runId) {
  const queue = ensureQueue();
  rememberCancelledRun(runId);
  pruneCancelledRuns();
  const jobs = await queue.getJobs(["waiting", "delayed", "active"], 0, 1000);
  for (const job of jobs) {
    if (String(job.data?.runId) !== String(runId)) continue;
    if ((await job.getState()) === "active") continue;
    await job.remove();
  }
}

export async function queueStats() {
  const queue = ensureQueue();
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "paused"
  );
  return {
    queueName: config.queueName,
    workerId: config.workerId,
    ...counts,
  };
}

let workerRef = null;

export function startQueueWorker() {
  if (!config.queueEnabled) {
    logInfo("queue_worker_disabled", { queueName: config.queueName });
    return null;
  }
  if (workerRef) return workerRef;
  ensureQueue();
  workerRef = new Worker(
    config.queueName,
    async (job) => {
      const data = job.data || {};
      const attempt = Number(job.attemptsMade ?? 0);
      const runId = String(data.runId || "");
      const jobId = String(data.jobId || "");
      if (!jobId) throw new Error("jobId missing in queue payload");
      if (isCancelledRun(runId)) {
        await notifyBackend(`/api/internal/automation/jobs/${jobId}/fail`, {
          errorMessage: "Run cancelled",
          willRetry: false,
          attempt,
        });
        return { status: "cancelled" };
      }
      await notifyBackend(`/api/internal/automation/jobs/${jobId}/start`, {
        workerId: config.workerId,
        attempt,
      });
      const stopHeartbeat = startHeartbeatLoop(jobId);
      try {
        const startedAt = new Date().toISOString();
        await notifyBackend(`/api/internal/automation/jobs/${jobId}/heartbeat`, { workerId: config.workerId });
        const result = await runExecutionWithProvider(data);
        await notifyBackend(`/api/internal/automation/jobs/${jobId}/complete`, {
          status: result?.status || "failed",
          startedAt,
          errorMessage: result?.errorMessage || null,
          logs: Array.isArray(result?.logs) ? result.logs : [],
          videoPath: result?.videoPath || null,
          screenshotPath: result?.screenshotPath || null,
          tracePath: result?.tracePath || null,
          attempt,
        });
        return { status: result?.status || "failed" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const willRetry = attempt + 1 < Number(job.opts.attempts || 1);
        await notifyBackend(`/api/internal/automation/jobs/${jobId}/fail`, {
          errorMessage: message,
          willRetry,
          attempt,
        });
        throw error;
      } finally {
        stopHeartbeat();
      }
    },
    {
      connection: connectionRef,
      concurrency: Math.max(1, config.queueConcurrency),
    }
  );

  workerRef.on("failed", (job, err) => {
    logError("queue_job_failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err?.message || String(err),
    });
  });

  workerRef.on("completed", (job) => {
    logInfo("queue_job_completed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
    });
  });

  logInfo("queue_worker_started", {
    queueName: config.queueName,
    workerId: config.workerId,
    concurrency: config.queueConcurrency,
  });
  return workerRef;
}

