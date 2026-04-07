import { createClient } from "redis";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";

let redisClient = null;
let redisSubscriber = null;
let connectPromise = null;

function canUseRedis() {
  return Boolean(config.redisUrl && config.redisUrl.trim());
}

async function connectRedisClient(client) {
  if (client.isOpen) return client;
  await client.connect();
  return client;
}

export async function getRedisClient() {
  if (!canUseRedis()) return null;
  if (redisClient?.isOpen) return redisClient;
  if (connectPromise) return connectPromise;

  redisClient = createClient({
    url: config.redisUrl,
    socket: {
      connectTimeout: Math.max(500, config.redisConnectTimeoutMs || 3000),
    },
  });
  redisClient.on("error", (error) => {
    logError("redis_client_error", { error: error?.message || String(error) });
  });

  connectPromise = connectRedisClient(redisClient)
    .then((client) => {
      logInfo("redis_client_connected", {});
      return client;
    })
    .catch((error) => {
      logError("redis_client_connect_failed", { error: error?.message || String(error) });
      redisClient = null;
      return null;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export async function getRedisSubscriber() {
  if (!canUseRedis()) return null;
  if (redisSubscriber?.isOpen) return redisSubscriber;
  const base = await getRedisClient();
  if (!base) return null;
  redisSubscriber = base.duplicate();
  redisSubscriber.on("error", (error) => {
    logError("redis_subscriber_error", { error: error?.message || String(error) });
  });
  try {
    await connectRedisClient(redisSubscriber);
    return redisSubscriber;
  } catch (error) {
    logError("redis_subscriber_connect_failed", { error: error?.message || String(error) });
    redisSubscriber = null;
    return null;
  }
}

export async function closeRedisClients() {
  const closers = [];
  if (redisSubscriber?.isOpen) closers.push(redisSubscriber.quit().catch(() => {}));
  if (redisClient?.isOpen) closers.push(redisClient.quit().catch(() => {}));
  await Promise.all(closers);
  redisClient = null;
  redisSubscriber = null;
}

