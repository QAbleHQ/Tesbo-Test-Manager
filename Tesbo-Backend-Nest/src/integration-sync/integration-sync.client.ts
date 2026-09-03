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

    const stillValid = new Date(connection.token_expires_at).getTime() > Date.now() + 60_000;
    // Linear tokens are long-lived and have no refresh flow (see LegacyService.getIntegrationConnection).
    if (stillValid || provider === "linear" || !connection.refresh_token) return connection;

    return this.refreshJiraToken(connection);
  }

  private async refreshJiraToken(connection: Row): Promise<Row> {
    const clientId = (process.env.JIRA_CLIENT_ID || "").trim();
    const clientSecret = (process.env.JIRA_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) {
      throw new IntegrationConnectionInvalidError(`${PROVIDER_FOLDER_NAMES.jira} sync is not configured for this workspace.`);
    }

    const attempt = () =>
      fetch("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: decryptSecret(String(connection.refresh_token || ""))
        }),
        signal: AbortSignal.timeout(INTEGRATION_SYNC_FETCH_TIMEOUT_MS)
      }).catch(() => null);

    // One retry, unconditional on the failure shape: a cold-start network blip right after a
    // container restart and a genuinely revoked refresh token both land here, and the retry is
    // cheap enough that it isn't worth distinguishing Atlassian's error taxonomy to skip it — a
    // revoked token just fails the same way again a second later.
    let res = await attempt();
    if (!res?.ok) {
      await sleep(JIRA_TOKEN_REFRESH_RETRY_DELAY_MS);
      res = await attempt();
    }
    if (!res?.ok) {
      this.logger.warn(`Jira token refresh failed (${res ? res.status : "network error"}) for connection ${connection.id} after retry`);
      throw new IntegrationConnectionInvalidError(`${PROVIDER_FOLDER_NAMES.jira} needs to be reconnected to this workspace.`);
    }
    const token = (await res.json()) as Row;
    const accessToken = encryptSecret(String(token.access_token || ""));
    const refreshToken = encryptSecret(String(token.refresh_token || decryptSecret(String(connection.refresh_token || ""))));
    const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
    await this.db.query("UPDATE integration_connections SET access_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now() WHERE id = $1", [
      connection.id,
      accessToken,
      refreshToken,
      expiresAt
    ]);
    return { ...connection, access_token: accessToken, refresh_token: refreshToken, token_expires_at: expiresAt };
  }

  // ── Jira ──

  private jiraAuth(connection: Row): { baseUrl: string; headers: Record<string, string> } {
    return {
      baseUrl: `https://api.atlassian.com/ex/jira/${connection.external_id}`,
      headers: { Authorization: `Bearer ${decryptSecret(String(connection.access_token || ""))}` }
    };
  }

  private async json<T>(url: string, init: RequestInit, provider: SyncProvider): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(INTEGRATION_SYNC_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
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
      const text = await res.text().catch(() => "");
      throw new Error(`linear request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const payload = (await res.json()) as Row;
    if (payload.errors) throw new Error(`linear request failed: ${JSON.stringify(payload.errors).slice(0, 300)}`);
    return payload.data as T;
  }

  /**
   * `sinceIso`, when given, adds a `filter: { updatedAt: { gte } }` clause — the nightly
   * scheduler's incremental fetch. Manual Sync never passes it, so its full-resync behavior
   * (page through every issue in the team) is unchanged.
   */
  async fetchLinearTickets(
    connection: Row,
    teamId: string,
    onPage: (tickets: RemoteTicket[]) => Promise<void>,
    sinceIso?: string | null
  ): Promise<{ total: number; truncated: boolean }> {
    let cursor: string | null = null;
    let total = 0;
    // Built as two distinct query strings (rather than one query with a nullable filter variable)
    // so an unset sinceIso can never risk Linear interpreting `gte: null` as "match nothing" —
    // manual Sync's full-resync query is byte-for-byte what it was before this change.
    const query = sinceIso
      ? `query TeamIssues($teamId: String!, $first: Int!, $after: String, $since: DateTimeOrDuration!) {
           team(id: $teamId) {
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
      : `query TeamIssues($teamId: String!, $first: Int!, $after: String) {
           team(id: $teamId) {
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
        sinceIso ? { teamId, first: LINEAR_PAGE_SIZE, after: cursor, since: sinceIso } : { teamId, first: LINEAR_PAGE_SIZE, after: cursor }
      );

      const issues = asArray(data?.team?.issues?.nodes);
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

      const pageInfo = (data?.team?.issues?.pageInfo || {}) as Row;
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
