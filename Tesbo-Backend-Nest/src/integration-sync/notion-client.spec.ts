import { DatabaseService } from "../database/database.service";
import { encryptSecret } from "../common/crypto.util";
import {
  IntegrationConnectionInvalidError,
  IntegrationSyncClient,
  NotionNotSharedError,
  NotionPermissionError
} from "./integration-sync.client";
import { NOTION_API_VERSION, NOTION_MAX_BLOCKS_PER_PAGE, NOTION_MAX_BLOCK_DEPTH } from "./integration-sync.constants";
import { compactNotionId, notionPageKey } from "./notion-api";
import {
  markdownToNotionRichText,
  notionPageTitle,
  notionTicketFields,
  renderNotionBlocks,
  renderNotionProperties,
  renderNotionProperty
} from "./notion-render";

// Test-only key, same approach as linear-integration.spec.ts.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const rich = (text: string, annotations: Record<string, unknown> = {}, href: string | null = null) => ({
  type: "text",
  plain_text: text,
  text: { content: text },
  annotations,
  href
});
const block = (type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  object: "block",
  id: `${type}-id`,
  type,
  has_children: false,
  [type]: payload,
  ...extra
});

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

function notionConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    organization_id: "org-1",
    provider: "notion",
    access_token: encryptSecret("secret_notion_token"),
    refresh_token: "",
    token_expires_at: "2999-12-31T00:00:00.000Z",
    ...overrides
  };
}

