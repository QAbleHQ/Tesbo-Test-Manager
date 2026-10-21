import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CACHE_CLIENT } from "../cache/redis-cache.tokens";
import { AppConfigService } from "../config/app-config.service";

/*
 * Brute-force limits that cannot get in a signed-in or well-behaved user's way.
 *
 * Nothing here counts traffic. It counts FAILURES of things only an attacker repeats: a wrong
 * password, a wrong code, an unknown token, an unknown email. A user who signs in, or whose requests
 * succeed, never touches a counter, and a signed-in user's ordinary traffic is not looked at at all.
 * The caps are set far above anything a person produces (a person mistypes a password a few times; a
 * shared office address still sits well under them), so they only ever trip on a script.
 *
 * Per-account defences (the 5-failure login lockout, the 5-guess budget on an OTP code) stay where they
 * were; this adds the limit those cannot give: one source trying many accounts or many codes.
 *
 * Redis-backed, so the count is shared by every backend instance (blue/green runs two). If Redis is
 * unreachable it falls back to a per-process counter rather than letting the limit lapse, and never
 * fails a request because of it.
 */

export interface RateLimit {
  /** What is counted, for the key and for logs. */
  bucket: string;
  /** Failures (or hits) allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Per-IP limits are scaled by RATE_LIMIT_IP_MULTIPLIER; per-account ones are not. */
  perIp: boolean;
}

/** One place for every number, so the policy can be read, reviewed and tested as a table. */
export const LIMITS = {
  /** Wrong password or unknown email on password login, from one address. */
  loginFailuresPerIp: { bucket: "login-fail", limit: 100, windowSeconds: 15 * 60, perIp: true },
  /** Wrong or expired code on login by email code. */
  otpLoginFailuresPerIp: { bucket: "otp-login-fail", limit: 100, windowSeconds: 15 * 60, perIp: true },
  /** Wrong code when finishing a signup or an invite registration. */
  codeFailuresPerIp: { bucket: "code-fail", limit: 100, windowSeconds: 15 * 60, perIp: true },
  /** Reset links that do not exist or are used up: someone guessing tokens. */
  resetTokenFailuresPerIp: { bucket: "reset-token-fail", limit: 100, windowSeconds: 15 * 60, perIp: true },
  /** Forgot-password for an address with no account: someone testing which emails are registered. */
  forgotUnknownPerIp: { bucket: "forgot-unknown", limit: 50, windowSeconds: 60 * 60, perIp: true },
  /**
   * Reset emails to ONE address from ONE source: stops a script mail-bombing a victim. Keyed by email AND
   * address on purpose, so someone else asking for the same email cannot use up the owner's allowance.
   */
  forgotPerEmailPerIp: { bucket: "forgot-email-ip", limit: 10, windowSeconds: 60 * 60, perIp: false },
  /** The same across every source: a safety valve for a distributed mail-bomb, far above any real owner. */
  forgotPerEmail: { bucket: "forgot-email", limit: 60, windowSeconds: 60 * 60, perIp: false },
  /** Code emails requested from one address: stops mail-bombing many victims from one place. */
  otpRequestsPerIp: { bucket: "otp-request", limit: 600, windowSeconds: 60 * 60, perIp: true },
  /** A signed-in user typing the wrong current password to change it: a stolen session guessing the password. */
  changePasswordFailuresPerUser: { bucket: "change-password-fail", limit: 10, windowSeconds: 15 * 60, perIp: false },
  /** Bearer tokens that do not exist or have expired, from one address. A misconfigured CI sits well under this. */
  badTokensPerIp: { bucket: "bad-token", limit: 600, windowSeconds: 10 * 60, perIp: true }
} satisfies Record<string, RateLimit>;

export class RateLimitedException extends HttpException {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      {
        error: `Too many attempts. Try again in ${retryAfterSeconds < 90 ? "a minute" : `${Math.ceil(retryAfterSeconds / 60)} minutes`}.`,
        code: "rate_limited",
        retryAfterSeconds
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}

/**
 * The key for an address. IPv4-mapped IPv6 is folded to its IPv4 form, and an IPv6 address is
 * counted as its /64, because one subscriber is handed a whole /64 and rotates addresses inside it.
 */
export function clientKey(ip: string | undefined | null): string {
  const raw = String(ip ?? "").trim().toLowerCase();
  if (!raw) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (raw.includes(":")) {
    const groups = raw.split("::")[0].split(":").filter(Boolean);
    return `${groups.slice(0, 4).join(":")}::/64`;
  }
  return raw;
}

interface Counter {
  count: number;
  resetsAt: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly local = new Map<string, Counter>();

