// Small hand-rolled Markdown → HTML renderer (h1–h6, bold/italic, links, inline code, fenced
// code blocks, blockquotes, hr, bullet and numbered lists, pipe tables). Escapes HTML first so raw content can never inject
// markup — safe to render via dangerouslySetInnerHTML. Pair with the `zyra-prose` CSS class
// (app/globals.css) for styling, and `break-words` on the container so long unbroken tokens
// (URLs, ids) wrap instead of overflowing a fixed-width container.
//
// Bold/italic run before the link replacement (same order as the backend's own inline()
// in integration-sync-document.builder.ts, which produces content_html from the identical
// markdown) so a link whose visible text uses **bold**/*italic*/_italic_ nests correctly.
function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Intraword underscores are not emphasis (as in CommonMark): user_id and order_id stay as written.
    .replace(/(^|[^A-Za-z0-9_])_([^_]+?)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function mdTable(lines: string[]): string {
  const isSep = (l: string) => /^\|[\s\-:|]+\|$/.test(l.trim());
  const cells = (l: string) => l.trim().replace(/(?:^\|)|(?:\|$)/g, "").split("|").map(c => c.trim());
  const data = lines.filter(l => !isSep(l));
  if (!data.length) return "";
  const [hdr, ...rows] = data;
  const thead = `<thead><tr>${cells(hdr).map(h => `<th>${mdInline(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(r => `<tr>${cells(r).map(c => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="zyra-md-table-wrap"><table class="zyra-md-table">${thead}${tbody}</table></div>`;
}

// The same Markdown flattened to one line of plain text, for clamped previews (task rows, Kanban
// cards) where headings and lists can't lay out: syntax is dropped, link text is kept, lines join.
// Returns text, not HTML — render it as a React text child, never via dangerouslySetInnerHTML.
export function markdownToPlainText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^---+$/.test(line) && !/^\|[\s\-:|]+\|$/.test(line) && !/^```/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\|(.*)\|$/, (_, cells: string) => cells.split("|").map((c) => c.trim()).join(" · "))
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/(^|[^A-Za-z0-9_])_([^_]+?)_(?![A-Za-z0-9_])/g, "$1$2"),
    )
    .join(" ");
}

// Zyra task source types whose `detail` is captured document/ticket text, which Jira, Linear and Notion
// descriptions carry as Markdown. Shared by the task detail page and the quick-view panel so the
// two can't disagree. `story` is left out: it is the user's own one-line story, shown plain
// everywhere else (the task heading, Kanban cards).
const MARKDOWN_SOURCE_TYPES = new Set(["knowledge_base", "context", "jira", "linear", "notion"]);

export function isMarkdownSource(type: string): boolean {
  return MARKDOWN_SOURCE_TYPES.has(type);
}

export function renderMarkdown(text: string): string {
  // Quotes matter here, not just `<`/`>`: the link replacement above interpolates its captured URL
  // straight into a double-quoted href attribute, so an unescaped `"` in the source text (e.g.
  // `[x](https://a" onmouseover=alert(1) x=")`) would close that attribute early and let whatever
  // follows land as raw, executing HTML instead of stopping at the closing `)` the regex expects.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Everything below operates on already-escaped text: `>` arrives as `&gt;` (hence the blockquote
  // pattern), and a code block's contents need no further escaping — only no inline formatting.
  const lines = esc(text).split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    // Fenced code block. Contents are emitted verbatim (untrimmed, no mdInline), so `**`/`*`/`_`
    // inside code never turn into formatting. An unterminated fence runs to the end of the text.
    if (/^```/.test(t)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++; // closing fence
      out.push(`<pre class="code-block"><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    // ATX headings, all six levels (an optional closing run of #s is dropped, as in CommonMark).
    // Only # to ### used to be recognised, so a "#### Heading" fell through to a paragraph and
    // rendered with its #s showing.
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(t);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^---+$/.test(t)) { out.push("<hr/>"); i++; continue; }
    if (/^&gt; ?/.test(t)) {
      const quoted: string[] = [];
      while (i < lines.length && /^&gt; ?/.test(lines[i].trim())) { quoted.push(mdInline(lines[i].trim().replace(/^&gt; ?/, ""))); i++; }
      out.push(`<blockquote><p>${quoted.join("<br/>")}</p></blockquote>`);
      continue;
    }
    if (t.startsWith("|")) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { tbl.push(lines[i]); i++; }
      out.push(mdTable(tbl));
      continue;
    }
    // A numbered list is an <ol> — it used to be a <ul> with the numbers stripped, which lost step
    // order. A run of one kind ends where the other kind starts, so each becomes its own list.
    const ordered = /^(\d+)\. /.exec(t);
    if (ordered || /^[-*] /.test(t)) {
      const itemPattern = ordered ? /^\d+\. / : /^[-*] /;
      const items: string[] = [];
      while (i < lines.length && itemPattern.test(lines[i].trim())) {
        items.push(`<li>${mdInline(lines[i].trim().replace(itemPattern, ""))}</li>`);
        i++;
      }
      const start = ordered ? Number(ordered[1]) : 1;
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (t === "") { out.push("<br/>"); i++; continue; }
    out.push(`<p>${mdInline(t)}</p>`);
    i++;
  }
  return out.join("");
}
