import type { JSONContent } from "@tiptap/react";
import { renderMarkdown } from "./markdown";

/*
 * Bug comments are stored as Markdown and displayed through renderMarkdown (lib/markdown.ts), so the
 * Markdown written here is exactly the subset that renderer reads — and nothing more:
 *
 *   - **bold**, *italic*, **_bold italic_**, [text](https://…) links
 *   - "- " bullet and "1. " numbered lists, one item per line
 *   - one line per paragraph or line break (renderMarkdown makes every line its own block)
 *
 * TipTap's own Markdown serializer (@tiptap/markdown) is deliberately not used: it backslash-escapes
 * `_ * [ ] ~ \` and HTML-encodes entities, neither of which renderMarkdown undoes, so a comment
 * mentioning @ann_lee would display as "@ann\_lee" — and no longer match the server's mention
 * parser, which reads the stored text.
 *
 * The way back into the editor is renderMarkdown itself (markdownToCommentHtml), so what the editor
 * loads is, by construction, what everyone else sees.
 */

type Mark = NonNullable<JSONContent["marks"]>[number];

const SAFE_HREF = /^https?:\/\/[^\s)]+$/i;

function hasMark(marks: Mark[] | undefined, type: string): boolean {
  return !!marks?.some((mark) => mark.type === type);
}

function textToMarkdown(node: JSONContent): string {
  const text = node.text ?? "";
  // Delimiters hug the words: "** bold **" is not emphasis to a reader, and leading/trailing spaces
  // stay outside so neighbouring words keep their spacing.
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (!core) return text;
  const bold = hasMark(node.marks, "bold");
  const italic = hasMark(node.marks, "italic");
  // Bold+italic is **_x_**, not ***x***: renderMarkdown runs bold before italic, and ***x*** would
  // leave a stray "*" that italic then pairs across the closing </strong>.
  let out = bold && italic ? `**_${core}_**` : bold ? `**${core}**` : italic ? `*${core}*` : core;
  const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
  // Links renderMarkdown would not render (mailto:, relative, javascript:) are kept as their text.
  if (typeof href === "string" && SAFE_HREF.test(href)) out = `[${out}](${href})`;
  return `${lead}${out}${trail}`;
}

/** A paragraph's inline content; `lineBreak` is what a hard break becomes. */
function inlineToMarkdown(node: JSONContent, lineBreak: string): string {
  return (node.content ?? [])
    .map((child) => (child.type === "hardBreak" ? lineBreak : child.type === "text" ? textToMarkdown(child) : ""))
    .join("");
}

/**
 * renderMarkdown has no nested lists, so nested items are flattened into the same run (a nested list
 * of the other kind starts its own list there). A newline inside an item would end the list, so the
 * item's paragraphs and line breaks are joined with spaces.
 */
function listToLines(node: JSONContent): string[] {
  const ordered = node.type === "orderedList";
  let n = Number(node.attrs?.start ?? 1) || 1;
  const lines: string[] = [];
  for (const item of node.content ?? []) {
    const text: string[] = [];
    const nested: string[] = [];
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") nested.push(...listToLines(child));
      else text.push(inlineToMarkdown(child, " ").trim());
    }
    const joined = text.filter(Boolean).join(" ");
    // An empty item ("- ") is not a list item to renderMarkdown; it would show as a stray "-".
    if (joined) lines.push(`${ordered ? `${n++}. ` : "- "}${joined}`);
    lines.push(...nested);
  }
  return lines;
}

export function commentDocToMarkdown(doc: JSONContent): string {
  const lines: string[] = [];
  for (const block of doc.content ?? []) {
    if (block.type === "bulletList" || block.type === "orderedList") lines.push(...listToLines(block));
    else lines.push(inlineToMarkdown(block, "\n"));
  }
  return lines.join("\n").replace(/^\s*\n/, "").trimEnd();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A comment for display: renderMarkdown's HTML with each "@Name" / "@email" of a project member
 * highlighted, by the same rule the server uses to log mentions (the "@" starts a word, longest
 * label first). Only text between tags is touched, never a tag or a link's text, and the labels are
 * matched in their escaped form because renderMarkdown has already escaped the text.
 */
export function renderCommentMarkdown(markdown: string, mentionLabels: string[]): string {
  const html = renderMarkdown(markdown);
  const labels = Array.from(new Set(mentionLabels.map((l) => l.trim()).filter(Boolean)));
  if (!labels.length || !html.includes("@")) return html;
  const alternatives = labels
    .map(escapeHtml)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  const mention = new RegExp(String.raw`(^|[^\p{L}\p{N}_.@])@(${alternatives})(?![\p{L}\p{N}_])`, "giu");
  let insideLink = false;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<a[\s>]/i.test(part)) insideLink = true;
        else if (/^<\/a>/i.test(part)) insideLink = false;
        return part;
      }
      return insideLink ? part : part.replace(mention, (_m, lead: string, name: string) => `${lead}<span class="font-medium text-[var(--accent-light)]">@${name}</span>`);
    })
    .join("");
}

/**
 * Stored Markdown as HTML the comment editor can load. renderMarkdown marks a blank line with a
 * bare <br/> between blocks; loaded as-is, that becomes a paragraph holding a hard break, which
 * serialises back as two blank lines — so it is turned into the empty paragraph it stands for.
 */
export function markdownToCommentHtml(markdown: string): string {
  return renderMarkdown(markdown).replace(/<br\/>/g, "<p></p>");
}
