import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { NyraClient, nyraValidationMessage } from "./nyra.client";

export { nyraValidationMessage };

type Row = Record<string, any>;

const NAME_MAX = 120; // NYRA's own limit (projects.name VARCHAR(120)).
const URL_MAX = 2000;
const USERNAME_MAX = 255; // NYRA's environments.username is VARCHAR(255) and answers 500, not 422, past it.
const PASSWORD_MAX = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (error: string) => new BadRequestException({ error });

function httpUrl(raw: unknown, label: string): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw bad(`${label} is required`);
  if (text.length > URL_MAX) throw bad(`${label} must be at most ${URL_MAX} characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw bad(`${label} must be a valid URL, for example https://staging.example.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad(`${label} must start with http:// or https://`);
  return text;
}

/** Everything NYRA is sent, validated here first so a bad form never costs a round trip. */
export function parseCreateBody(body: Record<string, any> | undefined) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) throw bad("Project name is required");
  if (name.length > NAME_MAX) throw bad(`Project name must be at most ${NAME_MAX} characters`);
  const appUrl = httpUrl(body?.appUrl, "App URL");

  const acct = body?.testAccount && typeof body.testAccount === "object" ? body.testAccount : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const loginUrl = str(acct.loginUrl).trim();
  const username = str(acct.username).trim();
  const password = str(acct.password);
  const loginMethod = str(acct.loginMethod).trim() || "password";
  if (!username && !password && !loginUrl) return { name, appUrl, testAccount: null };

  // Only password login: OTP login needs an emailed code a person must read, which a form cannot supply.
  if (loginMethod !== "password") throw bad("Only password login is supported");
  if (!username) throw bad("Username or email is required for the test account");
  if (username.length > USERNAME_MAX) throw bad(`Username must be at most ${USERNAME_MAX} characters`);
  if (!password) throw bad("Password is required for the test account");
  if (password.length > PASSWORD_MAX) throw bad(`Password must be at most ${PASSWORD_MAX} characters`);
  return {
    name,
    appUrl,
    testAccount: { loginUrl: loginUrl ? httpUrl(loginUrl, "Login page URL") : null, username, password }
  };
}

const ENV_NAME_MAX = 60; // NYRA's environments.name is VARCHAR(60) and answers 500, not 422, past it.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** An environment edit. Fields left out stay as they are; a blank password keeps the saved one. */
export function parseEnvironmentUpdate(body: Record<string, any> | undefined) {
  const out: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw bad("Environment name is required");
    if (name.length > ENV_NAME_MAX) throw bad(`Environment name must be at most ${ENV_NAME_MAX} characters`);
    out.name = name;
  }
  if (body?.baseUrl !== undefined) out.base_url = httpUrl(body.baseUrl, "App URL");
  if (body?.mode !== undefined) {
    if (body.mode !== "observe" && body.mode !== "sandbox") throw bad("Mode must be observe or sandbox");
    out.mode = body.mode;
  }
  if (body?.allowedDomains !== undefined) {
    const list = Array.isArray(body.allowedDomains) ? body.allowedDomains : null;
    if (!list || list.length > 50) throw bad("Allowed domains must be a list of at most 50 domains");
    const domains = list.map((d: unknown) => (typeof d === "string" ? d.trim().toLowerCase() : ""));
    // A bare suffix such as "com" would let the crawler follow every .com site, so only full hostnames pass.
    if (domains.some((d: string) => !DOMAIN.test(d))) throw bad("Each allowed domain must be a full hostname such as accounts.example.com");
    out.allowed_domains = [...new Set(domains)];
  }
  const acct = body?.testAccount;
  if (acct && typeof acct === "object") {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const username = str(acct.username).trim();
    const password = str(acct.password);
    const loginUrl = str(acct.loginUrl).trim();
    if (acct.loginMethod !== undefined && acct.loginMethod !== "password") throw bad("Only password login is supported");
    if (!username) throw bad("Username or email is required for the test account");
    if (username.length > USERNAME_MAX) throw bad(`Username must be at most ${USERNAME_MAX} characters`);
    if (password.length > PASSWORD_MAX) throw bad(`Password must be at most ${PASSWORD_MAX} characters`);
    // login_url is always sent: NYRA clears it when a test account arrives without one.
    out.test_account = {
      login_url: loginUrl ? httpUrl(loginUrl, "Login page URL") : null,
      username,
      login_method: "password",
      ...(password && { password })
    };
  }
  if (!Object.keys(out).length) throw bad("Nothing to update");
  return out;
}

