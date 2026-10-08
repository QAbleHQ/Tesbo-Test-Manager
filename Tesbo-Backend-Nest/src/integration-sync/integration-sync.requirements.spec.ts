import { IntegrationSyncProcessor } from "./integration-sync.processor";

/*
 * "Requirement [ID] has been updated." — who is told when a synced ticket changes. A requirement here
 * is a ticket synced from Jira / Linear / Notion; its assignee is only an external name and there are
 * no watchers, so the recipients are the owners and creators of the test cases linked to it.
 */

const PROJECT = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const CREATOR = "00000000-0000-4000-8000-0000000000a2";
const SYNCER = "00000000-0000-4000-8000-0000000000a3";

function makeProcessor(linked: Array<{ owner_id: string | null; created_by: string | null }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO notifications")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "n" }], rowCount: 1 };
    }
    calls.push({ sql, params });
    return { rows: linked, rowCount: linked.length };
  });
  const proc = Object.create(IntegrationSyncProcessor.prototype) as Record<string, unknown>;
  proc.db = { query };
  proc.logger = { warn: jest.fn(), error: jest.fn() };
  const notify = (provider: string, ticket: Record<string, string>, triggeredBy: string | null) =>
    (proc as unknown as { notifyRequirementUpdated: (...a: unknown[]) => Promise<void> }).notifyRequirementUpdated(PROJECT, provider, ticket, "doc-1", triggeredBy);
  return { notify, calls, inserts };
}

describe("requirement updated notifications", () => {
  it("tells the owners and creators of the linked test cases, in the matrix wording, linking to Requirements", async () => {
    const { notify, calls, inserts } = makeProcessor([{ owner_id: OWNER, created_by: CREATOR }]);
    await notify("jira", { issueKey: "QAD-12", issueId: "10012" }, null);
    expect(calls[0].sql).toContain("jira_issue_key = $2");
    expect(calls[0].params).toEqual([PROJECT, "QAD-12"]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toEqual([OWNER, CREATOR]);
    expect(inserts[0].params[1]).toBe("requirement_updated");
    expect(inserts[0].params[2]).toBe("Requirement QAD-12 has been updated.");
    expect(inserts[0].params[3]).toBe("requirements");
    expect(inserts[0].params[4]).toBe(PROJECT);
    expect(String(inserts[0].params[5])).toMatch(/^requirement_updated:doc-1:\d{4}-\d{2}-\d{2}$/);
  });

  it("does not tell the person who pressed Sync about their own sync", async () => {
    const { notify, inserts } = makeProcessor([{ owner_id: SYNCER, created_by: CREATOR }]);
    await notify("linear", { issueKey: "YAS-3", issueId: "abc" }, SYNCER);
    expect(inserts[0].params[0]).toEqual([CREATOR]);
  });

  it("matches a Notion requirement by its page id, and a Linear one by its key", async () => {
    const notion = makeProcessor([{ owner_id: OWNER, created_by: null }]);
    await notion.notify("notion", { issueKey: "PAGE-1", issueId: "page-uuid" }, null);
    expect(notion.calls[0].sql).toContain("notion_page_id = $2");
    expect(notion.calls[0].params[1]).toBe("page-uuid");
    const linear = makeProcessor([{ owner_id: OWNER, created_by: null }]);
    await linear.notify("linear", { issueKey: "YAS-3", issueId: "abc" }, null);
    expect(linear.calls[0].sql).toContain("linear_issue_key = $2");
  });

  it("says nothing when no test case is linked to the requirement", async () => {
    const { notify, inserts } = makeProcessor([]);
    await notify("jira", { issueKey: "QAD-99", issueId: "1" }, null);
    expect(inserts).toHaveLength(0);
  });
});
