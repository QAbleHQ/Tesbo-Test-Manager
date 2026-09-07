// Shared "what changed" summarizer for the Knowledge Base Change History timeline — used by both
// the Jira/Linear sync pipeline (integration-sync.processor.ts) and manual-document version
// history (legacy.service.ts), so a fix to how a diff is grouped/labelled only has to happen once.
//
// A document body here is markdown built from `\n\n`-joined blocks, e.g.
//   # TES-1: summary
//   - **Status:** Open
//   ## Description
//   the description text
//   ## Comments
//   ### Namrata Gosai — 2026-09-02
//   the comment text
// A heading and the block(s) of body text that follow it are pushed as *separate* `\n\n`-joined
// entries by the builder, so naively labelling each block by its own first line (the previous
// approach) treats every heading-less body block as its own anonymous section — a multi-paragraph
// comment or description fragments into several indistinguishable "Details" entries, and a
// comment's own heading (author + date) leaks into the label list verbatim. `groupSections` below
// folds a heading-less block into the section opened by the heading above it instead.

export interface ChangedField {
  label: string;
  oldExcerpt: string;
  newExcerpt: string;
  oldLength: number;
  newLength: number;
  truncated: boolean;
}

export interface TextChangeSummary {
  summary: string;
  fields: ChangedField[];
}

const EXCERPT_MAX_CHARS = 4000;
const SUMMARY_LABEL_MAX = 3;
const SUMMARY_MAX_CHARS = 140;
const DETAILS_LABEL = "Details";

// Matches a mirrored ticket comment's own heading ("Namrata Gosai — 2026-09-02"): bucketed under
// one generic "Comments" label rather than letting each comment's author/date leak into the
// summary as its own entry. A comment whose source `createdAt` failed to parse has no trailing
// date (see formatDate in integration-sync-document.builder.ts) and falls through to being
// labelled by its own heading text instead — rare, and never garbled, just slightly less generic.
const COMMENT_HEADING_RE = /^.+\s+—\s+\d{4}-\d{2}-\d{2}$/;

function excerptOf(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXCERPT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, EXCERPT_MAX_CHARS), truncated: true };
}

/**
 * Groups a document body into (label, text) sections. A single `#` heading always stands alone as
 * "Title". A `##`-`######` heading opens a new named section (or the shared "Comments" bucket) that
 * absorbs every heading-less block after it, until the next heading. Anything heading-less before
 * the first `##`+ heading (e.g. the Status/Type/Priority meta block) falls into the generic
 * "Details" bucket, matching the original design intent for that block.
 */
function groupSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  let activeLabel = DETAILS_LABEL;
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join("\n\n");
    const existing = sections.get(activeLabel);
    sections.set(activeLabel, existing ? `${existing}\n\n${text}` : text);
    buffer = [];
  };

  for (const block of content.split("\n\n")) {
    const firstLine = (block.split("\n")[0] || "").trim();
    const titleHeading = firstLine.match(/^#\s+(.*)$/);
    const sectionHeading = !titleHeading ? firstLine.match(/^#{2,6}\s+(.*)$/) : null;

    if (titleHeading) {
      flush();
      const existing = sections.get("Title");
      sections.set("Title", existing ? `${existing}\n\n${block}` : block);
      activeLabel = DETAILS_LABEL;
      continue;
    }
    if (sectionHeading) {
      flush();
      const text = sectionHeading[1].trim();
      activeLabel = COMMENT_HEADING_RE.test(text) ? "Comments" : text || DETAILS_LABEL;
      buffer = [block];
      continue;
    }
    buffer.push(block);
  }
  flush();
  return sections;
}

/**
 * Short, human-readable "what changed" summary plus the structured per-field diff behind it (used
 * for the large-change "View diff" modal — see ChangeDiffModal.tsx). `oldContent === null` means a
 * brand-new document/ticket, so there is nothing to diff against.
 */
export function summarizeTextChange(
  oldContent: string | null,
  newContent: string,
  addedMessage = "Added.",
  noChangeMessage = "Updated."
): TextChangeSummary {
  if (oldContent === null) return { summary: addedMessage, fields: [] };

  const oldSections = groupSections(oldContent);
  const newSections = groupSections(newContent);

  const labels: string[] = [];
  const fields: ChangedField[] = [];
  const seen = new Set<string>();

  const consider = (label: string, oldText: string, newText: string) => {
    if (oldText === newText || seen.has(label)) return;
    seen.add(label);
    labels.push(label);
    const oldEx = excerptOf(oldText);
    const newEx = excerptOf(newText);
    fields.push({
      label,
      oldExcerpt: oldEx.text,
      newExcerpt: newEx.text,
      oldLength: oldText.length,
      newLength: newText.length,
      truncated: oldEx.truncated || newEx.truncated
    });
  };

  for (const [label, newText] of newSections) consider(label, oldSections.get(label) ?? "", newText);
  // A section removed entirely (present before, absent now) is still a real change.
  for (const [label, oldText] of oldSections) consider(label, oldText, newSections.get(label) ?? "");

  if (!labels.length) return { summary: noChangeMessage, fields: [] };

  const shown = labels.slice(0, SUMMARY_LABEL_MAX);
  const rest = labels.length - shown.length;
  let summary = `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""} updated.`;
  if (summary.length > SUMMARY_MAX_CHARS) summary = `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
  return { summary, fields };
}

/**
 * Convenience wrapper for a manually-created (non-synced) Knowledge Base document, whose title and
 * body are separate columns rather than one markdown blob: folds the title into a synthetic `#`
 * heading so a title-only change is reported as its own "Title" field, then reuses the same
 * section grouping/labelling as the sync pipeline for the body.
 */
export function summarizeDocumentChange(
  oldDoc: { title: string; contentText: string | null },
  newDoc: { title: string; contentText: string | null }
): TextChangeSummary {
  const wrap = (d: { title: string; contentText: string | null }) => `# ${d.title}\n\n${d.contentText || ""}`;
  return summarizeTextChange(wrap(oldDoc), wrap(newDoc));
}
