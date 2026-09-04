import { jiraDescriptionToText, truncateForColumn } from "./integration-text.util";

/*
 * jiraDescriptionToText flattens Atlassian Document Format (ADF) — the recursive
 * {type, content[], text} tree Jira returns for issue descriptions and comment bodies — into
 * plain text. It backs the "User Story Context" / Jira source detail shown in the Zyra Task
 * Details view (legacy.service.ts sourceSummary, jira_tickets.description).
 *
 * This can't be driven end-to-end: it only runs against a real Jira REST response
 * (LegacyService#getJiraTicketsById), and the e2e suite has no live or mocked Jira connection —
 * the same documented boundary as api/zyra.spec.ts's "no AI provider is configured" (see
 * docs/e2e-coverage-waves.md). These are unit tests of the pure conversion instead.
 */
describe("jiraDescriptionToText", () => {
  it("returns an empty string for null, undefined and empty input", () => {
    expect(jiraDescriptionToText(null)).toBe("");
    expect(jiraDescriptionToText(undefined)).toBe("");
    expect(jiraDescriptionToText("")).toBe("");
    expect(jiraDescriptionToText({})).toBe("");
  });

  it("passes a plain string straight through", () => {
    expect(jiraDescriptionToText("Plain text description")).toBe("Plain text description");
  });

  it("keeps sibling paragraphs on separate lines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First paragraph." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second paragraph." }] },
      ],
    };
    expect(jiraDescriptionToText(doc)).toBe("First paragraph.\nSecond paragraph.");
  });

  it("does NOT insert a line break between inline text runs split by a mark (bold/italic/link)", () => {
    // Regression: the previous implementation joined every sibling array with "\n" unconditionally,
    // including the inline text nodes inside a single paragraph — so "Post requires a **title** and
    // body" (three text nodes because of the bold mark) rendered as "Post requires a\ntitle\nand
    // body", a spurious mid-sentence break.
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Post requires a " },
            { type: "text", text: "title", marks: [{ type: "strong" }] },
            { type: "text", text: " and body." },
          ],
        },
      ],
    };
    expect(jiraDescriptionToText(doc)).toBe("Post requires a title and body.");
  });

  it("keeps bullet list items on separate lines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Acceptance Criteria:" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "User can access a \"New Post\" option" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Post requires a title and body" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "User receives a confirmation" }] }] },
          ],
        },
      ],
    };
    expect(jiraDescriptionToText(doc)).toBe(
      'Acceptance Criteria:\nUser can access a "New Post" option\nPost requires a title and body\nUser receives a confirmation',
    );
  });

  it("treats an explicit hardBreak as a line break", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }],
        },
      ],
    };
    expect(jiraDescriptionToText(doc)).toBe("Line one\nLine two");
  });

  it("keeps a heading on its own line, with its own inline runs joined together", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body text." }] },
      ],
    };
    expect(jiraDescriptionToText(doc)).toBe("Summary\nBody text.");
  });

  it("drops empty nodes without leaving blank artifacts", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [] }, { type: "paragraph", content: [{ type: "text", text: "Only line." }] }] };
    expect(jiraDescriptionToText(doc)).toBe("Only line.");
  });
});

/*
 * Regression coverage for the "value too long for type character varying(1024)" prod incident: a
 * Jira/Linear issue title (linear_tickets.summary / jira_tickets.summary) longer than the column
 * allowed threw a raw Postgres error that aborted the whole sync run — see
 * integration-sync.processor.ts's upsertTicket and integration-sync-document.builder.ts's title.
 */
describe("truncateForColumn", () => {
  it("returns the value unchanged when it already fits", () => {
    expect(truncateForColumn("short", 10)).toBe("short");
  });

  it("returns the value unchanged exactly at the limit", () => {
    expect(truncateForColumn("1234567890", 10)).toBe("1234567890");
  });

  it("truncates and marks the cut with an ellipsis when the value is over the limit", () => {
    const result = truncateForColumn("12345678901", 10);
    expect(result).toBe("123456789…");
    expect(result).toHaveLength(10);
  });

  it("never produces a result longer than maxLength, for a wide range of inputs", () => {
    for (const len of [0, 1, 2, 5, 1024, 5000]) {
      const value = "x".repeat(len);
      expect(truncateForColumn(value, 512).length).toBeLessThanOrEqual(512);
    }
  });

  it("degrades gracefully when maxLength is smaller than the ellipsis itself", () => {
    expect(() => truncateForColumn("anything", 0)).not.toThrow();
    expect(truncateForColumn("anything", 0).length).toBeLessThanOrEqual(1);
  });
});
