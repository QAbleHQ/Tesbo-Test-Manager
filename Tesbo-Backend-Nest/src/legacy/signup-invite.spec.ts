import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { SignupService } from "./signup.service";
import { InvitationRow, LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
import { AppConfigService } from "../config/app-config.service";
import { OtpService } from "../auth/otp.service";
import { PasswordService } from "../auth/password.service";
import { AuthService } from "../auth/auth.service";
import { AuditService } from "../audit/audit.service";

/**
 * Covers the registration-via-invite path: a brand-new user who has never had
 * an account accepts an invite by registering, rather than an existing user
 * calling LegacyService.acceptInvitation directly (see team-invite.spec.ts).
 */
function makeDb(
  opts: {
    emailTaken?: boolean;
    pendingSignup?: {
      id: string;
      email: string;
      name: string;
      first_name: string | null;
      last_name: string | null;
      mobile_number: string | null;
      password_hash: string | null;
      invitation_id: string | null;
    } | null;
  } = {}
) {
  const txQuery = jest.fn().mockResolvedValue({ rows: [{ id: "new-user-1" }] });
  const query = jest.fn((sql: string, _params: unknown[]) => {
    if (sql.includes("SELECT id FROM users WHERE email = $1")) {
      return Promise.resolve({ rows: opts.emailTaken ? [{ id: "existing-user" }] : [] });
    }
    if (sql.includes("INSERT INTO pending_signups")) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("FROM pending_signups")) {
      return Promise.resolve({ rows: opts.pendingSignup ? [opts.pendingSignup] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const transaction = jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: txQuery }));
  return { db: { query, transaction } as unknown as DatabaseService, query, txQuery };
}

function makeService(opts: {
  dbOpts?: Parameters<typeof makeDb>[0];
  invitation?: InvitationRow | Error;
  otpRequestResult?: boolean;
  otpVerifyResult?: boolean;
} = {}) {
  const { db, query, txQuery } = makeDb(opts.dbOpts);
  const config = { otpExpiryMinutes: 10 } as unknown as AppConfigService;
  const otp = {
    requestOtp: jest.fn().mockResolvedValue(opts.otpRequestResult ?? true),
    verifyOtpCode: jest.fn().mockResolvedValue(opts.otpVerifyResult ?? true)
  } as unknown as OtpService;
  const password = {
    hashPassword: jest.fn((pw: string) => `hashed:${pw}`),
    assertValidPassword: jest.fn()
  } as unknown as PasswordService;
  const auth = { signInUser: jest.fn().mockResolvedValue(undefined) } as unknown as AuthService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const legacy = {
    getInvitationRowOrThrow:
      opts.invitation instanceof Error
        ? jest.fn().mockRejectedValue(opts.invitation)
        : jest.fn().mockResolvedValue(opts.invitation),
    logWorkspaceActivity: jest.fn().mockResolvedValue(undefined),
    logProjectActivity: jest.fn().mockResolvedValue(undefined)
  } as unknown as LegacyService;

  const svc = new SignupService(db, config, otp, password, auth, audit, legacy);
  return { svc, query, txQuery, otp, password, auth, audit, legacy };
}

const req = {} as any;
const res = {} as any;

const INVITE: InvitationRow = {
  id: "inv-1",
  organization_id: "org-1",
  email: "bob@example.com",
  role: "qa_engineer",
  status: "pending",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  project_ids: ["proj-1"]
};

describe("SignupService — invite-based registration", () => {
  describe("startInviteRegistration", () => {
    it("stores a pending signup tied to the invitation and sends an OTP (happy path)", async () => {
      const { svc, query, otp, password } = makeService({ invitation: INVITE });
      await svc.startInviteRegistration("raw-token", "Bob", "Builder", "+14155551234", "supersecret", "1.2.3.4", "ua");

      expect(password.hashPassword).toHaveBeenCalledWith("supersecret");
      const insertCall = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO pending_signups"));
      expect(insertCall).toBeDefined();
      // [email, name, firstName, lastName, mobileNumber, passwordHash, invitationId, expiresAt]
      expect(insertCall![1][0]).toBe("bob@example.com");
      expect(insertCall![1][1]).toBe("Bob Builder");
      expect(insertCall![1][2]).toBe("Bob");
      expect(insertCall![1][3]).toBe("Builder");
      expect(insertCall![1][4]).toBe("+14155551234");
      expect(insertCall![1][5]).toBe("hashed:supersecret");
      expect(insertCall![1][6]).toBe("inv-1");
      expect(otp.requestOtp).toHaveBeenCalledWith("bob@example.com", "1.2.3.4", "ua");
    });

    it("stores a pending signup with no mobile number when none is given (optional field)", async () => {
      const { svc, query } = makeService({ invitation: INVITE });
      await svc.startInviteRegistration("raw-token", "Bob", "Builder", undefined, "supersecret", "1.2.3.4");
      const insertCall = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO pending_signups"));
      expect(insertCall![1][4]).toBeNull();
    });

    it("rejects when the invited email already has an account", async () => {
      const { svc } = makeService({ invitation: INVITE, dbOpts: { emailTaken: true } });
      await expect(svc.startInviteRegistration("raw-token", "Bob", "Builder", undefined, "supersecret", "1.2.3.4")).rejects.toMatchObject({
        response: { error: "An account with this email already exists. Please sign in and accept the invite." }
      });
    });

    it("rejects a missing first name before ever touching the DB for the email check", async () => {
      const { svc, query } = makeService({ invitation: INVITE });
      await expect(svc.startInviteRegistration("raw-token", "  ", "Builder", undefined, "supersecret", "1.2.3.4")).rejects.toMatchObject({
        response: { error: "First name is required" }
      });
      expect(query.mock.calls.some((c) => String(c[0]).includes("SELECT id FROM users WHERE email"))).toBe(false);
    });

    it("rejects a malformed mobile number", async () => {
      const { svc } = makeService({ invitation: INVITE });
      await expect(
        svc.startInviteRegistration("raw-token", "Bob", "Builder", "not-a-number", "supersecret", "1.2.3.4")
      ).rejects.toMatchObject({
        response: { error: "Mobile number must include a country code, e.g. +14155551234" }
      });
    });

    it("propagates an invalid/expired invitation token from LegacyService untouched", async () => {
      const notFound = new BadRequestException({ error: "This invitation has expired. Ask the sender to resend it." });
      const { svc } = makeService({ invitation: notFound });
      await expect(svc.startInviteRegistration("raw-token", "Bob", "Builder", undefined, "supersecret", "1.2.3.4")).rejects.toBe(notFound);
    });
  });

  describe("startInviteOtpRegistration", () => {
    it("stores a pending signup with no password hash (OTP-only registration)", async () => {
      const { svc, query } = makeService({ invitation: INVITE });
      await svc.startInviteOtpRegistration("raw-token", "Bob", "Builder", undefined, "1.2.3.4");
      const insertCall = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO pending_signups"));
      expect(insertCall![1][5]).toBeNull();
      expect(insertCall![1][6]).toBe("inv-1");
    });
  });

  describe("verifyInviteRegistration / verifyInviteOtpRegistration (completeInviteVerification)", () => {
    const PENDING = {
      id: "pending-1",
      email: "bob@example.com",
      name: "Bob Builder",
      first_name: "Bob",
      last_name: "Builder",
      mobile_number: "+14155551234",
      password_hash: "hashed:supersecret",
      invitation_id: "inv-1"
    };

    it("creates the user, assigns the invited role in the org and its projects, and marks the invite accepted", async () => {
      const { svc, txQuery, query, auth, audit, legacy } = makeService({ invitation: INVITE, dbOpts: { pendingSignup: PENDING } });

      const result = await svc.verifyInviteRegistration("raw-token", "123456", "1.2.3.4", "ua", req, res);
      expect(result).toEqual({ ok: true, userId: "new-user-1", organizationId: "org-1" });

      const calls = txQuery.mock.calls;
      const insertUserCall = calls.find((c) => String(c[0]).includes("INSERT INTO users"));
      expect(insertUserCall![1]).toEqual(["bob@example.com", "Bob Builder", "Bob", "Builder", "+14155551234", "hashed:supersecret"]);

      const orgMemberCall = calls.find((c) => String(c[0]).includes("INSERT INTO organization_members"));
      expect(orgMemberCall![1]).toEqual(["org-1", "new-user-1", "qa_engineer"]);

      const projectMemberCall = calls.find((c) => String(c[0]).includes("INSERT INTO project_members"));
      expect(projectMemberCall![1]).toEqual(["proj-1", "new-user-1", "qa_engineer"]);

      const inviteUpdateCall = calls.find((c) => String(c[0]).includes("UPDATE invitations SET status = 'accepted'"));
      expect(inviteUpdateCall![1]).toEqual(["inv-1"]);

      const consumedCall = calls.find((c) => String(c[0]).includes("UPDATE pending_signups SET consumed_at"));
      expect(consumedCall![1]).toEqual(["pending-1"]);

      expect(auth.signInUser).toHaveBeenCalledWith("new-user-1", "bob@example.com", req, res);
      expect(audit.log).toHaveBeenCalledWith("new-user-1", "invite_registration_completed", "organization", "org-1", "{}", "1.2.3.4", "ua");
      expect(legacy.logWorkspaceActivity).toHaveBeenCalledWith(
        "org-1", "new-user-1", "invitation_accepted", "invitation", "inv-1", "bob@example.com", { role: "qa_engineer", viaRegistration: true }
      );
      expect(legacy.logProjectActivity).toHaveBeenCalledWith(
        "proj-1", "new-user-1", "project_member_added", "project_member", "new-user-1", "bob@example.com", { role: "qa_engineer", via: "invitation_registered" }
      );
      // Sanity: query() (non-transactional) is untouched by the transaction's own inserts.
      expect(query.mock.calls.some((c) => String(c[0]).includes("INSERT INTO users"))).toBe(false);
    });

    it("rejects an invalid or expired OTP code", async () => {
      const { svc } = makeService({ invitation: INVITE, dbOpts: { pendingSignup: PENDING }, otpVerifyResult: false });
      await expect(svc.verifyInviteRegistration("raw-token", "000000", "1.2.3.4", "ua", req, res)).rejects.toMatchObject({
        response: { error: "invalid_or_expired_otp" }
      });
    });

    it("rejects when no pending registration exists for this invite (e.g. never started, or expired)", async () => {
      const { svc } = makeService({ invitation: INVITE, dbOpts: { pendingSignup: null } });
      await expect(svc.verifyInviteRegistration("raw-token", "123456", "1.2.3.4", "ua", req, res)).rejects.toMatchObject({
        response: { error: "No pending registration found for this invite. Please start again." }
      });
    });

    it("surfaces a duplicate-account race as a Conflict instead of a raw DB error", async () => {
      const { svc, txQuery } = makeService({ invitation: INVITE, dbOpts: { pendingSignup: PENDING } });
      txQuery.mockImplementation((sql: string) => {
        if (String(sql).includes("INSERT INTO users")) {
          const err: any = new Error("duplicate key value violates unique constraint");
          err.code = "23505";
          return Promise.reject(err);
        }
        return Promise.resolve({ rows: [] });
      });
      await expect(svc.verifyInviteRegistration("raw-token", "123456", "1.2.3.4", "ua", req, res)).rejects.toBeInstanceOf(
        ConflictException
      );
    });
  });
});
