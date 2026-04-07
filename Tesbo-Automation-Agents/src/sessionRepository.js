import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getRedisClient } from "./redisClient.js";
import { logError } from "./logger.js";

function nowIso() {
  return new Date().toISOString();
}

function parseJson(raw, fallback = null) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

class MemorySessionRepository {
  constructor() {
    this.runtimeSessions = new Map();
    this.meta = new Map();
    this.locks = new Map();
  }

  getRuntimeSession(sessionId) {
    return this.runtimeSessions.get(sessionId) || null;
  }

  setRuntimeSession(sessionId, session) {
    this.runtimeSessions.set(sessionId, session);
  }

  removeRuntimeSession(sessionId) {
    this.runtimeSessions.delete(sessionId);
    this.meta.delete(sessionId);
    this.locks.delete(sessionId);
  }

  listRuntimeSessions() {
    return Array.from(this.runtimeSessions.entries());
  }

  async getSessionMeta(sessionId) {
    return this.meta.get(sessionId) || null;
  }

  async upsertSessionMeta(sessionId, patch = {}) {
    const current = this.meta.get(sessionId) || {
      id: sessionId,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const next = {
      ...current,
      ...patch,
      id: sessionId,
      updatedAt: nowIso(),
    };
    this.meta.set(sessionId, next);
    return next;
  }

  async heartbeat(sessionId, patch = {}) {
    return this.upsertSessionMeta(sessionId, {
      ...patch,
      heartbeatAt: nowIso(),
    });
  }

  async touchSessionTtl(_sessionId) {}

  async acquireSessionLock(sessionId, ownerId, ttlMs) {
    const now = Date.now();
    const cur = this.locks.get(sessionId);
    if (cur && cur.expiresAt > now && cur.ownerId !== ownerId) return false;
    this.locks.set(sessionId, {
      ownerId,
      token: randomUUID(),
      expiresAt: now + Math.max(1000, ttlMs || config.redisLockTtlMs),
    });
    return true;
  }

  async renewSessionLock(sessionId, ownerId, ttlMs) {
    const cur = this.locks.get(sessionId);
    if (!cur || cur.ownerId !== ownerId) return false;
    cur.expiresAt = Date.now() + Math.max(1000, ttlMs || config.redisLockTtlMs);
    this.locks.set(sessionId, cur);
    return true;
  }

  async releaseSessionLock(sessionId, ownerId) {
    const cur = this.locks.get(sessionId);
    if (cur && cur.ownerId !== ownerId) return false;
    this.locks.delete(sessionId);
    return true;
  }
}

class RedisSessionRepository extends MemorySessionRepository {
  keySession(sessionId) {
    return `${config.redisPrefix}:session:${sessionId}`;
  }
  keyLock(sessionId) {
    return `${config.redisPrefix}:lock:${sessionId}`;
  }
  keyEvents(sessionId) {
    return `${config.redisPrefix}:events:${sessionId}`;
  }

  async getClient() {
    return getRedisClient();
  }

  async getSessionMeta(sessionId) {
    const local = await super.getSessionMeta(sessionId);
    const client = await this.getClient();
    if (!client) return local;
    const raw = await client.get(this.keySession(sessionId));
    return parseJson(raw, local);
  }

  async upsertSessionMeta(sessionId, patch = {}) {
    const next = await super.upsertSessionMeta(sessionId, patch);
    const client = await this.getClient();
    if (!client) return next;
    const ttl = Math.max(60, config.redisSessionTtlSeconds || 1800);
    await client.set(this.keySession(sessionId), JSON.stringify(next), { EX: ttl });
    return next;
  }

  async heartbeat(sessionId, patch = {}) {
    return this.upsertSessionMeta(sessionId, { ...patch, heartbeatAt: nowIso() });
  }

  async touchSessionTtl(sessionId) {
    const client = await this.getClient();
    if (!client) return;
    await client.expire(this.keySession(sessionId), Math.max(60, config.redisSessionTtlSeconds || 1800));
  }

  async acquireSessionLock(sessionId, ownerId, ttlMs) {
    const client = await this.getClient();
    if (!client) return super.acquireSessionLock(sessionId, ownerId, ttlMs);
    const lockTtl = Math.max(1000, ttlMs || config.redisLockTtlMs);
    const value = JSON.stringify({ ownerId, lockAt: nowIso() });
    const res = await client.set(this.keyLock(sessionId), value, { NX: true, PX: lockTtl });
    return res === "OK";
  }

  async renewSessionLock(sessionId, ownerId, ttlMs) {
    const client = await this.getClient();
    if (!client) return super.renewSessionLock(sessionId, ownerId, ttlMs);
    const key = this.keyLock(sessionId);
    const current = parseJson(await client.get(key), null);
    if (!current || current.ownerId !== ownerId) return false;
    await client.pexpire(key, Math.max(1000, ttlMs || config.redisLockTtlMs));
    return true;
  }

  async releaseSessionLock(sessionId, ownerId) {
    const client = await this.getClient();
    if (!client) return super.releaseSessionLock(sessionId, ownerId);
    const key = this.keyLock(sessionId);
    const current = parseJson(await client.get(key), null);
    if (!current || current.ownerId !== ownerId) return false;
    await client.del(key);
    return true;
  }

  async appendEvent(sessionId, event) {
    const client = await this.getClient();
    if (!client) return;
    const ttl = Math.max(60, config.redisSessionTtlSeconds || 1800);
    await client.rPush(this.keyEvents(sessionId), JSON.stringify(event));
    await client.expire(this.keyEvents(sessionId), ttl);
  }

  async readEvents(sessionId, count = 200) {
    const client = await this.getClient();
    if (!client) return [];
    const total = await client.lLen(this.keyEvents(sessionId));
    if (!total) return [];
    const start = Math.max(0, total - Math.max(1, count));
    const rows = await client.lRange(this.keyEvents(sessionId), start, -1);
    return rows.map((row) => parseJson(row, null)).filter(Boolean);
  }
}

class DualWriteSessionRepository extends RedisSessionRepository {
  async upsertSessionMeta(sessionId, patch = {}) {
    const next = await super.upsertSessionMeta(sessionId, patch);
    return next;
  }
}

let singletonRepository = null;
export function getSessionRepository() {
  if (singletonRepository) return singletonRepository;
  try {
    const mode = String(config.sessionRepositoryMode || "memory").trim().toLowerCase();
    const canRedis = config.enableRedisSessionRepository && config.redisUrl;
    if (canRedis && mode === "redis") {
      singletonRepository = new RedisSessionRepository();
      return singletonRepository;
    }
    if (canRedis && mode === "dual-write") {
      singletonRepository = new DualWriteSessionRepository();
      return singletonRepository;
    }
    singletonRepository = new MemorySessionRepository();
    return singletonRepository;
  } catch (error) {
    logError("session_repository_init_failed", { error: error?.message || String(error) });
    singletonRepository = new MemorySessionRepository();
    return singletonRepository;
  }
}

