import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { decryptSecret, encryptSecret } from "../common/crypto.util";
import { jiraDescriptionToText } from "../common/integration-text.util";
import {
  COMMENTS_PER_TICKET,
  INTEGRATION_SYNC_FETCH_TIMEOUT_MS,
  JIRA_PAGE_SIZE,
  JIRA_TOKEN_REFRESH_RETRY_DELAY_MS,
  LINEAR_PAGE_SIZE,
  MAX_TICKETS_PER_RUN,
  PROVIDER_FOLDER_NAMES
} from "./integration-sync.constants";
import { RemoteComment, RemoteTicket, SyncProvider } from "./integration-sync.types";

type Row = Record<string, any>;
/** Loose structural type for either DatabaseService itself or a transaction's PoolClient — both
 *  expose a `query(text, values)` returning `{ rows }`, which is all persistRefreshedToken needs. */
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> };

function asArray(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown when a Jira connection's token cannot be made valid — authorization was revoked/expired,
 * or this deployment has no Jira OAuth app configured. Distinguishing this from the raw provider
 * HTTP error is the point: without it, a stale/unrefreshable token flows straight into a real Jira
 * API call, which 401s, and that raw body (e.g. `jira request failed (401): {"code":401,...}`)
 * propagates verbatim into the run's `error` field and onto the screen (SyncStatusPanel.tsx renders
 * `run.error` as-is).
 */
export class IntegrationConnectionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationConnectionInvalidError";
  }
}

/**
 * Provider API access for the sync processors.
 *
 * Deliberately re-implements connection loading + Jira token refresh rather than importing
 * LegacyService: LegacyService imports IntegrationSyncService to enqueue a run, so depending
 * back on it would close a module cycle. Same trade-off (and same reasoning) as
 * rag-ai-allocation.ts vs LegacyService.zyraAiAllocation.
 */
@Injectable()
export class IntegrationSyncClient {
  private readonly logger = new Logger(IntegrationSyncClient.name);

  constructor(private readonly db: DatabaseService) {}

  async loadConnection(organizationId: string, provider: SyncProvider): Promise<Row | null> {
    const res = await this.db.query("SELECT * FROM integration_connections WHERE organization_id = $1 AND provider = $2", [
      organizationId,
      provider
    ]);
    const connection = res.rows[0] as Row | undefined;
    if (!connection) return null;
    // Fast, lock-free path: the overwhelming majority of calls land here, so this stays exactly as
    // cheap (and contention-free) as it always was. Only a token that's actually due for refresh
    // pays for the transaction below.
    if (this.isTokenStillValid(connection) || !connection.refresh_token) return connection;

    // A connection is organization-scoped and can be mapped into several Tesbo projects, so at
    // nightly-cron time (INTEGRATION_SYNC_CONCURRENCY concurrent jobs) more than one job can find
    // the SAME connection's token expired at the same moment. Both Linear's and Atlassian's OAuth
    // apps rotate the refresh token on use, so two independent, concurrent refresh calls would
    // have the loser fail on an already-invalidated refresh token — a spurious "needs reconnecting"
    // for a connection that's actually fine. SELECT ... FOR UPDATE serializes them: whichever job
    // gets here first does the one real refresh; the rest block on the row lock, then re-check the
    // now-current row and simply reuse what the first job already wrote, with zero wasted (and
    // zero potentially-breaking) refresh calls. The lock is held across the outbound refresh call
    // (bounded by INTEGRATION_SYNC_FETCH_TIMEOUT_MS, plus one retry's delay) — an acceptable,
    // bounded cost given how rarely two jobs actually collide on the same connection's refresh
    // moment, and nothing else touches this row at meaningful frequency.
    return this.db.transaction(async (client) => {
      const locked = await client.query("SELECT * FROM integration_connections WHERE id = $1 FOR UPDATE", [connection.id]);
      const current = locked.rows[0] as Row | undefined;
      if (!current) return null;
      if (this.isTokenStillValid(current) || !current.refresh_token) return current;
      return provider === "jira" ? this.refreshJiraToken(current, client) : this.refreshLinearToken(current, client);
    });
  }