function makeClient(connection: Record<string, unknown> | null = null) {
  const query = jest.fn((sql: string) => {
    if (sql.startsWith("SELECT * FROM integration_connections")) return Promise.resolve({ rows: connection ? [connection] : [] });
    return Promise.resolve({ rows: [] });
  });
  const transaction = jest.fn((fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  const db = { query, transaction } as unknown as DatabaseService;
  return { client: new IntegrationSyncClient(db), query, transaction };
}

afterEach(() => jest.restoreAllMocks());

describe("notion-render: block tree to markdown", () => {
  it("renders paragraphs, shifted headings, lists, to-dos, quotes, code and dividers", () => {
    const md = renderNotionBlocks([
      block("heading_1", { rich_text: [rich("Overview")] }),
      block("paragraph", { rich_text: [rich("Hello "), rich("bold", { bold: true }), rich(" and "), rich("link", {}, "https://x.test")] }),
      block("bulleted_list_item", { rich_text: [rich("one")] }),
      block("numbered_list_item", { rich_text: [rich("first")] }),
      block("numbered_list_item", { rich_text: [rich("second")] }),
      block("to_do", { rich_text: [rich("done")], checked: true }),
      block("to_do", { rich_text: [rich("open")], checked: false }),
      block("quote", { rich_text: [rich("wise words")] }),
      block("code", { rich_text: [rich("const a = 1;")], language: "typescript" }),
      block("divider")
    ]);
    // Headings sit two levels down so they nest under the document's own "## Description".
    expect(md).toContain("### Overview");
    expect(md).toContain("Hello **bold** and [link](https://x.test)");
    expect(md).toContain("- one");
    expect(md).toContain("1. first");
    expect(md).toContain("2. second");
    expect(md).toContain("- [x] done");
    expect(md).toContain("- [ ] open");
    expect(md).toContain("> wise words");
    expect(md).toContain("```typescript\nconst a = 1;\n```");
    expect(md).toContain("---");
  });

  it("indents nested list children and renders a table with its header separator", () => {
    const md = renderNotionBlocks([
      { ...block("bulleted_list_item", { rich_text: [rich("parent")] }), has_children: true, children: [block("bulleted_list_item", { rich_text: [rich("child")] })] },
      {
        ...block("table", { table_width: 2, has_column_header: true }),
        has_children: true,
        children: [
          block("table_row", { cells: [[rich("Name")], [rich("Role")]] }),
          block("table_row", { cells: [[rich("Ada")], [rich("QA")]] })
        ]
      }
    ]);
    expect(md).toContain("- parent\n  - child");
    expect(md).toContain("| Name | Role |\n| --- | --- |\n| Ada | QA |");
  });

  it("turns an unsupported block into a placeholder line instead of throwing", () => {
    const md = renderNotionBlocks([block("paragraph", { rich_text: [rich("before")] }), block("ai_block", {}), block("paragraph", { rich_text: [rich("after")] })]);
    expect(md).toContain("before");
    expect(md).toContain("[Notion ai block is not shown here]");
    expect(md).toContain("after");
  });

  it("marks a block whose children were cut by the depth cap", () => {
    const md = renderNotionBlocks([{ ...block("toggle", { rich_text: [rich("Deep")] }), has_children: true, __capped: true }]);
    expect(md).toContain("**Deep**");
    expect(md).toContain("nested content");
  });

  it("keeps only the caption of a hosted file, never its expiring URL", () => {
    const md = renderNotionBlocks([block("image", { type: "file", file: { url: "https://s3.example/expiring" }, caption: [rich("Login screen")] })]);
    expect(md).toContain("[Image: Login screen]");
    expect(md).not.toContain("s3.example");
  });
});

describe("notion-render: property rendering", () => {
  const props = {
    Name: { type: "title", title: [rich("Checkout flow")] },
    Status: { type: "status", status: { name: "In progress" } },
    Priority: { type: "select", select: { name: "High" } },
    Tags: { type: "multi_select", multi_select: [{ name: "web" }, { name: "payments" }] },
    Assignee: { type: "people", people: [{ name: "Ada Lovelace" }] },
    Due: { type: "date", date: { start: "2026-01-01", end: "2026-01-05" } },
    Points: { type: "number", number: 5 },
    Done: { type: "checkbox", checkbox: false },
    Link: { type: "url", url: "https://example.test" },
    Notes: { type: "rich_text", rich_text: [rich("see spec")] },
    Calc: { type: "formula", formula: { type: "number", number: 12 } },
    Roll: { type: "rollup", rollup: { type: "array", array: [{ type: "number", number: 1 }, { type: "number", number: 2 }] } },
    Related: { type: "relation", relation: [{ id: "a" }, { id: "b" }] },
    Empty: { type: "select", select: null },
    Weird: { type: "button", button: {} }
  };

  it("renders each supported property type to text", () => {
    expect(renderNotionProperty(props.Status)).toBe("In progress");
    expect(renderNotionProperty(props.Tags)).toBe("web, payments");
    expect(renderNotionProperty(props.Assignee)).toBe("Ada Lovelace");
    expect(renderNotionProperty(props.Due)).toBe("2026-01-01 to 2026-01-05");
    expect(renderNotionProperty(props.Points)).toBe("5");
    expect(renderNotionProperty(props.Done)).toBe("No");
    expect(renderNotionProperty(props.Calc)).toBe("12");
    expect(renderNotionProperty(props.Roll)).toBe("1, 2");
    expect(renderNotionProperty(props.Related)).toBe("2 linked pages");
    expect(renderNotionProperty(props.Weird)).toBe("");
  });

  it("drops the title and empty values from the rendered property map", () => {
    const rendered = renderNotionProperties(props);
    expect(rendered.Name).toBeUndefined();
    expect(rendered.Empty).toBeUndefined();
    expect(rendered.Status).toBe("In progress");
  });

  it("takes the title from whichever property has type title, and falls back to Untitled", () => {
    expect(notionPageTitle(props)).toBe("Checkout flow");
    expect(notionPageTitle({ "Page name": { type: "title", title: [] } })).toBe("Untitled");
    expect(notionPageTitle({})).toBe("Untitled");
    expect(notionPageTitle(null)).toBe("Untitled");
  });

  it("maps conventional property names onto the shared ticket columns", () => {
    const fields = notionTicketFields(props);
    expect(fields).toMatchObject({ status: "In progress", priority: "High", assignee: "Ada Lovelace", labels: "web, payments", issueType: "Page" });
  });
});

describe("markdownToNotionRichText", () => {
  it("keeps bold and links and splits long text under Notion's 2000 character cap", () => {
    const segments = markdownToNotionRichText(`**Head**\n[TC-1](https://app.test/t/1) ${"x".repeat(4500)}`);
    expect(segments[0]).toMatchObject({ text: { content: "Head" }, annotations: { bold: true } });
    expect(segments[1].text.content).toBe("\n");
    expect(segments[2]).toMatchObject({ text: { content: "TC-1", link: { url: "https://app.test/t/1" } } });
    expect(segments.every((s) => s.text.content.length <= 2000)).toBe(true);
  });

  it("falls back to plain chunks when formatting would exceed 100 elements", () => {
    const markdown = Array.from({ length: 120 }, (_, i) => `[T${i}](https://a.test/${i})`).join("\n");
    const segments = markdownToNotionRichText(markdown);
    expect(segments.length).toBeLessThanOrEqual(100);
    expect(segments.map((s) => s.text.content).join("")).toBe(markdown);
  });
});

describe("notion page keys", () => {
  it("derives a short stable display key from the page id", () => {
    expect(notionPageKey("1429989f-e8ac-4eff-bc8f-57f56486db54")).toBe("notion:1429989f");
    expect(compactNotionId("1429989F-E8AC-4eff-bc8f-57f56486db54")).toBe("1429989fe8ac4effbc8f57f56486db54");
  });
});

describe("IntegrationSyncClient#loadConnection: Notion", () => {
  it("returns the connection untouched and never opens a refresh transaction, even with a stale expiry", async () => {
    const { client, transaction } = makeClient(notionConnection({ token_expires_at: new Date(Date.now() - 86_400_000).toISOString(), refresh_token: "would-be-refresh" }));
    const fetchSpy = jest.spyOn(global, "fetch");
    const loaded = await client.loadConnection("org-1", "notion");
    expect(loaded?.id).toBe("conn-1");
    expect(transaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not treat the far-future expiry as needing refresh", async () => {
    const { client, transaction } = makeClient(notionConnection());
    await client.loadConnection("org-1", "notion");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("IntegrationSyncClient: Notion HTTP behaviour", () => {
  it("sends the pinned Notion-Version and the decrypted bearer token", async () => {
    const { client } = makeClient();
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(200, { results: [], has_more: false }));
    await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/databases/db-1/query");
    const headers = init.headers as Record<string, string>;
    expect(headers["Notion-Version"]).toBe(NOTION_API_VERSION);
    expect(headers.Authorization).toBe("Bearer secret_notion_token");
  });

  it("paginates a database query with start_cursor and maps each page to a ticket", async () => {
    const { client } = makeClient();
    const page = (id: string, title: string) => ({
      object: "page",
      id,
      url: `https://www.notion.so/${id}`,
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-01-02T00:00:00.000Z",
      archived: false,
      properties: { Name: { type: "title", title: [rich(title)] }, Status: { type: "status", status: { name: "Open" } } }
    });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(res(200, { results: [page("11111111-1111-1111-1111-111111111111", "A")], has_more: true, next_cursor: "cur-2" }))
      .mockResolvedValueOnce(res(200, { results: [page("22222222-2222-2222-2222-222222222222", "B")], has_more: false, next_cursor: null }));
    const seen: Array<{ key: string; summary: string; status: string; archived?: boolean }> = [];
    const out = await client.fetchNotionPages(notionConnection(), "db-1", async (tickets) => {
      seen.push(...tickets.map((t) => ({ key: t.issueKey, summary: t.summary, status: t.status, archived: t.archived })));
    });
    expect(out).toEqual({ total: 2, truncated: false });
    expect(seen).toEqual([
      { key: "notion:11111111", summary: "A", status: "Open", archived: false },
      { key: "notion:22222222", summary: "B", status: "Open", archived: false }
    ]);
    expect(JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body)).start_cursor).toBe("cur-2");
  });

  it("adds a last_edited_time filter only for an incremental run", async () => {
    const { client } = makeClient();
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(200, { results: [], has_more: false }));
    await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined, "2026-02-01T00:00:00.000Z");
    await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined);
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).filter).toEqual({
      timestamp: "last_edited_time",
      last_edited_time: { on_or_after: "2026-02-01T00:00:00.000Z" }
    });
    expect(JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body)).filter).toBeUndefined();
  });

  it("flags an archived or trashed page", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockResolvedValue(
      res(200, { results: [{ object: "page", id: "p1", in_trash: true, properties: {} }], has_more: false })
    );
    let archived: boolean | undefined;
    await client.fetchNotionPages(notionConnection(), "db-1", async (t) => {
      archived = t[0].archived;
    });
    expect(archived).toBe(true);
  });

  it("waits out a 429 using Retry-After, then succeeds", async () => {
    jest.useFakeTimers();
    try {
      const { client } = makeClient();
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(res(429, { code: "rate_limited", message: "slow down" }, { "retry-after": "2" }))
        .mockResolvedValueOnce(res(200, { results: [], has_more: false }));
      const pending = client.fetchNotionPages(notionConnection(), "db-1", async () => undefined);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toEqual({ total: 0, truncated: false });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("gives up after the bounded retries and reports a rate-limit message, not a raw body", async () => {
    jest.useFakeTimers();
    try {
      const { client } = makeClient();
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(res(429, { code: "rate_limited", message: "slow down" }, { "retry-after": "1" }));
      const pending = client.fetchNotionPages(notionConnection(), "db-1", async () => undefined).catch((e) => e);
      await jest.advanceTimersByTimeAsync(10_000);
      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/rate limiting/i);
      expect(fetchSpy).toHaveBeenCalledTimes(4); // first try plus NOTION_MAX_RETRIES
    } finally {
      jest.useRealTimers();
    }
  });

  it("maps 401 to IntegrationConnectionInvalidError", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockResolvedValue(res(401, { code: "unauthorized", message: "API token is invalid." }));
    const err = await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationConnectionInvalidError);
    expect(err.message).not.toMatch(/API token is invalid/);
  });

  it("maps 404 object_not_found to a not-shared error that says how to fix it", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockResolvedValue(res(404, { code: "object_not_found", message: "Could not find database" }));
    const err = await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined).catch((e) => e);
    expect(err).toBeInstanceOf(NotionNotSharedError);
    expect(err.message).toMatch(/no longer shared|Connections/i);
  });

  it("maps 403 restricted_resource and a missing capability to distinct permission errors", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockResolvedValueOnce(res(403, { code: "restricted_resource", message: "no access" }));
    const restricted = await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined).catch((e) => e);
    expect(restricted).toBeInstanceOf(NotionPermissionError);
    expect(restricted.message).toMatch(/no access to this Notion/i);

    jest.spyOn(global, "fetch").mockResolvedValueOnce(res(403, { code: "restricted_resource_capability", message: "Insufficient permissions for this endpoint." }));
    const capability = await client.fetchNotionPages(notionConnection(), "db-1", async () => undefined).catch((e) => e);
    expect(capability).toBeInstanceOf(NotionPermissionError);
    expect(capability.message).toMatch(/missing a required capability/i);
    expect(capability.message).not.toBe(restricted.message);
  });
});

