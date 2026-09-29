import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Queue } from "bullmq";
import { EmailService } from "../auth/email.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { WELCOME_EMAIL_DELAY_MS, WELCOME_EMAIL_JOB, welcomeEmailDelayMs, welcomeEmailJobId } from "./welcome-email.constants";
import { WelcomeEmailService } from "./welcome-email.service";

const HOUR = 60 * 60 * 1000;

function makeService(opts: { rows?: unknown[]; config?: Partial<AppConfigService>; queueAdd?: jest.Mock } = {}) {
  const query = jest.fn().mockResolvedValue({ rows: opts.rows ?? [] });
  const add = opts.queueAdd ?? jest.fn().mockResolvedValue(undefined);
  const sendWelcome = jest.fn().mockResolvedValue(undefined);
  const config = { welcomeEmailCc: "cc-inbox@example.test", ...opts.config } as AppConfigService;
  const svc = new WelcomeEmailService(
    { add } as unknown as Queue,
    { query } as unknown as DatabaseService,
    config,
    { sendWelcome } as unknown as EmailService
  );
  return { svc, query, add, sendWelcome };
}

describe("welcomeEmailDelayMs", () => {
  it("is exactly 3 hours when scheduled at the moment of registration", () => {
    expect(WELCOME_EMAIL_DELAY_MS).toBe(3 * HOUR);
    const now = Date.parse("2026-09-28T10:00:00Z");
    expect(welcomeEmailDelayMs(new Date(now), now)).toBe(3 * HOUR);
  });

  it("is measured from the registration time, not from when it is scheduled", () => {
    const createdAt = new Date("2026-09-28T10:00:00Z");
    const fortyMinutesLater = createdAt.getTime() + 40 * 60 * 1000;
    // Fires at 13:00 whatever time the enqueue happened.
    expect(fortyMinutesLater + welcomeEmailDelayMs(createdAt, fortyMinutesLater)).toBe(createdAt.getTime() + 3 * HOUR);
  });

  it("never goes negative for a registration already more than 3 hours old", () => {
    const createdAt = new Date("2026-09-28T10:00:00Z");
    expect(welcomeEmailDelayMs(createdAt, createdAt.getTime() + 5 * HOUR)).toBe(0);
  });
});

describe("WelcomeEmailService.schedule", () => {
  it("enqueues one delayed job keyed to the user, due 3 hours after users.created_at", async () => {
    const createdAt = new Date(Date.now() - 10 * 60 * 1000); // registered 10 minutes ago
    const { svc, add, query } = makeService({ rows: [{ created_at: createdAt }] });

    await svc.schedule("user-1");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT created_at FROM users"), ["user-1"]);
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe(WELCOME_EMAIL_JOB);
    // Only the id travels through Redis — no recipient address.
    expect(data).toEqual({ userId: "user-1" });
    expect(opts.jobId).toBe("welcome-user-1");
    const firesAt = Date.now() + opts.delay;
    expect(Math.abs(firesAt - (createdAt.getTime() + 3 * HOUR))).toBeLessThan(1000);
  });

  it("uses the same jobId every time for a user, which is what stops BullMQ from queueing a duplicate", async () => {
    const { svc, add } = makeService({ rows: [{ created_at: new Date() }] });
    await svc.schedule("user-1");
    await svc.schedule("user-1");
    expect(add.mock.calls.map((c) => c[2].jobId)).toEqual([welcomeEmailJobId("user-1"), welcomeEmailJobId("user-1")]);
  });

  it("does nothing for a user that does not exist", async () => {
    const { svc, add } = makeService({ rows: [] });
    await svc.schedule("ghost");
    expect(add).not.toHaveBeenCalled();
  });

  it("never throws into the registration request when Redis is unavailable", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { svc } = makeService({ rows: [{ created_at: new Date() }], queueAdd: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    await expect(svc.schedule("user-1")).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("WelcomeEmailService.send", () => {
  it("sends to the registered user's own email, CCs WELCOME_EMAIL_CC, and uses their first name", async () => {
    const { svc, sendWelcome, query } = makeService({ rows: [{ email: "ada@example.test", first_name: "Ada", name: "Ada Lovelace" }] });
    await svc.send("user-1");
    // Looked up by the job's user id when it fires — the address never travels through Redis.
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT email, first_name, name FROM users WHERE id = $1"), ["user-1"]);
    expect(sendWelcome).toHaveBeenCalledWith("ada@example.test", "cc-inbox@example.test", "Ada");
  });

  it("sends with no CC when WELCOME_EMAIL_CC is not set", async () => {
    const { svc, sendWelcome } = makeService({ rows: [{ email: "ada@example.test", first_name: "Ada" }], config: { welcomeEmailCc: "" } });
    await svc.send("user-1");
    expect(sendWelcome).toHaveBeenCalledWith("ada@example.test", undefined, "Ada");
  });

  it("falls back to the first word of `name` for a legacy registration that has no first_name", async () => {
    const { svc, sendWelcome } = makeService({ rows: [{ email: "grace@example.test", first_name: null, name: "  Grace  Hopper " }] });
    await svc.send("user-1");
    expect(sendWelcome).toHaveBeenCalledWith("grace@example.test", "cc-inbox@example.test", "Grace");
  });

  it("propagates a send failure so BullMQ retries the job", async () => {
    const { svc, sendWelcome } = makeService({ rows: [{ email: "ada@example.test", first_name: "Ada" }] });
    (sendWelcome as jest.Mock).mockRejectedValue(new Error("Postmark returned 500"));
    await expect(svc.send("user-1")).rejects.toThrow("Postmark returned 500");
  });

  it("skips a user deleted since registering", async () => {
    const { svc, sendWelcome } = makeService({ rows: [] });
    await expect(svc.send("gone")).resolves.toBeUndefined();
    expect(sendWelcome).not.toHaveBeenCalled();
  });
});

describe("welcome email configuration", () => {
  const saved = process.env.WELCOME_EMAIL_CC;
  afterEach(() => {
    if (saved === undefined) delete process.env.WELCOME_EMAIL_CC;
    else process.env.WELCOME_EMAIL_CC = saved;
  });

  // Same assumption as email-delivery.policy.spec.ts: no Tesbo-Backend-Nest/.env shadows process.env.
  it("reads the CC from the environment", () => {
    process.env.WELCOME_EMAIL_CC = " cc-inbox@example.test ";
    expect(new AppConfigService().welcomeEmailCc).toBe("cc-inbox@example.test");
  });

  it("has no default CC", () => {
    delete process.env.WELCOME_EMAIL_CC;
    expect(new AppConfigService().welcomeEmailCc).toBe("");
  });

  it("hardcodes no email address in the welcome-email code or the email service", () => {
    const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/;
    const files = [
      ...readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts")).map((f) => join(__dirname, f)),
      join(__dirname, "../auth/email.service.ts")
    ];
    for (const file of files) {
      expect({ file, match: readFileSync(file, "utf8").match(address)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });
});
