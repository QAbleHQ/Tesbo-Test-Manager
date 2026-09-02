import { pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { request as pwRequest, type APIRequestContext } from "@playwright/test";
import { emailDomain, env } from "./env";
import { exec, execAllowingAuditImmutability, literal, scalar } from "./psql";

/*
 * The disposable tenant the screen-level suites own, plus the fixture builders they share.
 *
 * Why a tenant of its own rather than account A: these suites assert on the WHOLE projects list —
 * its order, its count, the parity between grid and list — and they need several projects alive at
 * once. Account A is Launch, PROJECT_LIMITS.launch is 2, and its smoke project already occupies one
 * of those slots. global-setup provisions this tenant and puts it on Pro (unlimited projects); if
 * that fails, the context file is absent and every consumer skips itself via screensSuiteSkipReason.
 *
 * Everything here is destructive to this workspace and only this workspace. Never point these
 * helpers at account A, whose project list other specs read.
 */

const AUTH_DIR = path.join(__dirname, "../.auth");
const CONTEXT_PATH = path.join(AUTH_DIR, "context-screens.json");
const STATE_PATH = path.join(AUTH_DIR, "state-screens.json");

export interface ScreensTenant {
  organizationId: string;
  /** The base project global-setup created. Suites treat it as scenery, never as their fixture. */
  projectId: string;
  email: string;
  /** Session state, loadable by an APIRequestContext or a browser context. */
  storageStatePath: string;
}

export function screensTenant(): ScreensTenant | null {
  if (!fs.existsSync(CONTEXT_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf-8"));
    if (!parsed?.organizationId || !parsed?.projectId) return null;
    return {
      organizationId: parsed.organizationId,
      projectId: parsed.projectId,
      email: parsed.email,
      storageStatePath: STATE_PATH,
    };
  } catch {
    return null;
  }
}

/** One reason string for every skip in these suites, or null when the tenant is usable. */
export function screensSuiteSkipReason(tenant: ScreensTenant | null): string | null {
  if (!tenant) {
    return (
      "needs the disposable screens tenant provisioned by global-setup (which requires " +
      "`docker compose exec postgres psql` access to put it on Pro for unlimited projects)"
    );
  }
  return null;
}

/** An API context authenticated as the screens tenant. Callers must dispose it. */
export function screensApi(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
}

/* ─────────────────────────── naming ─────────────────────────── */

/**
 * A fixture name nobody else will collide with.
 *
 * Re-runs share a persistent volume and different spec files run concurrently, so every fixture
 * carries both a timestamp and a per-call counter — Date.now() alone repeats when two fixtures are
 * built inside the same millisecond, which is routine when seeding a list of projects in a loop.
 */
let uniqueCounter = 0;
export function uniqueSuffix(): string {
  uniqueCounter += 1;
  return `${Date.now().toString().slice(-9)}${uniqueCounter % 10}`;
}

/** projects.key is UNIQUE(organization_id, key) and truncated to 16 chars — keep it short. */
export function uniqueKey(prefix = "SCR"): string {
  return `${prefix}${uniqueSuffix()}`.slice(0, 16);
}

/* ─────────────────────────── fixtures ─────────────────────────── */

export interface SeededProject {
  id: string;
  name: string;
  key: string;
}

export async function createProject(
  api: APIRequestContext,
  overrides: { name?: string; key?: string; description?: string } = {},
): Promise<SeededProject> {
  const suffix = uniqueSuffix();
  const name = overrides.name ?? `E2E Screens Project ${suffix}`;
  const key = overrides.key ?? uniqueKey();
  const res = await api.post("/api/projects", {
    data: { name, key, description: overrides.description ?? "", projectType: "tesbox" },
  });
  if (!res.ok()) {
    throw new Error(`Could not seed a project (${res.status()}): ${await res.text()}`);
  }
  const created = await res.json();
  return { id: created.id, name, key };
}

export async function deleteProjects(api: APIRequestContext, ids: (string | undefined)[]): Promise<void> {
  for (const id of ids) {
    if (id) await api.delete(`/api/projects/${id}`, { failOnStatusCode: false });
  }
}

export async function createTestCase(
  api: APIRequestContext,
  projectId: string,
  data: { title?: string; status?: string; priority?: string; suiteId?: string } = {},
): Promise<{ id: string; title: string }> {
  const title = data.title ?? `E2E Screens Case ${uniqueSuffix()}`;
  const res = await api.post(`/api/projects/${projectId}/testcases`, {
    data: { ...data, title },
  });
  const created = await res.json();
  return { id: created.id, title };
}

export async function createSuite(
  api: APIRequestContext,
  projectId: string,
  name = `E2E Screens Suite ${uniqueSuffix()}`,
): Promise<{ id: string; name: string }> {
  const res = await api.post(`/api/projects/${projectId}/suites`, { data: { name } });
  const created = await res.json();
  return { id: created.id, name };
}

export interface SeededPlan {
  id: string;
  name: string;
}

export async function createPlan(
  api: APIRequestContext,
  projectId: string,
  data: { name?: string; description?: string; targetRelease?: string } = {},
): Promise<SeededPlan> {
  const name = data.name ?? `E2E Screens Plan ${uniqueSuffix()}`;
  const res = await api.post(`/api/projects/${projectId}/plans`, { data: { ...data, name } });
  if (!res.ok()) throw new Error(`Could not seed a plan (${res.status()}): ${await res.text()}`);
  const created = await res.json();
  return { id: created.id, name };
}

export async function createBug(
  api: APIRequestContext,
  projectId: string,
  data: { title?: string; severity?: string; status?: string } = {},
): Promise<{ id: string; title: string }> {
  const title = data.title ?? `E2E Screens Bug ${uniqueSuffix()}`;
  const res = await api.post(`/api/projects/${projectId}/bugs`, {
    data: { ...data, title },
  });
  if (!res.ok()) throw new Error(`Could not seed a bug (${res.status()}): ${await res.text()}`);
  const created = await res.json();
  if (data.status && data.status !== created.status) {
    // Bugs are always created Open; anything else is a follow-up PATCH.
    await api.patch(`/api/bugs/${created.id}`, { data: { status: data.status } });
  }
  return { id: created.id, title };
}

export type ExecStatus = "Untested" | "Passed" | "Failed" | "Blocked" | "Skipped" | "Retest";

export interface SeededRun {
  cycleId: string;
  name: string;
  testcaseIds: string[];
  executionIds: string[];
}

/**
 * A run holding one test case per entry in `statuses`, each execution set to that status.
 *
 * Statuses are applied by matching each execution back to the test case it was created for rather
 * than by list position — GET /api/cycles/:id/executions has no ordering guarantee this can lean on.
 * "Untested" entries are left alone, since that's what adding a case to a run already produces.
 */
export async function seedRun(
  api: APIRequestContext,
  projectId: string,
  options: { statuses?: ExecStatus[]; name?: string; status?: string; planId?: string } = {},
): Promise<SeededRun> {
  const statuses = options.statuses ?? [];
  const name = options.name ?? `E2E Screens Run ${uniqueSuffix()}`;

  const cycle = await (
    await api.post(`/api/projects/${projectId}/cycles`, {
      data: { name, ...(options.planId ? { planId: options.planId } : {}) },
    })
  ).json();

  const testcaseIds: string[] = [];
  for (let i = 0; i < statuses.length; i++) {
    const testcase = await createTestCase(api, projectId, {
      title: `${name} Case ${i + 1}`,
      status: "Approved",
    });
    testcaseIds.push(testcase.id);
  }

  if (testcaseIds.length > 0) {
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });
  }

  const executions: { id: string; testcaseId: string }[] = await (
    await api.get(`/api/cycles/${cycle.id}/executions`)
  ).json();

  const executionIds: string[] = [];
  for (let i = 0; i < testcaseIds.length; i++) {
    const execution = executions.find((e) => e.testcaseId === testcaseIds[i]);
    if (!execution) continue;
    executionIds.push(execution.id);
    if (statuses[i] !== "Untested") {
      await api.patch(`/api/cycles/${cycle.id}/executions/${execution.id}`, {
        data: { status: statuses[i] },
      });
    }
  }

  if (options.status) {
    await api.patch(`/api/cycles/${cycle.id}`, { data: { status: options.status } });
  }

  return { cycleId: cycle.id, name, testcaseIds, executionIds };
}

