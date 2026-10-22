import { SignupService } from "./signup.service";
import { LIMITS, RateLimitedException } from "../rate-limit/rate-limit.service";

/*
 * Finishing a signup or an invite with the right code must never be held up by the per-address limit;
 * only wrong codes count, and an address that has tried too many is stopped before a code is checked.
 */

type Any = Record<string, any>;

function make(opts: { blocked?: boolean; codeValid?: boolean } = {}) {
  const calls: string[] = [];
  const svc = Object.create(SignupService.prototype) as Any;
  svc.rateLimit = {
    assertAllowed: jest.fn(async (limit: Any) => {
      calls.push(`assert:${limit.bucket}`);
      if (opts.blocked) throw new RateLimitedException(120);
    }),
    recordFailure: jest.fn(async (limit: Any, key: string) => void calls.push(`fail:${limit.bucket}:${key}`))
  };
  svc.otp = {
    verifyOtpCode: jest.fn(async () => {
      calls.push("verifyOtpCode");
      return opts.codeValid ?? true;
    })
  };
  return { svc, calls };
}

describe("SignupService.verifyCodeOrFail", () => {
  it("a right code records nothing, however many people on one address finish a signup", async () => {
    const { svc, calls } = make({ codeValid: true });
    for (let i = 0; i < 50; i++) await svc.verifyCodeOrFail("a@example.test", "123456", "203.0.113.9");
    expect(calls.filter((c) => c.startsWith("fail:"))).toEqual([]);
  });

  it("a wrong code is recorded against the address and answers 401", async () => {
    const { svc, calls } = make({ codeValid: false });
    await expect(svc.verifyCodeOrFail("a@example.test", "000000", "198.51.100.7")).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual(["assert:code-fail", "verifyOtpCode", `fail:${LIMITS.codeFailuresPerIp.bucket}:198.51.100.7`]);
  });

  it("an address over its allowance is stopped with a 429 before any code is checked", async () => {
    const { svc, calls } = make({ blocked: true });
    await expect(svc.verifyCodeOrFail("a@example.test", "123456", "203.0.113.9")).rejects.toBeInstanceOf(RateLimitedException);
    expect(calls).toEqual(["assert:code-fail"]);
  });

  it("folds IPv4-mapped IPv6 and counts an IPv6 /64 as one source", async () => {
    const mapped = make({ codeValid: false });
    await expect(mapped.svc.verifyCodeOrFail("a@example.test", "0", "::ffff:198.51.100.7")).rejects.toBeTruthy();
    expect(mapped.calls).toContain("fail:code-fail:198.51.100.7");

    const v6 = make({ codeValid: false });
    await expect(v6.svc.verifyCodeOrFail("a@example.test", "0", "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).rejects.toBeTruthy();
    expect(v6.calls).toContain("fail:code-fail:2001:db8:1:2::/64");
  });
});
