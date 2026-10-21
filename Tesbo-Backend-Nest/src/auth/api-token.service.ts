import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { DatabaseService } from "../database/database.service";

/**
 * Result of authenticating a raw API token presented as a bearer credential.
 * Carries the identity/scope needed by the bearer auth path in AuthMiddleware
 * (and, later, by the MCP module) to attribute and authorize machine calls.
 */
export interface ApiTokenPrincipal {
  tokenId: string;
  userId: string | null;
  projectId: string | null;
  scopes: string[];
}

/** Public (never-secret) shape of a token row returned to API clients. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  scopes: string[];
  tokenPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  /** Null only for a token that predates expiry and has not been migrated; none are issued that way. */
  expiresAt: string | null;
}

const TOKEN_PREFIX = "tsbo_";
const RAW_TOKEN_BYTES = 24;
const VALID_SCOPES = new Set(["read", "write"]);
export const DEFAULT_TOKEN_TTL_DAYS = 90;
const MAX_TOKEN_TTL_DAYS = 365;
/** Active (unexpired) tokens per project. Bounds how many live credentials one leak can multiply into. */
export const MAX_ACTIVE_TOKENS_PER_PROJECT = 25;
/** api_tokens.name is VARCHAR(128); longer used to surface as a 500 from Postgres. */
export const MAX_TOKEN_NAME_LENGTH = 128;

/**
 * Issues, lists, revokes and validates project-scoped API tokens.
 *
 * Storage model (migrations/V5_api_tokens_webhooks.sql): only a SHA-256 hash of
 * the token is ever persisted (token_hash, 64 hex chars). The raw token is
 * returned exactly once at creation time and is otherwise unrecoverable.
 *
 * This is the auth foundation the "Tesbo MCP" card builds on: the MCP module
 * (next slice) will consume ApiTokenPrincipal to authenticate machine clients
 * and attribute their writes to a dedicated actor.
 */
@Injectable()
export class ApiTokenService {
  private readonly logger = new Logger(ApiTokenService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Deterministic one-way hash used for both storage and lookup. */
  hashToken(rawToken: string): string {
    return createHash("sha256").update(rawToken, "utf8").digest("hex");
  }

  /** Generates a fresh, prefixed, high-entropy raw token. */
  generateRawToken(): string {
    return TOKEN_PREFIX + randomBytes(RAW_TOKEN_BYTES).toString("hex");
  }

  private normalizeScopes(input: unknown): string[] {
    const requested = Array.isArray(input)
      ? input.map((s) => String(s).trim().toLowerCase())
      : String(input ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase());
    const named = requested.filter(Boolean);
    // Nothing asked for: the long-standing default. Something asked for that is not a scope is a
    // mistake, and silently turning "admin" or a typo'd "reed" into read+write would grant more than
    // the caller wrote.
    if (!named.length) return ["read", "write"];
    const unknown = named.filter((s) => !VALID_SCOPES.has(s));
    if (unknown.length) {
      throw new BadRequestException({ error: `Unknown scope: ${unknown.join(", ")}. Valid scopes are read and write.` });
    }
    return Array.from(new Set(named));
  }

  private normalizeTtlDays(input: unknown): number {
    if (input === undefined || input === null || input === "") return DEFAULT_TOKEN_TTL_DAYS;
    const days = typeof input === "number" ? input : Number(String(input).trim());
    if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
      throw new BadRequestException({ error: `expiresInDays must be a whole number from 1 to ${MAX_TOKEN_TTL_DAYS}` });
    }
    return days;
  }

  private toSummary(row: {
    id: string;
    name: string;
    scopes: string | null;
    token_hash: string;
    last_used_at: string | null;
    created_at: string;
    expires_at?: string | null;
  }): ApiTokenSummary {
    return {
      id: row.id,
      name: row.name,
      scopes: (row.scopes || "").split(",").map((s) => s.trim()).filter(Boolean),
      // A stable, non-reversible hint so UIs can distinguish tokens without the secret.
      tokenPrefix: `${TOKEN_PREFIX}…${row.token_hash.slice(-6)}`,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? null
    };
  }