/** Deletes a seeded run and the test cases it created, newest artefact first. */
export async function cleanupRun(
  api: APIRequestContext,
  projectId: string,
  run: SeededRun | undefined,
): Promise<void> {
  if (!run) return;
  await api.delete(`/api/cycles/${run.cycleId}`, { failOnStatusCode: false });
  for (const id of run.testcaseIds) {
    await api.delete(`/api/projects/${projectId}/testcases/${id}`, { failOnStatusCode: false });
  }
}

/**
 * Seeds `keys` as Jira requirements on a project, so coverage stops being permanently null.
 *
 * There is no API route in: requirements only ever arrive through an OAuth'd Jira/Linear sync, and
 * coverage is computed by joining jira_tickets to testcases on the issue key. So the tickets go in
 * through Postgres. The connection row is per-workspace (UNIQUE(organization_id, provider)) and
 * reused across calls; the tickets are per-project and cascade away when the project is deleted, so
 * a fixture project's teardown already cleans them up.
 *
 * Mark a requirement covered by creating a test case carrying the same `jiraIssueKey`.
 */
export function seedJiraRequirements(
  organizationId: string,
  projectId: string,
  keys: string[],
): void {
  exec(
    `INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at) ` +
      `VALUES (${literal(organizationId)}, 'jira', 'e2e-screens', 'https://e2e-screens.invalid', 'e2e', '', now() + interval '365 days') ` +
      `ON CONFLICT (organization_id, provider) DO NOTHING;`,
  );
  const connectionId = scalar(
    `SELECT id FROM integration_connections WHERE organization_id = ${literal(organizationId)} AND provider = 'jira';`,
  );
  if (!connectionId) throw new Error("Could not resolve the seeded Jira integration connection");

  const values = keys
    .map(
      (key) =>
        `(${literal(projectId)}, ${literal(connectionId)}, ${literal(key)}, ${literal(key)}, ` +
        `${literal(`Requirement ${key}`)}, 'Story', 'Open')`,
    )
    .join(", ");
  exec(
    `INSERT INTO jira_tickets (project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, issue_type, status) ` +
      `VALUES ${values} ON CONFLICT DO NOTHING;`,
  );
}

