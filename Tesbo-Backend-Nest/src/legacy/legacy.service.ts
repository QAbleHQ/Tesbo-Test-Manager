import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";

type Body = Record<string, any>;

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toCamel<T extends QueryResultRow>(row: T): Body {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "workspace";
}

function projectKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 16) || "TESBO";
}

@Injectable()
export class LegacyService {
  constructor(private readonly db: DatabaseService) {}

  private requireUser(userId?: string | null): string {
    if (!userId) throw new BadRequestException({ error: "Authentication required" });
    return userId;
  }

  async createWorkspace(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const name = String(body.orgName || body.name || "").trim();
    if (!name) throw new BadRequestException({ error: "orgName is required" });
    const res = await this.db.transaction(async (client) => {
      const org = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        [name, slugify(name)]
      );
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
        [org.rows[0].id, uid]
      );
      return org.rows[0].id;
    });
    return { organizationId: res };
  }

  async createOrgAndProject(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const orgName = String(body.orgName || "").trim();
    const name = String(body.projectName || body.name || "").trim();
    if (!orgName || !name) throw new BadRequestException({ error: "orgName and projectName are required" });
    const key = projectKey(String(body.projectKey || name));
    return this.db.transaction(async (client) => {
      const org = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        [orgName, slugify(orgName)]
      );
      await client.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [
        org.rows[0].id,
        uid
      ]);
      const project = await client.query<{ id: string }>(
        `INSERT INTO projects (organization_id, key, name, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [org.rows[0].id, key, name, body.projectDescription || body.description || ""]
      );
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [
        project.rows[0].id,
        uid
      ]);
      await client.query("UPDATE users SET default_project_id = $1, updated_at = now() WHERE id = $2", [project.rows[0].id, uid]);
      return { organizationId: org.rows[0].id, projectId: project.rows[0].id, projectKey: key };
    });
  }

  async workspace(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const res = await this.db.query(
      `SELECT o.id, o.name, o.slug, om.role, o.created_at
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE om.user_id = $1
       ORDER BY o.created_at ASC LIMIT 1`,
      [uid]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Workspace not found" });
    return toCamel(res.rows[0]);
  }

  async workspaceMembers(userId: string | null | undefined) {
    const workspace = await this.workspace(userId);
    const res = await this.db.query(
      `SELECT u.id AS user_id, u.email, COALESCE(u.name, '') AS name, om.role, om.created_at AS joined_at
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 ORDER BY u.email`,
      [workspace.id]
    );
    return res.rows.map(toCamel);
  }

  async addWorkspaceMember(userId: string | null | undefined, body: Body) {
    const workspace = await this.workspace(userId);
    const email = String(body.email || "").trim().toLowerCase();
    const target = String(body.userId || "").trim();
    const role = String(body.role || "member");
    if (!email && !target) throw new BadRequestException({ error: "email or userId is required" });
    const uid = target || (await this.upsertUser(email));
    await this.db.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [workspace.id, uid, role]
    );
  }

  async removeWorkspaceMember(userId: string | null | undefined, targetUserId: string) {
    const workspace = await this.workspace(userId);
    await this.db.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [workspace.id, targetUserId]);
  }

  async listProjects(userId: string | null | undefined) {
    const uid = this.requireUser(userId);
    const res = await this.db.query(
      `SELECT p.id, p.key, p.name, COALESCE(p.description, '') AS description,
              COALESCE(p.project_type, 'tesbox') AS project_type,
              COALESCE(pm.role, 'member') AS role, p.created_at
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = $1 AND p.archived_at IS NULL
       ORDER BY p.created_at DESC`,
      [uid]
    );
    return res.rows.map(toCamel);
  }

  async createProject(userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const name = String(body.name || "").trim();
    if (!name) throw new BadRequestException({ error: "name is required" });
    const workspace = await this.workspace(uid);
    const key = projectKey(String(body.key || name));
    const res = await this.db.transaction(async (client) => {
      const project = await client.query(
        `INSERT INTO projects (organization_id, key, name, description, project_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, key, name, project_type, created_at`,
        [workspace.id, key, name, body.description || "", body.projectType || "tesbox"]
      );
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [
        project.rows[0].id,
        uid
      ]);
      return project.rows[0];
    });
    return toCamel(res);
  }

  async getProject(id: string) {
    const res = await this.db.query("SELECT * FROM projects WHERE id = $1 AND archived_at IS NULL", [id]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Project not found" });
    return toCamel(res.rows[0]);
  }

  async updateProject(id: string, body: Body) {
    await this.db.query(
      `UPDATE projects SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       settings = COALESCE($4::jsonb, settings),
       updated_at = now()
       WHERE id = $1`,
      [id, body.name ?? null, body.description ?? null, body.settings ? JSON.stringify(body.settings) : null]
    );
  }

  async deleteProject(id: string) {
    await this.db.query("UPDATE projects SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
  }

  async projectMembers(projectId: string) {
    const res = await this.db.query(
      `SELECT u.id AS user_id, u.email, COALESCE(u.name, '') AS name, pm.role, pm.created_at AS joined_at
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY u.email`,
      [projectId]
    );
    return res.rows.map(toCamel);
  }

  async addProjectMember(projectId: string, body: Body) {
    if (!body.userId) throw new BadRequestException({ error: "userId is required" });
    await this.db.query(
      "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
      [projectId, body.userId, body.role || "member"]
    );
  }

  async removeProjectMember(projectId: string, userId: string) {
    await this.db.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
  }

  async listSuites(projectId: string) {
    const res = await this.db.query(
      `SELECT s.id, s.parent_id, s.name, s.position, s.created_at, COUNT(t.id)::int AS test_case_count
       FROM suites s LEFT JOIN testcases t ON t.suite_id = s.id
       WHERE s.project_id = $1
       GROUP BY s.id ORDER BY s.position, s.name`,
      [projectId]
    );
    return res.rows.map(toCamel);
  }

  async createSuite(projectId: string, body: Body) {
    const name = String(body.name || "").trim();
    if (!name) throw new BadRequestException({ error: "name is required" });
    const res = await this.db.query(
      "INSERT INTO suites (project_id, parent_id, name, position) VALUES ($1, $2, $3, $4) RETURNING id, parent_id, name, position, created_at",
      [projectId, body.parentId || null, name, Number(body.position || 0)]
    );
    return { ...toCamel(res.rows[0]), testCaseCount: 0 };
  }

  async updateSuite(suiteId: string, body: Body) {
    await this.db.query(
      "UPDATE suites SET name = COALESCE($2, name), parent_id = $3, position = COALESCE($4, position), updated_at = now() WHERE id = $1",
      [suiteId, body.name ?? null, body.parentId ?? null, body.position ?? null]
    );
  }

  async deleteSuite(suiteId: string, mode = "moveToDefault") {
    if (mode === "deleteTestcases") await this.db.query("DELETE FROM testcases WHERE suite_id = $1", [suiteId]);
    else await this.db.query("UPDATE testcases SET suite_id = NULL WHERE suite_id = $1", [suiteId]);
    await this.db.query("DELETE FROM suites WHERE id = $1", [suiteId]);
  }

  async listTestCases(projectId: string, query: Body) {
    const limit = Math.min(Number(query.limit || 100), 500);
    const offset = Number(query.offset || 0);
    const filters: string[] = ["project_id = $1"];
    const values: any[] = [projectId];
    for (const [param, column] of [
      ["suiteId", "suite_id"],
      ["status", "status"],
      ["priority", "priority"],
      ["type", "type"],
      ["automationStatus", "automation_status"]
    ] as const) {
      if (query[param]) {
        values.push(query[param]);
        filters.push(`${column} = $${values.length}`);
      }
    }
    if (query.search) {
      values.push(`%${String(query.search).toLowerCase()}%`);
      filters.push("(lower(title) LIKE $" + values.length + " OR lower(coalesce(description, '')) LIKE $" + values.length + ")");
    }
    const where = filters.join(" AND ");
    const total = await this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM testcases WHERE ${where}`, values);
    values.push(limit, offset);
    const res = await this.db.query(
      `SELECT id, external_id, title, priority, type, automation_status, automation_tags, status,
              suite_id, owner_id, updated_at, jira_issue_key, jira_url
       FROM testcases WHERE ${where}
       ORDER BY updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { rows: res.rows.map(toCamel), total: Number(total.rows[0]?.count || 0) };
  }

  async getTestCase(id: string) {
    const res = await this.db.query("SELECT * FROM testcases WHERE id = $1", [id]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    return toCamel(res.rows[0]);
  }

  async createTestCase(projectId: string, body: Body) {
    const externalId = body.externalId || (await this.nextExternalId(projectId));
    const res = await this.db.query(
      `INSERT INTO testcases
       (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data,
        priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name,
        automation_framework, automation_tags, owner_id, component, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id, external_id, title, created_at`,
      [
        projectId,
        body.suiteId || null,
        externalId,
        body.title || "Untitled test case",
        body.description || "",
        body.preconditions || "",
        body.postconditions || "",
        JSON.stringify(body.steps || body.stepsJson || []),
        body.testData || "",
        body.priority || "P2",
        body.severity || null,
        body.type || "Functional",
        body.automationStatus || "Not Automated",
        body.automationRepo || null,
        body.automationPath || null,
        body.automationTestName || null,
        body.automationFramework || null,
        body.automationTags || null,
        body.ownerId || null,
        body.component || null,
        body.status || "Draft"
      ]
    );
    return toCamel(res.rows[0]);
  }

  async updateTestCase(id: string, body: Body) {
    await this.db.query(
      `UPDATE testcases SET
       suite_id=$2, title=COALESCE($3,title), description=COALESCE($4,description),
       preconditions=COALESCE($5,preconditions), postconditions=COALESCE($6,postconditions),
       steps=COALESCE($7::jsonb,steps), test_data=COALESCE($8,test_data), priority=COALESCE($9,priority),
       severity=COALESCE($10,severity), type=COALESCE($11,type), automation_status=COALESCE($12,automation_status),
       automation_repo=COALESCE($13,automation_repo), automation_path=COALESCE($14,automation_path),
       automation_test_name=COALESCE($15,automation_test_name), automation_framework=COALESCE($16,automation_framework),
       automation_tags=COALESCE($17,automation_tags), owner_id=$18, component=COALESCE($19,component),
       status=COALESCE($20,status), updated_at=now()
       WHERE id=$1`,
      [
        id,
        body.suiteId ?? null,
        body.title ?? null,
        body.description ?? null,
        body.preconditions ?? null,
        body.postconditions ?? null,
        body.steps || body.stepsJson ? JSON.stringify(body.steps || body.stepsJson) : null,
        body.testData ?? null,
        body.priority ?? null,
        body.severity ?? null,
        body.type ?? null,
        body.automationStatus ?? null,
        body.automationRepo ?? null,
        body.automationPath ?? null,
        body.automationTestName ?? null,
        body.automationFramework ?? null,
        body.automationTags ?? null,
        body.ownerId ?? null,
        body.component ?? null,
        body.status ?? null
      ]
    );
  }

  async deleteTestCase(id: string) {
    await this.db.query("DELETE FROM testcases WHERE id = $1", [id]);
  }

  async bulkUpdateTestCases(body: Body) {
    const ids = Array.isArray(body.testcaseIds) ? body.testcaseIds : [];
    if (!ids.length) return;
    await this.db.query(
      `UPDATE testcases SET priority=COALESCE($2,priority), suite_id=COALESCE($3,suite_id),
       status=COALESCE($4,status), owner_id=COALESCE($5,owner_id), updated_at=now() WHERE id = ANY($1::uuid[])`,
      [ids, body.priority || null, body.suiteId || null, body.status || null, body.ownerId || null]
    );
  }

  async bulkDeleteTestCases(ids: string[]) {
    if (!ids.length) return;
    await this.db.query("DELETE FROM testcases WHERE id = ANY($1::uuid[])", [ids]);
  }

  async linkedJiraKeys(projectId: string) {
    const res = await this.db.query(
      "SELECT jira_issue_key, COUNT(*)::int AS count FROM testcases WHERE project_id = $1 AND jira_issue_key IS NOT NULL GROUP BY jira_issue_key",
      [projectId]
    );
    const keys = res.rows.map((r) => r.jira_issue_key);
    return { keys, counts: Object.fromEntries(res.rows.map((r) => [r.jira_issue_key, r.count])) };
  }

  async listPlans(projectId: string) {
    const res = await this.db.query("SELECT * FROM plans WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    return res.rows.map(toCamel);
  }

  async createPlan(projectId: string, body: Body) {
    const res = await this.db.query(
      "INSERT INTO plans (project_id, name, description, target_release, owner_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [projectId, body.name || "Untitled plan", body.description || "", body.targetRelease || null, body.ownerId || null]
    );
    return toCamel(res.rows[0]);
  }

  async getPlan(planId: string) {
    const res = await this.db.query("SELECT * FROM plans WHERE id = $1", [planId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Plan not found" });
    return toCamel(res.rows[0]);
  }

  async updatePlan(planId: string, body: Body) {
    await this.db.query(
      "UPDATE plans SET name=COALESCE($2,name), description=COALESCE($3,description), target_release=COALESCE($4,target_release), updated_at=now() WHERE id=$1",
      [planId, body.name || null, body.description || null, body.targetRelease || null]
    );
  }

  async deletePlan(planId: string) {
    await this.db.query("DELETE FROM plans WHERE id = $1", [planId]);
  }

  async planItems(planId: string) {
    const res = await this.db.query("SELECT * FROM plan_items WHERE plan_id = $1 ORDER BY position, created_at", [planId]);
    return res.rows.map(toCamel);
  }

  async addPlanItem(planId: string, body: Body) {
    const res = await this.db.query(
      "INSERT INTO plan_items (plan_id, suite_id, testcase_id, position) VALUES ($1,$2,$3,$4) RETURNING *",
      [planId, body.suiteId || null, body.testcaseId || null, body.position || 0]
    );
    return toCamel(res.rows[0]);
  }

  async deletePlanItem(itemId: string) {
    await this.db.query("DELETE FROM plan_items WHERE id = $1", [itemId]);
  }

  async listCycles(projectId: string) {
    const res = await this.db.query("SELECT * FROM cycles WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    return res.rows.map(toCamel);
  }

  async createCycle(projectId: string, body: Body) {
    const res = await this.db.query(
      `INSERT INTO cycles (project_id, plan_id, name, description, environment, build_version, release_name, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        projectId,
        body.planId || null,
        body.name || "Untitled cycle",
        body.description || "",
        body.environment || null,
        body.buildVersion || null,
        body.releaseName || null,
        body.ownerId || null
      ]
    );
    return toCamel(res.rows[0]);
  }

  async getCycle(cycleId: string) {
    const res = await this.db.query("SELECT * FROM cycles WHERE id = $1", [cycleId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Cycle not found" });
    return toCamel(res.rows[0]);
  }

  async updateCycle(cycleId: string, body: Body) {
    await this.db.query(
      `UPDATE cycles SET name=COALESCE($2,name), description=COALESCE($3,description),
       environment=COALESCE($4,environment), build_version=COALESCE($5,build_version),
       release_name=COALESCE($6,release_name), updated_at=now() WHERE id=$1`,
      [cycleId, body.name || null, body.description || null, body.environment || null, body.buildVersion || null, body.releaseName || null]
    );
  }

  async deleteCycle(cycleId: string) {
    await this.db.query("DELETE FROM cycles WHERE id = $1", [cycleId]);
  }

  async addCycleTestCases(cycleId: string, body: Body) {
    const ids = body.testcaseIds || (body.testcaseId ? [body.testcaseId] : []);
    for (const testcaseId of ids) {
      const tc = await this.db.query<{ title: string }>("SELECT title FROM testcases WHERE id = $1", [testcaseId]);
      if (!tc.rows[0]) continue;
      const item = await this.db.query<{ id: string }>(
        "INSERT INTO cycle_items (cycle_id, testcase_id, snapshot_title) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
        [cycleId, testcaseId, tc.rows[0].title]
      );
      if (item.rows[0]) {
        await this.db.query("INSERT INTO executions (cycle_item_id) VALUES ($1) ON CONFLICT DO NOTHING", [item.rows[0].id]);
      }
    }
  }

  async removeCycleTestCase(cycleId: string, testcaseId: string) {
    await this.db.query("DELETE FROM cycle_items WHERE cycle_id = $1 AND testcase_id = $2", [cycleId, testcaseId]);
  }

  async executions(cycleId: string) {
    const res = await this.db.query(
      `SELECT e.id, e.status, e.assignee_id, e.actual_result, e.executed_at, e.defect_key, e.defect_url,
              ci.id AS cycle_item_id, ci.testcase_id, ci.snapshot_title, t.external_id, t.priority, t.suite_id
       FROM cycle_items ci JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN testcases t ON t.id = ci.testcase_id
       WHERE ci.cycle_id = $1 ORDER BY ci.position, ci.created_at`,
      [cycleId]
    );
    return res.rows.map(toCamel);
  }

  async updateExecution(executionId: string, body: Body) {
    await this.db.query(
      `UPDATE executions SET status=COALESCE($2,status), assignee_id=$3, actual_result=COALESCE($4,actual_result),
       executed_at=CASE WHEN $2 IS NULL THEN executed_at ELSE now() END, defect_key=COALESCE($5,defect_key),
       defect_url=COALESCE($6,defect_url), updated_at=now() WHERE id=$1`,
      [executionId, body.status || null, body.assigneeId ?? null, body.actualResult || null, body.defectKey || null, body.defectUrl || null]
    );
  }

  async listBugs(projectId: string) {
    const res = await this.db.query("SELECT * FROM bugs WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    return res.rows.map(toCamel);
  }

  async createBug(projectId: string, userId: string | null | undefined, body: Body) {
    const res = await this.db.query(
      `INSERT INTO bugs (project_id, execution_id, testcase_id, cycle_id, title, description, external_url, status, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        projectId,
        body.executionId || null,
        body.testcaseId || null,
        body.cycleId || null,
        body.title || "Untitled bug",
        body.description || "",
        body.externalUrl || null,
        body.status || "Open",
        userId || null
      ]
    );
    return toCamel(res.rows[0]);
  }

  async getBug(bugId: string) {
    const res = await this.db.query("SELECT * FROM bugs WHERE id = $1", [bugId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Bug not found" });
    return toCamel(res.rows[0]);
  }

  async updateBug(bugId: string, body: Body) {
    await this.db.query(
      "UPDATE bugs SET title=COALESCE($2,title), description=COALESCE($3,description), external_url=COALESCE($4,external_url), status=COALESCE($5,status), updated_at=now() WHERE id=$1",
      [bugId, body.title || null, body.description || null, body.externalUrl || null, body.status || null]
    );
  }

  async deleteBug(bugId: string) {
    await this.db.query("DELETE FROM bugs WHERE id = $1", [bugId]);
  }

  async analytics(projectId?: string) {
    const suffix = projectId ? " WHERE project_id = $1" : "";
    const values = projectId ? [projectId] : [];
    const [projects, testcases, suites, plans, cycles, statuses] = await Promise.all([
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM projects${projectId ? " WHERE id = $1" : ""}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM testcases${suffix}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM suites${suffix}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM plans${suffix}`, values),
      this.db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM cycles${suffix}`, values),
      this.db.query<{ status: string; count: string }>(
        `SELECT e.status, COUNT(*) AS count FROM executions e JOIN cycle_items ci ON ci.id = e.cycle_item_id JOIN cycles c ON c.id = ci.cycle_id${
          projectId ? " WHERE c.project_id = $1" : ""
        } GROUP BY e.status`,
        values
      )
    ]);
    const executionStatus = Object.fromEntries(statuses.rows.map((r) => [r.status, Number(r.count)]));
    const executionTotal = Object.values(executionStatus).reduce((a: number, b) => a + Number(b), 0);
    return {
      projectCount: Number(projects.rows[0]?.count || 0),
      testCaseCount: Number(testcases.rows[0]?.count || 0),
      suiteCount: Number(suites.rows[0]?.count || 0),
      planCount: Number(plans.rows[0]?.count || 0),
      cycleCount: Number(cycles.rows[0]?.count || 0),
      executionStatus,
      executionTotal
    };
  }

  async repositorySummary(projectId: string) {
    const total = await this.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM testcases WHERE project_id = $1", [projectId]);
    const byStatus = await this.groupTestcases(projectId, "status");
    const byPriority = await this.groupTestcases(projectId, "priority");
    const bySuite = await this.db.query<{ name: string; count: string }>(
      `SELECT COALESCE(s.name, 'Unassigned') AS name, COUNT(t.id) AS count
       FROM testcases t LEFT JOIN suites s ON s.id = t.suite_id
       WHERE t.project_id = $1 GROUP BY s.name ORDER BY s.name`,
      [projectId]
    );
    return {
      totalTestCases: Number(total.rows[0]?.count || 0),
      bySuite: bySuite.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
      byStatus,
      byPriority,
      addedByDate: [],
      updatedToday: 0,
      updatedThisWeek: 0,
      updatedThisMonth: 0
    };
  }

  async listKnowledge(projectId: string, query: Body) {
    const values: any[] = [projectId];
    const filters = ["project_id = $1"];
    if (query.type) {
      values.push(query.type);
      filters.push(`item_type = $${values.length}`);
    }
    if (query.search) {
      values.push(`%${String(query.search).toLowerCase()}%`);
      filters.push(`(lower(title) LIKE $${values.length} OR lower(coalesce(content,'')) LIKE $${values.length})`);
    }
    const res = await this.db.query(`SELECT * FROM knowledge_base_items WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC`, values);
    return { list: res.rows.map(toCamel), total: res.rowCount };
  }

  async createKnowledge(projectId: string, userId: string | null | undefined, body: Body) {
    const res = await this.db.query(
      `INSERT INTO knowledge_base_items (project_id, item_type, title, content, created_by)
       VALUES ($1, 'note', $2, $3, $4) RETURNING *`,
      [projectId, body.title || "Untitled note", body.content || "", userId || null]
    );
    return toCamel(res.rows[0]);
  }

  async getKnowledge(itemId: string) {
    const res = await this.db.query("SELECT * FROM knowledge_base_items WHERE id = $1", [itemId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Knowledge base item not found" });
    return toCamel(res.rows[0]);
  }

  async updateKnowledge(itemId: string, body: Body) {
    await this.db.query(
      "UPDATE knowledge_base_items SET title=COALESCE($2,title), content=COALESCE($3,content), updated_at=now() WHERE id=$1",
      [itemId, body.title || null, body.content || null]
    );
  }

  async deleteKnowledge(itemId: string) {
    await this.db.query("DELETE FROM knowledge_base_items WHERE id = $1", [itemId]);
  }

  async adminCustomers() {
    const summary = await this.analytics();
    const customers = await this.db.query(
      `SELECT o.id, o.name, o.slug, o.created_at,
              COUNT(DISTINCT om.user_id)::int AS member_count,
              COUNT(DISTINCT p.id)::int AS project_count,
              COUNT(DISTINCT t.id)::int AS test_case_count,
              COUNT(DISTINCT t.id) FILTER (WHERE t.automation_status <> 'Not Automated')::int AS automated_count,
              MAX(GREATEST(o.updated_at, p.updated_at, t.updated_at)) AS last_activity_at
       FROM organizations o
       LEFT JOIN organization_members om ON om.organization_id = o.id
       LEFT JOIN projects p ON p.organization_id = o.id
       LEFT JOIN testcases t ON t.project_id = p.id
       GROUP BY o.id ORDER BY o.created_at DESC`
    );
    return {
      summary: {
        totalOrganizations: summary.projectCount,
        totalMembers: 0,
        totalProjects: summary.projectCount,
        totalTestCases: summary.testCaseCount,
        totalAutomated: 0,
        overallAutomationCoverage: 0
      },
      customers: customers.rows.map((row) => {
        const item = toCamel(row);
        const total = Number(item.testCaseCount || 0);
        const automated = Number(item.automatedCount || 0);
        return { ...item, automationCoverage: total ? Math.round((automated / total) * 100) : 0 };
      })
    };
  }

  async adminList() {
    const res = await this.db.query(
      `SELECT pa.id, pa.user_id, pa.role, u.email, u.name, u.avatar_url, pa.created_at
       FROM platform_admins pa JOIN users u ON u.id = pa.user_id ORDER BY pa.created_at`
    );
    return res.rows.map(toCamel);
  }

  async addAdmin(body: Body, grantedBy?: string | null) {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) throw new BadRequestException({ error: "email is required" });
    const uid = await this.upsertUser(email);
    const res = await this.db.query(
      "INSERT INTO platform_admins (user_id, role, granted_by) VALUES ($1, 'admin', $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role RETURNING id, user_id, role",
      [uid, grantedBy || null]
    );
    return { ...toCamel(res.rows[0]), email };
  }

  async deleteAdmin(adminId: string) {
    await this.db.query("DELETE FROM platform_admins WHERE id = $1 AND role <> 'owner'", [adminId]);
  }

  async genericEmptyList() {
    return [];
  }

  async jiraStatus() {
    return { connected: false, connectedProjects: [] };
  }

  async aiGenerate() {
    return {
      generationRequestId: randomBytes(16).toString("hex"),
      provider: "openai",
      drafts: [],
      generatedCount: 0
    };
  }

  private async upsertUser(email: string): Promise<string> {
    const res = await this.db.query<{ id: string }>(
      "INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id",
      [email, email.split("@")[0]]
    );
    return res.rows[0].id;
  }

  private async nextExternalId(projectId: string): Promise<string> {
    const project = await this.db.query<{ key: string }>("SELECT key FROM projects WHERE id = $1", [projectId]);
    const key = project.rows[0]?.key || "TC";
    const count = await this.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM testcases WHERE project_id = $1", [projectId]);
    return `${key}-TC-${Number(count.rows[0]?.count || 0) + 1}`;
  }

  private async groupTestcases(projectId: string, column: string) {
    const res = await this.db.query<{ name: string; count: string }>(
      `SELECT COALESCE(${column}, 'Unspecified') AS name, COUNT(*) AS count FROM testcases WHERE project_id = $1 GROUP BY ${column}`,
      [projectId]
    );
    return res.rows.map((r) => ({ name: r.name, count: Number(r.count) }));
  }
}
