import { LIMITS, RateLimitService, RateLimitedException, clientKey, type RateLimit } from "./rate-limit.service";
import type { AppConfigService } from "../config/app-config.service";

/*
 * The limits count FAILED guesses so they can never stand in a real user's way. These pin that:
 * a counter only moves when a caller says "that was a failure", reading never moves it, the window
 * reopens, addresses do not share counters, and Redis being down degrades to an in-process count
 * instead of turning the limit off or failing the request.
 */

/** Just enough of ioredis for the commands the service issues, with real expiry. */
class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number | null }>();
  down = false;
  now = () => Date.now();

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  multi() {
    const ops: Array<() => unknown> = [];
    const chain = {
      get: (key: string) => (ops.push(() => this.live(key)?.value ?? null), chain),
      set: (key: string, value: string | number, _ex: string, seconds: number, _nx: string) => (
        ops.push(() => {
          if (!this.live(key)) this.store.set(key, { value: String(value), expiresAt: this.now() + seconds * 1000 });
          return "OK";
        }),
        chain
      ),
      incr: (key: string) => (
        ops.push(() => {
          const entry = this.live(key) ?? { value: "0", expiresAt: null };
          entry.value = String(Number(entry.value) + 1);
          this.store.set(key, entry);
          return Number(entry.value);
        }),
        chain
      ),
      pttl: (key: string) => (
        ops.push(() => {
          const entry = this.live(key);
          if (!entry) return -2;
          return entry.expiresAt === null ? -1 : entry.expiresAt - this.now();
        }),
        chain
      ),
      exec: async () => {
        if (this.down) throw new Error("Connection is closed.");
        return ops.map((op) => [null, op()]);
      }
    };
    return chain;
  }

  async expire(key: string, seconds: number) {
    const entry = this.live(key);
    if (entry) entry.expiresAt = this.now() + seconds * 1000;
    return 1;
  }
}

function make(config: Partial<{ rateLimitEnabled: boolean; rateLimitIpMultiplier: number }> = {}) {
  const redis = new FakeRedis();
  const service = new RateLimitService(redis as never, { rateLimitEnabled: true, rateLimitIpMultiplier: 1, ...config } as AppConfigService);
  return { redis, service };
}

const SMALL: RateLimit = { bucket: "test", limit: 3, windowSeconds: 60, perIp: true };
const SMALL_PER_ACCOUNT: RateLimit = { bucket: "acct", limit: 3, windowSeconds: 60, perIp: false };

describe("failure counting never touches a caller who has not failed", () => {
  it("reading does not move the counter, however often it is read", async () => {
    const { service, redis } = make();
    for (let i = 0; i < 50; i++) await service.assertAllowed(SMALL, "1.2.3.4");
    expect(redis.store.size).toBe(0);
  });

  it("is allowed up to the cap and refused from the next failure on", async () => {
    const { service } = make();
    for (let i = 0; i < 3; i++) {
      await service.assertAllowed(SMALL, "1.2.3.4");
      await service.recordFailure(SMALL, "1.2.3.4");
    }
    await expect(service.assertAllowed(SMALL, "1.2.3.4")).rejects.toBeInstanceOf(RateLimitedException);
  });

  it("a caller with 2 failures out of 3 is still let through, and a success afterwards costs nothing", async () => {
    const { service } = make();
    await service.recordFailure(SMALL, "1.2.3.4");
    await service.recordFailure(SMALL, "1.2.3.4");
    await expect(service.assertAllowed(SMALL, "1.2.3.4")).resolves.toBeUndefined();
    // The caller then succeeds: nothing is recorded, so nothing changes.
    await expect(service.assertAllowed(SMALL, "1.2.3.4")).resolves.toBeUndefined();
  });

  it("does not share a counter between addresses or between buckets", async () => {
    const { service } = make();
    for (let i = 0; i < 3; i++) await service.recordFailure(SMALL, "1.2.3.4");
    await expect(service.assertAllowed(SMALL, "1.2.3.4")).rejects.toBeInstanceOf(RateLimitedException);
    await expect(service.assertAllowed(SMALL, "5.6.7.8")).resolves.toBeUndefined();
    await expect(service.assertAllowed({ ...SMALL, bucket: "other" }, "1.2.3.4")).resolves.toBeUndefined();
  });

  it("the window reopens by itself", async () => {
    const { service, redis } = make();
    let t = 1_000_000;
    redis.now = () => t;
    for (let i = 0; i < 3; i++) await service.recordFailure(SMALL, "1.2.3.4");
    await expect(service.assertAllowed(SMALL, "1.2.3.4")).rejects.toBeInstanceOf(RateLimitedException);
    t += 61_000;
    await expect(service.assertAllowed(SMALL, "1.2.3.4")).resolves.toBeUndefined();
    await service.recordFailure(SMALL, "1.2.3.4");
    expect(redis.store.get("rl:test:1.2.3.4")?.value).toBe("1");
  });

  it("the window is fixed from the FIRST failure, so a steady trickle cannot keep a caller blocked forever", async () => {
    const { service, redis } = make();
    let t = 1_000_000;
    redis.now = () => t;
    await service.recordFailure(SMALL, "1.2.3.4");
    const opened = redis.store.get("rl:test:1.2.3.4")!.expiresAt;
    t += 30_000;
    await service.recordFailure(SMALL, "1.2.3.4");
    expect(redis.store.get("rl:test:1.2.3.4")!.expiresAt).toBe(opened);
  });

  it("says how long to wait", async () => {
    const { service, redis } = make();
    let t = 1_000_000;
    redis.now = () => t;
    for (let i = 0; i < 3; i++) await service.recordFailure(SMALL, "1.2.3.4");
    t += 20_000;
    const error = await service.assertAllowed(SMALL, "1.2.3.4").catch((e) => e as RateLimitedException);
    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).getStatus()).toBe(429);
    expect((error as RateLimitedException).retryAfterSeconds).toBe(40);
    expect((error as RateLimitedException).getResponse()).toMatchObject({ code: "rate_limited", retryAfterSeconds: 40 });
  });

  it("a key with no expiry (a crash between the two commands) is given one rather than counting forever", async () => {
    const { service, redis } = make();
    redis.store.set("rl:test:9.9.9.9", { value: "2", expiresAt: null });
    await service.recordFailure(SMALL, "9.9.9.9");
    expect(redis.store.get("rl:test:9.9.9.9")!.expiresAt).not.toBeNull();
  });
});

