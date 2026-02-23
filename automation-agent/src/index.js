import express from "express";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";
import {
  createSession,
  executeSteps,
  sessionState,
  closeSession,
  startCleanupWatchdog,
} from "./sessionStore.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

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
  res.json({ status: "ok", service: "automation-agent" });
});

app.post("/internal/sessions", async (req, res) => {
  const { sessionId, startUrl } = req.body || {};
  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }
  try {
    await createSession(sessionId, typeof startUrl === "string" ? startUrl : null);
    res.status(201).json({ sessionId });
  } catch (err) {
    logError("create_session_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create session" });
  }
});

app.post("/internal/sessions/:sessionId/execute", async (req, res) => {
  const { sessionId } = req.params;
  const { commandId, steps } = req.body || {};
  if (!commandId || !Array.isArray(steps) || steps.length === 0) {
    res.status(400).json({ error: "commandId and steps are required" });
    return;
  }
  try {
    const result = await executeSteps(sessionId, commandId, steps);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Execution failed" });
  }
});

app.get("/internal/sessions/:sessionId/state", (req, res) => {
  const state = sessionState(req.params.sessionId);
  if (!state) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(state);
});

app.post("/internal/sessions/:sessionId/close", async (req, res) => {
  await closeSession(req.params.sessionId);
  res.status(204).send();
});

app.use((err, _req, res, _next) => {
  logError("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  startCleanupWatchdog();
  logInfo("automation_agent_started", { port: config.port, headless: config.headless });
});
