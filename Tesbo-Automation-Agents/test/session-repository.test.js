import test from "node:test";
import assert from "node:assert/strict";
import { getSessionRepository } from "../src/sessionRepository.js";

test("session repository lock lifecycle works", async () => {
  const repo = getSessionRepository();
  const sessionId = `test-session-${Date.now()}`;
  const ownerA = "owner-a";
  const ownerB = "owner-b";

  const acquiredA = await repo.acquireSessionLock(sessionId, ownerA, 3000);
  assert.equal(acquiredA, true);

  const acquiredB = await repo.acquireSessionLock(sessionId, ownerB, 3000);
  assert.equal(acquiredB, false);

  const renewed = await repo.renewSessionLock(sessionId, ownerA, 3000);
  assert.equal(renewed, true);

  const released = await repo.releaseSessionLock(sessionId, ownerA);
  assert.equal(released, true);

  const acquiredBAfterRelease = await repo.acquireSessionLock(sessionId, ownerB, 3000);
  assert.equal(acquiredBAfterRelease, true);
});

test("session repository stores metadata heartbeat", async () => {
  const repo = getSessionRepository();
  const sessionId = `test-session-meta-${Date.now()}`;

  await repo.upsertSessionMeta(sessionId, { status: "starting", currentUrl: "https://example.com" });
  const initial = await repo.getSessionMeta(sessionId);
  assert.equal(initial.status, "starting");
  assert.equal(initial.currentUrl, "https://example.com");

  await repo.heartbeat(sessionId, { status: "active" });
  const updated = await repo.getSessionMeta(sessionId);
  assert.equal(updated.status, "active");
  assert.ok(updated.heartbeatAt);
});
