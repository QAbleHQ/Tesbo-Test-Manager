import express from "express";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";
import {
  enqueueExecutionJob,
  enqueueExecutionJobsBatch,
  startQueueWorker,
  queueStats,
  cancelRun,
} from "./queueRuntime.js";

const app = express();
app.use(express.json({ limit: "8mb" }));

function hasApiRole() {
  return config.serviceRole === "all" || config.serviceRole === "api";
}

function hasWorkerRole() {
  return config.serviceRole === "all" || config.serviceRole === "worker";
}

function isAuthorized(req) {
  if (!config.sharedToken) return true;
  const token = req.header("x-agent-token");
  return token === config.sharedToken;
}

app.use("/internal", (req, res, next) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "test-runner-agents",
    role: config.serviceRole,
    queueEnabled: config.queueEnabled,
  });
});

function normalizeEnqueuePayload(body) {
  const {
    jobId,
    runId,
    cycleId,
    executionId,
    script,
    startUrl,
    maxRetries,
    executionProvider,
    providerPayload,
    shardIndex,
    shardTotal,
    modelProvider,
    modelApiKey,
    model,
    projectId,
  } = body || {};
  if (!jobId || !runId || !cycleId || !executionId || !script) {
    return { error: "jobId, runId, cycleId, executionId, and script are required" };
  }
  return {
    payload: {
      jobId: String(jobId),
      projectId: typeof projectId === "string" ? projectId : "",
      runId: String(runId),
      cycleId: String(cycleId),
      executionId: String(executionId),
      script: String(script),
      startUrl: typeof startUrl === "string" ? startUrl : null,
      maxRetries,
      executionProvider: typeof executionProvider === "string" ? executionProvider : "default",
      providerPayload: providerPayload && typeof providerPayload === "object" ? providerPayload : {},
      shardIndex: Number.isFinite(Number(shardIndex)) ? Number(shardIndex) : 1,
      shardTotal: Number.isFinite(Number(shardTotal)) ? Number(shardTotal) : 1,
      modelProvider: typeof modelProvider === "string" ? modelProvider : "",
      modelApiKey: typeof modelApiKey === "string" ? modelApiKey : "",
      model: typeof model === "string" ? model : "",
    },
  };
}

app.post("/internal/queue/jobs", async (req, res) => {
  if (!hasApiRole()) {
    res.status(503).json({ error: "Queue enqueue API disabled for this service role" });
    return;
  }
  const normalized = normalizeEnqueuePayload(req.body || {});
  if (normalized.error) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  try {
    const queued = await enqueueExecutionJob(normalized.payload);
    res.status(202).json(queued);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Queue enqueue failed" });
  }
});

app.post("/internal/queue/jobs/batch", async (req, res) => {
  if (!hasApiRole()) {
    res.status(503).json({ error: "Queue enqueue API disabled for this service role" });
    return;
  }
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : null;
  if (!jobs || jobs.length === 0) {
    res.status(400).json({ error: "jobs array is required" });
    return;
  }
  const payloads = [];
  for (const body of jobs) {
    const normalized = normalizeEnqueuePayload(body);
    if (normalized.error) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    payloads.push(normalized.payload);
  }
  try {
    const results = await enqueueExecutionJobsBatch(payloads);
    res.status(202).json({ results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Batch queue enqueue failed" });
  }
});

app.post("/internal/queue/runs/:runId/cancel", async (req, res) => {
  if (!hasApiRole()) {
    res.status(503).json({ error: "Queue cancel API disabled for this service role" });
    return;
  }
  try {
    await cancelRun(req.params.runId);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Cancel failed" });
  }
});

app.get("/internal/queue/stats", async (_req, res) => {
  if (!hasApiRole() && !hasWorkerRole()) {
    res.status(503).json({ error: "Queue stats API disabled for this service role" });
    return;
  }
  try {
    res.json(await queueStats());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Queue stats failed" });
  }
});

app.use((err, _req, res, _next) => {
  logError("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  if (hasWorkerRole()) {
    startQueueWorker();
  }
  logInfo("test_runner_agents_started", {
    port: config.port,
    headless: config.headless,
    role: config.serviceRole,
    queueEnabled: config.queueEnabled,
  });
});
