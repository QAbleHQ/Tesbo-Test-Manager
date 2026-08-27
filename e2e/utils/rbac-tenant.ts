import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { request as pwRequest, type APIRequestContext } from "@playwright/test";
import { setProPlan } from "./billing-db";
import { emailDomain, env } from "./env";
import { hashPasswordForSeed } from "./password";
import { dbControlAvailable, exec, literal, scalar } from "./psql";

/*
 * Disposable multi-user workspaces for the permission suites.
 *
 * Why these can't share account A: every test here mutates membership — it promotes, demotes,
 * removes and re-adds users, and accepts invitations that repoint a user's active workspace. Account
 * A's role (owner) is load-bearing for most of the rest of the suite, so a half-finished permission
 * test there would fail unrelated files. The billing suites solved the same problem the same way;
 * this is that pattern generalised to "a workspace with one user per role".
 *
 * Why one tenant per spec file (the `kind` parameter): fullyParallel is false, so tests inside a
 * file are serialised, but different FILES still run concurrently across workers. Two files sharing
 * one workspace would interleave membership writes and fail each other non-deterministically.
 *
 * Why the tenant is put on Pro: the Launch ceiling is 2 projects, and several tests need a
 * throwaway project they're allowed to have archived. On Launch, project #3 is refused and projects
 * over the ceiling go read-only — both would show up as permission failures that aren't. Pro keeps
 * plan limits out of the results entirely, which is the billing suites' job, not this one's.
 *
 * Everything here is destructive to these workspaces and only these workspaces.
 */

/** One workspace per spec file. Add a kind here before pointing a new file at this factory. */
export type RbacTenantKind =
  | "rbac"
  | "invites"
  | "access"
  | "members-ui"
  | "setup"
  | "attachments"
  | "custom-fields"
  | "custom-field-values"
  | "custom-fields-ui"
  | "reports"
  | "reports-ui"
  | "import-export"
  | "import-export-ui"
  | "project-keys"
  // Wave 5 — Knowledge Base v2
  | "knowledge-base"
  | "kb-comments"
  | "kb-files"
  | "kb-ui"
  // Embeddings allocation + semantic retrieval. Its own tenant because it attaches and detaches
  // workspace AI keys, and the "zyra" / "ai-keys" tenants assert on their own key sets.
  | "kb-embeddings"
  // Wave 7 — execution bulk ops, schedules, share links
  | "exec-ops"
  // Wave 8 — integrations (Jira / Linear), authorization and validation layer
  | "integrations"
  // Wave 9 — Zyra, AI keys, MCP
  | "zyra"
  | "zyra-ui"
  | "ai-keys"
  // Wave 10 — the tail: notifications, activity, API keys, external report ingest
  | "notifications"
  | "api-keys"
  | "tesbo-reports"
  // Email delivery gating: needs an owner who can send an invite, in a workspace whose pending
  // invites nobody else clears mid-test (api/invitations.spec.ts clears its own tenant's).
  | "email-delivery"
  // The account screen and the forgot/reset-password flow. Its own tenant because both suites
  // CHANGE their user's password: run against a shared account and every later login — including
  // global-setup's on the next run — signs in with a password that no longer exists.
  | "account-ui"
  // The test case repository screen: absolute header counters (Total/Draft/Approved/Deprecated) and
  // the suite tree counts. A concurrent spec creating or deleting a case in the same project moves
  // those numbers mid-assertion, so this screen needs a project nobody else writes to.
  | "repo-ui"
  // The already-accepted invite → "Sign in" entry path into /login. Needs an invitation it can
  // actually redeem, and api/invitations.spec.ts clears its own tenant's pending invites in
  // beforeEach — sharing "invites" would delete this suite's token out from under it mid-test.
  | "invite-signin"
  // The activity / audit feed. Its assertions are about WHICH events exist and in what order, so any
  // other spec acting in the same project inserts events into the middle of them. The workspace-wide
  // feed is also owner-only and rolls up every project in the workspace, which makes a shared
  // workspace unusable here for the same reason.
  | "activity"
  // Zyra chat ↔ repository consistency. Separate from "zyra" because api/zyra.spec.ts owns that
  // tenant and these tests delete test cases out from under a stored transcript, which would change
  // what that file's assertions see.
  | "zyra-chat"
  // Bug assignee membership checks ("[Test Runs] Unable to assign test cases for execution"). Needs
  // a user who is in the workspace but not a project member (guest) to prove the assignee has to be
  // a member of the bug's own project, the same rule executions.assignee_id already enforces.
  | "bugs-assignee";