  private isTokenStillValid(connection: Row): boolean {
    return new Date(connection.token_expires_at).getTime() > Date.now() + 60_000;
  }

  /**
   * Shared shape for both providers' `grant_type=refresh_token` exchange: one retry (a cold-start
   * network blip right after a container restart and a genuinely revoked refresh token both land
   * here, and the retry is cheap enough that it isn't worth distinguishing the provider's error
   * taxonomy to skip it — a revoked token just fails the same way again a second later), a clean
   * `IntegrationConnectionInvalidError` on final failure, and "reuse the stored refresh token if
   * the provider didn't rotate it" on success.
   */
  private async exchangeRefreshToken(
    tokenUrl: string,
    body: () => BodyInit,
    headers: Record<string, string>,
    connection: Row,
    providerLabel: string
  ): Promise<Row> {
    const attempt = () =>
      fetch(tokenUrl, { method: "POST", headers, body: body(), signal: AbortSignal.timeout(INTEGRATION_SYNC_FETCH_TIMEOUT_MS) }).catch(() => null);

    let res = await attempt();
    if (!res?.ok) {
      await sleep(JIRA_TOKEN_REFRESH_RETRY_DELAY_MS);
      res = await attempt();
    }
    if (!res?.ok) {
      this.logger.warn(`${providerLabel} token refresh failed (${res ? res.status : "network error"}) for connection ${connection.id} after retry`);
      throw new IntegrationConnectionInvalidError(`${providerLabel} needs to be reconnected to this workspace.`);
    }
    const token = (await res.json()) as Row;
    const accessToken = encryptSecret(String(token.access_token || ""));
    const refreshToken = encryptSecret(String(token.refresh_token || decryptSecret(String(connection.refresh_token || ""))));
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
    return { accessToken, refreshToken, expiresAt };
  }

  private async persistRefreshedToken(client: Queryable, connection: Row, refreshed: Row): Promise<Row> {
    await client.query("UPDATE integration_connections SET access_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now() WHERE id = $1", [
      connection.id,
      refreshed.accessToken,
      refreshed.refreshToken,
      refreshed.expiresAt
    ]);
    return { ...connection, access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken, token_expires_at: refreshed.expiresAt };
  }

