import type { APIRequestContext } from "@playwright/test";
import { exec, literal, scalar } from "./psql";

/*
 * Bulk fixture builders for the aggregate-reporting suites (Wave 0, item 2).
 *
 * Why this module has to exist: every reports/analytics endpoint answers a question about TIME —
 * "the last 30 days", "since Monday", "the previous 7-day window", "the last 12 runs", "per week for
 * six weeks". The API offers no way to say when something happened: a run is stamped now() on
 * insert, an execution is stamped when its status changes. So a spec that wants to assert on a
 * six-week bug-discovery series, or on a run ordering that spans more than one day, has to write
 * those timestamps itself.
 *
 * The split is deliberate. Rows are CREATED through the real API, so the fixtures go through the
 * same insert paths the product uses (external-id allocation, the auto-created Untested execution
 * per added case, bug links) — and only their TIMESTAMPS are then rewritten in Postgres. Nothing
 * here fabricates a row shape the API can't produce, which is what keeps a passing report assertion
 * evidence about the product rather than about this file.
 *
 * Everything here is destructive to the project it is pointed at. Point it at a project this spec
 * file created, never at a shared one — purgeProject() deletes rather than archives.
 */

/** `now() - interval 'N days'` as SQL. N is truncated to an integer so it can never carry SQL. */
function daysAgoSql(days: number): string {
  return `now() - interval '${Math.trunc(days)} days'`;
}

/** `now() - interval 'N minutes'`, for "recent but not exactly now" stamps. */
function minutesAgoSql(minutes: number): string {
  return `now() - interval '${Math.trunc(minutes)} minutes'`;
}

export interface SeededCase {
  id: string;
  externalId: string;
  title: string;
}

export interface SeededRun {
  id: string;
  name: string;
}

export interface SeedCaseOptions {
  title: string;
  suiteId?: string | null;
  priority?: string;
  status?: string;
  automationTags?: string;
  /** Ids from the project's custom_tags catalog (see seedCustomTag below). */
  customTagIds?: string[];
  /** Backdates created_at (and updated_at with it, unless updatedDaysAgo says otherwise). */
  createdDaysAgo?: number;
  /** Backdates updated_at on its own, for the repository-summary "updated" windows. */
  updatedDaysAgo?: number;
}

/** Creates a project through the API and returns its id. */
export async function seedProject(api: APIRequestContext, name: string): Promise<string> {
  const res = await api.post("/api/projects", { data: { name }, failOnStatusCode: false });
  if (!res.ok()) throw new Error(`Could not create fixture project "${name}": ${res.status()} ${await res.text()}`);
  return (await res.json()).id;
}

export async function seedSuite(api: APIRequestContext, projectId: string, name: string): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/suites`, { data: { name }, failOnStatusCode: false });
  if (!res.ok()) throw new Error(`Could not create fixture suite "${name}": ${res.status()} ${await res.text()}`);
  return (await res.json()).id;
}

/** Creates a project custom tag through the API and returns its id. */
export async function seedCustomTag(api: APIRequestContext, projectId: string, name: string): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/custom-tags`, { data: { name }, failOnStatusCode: false });
  if (!res.ok()) throw new Error(`Could not create fixture custom tag "${name}": ${res.status()} ${await res.text()}`);
  return (await res.json()).id;
}