describe("hit: for things limited by how often they happen", () => {
  it("allows exactly the cap and refuses the next", async () => {
    const { service } = make();
    for (let i = 0; i < 3; i++) await expect(service.hit(SMALL, "k")).resolves.toBeUndefined();
    await expect(service.hit(SMALL, "k")).rejects.toBeInstanceOf(RateLimitedException);
  });
});

describe("the per-IP multiplier", () => {
  it("widens per-IP caps and leaves per-account caps alone", async () => {
    const { service } = make({ rateLimitIpMultiplier: 10 });
    for (let i = 0; i < 29; i++) await service.recordFailure(SMALL, "ip");
    await expect(service.assertAllowed(SMALL, "ip")).resolves.toBeUndefined();
    await service.recordFailure(SMALL, "ip");
    await expect(service.assertAllowed(SMALL, "ip")).rejects.toBeInstanceOf(RateLimitedException);

    for (let i = 0; i < 3; i++) await service.recordFailure(SMALL_PER_ACCOUNT, "acct");
    await expect(service.assertAllowed(SMALL_PER_ACCOUNT, "acct")).rejects.toBeInstanceOf(RateLimitedException);
  });

  it.each([0, -5, NaN])("treats a multiplier of %p as 1, never as 'no limit' or a negative cap", async (multiplier) => {
    const { service } = make({ rateLimitIpMultiplier: multiplier });
    for (let i = 0; i < 3; i++) await service.recordFailure(SMALL, "ip");
    await expect(service.assertAllowed(SMALL, "ip")).rejects.toBeInstanceOf(RateLimitedException);
  });
});

describe("switched off", () => {
  it("counts and refuses nothing", async () => {
    const { service, redis } = make({ rateLimitEnabled: false });
    for (let i = 0; i < 20; i++) {
      await service.recordFailure(SMALL, "ip");
      await service.hit(SMALL, "ip");
    }
    await expect(service.assertAllowed(SMALL, "ip")).resolves.toBeUndefined();
    expect(redis.store.size).toBe(0);
  });
});

describe("Redis unavailable", () => {
  it("falls back to an in-process count and still enforces the cap", async () => {
    const { service, redis } = make();
    redis.down = true;
    for (let i = 0; i < 3; i++) await service.recordFailure(SMALL, "ip");
    await expect(service.assertAllowed(SMALL, "ip")).rejects.toBeInstanceOf(RateLimitedException);
    await expect(service.assertAllowed(SMALL, "other-ip")).resolves.toBeUndefined();
  });

  it("never throws for a read or a write failure, only for a genuine refusal", async () => {
    const { service, redis } = make();
    redis.down = true;
    await expect(service.recordFailure(SMALL, "ip")).resolves.toBeUndefined();
    await expect(service.assertAllowed(SMALL, "ip")).resolves.toBeUndefined();
  });
});

describe("clientKey: one subscriber, one key", () => {
  it("leaves an IPv4 address alone", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
  });

  it("folds an IPv4-mapped IPv6 address to the IPv4 one", () => {
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("::FFFF:203.0.113.9")).toBe("203.0.113.9");
  });

  it("counts an IPv6 address as its /64, so rotating inside a subscriber's range does not escape the limit", () => {
    expect(clientKey("2001:db8:aaaa:bbbb:1:2:3:4")).toBe(clientKey("2001:db8:aaaa:bbbb:ffff:eeee:dddd:cccc"));
    expect(clientKey("2001:db8:aaaa:bbbb:1:2:3:4")).not.toBe(clientKey("2001:db8:aaaa:cccc:1:2:3:4"));
    expect(clientKey("2001:db8:aaaa:bbbb::1")).toBe("2001:db8:aaaa:bbbb::/64");
  });

  it.each([undefined, null, "", "   "])("gives %p a key instead of throwing", (value) => {
    expect(clientKey(value as string)).toBe("unknown");
  });
});

describe("the limits table", () => {
  it("is generous: no per-IP failure cap is below 50 per window, so a person or an office never reaches one", () => {
    for (const [name, limit] of Object.entries(LIMITS)) {
      if (limit.perIp) expect({ name, limit: limit.limit >= 50 }).toEqual({ name, limit: true });
    }
  });

  it("keeps the account-level caps to things a person does a handful of times", () => {
    expect(LIMITS.changePasswordFailuresPerUser.limit).toBeLessThanOrEqual(20);
    expect(LIMITS.forgotPerEmailPerIp.limit).toBeLessThanOrEqual(20);
  });

  it("uses a distinct bucket name for every limit", () => {
    const names = Object.values(LIMITS).map((limit) => limit.bucket);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has a window of at least a minute for every limit", () => {
    for (const limit of Object.values(LIMITS)) expect(limit.windowSeconds).toBeGreaterThanOrEqual(60);
  });
});
