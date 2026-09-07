import { summarizeDocumentChange, summarizeTextChange } from "./text-diff.util";

/** Builds a mirrored-ticket markdown body exactly the shape IntegrationSyncDocumentBuilder produces:
 *  heading and body pushed as separate `\n\n`-joined blocks. */
function mirrorMarkdown(opts: {
  title?: string;
  status?: string;
  description: string;
  comments: Array<{ author: string; date: string; body: string }>;
}): string {
  const sections = [`# ${opts.title ?? "TES-1: Checkout button is unresponsive"}`];
  sections.push(`- **Status:** ${opts.status ?? "Open"}`);
  sections.push("## Description");
  sections.push(opts.description);
  sections.push("## Comments");
  if (!opts.comments.length) {
    sections.push("_No comments on the source ticket._");
  } else {
    for (const c of opts.comments) {
      sections.push(`### ${c.author} — ${c.date}`);
      sections.push(c.body);
    }
  }
  return sections.join("\n\n");
}

describe("summarizeTextChange", () => {
  // Pins the exact reported bug: "Details, Details, namrata gosai — 2026-09-02, Details, namrata
  // gosai — 2026-09-02, Details updated." — a multi-paragraph comment (and its own heading)
  // fragmenting into repeated anonymous "Details" entries instead of one "Comments" entry.
  it("reports one deduped 'Comments' entry for a changed multi-paragraph comment thread, never a repeated 'Details' or a leaked author/date label", () => {
    const before = mirrorMarkdown({
      description: "Please investigate.",
      comments: [{ author: "Namrata Gosai", date: "2026-09-01", body: "Looking into it." }],
    });
    const after = mirrorMarkdown({
      description: "Please investigate.",
      comments: [
        {
          author: "Namrata Gosai",
          date: "2026-09-02",
          body: "First paragraph of the update.\n\nSecond paragraph with more detail.",
        },
      ],
    });

    const { summary, fields } = summarizeTextChange(before, after);

    expect(summary).toBe("Comments updated.");
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe("Comments");
    expect(summary).not.toMatch(/Details/);
    expect(summary).not.toMatch(/Namrata Gosai/i);
  });

  it("dedupes and caps the label list at 3 + '+N more' when many sections change at once", () => {
    const before = mirrorMarkdown({ status: "Open", description: "Old description.", comments: [] });
    const after = mirrorMarkdown({
      title: "TES-1: New title",
      status: "In Progress",
      description: "New description.",
      comments: [{ author: "Bob", date: "2026-09-02", body: "A new comment." }],
    });

    const { summary, fields } = summarizeTextChange(before, after);

    // Title, Details (the meta block), Description, Comments — 4 real changes, capped to 3 + more.
    expect(fields).toHaveLength(4);
    expect(summary).toMatch(/^Title, Details, Description \+1 more updated\.$/);
  });

  it("treats a section that disappears entirely as a change too", () => {
    const before = mirrorMarkdown({ description: "Has decisions.", comments: [] });
    const after = before; // no other change, but simulate a section vanishing below
    const withDecisions = `${before}\n\n## Decisions from discussion\n\nWe decided X.`;
    const { fields } = summarizeTextChange(withDecisions, after);
    expect(fields.some((f) => f.label === "Decisions from discussion")).toBe(true);
  });

  it("returns the added/no-change fallbacks, and never labels a null-vs-content diff as a field change", () => {
    const added = summarizeTextChange(null, mirrorMarkdown({ description: "x", comments: [] }), "Added from sync.", "Updated from sync.");
    expect(added.summary).toBe("Added from sync.");
    expect(added.fields).toHaveLength(0);

    const same = mirrorMarkdown({ description: "same", comments: [] });
    const unchanged = summarizeTextChange(same, same, "Added from sync.", "Updated from sync.");
    expect(unchanged.summary).toBe("Updated from sync.");
    expect(unchanged.fields).toHaveLength(0);
  });

  it("caps each excerpt at 4000 characters and flags it truncated", () => {
    const long = "x".repeat(5000);
    const before = mirrorMarkdown({ description: "short", comments: [] });
    const after = mirrorMarkdown({ description: long, comments: [] });
    const { fields } = summarizeTextChange(before, after);
    const description = fields.find((f) => f.label === "Description")!;
    expect(description.truncated).toBe(true);
    expect(description.newExcerpt).toHaveLength(4000);
    // The section's full text includes its own "## Description" heading, not just the body — so
    // this is slightly more than the raw description length, not exactly equal to it.
    expect(description.newLength).toBeGreaterThanOrEqual(long.length);
  });
});

describe("summarizeDocumentChange (manual, non-synced documents)", () => {
  it("reports a Title change and a Details (body) change independently", () => {
    const { summary, fields } = summarizeDocumentChange(
      { title: "Old title", contentText: "Old body." },
      { title: "New title", contentText: "New body." }
    );
    expect(summary).toBe("Title, Details updated.");
    expect(fields.map((f) => f.label).sort()).toEqual(["Details", "Title"]);
  });

  it("reports nothing changed when title and body are identical", () => {
    const { summary, fields } = summarizeDocumentChange({ title: "Same", contentText: "Same body." }, { title: "Same", contentText: "Same body." });
    expect(summary).toBe("Updated.");
    expect(fields).toHaveLength(0);
  });

  it("treats a null body the same as empty, for a document that has never had content", () => {
    const { fields } = summarizeDocumentChange({ title: "T", contentText: null }, { title: "T", contentText: "Now has content." });
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe("Details");
  });
});