/** The three roles legacy.service.ts's normalizeRole() collapses every stored role into. */
export type RbacRole = "owner" | "manager" | "qa_engineer";

export interface RbacUser {
  userId: string;
  email: string;
}

export interface RbacTenant {
  kind: RbacTenantKind;
  organizationId: string;
  /** The fixture project all three role-holders belong to. */
  mainProjectId: string;
  /** A second project used for scoped-access tests. Only the owner is a member. */
  secondProjectId: string;
  owner: RbacUser;
  manager: RbacUser;
  qa: RbacUser;
  /** In the workspace, but deliberately not a member of any project. */
  guest: RbacUser;
}

const PASSWORD = "E2E-Rbac-Pass-9f3!";
const MAIN_PROJECT = "RBAC Main Project";
const SECOND_PROJECT = "RBAC Second Project";

function emailFor(kind: RbacTenantKind, who: string): string {
  return `e2e-${kind}-${who}@${emailDomain}`;
}

/** One reason string for every skip in these suites, or null when the tenant is usable. */
export function rbacSuiteSkipReason(tenant: RbacTenant | null): string | null {
  if (!tenant) {
    return (
      "needs a disposable multi-user workspace, which requires `docker compose exec postgres psql` " +
      "access to seed one user per role. Unavailable against a remote target."
    );
  }
  return null;
}

function seedUser(email: string, name: string): string {
  exec(
    `INSERT INTO users (email, name, password_hash) VALUES (${literal(email)}, ${literal(name)}, ` +
      `${literal(hashPasswordForSeed(PASSWORD))}) ` +
      "ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;",
  );
  return scalar(`SELECT id FROM users WHERE email = ${literal(email)};`);
}

/*
 * Both context builders below clear storageState explicitly.
 *
 * playwright.config.ts sets use.storageState to account A's session, and request.newContext()
 * inherits it — so a context created without this carries account A's cookie. That makes an
 * "anonymous" caller silently authenticated (a 200 where the test wanted a 401) and leaves a
 * role-scoped context holding two sessions at once. Both failure modes look like product bugs.
 */
const NO_SESSION = { cookies: [], origins: [] };

/**
 * Seeds a standalone user who belongs to no workspace, for the outsider and invitee cases.
 *
 * Their password is FIXTURE_PASSWORD, so loginAs() works on them like any tenant user.
 */
export function seedFixtureUser(email: string, name: string): RbacUser {
  return { email, userId: seedUser(email, name) };
}

/** The password every seeded fixture user shares. */
export const FIXTURE_PASSWORD = PASSWORD;

/** An API context authenticated as one of the tenant's users. Callers must dispose it. */
export async function loginAs(user: RbacUser): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: NO_SESSION });
  const res = await api.post("/api/auth/password/login", {
    data: { email: user.email, password: PASSWORD },
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    await api.dispose();
    throw new Error(`Could not sign in fixture user ${user.email}: ${res.status()} ${await res.text()}`);
  }
  return api;
}

/**
 * Signs a fixture user in and writes their session to a storage-state file, for the UI suites.
 *
 * A browser context can't be handed an APIRequestContext's cookies directly, so the session goes
 * via disk the same way global-setup's tenants do. The cookie is set on the API origin and read on
 * the web one, which works because a cookie's domain ignores the port — the same reason the billing
 * UI suite can reuse a state file its API-side sibling produced.
 */
