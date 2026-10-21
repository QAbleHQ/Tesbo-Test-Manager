import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from "@nestjs/common";
import { safeFetch } from "../common/safe-fetch";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";

type Row = Record<string, any>;

const NAME_MAX = 120; // NYRA's own limit (projects.name VARCHAR(120)).
const URL_MAX = 2000;
const USERNAME_MAX = 255; // NYRA's environments.username is VARCHAR(255) and answers 500, not 422, past it.
const PASSWORD_MAX = 512;
const NYRA_TIMEOUT_MS = 15_000;
const NYRA_MAX_BYTES = 2 * 1024 * 1024;

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

/**
 * NYRA's 422 body echoes the caller's input, which includes the test-account password. Only the `msg`
 * of each error is kept, never `input`, and a raw body is never logged.
 */
export function nyraValidationMessage(detail: unknown): string {
  if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 300);
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" && typeof d.msg === "string" ? d.msg : ""))
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ").slice(0, 300);
  }
  return "NYRA rejected the project details";
}

@Injectable()
export class NyraService {
  private readonly logger = new Logger(NyraService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly planLimits: PlanLimitsService,
    private readonly legacy: LegacyService
  ) {}

  private get configured(): boolean {
    return !!this.config.nyraApiKey && !!this.config.nyraBaseUrl;
  }

  /** Project membership, then the EFFECTIVE Pro plan (same order as the Review Board). */
  private async requireAccess(userId: string | null | undefined, projectId: string): Promise<Row> {
    const project = await this.legacy.requireProjectAccess(userId, projectId);
    await this.planLimits.assertNyraEnabled(project.organization_id);
    return project;
  }

  private requireConfigured(): void {
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

    const created = await this.nyra("POST", "/projects", {
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
    });
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

  /** NYRA projects this Tesbo project created, oldest first. A NYRA project missing upstream is simply not shown. */
  private async projectsOf(projectId: string) {
    const links = await this.db.query<{ nyra_project_id: string }>(`SELECT nyra_project_id FROM nyra_projects WHERE project_id = $1`, [projectId]);
    if (!links.rows.length) return [];
    const mine = new Set(links.rows.map((r) => r.nyra_project_id));
    const all = await this.nyra("GET", "/projects");
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

  private async nyra(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await safeFetch(
        `${this.config.nyraBaseUrl}/api/v1${path}`,
        {
          method,
          headers: { Authorization: `Bearer ${this.config.nyraApiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        },
        { timeoutMs: NYRA_TIMEOUT_MS, maxBytes: NYRA_MAX_BYTES }
      );
    } catch (err) {
      this.logger.warn(`NYRA ${method} ${path} failed: ${(err as Error).message}`);
      throw new BadGatewayException({ error: "NYRA is unreachable. Try again later." });
    }
    const payload: any = await res.json().catch(() => null);
    if (res.ok) return payload;
    // Never forward NYRA's body as is: a 422 echoes the submitted password.
    this.logger.warn(`NYRA ${method} ${path} answered ${res.status}`);
    if (res.status === 422) throw bad(nyraValidationMessage(payload?.detail));
    if (res.status === 401 || res.status === 403) {
      throw new BadGatewayException({ error: "NYRA rejected this server's API key. Ask an administrator to check NYRA_API_KEY." });
    }
    if (res.status === 429) throw new HttpException({ error: "NYRA is rate limiting requests. Try again in a minute." }, 429);
    throw new BadGatewayException({ error: "NYRA is unavailable. Try again later." });
  }
}
