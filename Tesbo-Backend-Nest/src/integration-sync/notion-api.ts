import {
  INTEGRATION_SYNC_FETCH_TIMEOUT_MS,
  NOTION_API_BASE,
  NOTION_API_VERSION,
  NOTION_MAX_RETRIES,
  NOTION_MAX_RETRY_WAIT_MS
} from "./integration-sync.constants";

/**
 * The raw failure of one Notion API call: HTTP status plus Notion's own error `code`
 * (`object_not_found`, `restricted_resource`, `unauthorized`, `rate_limited`, ...) and `message`.
 *
 * Deliberately not tied to either caller's error vocabulary. The sync client turns it into
 * IntegrationConnectionInvalidError / NotionNotSharedError / NotionPermissionError, and LegacyService
 * turns it into the BadRequestException shape its own Jira/Linear calls use, so each keeps its
 * existing error handling.
 */
export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is whole seconds (Notion) or an HTTP date; anything unreadable waits one second. */
function retryDelayMs(header: string | null): number {
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
  return Math.min(ms, NOTION_MAX_RETRY_WAIT_MS);
}

/**
 * One Notion API call. Sends the single pinned Notion-Version, enforces the shared fetch timeout and
 * waits out a 429 (Retry-After, bounded retries). `path` starts with "/" and is relative to /v1.
 * `accessToken` is the plain (already decrypted) bearer token.
 */
export async function notionRequest<T>(
  accessToken: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${NOTION_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(INTEGRATION_SYNC_FETCH_TIMEOUT_MS)
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt < NOTION_MAX_RETRIES) {
      await sleep(retryDelayMs(res.headers.get("retry-after")));
      continue;
    }
    const text = await res.text().catch(() => "");
    let payload: { code?: unknown; message?: unknown } = {};
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      // A non-JSON error body (an upstream proxy page): fall back to the raw text below.
    }
    throw new NotionApiError(res.status, String(payload.code || ""), String(payload.message || text).slice(0, 300));
  }
}

/** Notion's `search`/query results use dashed UUIDs; normalise for the display key and comparisons. */
export function compactNotionId(id: string): string {
  return String(id || "").replace(/-/g, "").toLowerCase();
}

/**
 * The short display key shown for a page: "notion:" plus the first 8 hex characters of its id. Only a
 * label. Test cases link to a page by its full id (testcases.notion_page_id), never by this key, so
 * the (astronomically unlikely) clash of two keys inside one database cannot mislink anything.
 */
export function notionPageKey(pageId: string): string {
  return `notion:${compactNotionId(pageId).slice(0, 8)}`;
}

/** Plain-language cause for a Notion failure, shared by the sync client and LegacyService. */
export function describeNotionError(err: NotionApiError, what: "database" | "page" | "content" = "content"): string {
  if (err.status === 401) return "Notion needs to be reconnected to this workspace.";
  if (err.status === 404 || err.code === "object_not_found") {
    return `The Notion ${what} could not be found. It may have been deleted, or it is no longer shared with the Tesbo integration. In Notion, open the ${what}, choose Connections and add the Tesbo integration, or select a different database in this project's Notion integration settings.`;
  }
  if (err.status === 403) {
    return err.code === "restricted_resource"
      ? `The Tesbo integration has no access to this Notion ${what}. In Notion, open it, choose Connections and add the Tesbo integration.`
      : `Notion refused the request (403): the Tesbo integration is missing a required capability (${err.message}). Enable read content, read comments and insert comments for the integration in Notion, then reconnect.`;
  }
  if (err.status === 429) return "Notion is rate limiting requests right now. Try again in a minute.";
  return `Notion request failed (${err.status}): ${err.message}`;
}
