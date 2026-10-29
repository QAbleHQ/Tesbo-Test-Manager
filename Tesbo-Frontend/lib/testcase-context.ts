import type { ZyraSourceRef } from "@/lib/api";
import { notionPageKey } from "@/lib/api";

// A Context row: a verified Zyra citation, or the ticket/page the case is linked to. Linear and
// Notion have no citation type or detail drawer, so those rows only ever come from the case's own
// link columns and open the original in a new tab.
export type ContextEntry = { type: ZyraSourceRef["type"] | "linear_ticket" | "notion_page"; id: string; title: string; url?: string };

export function isLinkedOnlyContext(entry: ContextEntry): entry is ContextEntry & { type: "linear_ticket" | "notion_page" } {
  return entry.type === "linear_ticket" || entry.type === "notion_page";
}

type CaseLinks = {
  sourceRefs?: ZyraSourceRef[] | null;
  jiraIssueKey?: string | null;
  linearIssueKey?: string | null;
  linearUrl?: string | null;
  notionPageId?: string | null;
  notionUrl?: string | null;
};

/**
 * The ticket/page a case was generated for (or manually linked to) lives in its own link columns,
 * not in sourceRefs — a task-board generation never resolves citations, so reading sourceRefs alone
 * left those cases on "No specific source cited". Linked ticket first, then the citations,
 * de-duplicated against a Jira citation of the same key.
 */
export function buildContextEntries(data: CaseLinks): ContextEntry[] {
  const refs = Array.isArray(data.sourceRefs) ? data.sourceRefs : [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const linked: ContextEntry[] = [];
  const jiraKey = str(data.jiraIssueKey);
  if (jiraKey && !refs.some((r) => r.type === "jira_ticket" && r.id === jiraKey)) {
    linked.push({ type: "jira_ticket", id: jiraKey, title: jiraKey });
  }
  const linearKey = str(data.linearIssueKey);
  if (linearKey) linked.push({ type: "linear_ticket", id: linearKey, title: linearKey, url: str(data.linearUrl) || undefined });
  const notionId = str(data.notionPageId);
  if (notionId) linked.push({ type: "notion_page", id: notionId, title: notionPageKey(notionId), url: str(data.notionUrl) || undefined });
  return [...linked, ...refs];
}
