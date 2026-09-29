// Small hand-rolled Markdown → HTML renderer (headers, bold/italic, links, inline code, hr,
// bullet/numbered lists, pipe tables). Escapes HTML first so raw content can never inject
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
    .filter((line) => line && !/^---+$/.test(line) && !/^\|[\s\-:|]+\|$/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
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

export function renderMarkdown(text: string): string {
  // Quotes matter here, not just `<`/`>`: the link replacement above interpolates its captured URL
  // straight into a double-quoted href attribute, so an unescaped `"` in the source text (e.g.
  // `[x](https://a" onmouseover=alert(1) x=")`) would close that attribute early and let whatever
  // follows land as raw, executing HTML instead of stopping at the closing `)` the regex expects.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lines = esc(text).split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^### /.test(t)) { out.push(`<h3>${mdInline(t.slice(4))}</h3>`); i++; continue; }
    if (/^## /.test(t)) { out.push(`<h2>${mdInline(t.slice(3))}</h2>`); i++; continue; }
    if (/^# /.test(t)) { out.push(`<h1>${mdInline(t.slice(2))}</h1>`); i++; continue; }
    if (/^---+$/.test(t)) { out.push("<hr/>"); i++; continue; }
    if (t.startsWith("|")) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { tbl.push(lines[i]); i++; }
      out.push(mdTable(tbl));
      continue;
    }
    if (/^[-*] /.test(t) || /^\d+\. /.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (/^[-*] /.test(l)) { items.push(`<li>${mdInline(l.slice(2))}</li>`); i++; }
        else if (/^\d+\. /.test(l)) { items.push(`<li>${mdInline(l.replace(/^\d+\. /, ""))}</li>`); i++; }
        else break;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (t === "") { out.push("<br/>"); i++; continue; }
    out.push(`<p>${mdInline(t)}</p>`);
    i++;
  }
  return out.join("");
}
