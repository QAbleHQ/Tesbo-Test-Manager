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
  port: Number(env("PORT", "7400")),
  headless: env("PLAYWRIGHT_HEADLESS", "true") !== "false",
  sessionTtlMs: Number(env("SESSION_TTL_MS", "900000")),
  sessionCreateConcurrency: Number(env("SESSION_CREATE_CONCURRENCY", "2")),
  startUrlTimeoutMs: Number(env("START_URL_TIMEOUT_MS", "60000")),
  screenshotDir: path.resolve(env("SCREENSHOT_DIR", "./artifacts/screenshots")),
  videoDir: path.resolve(env("VIDEO_DIR", "./artifacts/videos")),
  traceDir: path.resolve(env("TRACE_DIR", "./artifacts/traces")),
  /** Use telemetry (step-by-step with LLM) vs full autonomous agent mode. */
  useTelemetry: env("USE_TELEMETRY", "true") === "true",
  /** LangGraph `recursionLimit` for the ReAct agent (each graph step counts; complex flows need more). */
  langchainMaxSteps: Number(env("LANGCHAIN_MAX_STEPS", "100")),
  domSnapshotMaxElements: Number(env("DOM_SNAPSHOT_MAX_ELEMENTS", "120")),
  recordVideo: env("RECORD_VIDEO", "true") !== "false",
  sharedToken: env("AGENT_SHARED_TOKEN", ""),
  serviceRole: NORMALIZED_SERVICE_ROLE,
  enableLambdaTestProvider: env("AUTOMATION_PROVIDER_LAMBDATEST_ENABLED", "false") === "true",
  enableBrowserStackProvider: env("AUTOMATION_PROVIDER_BROWSERSTACK_ENABLED", "false") === "true",
};
