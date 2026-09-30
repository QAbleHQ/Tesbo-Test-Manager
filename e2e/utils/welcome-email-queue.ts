import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { env } from "./env";
import { literal, scalar } from "./psql";

/*
 * Reading the backend's welcome-email BullMQ queue straight out of Redis.
 *
 * Registration schedules a job delayed until 3 hours after users.created_at. Nothing in the API
 * exposes that job, and no test can wait 3 hours for the email, so these helpers inspect the job
 * where BullMQ keeps it — the `bull:welcome-email:<jobId>` hash and the queue's `delayed` sorted
 * set — via `docker compose exec redis redis-cli`, the same transport utils/backend-logs.ts uses.
 * No bullmq dependency is added to the suite for this; the key layout is BullMQ's default prefix
 * ("bull"), which app.module.ts does not override.
 *
 * Best-effort like backend-logs.ts: null/false when docker can't be reached, so callers can skip.
 */

const QUEUE_KEY = "bull:welcome-email";

export function welcomeJobId(userId: string): string {
  return `welcome-${userId}`;
}

function redis(...args: string[]): string | null {
  try {
    return execFileSync(
      "docker",
      ["compose", "-f", env.dockerComposeFile, "exec", "-T", "redis", "redis-cli", ...args],
      { encoding: "utf-8" },
    );
  } catch {
    return null;
  }
}

export function welcomeQueueAvailable(): boolean {
  return redis("PING")?.trim() === "PONG";
}

export interface WelcomeJob {
  name: string;
  data: { userId?: string } & Record<string, unknown>;
  /** Raw JSON of the job's `data`, for asserting what does NOT travel through Redis. */
  rawData: string;
  /** When the job was added (ms since epoch). */
  timestamp: number;
  delay: number;
  /** timestamp + delay: when BullMQ will run it. */
  firesAt: number;
  /** Whether the job is in the queue's delayed set, i.e. still waiting rather than run or failed. */
  isDelayed: boolean;
}

/** The welcome-email job for this user, or null if there is none. */
export function readWelcomeJob(userId: string): WelcomeJob | null {
  const id = welcomeJobId(userId);
  const out = redis("HGETALL", `${QUEUE_KEY}:${id}`);
  if (!out?.trim()) return null;
  // Non-tty redis-cli prints HGETALL as alternating field / value lines; BullMQ's values are
  // single-line (JSON is stored compact), so pairing lines is safe.
  const lines = out.replace(/\r/g, "").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const hash: Record<string, string> = {};
  for (let i = 0; i + 1 < lines.length; i += 2) hash[lines[i]] = lines[i + 1];
  if (!hash.name) return null;
  const timestamp = Number(hash.timestamp);
  const delay = Number(hash.delay ?? JSON.parse(hash.opts ?? "{}").delay ?? 0);
  return {
    name: hash.name,
    data: JSON.parse(hash.data ?? "{}"),
    rawData: hash.data ?? "",
    timestamp,
    delay,
    firesAt: timestamp + delay,
    isDelayed: (redis("ZSCORE", `${QUEUE_KEY}:delayed`, id) ?? "").trim() !== "",
  };
}

/** users.created_at in ms since epoch, from the `.env` database. */
export function userCreatedAtMs(userId: string): number {
  return Number(scalar(`SELECT floor(extract(epoch FROM created_at) * 1000)::bigint FROM users WHERE id = ${literal(userId)};`));
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
// Room for clock skew between the hosted database (which stamps created_at) and the backend
// container (which stamps the job), not for any slack in the product's own arithmetic.
const CLOCK_SKEW_MS = 60_000;

/**
 * Asserts the user has exactly the welcome job the ticket calls for: waiting in the delayed set,
 * carrying only the user id (no recipient address in Redis), due 3 hours after users.created_at.
 */
export function expectWelcomeJobScheduled(userId: string): WelcomeJob {
  const job = readWelcomeJob(userId);
  expect(job, `no welcome-email job was scheduled for user ${userId}`).not.toBeNull();
  expect(job!.name).toBe("welcome-email-send");
  expect(job!.data).toEqual({ userId });
  expect(job!.rawData, "the job must not carry an email address").not.toContain("@");
  expect(job!.isDelayed, "the welcome job is not waiting in the delayed set").toBe(true);
  // Enqueued within moments of registering, so the delay itself is (just under) 3 hours...
  expect(job!.delay).toBeGreaterThan(THREE_HOURS_MS - 5 * 60_000);
  expect(job!.delay).toBeLessThanOrEqual(THREE_HOURS_MS);
  // ...and, the actual requirement, it fires 3 hours after the registration time.
  const expected = userCreatedAtMs(userId) + THREE_HOURS_MS;
  expect(Math.abs(job!.firesAt - expected), "the welcome job is not due 3h after users.created_at").toBeLessThan(CLOCK_SKEW_MS);
  return job!;
}

/**
 * Teardown: removes this user's pending welcome job, so a test account doesn't get a welcome email
 * sent three hours after the run. (The job would skip a deleted user anyway; many fixtures are
 * detached rather than deleted, so this is what actually keeps the inbox quiet.)
 */
export function removeWelcomeJob(userId: string | null | undefined): void {
  if (!userId) return;
  const id = welcomeJobId(userId);
  redis("ZREM", `${QUEUE_KEY}:delayed`, id);
  redis("DEL", `${QUEUE_KEY}:${id}`, `${QUEUE_KEY}:${id}:logs`);
}