export async function writeStorageState(user: RbacUser, label: string): Promise<string> {
  const api = await loginAs(user);
  try {
    const file = path.join(__dirname, "../.auth", `state-${label}.json`);
    await api.storageState({ path: file });
    return file;
  } finally {
    await api.dispose();
  }
}

/** A context with no session at all, for the "unauthenticated caller" axis. */
export async function anonymousContext(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: NO_SESSION });
}

async function findOrCreateProject(api: APIRequestContext, name: string): Promise<string> {
  const listRes = await api.get("/api/projects");
  if (!listRes.ok()) throw new Error(`Could not list projects: ${listRes.status()} ${await listRes.text()}`);
  const body = await listRes.json();
  const projects: any[] = Array.isArray(body) ? body : (body.projects ?? body.data ?? []);
  const existing = projects.find((p) => p.name === name);
  if (existing) return existing.id;

  const createRes = await api.post("/api/projects", { data: { name }, failOnStatusCode: false });
  if (!createRes.ok()) {
    throw new Error(`Could not create fixture project "${name}": ${createRes.status()} ${await createRes.text()}`);
  }
  return (await createRes.json()).id;
}

/**
 * Sets a workspace role directly in Postgres and points the user's active workspace at it.
 *
 * Exported because some states can't be arranged through the API at all: promotion to owner is
 * explicitly refused (changeWorkspaceMemberRole), so "a workspace with two owners" — the only way
 * to reach the last-owner guard — has to be written directly.
 */
export function setOrgRole(organizationId: string, userId: string, role: RbacRole): void {
  exec(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES (${literal(organizationId)}, ` +
      `${literal(userId)}, ${literal(role)}) ` +
      "ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;",
  );
  exec(
    `UPDATE users SET active_organization_id = ${literal(organizationId)} WHERE id = ${literal(userId)};`,
  );
}

/**
 * Grants a project role directly in Postgres, bypassing the API gates that are themselves under
 * test. Arranging access through POST /projects/:id/members would make every test that needs a
 * fixture depend on the very permission check it is trying to verify.
 */
export function setProjectRole(projectId: string, userId: string, role: RbacRole): void {
  exec(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (${literal(projectId)}, ` +
      `${literal(userId)}, ${literal(role)}) ` +
      "ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role;",
  );
}

/**
 * Drops a workspace membership directly, for simulating a change made in another session while a
 * page is already open. The API route can't be used: it needs an owner's session, and doing it
 * through the UI under test is what the test is trying to race against.
 */
export function removeOrgMember(tenant: RbacTenant, userId: string): void {
  exec(
    `DELETE FROM organization_members WHERE organization_id = ${literal(tenant.organizationId)} ` +
      `AND user_id = ${literal(userId)};`,
  );
}

function removeProjectRole(projectId: string, userId: string): void {
  exec(
    `DELETE FROM project_members WHERE project_id = ${literal(projectId)} AND user_id = ${literal(userId)};`,
  );
}

const cache = new Map<RbacTenantKind, RbacTenant | null>();

/**
 * Provisions (or re-resolves) this spec file's workspace: one owner, one manager, one QA engineer,
 * one workspace member with no project access, and two projects.
 *
 * Returns null — rather than throwing — when Postgres isn't reachable, so the caller can skip
 * cleanly instead of failing the whole file. Idempotent: safe to re-run against a persistent volume.
 */