  async listTokens(projectId: string): Promise<ApiTokenSummary[]> {
    const res = await this.db.query(
      `SELECT id, name, scopes, token_hash, last_used_at, created_at, expires_at
       FROM api_tokens WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId]
    );
    return res.rows.map((row) => this.toSummary(row as never));
  }

  /**
   * Creates a token for a project. Returns the summary plus the raw `token`,
   * which is shown to the caller exactly once and never stored in plaintext.
   */
  async issueToken(
    userId: string | null,
    projectId: string,
    name: string,
    scopesInput?: unknown,
    expiresInDays?: unknown
  ): Promise<ApiTokenSummary & { token: string }> {
    // Validated before anything is generated or written, so a bad request leaves no trace.
    if (name.length > MAX_TOKEN_NAME_LENGTH) {
      throw new BadRequestException({ error: `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters` });
    }
    const scopes = this.normalizeScopes(scopesInput).join(",");
    const ttlDays = this.normalizeTtlDays(expiresInDays);
    const rawToken = this.generateRawToken();
    const tokenHash = this.hashToken(rawToken);
    // The cap is inside the INSERT so there is no read-then-write gap for a burst of creates to slip
    // through; no row back means the project is full.
    const res = await this.db.query(
      `INSERT INTO api_tokens (user_id, project_id, name, token_hash, scopes, expires_at)
       SELECT $1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::varchar, now() + ($6::int * interval '1 day')
       WHERE (SELECT count(*) FROM api_tokens WHERE project_id = $2::uuid AND (expires_at IS NULL OR expires_at > now())) < $7::int
       RETURNING id, name, scopes, token_hash, last_used_at, created_at, expires_at`,
      [userId, projectId, name, tokenHash, scopes, ttlDays, MAX_ACTIVE_TOKENS_PER_PROJECT]
    );
    if (!res.rows[0]) {
      throw new ConflictException({
        error: `This project already has ${MAX_ACTIVE_TOKENS_PER_PROJECT} active API tokens. Revoke one before creating another.`
      });
    }
    return { ...this.toSummary(res.rows[0] as never), token: rawToken };
  }

  /** Deletes a token belonging to the given project. Returns whether a row was removed. */
  async revokeToken(projectId: string, tokenId: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM api_tokens WHERE id = $1 AND project_id = $2`,
      [tokenId, projectId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Validates a raw bearer token. On success returns the principal and
   * records last_used_at; returns null for any unknown/blank token.
   */
  async authenticate(rawToken: string | null | undefined): Promise<ApiTokenPrincipal | null> {
    const token = String(rawToken ?? "").trim();
    if (!token) return null;
    const tokenHash = this.hashToken(token);
    // A token is only as good as the person and project behind it. Joining project_members and
    // projects means removing the user from the project, or archiving it, kills the token on the
    // spot instead of leaving a credential for access its owner no longer has. A row with no user
    // (user_id NULL, or the user deleted) matches nothing here, so it can never authenticate.
    const res = await this.db.query(
      `SELECT t.id, t.user_id, t.project_id, t.scopes
       FROM api_tokens t
       JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = t.user_id
       JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL
       WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())
       LIMIT 1`,
      [tokenHash]
    );
    const row = res.rows[0] as
      | { id: string; user_id: string | null; project_id: string | null; scopes: string | null }
      | undefined;
    if (!row) return null;
    // Best-effort usage stamp; never block auth on the update.
    this.db
      .query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch((err) => this.logger.warn(`Failed to update last_used_at for token ${row.id}: ${err}`));
    return {
      tokenId: row.id,
      userId: row.user_id,
      projectId: row.project_id,
      scopes: (row.scopes || "").split(",").map((s) => s.trim()).filter(Boolean)
    };
  }
}
