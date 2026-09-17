import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

/**
 * DB double that routes queries to a caller-supplied list of `{ match, rows | handler }` rules,
 * matched by substring against the SQL text (same style as linear-integration.spec.ts /
 * mcp.service.spec.ts / api-token.service.spec.ts — no real Postgres).
 */
type Route = { match: string; rows?: Record<string, unknown>[]; handler?: (params: unknown[]) => { rows: Record<string, unknown>[] } };

function makeDb(routes: Route[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (sql.includes(route.match)) {
        return Promise.resolve(route.handler ? route.handler(params) : { rows: route.rows ?? [] });
      }
    }
    return Promise.resolve({ rows: [] });
  });
  // Routes are matched the same way inside a transaction, so the double hands the callback a
  // client backed by the very same `query` fn — SAVEPOINT/RELEASE statements included.
  const transaction = jest.fn((fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  return { db: { query, transaction } as unknown as DatabaseService, query, calls };
}

/** Route for LegacyService#workspace()'s primary "active organization" lookup. */
function activeOrgRoute(row: Record<string, unknown> | null): Route {
  return { match: "JOIN organizations o ON o.id = u.active_organization_id", rows: row ? [row] : [] };
}

/** Route for LegacyService#workspace()'s self-heal fallback (earliest membership). */
function fallbackOrgRoute(row: Record<string, unknown> | null): Route {
  return { match: "ORDER BY o.created_at ASC LIMIT 1", rows: row ? [row] : [] };
}

/** Route matching the shared "UPDATE users SET active_organization_id = ..." write used by
 * both the workspace() self-heal path and switchWorkspace(). */
function activeOrgUpdateRoute(): Route {
  return { match: "UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", rows: [] };
}

function makeLegacy(db: DatabaseService): LegacyService {
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
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
    {} as unknown as CustomFieldsService
  );
}

/** Captures a rejected promise's error without a try/catch block at every call site. */
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

const ORG_1 = { id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "owner", created_at: "2024-01-01T00:00:00.000Z" };
const ORG_2_AS_QA = { id: "org-2", name: "Beta Inc", slug: "beta-inc", role: "qa_engineer", created_at: "2024-06-01T00:00:00.000Z" };

// removeWorkspaceMember/changeWorkspaceMemberRole validate targetUserId with isUuid() (see
// legacy.service.ts) — these tests previously used human-readable placeholder ids ("target-user",
// "ghost-user", ...), which meant every one of them was silently short-circuited by that guard
// (BadRequestException "userId is not a valid user id") before ever reaching the behaviour it
// claims to test. Real UUID-shaped ids here so each test exercises its actual assertion.
const OWNER_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const MANAGER_USER_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const TARGET_USER_ID = "aaaaaaaa-0000-0000-0000-000000000003";
const GHOST_USER_ID = "aaaaaaaa-0000-0000-0000-000000000004";
const SOLE_OWNER_USER_ID = "aaaaaaaa-0000-0000-0000-000000000005";
const CO_OWNER_USER_ID = "aaaaaaaa-0000-0000-0000-000000000006";
const OTHER_OWNER_USER_ID = "aaaaaaaa-0000-0000-0000-000000000007";
const NOT_A_UUID = "not-a-uuid-at-all";

