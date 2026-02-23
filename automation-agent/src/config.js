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
  sharedToken: env("AGENT_SHARED_TOKEN", ""),
};