@Injectable()
export class NyraService {
  private readonly logger = new Logger(NyraService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly client: NyraClient,
    private readonly planLimits: PlanLimitsService,
    private readonly legacy: LegacyService
  ) {}

  private get configured(): boolean {
    return this.client.configured;
  }

  /** Project membership, then the EFFECTIVE Pro plan (same order as the Review Board). */
  async requireAccess(userId: string | null | undefined, projectId: string): Promise<Row> {
    const project = await this.legacy.requireProjectAccess(userId, projectId);
    await this.planLimits.assertNyraEnabled(project.organization_id);
    return project;
  }

  requireConfigured(): void {
    if (!this.configured) throw new ServiceUnavailableException({ error: "NYRA is not configured on this server." });
  }

  /** Card state. Not plan-gated and makes no NYRA call: the page shows its own Pro prompt. */
  async state(userId: string | null | undefined, projectId: string) {
    await this.legacy.requireProjectAccess(userId, projectId);
    return { configured: this.configured };
  }

  async list(userId: string | null | undefined, projectId: string) {
    await this.requireAccess(userId, projectId);
    this.requireConfigured();
    return { list: await this.projectsOf(projectId) };
  }

  async create(userId: string | null | undefined, projectId: string, body: Record<string, any>) {
    const project = await this.requireAccess(userId, projectId);
    if (this.legacy.normalizeRole(project.caller_role) === "qa_engineer") {
      throw new ForbiddenException({ error: "Only project owners and managers can create NYRA projects." });
    }
    // Validated before the config check so a bad form is a 400 whether or not NYRA is wired up.
    const input = parseCreateBody(body);
    this.requireConfigured();

    // ponytail: check-then-create, so two simultaneous submits can still both pass (NYRA has no
    // uniqueness or idempotency key). The form disables Create while a request is in flight.
    const existing = await this.projectsOf(projectId);
    if (existing.some((p) => p.name.toLowerCase() === input.name.toLowerCase())) {
      throw new ConflictException({ error: "A NYRA project with this name already exists in this project." });
    }

    const created = await this.client.json("POST", "/projects", { body: {
      name: input.name,
      environment: {
        base_url: input.appUrl,
        ...(input.testAccount && {
          test_account: {
            ...(input.testAccount.loginUrl && { login_url: input.testAccount.loginUrl }),
            username: input.testAccount.username,
            // Always explicit: omitted, NYRA stores a username with no password and the scan skips login.
            login_method: "password",
            password: input.testAccount.password
          }
        })
      }
    } });
    const id = String(created?.id ?? "");
    if (!id) throw new BadGatewayException({ error: "NYRA returned an unexpected response." });
    try {
      await this.db.query(`INSERT INTO nyra_projects (project_id, nyra_project_id, created_by) VALUES ($1, $2, $3)`, [
        projectId,
        id,
        userId
      ]);
    } catch (err) {
      // The NYRA project exists but is not linked, so it would be invisible here. Log the id so it can be linked or removed by hand.
      this.logger.error(`NYRA project ${id} was created but could not be linked to project ${projectId}`, err as Error);
      throw err;
    }
    return this.dto(created);
  }

