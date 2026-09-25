import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "../auth/email.service";
import { PasswordService } from "../auth/password.service";
import { AppConfigService } from "../config/app-config.service";
import { StorageService } from "../storage/storage.service";
import { ApiTokenService } from "../auth/api-token.service";
import { RagIngestionService } from "../rag/rag-ingestion.service";
import { RagRetrievalService } from "../rag/rag-retrieval.service";
import { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

/**
 * DB test double for the invitation surface of LegacyService.
 * Routes queries by a unique SQL substring per call site, same pattern as
 * mcp.service.spec.ts / api-token.service.spec.ts (no real Postgres).
 */
function makeDb(
  opts: {
    workspace?: { id: string; name: string; slug?: string; role: string; created_at?: string } | null;
    existingMember?: boolean;
    pendingInvite?: { id: string } | null;
    validProjectIds?: string[];
    insertedInvitation?: Record<string, unknown> | null;
    inviter?: { name: string | null; email: string } | null;
    projectNames?: { name: string }[];
    cancelInvite?: { id: string; status: string; invited_by: string | null; email?: string } | null;
    resendInvite?: { id: string; email: string; role: string; status: string; invited_by: string | null; project_ids: string[] } | null;
    invitationByTokenRow?: Record<string, unknown> | null;
    hasAccount?: boolean;
    invitationRow?: Record<string, unknown> | null;
    userEmail?: string | null;
  } = {}
) {
  const txQuery = jest.fn().mockResolvedValue({ rows: [] });
  const query = jest.fn((sql: string, _params: unknown[]) => {
    if (sql.includes("u.active_organization_id")) {
      return Promise.resolve({ rows: opts.workspace ? [opts.workspace] : [] });
    }
    if (sql.includes("JOIN users u ON u.id = om.user_id")) {
      return Promise.resolve({ rows: opts.existingMember ? [{ user_id: "existing-user" }] : [] });
    }
    if (sql.includes("WHERE organization_id = $1 AND email = $2 AND status = 'pending'")) {
      return Promise.resolve({ rows: opts.pendingInvite ? [opts.pendingInvite] : [] });
    }
    if (sql.includes("archived_at IS NULL")) {
      const ids = opts.validProjectIds ?? [];
      return Promise.resolve({ rows: ids.map((id) => ({ id })) });
    }
    if (sql.includes("INSERT INTO invitations (organization_id, email, role, token, invited_by, status, expires_at, project_ids)")) {
      return Promise.resolve({ rows: opts.insertedInvitation ? [opts.insertedInvitation] : [] });
    }
    if (sql.includes("SELECT name, email FROM users WHERE id = $1")) {
      return Promise.resolve({ rows: opts.inviter ? [opts.inviter] : [] });
    }
    if (sql.includes("SELECT name FROM projects WHERE id = ANY($1::uuid[])")) {
      return Promise.resolve({ rows: opts.projectNames ?? [] });
    }
    if (sql.includes("SELECT id, status, invited_by, email FROM invitations")) {
      return Promise.resolve({ rows: opts.cancelInvite ? [opts.cancelInvite] : [] });
    }
    if (sql.includes("UPDATE invitations SET status = 'cancelled'")) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("SELECT id, email, role, status, invited_by, project_ids FROM invitations")) {
      return Promise.resolve({ rows: opts.resendInvite ? [opts.resendInvite] : [] });
    }
    if (sql.includes("UPDATE invitations SET token = $1, expires_at = $2")) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("LEFT JOIN organizations o ON o.id = i.organization_id")) {
      return Promise.resolve({ rows: opts.invitationByTokenRow ? [opts.invitationByTokenRow] : [] });
    }
    if (sql.includes("SELECT id FROM users WHERE email = $1 AND password_hash IS NOT NULL")) {
      return Promise.resolve({ rows: opts.hasAccount ? [{ id: "u-has-account" }] : [] });
    }
    if (sql.includes("UPDATE invitations SET status = 'expired'")) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes("SELECT id, organization_id, email, role, status, expires_at, project_ids FROM invitations WHERE token = $1")) {
      return Promise.resolve({ rows: opts.invitationRow ? [opts.invitationRow] : [] });
    }
    if (sql.includes("SELECT email FROM users WHERE id = $1")) {
      return Promise.resolve({ rows: opts.userEmail ? [{ email: opts.userEmail }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const transaction = jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: txQuery }));
  return { db: { query, transaction } as unknown as DatabaseService, query, txQuery };
}

function makeService(dbOpts: Parameters<typeof makeDb>[0] = {}, emailOverrides: Partial<Record<string, jest.Mock>> = {}) {
  const { db, query, txQuery } = makeDb(dbOpts);
  const email = {
    sendInvite: jest.fn().mockResolvedValue(undefined),
    sendOtp: jest.fn().mockResolvedValue(undefined),
    ...emailOverrides
  } as unknown as EmailService;
  const config = { frontendUrl: "https://app.tesbo.io" } as unknown as AppConfigService;
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const svc = new LegacyService(
    db,
    email,
    {} as unknown as PasswordService,
    config,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    requestCache,
    new ProjectLookupService(db, requestCache),
    {} as unknown as KbExtractionRunnerService,
    suitesCache,
    testcasesListCache,
    projectOverviewCache,
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
  return { svc, db, query, txQuery, email };
}

async function expectRejection(promise: Promise<unknown>, Ctor: new (...args: never[]) => Error, response: unknown) {
  await expect(promise).rejects.toBeInstanceOf(Ctor);
  await promise.catch((err: { getResponse(): unknown }) => {
    expect(err.getResponse()).toEqual(response);
  });
}

const OWNER_WORKSPACE = { id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "owner", created_at: "2026-01-01T00:00:00.000Z" };
const MANAGER_WORKSPACE = { id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "manager", created_at: "2026-01-01T00:00:00.000Z" };
const QA_WORKSPACE = { id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "qa_engineer", created_at: "2026-01-01T00:00:00.000Z" };

describe("LegacyService — team invitations", () => {
  describe("createInvitation", () => {
    it("creates a pending invite, hashes the token, and emails the invitee (happy path)", async () => {
      const { svc, query, email } = makeService({
        workspace: OWNER_WORKSPACE,
        existingMember: false,
        pendingInvite: null,
        validProjectIds: ["proj-1", "proj-2"],
        insertedInvitation: {
          id: "inv-1",
          email: "bob@example.com",
          role: "qa_engineer",
          status: "pending",
          expires_at: "2026-07-25T00:00:00.000Z",
          created_at: "2026-07-18T00:00:00.000Z",
          project_ids: ["proj-1", "proj-2"]
        },
        inviter: { name: "Alice Owner", email: "alice@example.com" },
        projectNames: [{ name: "Website" }, { name: "Mobile" }]
      });

      const result = await svc.createInvitation("user-1", {
        email: " BOB@Example.com ",
        role: "qa_engineer",
        projectIds: ["proj-1", "proj-2"]
      });

      const insertCall = query.mock.calls.find((c) =>
        String(c[0]).includes("INSERT INTO invitations (organization_id, email, role, token, invited_by, status, expires_at, project_ids)")
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      // [organization_id, email, role, tokenHash, invited_by, expires_at, project_ids]
      expect(params[0]).toBe("org-1");
      expect(params[1]).toBe("bob@example.com"); // trimmed + lowercased
      expect(params[2]).toBe("qa_engineer");
      expect(params[4]).toBe("user-1");
      expect(params[6]).toEqual(["proj-1", "proj-2"]);

      // Expiry is ~7 days out.
      const expiresAt = params[5] as Date;
      const deltaMs = expiresAt.getTime() - Date.now();
      expect(deltaMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(deltaMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);

      // The invite email carries the *raw* token, and its hash is what got persisted.
      expect(email.sendInvite).toHaveBeenCalledTimes(1);
      const [to, inviterName, role, workspaceName, rawToken, projectNames, frontendUrl] = (email.sendInvite as jest.Mock).mock.calls[0];
      expect(to).toBe("bob@example.com");
      expect(inviterName).toBe("Alice Owner");
      expect(role).toBe("qa_engineer");
      expect(workspaceName).toBe("Acme Corp");
      expect(projectNames).toEqual(["Website", "Mobile"]);
      expect(frontendUrl).toBe("https://app.tesbo.io");
      expect(params[3]).toBe(svc.hashToken(rawToken));
      expect(params[3]).not.toBe(rawToken); // raw token is never persisted

      expect(result).toEqual({
        id: "inv-1",
        email: "bob@example.com",
        role: "qa_engineer",
        status: "pending",
        expiresAt: "2026-07-25T00:00:00.000Z",
        createdAt: "2026-07-18T00:00:00.000Z",
        projectIds: ["proj-1", "proj-2"]
      });
    });

    it("rejects when a QA Engineer tries to invite anyone", async () => {
      const { svc } = makeService({ workspace: QA_WORKSPACE });
      await expectRejection(
        svc.createInvitation("user-1", { email: "new@example.com", role: "qa_engineer" }),
        ForbiddenException,
        { error: "QA Engineers cannot invite members" }
      );
    });

    it("rejects inviting someone directly as owner", async () => {
      const { svc } = makeService({ workspace: OWNER_WORKSPACE });
      await expectRejection(
        svc.createInvitation("user-1", { email: "new@example.com", role: "owner" }),
        ForbiddenException,
        { error: "Cannot invite owners directly" }
      );
    });

    it("restricts a manager to inviting QA Engineers only", async () => {
      const { svc } = makeService({ workspace: MANAGER_WORKSPACE });
      await expectRejection(
        svc.createInvitation("user-1", { email: "new@example.com", role: "manager" }),
        ForbiddenException,
        { error: "Managers can only invite QA Engineers" }
      );
    });

    it("rejects an invite for an email that is already a team member", async () => {
      const { svc } = makeService({ workspace: OWNER_WORKSPACE, existingMember: true });
      await expectRejection(
        svc.createInvitation("user-1", { email: "existing@example.com", role: "qa_engineer" }),
        BadRequestException,
        { error: "This user is already a team member" }
      );
    });

    it("rejects a duplicate invite and surfaces the existing pending invite id", async () => {
      const { svc } = makeService({ workspace: OWNER_WORKSPACE, pendingInvite: { id: "inv-pending-1" } });
      await expectRejection(
        svc.createInvitation("user-1", { email: "bob@example.com", role: "qa_engineer" }),
        BadRequestException,
        { error: "This email already has a pending invite. You can resend the invite.", inviteId: "inv-pending-1" }
      );
    });

    it("rejects project ids that don't belong to (or are archived in) the workspace", async () => {
      // Only proj-1 validates; proj-2 is missing/archived/foreign.
      const { svc } = makeService({ workspace: OWNER_WORKSPACE, validProjectIds: ["proj-1"] });
      await expectRejection(
        svc.createInvitation("user-1", { email: "bob@example.com", role: "qa_engineer", projectIds: ["proj-1", "proj-2"] }),
        BadRequestException,
        { error: "One or more project IDs are invalid" }
      );
    });

    it("rejects an invalid email address", async () => {
      const { svc } = makeService({ workspace: OWNER_WORKSPACE });
      await expectRejection(
        svc.createInvitation("user-1", { email: "not-an-email", role: "qa_engineer" }),
        BadRequestException,
        { error: "invalid email address" }
      );
    });
  });

  describe("cancelInvitation", () => {
    it("lets the owner cancel any pending invite", async () => {
      const { svc, query } = makeService({
        workspace: OWNER_WORKSPACE,
        cancelInvite: { id: "inv-1", status: "pending", invited_by: "someone-else", email: "bob@example.com" }
      });
      await svc.cancelInvitation("owner-user", "inv-1");
      const updateCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE invitations SET status = 'cancelled'"));
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual(["inv-1"]);
    });

    it("lets a manager cancel only the invites they sent", async () => {
      const { svc } = makeService({
        workspace: MANAGER_WORKSPACE,
        cancelInvite: { id: "inv-1", status: "pending", invited_by: "someone-else", email: "bob@example.com" }
      });
      await expectRejection(svc.cancelInvitation("manager-user", "inv-1"), ForbiddenException, {
        error: "You can only cancel invitations you sent"
      });
    });

    it("404s for a missing invitation", async () => {
      const { svc } = makeService({ workspace: OWNER_WORKSPACE, cancelInvite: null });
      await expectRejection(svc.cancelInvitation("owner-user", "ghost"), NotFoundException, { error: "Invitation not found" });
    });

    it("refuses to cancel a non-pending invite", async () => {
      const { svc } = makeService({
        workspace: OWNER_WORKSPACE,
        cancelInvite: { id: "inv-1", status: "accepted", invited_by: "owner-user", email: "bob@example.com" }
      });
      await expectRejection(svc.cancelInvitation("owner-user", "inv-1"), BadRequestException, {
        error: "Only pending invitations can be cancelled"
      });
    });
  });

  describe("resendInvitation", () => {
    it("rotates the token, extends expiry, and re-sends the invite email", async () => {
      const { svc, query, email } = makeService({
        workspace: OWNER_WORKSPACE,
        resendInvite: { id: "inv-1", email: "bob@example.com", role: "qa_engineer", status: "pending", invited_by: "owner-user", project_ids: ["proj-1"] },
        inviter: { name: "Alice Owner", email: "alice@example.com" },
        projectNames: [{ name: "Website" }]
      });

      const result = await svc.resendInvitation("owner-user", "inv-1");
      expect(result).toEqual({ resent: true });

      const updateCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE invitations SET token = $1, expires_at = $2"));
      expect(updateCall).toBeDefined();
      const [, params] = updateCall!;
      expect(params[2]).toBe("inv-1");
      const newTokenHash = params[0];

      expect(email.sendInvite).toHaveBeenCalledTimes(1);
      const [to, , , , rawToken] = (email.sendInvite as jest.Mock).mock.calls[0];
      expect(to).toBe("bob@example.com");
      expect(newTokenHash).toBe(svc.hashToken(rawToken));
    });

    it("refuses to resend an invite the caller (a non-owner) did not send", async () => {
      const { svc } = makeService({
        workspace: MANAGER_WORKSPACE,
        resendInvite: { id: "inv-1", email: "bob@example.com", role: "qa_engineer", status: "pending", invited_by: "someone-else", project_ids: [] }
      });
      await expectRejection(svc.resendInvitation("manager-user", "inv-1"), ForbiddenException, {
        error: "You can only resend invitations you sent"
      });
    });

    it("refuses to resend a cancelled invite", async () => {
      const { svc } = makeService({
        workspace: OWNER_WORKSPACE,
        resendInvite: { id: "inv-1", email: "bob@example.com", role: "qa_engineer", status: "cancelled", invited_by: "owner-user", project_ids: [] }
      });
      await expectRejection(svc.resendInvitation("owner-user", "inv-1"), BadRequestException, {
        error: "Only pending invitations can be resent"
      });
    });
  });

  describe("getInvitationByToken", () => {
    it("reports hasAccount so the frontend can pick the sign-in vs register flow", async () => {
      const { svc } = makeService({
        invitationByTokenRow: {
          id: "inv-1",
          organization_id: "org-1",
          email: "bob@example.com",
          role: "qa_engineer",
          status: "pending",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          accepted_at: null,
          created_at: "2026-07-18T00:00:00.000Z",
          project_ids: [],
          organization_name: "Acme Corp",
          projects: []
        },
        hasAccount: true
      });
      const result = await svc.getInvitationByToken("raw-token");
      expect(result.hasAccount).toBe(true);
      expect(result.status).toBe("pending");
      expect(result.organizationName).toBe("Acme Corp");
    });

    it("auto-expires a pending invite whose expiry has passed", async () => {
      const { svc, query } = makeService({
        invitationByTokenRow: {
          id: "inv-1",
          organization_id: "org-1",
          email: "bob@example.com",
          role: "qa_engineer",
          status: "pending",
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          accepted_at: null,
          created_at: "2026-07-01T00:00:00.000Z",
          project_ids: [],
          organization_name: "Acme Corp",
          projects: []
        },
        hasAccount: false
      });
      const result = await svc.getInvitationByToken("raw-token");
      expect(result.status).toBe("expired");
      const expireCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE invitations SET status = 'expired'"));
      expect(expireCall).toBeDefined();
      expect(expireCall![1]).toEqual(["inv-1"]);
    });

    it("404s for an unknown token", async () => {
      const { svc } = makeService({ invitationByTokenRow: null });
      await expectRejection(svc.getInvitationByToken("bogus"), NotFoundException, {
        error: "Invitation not found or token is invalid"
      });
    });
  });

  describe("getInvitationRowOrThrow (used by the signup/registration flows)", () => {
    it("404s for an unknown token", async () => {
      const { svc } = makeService({ invitationRow: null });
      await expectRejection(svc.getInvitationRowOrThrow("bogus"), NotFoundException, {
        error: "Invitation not found or token is invalid"
      });
    });

    it("rejects an already-accepted invite", async () => {
      const { svc } = makeService({
        invitationRow: {
          id: "inv-1",
          organization_id: "org-1",
          email: "bob@example.com",
          role: "qa_engineer",
          status: "accepted",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          project_ids: []
        }
      });
      await expectRejection(svc.getInvitationRowOrThrow("raw-token"), BadRequestException, {
        error: "Invitation is accepted and can no longer be used"
      });
    });

    it("expires (and marks expired in the DB) a pending invite past its expiry", async () => {
      const { svc, query } = makeService({
        invitationRow: {
          id: "inv-1",
          organization_id: "org-1",
          email: "bob@example.com",
          role: "qa_engineer",
          status: "pending",
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          project_ids: []
        }
      });
      await expectRejection(svc.getInvitationRowOrThrow("raw-token"), BadRequestException, {
        error: "This invitation has expired. Ask the sender to resend it."
      });
      const expireCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE invitations SET status = 'expired'"));
      expect(expireCall).toBeDefined();
      expect(expireCall![1]).toEqual(["inv-1"]);
    });

    it("returns the invitation row for a valid, pending, unexpired token", async () => {
      const row = {
        id: "inv-1",
        organization_id: "org-1",
        email: "bob@example.com",
        role: "qa_engineer",
        status: "pending",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        project_ids: []
      };
      const { svc } = makeService({ invitationRow: row });
      await expect(svc.getInvitationRowOrThrow("raw-token")).resolves.toEqual(row);
    });
  });

  describe("acceptInvitation", () => {
    const PENDING_ROW = {
      id: "inv-1",
      organization_id: "org-1",
      email: "bob@example.com",
      role: "qa_engineer",
      status: "pending",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      project_ids: ["proj-1"]
    };

    it("adds the accepting user to the org and their scoped projects, then marks the invite accepted", async () => {
      const { svc, txQuery } = makeService({ invitationRow: PENDING_ROW, userEmail: "bob@example.com" });
      const result = await svc.acceptInvitation("user-9", "raw-token");
      expect(result).toEqual({ accepted: true, organizationId: "org-1" });

      const calls = txQuery.mock.calls.map((c) => String(c[0]));
      expect(calls.some((sql) => sql.includes("INSERT INTO organization_members"))).toBe(true);
      expect(calls.some((sql) => sql.includes("INSERT INTO project_members"))).toBe(true);
      expect(calls.some((sql) => sql.includes("UPDATE invitations SET status = 'accepted'"))).toBe(true);
      expect(calls.some((sql) => sql.includes("UPDATE users SET active_organization_id"))).toBe(true);

      const orgMemberCall = txQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO organization_members"));
      expect(orgMemberCall![1]).toEqual(["org-1", "user-9", "qa_engineer"]);
      const projectMemberCall = txQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO project_members"));
      expect(projectMemberCall![1]).toEqual(["proj-1", "user-9", "qa_engineer"]);
    });

    it("404s for an unknown token", async () => {
      const { svc } = makeService({ invitationRow: null });
      await expectRejection(svc.acceptInvitation("user-9", "bogus"), NotFoundException, {
        error: "Invitation not found or token is invalid"
      });
    });

    it("rejects a cancelled invitation", async () => {
      const { svc } = makeService({ invitationRow: { ...PENDING_ROW, status: "cancelled" }, userEmail: "bob@example.com" });
      await expectRejection(svc.acceptInvitation("user-9", "raw-token"), BadRequestException, {
        error: "This invitation has been cancelled"
      });
    });

    it("rejects an already-accepted invitation", async () => {
      const { svc } = makeService({ invitationRow: { ...PENDING_ROW, status: "accepted" }, userEmail: "bob@example.com" });
      await expectRejection(svc.acceptInvitation("user-9", "raw-token"), BadRequestException, {
        error: "This invitation has already been accepted"
      });
    });

    it("rejects an expired invitation", async () => {
      const { svc } = makeService({
        invitationRow: { ...PENDING_ROW, expires_at: new Date(Date.now() - 60_000).toISOString() },
        userEmail: "bob@example.com"
      });
      await expectRejection(svc.acceptInvitation("user-9", "raw-token"), BadRequestException, {
        error: "This invitation has expired. Ask the sender to resend it."
      });
    });

    it("rejects acceptance from a user signed in under a different email", async () => {
      const { svc, txQuery } = makeService({ invitationRow: PENDING_ROW, userEmail: "someone-else@example.com" });
      await expectRejection(svc.acceptInvitation("user-9", "raw-token"), ForbiddenException, {
        error: "You must sign in with the invited email address to accept this invite"
      });
      expect(txQuery).not.toHaveBeenCalled();
    });
  });
});
