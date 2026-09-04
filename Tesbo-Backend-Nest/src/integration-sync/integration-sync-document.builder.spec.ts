import { IntegrationSyncDocumentBuilder } from "./integration-sync-document.builder";
import { RemoteComment, RemoteTicket } from "./integration-sync.types";

function ticket(overrides: Partial<RemoteTicket> = {}): RemoteTicket {
  return {
    issueId: "10001",
    issueKey: "EAD-123",
    summary: "Checkout fails on Safari",
    description: "Users on Safari 17 see a blank page after clicking Pay.",
    issueType: "Bug",
    status: "In Progress",
    priority: "High",
    assignee: "Priya Shah",
    reporter: "Sam Ortiz",
    labels: "checkout, safari",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-05T14:30:00.000Z",
    url: "https://acme.atlassian.net/browse/EAD-123",
    ...overrides
  };
}

const comments: RemoteComment[] = [
  { author: "Priya Shah", createdAt: "2026-03-04T10:00:00.000Z", body: "Repro'd on 17.2 — ITP is blocking the 3DS iframe." },
  { author: "Sam Ortiz", createdAt: "2026-03-05T08:00:00.000Z", body: "Let's ship Safari first and defer Firefox." }
];

describe("IntegrationSyncDocumentBuilder#buildMirror", () => {
  const builder = new IntegrationSyncDocumentBuilder();

  it("titles the document '<KEY>: <summary>'", () => {
    expect(builder.buildMirror(ticket(), [], null).title).toBe("EAD-123: Checkout fails on Safari");
  });

  // Regression: knowledge_documents.title is VARCHAR(512). A summary comfortably under
  // linear_tickets/jira_tickets' own (much larger, TEXT since V93) limit can still overflow this
  // smaller, more widely shared column once "<KEY>: " is prepended — this is the dormant half of
  // the "value too long for type character varying" prod incident.
  it("truncates the title to fit knowledge_documents.title (512 chars) rather than overflowing it", () => {
    const longSummary = "A".repeat(600);
    const { title } = builder.buildMirror(ticket({ summary: longSummary }), [], null);
    expect(title).toHaveLength(512);
    expect(title.startsWith("EAD-123: AAAA")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });

  // RagChunkingService splits on markdown headings and records the heading breadcrumb per chunk,
  // so this exact set — and its order — is what lets Zyra cite "EAD-123 > Comments".
  it("emits Description, Decisions and Comments as h2 sections in that order", () => {
    const { markdown } = builder.buildMirror(ticket(), comments, "- Scope cut to Safari only (Sam Ortiz, 5 Mar).");
    const headings = markdown.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Description", "## Decisions from discussion", "## Comments"]);
  });

  it("carries ticket metadata into the body so status/priority are semantically searchable", () => {
    const { markdown } = builder.buildMirror(ticket(), [], null);
    expect(markdown).toContain("- **Status:** In Progress");
    expect(markdown).toContain("- **Priority:** High");
    expect(markdown).toContain("- **Assignee:** Priya Shah");
    expect(markdown).toContain("- **Labels:** checkout, safari");
    expect(markdown).toContain("- **Updated:** 2026-03-05");
  });

  it("renders each comment under its own h3 with author and date", () => {
    const { markdown } = builder.buildMirror(ticket(), comments, null);
    expect(markdown).toContain("### Priya Shah — 2026-03-04");
    expect(markdown).toContain("Repro'd on 17.2 — ITP is blocking the 3DS iframe.");
    expect(markdown).toContain("### Sam Ortiz — 2026-03-05");
  });

  it("omits the Decisions section entirely when there is no summary", () => {
    const { markdown } = builder.buildMirror(ticket(), comments, null);
    expect(markdown).not.toContain("Decisions from discussion");
  });

  it("states the absence explicitly rather than leaving sections blank", () => {
    // An empty section is exactly the "why is this document empty?" confusion the sync UI work
    // is meant to remove — the document should say why.
    const { markdown } = builder.buildMirror(ticket({ description: "  " }), [], null);
    expect(markdown).toContain("_No description provided in the source ticket._");
    expect(markdown).toContain("_No comments on the source ticket._");
  });

  it("escapes provider content in the HTML rendering", () => {
    const { html } = builder.buildMirror(ticket({ summary: '<img src=x onerror="alert(1)">' }), [], null);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("keeps our own bold/link markdown as real markup in the HTML", () => {
    const { html } = builder.buildMirror(ticket(), [], null);
    expect(html).toContain("<strong>Status:</strong>");
    expect(html).toContain("<h1>EAD-123: Checkout fails on Safari</h1>");
    expect(html).toContain("<ul><li>");
  });
});

// V72's buildNotes (a per-ticket sibling document) was retired in V73: human input on a synced
// ticket now goes to the document's comment thread instead. The builder produces exactly one
// document per ticket.