describe("IntegrationSyncClient#fetchNotionBody", () => {
  it("reads nested children depth first and renders them", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/blocks/page-1/children")) {
        return res(200, {
          results: [{ ...block("toggle", { rich_text: [rich("More")] }, { id: "toggle-1" }), has_children: true }],
          has_more: false
        });
      }
      if (u.includes("/blocks/toggle-1/children")) {
        return res(200, { results: [block("paragraph", { rich_text: [rich("hidden detail")] })], has_more: false });
      }
      return res(404, { code: "object_not_found", message: "x" });
    });
    const body = await client.fetchNotionBody(notionConnection(), "page-1");
    expect(body).toContain("**More**");
    expect(body).toContain("hidden detail");
  });

  it("paginates block children with start_cursor", async () => {
    const { client } = makeClient();
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(res(200, { results: [block("paragraph", { rich_text: [rich("one")] })], has_more: true, next_cursor: "c2" }))
      .mockResolvedValueOnce(res(200, { results: [block("paragraph", { rich_text: [rich("two")] })], has_more: false }));
    const body = await client.fetchNotionBody(notionConnection(), "page-1");
    expect(body).toContain("one");
    expect(body).toContain("two");
    expect(String(fetchSpy.mock.calls[1][0])).toContain("start_cursor=c2");
  });

  it("stops descending at the depth cap and marks the cut", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      const id = /blocks\/([^/]+)\/children/.exec(String(url))![1];
      return res(200, { results: [{ ...block("toggle", { rich_text: [rich(`level of ${id}`)] }, { id: `${id}-x` }), has_children: true }], has_more: false });
    });
    const body = await client.fetchNotionBody(notionConnection(), "p");
    expect((body.match(/level of/g) || []).length).toBe(NOTION_MAX_BLOCK_DEPTH);
    expect(body).toContain("nested content");
  });

  it("stops at the total block cap and says the page was cut", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockImplementation(async () =>
      res(200, { results: Array.from({ length: 100 }, () => block("paragraph", { rich_text: [rich("line")] })), has_more: true, next_cursor: "more" })
    );
    const body = await client.fetchNotionBody(notionConnection(), "p");
    expect((body.match(/^line$/gm) || []).length).toBe(NOTION_MAX_BLOCKS_PER_PAGE);
    expect(body).toMatch(/not synced/i);
  });

  it("replaces an unreadable nested container with a placeholder instead of failing the page", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/blocks/p/children")) {
        return res(200, { results: [{ ...block("toggle", { rich_text: [rich("Broken")] }, { id: "t" }), has_children: true }], has_more: false });
      }
      return res(404, { code: "object_not_found", message: "gone" });
    });
    const body = await client.fetchNotionBody(notionConnection(), "p");
    expect(body).toContain("**Broken**");
    expect(body).toMatch(/not shown here/);
  });

  it("fails the whole body when the page itself is not shared", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockResolvedValue(res(404, { code: "object_not_found", message: "gone" }));
    await expect(client.fetchNotionBody(notionConnection(), "p")).rejects.toBeInstanceOf(NotionNotSharedError);
  });
});

