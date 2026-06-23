import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";

type Body = Record<string, any>;

function normalizeTestcaseIdPrefix(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

function parseSettings(raw: unknown): Body {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw as Body : {};
}

const ZYRA_AGENT_NAME = "Zyra the Test Generator";
const LEGACY_ZYRA_AGENT_NAME = "Zyra the Edge Hunter";
const ZYRA_AGENT_NAMES = [ZYRA_AGENT_NAME, LEGACY_ZYRA_AGENT_NAME];

type ZyraGenerationInput = {
  story: string;
  context: string;
  acceptanceCriteria: string;
  feedback: string;
  knowledge: Array<{ title: string; content: string }>;
  jira: Array<{ key: string; summary: string; description: string }>;
  existingTestcases: Array<{ externalId: string; title: string; description: string; priority: string; status: string; stepsSummary: string }>;
  requestedCount: number;
  testcaseRange?: string; // "minimum" | "1-10" | "10-30" | "all"
};

type ZyraAiUsage = {
  input: number;
  output: number;
  total: number;
  cached: number;
};

type ZyraAiResult = {
  drafts: Body[];
  usage: ZyraAiUsage;
  requestId?: string;
};

type ZyraChatDecision = {
  reply: string;
  reasoningSummary: string;
  actionType: "answer" | "create" | "update" | "archive" | "suite" | "mixed";
  operations: Array<{
    type: "create" | "update" | "archive" | "create_suite" | "move_to_suite";
    testcaseId?: string;
    externalId?: string;
    // move_to_suite: testcases to move (by external id and/or internal id), or every existing testcase
    externalIds?: string[];
    testcaseIds?: string[];
    allExisting?: boolean;
    // create_suite / move_to_suite target (suite is created by name when it does not exist yet)
    suiteName?: string;
    suiteId?: string;
    draft?: Body;
    fields?: Body;
    reason?: string;
  }>;
  testcases: Body[];
};

type ZyraChatIntent = "answer" | "example" | "list" | "create" | "update" | "archive" | "suite" | "jira_pending_testcases";

// Configurable Zyra capabilities (per project, stored under project.settings.zyraAgent.capabilities).
// All default to enabled so existing projects behave unchanged until a user turns one off.
type ZyraCapabilities = {
  generation: boolean;      // author/generate new testcases (chat "create" + task-board generation)
  knowledgeBase: boolean;   // read the project Knowledge Base into Zyra's context
  testcaseStorage: boolean; // write to the testcase repository: create / update / archive / bulk
  suiteOperations: boolean; // create suites and move/assign testcases into suites
};

type ZyraChatProjectSnapshot = {
  knowledgeCount: number;
  knowledgeTitles: string[];
  suites: Array<{ id: string; name: string; testCaseCount: number }>;
  testcaseCount: number;
  linkedJiraTestcaseCount: number;
  jiraConnected: boolean;
  jiraProjectCount: number;
  jiraTicketCount: number;
  pendingJiraTicketCount: number;
  lastJiraSyncAt: string | null;
};

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

function maskSecret(value: string): string {
  if (!value) return "********";
  const suffix = value.slice(-4);
  return `${"*".repeat(Math.max(8, Math.min(16, value.length - 4)))}${suffix}`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizeJsonArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function jiraDescriptionToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jiraDescriptionToText).filter(Boolean).join("\n");
  if (typeof value !== "object") return String(value);

  const node = value as Body;
  const parts: string[] = [];
  if (typeof node.text === "string") parts.push(node.text);
  if (Array.isArray(node.content)) parts.push(jiraDescriptionToText(node.content));
  return parts.filter(Boolean).join(node.type === "paragraph" ? "\n" : " ");
}

function normalizeProviderModel(provider: string, model?: string | null): string {
  const value = String(model || "").trim();
  if (provider === "anthropic") {
    const aliases: Record<string, string> = {
      "": "claude-sonnet-4-6",
      "claude-sonnet": "claude-sonnet-4-6",
      "claude-sonnet-4": "claude-sonnet-4-6",
      "claude-4-sonnet": "claude-sonnet-4-6",
      "sonnet": "claude-sonnet-4-6",
      "sonnet-4": "claude-sonnet-4-6",
      "claude-sonnet-4-20250514": "claude-sonnet-4-6",
      "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
      "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet": "claude-3-7-sonnet-20250219"
    };
    return aliases[value.toLowerCase()] || value;
  }
  return value || "gpt-4o";
}

function anthropicModelCandidates(model?: string | null): string[] {
  const normalized = normalizeProviderModel("anthropic", model);
  return Array.from(new Set([
    normalized,
    "claude-sonnet-4-6",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022"
  ].filter(Boolean)));
}

function normalizeChatCompletionsUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.openai.com/v1/chat/completions";
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function normalizeAnthropicMessagesUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.anthropic.com/v1/messages";
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

@Injectable()
export class LegacyService {
  constructor(private readonly db: DatabaseService) {}

  private requireUser(userId?: string | null): string {
    if (!userId) throw new BadRequestException({ error: "Authentication required" });
    return userId;
  }

  private async requirePlatformAdmin(userId?: string | null): Promise<string> {
    const uid = this.requireUser(userId);
    const result = await this.db.query("SELECT 1 FROM platform_admins WHERE user_id = $1 LIMIT 1", [uid]);
    if (!result.rows[0]) throw new ForbiddenException({ error: "Platform admin access required" });
    return uid;
  }

  private async logProjectActivity(projectId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, entityName: string | null, diff: Body) {
    await this.db.query(
      `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [projectId, actorId, action, entityType, entityId, entityName, JSON.stringify(diff)]
    ).catch(() => undefined);
  }

  private async zyraAiAllocation(projectId: string): Promise<{ key: Body | null; reason: string }> {
    const allocation = await this.db.query(
      `SELECT k.id, k.name, k.provider, k.default_model, k.base_url, k.auth_header_name, k.auth_scheme, k.is_active, k.api_key
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1`,
      [projectId]
    );
    const key = allocation.rows[0] || null;
    if (key?.is_active) return { key, reason: "Workspace AI key allocated to this project." };
    if (key && !key.is_active) return { key: null, reason: `AI key "${key.name}" is allocated to this project but is inactive.` };

    const project = await this.db.query("SELECT organization_id FROM projects WHERE id = $1", [projectId]);
    const organizationId = project.rows[0]?.organization_id;
    if (!organizationId) return { key: null, reason: "Project was not found while checking AI key allocation." };
    const workspaceKeys = await this.db.query(
      `SELECT provider, COUNT(*)::int AS count
       FROM workspace_ai_keys
       WHERE organization_id = $1 AND is_active = true
       GROUP BY provider`,
      [organizationId]
    );
    if (workspaceKeys.rows.length) {
      const providers = workspaceKeys.rows.map((row) => `${row.provider} (${row.count})`).join(", ");
      return { key: null, reason: `Active workspace AI key(s) exist (${providers}), but none is allocated to this project.` };
    }
    return { key: null, reason: "No active workspace AI key is available for this project." };
  }

  private buildAnthropicAuthHeaders(apiKey: string, authHeaderName: string | null, authScheme: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01"
    };
    // Strip any accidental "Bearer " prefix that may have been stored with the key
    const cleanKey = String(apiKey || "").replace(/^bearer\s+/i, "").trim();
    // "Authorization" is the legacy DB default for known providers — treat it the same as null.
    // Only respect a custom header name when the user explicitly set something non-standard.
    const hasCustomHeader = authHeaderName && authHeaderName.toLowerCase() !== "authorization";
    if (hasCustomHeader) {
      const scheme = authScheme ? String(authScheme).trim() : "";
      headers[String(authHeaderName)] = scheme ? `${scheme} ${cleanKey}` : cleanKey;
    } else {
      headers["x-api-key"] = cleanKey;
    }
    return headers;
  }

  private isProviderAuthError(status: number, message?: string): boolean {
    if (status === 401 || status === 403) return true;
    return /invalid x-api-key|authentication_error|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|permission_error|forbidden/i.test(String(message || ""));
  }

  // Turn a raw provider HTTP failure into a clear, actionable message for the user.
  // Returns "" when the failure isn't a recognized auth/permission/rate-limit case.
  private describeProviderError(provider: string, status: number, rawMessage?: string): string {
    const label = provider === "anthropic" ? "Anthropic (Claude)" : provider === "openai" ? "OpenAI" : (provider || "AI provider");
    const message = String(rawMessage || "");
    if (status === 401 || /invalid x-api-key|authentication_error|invalid[_ ]api[_ ]key|incorrect api key|unauthorized/i.test(message)) {
      return `The ${label} API key is invalid or has been revoked. Update it in Workspace → Integrations, then use "Test connection" to verify.`;
    }
    if (status === 403 || /permission_error|forbidden|does not have access|not allowed/i.test(message)) {
      return `The ${label} API key was rejected for permissions — check the account's plan, billing, or model access, then update the key in Workspace → Integrations.`;
    }
    if (status === 429 || /rate.?limit|overloaded|quota|insufficient_quota/i.test(message)) {
      return `${label} is rate-limited or out of quota right now. Wait a moment and retry, or check the account's usage limits.`;
    }
    return "";
  }

