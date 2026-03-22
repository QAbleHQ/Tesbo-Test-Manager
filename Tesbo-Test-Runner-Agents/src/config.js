import path from "node:path";
import fs from "node:fs";

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  const map = new Map();
  if (!fs.existsSync(envPath)) return map;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

const DOT_ENV = loadDotEnv();
const SERVICE_ROLE = env("AUTOMATION_SERVICE_ROLE", "all").toLowerCase();
const NORMALIZED_SERVICE_ROLE =
  SERVICE_ROLE === "api" || SERVICE_ROLE === "worker" || SERVICE_ROLE === "all"
    ? SERVICE_ROLE
    : "all";

function env(name, fallback) {
  const fromDotEnv = DOT_ENV.get(name);
  if (fromDotEnv != null && fromDotEnv !== "") return fromDotEnv;
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value;
}

export const config = {
  port: Number(env("PORT", "7410")),
  headless: env("PLAYWRIGHT_HEADLESS", "true") !== "false",
  startUrlTimeoutMs: Number(env("START_URL_TIMEOUT_MS", "60000")),
  screenshotDir: path.resolve(env("SCREENSHOT_DIR", "./artifacts/screenshots")),
  videoDir: path.resolve(env("VIDEO_DIR", "./artifacts/videos")),
  traceDir: path.resolve(env("TRACE_DIR", "./artifacts/traces")),
  recordVideo: env("RECORD_VIDEO", "true") !== "false",
  sharedToken: env("AGENT_SHARED_TOKEN", ""),
  workerId: env("WORKER_ID", `worker-${Math.random().toString(36).slice(2, 10)}`),
  backendBaseUrl: env("BACKEND_BASE_URL", "http://localhost:7000"),
  backendSharedToken: env("AUTOMATION_QUEUE_SHARED_TOKEN", ""),
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  queuePrefix: env("AUTOMATION_QUEUE_PREFIX", "bull"),
  queueName: env("AUTOMATION_QUEUE_NAME", "automation-execution-jobs"),
  queueEnabled: env("AUTOMATION_QUEUE_ENABLED", "true") !== "false",
  queueDefaultRetries: Number(env("AUTOMATION_QUEUE_MAX_RETRIES", "2")),
  queueConcurrency: Number(env("AUTOMATION_QUEUE_CONCURRENCY", "2")),
  queueHeartbeatMs: Number(env("AUTOMATION_QUEUE_HEARTBEAT_MS", "5000")),
  /** BullMQ job timeout (ms); browser/session should close when job fails on timeout. */
  queueJobTimeoutMs: Number(env("AUTOMATION_QUEUE_JOB_TIMEOUT_MS", "900000")),
  serviceRole: NORMALIZED_SERVICE_ROLE,
  enableLambdaTestProvider: env("AUTOMATION_PROVIDER_LAMBDATEST_ENABLED", "false") === "true",
  enableBrowserStackProvider: env("AUTOMATION_PROVIDER_BROWSERSTACK_ENABLED", "false") === "true",
};
