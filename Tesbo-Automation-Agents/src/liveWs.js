import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { getRedisClient, getRedisSubscriber } from "./redisClient.js";
import { logError, logInfo } from "./logger.js";

function nowIso() {
  return new Date().toISOString();
}

function sessionIdFromPath(pathname) {
  const match = pathname.match(/^\/internal\/sessions\/([^/]+)\/live\/ws$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function channelName(sessionId) {
  return `${config.redisPrefix}:live:${sessionId}`;
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // no-op
  }
}

export function createLiveWsServer({ server, isAuthorized, getSession }) {
  if (!config.enableWebSocketLiveStream) {
    return { enabled: false };
  }

  const wss = new WebSocketServer({ noServer: true });
  const subscribersBySession = new Map();
  const clientsBySession = new Map();
  const producersBySession = new Map();
  const pingTimers = new Map();

  const attachClient = (sessionId, ws) => {
    const set = clientsBySession.get(sessionId) || new Set();
    set.add(ws);
    clientsBySession.set(sessionId, set);
  };

  const detachClient = (sessionId, ws) => {
    const set = clientsBySession.get(sessionId);
    if (!set) return;
    set.delete(ws);
    if (!set.size) clientsBySession.delete(sessionId);
  };

  const broadcastSession = (sessionId, payload) => {
    const set = clientsBySession.get(sessionId);
    if (!set || !set.size) return;
    for (const ws of set) safeSend(ws, payload);
  };

  const ensureRedisSubscription = async (sessionId) => {
    if (subscribersBySession.has(sessionId)) return;
    const subscriber = await getRedisSubscriber();
    if (!subscriber) return;
    const channel = channelName(sessionId);
    await subscriber.subscribe(channel, (message) => {
      try {
        const payload = JSON.parse(message);
        broadcastSession(sessionId, payload);
      } catch {
        // no-op
      }
    });
    subscribersBySession.set(sessionId, true);
  };

  const publishLivePayload = async (sessionId, payload) => {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.publish(channelName(sessionId), JSON.stringify(payload));
  };

  const stopProducer = (sessionId) => {
    const timer = producersBySession.get(sessionId);
    if (timer) clearInterval(timer);
    producersBySession.delete(sessionId);
  };

  const ensureProducer = (sessionId) => {
    if (producersBySession.has(sessionId)) return;
    const intervalMs = 220;
    const timer = setInterval(async () => {
      const hasClients = (clientsBySession.get(sessionId)?.size || 0) > 0;
      if (!hasClients) {
        stopProducer(sessionId);
        return;
      }
      const session = getSession(sessionId);
      if (!session?.page) return;
      try {
        const buffer = await session.page.screenshot({ type: "jpeg", quality: 55 });
        session.currentUrl = session.page.url();
        session.updatedAt = nowIso();
        const payload = {
          type: "frame",
          ts: nowIso(),
          sessionId,
          currentUrl: session.currentUrl,
          imageBase64: buffer.toString("base64"),
          contentType: "image/jpeg",
        };
        broadcastSession(sessionId, payload);
        await publishLivePayload(sessionId, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("ws_live_frame_failed", { sessionId, error: message });
      }
    }, intervalMs);
    producersBySession.set(sessionId, timer);
  };

  server.on("upgrade", async (request, socket, head) => {
    try {
      const reqUrl = new URL(request.url || "/", "http://127.0.0.1");
      const sessionId = sessionIdFromPath(reqUrl.pathname);
      if (!sessionId) return;
      if (!isAuthorized(request, reqUrl)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, sessionId, reqUrl);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", async (ws, _request, sessionId, reqUrl) => {
    attachClient(sessionId, ws);
    await ensureRedisSubscription(sessionId).catch(() => {});
    ensureProducer(sessionId);
    safeSend(ws, { type: "connected", ts: nowIso(), sessionId });

    const timer = setInterval(() => {
      if (ws.readyState !== 1) return;
      safeSend(ws, { type: "heartbeat", ts: nowIso() });
      try {
        ws.ping();
      } catch {
        // no-op
      }
    }, Math.max(3000, config.websocketHeartbeatMs || 15000));
    pingTimers.set(ws, timer);

    ws.on("pong", () => {
      ws.__lastPongAt = Date.now();
    });
    ws.__lastPongAt = Date.now();

    ws.on("message", async (raw) => {
      try {
        const parsed = JSON.parse(String(raw || "{}"));
        if (!parsed || typeof parsed !== "object") return;
        if (parsed.type === "manualAction") {
          const payload = {
            type: "manualActionEcho",
            ts: nowIso(),
            sessionId,
            action: parsed.action || {},
          };
          broadcastSession(sessionId, payload);
          await publishLivePayload(sessionId, payload);
          return;
        }
        if (parsed.type === "resumeAi") {
          const payload = {
            type: "resumeAiAck",
            ts: nowIso(),
            sessionId,
            objective: String(parsed.objective || ""),
          };
          broadcastSession(sessionId, payload);
          await publishLivePayload(sessionId, payload);
          return;
        }
      } catch {
        // no-op
      }
    });

    ws.on("close", () => {
      const t = pingTimers.get(ws);
      if (t) clearInterval(t);
      pingTimers.delete(ws);
      detachClient(sessionId, ws);
      if (!clientsBySession.get(sessionId)?.size) {
        stopProducer(sessionId);
      }
    });

    const idleTimer = setInterval(() => {
      const idleMs = Date.now() - (ws.__lastPongAt || 0);
      if (idleMs > Math.max(15000, config.websocketClientIdleTimeoutMs || 90000)) {
        try {
          ws.close(1001, "Idle timeout");
        } catch {
          // no-op
        }
      }
    }, 10000);
    ws.on("close", () => clearInterval(idleTimer));

    if (reqUrl?.searchParams?.get("bootstrap") === "state") {
      const session = getSession(sessionId);
      safeSend(ws, {
        type: "state",
        ts: nowIso(),
        sessionId,
        currentUrl: session?.currentUrl || "",
      });
    }
  });

  logInfo("ws_live_stream_enabled", {});
  return { enabled: true, wss };
}