export async function seedPlan(api: APIRequestContext, projectId: string, name: string): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/plans`, { data: { name }, failOnStatusCode: false });
  if (!res.ok()) throw new Error(`Could not create fixture plan "${name}": ${res.status()} ${await res.text()}`);
  return (await res.json()).id;
}

export async function seedTestCase(
  api: APIRequestContext,
  projectId: string,
  opts: SeedCaseOptions,
): Promise<SeededCase> {
  const res = await api.post(`/api/projects/${projectId}/testcases`, {
    data: {
      title: opts.title,
      suiteId: opts.suiteId ?? null,
      priority: opts.priority ?? "P2",
      status: opts.status ?? "Draft",
      automationTags: opts.automationTags ?? null,
      customTagIds: opts.customTagIds,
    },
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`Could not create fixture test case "${opts.title}": ${res.status()} ${await res.text()}`);
  const body = await res.json();

  if (opts.createdDaysAgo !== undefined || opts.updatedDaysAgo !== undefined) {
    // created_at drags updated_at with it by default: a case "created 40 days ago" that still
    // carries today's updated_at would land in updatedToday and silently break the window
    // assertions it was seeded to stay out of.
    const created = opts.createdDaysAgo !== undefined ? daysAgoSql(opts.createdDaysAgo) : "created_at";
    const updated =
      opts.updatedDaysAgo !== undefined
        ? daysAgoSql(opts.updatedDaysAgo)
        : opts.createdDaysAgo !== undefined
          ? daysAgoSql(opts.createdDaysAgo)
          : "updated_at";
    exec(`UPDATE testcases SET created_at = ${created}, updated_at = ${updated} WHERE id = ${literal(body.id)};`);
  }

  return { id: body.id, externalId: String(body.externalId ?? ""), title: opts.title };
}

export async function seedRun(
  api: APIRequestContext,
  projectId: string,
  opts: { name: string; planId?: string | null; status?: string; createdDaysAgo?: number },
): Promise<SeededRun> {
  const res = await api.post(`/api/projects/${projectId}/cycles`, {
    data: { name: opts.name, planId: opts.planId ?? undefined },
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`Could not create fixture run "${opts.name}": ${res.status()} ${await res.text()}`);
  const body = await res.json();

  if (opts.status) {
    await api.patch(`/api/cycles/${body.id}`, { data: { status: opts.status }, failOnStatusCode: false });
  }
  if (opts.createdDaysAgo !== undefined) {
    // The pass-rate series orders runs by created_at and slices the tail, so runs seeded inside one
    // second would come back in an arbitrary order and make "the last 10 runs" untestable.
    exec(`UPDATE cycles SET created_at = ${daysAgoSql(opts.createdDaysAgo)} WHERE id = ${literal(body.id)};`);
  }
  return { id: body.id, name: opts.name };
}

/** Adds cases to a run, which auto-creates one Untested execution per case. */
export async function addRunCases(api: APIRequestContext, runId: string, testcaseIds: string[]): Promise<void> {
  const res = await api.post(`/api/cycles/${runId}/testcases`, { data: { testcaseIds }, failOnStatusCode: false });
  if (!res.ok()) throw new Error(`Could not add cases to run ${runId}: ${res.status()} ${await res.text()}`);
}

export interface SeededExecution {
  id: string;
  testcaseId: string;
  status: string;
}

export async function listRunExecutions(api: APIRequestContext, runId: string): Promise<SeededExecution[]> {
  const res = await api.get(`/api/cycles/${runId}/executions`, { failOnStatusCode: false });
  if (!res.ok()) throw new Error(`Could not list executions for run ${runId}: ${res.status()} ${await res.text()}`);
  return await res.json();
}

/**
 * Records a result on an execution, with control over when it was executed.
 *
 * Written straight to Postgres rather than through PATCH /api/cycles/:id/executions/:id because
 * that endpoint stamps executed_at = now() whenever status changes, and the whole point here is to
 * place results inside or outside the report windows. `status` is passed as a literal so the
 * "status outside the six known keys" case can be arranged too — the API accepts anything the
 * column takes, and the reports layer is what's supposed to normalise it.
 */
export function setExecutionResult(
  executionId: string,
  opts: { status: string; executedDaysAgo?: number; executedMinutesAgo?: number; assigneeId?: string | null },
): void {
  const executedAt =
    opts.executedDaysAgo !== undefined
      ? daysAgoSql(opts.executedDaysAgo)
      : opts.executedMinutesAgo !== undefined
        ? minutesAgoSql(opts.executedMinutesAgo)
        : "now()";
  const assignee = opts.assigneeId === undefined ? "assignee_id" : literal(opts.assigneeId);
  exec(
    `UPDATE executions SET status = ${literal(opts.status)}, executed_at = ${executedAt}, ` +
      `assignee_id = ${assignee}, updated_at = now() WHERE id = ${literal(executionId)};`,
  );
}

/**
 * The batched form of setExecutionResult, for fixtures that record dozens of results.
 *
 * Every psql helper shells out through `docker compose exec`, which costs a few hundred ms whatever
 * the statement is. A fixture spanning eleven runs pays that thirty-odd times if each result is its
 * own call, which is most of the file's setup budget. Statements are sent in one -c payload, so
 * Postgres also applies them as a single transaction — the fixture is never half-applied.
 */
export function setExecutionResults(
  entries: { executionId: string; status: string; executedDaysAgo?: number; assigneeId?: string | null }[],
): void {
  if (entries.length === 0) return;
  const statements = entries.map((entry) => {
    const executedAt = entry.executedDaysAgo !== undefined ? daysAgoSql(entry.executedDaysAgo) : "now()";
    const assignee = entry.assigneeId === undefined ? "assignee_id" : literal(entry.assigneeId);
    return (
      `UPDATE executions SET status = ${literal(entry.status)}, executed_at = ${executedAt}, ` +
      `assignee_id = ${assignee}, updated_at = now() WHERE id = ${literal(entry.executionId)};`
    );
  });
  exec(statements.join(" "));
}

/** Soft-deletes an execution the way the product's delete path does, for the *_active view tests. */
export function softDeleteExecution(executionId: string): void {
  exec(`UPDATE executions SET deleted_at = now() WHERE id = ${literal(executionId)};`);
}

export async function seedBug(
  api: APIRequestContext,
  projectId: string,
  opts: {
    title: string;
    severity?: string;
    status?: string;
    externalUrl?: string | null;
    links?: { executionId?: string; testcaseId?: string; cycleId?: string }[];
    createdDaysAgo?: number;
  },
): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/bugs`, {
    data: {
      title: opts.title,
      severity: opts.severity ?? "Medium",
      status: opts.status ?? "Open",
      externalUrl: opts.externalUrl ?? null,
      links: opts.links ?? [],
    },
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`Could not create fixture bug "${opts.title}": ${res.status()} ${await res.text()}`);
  const bugId = (await res.json()).id;
  if (opts.createdDaysAgo !== undefined) {
    exec(`UPDATE bugs SET created_at = ${daysAgoSql(opts.createdDaysAgo)} WHERE id = ${literal(bugId)};`);
  }
  return bugId;
}

