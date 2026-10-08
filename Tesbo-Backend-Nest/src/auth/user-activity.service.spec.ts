import { EventEmitter } from "events";
import { ActivityMiddleware } from "./activity.middleware";
import { UserActivityService } from "./user-activity.service";

function makeService(redisSet: jest.Mock, dbQuery: jest.Mock = jest.fn().mockResolvedValue({ rows: [] })) {
  const svc = new UserActivityService({ query: dbQuery } as any, { set: redisSet } as any);
  return { svc, dbQuery };
}

describe("UserActivityService.recordMutation", () => {
  it("writes on the first mutation of the window", async () => {
    const { svc, dbQuery } = makeService(jest.fn().mockResolvedValue("OK"));
    await svc.recordMutation("u1");
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(dbQuery.mock.calls[0][1]).toEqual(["u1"]);
  });

  it("skips the write while the throttle key is held", async () => {
    const { svc, dbQuery } = makeService(jest.fn().mockResolvedValue(null));
    await svc.recordMutation("u1");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("keys the throttle by IST day so a post-midnight action is not swallowed", async () => {
    const set = jest.fn().mockResolvedValue("OK");
    const { svc } = makeService(set);
    await svc.recordMutation("u1");
    expect(set.mock.calls[0][0]).toMatch(/^activity:\d{4}-\d{2}-\d{2}:u1$/);
  });

  it("still writes when Redis is down", async () => {
    const { svc, dbQuery } = makeService(jest.fn().mockRejectedValue(new Error("redis down")));
    await svc.recordMutation("u1");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("never throws when Postgres fails", async () => {
    const { svc } = makeService(jest.fn().mockResolvedValue("OK"), jest.fn().mockRejectedValue(new Error("db down")));
    await expect(svc.recordMutation("u1")).resolves.toBeUndefined();
  });
});

describe("ActivityMiddleware", () => {
  function run(opts: { userId?: string | null; method: string; url: string; status: number }) {
    const recordMutation = jest.fn().mockResolvedValue(undefined);
    const mw = new ActivityMiddleware({ recordMutation } as unknown as UserActivityService);
    const res: any = new EventEmitter();
    res.statusCode = opts.status;
    const next = jest.fn();
    mw.use({ userId: opts.userId, method: opts.method, originalUrl: opts.url } as any, res, next);
    res.emit("finish");
    expect(next).toHaveBeenCalledTimes(1);
    return recordMutation;
  }

  it("counts a successful authenticated mutation", () => {
    expect(run({ userId: "u1", method: "POST", url: "/api/projects/p/testcases", status: 201 })).toHaveBeenCalledWith("u1");
  });
  it.each(["GET", "HEAD", "OPTIONS"])("ignores %s (frontend polls reads)", (method) => {
    expect(run({ userId: "u1", method, url: "/api/projects", status: 200 })).not.toHaveBeenCalled();
  });
  it("ignores a rejected mutation", () => {
    expect(run({ userId: "u1", method: "POST", url: "/api/projects", status: 400 })).not.toHaveBeenCalled();
  });
  it("ignores an unauthenticated request", () => {
    expect(run({ userId: null, method: "POST", url: "/api/projects", status: 200 })).not.toHaveBeenCalled();
  });
  it.each(["/api/auth/logout", "/api/auth/password/change?x=1"])("ignores auth route %s", (url) => {
    expect(run({ userId: "u1", method: "POST", url, status: 200 })).not.toHaveBeenCalled();
  });
});