describe("IntegrationSyncClient#fetchNotionComments", () => {
  it("returns comments oldest first with the author's resolved name, capped to the most recent", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/comments")) {
        return res(200, {
          results: [
            { created_by: { id: "u1" }, created_time: "2026-01-01T00:00:00.000Z", rich_text: [rich("first")] },
            { created_by: { id: "u1" }, created_time: "2026-01-02T00:00:00.000Z", rich_text: [rich("second", { bold: true })] },
            { created_by: { id: "u2" }, created_time: "2026-01-03T00:00:00.000Z", rich_text: [] }
          ],
          has_more: false
        });
      }
      if (u.includes("/users/u1")) return res(200, { name: "Ada" });
      return res(403, { code: "restricted_resource", message: "no user access" });
    });
    const comments = await client.fetchNotionComments(notionConnection(), "page-1");
    expect(comments.map((c) => c.body)).toEqual(["first", "**second**"]);
    expect(comments.every((c) => c.author === "Ada")).toBe(true);
  });

  it("falls back to a generic author when user lookup is not permitted", async () => {
    const { client } = makeClient();
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/comments")) {
        return res(200, { results: [{ created_by: { id: "u9" }, created_time: "2026-01-01T00:00:00.000Z", rich_text: [rich("hi")] }], has_more: false });
      }
      return res(403, { code: "restricted_resource", message: "no user access" });
    });
    const comments = await client.fetchNotionComments(notionConnection(), "page-1");
    expect(comments[0].author).toBe("Notion user");
  });

  it("is routed to by fetchComments for the notion provider", async () => {
    const { client } = makeClient();
    const spy = jest.spyOn(client, "fetchNotionComments").mockResolvedValue([]);
    await client.fetchComments(notionConnection(), "notion", "page-1");
    expect(spy).toHaveBeenCalledWith(expect.anything(), "page-1");
  });
});

describe("IntegrationSyncClient.composeNotionDescription", () => {
  it("puts properties above the body and omits an empty half", () => {
    expect(IntegrationSyncClient.composeNotionDescription({ Status: "Open" }, "Body text")).toBe("- **Status:** Open\n\nBody text");
    expect(IntegrationSyncClient.composeNotionDescription({}, "Body text")).toBe("Body text");
    expect(IntegrationSyncClient.composeNotionDescription(null, "")).toBe("");
  });
});
