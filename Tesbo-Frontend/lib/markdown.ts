// Small hand-rolled Markdown → HTML renderer (headers, bold/italic, inline code, hr,
// bullet/numbered lists, pipe tables). Escapes HTML first so raw content can never inject
// markup — safe to render via dangerouslySetInnerHTML. Pair with the `zyra-prose` CSS class
// (app/globals.css) for styling, and `break-words` on the container so long unbroken tokens
// (URLs, ids) wrap instead of overflowing a fixed-width container.
function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
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

export function renderMarkdown(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
