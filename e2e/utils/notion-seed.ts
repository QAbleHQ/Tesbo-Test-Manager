import { randomUUID } from "node:crypto";
import { exec, literal, scalar } from "./psql";

/*
 * Direct-Postgres fixtures for the Notion integration (notion_pages / notion_project_mappings,
 * migration V133).
 *
 * There is no fake Notion server: api.notion.com is compiled in as the base URL, so a sync, the
 * database picker and a comment can never be driven end to end from here. Everything that is ours
 * (authorization, validation, the not-connected path, the mirrored page store, the cross-source
 * aggregates, disconnect) is driven through the real HTTP API against rows seeded here, with a
 * deliberately fake token and a .invalid host so a fixture that reaches out fails loudly instead of
 * quietly talking to a real workspace. Same approach as the Jira/Linear seeds in
 * api/integrations.spec.ts and seedLinearRequirements in screens-tenant.ts.
 *
 * Connection rows are created by the caller's own seedConnection("notion"); these helpers only take
 * the resulting connection id. Like every utils/psql consumer, they go to env.dbUrl and nowhere else.
 */

/** A Notion page id in the dashed form the API and the sync store (Notion returns it this way). */
export function newNotionId(): string {
  return randomUUID();
}

/** The short display key the sync derives from a page id: "notion:" + the first 8 hex characters. */
export function notionKeyOf(pageId: string): string {
  return `notion:${pageId.replace(/-/g, "").slice(0, 8)}`;
}

/**
 * A mapping row linking a Tesbo project to one Notion database. `enabled: false` seeds a historical
 * mapping (what an unlink or a remap leaves behind: disabled, never deleted).
 * Returns the database id so a page can be seeded under it.
 */
export function seedNotionMapping(
  connectionId: string,
  projectId: string,
  fields: { databaseId?: string; databaseName?: string; enabled?: boolean } = {},
): string {
  const databaseId = fields.databaseId ?? newNotionId();
  exec(
    "INSERT INTO notion_project_mappings (integration_connection_id, project_id, notion_database_id, notion_database_name, enabled) VALUES (" +
      `${literal(connectionId)}, ${literal(projectId)}, ${literal(databaseId)}, ` +
      `${literal(fields.databaseName ?? `E2E Notion DB ${databaseId.slice(0, 8)}`)}, ${literal(fields.enabled ?? true)});`,
  );
  return databaseId;
}

/**
 * The page store only shows a page by default when it carries the project's currently enabled
 * mapping's database id in mapped_remote_id (same rule as Jira/Linear, V96). So a page seeded with
 * no explicit `mappedRemoteId` reuses the project's enabled mapping, or auto-creates one, which keeps
 * every call site that does not care about mapping specifics to one line. Pass `mappedRemoteId`
 * explicitly to seed a stale page that deliberately does not match the current mapping.
 */
function currentOrAutoMapping(connectionId: string, projectId: string): string {
  const existing = scalar(
    `SELECT notion_database_id FROM notion_project_mappings WHERE project_id = ${literal(projectId)} AND enabled = true LIMIT 1;`,
  );
  if (existing) return existing;
  return seedNotionMapping(connectionId, projectId, { databaseId: newNotionId(), databaseName: "E2E auto mapping" });
}

export interface SeededNotionPage {
  /** The full page id; test cases link by this, never by the short key. */
  pageId: string;
  key: string;
}

/** A mirrored Notion page exactly as a completed sync would have left it. */
export function seedNotionPage(
  connectionId: string,
  projectId: string,
  fields: {
    summary: string;
    pageId?: string;
    status?: string;
    issueType?: string;
    archived?: boolean;
    mappedRemoteId?: string;
    /** Minutes before now that notion_updated_at is set to; lists order by it, newest first. */
    updatedMinutesAgo?: number;
  },
): SeededNotionPage {
  const pageId = fields.pageId ?? newNotionId();
  const key = notionKeyOf(pageId);
  const mappedRemoteId = fields.mappedRemoteId ?? currentOrAutoMapping(connectionId, projectId);
  const updated = `now() - interval '${Math.max(0, Math.floor(fields.updatedMinutesAgo ?? 0))} minutes'`;
  exec(
    "INSERT INTO notion_pages (project_id, integration_connection_id, notion_page_id, notion_page_key, summary, description, " +
      "issue_type, status, priority, assignee, notion_created_at, notion_updated_at, notion_url, archived, mapped_remote_id) VALUES (" +
      `${literal(projectId)}, ${literal(connectionId)}, ${literal(pageId)}, ${literal(key)}, ${literal(fields.summary)}, ` +
      `'seeded by the e2e suite', ${literal(fields.issueType ?? "Task")}, ${literal(fields.status ?? "Not started")}, ` +
      `'Medium', 'e2e@example.com', now(), ${updated}, ${literal(`https://www.notion.so/e2e-${pageId.replace(/-/g, "")}`)}, ` +
      `${literal(fields.archived ?? false)}, ${literal(mappedRemoteId)});`,
  );
  return { pageId, key };
}

/** Clears every Notion row for a set of projects; cheap enough to run before and after each test. */
export function purgeNotionRows(projectIds: string[]): void {
  if (projectIds.length === 0) return;
  const ids = projectIds.map((id) => literal(id)).join(", ");
  exec(`DELETE FROM notion_pages WHERE project_id IN (${ids});`);
  exec(`DELETE FROM notion_project_mappings WHERE project_id IN (${ids});`);
}