export async function provisionRbacTenant(kind: RbacTenantKind): Promise<RbacTenant | null> {
  if (cache.has(kind)) return cache.get(kind)!;
  if (!dbControlAvailable()) {
    cache.set(kind, null);
    return null;
  }

  const owner: RbacUser = { email: emailFor(kind, "owner"), userId: "" };
  const manager: RbacUser = { email: emailFor(kind, "manager"), userId: "" };
  const qa: RbacUser = { email: emailFor(kind, "qa"), userId: "" };
  const guest: RbacUser = { email: emailFor(kind, "guest"), userId: "" };

  owner.userId = seedUser(owner.email, `E2E ${kind} Owner`);
  manager.userId = seedUser(manager.email, `E2E ${kind} Manager`);
  qa.userId = seedUser(qa.email, `E2E ${kind} QA`);
  guest.userId = seedUser(guest.email, `E2E ${kind} Guest`);

  const ownerApi = await loginAs(owner);
  let organizationId: string;
  let mainProjectId: string;
  try {
    const wsRes = await ownerApi.get("/api/workspace", { failOnStatusCode: false });
    if (wsRes.status() === 404) {
      const res = await ownerApi.post("/api/onboarding/org-and-project", {
        data: { orgName: `E2E ${kind} Workspace`, projectName: MAIN_PROJECT },
        failOnStatusCode: false,
      });
      if (!res.ok()) {
        throw new Error(`Could not bootstrap the ${kind} workspace: ${res.status()} ${await res.text()}`);
      }
      const body = await res.json();
      organizationId = body.organizationId;
      mainProjectId = body.projectId;
    } else if (wsRes.ok()) {
      organizationId = (await wsRes.json()).id;
      mainProjectId = await findOrCreateProject(ownerApi, MAIN_PROJECT);
    } else {
      throw new Error(`Could not resolve the ${kind} workspace: ${wsRes.status()} ${await wsRes.text()}`);
    }

    // Pro before the second project, so the Launch 2-project ceiling can't refuse it on a re-run
    // where the workspace already exists.
    setProPlan(organizationId);

    const secondProjectId = await findOrCreateProject(ownerApi, SECOND_PROJECT);

    setOrgRole(organizationId, owner.userId, "owner");
    setOrgRole(organizationId, manager.userId, "manager");
    setOrgRole(organizationId, qa.userId, "qa_engineer");
    setOrgRole(organizationId, guest.userId, "qa_engineer");

    setProjectRole(mainProjectId, manager.userId, "manager");
    setProjectRole(mainProjectId, qa.userId, "qa_engineer");
    // The guest is deliberately left out of both projects.
    removeProjectRole(mainProjectId, guest.userId);
    removeProjectRole(secondProjectId, guest.userId);
    removeProjectRole(secondProjectId, manager.userId);
    removeProjectRole(secondProjectId, qa.userId);

    const tenant: RbacTenant = {
      kind,
      organizationId,
      mainProjectId,
      secondProjectId,
      owner,
      manager,
      qa,
      guest,
    };
    cache.set(kind, tenant);
    return tenant;
  } finally {
    await ownerApi.dispose();
  }
}

/**
 * Puts membership back to what provisionRbacTenant() established.
 *
 * Every test that touches roles calls this in its `finally`, because a leaked promotion doesn't
 * just dirty a fixture — it changes what the NEXT test is allowed to do, which turns one real
 * failure into a cascade of fake ones.
 */
export function resetRbacMembership(tenant: RbacTenant): void {
  setOrgRole(tenant.organizationId, tenant.owner.userId, "owner");
  setOrgRole(tenant.organizationId, tenant.manager.userId, "manager");
  setOrgRole(tenant.organizationId, tenant.qa.userId, "qa_engineer");
  setOrgRole(tenant.organizationId, tenant.guest.userId, "qa_engineer");

  setProjectRole(tenant.mainProjectId, tenant.owner.userId, "owner");
  setProjectRole(tenant.mainProjectId, tenant.manager.userId, "manager");
  setProjectRole(tenant.mainProjectId, tenant.qa.userId, "qa_engineer");
  removeProjectRole(tenant.mainProjectId, tenant.guest.userId);

  setProjectRole(tenant.secondProjectId, tenant.owner.userId, "owner");
  removeProjectRole(tenant.secondProjectId, tenant.manager.userId);
  removeProjectRole(tenant.secondProjectId, tenant.qa.userId);
  removeProjectRole(tenant.secondProjectId, tenant.guest.userId);

  // Drop anyone a test added who isn't one of the four fixture users, so a stray member can't
  // change a later test's owner-count or roster assertions.
  const fixtureIds = [tenant.owner, tenant.manager, tenant.qa, tenant.guest]
    .map((u) => literal(u.userId))
    .join(", ");
  exec(
    `DELETE FROM organization_members WHERE organization_id = ${literal(tenant.organizationId)} ` +
      `AND user_id NOT IN (${fixtureIds});`,
  );
}