  private async refreshJiraToken(connection: Row, client: Queryable): Promise<Row> {
    const clientId = (process.env.JIRA_CLIENT_ID || "").trim();
    const clientSecret = (process.env.JIRA_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) {
      throw new IntegrationConnectionInvalidError(`${PROVIDER_FOLDER_NAMES.jira} sync is not configured for this workspace.`);
    }
    const refreshed = await this.exchangeRefreshToken(
      "https://auth.atlassian.com/oauth/token",
      () =>
        JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: decryptSecret(String(connection.refresh_token || ""))
        }),
      { "Content-Type": "application/json" },
      connection,
      PROVIDER_FOLDER_NAMES.jira
    );
    return this.persistRefreshedToken(client, connection, refreshed);
  }

  /**
   * Linear's OAuth token endpoint accepts `grant_type=refresh_token` the same way Jira's does —
   * this is the same endpoint (and same form-urlencoded shape) the initial authorization-code
   * exchange already uses (LegacyService.integrationCallback). Added because Linear's own OAuth
   * policy now issues short-lived (~24h) access tokens with a rotating refresh token, contradicting
   * this file's former assumption that Linear tokens never needed refreshing.
   */
  private async refreshLinearToken(connection: Row, client: Queryable): Promise<Row> {
    const clientId = (process.env.LINEAR_CLIENT_ID || "").trim();
    const clientSecret = (process.env.LINEAR_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) {
      throw new IntegrationConnectionInvalidError(`${PROVIDER_FOLDER_NAMES.linear} sync is not configured for this workspace.`);
    }
    const refreshed = await this.exchangeRefreshToken(
      "https://api.linear.app/oauth/token",
      () =>
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: decryptSecret(String(connection.refresh_token || ""))
        }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded" },
      connection,
      PROVIDER_FOLDER_NAMES.linear
    );
    return this.persistRefreshedToken(client, connection, refreshed);
  }

  // ── Jira ──

  private jiraAuth(connection: Row): { baseUrl: string; headers: Record<string, string> } {
    return {
      baseUrl: `https://api.atlassian.com/ex/jira/${connection.external_id}`,
      headers: { Authorization: `Bearer ${decryptSecret(String(connection.access_token || ""))}` }
    };
  }

  /**
   * A 401/403 here means the access token that reached the real provider call is dead — most often
   * because a refresh just above silently produced a token that doesn't actually work, or the
   * refresh token itself is revoked. Without this check, the raw provider body (e.g.
   * `jira request failed (401): {"code":401,...}`) leaks verbatim into the run's `error` field and
   * onto the Requirements page — the exact defect IntegrationConnectionInvalidError exists to avoid,
   * applied here as defense in depth alongside the proactive refresh in loadConnection.
   */
  private authErrorOrNull(status: number, providerLabel: string): IntegrationConnectionInvalidError | null {
    return status === 401 || status === 403 ? new IntegrationConnectionInvalidError(`${providerLabel} needs to be reconnected to this workspace.`) : null;
  }

  private async json<T>(url: string, init: RequestInit, provider: SyncProvider): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(INTEGRATION_SYNC_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      const authError = this.authErrorOrNull(res.status, PROVIDER_FOLDER_NAMES[provider]);
      if (authError) throw authError;
      const text = await res.text().catch(() => "");
      throw new Error(`${provider} request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Pages through every issue in a Jira project, newest-updated first, invoking `onPage` per
   * page so the caller can upsert incrementally and report progress before the whole backlog
   * is in memory. Stops at MAX_TICKETS_PER_RUN.
   *
   * `sinceIso`, when given, narrows the JQL to `updated >= sinceIso` — the nightly scheduler's
   * incremental fetch. Manual Sync never passes it, so its full-resync behavior is unchanged.
   */
  async fetchJiraTickets(
    connection: Row,
    projectKey: string,
    onPage: (tickets: RemoteTicket[]) => Promise<void>,
    sinceIso?: string | null
  ): Promise<{ total: number; truncated: boolean }> {
    const { baseUrl, headers } = this.jiraAuth(connection);
    const siteUrl = String(connection.site_url || "").replace(/\/$/, "");
    const escapedKey = projectKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // Jira JQL date literals don't take a full ISO instant, only "yyyy-MM-dd HH:mm" — truncate to
    // the minute, which only widens the window (never narrows it past what sinceIso intended).
    const sinceClause = sinceIso ? ` AND updated >= "${new Date(sinceIso).toISOString().slice(0, 16).replace("T", " ")}"` : "";
    const jql = `project = "${escapedKey}"${sinceClause} ORDER BY updated DESC`;
    let nextPageToken: string | undefined;
    let total = 0;

    for (;;) {
      const body: Row = {
        jql,
        maxResults: JIRA_PAGE_SIZE,
        fields: ["summary", "description", "issuetype", "status", "priority", "assignee", "reporter", "labels", "created", "updated"]
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const data = await this.json<Row>(`${baseUrl}/rest/api/3/search/jql`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, "jira");

      const issues = asArray(data.issues);
      if (!issues.length) return { total, truncated: false };

      const remaining = MAX_TICKETS_PER_RUN - total;
      const truncated = issues.length > remaining;
      const page = (truncated ? issues.slice(0, remaining) : issues).map((issue) => {
        const fields = (issue.fields || {}) as Row;
        return {
          issueId: String(issue.id || ""),
          issueKey: String(issue.key || ""),
          summary: String(fields.summary || ""),
          description: jiraDescriptionToText(fields.description),
          issueType: String(fields.issuetype?.name || ""),
          status: String(fields.status?.name || ""),
          priority: String(fields.priority?.name || ""),
          assignee: String(fields.assignee?.displayName || ""),
          reporter: String(fields.reporter?.displayName || ""),
          labels: (Array.isArray(fields.labels) ? fields.labels : []).map(String).filter(Boolean).join(", "),
          createdAt: (fields.created as string) || null,
          updatedAt: (fields.updated as string) || null,
          url: `${siteUrl}/browse/${issue.key}`
        } satisfies RemoteTicket;
      });

      await onPage(page);
      total += page.length;
      if (truncated) return { total, truncated: true };

      nextPageToken = data.nextPageToken ? String(data.nextPageToken) : undefined;
      if (!nextPageToken || data.isLast === true) return { total, truncated: false };
    }
  }

  async fetchJiraComments(connection: Row, issueId: string): Promise<RemoteComment[]> {
    const { baseUrl, headers } = this.jiraAuth(connection);
    // orderBy=-created gets the newest COMMENTS_PER_TICKET; reversed below so the document
    // reads oldest-to-newest like the Jira UI.
    const data = await this.json<Row>(
      `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}/comment?maxResults=${COMMENTS_PER_TICKET}&orderBy=-created`,
      { headers },
      "jira"
    );
    return asArray(data.comments)
      .map((comment) => ({
        author: String(comment.author?.displayName || "Unknown"),
        createdAt: (comment.created as string) || null,
        body: jiraDescriptionToText(comment.body).trim()
      }))
      .filter((comment) => comment.body)
      .reverse();
  }

  // ── Linear ──

  private async linearGraphQL<T>(connection: Row, query: string, variables: Row): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decryptSecret(String(connection.access_token || ""))}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(INTEGRATION_SYNC_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
      const authError = this.authErrorOrNull(res.status, PROVIDER_FOLDER_NAMES.linear);
      if (authError) throw authError;
      const text = await res.text().catch(() => "");
      throw new Error(`linear request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const payload = (await res.json()) as Row;
    if (payload.errors) {
      // Linear can also report an auth failure as an HTTP 200 with a GraphQL-level error carrying
      // extensions.code "AUTHENTICATION_ERROR" (or an embedded statusCode of 401/403) — the exact
      // shape behind the reported "Authentication required, not authenticated" run failure. Caught
      // here too, not just on !res.ok, so it gets the same clean message instead of raw JSON.
      const errors = asArray(payload.errors);
      const authFailure = errors.some((e) => {
        const ext = (e as Row)?.extensions as Row | undefined;
        return ext?.code === "AUTHENTICATION_ERROR" || ext?.statusCode === 401 || ext?.statusCode === 403;
      });
      if (authFailure) throw new IntegrationConnectionInvalidError(`${PROVIDER_FOLDER_NAMES.linear} needs to be reconnected to this workspace.`);
      throw new Error(`linear request failed: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    }
    return payload.data as T;
  }

  /**
   * `sinceIso`, when given, adds a `filter: { updatedAt: { gte } }` clause — the nightly
   * scheduler's incremental fetch. Manual Sync never passes it, so its full-resync behavior
   * (page through every issue in the team/project) is unchanged.
   *
   * `entityType` picks the GraphQL root field — `team(id: ...)` or `project(id: ...)` — aliased to
   * `entity` in both cases so every line below (pagination, truncation, the RemoteTicket mapping)
   * reads `data.entity` regardless of which kind of Linear entity this mapping actually is.
   */
  async fetchLinearTickets(
    connection: Row,
    entityId: string,
    onPage: (tickets: RemoteTicket[]) => Promise<void>,
    sinceIso?: string | null,
    entityType: "team" | "project" = "team"
  ): Promise<{ total: number; truncated: boolean }> {
    let cursor: string | null = null;
    let total = 0;
    const rootField = entityType === "project" ? "project" : "team";
    // Built as two distinct query strings (rather than one query with a nullable filter variable)
    // so an unset sinceIso can never risk Linear interpreting `gte: null` as "match nothing" —
    // manual Sync's full-resync query is byte-for-byte what it was before this change.
    const query = sinceIso
      ? `query EntityIssues($id: String!, $first: Int!, $after: String, $since: DateTimeOrDuration!) {
           entity: ${rootField}(id: $id) {
             issues(first: $first, after: $after, orderBy: updatedAt, filter: { updatedAt: { gte: $since } }) {
               nodes {
                 id identifier title description url createdAt updatedAt
                 state { name }
                 priorityLabel
                 assignee { name }
                 creator { name }
                 labels { nodes { name } }
               }
               pageInfo { hasNextPage endCursor }
             }
           }
         }`
      : `query EntityIssues($id: String!, $first: Int!, $after: String) {
           entity: ${rootField}(id: $id) {
             issues(first: $first, after: $after, orderBy: updatedAt) {
               nodes {
                 id identifier title description url createdAt updatedAt
                 state { name }
                 priorityLabel
                 assignee { name }
                 creator { name }
                 labels { nodes { name } }
               }
               pageInfo { hasNextPage endCursor }
             }
           }
         }`;

    for (;;) {
      const data = await this.linearGraphQL<Row>(
        connection,
        query,
        sinceIso ? { id: entityId, first: LINEAR_PAGE_SIZE, after: cursor, since: sinceIso } : { id: entityId, first: LINEAR_PAGE_SIZE, after: cursor }
      );

      // Optional-chained throughout: a since-archived/deleted/inaccessible entity (team or
      // project) resolves `data.entity` to null rather than erroring, and this yields zero
      // tickets instead of crashing — identical to how a deleted Team already behaved.
      const issues = asArray(data?.entity?.issues?.nodes);
      if (!issues.length) return { total, truncated: false };

      const remaining = MAX_TICKETS_PER_RUN - total;
      const truncated = issues.length > remaining;
      const page = (truncated ? issues.slice(0, remaining) : issues).map((issue) => ({
        issueId: String(issue.id || ""),
        issueKey: String(issue.identifier || ""),
        summary: String(issue.title || ""),
        description: String(issue.description || ""),
        issueType: "Issue",
        status: String(issue.state?.name || ""),
        priority: String(issue.priorityLabel || ""),
        assignee: String(issue.assignee?.name || ""),
        reporter: String(issue.creator?.name || ""),
        labels: asArray(issue.labels?.nodes).map((label) => String(label.name || "")).filter(Boolean).join(", "),
        createdAt: (issue.createdAt as string) || null,
        updatedAt: (issue.updatedAt as string) || null,
        url: String(issue.url || "")
      } satisfies RemoteTicket));

      await onPage(page);
      total += page.length;
      if (truncated) return { total, truncated: true };

      const pageInfo = (data?.entity?.issues?.pageInfo || {}) as Row;
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) return { total, truncated: false };
      cursor = String(pageInfo.endCursor);
    }
  }

  async fetchLinearComments(connection: Row, issueId: string): Promise<RemoteComment[]> {
    const data = await this.linearGraphQL<Row>(
      connection,
      `query IssueComments($issueId: String!, $first: Int!) {
         issue(id: $issueId) {
           comments(first: $first) {
             nodes { body createdAt user { name } }
           }
         }
       }`,
      { issueId, first: COMMENTS_PER_TICKET }
    );
    return asArray(data?.issue?.comments?.nodes)
      .map((comment) => ({
        author: String(comment.user?.name || "Unknown"),
        createdAt: (comment.createdAt as string) || null,
        body: String(comment.body || "").trim()
      }))
      .filter((comment) => comment.body);
  }

  async fetchComments(connection: Row, provider: SyncProvider, issueId: string): Promise<RemoteComment[]> {
    return provider === "jira" ? this.fetchJiraComments(connection, issueId) : this.fetchLinearComments(connection, issueId);
  }
}
