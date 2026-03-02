import path from "node:path";

function env(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value;
}

export const config = {
  port: Number(env("PORT", "7400")),
  headless: env("PLAYWRIGHT_HEADLESS", "true") !== "false",
  sessionTtlMs: Number(env("SESSION_TTL_MS", "900000")),
  screenshotDir: path.resolve(env("SCREENSHOT_DIR", "./artifacts/screenshots")),
  videoDir: path.resolve(env("VIDEO_DIR", "./artifacts/videos")),
  recordVideo: env("RECORD_VIDEO", "true") !== "false",
  sharedToken: env("AGENT_SHARED_TOKEN", ""),
  workerId: env("WORKER_ID", `worker-${Math.random().toString(36).slice(2, 10)}`),
  backendBaseUrl: env("BACKEND_BASE_URL", "http://localhost:7000"),
  backendSharedToken: env("AUTOMATION_QUEUE_SHARED_TOKEN", ""),
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  queueName: env("AUTOMATION_QUEUE_NAME", "automation-execution-jobs"),
  queueEnabled: env("AUTOMATION_QUEUE_ENABLED", "true") !== "false",
  queueDefaultRetries: Number(env("AUTOMATION_QUEUE_MAX_RETRIES", "2")),
  queueConcurrency: Number(env("AUTOMATION_QUEUE_CONCURRENCY", "2")),
};
