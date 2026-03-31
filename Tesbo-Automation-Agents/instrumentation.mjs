import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tracker = require("@middleware.io/node-apm");

function readDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return new Map();

  const entries = new Map();
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

const dotEnv = readDotEnv();

function env(name, fallback = "") {
  const fromFile = dotEnv.get(name);
  if (fromFile != null && fromFile !== "") return fromFile;
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess !== "") return fromProcess;
  return fallback;
}

const accessToken = env("MW_APM_ACCESS_TOKEN");
if (!accessToken) {
  // Allow startup without APM in local/dev environments.
  console.warn("[middleware-apm] Disabled: MW_APM_ACCESS_TOKEN is not set.");
} else {
  tracker.track({
    serviceName: env("MW_APM_SERVICE_NAME", "tesbo-automation-agents"),
    accessToken,
  });
}
