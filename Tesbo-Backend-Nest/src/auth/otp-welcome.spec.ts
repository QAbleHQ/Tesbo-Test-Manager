import { OtpService } from "./otp.service";
import { EmailService } from "./email.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { SessionCacheService } from "../cache/session-cache.service";
import { WelcomeEmailService } from "../welcome-email/welcome-email.service";

/**
 * Passwordless "Email code" sign-in creates the account on first verify (findOrCreateUser), so it is
 * a registration path too — the one the Create account → Email code screen uses. It must schedule
 * the welcome email when, and only when, that call created the user.
 */
function makeService(users: { existing?: string; insertReturns?: string | null } = {}) {
  const query = jest.fn((sql: string) => {
    if (sql.includes("FROM otp_codes")) return Promise.resolve({ rows: [{ id: "otp-1" }] });
    if (sql.includes("SELECT id FROM users WHERE email")) {
      return Promise.resolve({ rows: users.existing ? [{ id: users.existing }] : [] });
    }
    if (sql.includes("INSERT INTO users")) {
      // A null insert models a concurrent verify winning the ON CONFLICT race; the retry then finds it.
      if (users.insertReturns === null) users.existing = "raced-user";
      return Promise.resolve({ rows: users.insertReturns ? [{ id: users.insertReturns }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const welcomeEmail = { schedule: jest.fn().mockResolvedValue(undefined) };
  const svc = new OtpService(
    { query } as unknown as DatabaseService,
    { sessionDays: 30 } as AppConfigService,
    {} as EmailService,
    {} as SessionCacheService,
    welcomeEmail as unknown as WelcomeEmailService
  );
  return { svc, welcomeEmail };
}

describe("OtpService.verifyOtp — welcome email", () => {
  it("schedules the welcome email for an account created by an email-code signup", async () => {
    const { svc, welcomeEmail } = makeService({ insertReturns: "new-user" });
    await expect(svc.verifyOtp("New@Example.test", "123456")).resolves.toEqual(expect.any(String));
    expect(welcomeEmail.schedule).toHaveBeenCalledTimes(1);
    expect(welcomeEmail.schedule).toHaveBeenCalledWith("new-user");
  });

  it("does not welcome an existing user signing in with an email code", async () => {
    const { svc, welcomeEmail } = makeService({ existing: "old-user" });
    await expect(svc.verifyOtp("old@example.test", "123456")).resolves.toEqual(expect.any(String));
    expect(welcomeEmail.schedule).not.toHaveBeenCalled();
  });

  it("leaves the welcome to whichever concurrent verify actually created the account", async () => {
    const { svc, welcomeEmail } = makeService({ insertReturns: null });
    await expect(svc.verifyOtp("race@example.test", "123456")).resolves.toEqual(expect.any(String));
    expect(welcomeEmail.schedule).not.toHaveBeenCalled();
  });
});
