import express from "express";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";
import {
  getSession,
  createSession,
  resetSession,
  executeSteps,
  executeAgent,
  manualAction,
  runPlaywrightScript,
  runPlaywrightScriptInSession,
  sessionState,
  closeSession,
  startCleanupWatchdog,
  SessionCreationError,
} from "./sessionStore.js";

const app = express();
app.use(express.json({ limit: "8mb" }));

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
    service: "tesbo-automation-agents",
    role: config.serviceRole,
  });
});

app.post("/internal/sessions", async (req, res) => {
  const {
    sessionId,
    startUrl,
    modelProvider,
    modelApiKey,
    model,
  } = req.body || {};
  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }
  const options = {};
  if (modelApiKey) {
    options.modelProvider = modelProvider || "openai";
    options.modelApiKey = modelApiKey;
    options.model = model;
  }
  try {
    const state = await createSession(sessionId, typeof startUrl === "string" ? startUrl : null, options);
    res.status(201).json({
      sessionId,
      sessionType: state?.type === "agent" ? "agent" : "playwright",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SessionCreationError ? err.code : "SESSION_CREATION_FAILED";
    logError("create_session_failed", { error: message, code });
    if (code === "SESSION_CREATION_CAPACITY_REACHED") {
      res.status(429).json({ error: message, code });
      return;
    }
    res.status(500).json({ error: "Failed to create session", code, message });
  }
});

app.post("/internal/sessions/:sessionId/reset", async (req, res) => {
  const { sessionId } = req.params;
  const { startUrl } = req.body || {};
  try {
    const result = await resetSession(sessionId, typeof startUrl === "string" ? startUrl : null);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Session reset failed" });
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

app.post("/internal/sessions/:sessionId/execute-agent", async (req, res) => {
  const { sessionId } = req.params;
  const { commandId, objective, useTelemetry } = req.body || {};
  if (!commandId || !objective || typeof objective !== "string") {
    res.status(400).json({ error: "commandId and objective are required" });
    return;
  }
  try {
    const result = await executeAgent(sessionId, commandId, objective.trim(), {
      useTelemetry: typeof useTelemetry === "boolean" ? useTelemetry : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Agent execution failed" });
  }
});

app.post("/internal/playwright/run", async (req, res) => {
  const {
    executionId,
    script,
    startUrl,
  } = req.body || {};
  if (!executionId || !script) {
    res.status(400).json({ error: "executionId and script are required" });
    return;
  }
  try {
    const result = await runPlaywrightScript(String(executionId), String(script), typeof startUrl === "string" ? startUrl : null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Playwright run failed" });
  }
});

app.post("/internal/sessions/:sessionId/run-script", async (req, res) => {
  const { sessionId } = req.params;
  const {
    executionId,
    script,
    startUrl,
    actionDelayMs,
  } = req.body || {};
  if (!executionId || !script) {
    res.status(400).json({ error: "executionId and script are required" });
    return;
  }
  try {
    const result = await runPlaywrightScriptInSession(
      sessionId,
      String(executionId),
      String(script),
      typeof startUrl === "string" ? startUrl : null,
      Number.isFinite(Number(actionDelayMs)) ? Number(actionDelayMs) : 0
    );
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Session script run failed" });
  }
});

app.post("/internal/sessions/:sessionId/manual-action", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const result = await manualAction(sessionId, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Manual action failed" });
  }
});

app.get("/internal/sessions/:sessionId/state", async (req, res) => {
  const state = await sessionState(req.params.sessionId);
  if (!state) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(state);
});

app.get("/internal/sessions/:sessionId/live", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
  });

  let cancelled = false;
  let busy = false;
  let streamClosed = false;
  let timer = null;
  req.on("close", () => {
    cancelled = true;
  });

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    cancelled = true;
    if (timer) clearInterval(timer);
    try {
      res.end();
    } catch {
      // no-op
    }
  };

  const writeFrame = async () => {
    if (cancelled || busy || streamClosed) return;
    const activeSession = getSession(sessionId);
    if (!activeSession?.page) {
      closeStream();
      return;
    }
    busy = true;
    try {
      const buffer = await activeSession.page.screenshot({ type: "jpeg", quality: 55 });
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write("\r\n");
      activeSession.currentUrl = activeSession.page.url();
      activeSession.updatedAt = new Date().toISOString();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const normalizedMessage = message.toLowerCase();
      const closedContext =
        message.includes("Target page, context or browser has been closed") ||
        message.includes("Target closed") ||
        normalizedMessage.includes("session with given id not found");
      if (!closedContext) {
        logError("live_frame_failed", { error: message });
      }
      if (closedContext) {
        closeStream();
      }
    } finally {
      busy = false;
    }
  };

  const intervalMs = 180;
  timer = setInterval(() => {
    void writeFrame();
  }, intervalMs);
  void writeFrame();

  req.on("close", () => {
    closeStream();
  });
});

app.get("/internal/sessions/:sessionId/recording", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  const recorder = session.recorder;
  const browserRecorder = session.browserRecorder;
  if (!recorder && !browserRecorder) {
    return res.json({
      sessionId,
      hasRecording: false,
      message: "No active recording for this session",
    });
  }
  const response = {
    sessionId,
    hasRecording: true,
  };

  if (browserRecorder) {
    response.summary = browserRecorder.getSummary();
    response.actions = browserRecorder.getActions();
    response.partialScript = browserRecorder.toPlaywrightScript();
  }

  if (recorder) {
    response.agentMetadata = {
      summary: recorder.getSummary(),
      actions: recorder.getActions(),
      reasoningLog: recorder.getReasoningLog(),
    };
  }
  res.json(response);
});

app.post("/internal/sessions/:sessionId/recording/compile", async (req, res) => {
  const { sessionId } = req.params;
  const { scenario, addHeader } = req.body || {};
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  const browserRecorder = session.browserRecorder;
  if (!browserRecorder) {
    return res.status(404).json({ error: "No browser recording found for this session" });
  }
  if (browserRecorder.isRunning) {
    browserRecorder.stop();
  }
  const script = browserRecorder.toPlaywrightScript({
    testName: scenario || undefined,
    addHeader: addHeader !== false,
  });
  res.json({
    sessionId,
    script,
    summary: browserRecorder.getSummary(),
    recording: browserRecorder.toJSON(),
  });
});

app.post("/internal/sessions/:sessionId/close", async (req, res) => {
  const result = await closeSession(req.params.sessionId);
  res.json(result || { videoPath: null });
});

app.use((err, _req, res, _next) => {
  logError("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  startCleanupWatchdog();
  logInfo("automation_agent_started", {
    port: config.port,
    headless: config.headless,
    role: config.serviceRole,
  });
});