  constructor(
    @Inject(REDIS_CACHE_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService
  ) {}

  private cap(limit: RateLimit): number {
    if (!limit.perIp) return limit.limit;
    // A multiplier that is not a number, or is below 1, must mean "no scaling", never "no limit": a NaN
    // cap compares false against every count and would silently switch the limit off.
    const multiplier = this.config.rateLimitIpMultiplier;
    return limit.limit * (Number.isFinite(multiplier) && multiplier >= 1 ? Math.floor(multiplier) : 1);
  }

  private redisKey(limit: RateLimit, key: string): string {
    return `rl:${limit.bucket}:${key}`;
  }

  /** Throws 429 if `key` has already used up its failures for this window. Reads only: costs a successful caller nothing. */
  async assertAllowed(limit: RateLimit, key: string): Promise<void> {
    if (!this.config.rateLimitEnabled) return;
    const { count, retryAfterSeconds } = await this.read(limit, key);
    if (count >= this.cap(limit)) throw new RateLimitedException(retryAfterSeconds);
  }

  /** Counts one failure. Never throws. */
  async recordFailure(limit: RateLimit, key: string): Promise<void> {
    if (!this.config.rateLimitEnabled) return;
    await this.increment(limit, key);
  }

  /** For a thing limited by how often it happens, not by how it ends: counts it, and throws once over the cap. */
  async hit(limit: RateLimit, key: string): Promise<void> {
    if (!this.config.rateLimitEnabled) return;
    const { count, retryAfterSeconds } = await this.increment(limit, key);
    if (count > this.cap(limit)) throw new RateLimitedException(retryAfterSeconds);
  }

  private async read(limit: RateLimit, key: string): Promise<{ count: number; retryAfterSeconds: number }> {
    try {
      const redisKey = this.redisKey(limit, key);
      const results = await this.redis.multi().get(redisKey).pttl(redisKey).exec();
      const values = (results ?? []).map(([err, value]) => {
        if (err) throw err;
        return value;
      });
      const count = values[0] === null || values[0] === undefined ? 0 : Number(values[0]) || 0;
      const ttlMs = Number(values[1]);
      return { count, retryAfterSeconds: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : limit.windowSeconds * 1000) / 1000)) };
    } catch (error) {
      this.logger.warn(`rate limit read failed, using the in-process count: ${(error as Error).message}`);
      return this.readLocal(limit, key);
    }
  }

  private async increment(limit: RateLimit, key: string): Promise<{ count: number; retryAfterSeconds: number }> {
    try {
      const redisKey = this.redisKey(limit, key);
      // SET NX EX opens the window on the first failure; INCR counts; PTTL says how long until it reopens.
      const results = await this.redis.multi().set(redisKey, 0, "EX", limit.windowSeconds, "NX").incr(redisKey).pttl(redisKey).exec();
      const values = (results ?? []).map(([err, value]) => {
        if (err) throw err;
        return value;
      });
      const count = Number(values[1]);
      let ttlMs = Number(values[2]);
      if (ttlMs < 0) {
        // A key with no expiry would count forever; give it one.
        await this.redis.expire(redisKey, limit.windowSeconds).catch(() => undefined);
        ttlMs = limit.windowSeconds * 1000;
      }
      return { count, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
    } catch (error) {
      this.logger.warn(`rate limit write failed, using the in-process count: ${(error as Error).message}`);
      return this.incrementLocal(limit, key);
    }
  }

  private localKey(limit: RateLimit, key: string): string {
    return `${limit.bucket}:${key}`;
  }

  private readLocal(limit: RateLimit, key: string) {
    const entry = this.local.get(this.localKey(limit, key));
    if (!entry || entry.resetsAt <= Date.now()) return { count: 0, retryAfterSeconds: limit.windowSeconds };
    return { count: entry.count, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - Date.now()) / 1000)) };
  }

  private incrementLocal(limit: RateLimit, key: string) {
    const now = Date.now();
    const id = this.localKey(limit, key);
    if (this.local.size > 10_000) {
      for (const [k, v] of this.local) if (v.resetsAt <= now) this.local.delete(k);
    }
    let entry = this.local.get(id);
    if (!entry || entry.resetsAt <= now) entry = { count: 0, resetsAt: now + limit.windowSeconds * 1000 };
    entry.count += 1;
    this.local.set(id, entry);
    return { count: entry.count, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)) };
  }
}