  /** Access, Pro, the NYRA project being one this Tesbo project created, and NYRA being configured. */
  async requireLinked(userId: string | null | undefined, projectId: string, nyraId: string): Promise<Row> {
    const project = await this.requireAccess(userId, projectId);
    if (!UUID.test(nyraId)) throw new NotFoundException({ error: "NYRA project not found" });
    const link = await this.db.query(`SELECT 1 FROM nyra_projects WHERE project_id = $1 AND nyra_project_id = $2`, [projectId, nyraId]);
    // Same answer for "does not exist" and "belongs to another Tesbo project", so ids cannot be probed.
    if (!link.rows.length) throw new NotFoundException({ error: "NYRA project not found" });
    this.requireConfigured();
    return project;
  }

  /** One NYRA project with its environments, which the scan form needs. */
  async detail(userId: string | null | undefined, projectId: string, nyraId: string) {
    await this.requireLinked(userId, projectId, nyraId);
    const p = await this.client.json("GET", `/projects/${nyraId}`);
    if (!p?.id) throw new BadGatewayException({ error: "NYRA returned an unexpected response." });
    return {
      ...this.dto(p),
      environments: (Array.isArray(p.environments) ? p.environments : []).map((e: Row) => ({
        id: String(e.id),
        name: String(e.name ?? ""),
        baseUrl: e.base_url ?? null,
        mode: e.mode ?? "observe",
        allowedDomains: Array.isArray(e.allowed_domains) ? e.allowed_domains : [],
        loginUrl: e.login_url ?? null,
        username: e.username ?? null,
        loginMethod: e.login_method ?? null,
        hasPassword: !!e.has_password
      }))
    };
  }

  /** Edit an environment of a NYRA project this Tesbo project created. Owners and managers only. */
  async updateEnvironment(userId: string | null | undefined, projectId: string, nyraId: string, envId: string, body: Row) {
    const project = await this.requireLinked(userId, projectId, nyraId);
    if (this.legacy.normalizeRole(project.caller_role) === "qa_engineer") {
      throw new ForbiddenException({ error: "Only project owners and managers can change NYRA settings." });
    }
    if (!UUID.test(envId)) throw new NotFoundException({ error: "Environment not found" });
    const patch = parseEnvironmentUpdate(body);
    const account = patch.test_account as { password?: string } | undefined;
    if (account && !account.password) {
      // A blank password keeps the saved one, which only exists if one was saved. Without it NYRA stores
      // a username with no password and the scan silently skips login.
      const current = await this.client.json("GET", `/projects/${nyraId}`);
      const env = (Array.isArray(current?.environments) ? current.environments : []).find((e: Row) => String(e.id) === envId);
      if (!env) throw new NotFoundException({ error: "Environment not found" });
      if (!env.has_password) throw bad("Password is required for the test account");
    }
    await this.client.json("PATCH", `/projects/${nyraId}/environments/${envId}`, { body: patch });
    return this.detail(userId, projectId, nyraId);
  }

  /** NYRA projects this Tesbo project created, oldest first. A NYRA project missing upstream is simply not shown. */
  private async projectsOf(projectId: string) {
    const links = await this.db.query<{ nyra_project_id: string }>(`SELECT nyra_project_id FROM nyra_projects WHERE project_id = $1`, [projectId]);
    if (!links.rows.length) return [];
    const mine = new Set(links.rows.map((r) => r.nyra_project_id));
    const all = await this.client.json("GET", "/projects");
    if (!Array.isArray(all)) throw new BadGatewayException({ error: "NYRA returned an unexpected response." });
    return all.filter((p: Row) => mine.has(String(p?.id))).map((p: Row) => this.dto(p));
  }

  /** Never includes the password; NYRA only reports has_password. */
  private dto(p: Row) {
    const env: Row = Array.isArray(p.environments) ? (p.environments[0] ?? {}) : {};
    return {
      id: String(p.id),
      name: String(p.name ?? ""),
      appUrl: env.base_url ?? null,
      hasTestAccount: !!env.has_password || !!env.username,
      username: env.username ?? null,
      loginMethod: env.login_method ?? null,
      createdAt: p.created_at ?? null
    };
  }
}