/** Backdates rows so the dashboard's 7-day and 14-day windows can be exercised without waiting. */
export function backdate(
  table: "testcases" | "executions",
  column: "created_at" | "executed_at",
  ids: string[],
  interval: string,
): void {
  if (ids.length === 0) return;
  const idList = ids.map((id) => literal(id)).join(", ");
  exec(`UPDATE ${table} SET ${column} = now() - interval '${interval}' WHERE id IN (${idList});`);
}

/** Soft-deletes executions the only way the product can — there is no DELETE route for them. */
export function softDeleteExecutions(ids: string[]): void {
  if (ids.length === 0) return;
  const idList = ids.map((id) => literal(id)).join(", ");
  exec(`UPDATE executions SET deleted_at = now() WHERE id IN (${idList});`);
}

/**
 * Adds a second user to the screens workspace with the given role, and signs them in.
 *
 * Role-gated UI — the owner-only Activity nav item, the create-project button's owner/admin/manager
 * check, a project list scoped by project_members — can't be exercised with one account, and there
 * is no API for "make me a workspace member with role X". So the user goes in through Postgres,
 * with a password hash in the same format PasswordService produces, and is then signed in over the
 * real login endpoint so the resulting session is genuine.
 *
 * The caller must pass the returned userId to removeWorkspaceMember in its teardown.
 */
export async function seedWorkspaceMember(
  organizationId: string,
  role: "member" | "admin" | "manager" | "viewer",
): Promise<{ email: string; password: string; userId: string; storageStatePath: string }> {
  const suffix = uniqueSuffix();
  const email = `e2e-screens-${role}-${suffix}@${emailDomain}`;
  const password = `E2eScreens${role}!2026`;

  // Mirrors Tesbo-Backend-Nest/src/auth/password.service.ts — pbkdf2_sha256, 210000, 32 bytes.
  const iterations = 210_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const passwordHash = `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;

  exec(
    `INSERT INTO users (email, name, password_hash, active_organization_id) ` +
      `VALUES (${literal(email)}, ${literal(`E2E Screens ${role}`)}, ${literal(passwordHash)}, ${literal(organizationId)});`,
  );
  const userId = scalar(`SELECT id FROM users WHERE email = ${literal(email)};`);
  if (!userId) throw new Error(`Could not seed the ${role} member`);

  exec(
    `INSERT INTO organization_members (organization_id, user_id, role) ` +
      `VALUES (${literal(organizationId)}, ${literal(userId)}, ${literal(role)});`,
  );

  const storageStatePath = path.join(AUTH_DIR, `state-screens-${role}-${suffix}.json`);
  const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl });
  try {
    const res = await api.post("/api/auth/password/login", { data: { email, password } });
    if (!res.ok()) {
      throw new Error(`Seeded the ${role} member but login failed: ${res.status()} ${await res.text()}`);
    }
    await api.storageState({ path: storageStatePath });
  } finally {
    await api.dispose();
  }

  return { email, password, userId, storageStatePath };
}

export function removeWorkspaceMember(userId: string | undefined, storageStatePath?: string): void {
  if (userId) execAllowingAuditImmutability(`DELETE FROM users WHERE id = ${literal(userId)};`);
  if (storageStatePath) fs.rmSync(storageStatePath, { force: true });
}

/** Grants an existing user access to a project, which is what makes it appear in their list. */
export async function addProjectMember(
  api: APIRequestContext,
  projectId: string,
  userId: string,
  role = "member",
): Promise<void> {
  const res = await api.post(`/api/projects/${projectId}/members`, { data: { userId, role } });
  if (!res.ok()) {
    throw new Error(`Could not add the project member (${res.status()}): ${await res.text()}`);
  }
}

export interface DashboardSummary {
  testCases: { total: number; addedThisWeek: number };
  passRate: { value: number | null; deltaThisWeek: number | null };
  executionProgress: { value: number };
  openBugs: { total: number; bySeverity: { Critical: number; High: number; Medium: number; Low: number } };
  coverage: { pct: number | null; totalRequirements: number };
  plans: number;
  suites: number;
  activeRuns: number;
}

export async function getDashboard(api: APIRequestContext, projectId: string): Promise<DashboardSummary> {
  const res = await api.get(`/api/projects/${projectId}/dashboard`);
  if (!res.ok()) throw new Error(`Dashboard fetch failed (${res.status()}): ${await res.text()}`);
  return res.json();
}

export interface RunListItem {
  id: string;
  name: string;
  status: string;
  totalCases: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
  createdAt: string;
}

export async function listRuns(api: APIRequestContext, projectId: string): Promise<RunListItem[]> {
  return (await api.get(`/api/projects/${projectId}/cycles`)).json();
}