/** The stored (un-normalized) workspace role, for asserting on what actually landed in the table. */
export function storedOrgRole(tenant: RbacTenant, userId: string): string {
  return scalar(
    `SELECT role FROM organization_members WHERE organization_id = ${literal(tenant.organizationId)} ` +
      `AND user_id = ${literal(userId)};`,
  );
}

/**
 * The stored workspace role for an email address, or "" when that address holds no membership
 * (including when no such user exists at all).
 *
 * Used by the registration tests, where the whole point is that a failed attempt left nothing
 * behind — so there may be no user id to look up. Passing an empty id to storedOrgRole would make
 * Postgres reject the uuid cast and fail the test for the wrong reason.
 */
export function orgRoleForEmail(tenant: RbacTenant, email: string): string {
  return scalar(
    `SELECT om.role FROM organization_members om JOIN users u ON u.id = om.user_id ` +
      `WHERE om.organization_id = ${literal(tenant.organizationId)} AND lower(u.email) = ${literal(email.toLowerCase())};`,
  );
}

/** The stored project role, or "" when the user isn't a member of that project. */
export function storedProjectRole(projectId: string, userId: string): string {
  return scalar(
    `SELECT role FROM project_members WHERE project_id = ${literal(projectId)} AND user_id = ${literal(userId)};`,
  );
}

export function orgMemberCount(tenant: RbacTenant): number {
  return Number(
    scalar(
      `SELECT COUNT(*) FROM organization_members WHERE organization_id = ${literal(tenant.organizationId)};`,
    ),
  );
}

/**
 * Replaces a pending invitation's token with one we know, and returns the raw value.
 *
 * The API only ever returns the invitation's id — the raw token goes out by email and is stored as
 * a sha256 hash (legacy.service.ts's hashToken), so there is no way to read it back. Rather than
 * scrape a mailbox, these tests mint a token, write its hash the way the product would, and then
 * drive the real public endpoints with it.
 */
export function mintInviteToken(inviteId: string): string {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  exec(
    `UPDATE invitations SET token = ${literal(tokenHash)}, updated_at = now() WHERE id = ${literal(inviteId)};`,
  );
  return rawToken;
}

/** Forces a pending invitation to look expired, without waiting out its 7-day window. */
export function expireInvite(inviteId: string): void {
  exec(
    `UPDATE invitations SET expires_at = now() - interval '1 day', updated_at = now() ` +
      `WHERE id = ${literal(inviteId)};`,
  );
}

export function inviteStatus(inviteId: string): string {
  return scalar(`SELECT status FROM invitations WHERE id = ${literal(inviteId)};`);
}

/** Clears every invitation in this workspace, so counts and "already pending" checks start clean. */
export function clearInvitations(tenant: RbacTenant): void {
  exec(`DELETE FROM invitations WHERE organization_id = ${literal(tenant.organizationId)};`);
}

/**
 * Removes every membership a user picked up during a test, without deleting the user row.
 *
 * The row is left in place on purpose: activity entries reference actor_id, so deleting the user
 * would either trip a foreign key or silently take audit history with it. Membership is what the
 * permission checks read, and dropping that is enough to make the next run behave like the first —
 * "already a team member" is decided by organization_members, not by the users table.
 */
export function detachUserByEmail(email: string): void {
  exec(
    `DELETE FROM project_members WHERE user_id IN (SELECT id FROM users WHERE email = ${literal(email)});`,
  );
  exec(
    `DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = ${literal(email)});`,
  );
}