  // Pull a clean, user-facing message out of any thrown error (incl. Nest HttpException payloads).
  private extractAiErrorMessage(err: unknown): string {
    const anyErr = err as { getResponse?: () => unknown; message?: string };
    if (anyErr && typeof anyErr.getResponse === "function") {
      const resp = anyErr.getResponse();
      if (resp && typeof resp === "object") {
        const obj = resp as Record<string, unknown>;
        return String(obj.error || obj.message || anyErr.message || "AI request failed.");
      }
      if (typeof resp === "string") return resp;
    }
    return err instanceof Error ? err.message : String(err);
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

  async aiKeys(userId: string | null | undefined) {
    const workspace = await this.workspace(userId);
    const keys = await this.db.query(
      `SELECT id, name, provider, default_model, base_url, auth_header_name, auth_scheme,
              is_active AS active, api_key, created_at, updated_at
       FROM workspace_ai_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
      [workspace.id]
    );
    const projects = await this.db.query(
      `SELECT p.id AS project_id, p.key AS project_key, p.name AS project_name, a.workspace_ai_key_id
       FROM projects p
       LEFT JOIN project_ai_key_allocations a ON a.project_id = p.id
       WHERE p.organization_id = $1 AND p.archived_at IS NULL
       ORDER BY p.name`,
      [workspace.id]
    );
    return {
      keys: keys.rows.map((row) => {
        const item = toCamel(row);
        item.maskedKey = maskSecret(String(row.api_key || ""));
        delete item.apiKey;
        return item;
      }),
      projects: projects.rows.map(toCamel)
    };
  }

  async createAiKey(userId: string | null | undefined, body: Body) {
    const workspace = await this.workspace(userId);
    const name = String(body.name || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const provider = String(body.provider || "openai").trim().toLowerCase();
    const baseUrl = String(body.baseUrl || "").trim() || null;
    // For known providers (openai, anthropic) the auth method is well-defined by the SDK —
    // store null so the generation code can apply the correct provider-specific defaults.
    // Only custom providers need explicit auth_header_name / auth_scheme overrides.
    const isKnownProvider = ["openai", "anthropic"].includes(provider);
    const authHeaderName = isKnownProvider ? null : (String(body.authHeaderName || "").trim() || null);
    const authScheme = isKnownProvider ? null : (String(body.authScheme || "").trim() || null);
    if (!name) throw new BadRequestException({ error: "name is required" });
    if (!apiKey) throw new BadRequestException({ error: "apiKey is required" });
    if (!provider) throw new BadRequestException({ error: "provider is required" });
    if (!["openai", "anthropic"].includes(provider) && !baseUrl) {
      throw new BadRequestException({ error: "baseUrl is required for custom providers" });
    }
    const res = await this.db.query(
      `INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, default_model, base_url, auth_header_name, auth_scheme, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id, name)
       DO UPDATE SET provider = EXCLUDED.provider, api_key = EXCLUDED.api_key, default_model = EXCLUDED.default_model,
                     base_url = EXCLUDED.base_url, auth_header_name = EXCLUDED.auth_header_name, auth_scheme = EXCLUDED.auth_scheme,
                     is_active = true, updated_at = now()
       RETURNING id, name, provider, default_model, base_url, auth_header_name, auth_scheme, is_active AS active, api_key, created_at, updated_at`,
      [workspace.id, name, provider, apiKey, body.defaultModel || null, baseUrl, authHeaderName, authScheme, userId || null]
    );
    const item = toCamel(res.rows[0]);
    item.maskedKey = maskSecret(apiKey);
    delete item.apiKey;
    return item;
  }

  async deleteAiKey(userId: string | null | undefined, keyId: string) {
    const workspace = await this.workspace(userId);
    await this.db.query("DELETE FROM workspace_ai_keys WHERE id = $1 AND organization_id = $2", [keyId, workspace.id]);
    return { ok: true };
  }

  async allocateAiKey(userId: string | null | undefined, body: Body) {
    const projectId = String(body.projectId || "");
    if (!projectId) throw new BadRequestException({ error: "projectId is required" });
    const workspace = await this.workspace(userId);
    const project = await this.db.query("SELECT id FROM projects WHERE id = $1 AND organization_id = $2", [projectId, workspace.id]);
    if (!project.rows[0]) throw new NotFoundException({ error: "Project not found" });
    const keyId = body.workspaceAiKeyId || null;
    if (keyId) {
      const key = await this.db.query("SELECT id FROM workspace_ai_keys WHERE id = $1 AND organization_id = $2", [keyId, workspace.id]);
      if (!key.rows[0]) throw new NotFoundException({ error: "AI key not found" });
    }
    await this.db.query(
      `INSERT INTO project_ai_key_allocations (project_id, workspace_ai_key_id, allocated_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (project_id)
       DO UPDATE SET workspace_ai_key_id = EXCLUDED.workspace_ai_key_id, allocated_by = EXCLUDED.allocated_by, updated_at = now()`,
      [projectId, keyId, userId || null]
    );
    return { ok: true };
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
      ["automationStatus", "automation_status"],
      ["jiraIssueKey", "jira_issue_key"]
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

  async exportTestCases(projectId: string): Promise<Body[]> {
    const res = await this.db.query(
      `SELECT t.external_id, t.title, COALESCE(t.description, '') AS description,
              COALESCE(t.preconditions, '') AS preconditions,
              t.steps, COALESCE(t.test_data, '') AS test_data,
              COALESCE(t.priority, '') AS priority, COALESCE(t.severity, '') AS severity,
              COALESCE(t.type, '') AS type, COALESCE(t.status, '') AS status,
              COALESCE(s.name, '') AS suite, COALESCE(t.component, '') AS component
       FROM testcases t
       LEFT JOIN suites s ON s.id = t.suite_id
       WHERE t.project_id = $1
       ORDER BY t.updated_at DESC`,
      [projectId]
    );
    return res.rows.map((row) => {
      const steps = normalizeJsonArray(row.steps)
        .map((step) => {
          if (typeof step === "string") return step;
          return [step.action || step.step || step.description, step.expectedResult || step.expected]
            .filter(Boolean)
            .join(" => ");
        })
        .filter(Boolean)
        .join(" | ");
      return {
        externalId: row.external_id || "",
        title: row.title || "",
        description: row.description || "",
        preconditions: row.preconditions || "",
        steps,
        testData: row.test_data || "",
        priority: row.priority || "",
        severity: row.severity || "",
        type: row.type || "",
        status: row.status || "",
        suite: row.suite || "",
        component: row.component || ""
      };
    });
  }

  async getTestCase(id: string) {
    const res = await this.db.query("SELECT * FROM testcases WHERE id = $1", [id]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    return toCamel(res.rows[0]);
  }

  async createTestCase(projectId: string, body: Body) {
    const externalId = body.externalId || (await this.nextExternalId(projectId, body.testcaseIdPrefix));
    const res = await this.db.query(
      `INSERT INTO testcases
       (project_id, suite_id, external_id, title, description, preconditions, postconditions, steps, test_data,
        priority, severity, type, automation_status, automation_repo, automation_path, automation_test_name,
        automation_framework, automation_tags, owner_id, component, status, jira_issue_key, jira_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
        body.status || "Draft",
        body.jiraIssueKey || null,
        body.jiraUrl || null
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
       status=COALESCE($20,status), jira_issue_key=COALESCE($21,jira_issue_key), jira_url=COALESCE($22,jira_url), updated_at=now()
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
        body.status ?? null,
        body.jiraIssueKey ?? null,
        body.jiraUrl ?? null
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

  async planRuns(planId: string) {
    const res = await this.db.query(
      `SELECT c.*,
              COUNT(ci.id)::int AS total_cases,
              COUNT(*) FILTER (WHERE e.status = 'Passed')::int AS passed,
              COUNT(*) FILTER (WHERE e.status = 'Failed')::int AS failed,
              COUNT(*) FILTER (WHERE e.status = 'Blocked')::int AS blocked,
              COUNT(*) FILTER (WHERE e.status = 'Skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE e.status IS NULL OR e.status = 'Untested')::int AS untested
       FROM cycles c
       LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id
       WHERE c.plan_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [planId]
    );
    return res.rows.map(toCamel);
  }

  async planProgress(planId: string) {
    const res = await this.db.query<{
      run_count: number;
      total_cases: number;
      passed: number;
      failed: number;
      blocked: number;
      skipped: number;
      untested: number;
    }>(
      `SELECT COUNT(DISTINCT c.id)::int AS run_count,
              COUNT(ci.id)::int AS total_cases,
              COUNT(*) FILTER (WHERE e.status = 'Passed')::int AS passed,
              COUNT(*) FILTER (WHERE e.status = 'Failed')::int AS failed,
              COUNT(*) FILTER (WHERE e.status = 'Blocked')::int AS blocked,
              COUNT(*) FILTER (WHERE e.status = 'Skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE e.status IS NULL OR e.status = 'Untested')::int AS untested
       FROM cycles c
       LEFT JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id
       WHERE c.plan_id = $1`,
      [planId]
    );
    const row = res.rows[0] ?? {
      run_count: 0,
      total_cases: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      untested: 0
    };
    const totalCases = Number(row.total_cases) || 0;
    const passed = Number(row.passed) || 0;
    const failed = Number(row.failed) || 0;
    const blocked = Number(row.blocked) || 0;
    const skipped = Number(row.skipped) || 0;
    const untested = Number(row.untested) || 0;
    const executed = passed + failed + blocked + skipped;
    return {
      runCount: Number(row.run_count) || 0,
      totalCases,
      passed,
      failed,
      blocked,
      skipped,
      untested,
      executed,
      completionPercent: totalCases > 0 ? Math.round((executed / totalCases) * 100) : 0
    };
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

  async shareCycle(cycleId: string, body: Body) {
    const enabled = body.enabled !== false;
    const existing = await this.db.query("SELECT id, share_token FROM cycles WHERE id = $1", [cycleId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Cycle not found" });
    const shareToken = existing.rows[0].share_token || randomBytes(24).toString("hex");
    const res = await this.db.query(
      "UPDATE cycles SET share_enabled = $2, share_token = $3, updated_at = now() WHERE id = $1 RETURNING share_enabled, share_token",
      [cycleId, enabled, shareToken]
    );
    return {
      shareEnabled: Boolean(res.rows[0]?.share_enabled),
      shareToken: res.rows[0]?.share_token || null
    };
  }

  async publicCycle(token: string) {
    const res = await this.db.query("SELECT * FROM cycles WHERE share_token = $1 AND share_enabled = true", [token]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Shared run not found" });
    return toCamel(res.rows[0]);
  }

  async publicCycleExecutions(token: string) {
    const run = await this.db.query("SELECT id FROM cycles WHERE share_token = $1 AND share_enabled = true", [token]);
    if (!run.rows[0]) throw new NotFoundException({ error: "Shared run not found" });
    return this.executions(run.rows[0].id);
  }

  async updateCycle(cycleId: string, body: Body) {
    await this.db.query(
      `UPDATE cycles SET name=COALESCE($2,name), description=COALESCE($3,description),
       environment=COALESCE($4,environment), build_version=COALESCE($5,build_version),
       release_name=COALESCE($6,release_name),
       plan_id=CASE WHEN $7::boolean THEN NULL WHEN $8::uuid IS NOT NULL THEN $8::uuid ELSE plan_id END,
       status=COALESCE($9,status),
       updated_at=now() WHERE id=$1`,
      [
        cycleId,
        body.name || null,
        body.description || null,
        body.environment || null,
        body.buildVersion || null,
        body.releaseName || null,
        body.clearPlan === true,
        body.planId || null,
        body.status || null
      ]
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
              ci.id AS cycle_item_id, ci.testcase_id, ci.snapshot_title,
              COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS title,
              t.external_id, t.priority, t.type, t.suite_id, t.description, t.preconditions, t.postconditions,
              t.steps, t.test_data, t.automation_status, t.automation_tags
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

  async executionReport(projectId: string, query: Body) {
    const filterBy = String(query.filterBy || "overall");
    const filterValue = query.filterValue ? String(query.filterValue) : null;
    const res = await this.db.query(
      `SELECT
         e.id AS execution_id,
         COALESCE(e.status, 'Untested') AS execution_status,
         e.assignee_id,
         ci.testcase_id,
         COALESCE(NULLIF(ci.snapshot_title, ''), NULLIF(t.title, ''), 'Untitled test case') AS testcase_title,
         COALESCE(t.priority, 'Unspecified') AS priority,
         COALESCE(t.automation_tags, '') AS automation_tags,
         t.suite_id,
         COALESCE(s.name, 'No Suite') AS suite_name,
         c.id AS run_id,
         COALESCE(c.name, 'Untitled test run') AS run_name,
         c.plan_id,
         COALESCE(p.name, 'No Plan') AS plan_name,
         COALESCE(u.name, u.email, 'Unassigned') AS assignee_name
       FROM cycles c
       JOIN cycle_items ci ON ci.cycle_id = c.id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN testcases t ON t.id = ci.testcase_id
       LEFT JOIN suites s ON s.id = t.suite_id
       LEFT JOIN plans p ON p.id = c.plan_id
       LEFT JOIN users u ON u.id = e.assignee_id
       WHERE c.project_id = $1
       ORDER BY c.created_at DESC, ci.position, ci.created_at`,
      [projectId]
    );
    const statusKeys = ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"] as const;
    const groups = new Map<string, Body>();
    const add = (groupId: string, groupName: string, status: string) => {
      const normalizedStatus = statusKeys.includes(status as any) ? status : "Untested";
      const row = groups.get(groupId) || {
        groupId,
        groupName,
        Passed: 0,
        Failed: 0,
        Blocked: 0,
        Skipped: 0,
        Untested: 0,
        Retest: 0,
        total: 0
      };
      row[normalizedStatus] = Number(row[normalizedStatus] || 0) + 1;
      row.total = Number(row.total || 0) + 1;
      groups.set(groupId, row);
    };
    for (const row of res.rows) {
      const tags = String(row.automation_tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const matchesFilter = (() => {
        if (!filterValue || filterBy === "overall") return true;
        if (filterBy === "person") return String(row.assignee_id || "unassigned") === filterValue;
        if (filterBy === "plan") return String(row.plan_id || "none") === filterValue;
        if (filterBy === "run") return String(row.run_id) === filterValue;
        if (filterBy === "suite") return String(row.suite_id || "none") === filterValue;
        if (filterBy === "priority") return String(row.priority || "Unspecified") === filterValue;
        if (filterBy === "tags") return tags.includes(filterValue);
        return true;
      })();
      if (!matchesFilter) continue;
      const status = String(row.execution_status || "Untested");
      if (filterBy === "person") add(String(row.assignee_id || "unassigned"), String(row.assignee_name || "Unassigned"), status);
      else if (filterBy === "plan") add(String(row.plan_id || "none"), String(row.plan_name || "No Plan"), status);
      else if (filterBy === "suite") add(String(row.suite_id || "none"), String(row.suite_name || "No Suite"), status);
      else if (filterBy === "priority") add(String(row.priority || "Unspecified"), String(row.priority || "Unspecified"), status);
      else if (filterBy === "tags") {
        const effectiveTags = tags.length ? tags : ["Untagged"];
        for (const tag of effectiveTags) add(tag, tag, status);
      } else {
        add(String(row.run_id), String(row.run_name || "Untitled test run"), status);
      }
    }
    return {
      filterBy,
      filterValue,
      rows: Array.from(groups.values()).sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
    };
  }

  async requirementMatrix(projectId: string) {
    const res = await this.db.query(
      `SELECT
         t.id AS testcase_id,
         COALESCE(t.external_id, '') AS external_id,
         COALESCE(t.title, ci.snapshot_title, 'Untitled test case') AS testcase_title,
         COALESCE(t.priority, '') AS priority,
         COALESCE(t.status, '') AS testcase_status,
         s.name AS suite_name,
         c.id AS run_id,
         c.name AS run_name,
         c.status AS run_status,
         e.id AS execution_id,
         e.status AS execution_status,
         e.executed_at,
         b.id AS bug_id,
         b.title AS bug_title,
         b.status AS bug_status,
         b.external_url AS bug_url
       FROM testcases t
       LEFT JOIN suites s ON s.id = t.suite_id
       LEFT JOIN cycle_items ci ON ci.testcase_id = t.id
       LEFT JOIN cycles c ON c.id = ci.cycle_id
       LEFT JOIN executions e ON e.cycle_item_id = ci.id
       LEFT JOIN bugs b ON b.execution_id = e.id
       WHERE t.project_id = $1
       ORDER BY t.external_id, c.created_at DESC NULLS LAST`,
      [projectId]
    );
    return { rows: res.rows.map(toCamel) };
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

  async listActivity(projectId: string, query: Body) {
    const limit = Math.min(Math.max(Number(query.limit || 30), 1), 100);
    const offset = Math.max(Number(query.offset || 0), 0);
    const entityType = String(query.entityType || "").trim();
    const values: any[] = [projectId];
    const filters = ["project_id = $1"];
    if (entityType) {
      values.push(entityType);
      filters.push(`entity_type = $${values.length}`);
    }
    const where = filters.join(" AND ");

    const eventsSql = `
      WITH activity_events AS (
        SELECT
          project_id,
          ('testcase-created-' || id::text) AS id,
          NULL::uuid AS actor_id,
          NULL::text AS actor_email,
          NULL::text AS actor_name,
          'created'::text AS action,
          'testcase'::text AS entity_type,
          id::text AS entity_id,
          COALESCE(external_id || ' - ' || title, title) AS entity_name,
          NULL::text AS diff,
          created_at
        FROM testcases
        WHERE project_id = $1

        UNION ALL
        SELECT
          project_id, ('testcase-updated-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'updated'::text, 'testcase'::text, id::text, COALESCE(external_id || ' - ' || title, title), NULL::text, updated_at
        FROM testcases
        WHERE project_id = $1 AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          project_id, ('suite-created-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'created'::text, 'suite'::text, id::text, name, NULL::text, created_at
        FROM suites
        WHERE project_id = $1

        UNION ALL
        SELECT
          project_id, ('suite-updated-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'updated'::text, 'suite'::text, id::text, name, NULL::text, updated_at
        FROM suites
        WHERE project_id = $1 AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          project_id, ('plan-created-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'created'::text, 'plan'::text, id::text, name, NULL::text, created_at
        FROM plans
        WHERE project_id = $1

        UNION ALL
        SELECT
          project_id, ('plan-updated-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'updated'::text, 'plan'::text, id::text, name, NULL::text, updated_at
        FROM plans
        WHERE project_id = $1 AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          project_id, ('cycle-created-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'created'::text, 'cycle'::text, id::text, name, NULL::text, created_at
        FROM cycles
        WHERE project_id = $1

        UNION ALL
        SELECT
          project_id, ('cycle-updated-' || id::text), NULL::uuid, NULL::text, NULL::text,
          'updated'::text, 'cycle'::text, id::text, name, NULL::text, updated_at
        FROM cycles
        WHERE project_id = $1 AND updated_at > created_at + interval '1 second'

        UNION ALL
        SELECT
          b.project_id, ('bug-created-' || b.id::text), b.reported_by, u.email, u.name,
          'created'::text, 'bug'::text, b.id::text, b.title, NULL::text, b.created_at
        FROM bugs b
        LEFT JOIN users u ON u.id = b.reported_by
        WHERE b.project_id = $1

        UNION ALL
        SELECT
          b.project_id, ('bug-updated-' || b.id::text), b.reported_by, u.email, u.name,
          'updated'::text, 'bug'::text, b.id::text, b.title, NULL::text, b.updated_at
        FROM bugs b
        LEFT JOIN users u ON u.id = b.reported_by
        WHERE b.project_id = $1 AND b.updated_at > b.created_at + interval '1 second'

        UNION ALL
        SELECT
          a.project_id, a.id::text, a.actor_id, u.email, u.name,
          a.action::text, a.entity_type::text, a.entity_id::text, a.entity_name::text, a.diff::text, a.created_at
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.project_id = $1
      )
      SELECT *
      FROM activity_events
      WHERE ${where}
    `;

    const total = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (${eventsSql}) counted`,
      values
    );
    values.push(limit, offset);
    const res = await this.db.query(
      `${eventsSql} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: Number(total.rows[0]?.count || 0) };
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

  async publicBranding() {
    const res = await this.db.query("SELECT value FROM platform_settings WHERE key = 'branding'").catch(() => ({ rows: [] as Body[] }));
    const value = res.rows[0]?.value || {};
    return {
      productName: String(value.productName || "Tesbo Test Manager"),
      logoUrl: String(value.logoUrl || "/tesbo-test-manager-logo.png")
    };
  }

  async adminBranding(userId: string | null | undefined) {
    await this.requirePlatformAdmin(userId);
    return this.publicBranding();
  }

  async updateAdminBranding(userId: string | null | undefined, body: Body) {
    const uid = await this.requirePlatformAdmin(userId);
    const logoUrl = String(body.logoUrl || "").trim();
    const productName = String(body.productName || "Tesbo Test Manager").trim() || "Tesbo Test Manager";
    if (logoUrl && !/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(logoUrl) && !logoUrl.startsWith("/")) {
      throw new BadRequestException({ error: "Logo must be an uploaded image data URL or a public app asset path." });
    }
    if (logoUrl.length > 2_500_000) {
      throw new BadRequestException({ error: "Logo is too large. Upload an image below 2 MB." });
    }
    const value = {
      productName,
      logoUrl: logoUrl || "/tesbo-test-manager-logo.png"
    };
    await this.db.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('branding', $1::jsonb, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(value), uid]
    );
    return value;
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

  private envJiraConfig() {
    const clientId = process.env.JIRA_CLIENT_ID || "";
    const clientSecret = process.env.JIRA_CLIENT_SECRET || "";
    const redirectUri = process.env.JIRA_REDIRECT_URI || "";
    if (!clientId || !clientSecret || !redirectUri) return null;
    return { clientId, clientSecret, redirectUri };
  }

  private async jiraConfig(projectId: string) {
    const saved = await this.db.query(
      "SELECT client_id, client_secret, redirect_uri FROM jira_oauth_config WHERE project_id = $1",
      [projectId]
    ).catch(() => ({ rows: [] as Body[] }));
    const row = saved.rows[0];
    if (row?.client_id && row?.client_secret && row?.redirect_uri) {
      return {
        clientId: String(row.client_id),
        clientSecret: String(row.client_secret),
        redirectUri: String(row.redirect_uri)
      };
    }
    const env = this.envJiraConfig();
    if (env) return env;
    throw new BadRequestException({ error: "Jira OAuth is not configured. Add Client ID, Client Secret, and Redirect URI in Jira Integration settings." });
  }

  async jiraConfigStatus(projectId: string) {
    const saved = await this.db.query(
      "SELECT client_id, redirect_uri, updated_at FROM jira_oauth_config WHERE project_id = $1",
      [projectId]
    ).catch(() => ({ rows: [] as Body[] }));
    const row = saved.rows[0];
    const env = this.envJiraConfig();
    if (row) {
      return {
        configured: true,
        source: "project",
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        hasClientSecret: true,
        updatedAt: row.updated_at
      };
    }
    return {
      configured: !!env,
      source: env ? "environment" : "none",
      clientId: env?.clientId ?? "",
      redirectUri: env?.redirectUri ?? this.defaultJiraRedirectUri(),
      hasClientSecret: !!env?.clientSecret,
      updatedAt: null
    };
  }

  async updateJiraConfig(projectId: string, userId: string | null | undefined, body: Body) {
    const clientId = String(body.clientId || "").trim();
    const requestedClientSecret = String(body.clientSecret || "").trim();
    const redirectUri = String(body.redirectUri || "").trim();
    const existing = await this.db.query("SELECT client_secret FROM jira_oauth_config WHERE project_id = $1", [projectId])
      .catch(() => ({ rows: [] as Body[] }));
    const clientSecret = requestedClientSecret || String(existing.rows[0]?.client_secret || "");
    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException({ error: "Client ID, Client Secret, and Redirect URI are required." });
    }
    if (!/^https?:\/\//i.test(redirectUri)) {
      throw new BadRequestException({ error: "Redirect URI must start with http:// or https://." });
    }
    await this.db.query(
      `INSERT INTO jira_oauth_config (project_id, client_id, client_secret, redirect_uri, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO UPDATE SET
         client_id = EXCLUDED.client_id,
         client_secret = EXCLUDED.client_secret,
         redirect_uri = EXCLUDED.redirect_uri,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [projectId, clientId, clientSecret, redirectUri, userId || null]
    );
    return this.jiraConfigStatus(projectId);
  }

  private defaultJiraRedirectUri() {
    const frontend = process.env.FRONTEND_URL || process.env.APP_URL || "http://localhost:1010";
    return `${frontend.replace(/\/$/, "")}/jira/callback`;
  }

  async jiraAuthUrl(projectId: string) {
    const { clientId, redirectUri } = await this.jiraConfig(projectId);
    const params = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: clientId,
      scope: "read:jira-work read:jira-user write:jira-work offline_access",
      redirect_uri: redirectUri,
      state: projectId,
      response_type: "code",
      prompt: "consent"
    });
    return { url: `https://auth.atlassian.com/authorize?${params.toString()}` };
  }

  async jiraCallback(projectId: string, userId: string | null | undefined, body: Body) {
    const code = String(body.code || "");
    if (!code) throw new BadRequestException({ error: "Jira authorization code is required." });
    const { clientId, clientSecret, redirectUri } = await this.jiraConfig(projectId);

    const token = await this.jiraFetch<Body>("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });
    const accessToken = String(token.access_token || "");
    const refreshToken = String(token.refresh_token || "");
    if (!accessToken || !refreshToken) throw new BadRequestException({ error: "Jira did not return OAuth tokens." });

    const resources = await this.jiraFetch<Body[]>("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const resource = resources[0];
    if (!resource?.id || !resource?.url) throw new BadRequestException({ error: "No accessible Jira site was found." });

    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
    const res = await this.db.query(
      `INSERT INTO jira_connections (project_id, cloud_id, site_url, access_token, refresh_token, token_expires_at, connected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id) DO UPDATE SET
         cloud_id = EXCLUDED.cloud_id,
         site_url = EXCLUDED.site_url,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         connected_by = EXCLUDED.connected_by,
         updated_at = now()
       RETURNING id, cloud_id, site_url`,
      [projectId, String(resource.id), String(resource.url), accessToken, refreshToken, expiresAt, userId || null]
    );
    return { connectionId: res.rows[0].id, cloudId: res.rows[0].cloud_id, siteUrl: res.rows[0].site_url };
  }

  async jiraStatus(projectId: string) {
    const connection = await this.getJiraConnection(projectId, false);
    if (!connection) return { connected: false, connectedProjects: [] };
    const projects = await this.db.query(
      `SELECT id, jira_project_id, jira_project_key, jira_project_name, created_at
       FROM jira_project_mappings
       WHERE project_id = $1 AND enabled = true
       ORDER BY jira_project_key`,
      [projectId]
    );
    return {
      connected: true,
      id: connection.id,
      cloudId: connection.cloud_id,
      siteUrl: connection.site_url,
      tokenExpiresAt: connection.token_expires_at,
      connectedBy: connection.connected_by,
      createdAt: connection.created_at,
      connectedProjects: projects.rows.map(toCamel)
    };
  }

  async jiraDisconnect(projectId: string) {
    await this.db.query("DELETE FROM jira_connections WHERE project_id = $1", [projectId]);
    return { disconnected: true };
  }

  async jiraProjects(projectId: string) {
    const connection = await this.getJiraConnection(projectId, true);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const data = await this.jiraFetch<Body>(
      `https://api.atlassian.com/ex/jira/${connection.cloud_id}/rest/api/3/project/search?maxResults=100`,
      { headers: { Authorization: `Bearer ${connection.access_token}` } }
    );
    const connected = await this.db.query(
      "SELECT jira_project_id FROM jira_project_mappings WHERE project_id = $1 AND enabled = true",
      [projectId]
    );
    const connectedIds = new Set(connected.rows.map((row) => String(row.jira_project_id)));
    return normalizeJsonArray(data.values).map((project) => ({
      id: String(project.id || ""),
      key: String(project.key || ""),
      name: String(project.name || project.key || "Jira project"),
      style: String(project.style || ""),
      connected: connectedIds.has(String(project.id || ""))
    })).filter((project) => project.id && project.key);
  }

  async connectJiraProjects(projectId: string, body: Body) {
    const connection = await this.getJiraConnection(projectId, false);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const projects = normalizeJsonArray(body.projects)
      .map((project) => ({
        id: String(project.id || "").trim(),
        key: String(project.key || "").trim(),
        name: String(project.name || project.key || "").trim()
      }))
      .filter((project) => project.id && project.key);
    await this.db.query("DELETE FROM jira_project_mappings WHERE project_id = $1", [projectId]);
    for (const project of projects) {
      await this.db.query(
        `INSERT INTO jira_project_mappings (jira_connection_id, project_id, jira_project_id, jira_project_key, jira_project_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (jira_connection_id, jira_project_id) DO UPDATE SET
           jira_project_key = EXCLUDED.jira_project_key,
           jira_project_name = EXCLUDED.jira_project_name,
           enabled = true`,
        [connection.id, projectId, project.id, project.key, project.name]
      );
    }
    return { linked: projects.length };
  }

  async syncJira(projectId: string) {
    const connection = await this.getJiraConnection(projectId, true);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const mappings = await this.db.query(
      "SELECT jira_project_key FROM jira_project_mappings WHERE project_id = $1 AND enabled = true",
      [projectId]
    );
    const keys = mappings.rows.map((row) => String(row.jira_project_key)).filter(Boolean);
    if (!keys.length) return { synced: 0 };

    let synced = 0;
    for (const key of keys) {
      const jql = `project = "${key}" ORDER BY updated DESC`;
      const data = await this.jiraFetch<Body>(
        `https://api.atlassian.com/ex/jira/${connection.cloud_id}/rest/api/3/search/jql`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jql,
            maxResults: 100,
            fields: ["summary", "description", "issuetype", "status", "priority", "assignee", "reporter", "labels", "created", "updated"]
          })
        }
      );
      for (const issue of normalizeJsonArray(data.issues)) {
        const fields = (issue.fields || {}) as Body;
        await this.db.query(
          `INSERT INTO jira_tickets (
             project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, description,
             issue_type, status, priority, assignee, reporter, labels, jira_created_at, jira_updated_at, jira_url, synced_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
           ON CONFLICT (jira_connection_id, jira_issue_id) DO UPDATE SET
             jira_issue_key = EXCLUDED.jira_issue_key,
             summary = EXCLUDED.summary,
             description = EXCLUDED.description,
             issue_type = EXCLUDED.issue_type,
             status = EXCLUDED.status,
             priority = EXCLUDED.priority,
             assignee = EXCLUDED.assignee,
             reporter = EXCLUDED.reporter,
             labels = EXCLUDED.labels,
             jira_created_at = EXCLUDED.jira_created_at,
             jira_updated_at = EXCLUDED.jira_updated_at,
             jira_url = EXCLUDED.jira_url,
             synced_at = now()`,
          [
            projectId,
            connection.id,
            String(issue.id || ""),
            String(issue.key || ""),
            String(fields.summary || ""),
            jiraDescriptionToText(fields.description),
            String(fields.issuetype?.name || ""),
            String(fields.status?.name || ""),
            String(fields.priority?.name || ""),
            String(fields.assignee?.displayName || ""),
            String(fields.reporter?.displayName || ""),
            normalizeJsonArray(fields.labels).join(", "),
            fields.created || null,
            fields.updated || null,
            `${connection.site_url}/browse/${issue.key}`
          ]
        );
        synced += 1;
      }
    }
    return { synced };
  }

  async jiraTickets(projectId: string, query: Body) {
    const limit = Math.max(1, Math.min(100, Number(query.limit || 25)));
    const offset = Math.max(0, Number(query.offset || 0));
    const search = String(query.search || "").trim();
    const filters = ["project_id = $1"];
    const values: any[] = [projectId];
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(jira_issue_key ILIKE $${values.length} OR summary ILIKE $${values.length})`);
    }
    const count = await this.db.query(`SELECT COUNT(*)::int AS count FROM jira_tickets WHERE ${filters.join(" AND ")}`, values);
    values.push(limit, offset);
    const res = await this.db.query(
      `SELECT * FROM jira_tickets
       WHERE ${filters.join(" AND ")}
       ORDER BY jira_updated_at DESC NULLS LAST, synced_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { list: res.rows.map(toCamel), total: count.rows[0]?.count ?? 0 };
  }

  async jiraComment(projectId: string, body: Body) {
    const connection = await this.getJiraConnection(projectId, true);
    if (!connection) throw new NotFoundException({ error: "Jira is not connected." });
    const issueKey = String(body.issueKey || body.jiraIssueKey || "").trim();
    const comment = String(body.comment || body.body || "").trim();
    if (!issueKey || !comment) throw new BadRequestException({ error: "Jira issue key and comment are required." });
    await this.jiraFetch(
      `https://api.atlassian.com/ex/jira/${connection.cloud_id}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }]
          }
        })
      }
    );
    return { ok: true };
  }

  private async getJiraConnection(projectId: string, refresh: boolean): Promise<Body | null> {
    const res = await this.db.query("SELECT * FROM jira_connections WHERE project_id = $1", [projectId]);
    const connection = res.rows[0] as Body | undefined;
    if (!connection) return null;
    if (!refresh || new Date(connection.token_expires_at).getTime() > Date.now() + 60_000) return connection;

    const { clientId, clientSecret } = await this.jiraConfig(projectId);
    const token = await this.jiraFetch<Body>("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: connection.refresh_token
      })
    });
    const accessToken = String(token.access_token || "");
    const refreshToken = String(token.refresh_token || connection.refresh_token);
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
    await this.db.query(
      "UPDATE jira_connections SET access_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now() WHERE id = $1",
      [connection.id, accessToken, refreshToken, expiresAt]
    );
    return { ...connection, access_token: accessToken, refresh_token: refreshToken, token_expires_at: expiresAt };
  }

  private async jiraFetch<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BadRequestException({ error: `Jira request failed (${res.status}).`, detail: text.slice(0, 500) });
    }
    return (await res.json()) as T;
  }

  async zyraAgent(projectId: string) {
    const [project, allocation, usage, tasks] = await Promise.all([
      this.getProject(projectId),
      this.zyraAiAllocation(projectId),
      this.db.query<{ total: string }>(
        "SELECT COALESCE(SUM(token_total), 0) AS total FROM ai_generation_requests WHERE project_id = $1 AND agent_name = ANY($2::text[])",
        [projectId, ZYRA_AGENT_NAMES]
      ),
      this.db.query(
        `SELECT id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, style,
                requested_count, generated_count, generated_payload, saved_count, save_events, created_at, updated_at,
                agent_name, task_status, feedback, context, jira_issue_keys, token_input, token_output, token_total,
                source_summary, activity_log
         FROM ai_generation_requests
         WHERE project_id = $1 AND agent_name = ANY($2::text[])
         ORDER BY updated_at DESC LIMIT 50`,
        [projectId, ZYRA_AGENT_NAMES]
      )
    ]);
    const settings = this.parseProjectSettings(project.settings).zyraAgent || {};
    const key = allocation.key;
    return {
      agent: {
        name: ZYRA_AGENT_NAME,
        role: "AI testcase generation agent",
        active: Boolean(key),
        activationReason: key ? "Workspace AI key allocated to this project." : allocation.reason
      },
      settings: {
        testcaseCount: Number(settings.testcaseCount || 5),
        testcaseRange: String(settings.testcaseRange || "1-10"),
        capabilities: this.normalizeZyraCapabilities(settings.capabilities)
      },
      aiKey: key
        ? {
            id: key.id,
            name: key.name,
            provider: key.provider,
            defaultModel: key.default_model,
            baseUrl: key.base_url,
            authHeaderName: key.auth_header_name,
            authScheme: key.auth_scheme,
            maskedKey: maskSecret(String(key.api_key || ""))
          }
        : null,
      tokenUsage: {
        total: Number(usage.rows[0]?.total || 0)
      },
      tasks: tasks.rows.map((row) => this.formatAiTask(row))
    };
  }

  async testZyraAiConnection(projectId: string): Promise<{ ok: boolean; provider: string; model: string; error?: string; latencyMs: number }> {
    const allocation = await this.zyraAiAllocation(projectId);
    if (!allocation.key) {
      return { ok: false, provider: "none", model: "none", error: allocation.reason, latencyMs: 0 };
    }
    const { key } = allocation;
    const provider = String(key.provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, key.default_model);
    const start = performance.now();
    try {
      if (provider === "anthropic") {
        const headers = this.buildAnthropicAuthHeaders(key.api_key, key.auth_header_name, key.auth_scheme);
        const res = await fetch(normalizeAnthropicMessagesUrl(key.base_url), {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: anthropicModelCandidates(model)[0],
            max_tokens: 5,
            messages: [{ role: "user", content: "hi" }]
          })
        });
        const body = await res.json().catch(() => ({} as Body)) as Body;
        if (!res.ok) {
          const raw = String(body.error?.message || body.error || res.statusText);
          return { ok: false, provider, model, error: this.describeProviderError(provider, res.status, raw) || raw, latencyMs: Math.round(performance.now() - start) };
        }
        return { ok: true, provider, model, latencyMs: Math.round(performance.now() - start) };
      }
      const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const authHeaderName = key.auth_header_name || "Authorization";
      const authScheme = key.auth_scheme == null ? "Bearer" : String(key.auth_scheme);
      authHeaders[authHeaderName] = authScheme ? `${authScheme} ${String(key.api_key || "")}` : String(key.api_key || "");
      const res = await fetch(normalizeChatCompletionsUrl(provider === "openai" ? null : key.base_url), {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
      });
      const body = await res.json().catch(() => ({} as Body)) as Body;
      if (!res.ok) {
        const raw = String(body.error?.message || body.error || res.statusText);
        return { ok: false, provider, model, error: this.describeProviderError(provider, res.status, raw) || raw, latencyMs: Math.round(performance.now() - start) };
      }
      return { ok: true, provider, model, latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return { ok: false, provider, model, error: err instanceof Error ? err.message : String(err), latencyMs: Math.round(performance.now() - start) };
    }
  }

  async zyraTask(projectId: string, taskId: string) {
    const res = await this.db.query(
      `SELECT id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, style,
              requested_count, generated_count, generated_payload, saved_count, save_events, created_at, updated_at,
              agent_name, task_status, feedback, context, jira_issue_keys, token_input, token_output, token_total,
              source_summary, activity_log
       FROM ai_generation_requests
       WHERE id = $1 AND project_id = $2 AND agent_name = ANY($3::text[])`,
      [taskId, projectId, ZYRA_AGENT_NAMES]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    return this.formatAiTask(res.rows[0]);
  }

  async updateZyraSettings(projectId: string, body: Body) {
    const project = await this.getProject(projectId);
    const settings = this.parseProjectSettings(project.settings);
    const current = (settings.zyraAgent || {}) as Body;
    const validRanges = ["minimum", "1-10", "10-30", "all"];
    const testcaseRange = validRanges.includes(String(body.testcaseRange))
      ? String(body.testcaseRange)
      : String(current.testcaseRange || "1-10");
    const { requestedCount } = this.testcaseRangeConfig(testcaseRange);
    // Capabilities: merge the incoming partial over current, then normalize to strict booleans.
    const capabilities = this.normalizeZyraCapabilities({
      ...this.normalizeZyraCapabilities(current.capabilities),
      ...(body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {})
    });
    settings.zyraAgent = { ...current, testcaseCount: requestedCount, testcaseRange, capabilities };
    await this.db.query("UPDATE projects SET settings = $2::jsonb, updated_at = now() WHERE id = $1", [projectId, JSON.stringify(settings)]);
    return { testcaseCount: requestedCount, testcaseRange, capabilities };
  }

  async zyraChatSessions(projectId: string) {
    const res = await this.db.query(
      `SELECT id, project_id, user_id, title, created_at, updated_at
       FROM zyra_chat_sessions
       WHERE project_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [projectId]
    );
    return { list: res.rows.map(toCamel) };
  }

  async zyraChatSession(projectId: string, sessionId: string) {
    const session = await this.db.query(
      "SELECT id, project_id, user_id, title, created_at, updated_at FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2",
      [sessionId, projectId]
    );
    if (!session.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    const messages = await this.db.query(
      `SELECT id, session_id, project_id, user_id, role, content, reasoning_summary, action_type,
              status, testcases, activity, created_at
       FROM zyra_chat_messages
       WHERE session_id = $1 AND project_id = $2
       ORDER BY created_at ASC`,
      [sessionId, projectId]
    );
    return {
      ...toCamel(session.rows[0]),
      messages: messages.rows.map((row) => {
        const item = toCamel(row);
        item.testcases = normalizeJsonArray(row.testcases);
        item.activity = normalizeJsonArray(row.activity);
        return item;
      })
    };
  }

  async createZyraChatSession(projectId: string, userId: string | null | undefined, body: Body) {
    const title = String(body.title || "Zyra chat").trim().slice(0, 240) || "Zyra chat";
    const res = await this.db.query(
      `INSERT INTO zyra_chat_sessions (project_id, user_id, title)
       VALUES ($1,$2,$3)
       RETURNING id, project_id, user_id, title, created_at, updated_at`,
      [projectId, userId || null, title]
    );
    return { ...toCamel(res.rows[0]), messages: [] };
  }

  async sendZyraChatMessage(projectId: string, userId: string | null | undefined, sessionId: string, body: Body) {
    const uid = this.requireUser(userId);
    const message = String(body.message || "").trim();
    if (!message) throw new BadRequestException({ error: "message is required" });
    const sessionRes = await this.db.query("SELECT * FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2", [sessionId, projectId]);
    if (!sessionRes.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });

    await this.db.query(
      `INSERT INTO zyra_chat_messages (session_id, project_id, user_id, role, content, status)
       VALUES ($1,$2,$3,'user',$4,'sent')`,
      [sessionId, projectId, uid, message]
    );

    const decision = await this.buildZyraChatDecision(projectId, uid, sessionId, message);
    const applied = await this.applyZyraChatOperations(projectId, uid, decision.operations);
    const activity = [
      { actor: "user", title: "Asked Zyra", detail: message.slice(0, 320), createdAt: new Date().toISOString() },
      ...applied.activity
    ];
    const testcases = applied.testcases.length ? applied.testcases : decision.testcases;
    const assistant = await this.db.query(
      `INSERT INTO zyra_chat_messages
       (session_id, project_id, user_id, role, content, reasoning_summary, action_type, status, testcases, activity)
       VALUES ($1,$2,$3,'assistant',$4,$5,$6,'completed',$7::jsonb,$8::jsonb)
       RETURNING id, session_id, project_id, user_id, role, content, reasoning_summary, action_type, status, testcases, activity, created_at`,
      [
        sessionId,
        projectId,
        uid,
        decision.reply,
        decision.reasoningSummary,
        decision.actionType,
        JSON.stringify(testcases),
        JSON.stringify(activity)
      ]
    );
    const title = this.compactTitle(message);
    await this.db.query(
      "UPDATE zyra_chat_sessions SET title = CASE WHEN title = 'Zyra chat' THEN $3 ELSE title END, updated_at = now() WHERE id = $1 AND project_id = $2",
      [sessionId, projectId, title]
    );
    const item = toCamel(assistant.rows[0]);
    item.testcases = normalizeJsonArray(assistant.rows[0].testcases);
    item.activity = normalizeJsonArray(assistant.rows[0].activity);
    return { message: item, session: await this.zyraChatSession(projectId, sessionId) };
  }

  private async buildZyraChatDecision(projectId: string, userId: string, sessionId: string, message: string): Promise<ZyraChatDecision> {
    const intent = this.detectZyraChatIntent(message);
    const mentionedJiraKeys = this.extractJiraIssueKeys(message);
    const [history, knowledge, existingTestcases, allocation, projectSnapshot, mentionedJira] = await Promise.all([
      this.db.query(
        `SELECT role, content, reasoning_summary, testcases
         FROM zyra_chat_messages
         WHERE session_id = $1 AND project_id = $2
         ORDER BY created_at DESC
         LIMIT 12`,
        [sessionId, projectId]
      ),
      this.knowledgeSnapshot(projectId),
      this.existingTestcaseSnapshot(projectId, message, ""),
      this.zyraAiAllocation(projectId),
      this.zyraChatProjectSnapshot(projectId),
      this.jiraSnapshot(projectId, mentionedJiraKeys)
    ]);
    const key = allocation.key;
    if (!key) {
      return this.aiUnavailableForZyraChat(existingTestcases.length, allocation.reason);
    }

    const provider = String(key.provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, key.default_model);
    const capabilities = await this.zyraProjectCapabilities(projectId);
    const knowledgeForChat = capabilities.knowledgeBase ? knowledge : [];

    // Hard capability gates — Zyra declines an action whose capability is disabled in settings.
    if ((intent === "update" || intent === "archive") && !capabilities.testcaseStorage) {
      return this.zyraCapabilityDisabled("testcaseStorage", existingTestcases.length);
    }
    if (intent === "suite" && !capabilities.suiteOperations) {
      return this.zyraCapabilityDisabled("suiteOperations", existingTestcases.length);
    }
    if (intent === "create") {
      if (!capabilities.generation) return this.zyraCapabilityDisabled("generation", existingTestcases.length);
      try {
        const decision = await this.generateZyraChatTestcasesWithAi({
          projectId,
          userId,
          provider,
          model,
          key,
          message,
          knowledge: knowledgeForChat,
          existingTestcases,
          jiraIssueKeys: mentionedJiraKeys,
          requestedCount: this.requestedTestcaseCount(message)
        });
        return this.applyStorageGateToGenerated(decision, capabilities);
      } catch (err) {
        const detail = this.extractAiErrorMessage(err);
        // If the AI returned prose instead of JSON drafts the intent was likely analytical,
        // not generative. Fall through to the main model path so the user gets a useful
        // answer rather than a parse-error string.
        if (!detail.includes("invalid JSON") && !detail.includes("no testcase drafts")) {
          await this.logProjectActivity(projectId, userId, "zyra_chat_ai_failed", "zyra_chat", sessionId, "Zyra chat", { message: detail });
          return this.aiUnavailableForZyraChat(existingTestcases.length, detail);
        }
        // For invalid JSON / no drafts: fall through so the main model below can answer analytically.
      }
    }
    const context = [
      "You are Zyra, an expert test engineer and edge-case designer for this product.",
      "Your workflow is: understand the user's query, decide which project context is needed, choose exactly one supported action, then return a structured plan.",
      `Enabled capabilities for this project — generation (author new testcases): ${capabilities.generation ? "ON" : "OFF"}; knowledge base access: ${capabilities.knowledgeBase ? "ON" : "OFF"}; testcase storage (create/update/archive/bulk): ${capabilities.testcaseStorage ? "ON" : "OFF"}; suite operations (create/move): ${capabilities.suiteOperations ? "ON" : "OFF"}.`,
      "If the user asks for an action whose capability is OFF, do NOT emit those operations — choose action 'answer' and briefly say that capability is disabled in Zyra settings and how to enable it. Never silently substitute a different mutation (e.g. do not create testcases when storage or generation is OFF).",
      "Supported actions:",
      "- answer: answer product, feature, test strategy, or knowledge-base questions conversationally.",
      "- list: show existing testcase or coverage rows when the user asks to show/list/compare coverage.",
      "- jira_pending_testcases: count Jira tickets, linked testcase coverage, and pending tickets for testcase writing.",
      "- create: create new testcase drafts/saved cases only when the user clearly asks to create/generate/add/write testcases.",
      "- update: update an existing testcase only when the user clearly asks to update/edit/mark/revise a testcase.",
      "- archive: archive an existing testcase when the user asks to remove/delete/archive testcase coverage. IMPORTANT: before archiving, always describe which testcases will be archived and explicitly ask the user to confirm (e.g. 'I found TC-5 Login Test. Should I archive it? Reply yes to confirm.'). Only include archive operations if the user's current message is a clear confirmation (yes, confirm, go ahead, proceed) after you already proposed what would be archived in the prior assistant turn.",
      "- create_suite: create a new test suite (a folder/group for testcases) when the user asks to create/add a suite, folder, or group. Put the suite name in operation.suiteName.",
      "- move_to_suite: move/assign EXISTING testcases into a suite when the user asks to move/assign/organize/group/put existing testcases into a suite. The target suite goes in operation.suiteName (it is created automatically if it does not already exist, so you do not need a separate create_suite op for the same suite). List the testcases to move in operation.externalIds (use the external IDs shown under 'Existing suites' / 'Existing testcases'), or set operation.allExisting=true when the user means every existing testcase.",
      "CRITICAL: moving or assigning existing testcases into a suite is NEVER a create action. Do not generate, draft, or duplicate testcases for a move/assign/organize request — only emit move_to_suite operations that reference the existing testcases. Use create only when the user explicitly asks to author brand-new testcases.",
      "When the user asks to create a suite AND move existing testcases into it in one message, return a single move_to_suite operation with the suiteName (the suite is auto-created) — or a create_suite plus move_to_suite — but never any create operations.",
      "Use the project snapshot to choose the action. If the query asks for numbers from Jira/testcase links, choose jira_pending_testcases instead of guessing.",
      "If the user asks a normal product, feature, explanation, example, or how-to question, choose answer with empty operations and empty testcases.",
      "Only return testcase rows when the user explicitly asks to create, update, archive/remove, list, compare, or show testcase coverage.",
      "Only create/update/archive when the user clearly asks for a repository mutation. Otherwise suggest what could be done without mutating anything.",
      "Do not reveal hidden chain-of-thought. Provide a concise reasoningSummary with observable factors and action steps.",
      "Treat remove/delete requests as archive operations unless the user clearly names an existing app delete control.",
      `Detected local intent hint: ${intent}. Follow the user's actual wording if it is clearer than this hint.`,
      "Return ONLY a single valid JSON object — no markdown fences, no text before or after the JSON:",
      "{\"reply\":\"\",\"reasoningSummary\":\"\",\"action\":\"answer|list|jira_pending_testcases|create|update|archive|create_suite|move_to_suite\",\"actionType\":\"answer|create|update|archive|suite|mixed\",\"operations\":[{\"type\":\"create|update|archive|create_suite|move_to_suite\",\"testcaseId\":\"\",\"externalId\":\"\",\"externalIds\":[],\"allExisting\":false,\"suiteName\":\"\",\"suiteId\":\"\",\"draft\":{},\"fields\":{},\"reason\":\"\"}],\"testcases\":[{}]}",
      "REPLY FIELD RULES — reply is rendered as markdown in a chat UI, must be human-readable:",
      "  - Use ## for main headings, ### for subsections, **bold** for emphasis, - for bullets, 1. for numbered steps.",
      "  - For comparisons or tabular data use markdown table syntax: | Heading | Heading |\\n|---|---|\\n| value | value |",
      "  - When testcase rows are in the testcases array the UI already renders them in a table — only write a brief summary in reply (e.g. 'Created 3 test cases covering the checkout flow.'). Do NOT duplicate testcase data as a markdown table in reply.",
      "  - NEVER put raw JSON, object/array literals, code blocks, or placeholder text like <string> in reply.",
      "  - Be direct — skip filler openers like 'Certainly!', 'Sure!', or 'Here is your answer:'.",
      "  - For analytical responses (coverage gaps, test strategy, explanations) use structured headings and bullets so the answer is easy to scan.",
      "",
      "Existing suites (use these names/ids for move_to_suite; reuse an existing suite instead of duplicating it):",
      projectSnapshot.suites.length ? projectSnapshot.suites.map((s) => `${s.name} (id: ${s.id}, ${s.testCaseCount} testcase(s))`).join("\n") : "No suites yet.",
      "",
      "Project snapshot:",
      JSON.stringify(projectSnapshot),
      "",
      "Knowledge base:",
      capabilities.knowledgeBase
        ? (knowledgeForChat.map((item) => `${item.title}\n${item.content}`).join("\n\n") || "No knowledge-base notes.")
        : "Knowledge base access is disabled for Zyra in this project — do not rely on or claim knowledge-base context.",
      "",
      "Jira tickets explicitly mentioned by the user:",
      mentionedJira.map((item) => `${item.key}: ${item.summary}\n${item.description}`).join("\n\n") || "No explicit Jira issue key was mentioned or found in the local Jira cache.",
      "",
      "Existing testcases:",
      existingTestcases.map((tc) => `${tc.externalId} | ${tc.title} | ${tc.priority} | ${tc.status}\n${tc.description}\nSteps: ${tc.stepsSummary}`).join("\n\n") || "No existing testcases.",
      "",
      "Recent chat:",
      history.rows.reverse().map((row) => {
        let content = String(row.content || "");
        const trimmed = content.trim();
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed?.reply === "string" && parsed.reply) content = parsed.reply;
          } catch { /* not JSON — use as-is */ }
        }
        return `${row.role}: ${content}`;
      }).join("\n") || "No prior chat."
    ].join("\n");

    try {
      const raw = provider === "anthropic"
        ? await this.zyraChatWithAnthropic(key, model, context, message)
        : await this.zyraChatWithOpenAi(key, model, context, message);
      const modelIntent = this.intentFromZyraModelAction(raw.action, intent);
      if (modelIntent === "jira_pending_testcases") {
        const toolDecision = await this.analyzeZyraJiraTestcaseCoverage(projectId);
        return this.finalizeZyraToolDecisionWithAi({
          key,
          provider,
          model,
          message,
          context,
          toolName: "jira_pending_testcases",
          toolDecision
        });
      }
      if (modelIntent === "suite" && !capabilities.suiteOperations) {
        return this.zyraCapabilityDisabled("suiteOperations", existingTestcases.length);
      }
      if ((modelIntent === "update" || modelIntent === "archive") && !capabilities.testcaseStorage) {
        return this.zyraCapabilityDisabled("testcaseStorage", existingTestcases.length);
      }
      if (modelIntent === "create") {
        if (!capabilities.generation) return this.zyraCapabilityDisabled("generation", existingTestcases.length);
        const decision = await this.generateZyraChatTestcasesWithAi({
          projectId,
          userId,
          provider,
          model,
          key,
          message,
          knowledge: knowledgeForChat,
          existingTestcases,
          jiraIssueKeys: mentionedJiraKeys,
          requestedCount: this.requestedTestcaseCount(message)
        });
        return this.applyStorageGateToGenerated(decision, capabilities);
      }
      return this.normalizeZyraChatDecision(raw, message, existingTestcases, modelIntent);
    } catch (err) {
      const errorDetail = this.extractAiErrorMessage(err);
      await this.logProjectActivity(projectId, userId, "zyra_chat_ai_failed", "zyra_chat", sessionId, "Zyra chat", { message: errorDetail });
      return this.aiUnavailableForZyraChat(existingTestcases.length, errorDetail);
    }
  }

  private async applyZyraChatOperations(projectId: string, userId: string, operations: ZyraChatDecision["operations"]) {
    const testcases: Body[] = [];
    const activity: Body[] = [];
    // Final hard gate: never persist an operation whose capability is disabled, regardless of what the model emitted.
    const capabilities = await this.zyraProjectCapabilities(projectId);
    const allowed = operations.filter((op) => {
      if (op.type === "create" || op.type === "update" || op.type === "archive") return capabilities.testcaseStorage;
      if (op.type === "create_suite" || op.type === "move_to_suite") return capabilities.suiteOperations;
      return false;
    });
    for (const op of allowed.slice(0, 10)) {
      if (op.type === "create" && op.draft) {
        let created: Body | null = null;
        try {
          created = await this.createTestCase(projectId, {
            title: op.draft.title,
            description: op.draft.description || op.draft.expectedSummary || "",
            preconditions: op.draft.preconditions || "",
            stepsJson: this.safeSteps(op.draft.stepsJson || op.draft.steps),
            testData: op.draft.testData || "",
            priority: op.draft.priority || "P2",
            severity: op.draft.severity || null,
            type: op.draft.type || "Functional",
            status: op.draft.status || "Draft",
            component: op.draft.component || null,
            jiraIssueKey: op.draft.jiraIssueKey || null
          });
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === "23505") continue; // duplicate — skip silently
          throw err;
        }
        const row = await this.getTestCase(created.id);
        testcases.push(this.chatTestcaseRow(row, "created", op.reason));
        activity.push({ actor: "agent", title: "Created testcase", detail: `${created.externalId} ${created.title}`, createdAt: new Date().toISOString() });
        await this.logProjectActivity(projectId, userId, "zyra_created", "testcase", created.id, `${created.externalId} - ${created.title}`, { source: "zyra_chat", reason: op.reason || null });
      } else if ((op.type === "update" || op.type === "archive") && (op.testcaseId || op.externalId)) {
        const found = await this.findProjectTestcase(projectId, op.testcaseId, op.externalId);
        if (!found) continue;
        const fields = op.type === "archive" ? { status: "Archived" } : this.sanitizeZyraUpdateFields(op.fields || {});
        await this.patchTestCaseFromZyra(found.id, fields);
        const row = await this.getTestCase(found.id);
        const action = op.type === "archive" ? "archived" : "updated";
        testcases.push(this.chatTestcaseRow(row, action, op.reason));
        activity.push({ actor: "agent", title: `${action[0].toUpperCase()}${action.slice(1)} testcase`, detail: `${row.externalId} ${row.title}`, createdAt: new Date().toISOString() });
        await this.logProjectActivity(projectId, userId, `zyra_${action}`, "testcase", found.id, `${row.externalId} - ${row.title}`, { source: "zyra_chat", fields, reason: op.reason || null });
      } else if (op.type === "create_suite" && op.suiteName) {
        const suite = await this.resolveOrCreateSuiteByName(projectId, op.suiteName);
        activity.push({ actor: "agent", title: suite.created ? "Created suite" : "Suite already exists", detail: suite.name, createdAt: new Date().toISOString() });
        if (suite.created) {
          await this.logProjectActivity(projectId, userId, "zyra_suite_created", "suite", suite.id, suite.name, { source: "zyra_chat", reason: op.reason || null });
        }
      } else if (op.type === "move_to_suite" && (op.suiteName || op.suiteId)) {
        const suite = op.suiteId
          ? await this.getProjectSuite(projectId, op.suiteId)
          : await this.resolveOrCreateSuiteByName(projectId, String(op.suiteName));
        if (!suite) continue;
        const targets = await this.resolveZyraMoveTargets(projectId, op, suite.id);
        if (!targets.length) continue;
        const movedIds = targets.map((target) => target.id);
        await this.db.query(
          "UPDATE testcases SET suite_id = $2, updated_at = now() WHERE project_id = $1 AND id = ANY($3::uuid[])",
          [projectId, suite.id, movedIds]
        );
        for (const target of targets.slice(0, 25)) {
          const row = await this.getTestCase(target.id);
          testcases.push(this.chatTestcaseRow(row, "moved", op.reason || `Moved to suite ${suite.name}`));
        }
        activity.push({ actor: "agent", title: `Moved ${movedIds.length} testcase(s) to suite`, detail: `${suite.name}${"created" in suite && suite.created ? " (created)" : ""}`, createdAt: new Date().toISOString() });
        await this.logProjectActivity(projectId, userId, "zyra_moved_to_suite", "suite", suite.id, suite.name, { source: "zyra_chat", movedCount: movedIds.length, testcaseIds: movedIds, reason: op.reason || null });
      }
    }
    return { testcases, activity };
  }

  private async resolveOrCreateSuiteByName(projectId: string, name: string): Promise<{ id: string; name: string; created: boolean }> {
    const trimmed = String(name || "").trim();
    const existing = await this.db.query(
      "SELECT id, name FROM suites WHERE project_id = $1 AND lower(name) = lower($2) ORDER BY position, created_at LIMIT 1",
      [projectId, trimmed]
    ).catch(() => ({ rows: [] as Body[] }));
    if (existing.rows[0]) return { id: String(existing.rows[0].id), name: String(existing.rows[0].name), created: false };
    const created = await this.createSuite(projectId, { name: trimmed }) as Body;
    return { id: String(created.id), name: String(created.name), created: true };
  }

  private async getProjectSuite(projectId: string, suiteId: string): Promise<{ id: string; name: string } | null> {
    const res = await this.db.query(
      "SELECT id, name FROM suites WHERE project_id = $1 AND id = $2::uuid LIMIT 1",
      [projectId, suiteId]
    ).catch(() => ({ rows: [] as Body[] }));
    return res.rows[0] ? { id: String(res.rows[0].id), name: String(res.rows[0].name) } : null;
  }

  // Resolve which existing testcases a move_to_suite op should affect: every non-archived testcase
  // (allExisting), or the ones named by external id / internal id. Never creates testcases.
  private async resolveZyraMoveTargets(projectId: string, op: ZyraChatDecision["operations"][number], targetSuiteId: string): Promise<Array<{ id: string }>> {
    if (op.allExisting) {
      const res = await this.db.query(
        "SELECT id FROM testcases WHERE project_id = $1 AND COALESCE(status,'') <> 'Archived' AND suite_id IS DISTINCT FROM $2::uuid",
        [projectId, targetSuiteId]
      ).catch(() => ({ rows: [] as Body[] }));
      return res.rows.map((row) => ({ id: String(row.id) }));
    }
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const externalIds = [...(op.externalIds || []), ...(op.externalId ? [op.externalId] : [])].map((value) => String(value).trim()).filter(Boolean);
    const internalIds = [...(op.testcaseIds || []), ...(op.testcaseId ? [op.testcaseId] : [])].map((value) => String(value).trim()).filter((value) => uuidPattern.test(value));
    if (!externalIds.length && !internalIds.length) return [];
    const res = await this.db.query(
      "SELECT id FROM testcases WHERE project_id = $1 AND (external_id = ANY($2::text[]) OR id = ANY($3::uuid[]))",
      [projectId, externalIds, internalIds]
    ).catch(() => ({ rows: [] as Body[] }));
    return res.rows.map((row) => ({ id: String(row.id) }));
  }

  private async generateZyraChatTestcasesWithAi(params: {
    projectId: string;
    userId: string;
    provider: string;
    model: string;
    key: Body;
    message: string;
    knowledge: Array<{ title: string; content: string }>;
    existingTestcases: ZyraGenerationInput["existingTestcases"];
    jiraIssueKeys: string[];
    requestedCount: number;
  }): Promise<ZyraChatDecision> {
    const jira = await this.jiraSnapshot(params.projectId, params.jiraIssueKeys);
    const aiResult = await this.generateZyraWithProvider({
      provider: params.provider,
      model: params.model,
      apiKey: params.key.api_key,
      baseUrl: params.key.base_url,
      authHeaderName: params.key.auth_header_name,
      authScheme: params.key.auth_scheme,
      projectId: params.projectId,
      input: {
        story: params.message,
        context: "Generated from Zyra chat after reading project knowledge, Jira ticket details, Zyra memory, and existing testcase coverage.",
        acceptanceCriteria: "",
        feedback: "",
        knowledge: params.knowledge,
        jira,
        existingTestcases: params.existingTestcases,
        requestedCount: params.requestedCount
      }
    });
    await this.rememberZyraMemory(params.projectId, params.userId, [
      `Chat request: ${params.message}`,
      `AI generated ${aiResult.drafts.length} testcase draft(s).`,
      params.jiraIssueKeys.length ? `Jira keys: ${params.jiraIssueKeys.join(", ")}` : "",
      `Sources considered: ${params.knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), ${params.existingTestcases.length} existing testcase(s).`
    ].filter(Boolean).join("\n"));
    return {
      reply: `I used the AI provider to generate ${aiResult.drafts.length} testcase candidate(s) after reading ${jira.length} Jira ticket(s), ${params.knowledge.length} knowledge-base item(s), and ${params.existingTestcases.length} nearby testcase(s).`,
      reasoningSummary: `AI generation used ${params.provider}/${params.model}. It considered Jira keys ${params.jiraIssueKeys.length ? params.jiraIssueKeys.join(", ") : "none explicitly mentioned"}, knowledge-base context, existing coverage for duplicate avoidance, and Zyra memory. Tokens: input ${aiResult.usage.input}, output ${aiResult.usage.output}.`,
      actionType: "create",
      operations: aiResult.drafts.map((draft) => ({
        type: "create",
        draft: {
          ...draft,
          jiraIssueKey: params.jiraIssueKeys[0] || draft.jiraIssueKey || null
        },
        reason: "Generated by AI from Zyra chat context."
      })),
      testcases: aiResult.drafts.map((draft) => this.chatDraftRow(draft, "suggested", "Generated by AI from Zyra chat context."))
    };
  }

  private async finalizeZyraToolDecisionWithAi(params: {
    key: Body;
    provider: string;
    model: string;
    message: string;
    context: string;
    toolName: string;
    toolDecision: ZyraChatDecision;
  }): Promise<ZyraChatDecision> {
    const finalizePrompt = [
      params.context,
      "",
      "A backend project-data tool has completed. Use this exact tool result as factual source data.",
      "Write the final user-facing response in Zyra's expert QA voice.",
      "Do not invent numbers, tickets, or testcase rows beyond the tool result.",
      "Return ONLY a single valid JSON object — no markdown fences, no text outside the JSON:",
      "{\"reply\":\"\",\"reasoningSummary\":\"\",\"action\":\"answer\",\"actionType\":\"answer\",\"operations\":[],\"testcases\":[{}]}",
      "REPLY FIELD: human-readable markdown. Use ## headings, - bullets, **bold**, markdown tables (| H | H |\\n|---|---|\\n| v | v |). Never put raw JSON or code blocks inside reply. Be direct and structured.",
      "",
      `Tool name: ${params.toolName}`,
      `Tool result JSON: ${JSON.stringify(params.toolDecision)}`
    ].join("\n");
    const raw = params.provider === "anthropic"
      ? await this.zyraChatWithAnthropic(params.key, params.model, finalizePrompt, params.message)
      : await this.zyraChatWithOpenAi(params.key, params.model, finalizePrompt, params.message);
    return {
      reply: this.sanitizeZyraReply(raw.reply, String(params.toolDecision.reply || "")),
      reasoningSummary: String(raw.reasoningSummary || params.toolDecision.reasoningSummary || "").slice(0, 1500),
      actionType: "answer",
      operations: [],
      testcases: normalizeJsonArray(raw.testcases).length ? normalizeJsonArray(raw.testcases).slice(0, 50) : params.toolDecision.testcases
    };
  }

  async aiGenerate(projectId: string, userId: string | null | undefined, body: Body) {
    const uid = this.requireUser(userId);
    const allocation = await this.db.query(
      `SELECT k.provider, k.default_model, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1 AND k.is_active = true`,
      [projectId]
    );
    if (!allocation.rows[0]) throw new BadRequestException({ error: "Zyra is inactive. Allocate an OpenAI or Claude key to this project first." });
    const provider = String(body.provider || allocation.rows[0].provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, body.model || allocation.rows[0].default_model);
    const project = await this.getProject(projectId);
    const settings = this.parseProjectSettings(project.settings).zyraAgent || {};
    if (!this.normalizeZyraCapabilities((settings as Body).capabilities).generation) {
      throw new BadRequestException({ error: "Test case generation is disabled for Zyra in this project. Enable it under Zyra → Settings → Capabilities.", code: "zyra_capability_disabled" });
    }
    const testcaseRange = String((settings as Body).testcaseRange || "1-10");
    const { requestedCount } = this.testcaseRangeConfig(testcaseRange);
    const story = String(body.userStory || body.story || "").trim();
    const context = String(body.context || body.prompt || "").trim();
    const acceptanceCriteria = String(body.acceptanceCriteria || "").trim();
    if (!story) throw new BadRequestException({ error: "story is required" });
    const jiraIssueKeys = normalizeJsonArray(body.jiraIssueKeys).map(String);
    const knowledgeItemIds = normalizeJsonArray(body.knowledgeItemIds).map(String).filter(Boolean);
    const feedback = String(body.feedback || "").trim();
    const now = new Date().toISOString();
    const activityLog = [
      { actor: "user", stage: "todo", title: "Task created", detail: story, createdAt: now },
      { actor: "agent", stage: "todo", title: "Waiting for Zyra", detail: "Zyra will pick up this task and move it to In Progress.", createdAt: now }
    ];
    const sourceSummary = [
      { type: "story", title: "User story", detail: story.slice(0, 320) },
      ...(context ? [{ type: "context", title: "User context", detail: context.slice(0, 320) }] : []),
      ...jiraIssueKeys.map((key) => ({ type: "jira", title: key, detail: "Selected Jira ticket queued for Zyra." }))
    ];
    const res = await this.db.query(
      `INSERT INTO ai_generation_requests
       (project_id, requested_by, provider, model, user_story, acceptance_criteria, custom_prompt, requested_count,
        generated_count, generated_payload, agent_name, task_status, feedback, context, jira_issue_keys,
        token_input, token_output, token_total, source_summary, activity_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'[]'::jsonb,$9,'todo',$10,$11,$12::jsonb,0,0,0,$13::jsonb,$14::jsonb)
       RETURNING *`,
      [
        projectId,
        uid,
        provider,
        model,
        story,
        acceptanceCriteria,
        context,
        requestedCount,
        ZYRA_AGENT_NAME,
        feedback,
        context,
        JSON.stringify(jiraIssueKeys),
        JSON.stringify(sourceSummary),
        JSON.stringify(activityLog)
      ]
    );
    void this.processZyraTask(projectId, res.rows[0].id, { userId: uid, knowledgeItemIds }).catch(() => undefined);
    return {
      generationRequestId: res.rows[0].id,
      task: this.formatAiTask(res.rows[0]),
      provider,
      drafts: [],
      generatedCount: 0,
      tokenUsage: { input: 0, output: 0, total: 0 }
    };
  }

  private async processZyraTask(projectId: string, taskId: string, options: { userId: string; knowledgeItemIds?: string[] }) {
    const taskRes = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    const task = taskRes.rows[0];
    if (!task) return;
    const allocation = await this.db.query(
      `SELECT k.provider, k.default_model, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1 AND k.is_active = true`,
      [projectId]
    );
    if (!allocation.rows[0]) return;
    const now = new Date().toISOString();
    const startedActivity = [{
      actor: "agent",
      stage: "in_progress",
      title: "Picked up task",
      detail: "Zyra moved this task from Todo to In Progress.",
      createdAt: now
    }];
    await this.db.query(
      "UPDATE ai_generation_requests SET task_status = 'in_progress', activity_log = activity_log || $3::jsonb, updated_at = now() WHERE id = $1 AND project_id = $2",
      [taskId, projectId, JSON.stringify(startedActivity)]
    );

    try {
      const story = String(task.user_story || "");
      const context = String(task.context || task.custom_prompt || "");
      const acceptanceCriteria = String(task.acceptance_criteria || "");
      const feedback = String(task.feedback || "");
      const jiraIssueKeys = normalizeJsonArray(task.jira_issue_keys).map(String);
      const projectSettings = this.parseProjectSettings((await this.getProject(projectId)).settings).zyraAgent || {};
      const testcaseRange = String((projectSettings as Body).testcaseRange || "1-10");
      const { requestedCount } = this.testcaseRangeConfig(testcaseRange);
      const provider = String(task.provider || allocation.rows[0].provider || "openai").toLowerCase();
      const model = normalizeProviderModel(provider, task.model || allocation.rows[0].default_model);
      const knowledge = await this.knowledgeSnapshot(projectId, options.knowledgeItemIds || []);
      const jira = await this.jiraSnapshot(projectId, jiraIssueKeys);
      const existingTestcases = await this.existingTestcaseSnapshot(projectId, story, context);
      const aiResult = await this.generateZyraWithProvider({
        provider,
        model,
        apiKey: allocation.rows[0].api_key,
        baseUrl: allocation.rows[0].base_url,
        authHeaderName: allocation.rows[0].auth_header_name,
        authScheme: allocation.rows[0].auth_scheme,
        projectId,
        input: { story, context, acceptanceCriteria, feedback, knowledge, jira, existingTestcases, requestedCount, testcaseRange }
      });
      const drafts = aiResult.drafts;
      const inputText = [
        story,
        context,
        acceptanceCriteria,
        feedback,
        knowledge.map((item) => `${item.title}\n${item.content}`).join("\n"),
        jira.map((t) => `${t.key} ${t.summary}`).join("\n"),
        existingTestcases.map((tc) => `${tc.externalId} ${tc.title} ${tc.description}`).join("\n")
      ].join("\n");
      const tokenInput = aiResult.usage.input || estimateTokens(inputText);
      const tokenOutput = aiResult.usage.output || estimateTokens(JSON.stringify(drafts));
      const sourceSummary = [
        { type: "story", title: "User story", detail: story.slice(0, 320) },
        ...(context ? [{ type: "context", title: "User context", detail: context.slice(0, 320) }] : []),
        ...knowledge.map((item) => ({ type: "knowledge_base", title: item.title, detail: item.content.slice(0, 320) })),
        ...jira.map((item) => ({ type: "jira", title: item.key, detail: `${item.summary} ${item.description}`.trim().slice(0, 320) })),
        ...existingTestcases.map((item) => ({ type: "existing_testcase", title: `${item.externalId} ${item.title}`, detail: item.description.slice(0, 320) }))
      ];
      const finishedAt = new Date().toISOString();
      const activity = [
        { actor: "agent", stage: "in_progress", title: "Read available sources", detail: `Considered ${knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), ${existingTestcases.length} existing testcase(s), Zyra memory, and the supplied story/context.`, createdAt: finishedAt },
        { actor: "agent", stage: "in_progress", title: "Generation plan", detail: this.zyraThinking({ story, context, acceptanceCriteria, feedback, knowledgeCount: knowledge.length, jiraCount: jira.length }), createdAt: finishedAt },
        { actor: "agent", stage: "in_review", title: "Generated testcase drafts", detail: `Generated ${drafts.length} testcase draft(s) with ${provider}${aiResult.requestId ? ` request ${aiResult.requestId}` : ""}. Cached input tokens: ${aiResult.usage.cached}.`, createdAt: finishedAt }
      ];
      await this.db.query(
        `UPDATE ai_generation_requests
         SET generated_count = $3, generated_payload = $4::jsonb,
             token_input = $5, token_output = $6, token_total = $7,
             source_summary = $8::jsonb, activity_log = activity_log || $9::jsonb,
             task_status = 'in_review', updated_at = now()
         WHERE id = $1 AND project_id = $2`,
        [taskId, projectId, drafts.length, JSON.stringify(drafts), tokenInput, tokenOutput, tokenInput + tokenOutput, JSON.stringify(sourceSummary), JSON.stringify(activity)]
      );
      await this.rememberZyraMemory(projectId, options.userId, [
        `Task: ${story}`,
        `Generated ${drafts.length} testcase draft(s).`,
        `Sources considered: ${knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s).`,
        `Coverage plan: ${this.zyraThinking({ story, context, acceptanceCriteria, feedback, knowledgeCount: knowledge.length, jiraCount: jira.length })}`
      ].join("\n"));
    } catch (error) {
      const failedAt = new Date().toISOString();
      const detail = error instanceof Error ? error.message : "Zyra failed to generate testcase drafts.";
      const activity = [{ actor: "agent", stage: "todo", title: "Generation failed", detail, createdAt: failedAt }];
      await this.db.query(
        "UPDATE ai_generation_requests SET task_status = 'todo', activity_log = activity_log || $3::jsonb, updated_at = now() WHERE id = $1 AND project_id = $2",
        [taskId, projectId, JSON.stringify(activity)]
      );
    }
  }

  async aiHistory(projectId: string, query: Body) {
    const limit = Math.min(Number(query.limit || 50), 100);
    const offset = Number(query.offset || 0);
    const res = await this.db.query(
      `SELECT * FROM ai_generation_requests WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [projectId, limit, offset]
    );
    return { list: res.rows.map(toCamel) };
  }

  async aiSave(projectId: string, requestId: string, body: Body) {
    const savedAt = new Date().toISOString();
    const events = [{ suiteId: body.suiteId || null, testcaseIds: body.testcaseIds || [], savedAt }];
    const activity = [{
      actor: "user",
      stage: "done",
      title: "Accepted and saved testcases",
      detail: `Saved ${Array.isArray(body.testcaseIds) ? body.testcaseIds.length : 0} testcase(s).`,
      createdAt: savedAt
    }];
    await this.db.query(
      `UPDATE ai_generation_requests
       SET saved_count = saved_count + $3, save_events = save_events || $4::jsonb,
           activity_log = activity_log || $5::jsonb, task_status = 'done', updated_at = now()
       WHERE id = $1 AND project_id = $2`,
      [requestId, projectId, Array.isArray(body.testcaseIds) ? body.testcaseIds.length : 0, JSON.stringify(events), JSON.stringify(activity)]
    );
  }

  async zyraFeedback(projectId: string, userId: string | null | undefined, taskId: string, body: Body) {
    const existing = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    const uid = this.requireUser(userId);
    const feedbackText = String(body.feedback || "").trim();
    const referenceNote = String(body.referenceNote || "").trim();
    const additionalJiraIssueKeys = normalizeJsonArray(body.jiraIssueKeys).map(String).filter(Boolean);
    const feedback = [
      feedbackText,
      referenceNote ? `Referenced docs or tickets for knowledge base:\n${referenceNote}` : ""
    ].filter(Boolean).join("\n\n");
    if (!feedback) throw new BadRequestException({ error: "feedback is required" });
    const allocation = await this.db.query(
      `SELECT k.provider, k.default_model, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme
       FROM project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.project_id = $1 AND k.is_active = true`,
      [projectId]
    );
    if (!allocation.rows[0]) throw new BadRequestException({ error: "Zyra is inactive. Allocate an OpenAI or Claude key to this project first." });
    const feedbackActivity = [{
      actor: "user",
      stage: "todo",
      title: "Review feedback submitted",
      detail: [
        feedbackText,
        referenceNote ? `References: ${referenceNote}` : "",
        additionalJiraIssueKeys.length ? `Jira tickets: ${additionalJiraIssueKeys.join(", ")}` : ""
      ].filter(Boolean).join("\n"),
      createdAt: new Date().toISOString()
    }];
    await this.db.query(
      "UPDATE ai_generation_requests SET task_status = 'todo', feedback = $3, activity_log = activity_log || $4::jsonb, updated_at = now() WHERE id = $1 AND project_id = $2",
      [taskId, projectId, feedback, JSON.stringify(feedbackActivity)]
    );
    const story = existing.rows[0].user_story;
    const context = existing.rows[0].context || existing.rows[0].custom_prompt || "";
    const acceptanceCriteria = existing.rows[0].acceptance_criteria || "";
    const jiraIssueKeys = Array.from(new Set([...normalizeJsonArray(existing.rows[0].jira_issue_keys).map(String), ...additionalJiraIssueKeys]));
    const requestedCount = Number(existing.rows[0].requested_count || 5);
    const provider = String(existing.rows[0].provider || allocation.rows[0].provider || "openai").toLowerCase();
    const model = normalizeProviderModel(provider, existing.rows[0].model || allocation.rows[0].default_model);
    const knowledge = await this.knowledgeSnapshot(projectId);
    const jira = await this.jiraSnapshot(projectId, jiraIssueKeys);
    const existingTestcases = await this.existingTestcaseSnapshot(projectId, story, context);
    const aiResult = await this.generateZyraWithProvider({
      provider,
      model,
      apiKey: allocation.rows[0].api_key,
      baseUrl: allocation.rows[0].base_url,
      authHeaderName: allocation.rows[0].auth_header_name,
      authScheme: allocation.rows[0].auth_scheme,
      projectId,
      input: { story, context, acceptanceCriteria, feedback, knowledge, jira, existingTestcases, requestedCount }
    });
    const now = new Date().toISOString();
    const activity = [
      { actor: "agent", stage: "in_progress", title: "Moved task back to Todo", detail: "Zyra queued the task again after reviewer feedback.", createdAt: now },
      { actor: "agent", stage: "in_progress", title: "Re-read sources with feedback", detail: `Reused the same task and applied feedback against ${knowledge.length} knowledge-base item(s), ${jira.length} Jira ticket(s), ${existingTestcases.length} existing testcase(s), Zyra memory, and ${referenceNote ? "the referenced docs/tickets" : "the existing context"}.`, createdAt: now },
      { actor: "agent", stage: "in_review", title: "Regenerated testcase drafts", detail: `Updated this task with ${aiResult.drafts.length} regenerated draft(s). Cached input tokens: ${aiResult.usage.cached}.`, createdAt: now }
    ];
    const previousSources = normalizeJsonArray(existing.rows[0].source_summary);
    const nextSources = [
      ...previousSources,
      ...(referenceNote ? [{ type: "feedback_reference", title: "Reviewer reference", detail: referenceNote.slice(0, 320) }] : []),
      ...additionalJiraIssueKeys.map((key) => ({ type: "jira", title: key, detail: "Referenced by reviewer feedback." })),
      ...existingTestcases.map((item) => ({ type: "existing_testcase", title: `${item.externalId} ${item.title}`, detail: item.description.slice(0, 320) }))
    ];
    const res = await this.db.query(
      `UPDATE ai_generation_requests
       SET generated_count = $3, generated_payload = $4::jsonb, feedback = $5,
           token_input = token_input + $6, token_output = token_output + $7, token_total = token_total + $8,
           activity_log = activity_log || $9::jsonb, source_summary = $10::jsonb, jira_issue_keys = $11::jsonb,
           task_status = 'in_review', updated_at = now()
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [
        taskId,
        projectId,
        aiResult.drafts.length,
        JSON.stringify(aiResult.drafts),
        feedback,
        aiResult.usage.input,
        aiResult.usage.output,
        aiResult.usage.total,
        JSON.stringify(activity),
        JSON.stringify(nextSources),
        JSON.stringify(jiraIssueKeys)
      ]
    );
    await this.rememberZyraMemory(projectId, uid, [
      `Task: ${story}`,
      `Feedback applied: ${feedbackText}`,
      referenceNote ? `Reviewer references: ${referenceNote}` : "",
      additionalJiraIssueKeys.length ? `Jira references: ${additionalJiraIssueKeys.join(", ")}` : "",
      `Regenerated ${aiResult.drafts.length} testcase draft(s).`
    ].filter(Boolean).join("\n"));
    return {
      generationRequestId: taskId,
      task: this.formatAiTask(res.rows[0]),
      provider,
      drafts: aiResult.drafts,
      generatedCount: aiResult.drafts.length,
      tokenUsage: aiResult.usage
    };
  }

  async zyraDeleteDraft(projectId: string, taskId: string, draftIndex: number) {
    const existing = await this.db.query("SELECT generated_payload FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    const drafts = normalizeJsonArray(existing.rows[0].generated_payload);
    if (!Number.isInteger(draftIndex) || draftIndex < 0 || draftIndex >= drafts.length) {
      throw new BadRequestException({ error: "Invalid testcase draft index" });
    }
    const [removed] = drafts.splice(draftIndex, 1);
    const now = new Date().toISOString();
    const activity = [{
      actor: "user",
      stage: "in_review",
      title: "Deleted testcase draft",
      detail: String(removed?.title || `Draft ${draftIndex + 1}`),
      createdAt: now
    }];
    const res = await this.db.query(
      `UPDATE ai_generation_requests
       SET generated_payload = $3::jsonb, generated_count = $4,
           activity_log = activity_log || $5::jsonb, updated_at = now()
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [taskId, projectId, JSON.stringify(drafts), drafts.length, JSON.stringify(activity)]
    );
    return this.formatAiTask(res.rows[0]);
  }

  async zyraCloseTask(projectId: string, taskId: string) {
    const existing = await this.db.query("SELECT id, task_status FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    const now = new Date().toISOString();
    const activity = [{
      actor: "user",
      stage: "done",
      title: "Closed task",
      detail: "Task closed from review without saving additional testcase drafts.",
      createdAt: now
    }];
    const res = await this.db.query(
      `UPDATE ai_generation_requests
       SET task_status = 'done', activity_log = activity_log || $3::jsonb, updated_at = now()
       WHERE id = $1 AND project_id = $2
       RETURNING *`,
      [taskId, projectId, JSON.stringify(activity)]
    );
    return this.formatAiTask(res.rows[0]);
  }

  async zyraSave(projectId: string, taskId: string, body: Body) {
    const existing = await this.db.query("SELECT * FROM ai_generation_requests WHERE id = $1 AND project_id = $2", [taskId, projectId]);
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra task not found" });
    let suiteId = body.suiteId || null;
    if (!suiteId && body.suiteName) {
      const suite = await this.createSuite(projectId, { name: body.suiteName });
      suiteId = (suite as Body).id;
    }
    const drafts = normalizeJsonArray(existing.rows[0].generated_payload);
    const selectedIndexes = normalizeJsonArray(body.selectedDraftIndexes).map(Number);
    const selected = selectedIndexes.length ? selectedIndexes.map((index) => drafts[index]).filter(Boolean) : drafts;
    const jiraKeys = normalizeJsonArray(existing.rows[0].jira_issue_keys).map(String).filter(Boolean);
    const jiraIssueKey = jiraKeys[0] || null;
    const jiraTicket = jiraIssueKey
      ? await this.db.query("SELECT jira_url FROM jira_tickets WHERE project_id = $1 AND jira_issue_key = $2 LIMIT 1", [projectId, jiraIssueKey]).catch(() => ({ rows: [] as Body[] }))
      : { rows: [] as Body[] };
    const jiraUrl = jiraTicket.rows[0]?.jira_url || null;
    const existingLinked = jiraIssueKey
      ? await this.db.query(
          "SELECT id FROM testcases WHERE project_id = $1 AND jira_issue_key = $2 ORDER BY updated_at ASC",
          [projectId, jiraIssueKey]
        )
      : { rows: [] as Body[] };
    const created = [];
    const touched = [];
    for (const [index, draft] of selected.entries()) {
      const baseTags = Array.isArray(draft.tags) ? draft.tags.map(String) : [];
      const tags = Array.from(new Set([
        ...baseTags,
        "zyra",
        ...(jiraIssueKey ? [`jira:${jiraIssueKey}`] : []),
        existingLinked.rows[index]?.id ? "zyra-regenerated" : "zyra-generated"
      ])).join(",");
      const payload = {
        suiteId,
        title: draft.title,
        description: draft.expectedSummary || "",
        preconditions: draft.preconditions || "",
        stepsJson: this.safeSteps(draft.stepsJson),
        priority: draft.priority || "P2",
        type: "Functional",
        status: "Draft",
        automationTags: tags,
        jiraIssueKey,
        jiraUrl
      };
      if (existingLinked.rows[index]?.id) {
        await this.updateTestCase(existingLinked.rows[index].id, payload);
        touched.push({ id: existingLinked.rows[index].id, title: draft.title, updated: true });
      } else {
        const testcase = await this.createTestCase(projectId, payload);
        created.push(testcase);
        touched.push(testcase);
      }
    }
    await this.aiSave(projectId, taskId, { suiteId, testcaseIds: touched.map((item) => item.id) });
    return { savedCount: touched.length, suiteId, testcases: touched };
  }

  private parseProjectSettings(raw: unknown): Body {
    if (!raw) return {};
    if (typeof raw === "object") return raw as Body;
    if (typeof raw !== "string") return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async rememberZyraMemory(projectId: string, userId: string | null, entry: string) {
    const title = "Zyra AI Memory";
    const existing = await this.db.query<{ id: string; content: string }>(
      "SELECT id, content FROM knowledge_base_items WHERE project_id = $1 AND item_type = 'note' AND title = $2 ORDER BY updated_at DESC LIMIT 1",
      [projectId, title]
    );
    const stampedEntry = `## ${new Date().toISOString()}\n${entry.trim()}`.slice(0, 2500);
    if (existing.rows[0]) {
      const content = [stampedEntry, String(existing.rows[0].content || "")].filter(Boolean).join("\n\n").slice(0, 20000);
      await this.db.query("UPDATE knowledge_base_items SET content = $2, updated_at = now() WHERE id = $1", [existing.rows[0].id, content]);
      return;
    }
    await this.db.query(
      "INSERT INTO knowledge_base_items (project_id, item_type, title, content, created_by) VALUES ($1, 'note', $2, $3, $4)",
      [projectId, title, stampedEntry, userId]
    );
  }

  private async knowledgeSnapshot(projectId: string, selectedItemIds: string[] = []): Promise<Array<{ title: string; content: string }>> {
    const selected = Array.from(new Set(selectedItemIds.filter(Boolean)));
    const values: any[] = [projectId];
    let filter = "project_id = $1";
    if (selected.length) {
      values.push(selected);
      filter += ` AND (id = ANY($${values.length}::uuid[]) OR title = 'Zyra AI Memory')`;
    }
    const res = await this.db.query(
      `SELECT title, item_type, content, file_name FROM knowledge_base_items
       WHERE ${filter}
       ORDER BY CASE WHEN title = 'Zyra AI Memory' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 12`,
      values
    );
    return res.rows.map((row) => ({
      title: row.title || row.file_name || "Knowledge base item",
      content: String(row.content || row.file_name || `${row.item_type || "knowledge"} item`).slice(0, 1500)
    }));
  }

  private async existingTestcaseSnapshot(
    projectId: string,
    story: string,
    context: string
  ): Promise<Array<{ externalId: string; title: string; description: string; priority: string; status: string; stepsSummary: string }>> {
    const searchText = [story, context].join(" ").toLowerCase();
    const terms = Array.from(new Set(searchText.split(/[^a-z0-9]+/).filter((word) => word.length > 3))).slice(0, 8);
    const values: any[] = [projectId];
    let orderBy = "updated_at DESC";
    if (terms.length) {
      values.push(terms.map((term) => `%${term}%`));
      orderBy = `CASE WHEN lower(title) LIKE ANY($2::text[]) OR lower(coalesce(description, '')) LIKE ANY($2::text[]) THEN 0 ELSE 1 END, updated_at DESC`;
    }
    const res = await this.db.query(
      `SELECT external_id, title, description, priority, status, steps
       FROM testcases
       WHERE project_id = $1
       ORDER BY ${orderBy}
       LIMIT 25`,
      values
    );
    return res.rows.map((row) => ({
      externalId: row.external_id || "",
      title: String(row.title || "Untitled testcase").slice(0, 240),
      description: String(row.description || "").slice(0, 500),
      priority: String(row.priority || "P2"),
      status: String(row.status || "Draft"),
      stepsSummary: JSON.stringify(normalizeJsonArray(row.steps)).slice(0, 800)
    }));
  }

  private async jiraSnapshot(projectId: string, keys: string[]): Promise<Array<{ key: string; summary: string; description: string }>> {
    const selectedKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
    if (!selectedKeys.length) return [];
    const res = await this.db.query(
      `SELECT jira_issue_key, summary, description FROM jira_tickets
       WHERE project_id = $1 AND jira_issue_key = ANY($2::text[])`,
      [projectId, selectedKeys]
    ).catch(() => ({ rows: [] as any[] }));
    const byKey = new Map<string, { key: string; summary: string; description: string }>(
      res.rows.map((row) => [
        String(row.jira_issue_key),
        {
          key: String(row.jira_issue_key),
          summary: String(row.summary || ""),
          description: String(row.description || "")
        }
      ])
    );

    const missingKeys = selectedKeys.filter((key) => !byKey.has(key));
    if (missingKeys.length) {
      const connection = await this.getJiraConnection(projectId, true).catch(() => null);
      if (connection) {
        for (const key of missingKeys) {
          const issue = await this.jiraFetch<Body>(
            `https://api.atlassian.com/ex/jira/${connection.cloud_id}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,priority,assignee,reporter,labels,created,updated`,
            { headers: { Authorization: `Bearer ${connection.access_token}` } }
          ).catch(() => null);
          if (!issue) continue;
          const fields = (issue.fields || {}) as Body;
          const summary = String(fields.summary || "");
          const description = jiraDescriptionToText(fields.description);
          byKey.set(key, { key, summary, description });
          await this.db.query(
            `INSERT INTO jira_tickets (
               project_id, jira_connection_id, jira_issue_id, jira_issue_key, summary, description,
               issue_type, status, priority, assignee, reporter, labels, jira_created_at, jira_updated_at, jira_url, synced_at
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
             ON CONFLICT (jira_connection_id, jira_issue_id) DO UPDATE SET
               jira_issue_key = EXCLUDED.jira_issue_key,
               summary = EXCLUDED.summary,
               description = EXCLUDED.description,
               issue_type = EXCLUDED.issue_type,
               status = EXCLUDED.status,
               priority = EXCLUDED.priority,
               assignee = EXCLUDED.assignee,
               reporter = EXCLUDED.reporter,
               labels = EXCLUDED.labels,
               jira_created_at = EXCLUDED.jira_created_at,
               jira_updated_at = EXCLUDED.jira_updated_at,
               jira_url = EXCLUDED.jira_url,
               synced_at = now()`,
            [
              projectId,
              connection.id,
              String(issue.id || key),
              String(issue.key || key),
              summary,
              description,
              String(fields.issuetype?.name || ""),
              String(fields.status?.name || ""),
              String(fields.priority?.name || ""),
              String(fields.assignee?.displayName || ""),
              String(fields.reporter?.displayName || ""),
              normalizeJsonArray(fields.labels).join(", "),
              fields.created || null,
              fields.updated || null,
              `${connection.site_url}/browse/${issue.key || key}`
            ]
          ).catch(() => undefined);
        }
      }
    }

    return selectedKeys.map((key) => byKey.get(key) || {
      key,
      summary: "Selected Jira ticket",
      description: "Ticket details were not available from the local cache or Jira API, but the selected key was included for Zyra context."
    });
  }

  private async generateZyraWithProvider(params: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    projectId: string;
    input: ZyraGenerationInput;
  }): Promise<ZyraAiResult> {
    const provider = String(params.provider || "openai").toLowerCase();
    if (provider === "anthropic") return this.generateZyraWithAnthropic(params);
    return this.generateZyraWithOpenAi(params);
  }

  private zyraSystemPrompt(): string {
    return [
      "You are Zyra the Test Generator, an AI testcase generation agent.",
      "Generate practical, detailed QA testcases from the supplied product story, user context, Jira tickets, knowledge-base sources, Zyra memory, and existing testcase repository context.",
      "Review existing testcases before generating. Do not duplicate existing coverage; instead fill gaps, deepen weak coverage, or create clearly distinct edge cases.",
      "Prioritize edge cases, boundary values, negative paths, permissions, data integrity, state transitions, and traceability.",
      "Return only valid JSON matching this shape: {\"drafts\":[{\"title\":\"\",\"preconditions\":\"\",\"stepsJson\":\"[]\",\"expectedSummary\":\"\",\"priority\":\"P1|P2|P3\",\"tags\":[\"\"]}]}",
      "Do not include markdown fences, explanations, comments, or text before or after the JSON object.",
      "stepsJson must be a JSON string containing an array of step objects with step, action, and expected fields."
    ].join("\n");
  }

  private zyraStaticSourcePrompt(input: ZyraGenerationInput): string {
    const knowledge = input.knowledge.length
      ? input.knowledge.map((item, index) => `KB ${index + 1}: ${item.title}\n${item.content}`).join("\n\n")
      : "No knowledge-base notes were available.";
    const jira = input.jira.length
      ? input.jira.map((item) => `${item.key}: ${item.summary}\n${item.description}`).join("\n\n")
      : "No Jira tickets were selected.";
    const existingTestcases = input.existingTestcases.length
      ? input.existingTestcases.map((item) => `${item.externalId}: ${item.title}\nPriority: ${item.priority}; Status: ${item.status}\n${item.description}\nSteps: ${item.stepsSummary}`).join("\n\n")
      : "No existing testcases were available.";
    return [
      "Static project sources for prompt caching:",
      "Knowledge base:",
      knowledge,
      "Jira tickets:",
      jira,
      "Existing testcases to review for context and duplicate avoidance:",
      existingTestcases
    ].join("\n\n");
  }

  private testcaseRangeConfig(range: string): { requestedCount: number; instruction: string } {
    switch (range) {
      case "minimum":
        return { requestedCount: 4, instruction: "Generate only the minimum testcases needed — aim for 1 to 3 highly targeted scenarios covering the most critical paths. Never generate more than 5 testcases." };
      case "10-30":
        return { requestedCount: 25, instruction: "Generate between 10 and 25 testcases. Cover the main flows, key edge cases, negative scenarios, and important variations. Aim for at least 10 distinct testcases." };
      case "all":
        return { requestedCount: 50, instruction: "Generate as many testcases as possible — cover every applicable flow, edge case, boundary value, negative path, and variation. Be exhaustive and do not cap yourself." };
      default: // "1-10"
        return { requestedCount: 10, instruction: "Generate between 1 and 10 testcases. Prioritise quality and relevance; include edge cases only where genuinely important." };
    }
  }

  private zyraDynamicTaskPrompt(input: ZyraGenerationInput): string {
    const instruction = input.testcaseRange
      ? this.testcaseRangeConfig(input.testcaseRange).instruction
      : `Generate exactly ${input.requestedCount} testcase drafts.`;
    return [
      instruction,
      `Story:\n${input.story}`,
      input.acceptanceCriteria ? `Acceptance criteria:\n${input.acceptanceCriteria}` : "",
      input.context ? `User context:\n${input.context}` : "",
      input.feedback ? `Reviewer feedback to apply to this same task:\n${input.feedback}` : "",
      "For every draft, use the selected knowledge, Jira context, Zyra memory, and existing testcase repository context.",
      "Make sure every draft is specific, detailed, testable, and not a duplicate of existing testcases or another generated draft."
    ].filter(Boolean).join("\n\n");
  }

  private normalizeAiDrafts(raw: unknown, requestedCount: number): Body[] {
    let parsed: unknown;
    try {
      const text = typeof raw === "string" ? this.extractJsonPayload(raw) : raw;
      parsed = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      throw new BadRequestException({ error: "AI testcase generation returned invalid JSON" });
    }
    const candidates = Array.isArray(parsed) ? parsed : normalizeJsonArray((parsed as Body)?.drafts);
    if (!candidates.length) throw new BadRequestException({ error: "AI testcase generation returned no testcase drafts" });
    return candidates.slice(0, requestedCount).map((item, index) => {
      const draft = item as Body;
      const tags = Array.isArray(draft.tags) ? draft.tags.map(String) : ["zyra"];
      return {
        title: String(draft.title || `Generated testcase ${index + 1}`).slice(0, 240),
        preconditions: String(draft.preconditions || "Required test data and user permissions are available."),
        stepsJson: typeof draft.stepsJson === "string" ? draft.stepsJson : JSON.stringify(draft.steps || []),
        expectedSummary: String(draft.expectedSummary || draft.expected || "The workflow behaves as expected."),
        priority: String(draft.priority || (index < 2 ? "P1" : "P2")),
        tags
      };
    });
  }

  private extractJsonPayload(raw: string): string {
    const text = raw.trim();
    if (!text) return text;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] || text).trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      const balanced = this.extractBalancedJson(candidate);
      if (balanced) return balanced;
    }
    const firstObject = candidate.indexOf("{");
    const firstArray = candidate.indexOf("[");
    const starts = [firstObject, firstArray].filter((index) => index >= 0);
    if (!starts.length) return candidate;
    const start = Math.min(...starts);
    return this.extractBalancedJson(candidate.slice(start)) || candidate.slice(start).trim();
  }

  private extractBalancedJson(text: string): string | null {
    const open = text[0];
    const close = open === "{" ? "}" : open === "[" ? "]" : "";
    if (!close) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(0, index + 1);
      }
    }
    return null;
  }

  private async generateZyraWithOpenAi(params: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    projectId: string;
    input: ZyraGenerationInput;
  }): Promise<ZyraAiResult> {
    const openAiBody: Body = {
      model: params.model || "gpt-4o",
      messages: [
        { role: "system", content: this.zyraSystemPrompt() },
        { role: "user", content: this.zyraStaticSourcePrompt(params.input) },
        { role: "user", content: this.zyraDynamicTaskPrompt(params.input) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    };
    if (params.provider === "openai") {
      openAiBody.prompt_cache_key = `zyra:${params.projectId}`;
    }
    if (params.provider === "openai" && /^(gpt-5|gpt-4\.1)/.test(String(openAiBody.model))) {
      openAiBody.prompt_cache_retention = "24h";
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const authHeaderName = params.authHeaderName || "Authorization";
    const authScheme = params.authScheme == null ? "Bearer" : String(params.authScheme);
    headers[authHeaderName] = authScheme ? `${authScheme} ${params.apiKey}` : params.apiKey;
    const response = await fetch(normalizeChatCompletionsUrl(params.provider === "openai" ? null : params.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(openAiBody)
    });
    const body = await response.json().catch(() => ({} as Body)) as Body;
    if (!response.ok) {
      const rawMessage = String(body.error?.message || body.error || response.statusText);
      const friendly = this.describeProviderError(params.provider, response.status, rawMessage);
      throw new BadRequestException({
        error: friendly || `${params.provider === "openai" ? "OpenAI" : params.provider} testcase generation failed`,
        detail: rawMessage,
        ...(this.isProviderAuthError(response.status, rawMessage) ? { code: "ai_key_invalid" } : {})
      });
    }
    const content = body.choices?.[0]?.message?.content;
    const usage = body.usage || {};
    return {
      drafts: this.normalizeAiDrafts(content, params.input.requestedCount),
      usage: {
        input: Number(usage.prompt_tokens || 0),
        output: Number(usage.completion_tokens || 0),
        total: Number(usage.total_tokens || 0),
        cached: Number(usage.prompt_tokens_details?.cached_tokens || 0)
      },
      requestId: response.headers.get("x-request-id") || undefined
    };
  }

  private async generateZyraWithAnthropic(params: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    authHeaderName?: string | null;
    authScheme?: string | null;
    projectId: string;
    input: ZyraGenerationInput;
  }): Promise<ZyraAiResult> {
    let lastMessage = "";
    const anthropicUrl = normalizeAnthropicMessagesUrl(params.baseUrl);
    const anthropicHeaders = this.buildAnthropicAuthHeaders(params.apiKey, params.authHeaderName ?? null, params.authScheme ?? null);
    for (const model of anthropicModelCandidates(params.model)) {
      const response = await fetch(anthropicUrl, {
        method: "POST",
        headers: anthropicHeaders,
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          temperature: 0.2,
          system: [
            {
              type: "text",
              text: `${this.zyraSystemPrompt()}\n\n${this.zyraStaticSourcePrompt(params.input)}`,
              cache_control: { type: "ephemeral" }
            }
          ],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: this.zyraDynamicTaskPrompt(params.input) }]
            }
          ]
        })
      });
      const body = await response.json().catch(() => ({} as Body)) as Body;
      if (!response.ok) {
        const rawMessage = String(body.error?.message || body.error || response.statusText);
        const friendly = this.describeProviderError("anthropic", response.status, rawMessage);
        lastMessage = friendly || rawMessage;
        // Auth/permission failures are not model-specific — stop trying candidates and surface a clear message.
        if (this.isProviderAuthError(response.status, rawMessage)) {
          throw new BadRequestException({ error: lastMessage, detail: rawMessage, code: "ai_key_invalid" });
        }
        if (!/model|not.?found|invalid/i.test(rawMessage)) break;
        continue;
      }
      const content = normalizeJsonArray(body.content).map((item) => item?.text || "").join("\n").trim();
      const usage = body.usage || {};
      const cached = Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
      const input = Number(usage.input_tokens || 0) + cached;
      const output = Number(usage.output_tokens || 0);
      return {
        drafts: this.normalizeAiDrafts(content, params.input.requestedCount),
        usage: { input, output, total: input + output, cached },
        requestId: response.headers.get("request-id") || undefined
      };
    }
    throw new BadRequestException({ error: "Claude testcase generation failed", detail: lastMessage || "No compatible Claude model was accepted." });
  }

  private generateZyraDrafts(input: {
    story: string;
    context: string;
    acceptanceCriteria: string;
    feedback: string;
    knowledge: Array<{ title: string; content: string }>;
    jira: Array<{ key: string; summary: string; description: string }>;
    requestedCount: number;
  }) {
    const focus = [
      "happy path",
      "required field boundary",
      "invalid data rejection",
      "permission edge",
      "empty state",
      "duplicate submission",
      "slow network recovery",
      "cross-browser behavior",
      "multi-tab consistency",
      "audit and traceability"
    ];
    const knowledgeHint = input.knowledge[0]?.title || "project knowledge";
    const jiraHint = input.jira[0]?.key ? `${input.jira[0].key} ${input.jira[0].summary}` : "linked requirements";
    const feedbackHint = input.feedback ? ` Incorporate feedback: ${input.feedback}` : "";
    return Array.from({ length: input.requestedCount }).map((_, index) => {
      const angle = focus[index % focus.length];
      const title = `${this.compactTitle(input.story)} - ${angle}`;
      const steps = [
        { step: 1, action: `Review the story, ${jiraHint}, and ${knowledgeHint}.`, expected: "Relevant requirement context is available." },
        { step: 2, action: `Prepare data for the ${angle} scenario.`, expected: "Test data matches the scenario intent." },
        { step: 3, action: `Execute the workflow described in the story.${feedbackHint}`, expected: `The system handles the ${angle} scenario correctly.` },
        { step: 4, action: "Verify stored state, UI messages, and any linked audit output.", expected: "The final result is traceable and consistent." }
      ];
      return {
        title,
        preconditions: input.context || input.acceptanceCriteria || "User has access to the target feature and required project data exists.",
        stepsJson: JSON.stringify(steps),
        expectedSummary: `Covers ${angle} behavior for: ${input.story}`,
        priority: index < 2 ? "P1" : "P2",
        tags: ["zyra", angle.replaceAll(" ", "-")]
      };
    });
  }

  private zyraThinking(input: {
    story: string;
    context: string;
    acceptanceCriteria: string;
    feedback: string;
    knowledgeCount: number;
    jiraCount: number;
  }): string {
    const signals = [
      input.context ? "project context" : null,
      input.acceptanceCriteria ? "acceptance criteria" : null,
      input.knowledgeCount ? `${input.knowledgeCount} knowledge-base source(s)` : null,
      input.jiraCount ? `${input.jiraCount} Jira ticket(s)` : null,
      input.feedback ? "review feedback" : null
    ].filter(Boolean).join(", ");
    return `I checked ${signals || "the submitted story"} and planned coverage across happy path, negative, boundary, permission, data-state, and traceability risks before drafting the testcases.`;
  }

  private async zyraChatWithOpenAi(key: Body, model: string, context: string, message: string): Promise<Body> {
    const body = {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: context },
        { role: "user", content: message }
      ]
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const authHeader = String(key.auth_header_name || "Authorization");
    const scheme = String(key.auth_scheme || "Bearer").trim();
    headers[authHeader] = scheme ? `${scheme} ${key.api_key}` : String(key.api_key);
    const res = await fetch(normalizeChatCompletionsUrl(key.base_url), {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({} as Body)) as Body;
      const rawMessage = String(errBody.error?.message || errBody.error || res.status);
      throw new Error(this.describeProviderError(String(key.provider || "openai"), res.status, rawMessage) || `OpenAI chat failed: ${rawMessage}`);
    }
    const data = await res.json() as Body;
    const content = String(data.choices?.[0]?.message?.content || "{}");
    try {
      return JSON.parse(this.extractJsonPayload(content));
    } catch {
      // AI returned prose instead of JSON — surface it as a plain answer so the
      // user sees the actual message rather than a SyntaxError string.
      return { reply: content.trim().slice(0, 5000), action: "answer", actionType: "answer", operations: [], testcases: [] };
    }
  }

  private async zyraChatWithAnthropic(key: Body, model: string, context: string, message: string): Promise<Body> {
    let lastStatus = "";
    const chatUrl = normalizeAnthropicMessagesUrl(key.base_url);
    const chatHeaders = this.buildAnthropicAuthHeaders(key.api_key, key.auth_header_name, key.auth_scheme);
    for (const candidate of anthropicModelCandidates(model)) {
      const body = {
        model: candidate,
        max_tokens: 2200,
        system: context,
        messages: [{ role: "user", content: message }]
      };
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as Body)) as Body;
        const rawStatus = String(data.error?.message || data.error || res.status);
        const friendly = this.describeProviderError("anthropic", res.status, rawStatus);
        lastStatus = friendly || rawStatus;
        // Auth/permission failures won't be fixed by another model candidate — fail fast and clearly.
        if (this.isProviderAuthError(res.status, rawStatus)) {
          throw new Error(lastStatus);
        }
        if (!/model|not.?found|invalid/i.test(rawStatus)) break;
        continue;
      }
      const data = await res.json() as Body;
      const content = normalizeJsonArray(data.content).map((item) => item?.text || "").join("\n").trim();
      try {
        return JSON.parse(this.extractJsonPayload(content || "{}"));
      } catch {
        // AI returned prose instead of JSON — surface it as a plain answer so the
        // user sees the actual message rather than a SyntaxError string.
        return { reply: content.trim().slice(0, 5000), action: "answer", actionType: "answer", operations: [], testcases: [] };
      }
    }
    throw new Error(`Claude chat failed: ${lastStatus || "No compatible model was accepted."}`);
  }

  private sanitizeZyraReply(raw: unknown, fallback: string): string {
    let text = String(raw ?? "").trim();
    // AI occasionally nests a full JSON blob inside the reply field — unwrap it
    if (text.startsWith("{")) {
      try {
        const inner = JSON.parse(text);
        if (typeof inner?.reply === "string" && inner.reply) text = inner.reply.trim();
      } catch { /* not JSON */ }
    }
    return (text || fallback).slice(0, 5000);
  }

  private normalizeZyraChatDecision(raw: Body, message: string, existingTestcases: ZyraGenerationInput["existingTestcases"], intent: ZyraChatIntent): ZyraChatDecision {
    const modelActionType = ["answer", "create", "update", "archive", "suite", "mixed"].includes(String(raw.actionType))
      ? String(raw.actionType) as ZyraChatDecision["actionType"]
      : "answer";
    const mutationIntent = intent === "create" || intent === "update" || intent === "archive" || intent === "suite";
    const tableIntent = mutationIntent || intent === "list";
    const actionType = intent === "suite" ? "suite" : (mutationIntent ? modelActionType : "answer");
    const opTypes = ["create", "update", "archive", "create_suite", "move_to_suite"];
    const operations = normalizeJsonArray(raw.operations)
      .map((op) => {
        const type = opTypes.includes(String(op?.type)) ? String(op.type) : (intent === "suite" ? "move_to_suite" : "create");
        const externalIds = normalizeJsonArray(op?.externalIds).map((value) => String(value).trim()).filter(Boolean);
        const testcaseIds = normalizeJsonArray(op?.testcaseIds).map((value) => String(value).trim()).filter(Boolean);
        return {
          type: type as ZyraChatDecision["operations"][number]["type"],
          testcaseId: op?.testcaseId ? String(op.testcaseId) : undefined,
          externalId: op?.externalId ? String(op.externalId) : undefined,
          externalIds: externalIds.length ? externalIds.slice(0, 200) : undefined,
          testcaseIds: testcaseIds.length ? testcaseIds.slice(0, 200) : undefined,
          allExisting: op?.allExisting === true,
          suiteName: op?.suiteName ? String(op.suiteName).trim().slice(0, 128) : undefined,
          suiteId: op?.suiteId ? String(op.suiteId).trim() : undefined,
          draft: op?.draft && typeof op.draft === "object" ? op.draft : undefined,
          fields: op?.fields && typeof op.fields === "object" ? op.fields : undefined,
          reason: op?.reason ? String(op.reason).slice(0, 500) : undefined
        };
      })
      .filter((op) => {
        if (op.type === "create") return !!op.draft;
        if (op.type === "create_suite") return !!op.suiteName;
        if (op.type === "move_to_suite") return (!!op.suiteName || !!op.suiteId) && (op.allExisting || !!op.externalIds?.length || !!op.testcaseIds?.length);
        return op.testcaseId || op.externalId; // update / archive
      })
      .slice(0, 10);
    const testcases = tableIntent ? normalizeJsonArray(raw.testcases).slice(0, 25) : [];
    return {
      reply: this.sanitizeZyraReply(raw.reply, this.defaultZyraReply(message, existingTestcases)),
      reasoningSummary: String(raw.reasoningSummary || this.defaultReasoningSummary(existingTestcases.length)).slice(0, 1500),
      actionType,
      operations: mutationIntent ? operations : [],
      testcases
    };
  }

  private fallbackZyraChatDecision(message: string, knowledge: Array<{ title: string; content: string }>, existingTestcases: ZyraGenerationInput["existingTestcases"], intent: ZyraChatIntent): ZyraChatDecision {
    if (intent === "create") {
      return this.aiUnavailableForZyraChat(existingTestcases.length, "AI provider path was unavailable.");
    }
    if ((intent === "update" || intent === "archive") && existingTestcases[0]) {
      const target = existingTestcases[0];
      const type = intent === "archive" ? "archive" : "update";
      return {
        reply: intent === "archive"
          ? `I found ${target.externalId} as the closest matching testcase and archived it instead of permanently deleting it.`
          : `I found ${target.externalId} as the closest matching testcase and marked it for review with Zyra context.`,
        reasoningSummary: this.defaultReasoningSummary(existingTestcases.length),
        actionType: type,
        operations: [{
          type,
          externalId: target.externalId,
          fields: { status: "In Review", priority: target.priority || "P2" },
          reason: "Closest match from the current testcase repository context."
        }],
        testcases: [this.chatDraftRow(target, type === "archive" ? "archived" : "updated", "Closest match from repository context.")]
      };
    }
    if (intent === "list") {
      return {
        reply: existingTestcases.length
          ? `I found ${existingTestcases.length} related testcase(s). The table shows the strongest nearby coverage.`
          : "I did not find matching testcase coverage in the current repository context.",
        reasoningSummary: this.defaultReasoningSummary(existingTestcases.length),
        actionType: "answer",
        operations: [],
        testcases: existingTestcases.slice(0, 8).map((tc) => this.chatDraftRow(tc, "covered", "Relevant existing coverage."))
      };
    }
    return {
      reply: this.defaultZyraReply(message, existingTestcases),
      reasoningSummary: this.defaultReasoningSummary(existingTestcases.length),
      actionType: "answer",
      operations: [],
      testcases: []
    };
  }

  private detectZyraChatIntent(message: string): ZyraChatIntent {
    const lower = message.toLowerCase();
    const jiraWords = /\b(jira|ticket|tickets|story|stories|issue|issues)\b/.test(lower);
    const pendingTestcaseWords = /\b(pending|missing|without|not covered|uncovered|need|needs|remaining)\b/.test(lower)
      && /\b(testcase|test case|testcases|test cases|tests|coverage|writing)\b/.test(lower);
    const testcaseWords = /\b(testcase|test case|testcases|test cases|case|cases|coverage)\b/.test(lower);
    const createWords = /\b(create|generate|add|write|draft|make|prepare|new)\b/.test(lower);
    const updateWords = /\b(update|change|mark|revise|edit|modify|improve)\b/.test(lower);
    const archiveWords = /\b(remove|delete|archive|drop|deprecate)\b/.test(lower);
    const listWords = /\b(show|list|which|what|find|display|compare|covered|covers|coverage|existing)\b/.test(lower);
    const exampleWords = /\b(example|sample|explain|how|why|what is|what are|walk me|describe)\b/.test(lower);
    const suiteWords = /\b(suite|suites|folder|folders)\b/.test(lower);
    const moveWords = /\b(move|moved|moving|assign|assigned|organi[sz]e|organi[sz]ed|group|grouped|regroup|categori[sz]e|reorgani[sz]e)\b/.test(lower);
    // Analysis/review framing: user wants to UNDERSTAND gaps, not generate right now.
    // e.g. "review KB and let me know what gaps we need to generate" → list/answer, not create.
    const analysisWords = /\b(review|analyse|analyze|gap|gaps|let me know|tell me|identify|what to|which to|what we need|which we need|what cases|which cases)\b/.test(lower);

    if (jiraWords && pendingTestcaseWords) return "jira_pending_testcases";
    // Suite work (create a suite, move/assign existing testcases into a suite) wins over create/update:
    // "create a suite and move the existing testcases" must NOT be read as "create new testcases".
    if (suiteWords || (moveWords && testcaseWords)) return "suite";
    if (archiveWords && testcaseWords) return "archive";
    if (updateWords && testcaseWords) return "update";
    // When review/gap/analysis language is present alongside create words, the user is asking
    // Zyra to analyse coverage and identify what to build — not to generate right now.
    // Route to "list" so the main model can reason about the request and reply analytically.
    if (createWords && testcaseWords && analysisWords) return "list";
    if (createWords && testcaseWords) return "create";
    if (testcaseWords && listWords) return "list";
    if (exampleWords) return "example";
    return "answer";
  }

  private normalizeZyraCapabilities(raw: unknown): ZyraCapabilities {
    const caps = (raw && typeof raw === "object" ? raw : {}) as Body;
    return {
      generation: caps.generation !== false,
      knowledgeBase: caps.knowledgeBase !== false,
      testcaseStorage: caps.testcaseStorage !== false,
      suiteOperations: caps.suiteOperations !== false
    };
  }

  private async zyraProjectCapabilities(projectId: string): Promise<ZyraCapabilities> {
    const project = await this.getProject(projectId).catch(() => ({} as Body));
    const zyraAgent = (this.parseProjectSettings((project as Body).settings).zyraAgent || {}) as Body;
    return this.normalizeZyraCapabilities(zyraAgent.capabilities);
  }

  private zyraCapabilityDisabled(capability: keyof ZyraCapabilities, existingCount: number): ZyraChatDecision {
    const label: Record<keyof ZyraCapabilities, string> = {
      generation: "Test case generation",
      knowledgeBase: "Knowledge base access",
      testcaseStorage: "Test case storage operations (create, update, delete, bulk)",
      suiteOperations: "Suite operations (create, move/assign)"
    };
    const reason = `${label[capability]} is currently disabled for Zyra in this project. Enable it under Zyra → Settings → Capabilities, then try again.`;
    return {
      reply: reason,
      reasoningSummary: `Requested a disabled Zyra capability (${capability}). ${existingCount} nearby testcase(s) available for context.`,
      actionType: "answer",
      operations: [],
      testcases: []
    };
  }

  // Generation is allowed but storage is OFF: keep the generated drafts as suggestions, persist nothing.
  private applyStorageGateToGenerated(decision: ZyraChatDecision, capabilities: ZyraCapabilities): ZyraChatDecision {
    if (capabilities.testcaseStorage) return decision;
    return {
      ...decision,
      operations: [],
      actionType: "answer",
      reply: `Test case storage is disabled for Zyra in this project, so these are suggestions only — I did not save them. Enable "Test case storage operations" under Zyra → Settings → Capabilities to let me save generated testcases.\n\n${decision.reply}`
    };
  }

  private aiUnavailableForZyraChat(existingCount: number, reason = "AI generation was not available for this chat request."): ZyraChatDecision {
    return {
      reply: reason,
      reasoningSummary: `Zyra could not complete an AI response. ${existingCount} nearby testcase(s) were available for context. Detail: ${reason}`,
      actionType: "answer",
      operations: [],
      testcases: []
    };
  }

  private extractJiraIssueKeys(message: string): string[] {
    const keys = new Set<string>();
    for (const match of message.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) || []) {
      keys.add(match.toUpperCase());
    }
    const loosePattern = /\b([A-Z][A-Z0-9]{1,9})\s+(\d+)\b/gi;
    let loose: RegExpExecArray | null;
    while ((loose = loosePattern.exec(message))) {
      const prefix = loose[1].toUpperCase();
      if (["THE", "FOR", "AND", "WITH", "FROM", "THIS", "THAT", "CASE", "TEST"].includes(prefix)) continue;
      keys.add(`${prefix}-${loose[2]}`);
    }
    return Array.from(keys);
  }

  private requestedTestcaseCount(message: string): number {
    const explicit = message.match(/\b(\d{1,2})\s+(?:testcases|test cases|tests|cases)\b/i);
    if (explicit) return Math.max(1, Math.min(25, Number(explicit[1])));
    const lower = message.toLowerCase();
    if (lower.includes("all type") || lower.includes("all types") || lower.includes("full coverage")) return 8;
    return 5;
  }

  private intentFromZyraModelAction(action: unknown, fallback: ZyraChatIntent): ZyraChatIntent {
    const value = String(action || "").trim().toLowerCase();
    if (value === "jira_pending_testcases") return "jira_pending_testcases";
    if (value === "suite" || value === "create_suite" || value === "move_to_suite" || value === "list_suites") return "suite";
    if (value === "create" || value === "create_testcases") return "create";
    if (value === "update" || value === "update_testcases") return "update";
    if (value === "archive" || value === "archive_testcases") return "archive";
    if (value === "list" || value === "list_testcases") return "list";
    if (value === "answer") return "answer";
    return fallback;
  }

  private async zyraChatProjectSnapshot(projectId: string): Promise<ZyraChatProjectSnapshot> {
    const [knowledge, suites, testcases, jira, pending, status] = await Promise.all([
      this.db.query(
        `SELECT title
         FROM knowledge_base_items
         WHERE project_id = $1
         ORDER BY updated_at DESC
         LIMIT 12`,
        [projectId]
      ).catch(() => ({ rows: [] as Body[] })),
      this.db.query(
        `SELECT s.id, s.name, COUNT(t.id)::int AS test_case_count
         FROM suites s LEFT JOIN testcases t ON t.suite_id = s.id
         WHERE s.project_id = $1
         GROUP BY s.id, s.name
         ORDER BY s.position, s.name
         LIMIT 50`,
        [projectId]
      ).catch(() => ({ rows: [] as Body[] })),
      this.db.query(
        `SELECT
           COUNT(*)::int AS testcase_count,
           COUNT(*) FILTER (WHERE jira_issue_key IS NOT NULL AND COALESCE(status, '') <> 'Archived')::int AS linked_jira_testcase_count
         FROM testcases
         WHERE project_id = $1`,
        [projectId]
      ).catch(() => ({ rows: [{}] as Body[] })),
      this.db.query(
        `SELECT COUNT(*)::int AS jira_ticket_count, MAX(synced_at) AS last_jira_sync_at
         FROM jira_tickets
         WHERE project_id = $1`,
        [projectId]
      ).catch(() => ({ rows: [{}] as Body[] })),
      this.db.query(
        `WITH linked AS (
           SELECT jira_issue_key
           FROM testcases
           WHERE project_id = $1
             AND jira_issue_key IS NOT NULL
             AND COALESCE(status, '') <> 'Archived'
           GROUP BY jira_issue_key
         )
         SELECT COUNT(j.id)::int AS pending_jira_ticket_count
         FROM jira_tickets j
         LEFT JOIN linked l ON l.jira_issue_key = j.jira_issue_key
         WHERE j.project_id = $1 AND l.jira_issue_key IS NULL`,
        [projectId]
      ).catch(() => ({ rows: [{}] as Body[] })),
      this.jiraStatus(projectId).catch(() => ({ connected: false, connectedProjects: [] }))
    ]);
    return {
      knowledgeCount: knowledge.rows.length,
      knowledgeTitles: knowledge.rows.map((row) => String(row.title || "")).filter(Boolean),
      suites: suites.rows.map((row) => ({ id: String(row.id), name: String(row.name || ""), testCaseCount: Number(row.test_case_count || 0) })),
      testcaseCount: Number(testcases.rows[0]?.testcase_count || 0),
      linkedJiraTestcaseCount: Number(testcases.rows[0]?.linked_jira_testcase_count || 0),
      jiraConnected: Boolean((status as Body).connected),
      jiraProjectCount: normalizeJsonArray((status as Body).connectedProjects).length,
      jiraTicketCount: Number(jira.rows[0]?.jira_ticket_count || 0),
      pendingJiraTicketCount: Number(pending.rows[0]?.pending_jira_ticket_count || 0),
      lastJiraSyncAt: jira.rows[0]?.last_jira_sync_at || null
    };
  }

  private async analyzeZyraJiraTestcaseCoverage(projectId: string): Promise<ZyraChatDecision> {
    const [status, totals, pending] = await Promise.all([
      this.jiraStatus(projectId).catch(() => ({ connected: false, connectedProjects: [] })),
      this.db.query(
        `WITH linked AS (
           SELECT jira_issue_key, COUNT(*)::int AS testcase_count
           FROM testcases
           WHERE project_id = $1
             AND jira_issue_key IS NOT NULL
             AND COALESCE(status, '') <> 'Archived'
           GROUP BY jira_issue_key
         )
         SELECT
           COUNT(j.id)::int AS total_tickets,
           COUNT(l.jira_issue_key)::int AS covered_tickets,
           (COUNT(j.id) - COUNT(l.jira_issue_key))::int AS pending_tickets,
           COALESCE(SUM(l.testcase_count), 0)::int AS linked_testcases,
           MAX(j.synced_at) AS last_synced_at
         FROM jira_tickets j
         LEFT JOIN linked l ON l.jira_issue_key = j.jira_issue_key
         WHERE j.project_id = $1`,
        [projectId]
      ),
      this.db.query(
        `WITH linked AS (
           SELECT jira_issue_key, COUNT(*)::int AS testcase_count
           FROM testcases
           WHERE project_id = $1
             AND jira_issue_key IS NOT NULL
             AND COALESCE(status, '') <> 'Archived'
           GROUP BY jira_issue_key
         )
         SELECT j.jira_issue_key, j.summary, j.issue_type, j.status, j.priority, j.assignee, j.jira_url, j.synced_at
         FROM jira_tickets j
         LEFT JOIN linked l ON l.jira_issue_key = j.jira_issue_key
         WHERE j.project_id = $1 AND l.jira_issue_key IS NULL
         ORDER BY j.jira_updated_at DESC NULLS LAST, j.synced_at DESC
         LIMIT 50`,
        [projectId]
      )
    ]);
    const row = totals.rows[0] || {};
    const totalTickets = Number(row.total_tickets || 0);
    const coveredTickets = Number(row.covered_tickets || 0);
    const pendingTickets = Number(row.pending_tickets || 0);
    const linkedTestcases = Number(row.linked_testcases || 0);
    const connected = Boolean((status as Body).connected);
    const projectCount = normalizeJsonArray((status as Body).connectedProjects).length;
    const pendingRows = pending.rows.map((ticket) => ({
      id: null,
      externalId: ticket.jira_issue_key,
      title: ticket.summary || "Untitled Jira ticket",
      priority: ticket.priority || "Unspecified",
      status: ticket.status || "Unspecified",
      type: ticket.issue_type || "Jira ticket",
      expectedSummary: [
        ticket.assignee ? `Assignee: ${ticket.assignee}` : "Assignee: Unassigned",
        ticket.jira_url ? `URL: ${ticket.jira_url}` : ""
      ].filter(Boolean).join(" | "),
      action: "pending testcase",
      reason: "No active testcase is linked to this Jira issue key."
    }));
    const coveragePct = totalTickets ? Math.round((coveredTickets / totalTickets) * 100) : 0;
    const reply = totalTickets
      ? [
          `I checked the Jira ticket cache and testcase links for this project.`,
          `Total Jira tickets: ${totalTickets}.`,
          `Tickets with at least one active linked testcase: ${coveredTickets}.`,
          `Pending tickets for testcase writing: ${pendingTickets}.`,
          `Active linked testcases across covered tickets: ${linkedTestcases}.`,
          `Coverage by Jira ticket: ${coveragePct}%.`,
          pendingTickets ? "The pending tickets are listed in the table." : "No Jira tickets are currently pending testcase coverage."
        ].join("\n")
      : connected
        ? "Jira is connected, but I did not find synced Jira tickets in the local cache yet. Run Jira sync first, then ask me again and I will calculate pending testcase coverage."
        : "Jira is not connected for this project yet, so I cannot calculate pending testcase coverage. Connect Jira and sync tickets first.";
    return {
      reply,
      reasoningSummary: connected
        ? `Checked ${projectCount} connected Jira project mapping(s), ${totalTickets} cached Jira ticket(s), and active testcases linked by jira_issue_key. Pending means the Jira issue key has zero non-archived linked testcases. Last Jira sync seen: ${row.last_synced_at || "not available"}.`
        : "Checked Jira connection status first; coverage cannot be calculated until Jira is connected and tickets are synced.",
      actionType: "answer",
      operations: [],
      testcases: pendingRows
    };
  }

  private defaultZyraReply(message: string, existingTestcases: ZyraGenerationInput["existingTestcases"]): string {
    if (existingTestcases.length) {
      return `I found ${existingTestcases.length} related testcase(s) in the repository context. At a high level, I would use them as reference coverage, then look for gaps around negative flows, boundaries, permissions, data state, and audit behavior. Ask me to show the related testcases if you want the table.`;
    }
    if (/\b(example|sample|for example|how would|how to)\b/i.test(message)) {
      return "Example: for a password reset feature, I would first explain the expected user flow, then call out risk areas like expired tokens, reused links, throttling, account enumeration, and email delivery delays. I would only create testcase rows if you ask me to generate or save them.";
    }
    return `I can help with that as a QA-focused product assistant. I will answer directly first, then create, list, or update testcases only when you ask for that output.`;
  }

  private defaultReasoningSummary(existingCount: number): string {
    return `Reviewed available knowledge-base notes, recent chat context, and ${existingCount} nearby testcase(s). Focused on coverage gaps, duplicate avoidance, edge cases, boundary values, permissions, data integrity, state transitions, and auditability.`;
  }

  private async findProjectTestcase(projectId: string, testcaseId?: string, externalId?: string) {
    const res = await this.db.query(
      `SELECT id FROM testcases
       WHERE project_id = $1 AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($3::text IS NOT NULL AND external_id = $3::text))
       LIMIT 1`,
      [projectId, testcaseId || null, externalId || null]
    ).catch(() => ({ rows: [] as Body[] }));
    return res.rows[0] || null;
  }

  private sanitizeZyraUpdateFields(fields: Body): Body {
    const allowed = ["title", "description", "preconditions", "postconditions", "stepsJson", "testData", "priority", "severity", "type", "automationStatus", "automationTags", "component", "status", "jiraIssueKey", "jiraUrl"];
    const cleaned: Body = {};
    for (const key of allowed) {
      if (fields[key] !== undefined && fields[key] !== null) cleaned[key] = fields[key];
    }
    if (cleaned.stepsJson) cleaned.stepsJson = this.safeSteps(cleaned.stepsJson);
    return cleaned;
  }

  private async patchTestCaseFromZyra(testcaseId: string, fields: Body) {
    const keys = [
      ["title", "title"],
      ["description", "description"],
      ["preconditions", "preconditions"],
      ["postconditions", "postconditions"],
      ["stepsJson", "steps"],
      ["testData", "test_data"],
      ["priority", "priority"],
      ["severity", "severity"],
      ["type", "type"],
      ["automationStatus", "automation_status"],
      ["automationTags", "automation_tags"],
      ["component", "component"],
      ["status", "status"],
      ["jiraIssueKey", "jira_issue_key"],
      ["jiraUrl", "jira_url"]
    ] as const;
    const sets: string[] = [];
    const values: any[] = [testcaseId];
    for (const [key, column] of keys) {
      if (fields[key] === undefined) continue;
      values.push(column === "steps" ? JSON.stringify(this.safeSteps(fields[key])) : fields[key]);
      sets.push(`${column} = $${values.length}${column === "steps" ? "::jsonb" : ""}`);
    }
    if (!sets.length) return;
    await this.db.query(`UPDATE testcases SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
  }

  private chatDraftRow(value: Body, action: string, reason?: string): Body {
    return {
      id: value.id || null,
      externalId: value.externalId || value.external_id || "",
      title: value.title || "Untitled testcase",
      priority: value.priority || "P2",
      status: value.status || "Draft",
      type: value.type || "Functional",
      preconditions: value.preconditions || "",
      expectedSummary: value.expectedSummary || value.description || "",
      stepsJson: value.stepsJson || value.stepsSummary || value.steps || "[]",
      action,
      reason: reason || ""
    };
  }

  private chatTestcaseRow(row: Body, action: string, reason?: string): Body {
    return this.chatDraftRow({
      id: row.id,
      externalId: row.externalId,
      title: row.title,
      priority: row.priority,
      status: row.status,
      type: row.type,
      preconditions: row.preconditions,
      description: row.description,
      stepsJson: row.steps
    }, action, reason);
  }

  private formatAiTask(row: Body) {
    const item = toCamel(row as QueryResultRow);
    item.drafts = normalizeJsonArray(row.generated_payload);
    item.jiraIssueKeys = normalizeJsonArray(row.jira_issue_keys);
    item.sources = normalizeJsonArray(row.source_summary);
    item.activities = normalizeJsonArray(row.activity_log);
    item.tokenUsage = {
      input: Number(row.token_input || 0),
      output: Number(row.token_output || 0),
      total: Number(row.token_total || 0)
    };
    return item;
  }

  private safeSteps(value: unknown) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private compactTitle(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, 72) || "Generated testcase";
  }

  private async upsertUser(email: string): Promise<string> {
    const res = await this.db.query<{ id: string }>(
      "INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id",
      [email, email.split("@")[0]]
    );
    return res.rows[0].id;
  }

  private async nextExternalId(projectId: string, requestedPrefix?: unknown): Promise<string> {
    const project = await this.db.query<{ key: string; settings: unknown }>("SELECT key, settings FROM projects WHERE id = $1", [projectId]);
    const settings = parseSettings(project.rows[0]?.settings);
    const key = normalizeTestcaseIdPrefix(requestedPrefix)
      || normalizeTestcaseIdPrefix(settings.testcaseIdPrefix)
      || normalizeTestcaseIdPrefix(project.rows[0]?.key)
      || "TC";
    // Use MAX of the trailing numeric part to avoid collisions when IDs have gaps
    const maxRes = await this.db.query<{ n: string }>(
      "SELECT COALESCE(MAX((regexp_match(external_id, '\\d+$'))[1]::int), 0) AS n FROM testcases WHERE project_id = $1 AND external_id LIKE $2",
      [projectId, `${key}-TC-%`]
    );
    return `${key}-TC-${Number(maxRes.rows[0]?.n || 0) + 1}`;
  }

  private async groupTestcases(projectId: string, column: string) {
    const res = await this.db.query<{ name: string; count: string }>(
      `SELECT COALESCE(${column}, 'Unspecified') AS name, COUNT(*) AS count FROM testcases WHERE project_id = $1 GROUP BY ${column}`,
      [projectId]
    );
    return res.rows.map((r) => ({ name: r.name, count: Number(r.count) }));
  }
}