describe("LegacyService — multi-workspace / organization switching", () => {
  describe("workspace() — resolving the active organization", () => {
    it("resolves the user's active organization along with their role in it", async () => {
      const { db, query } = makeDb([activeOrgRoute(ORG_1)]);
      const svc = makeLegacy(db);
      const result = await svc.workspace("user-1");
      expect(result).toEqual({ id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "owner", createdAt: "2024-01-01T00:00:00.000Z" });
      const activeCall = query.mock.calls.find((c) => String(c[0]).includes("JOIN organizations o ON o.id = u.active_organization_id"));
      expect(activeCall![1]).toEqual(["user-1"]);
    });

    it("self-heals when active_organization_id is unset/stale: falls back to the earliest membership and persists it", async () => {
      const { db, query } = makeDb([activeOrgRoute(null), fallbackOrgRoute(ORG_1), activeOrgUpdateRoute()]);
      const svc = makeLegacy(db);
      const result = await svc.workspace("user-1");
      expect(result.id).toBe("org-1");

      const updateCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE users SET active_organization_id"));
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual(["org-1", "user-1"]);
    });

    it("still returns the resolved workspace even when the self-heal write itself fails", async () => {
      const { db } = makeDb([
        activeOrgRoute(null),
        fallbackOrgRoute(ORG_1),
        { match: "UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", handler: () => { throw new Error("write failed"); } }
      ]);
      const svc = makeLegacy(db);
      await expect(svc.workspace("user-1")).resolves.toEqual(
        expect.objectContaining({ id: "org-1" })
      );
    });

    it("throws NotFoundException when the user belongs to zero organizations", async () => {
      const { db } = makeDb([activeOrgRoute(null), fallbackOrgRoute(null)]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.workspace("user-1"));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toEqual({ error: "Workspace not found" });
    });

    it("rejects when no authenticated user is supplied", async () => {
      const { db, query } = makeDb();
      const svc = makeLegacy(db);
      const err = await rejection(svc.workspace(null));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({ error: "Authentication required" });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("listWorkspaces() — enumerating a user's organizations", () => {
    it("lists every organization the user belongs to, flagging which one is active", async () => {
      const rows = [
        { id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "owner", is_active: true },
        { id: "org-2", name: "Beta Inc", slug: "beta-inc", role: "qa_engineer", is_active: false }
      ];
      const { db, query } = makeDb([{ match: "(o.id = u.active_organization_id) AS is_active", rows }]);
      const svc = makeLegacy(db);
      const result = await svc.listWorkspaces("user-1");
      expect(result).toEqual([
        { id: "org-1", name: "Acme Corp", slug: "acme-corp", role: "owner", isActive: true },
        { id: "org-2", name: "Beta Inc", slug: "beta-inc", role: "qa_engineer", isActive: false }
      ]);
      const listCall = query.mock.calls.find((c) => String(c[0]).includes("(o.id = u.active_organization_id) AS is_active"));
      expect(listCall![1]).toEqual(["user-1"]);
    });

    it("returns an empty list for a user with zero organizations", async () => {
      const { db } = makeDb([{ match: "(o.id = u.active_organization_id) AS is_active", rows: [] }]);
      const svc = makeLegacy(db);
      await expect(svc.listWorkspaces("user-1")).resolves.toEqual([]);
    });
  });

  describe("switchWorkspace() — changing the active organization", () => {
    it("switches the active organization when the caller is a member (happy path)", async () => {
      const { db, query } = makeDb([
        { match: "SELECT organization_id FROM organization_members WHERE organization_id = $1 AND user_id = $2", rows: [{ organization_id: "org-2" }] },
        activeOrgUpdateRoute(),
        activeOrgRoute(ORG_2_AS_QA)
      ]);
      const svc = makeLegacy(db);
      const result = await svc.switchWorkspace("user-1", "org-2");
      expect(result).toEqual(expect.objectContaining({ id: "org-2", role: "qa_engineer" }));

      const memberCheck = query.mock.calls.find((c) =>
        String(c[0]).includes("SELECT organization_id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
      );
      expect(memberCheck![1]).toEqual(["org-2", "user-1"]);

      const updateCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE users SET active_organization_id"));
      expect(updateCall![1]).toEqual(["org-2", "user-1"]);
    });

    it("rejects switching to an organization the caller is not a member of", async () => {
      const { db, query } = makeDb([
        { match: "SELECT organization_id FROM organization_members WHERE organization_id = $1 AND user_id = $2", rows: [] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.switchWorkspace("user-1", "org-999"));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({ error: "You are not a member of this workspace" });
      // Never writes the active org if membership isn't confirmed.
      expect(query.mock.calls.some((c) => String(c[0]).includes("UPDATE users SET active_organization_id"))).toBe(false);
    });
  });

  describe("role resolution differs per organization for the same user", () => {
    it("the same user resolves to 'owner' in one org and 'qa_engineer' in another, depending on which is active", async () => {
      const { db: dbOwner } = makeDb([activeOrgRoute(ORG_1)]);
      const asOwner = await makeLegacy(dbOwner).workspace("user-1");
      expect(asOwner.role).toBe("owner");

      const { db: dbQa } = makeDb([activeOrgRoute(ORG_2_AS_QA)]);
      const asQa = await makeLegacy(dbQa).workspace("user-1");
      expect(asQa.role).toBe("qa_engineer");
    });
  });

  describe("workspaceMembers() — listing members of the active org", () => {
    it("lists members scoped to the caller's active organization", async () => {
      const memberRows = [
        { user_id: "user-1", email: "alice@example.com", name: "Alice", role: "owner", joined_at: "2024-01-01T00:00:00.000Z" },
        { user_id: "user-2", email: "bob@example.com", name: "Bob", role: "qa_engineer", joined_at: "2024-02-01T00:00:00.000Z" }
      ];
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "FROM organization_members om JOIN users u ON u.id = om.user_id", rows: memberRows }
      ]);
      const svc = makeLegacy(db);
      const result = await svc.workspaceMembers("user-1");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expect.objectContaining({ userId: "user-1", role: "owner" }));

      const membersCall = query.mock.calls.find((c) => String(c[0]).includes("FROM organization_members om JOIN users u ON u.id = om.user_id"));
      expect(membersCall![1]).toEqual(["org-1"]);
    });
  });

  describe("removeWorkspaceMember() — leaving/removal guardrails", () => {
    it("lets the owner remove a non-owner member", async () => {
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "qa_engineer" }] },
        { match: "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", rows: [] }
      ]);
      const svc = makeLegacy(db);
      await svc.removeWorkspaceMember(OWNER_USER_ID, TARGET_USER_ID);
      const deleteCall = query.mock.calls.find((c) => String(c[0]).includes("DELETE FROM organization_members"));
      expect(deleteCall![1]).toEqual(["org-1", TARGET_USER_ID]);
    });

    it("rejects a caller trying to remove themselves", async () => {
      const { db, query } = makeDb([activeOrgRoute(ORG_1)]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.removeWorkspaceMember(OWNER_USER_ID, OWNER_USER_ID));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({ error: "You cannot remove yourself" });
      // Short-circuits before ever checking membership rows or deleting.
      expect(query.mock.calls.some((c) => String(c[0]).includes("om.role, u.email FROM organization_members"))).toBe(false);
    });

    it("404s when the target is not a member of the workspace", async () => {
      const { db } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.removeWorkspaceMember(OWNER_USER_ID, GHOST_USER_ID));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toEqual({ error: "Member not found" });
    });

    it("refuses to remove the sole owner of the workspace (last-owner protection)", async () => {
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "owner" }] },
        { match: "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = $1 AND role = 'owner'", rows: [{ count: "1" }] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.removeWorkspaceMember(OWNER_USER_ID, SOLE_OWNER_USER_ID));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({ error: "Cannot remove the last owner" });
      expect(query.mock.calls.some((c) => String(c[0]).includes("DELETE FROM organization_members"))).toBe(false);
    });

    it("allows removing an owner when there is more than one owner in the workspace", async () => {
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "owner" }] },
        { match: "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = $1 AND role = 'owner'", rows: [{ count: "2" }] },
        { match: "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", rows: [] }
      ]);
      const svc = makeLegacy(db);
      await svc.removeWorkspaceMember(OWNER_USER_ID, CO_OWNER_USER_ID);
      const deleteCall = query.mock.calls.find((c) => String(c[0]).includes("DELETE FROM organization_members"));
      expect(deleteCall![1]).toEqual(["org-1", CO_OWNER_USER_ID]);
    });

    it("forbids a non-owner (manager) from removing team members", async () => {
      const { db, query } = makeDb([
        activeOrgRoute({ ...ORG_1, role: "manager" }),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "qa_engineer" }] },
        { match: "SELECT COUNT(*) AS count FROM organization_members WHERE organization_id = $1 AND role = 'owner'", rows: [{ count: "1" }] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.removeWorkspaceMember(MANAGER_USER_ID, TARGET_USER_ID));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({ error: "Only the owner can remove team members" });
      expect(query.mock.calls.some((c) => String(c[0]).includes("DELETE FROM organization_members"))).toBe(false);
    });

    it("rejects a malformed (non-UUID) target id with a 400, before any membership lookup — the one scenario the guard exists for", async () => {
      const { db, query } = makeDb([activeOrgRoute(ORG_1)]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.removeWorkspaceMember(OWNER_USER_ID, NOT_A_UUID));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({ error: "userId is not a valid user id" });
      expect(query.mock.calls.some((c) => String(c[0]).includes("om.role, u.email FROM organization_members"))).toBe(false);
    });
  });

  describe("changeWorkspaceMemberRole() — per-org role changes", () => {
    it("lets the owner change a member's role", async () => {
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "qa_engineer" }] },
        { match: "UPDATE organization_members SET role = $1 WHERE organization_id = $2 AND user_id = $3", rows: [] }
      ]);
      const svc = makeLegacy(db);
      await svc.changeWorkspaceMemberRole(OWNER_USER_ID, TARGET_USER_ID, "manager");
      const updateCall = query.mock.calls.find((c) => String(c[0]).includes("UPDATE organization_members SET role = $1"));
      expect(updateCall![1]).toEqual(["manager", "org-1", TARGET_USER_ID]);
    });

    it("forbids a non-owner from changing roles", async () => {
      const { db, query } = makeDb([activeOrgRoute({ ...ORG_1, role: "manager" })]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.changeWorkspaceMemberRole(MANAGER_USER_ID, TARGET_USER_ID, "qa_engineer"));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({ error: "Only the owner can change roles" });
      expect(query.mock.calls.some((c) => String(c[0]).includes("om.role, u.email FROM organization_members"))).toBe(false);
    });

    it("rejects the owner trying to change their own role", async () => {
      const { db } = makeDb([activeOrgRoute(ORG_1)]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.changeWorkspaceMemberRole(OWNER_USER_ID, OWNER_USER_ID, "manager"));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({ error: "You cannot change your own role" });
    });

    it("404s when the target member does not exist in the workspace", async () => {
      const { db } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.changeWorkspaceMemberRole(OWNER_USER_ID, GHOST_USER_ID, "manager"));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toEqual({ error: "Member not found" });
    });

    it("refuses to change another owner's role (owners are immutable via this path)", async () => {
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "owner" }] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.changeWorkspaceMemberRole(OWNER_USER_ID, OTHER_OWNER_USER_ID, "manager"));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({ error: "Owner role cannot be changed" });
      expect(query.mock.calls.some((c) => String(c[0]).includes("UPDATE organization_members SET role"))).toBe(false);
    });

    it("refuses to promote a member to owner through this endpoint", async () => {
      const { db, query } = makeDb([
        activeOrgRoute(ORG_1),
        { match: "om.role, u.email FROM organization_members om JOIN users u ON u.id = om.user_id", rows: [{ role: "qa_engineer" }] }
      ]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.changeWorkspaceMemberRole(OWNER_USER_ID, TARGET_USER_ID, "owner"));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toEqual({ error: "Cannot promote to owner" });
      expect(query.mock.calls.some((c) => String(c[0]).includes("UPDATE organization_members SET role"))).toBe(false);
    });

    it("rejects a malformed (non-UUID) target id with a 400, before any membership lookup — the one scenario the guard exists for", async () => {
      const { db } = makeDb([activeOrgRoute(ORG_1)]);
      const svc = makeLegacy(db);
      const err = await rejection(svc.changeWorkspaceMemberRole(OWNER_USER_ID, NOT_A_UUID, "manager"));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({ error: "userId is not a valid user id" });
    });
  });

  describe("createWorkspace() — workspace names are not globally unique", () => {
    /** Routes the org INSERT through a real-ish unique index on `slug`, seeded with `taken`. */
    function orgInsertRoute(taken: string[]) {
      const slugs = new Set(taken);
      let created = 0;
      return {
        route: {
          match: "INSERT INTO organizations",
          handler: (params: unknown[]) => {
            const slug = String(params[1]);
            if (slugs.has(slug)) throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
            slugs.add(slug);
            created += 1;
            return { rows: [{ id: "org-new" }] };
          }
        } as Route,
        createdCount: () => created
      };
    }

    it("creates the workspace on the bare slug when the name is unclaimed", async () => {
      const insert = orgInsertRoute([]);
      const { db, calls } = makeDb([insert.route]);
      const svc = makeLegacy(db);

      await expect(svc.createWorkspace("user-1", { orgName: "Acme Corp" })).resolves.toEqual({ organizationId: "org-new" });
      const slug = calls.find((c) => c.sql.includes("INSERT INTO organizations"))!.params[1];
      expect(slug).toBe("acme-corp");
    });

    it("still creates the workspace when another account already owns that name", async () => {
      const insert = orgInsertRoute(["acme-corp"]);
      const { db, calls } = makeDb([insert.route]);
      const svc = makeLegacy(db);

      await expect(svc.createWorkspace("user-2", { orgName: "Acme Corp" })).resolves.toEqual({ organizationId: "org-new" });

      const slugs = calls.filter((c) => c.sql.includes("INSERT INTO organizations")).map((c) => String(c.params[1]));
      expect(slugs[0]).toBe("acme-corp");
      expect(slugs[slugs.length - 1]).toMatch(/^acme-corp-[0-9a-f]{6}$/);
      expect(insert.createdCount()).toBe(1);
      // The owner row and the active-workspace pointer must still target the newly created org.
      const member = calls.find((c) => c.sql.includes("INSERT INTO organization_members"))!;
      expect(member.params).toEqual(["org-new", "user-2"]);
    });

    it("rolls back to a savepoint after a collision so the transaction stays usable", async () => {
      const insert = orgInsertRoute(["acme-corp"]);
      const { db, calls } = makeDb([insert.route]);
      const svc = makeLegacy(db);

      await svc.createWorkspace("user-2", { orgName: "Acme Corp" });

      const sql = calls.map((c) => c.sql);
      expect(sql).toContain("SAVEPOINT org_slug");
      expect(sql).toContain("ROLLBACK TO SAVEPOINT org_slug");
      expect(sql).toContain("RELEASE SAVEPOINT org_slug");
    });

    it("propagates non-unique-violation insert failures instead of retrying them", async () => {
      const { db, calls } = makeDb([
        {
          match: "INSERT INTO organizations",
          handler: () => {
            throw Object.assign(new Error("null value in column violates not-null constraint"), { code: "23502" });
          }
        }
      ]);
      const svc = makeLegacy(db);

      await expect(svc.createWorkspace("user-1", { orgName: "Acme Corp" })).rejects.toThrow("not-null constraint");
      expect(calls.filter((c) => c.sql.includes("INSERT INTO organizations"))).toHaveLength(1);
    });
  });
});