/**
 * Empties a fixture project of everything the reports read, then archives the shell.
 *
 * Why not just `DELETE FROM projects`: audit_logs.project_id is ON DELETE SET NULL, and audit_logs
 * is append-only — migration V62 installs a trigger that rejects UPDATE outright. So the cascade
 * raises `audit_logs is append-only: UPDATE is not permitted` and the project row can never be
 * removed once anything has been audited against it. Its content, though, deletes cleanly, and
 * cycle_items/executions/bug_links follow by cascade.
 *
 * Why the content has to go at all rather than only archiving: an archived project keeps its rows,
 * so a suite re-run against the persistent volume would leave earlier runs' history behind for the
 * next run's "last 30 days" and "last 12 runs" assertions to trip over.
 *
 * Refuses any project whose name doesn't look like a fixture — the blast radius of getting this
 * wrong is a customer's entire project.
 */
export function purgeProject(projectId: string): void {
  const name = scalar(`SELECT name FROM projects WHERE id = ${literal(projectId)};`);
  if (!name) return;
  if (!name.startsWith("E2E ")) {
    throw new Error(`Refusing to purge project ${projectId} ("${name}") — it isn't an E2E fixture project.`);
  }
  const id = literal(projectId);
  // Ordered child-before-parent, per hard-delete remediation (V110-V117): cycle_items.cycle_id,
  // executions.cycle_item_id, bug_links.bug_id and plan_items.plan_id are all ON DELETE RESTRICT
  // now, not CASCADE — this used to rely on the cascade to clean up in any order at all.
  exec(
    [
      `DELETE FROM executions WHERE cycle_item_id IN (SELECT ci.id FROM cycle_items ci JOIN cycles c ON c.id = ci.cycle_id WHERE c.project_id = ${id});`,
      `DELETE FROM cycle_items WHERE cycle_id IN (SELECT id FROM cycles WHERE project_id = ${id});`,
      `DELETE FROM bug_links WHERE bug_id IN (SELECT id FROM bugs WHERE project_id = ${id});`,
      `DELETE FROM cycles WHERE project_id = ${id};`,
      `DELETE FROM plan_items WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ${id});`,
      `DELETE FROM plans WHERE project_id = ${id};`,
      `DELETE FROM bugs WHERE project_id = ${id};`,
      `DELETE FROM testcases WHERE project_id = ${id};`,
      `DELETE FROM custom_tags WHERE project_id = ${id};`,
      `DELETE FROM suites WHERE project_id = ${id};`,
      `UPDATE projects SET archived_at = now() WHERE id = ${id};`,
    ].join(" "),
  );
}
