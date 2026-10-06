// Pure Notion -> text rendering for the sync pipeline: page properties, rich text and the block tree.
// No network and no DB, so every output is unit-testable (notion-client.spec.ts).

type Row = Record<string, any>;

function asArray(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

export function notionRichTextToPlain(rich: unknown): string {
  return asArray(rich).map((item) => String(item?.plain_text ?? item?.text?.content ?? "")).join("");
}

/** Rich text with the annotations the document viewer understands: bold, italic, code, links. */
export function notionRichTextToMarkdown(rich: unknown): string {
  return asArray(rich)
    .map((item) => {
      let text = String(item?.plain_text ?? item?.text?.content ?? "");
      if (!text) return "";
      const a = (item?.annotations || {}) as Row;
      if (a.code) text = `\`${text}\``;
      if (a.bold) text = `**${text}**`;
      if (a.italic) text = `_${text}_`;
      if (a.strikethrough) text = `~~${text}~~`;
      const href = item?.href || item?.text?.link?.url;
      return href ? `[${text}](${href})` : text;
    })
    .join("");
}

function dateText(value: Row | null | undefined): string {
  if (!value?.start) return "";
  return value.end ? `${value.start} to ${value.end}` : String(value.start);
}

function userName(user: Row | null | undefined): string {
  return String(user?.name || user?.person?.email || "").trim();
}

/** One property value as text. Unknown or empty property types render as "" (and are dropped by the caller). */
export function renderNotionProperty(prop: Row | null | undefined): string {
  if (!prop || typeof prop !== "object") return "";
  switch (prop.type) {
    case "title":
    case "rich_text":
      return notionRichTextToPlain(prop[prop.type]).trim();
    case "number":
      return typeof prop.number === "number" ? String(prop.number) : "";
    case "select":
    case "status":
      return String(prop[prop.type]?.name || "");
    case "multi_select":
      return asArray(prop.multi_select).map((o) => String(o.name || "")).filter(Boolean).join(", ");
    case "date":
      return dateText(prop.date);
    case "people":
      return asArray(prop.people).map(userName).filter(Boolean).join(", ");
    case "created_by":
    case "last_edited_by":
      return userName(prop[prop.type]);
    case "checkbox":
      return prop.checkbox === true ? "Yes" : "No";
    case "url":
    case "email":
    case "phone_number":
      return String(prop[prop.type] || "");
    case "created_time":
    case "last_edited_time":
      return String(prop[prop.type] || "");
    case "files":
      return asArray(prop.files).map((f) => String(f.name || "")).filter(Boolean).join(", ");
    case "relation": {
      const count = asArray(prop.relation).length;
      return count ? `${count} linked page${count === 1 ? "" : "s"}` : "";
    }
    case "unique_id": {
      const id = prop.unique_id as Row | undefined;
      return id?.number == null ? "" : `${id.prefix ? `${id.prefix}-` : ""}${id.number}`;
    }
    case "formula": {
      const f = (prop.formula || {}) as Row;
      if (f.type === "date") return dateText(f.date);
      if (f.type === "boolean") return f.boolean ? "Yes" : "No";
      const v = f[f.type];
      return v == null ? "" : String(v);
    }
    case "rollup": {
      const r = (prop.rollup || {}) as Row;
      if (r.type === "number") return r.number == null ? "" : String(r.number);
      if (r.type === "date") return dateText(r.date);
      if (r.type === "array") return asArray(r.array).map(renderNotionProperty).filter(Boolean).join(", ");
      return "";
    }
    default:
      return "";
  }
}

/** The page title: the one property whose type is "title". Notion allows exactly one per database. */
export function notionPageTitle(properties: Row | null | undefined): string {
  for (const prop of Object.values(properties || {})) {
    if ((prop as Row)?.type === "title") {
      const title = renderNotionProperty(prop as Row);
      if (title) return title;
    }
  }
  return "Untitled";
}

/** Every non-title property that has a value, keyed by its name, in the database's own order. */
export function renderNotionProperties(properties: Row | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, prop] of Object.entries(properties || {})) {
    if ((prop as Row)?.type === "title") continue;
    const text = renderNotionProperty(prop as Row);
    if (text) out[name] = text;
  }
  return out;
}

/** The "Properties" block placed above a page body in the mirrored document. */
export function notionPropertiesMarkdown(properties: Record<string, string> | null | undefined): string {
  const lines = Object.entries(properties || {}).map(([name, value]) => `- **${name}:** ${value.replace(/\s*\n\s*/g, " ")}`);
  return lines.join("\n");
}

export interface NotionTicketFields {
  issueType: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string;
}

/**
 * Maps a page's properties onto the ticket columns every provider shares. Notion databases have no
 * fixed schema, so this goes by the conventional names (case-insensitive) and falls back to property
 * type where a type is unambiguous (a database has at most one `status` property).
 */
export function notionTicketFields(properties: Row | null | undefined): NotionTicketFields {
  const entries = Object.entries(properties || {}) as Array<[string, Row]>;
  const named = (names: string[], types: string[]): string => {
    for (const name of names) {
      const hit = entries.find(([key, prop]) => key.trim().toLowerCase() === name && types.includes(prop?.type));
      const text = hit ? renderNotionProperty(hit[1]) : "";
      if (text) return text;
    }
    return "";
  };
  const byType = (type: string): string => {
    const hit = entries.find(([, prop]) => prop?.type === type);
    return hit ? renderNotionProperty(hit[1]) : "";
  };
  return {
    issueType: named(["type", "category", "kind"], ["select", "status", "multi_select"]) || "Page",
    status: byType("status") || named(["status", "state", "stage"], ["select"]),
    priority: named(["priority", "severity"], ["select", "status", "number"]),
    assignee: named(["assignee", "assignees", "assigned to", "owner"], ["people"]),
    reporter: byType("created_by"),
    labels: named(["tags", "labels", "tag", "label"], ["multi_select"])
  };
}

// ── Block tree -> markdown ──

const UNSUPPORTED = (type: string) => `_[Notion ${type.replace(/_/g, " ")} is not shown here]_`;

function blockText(block: Row): string {
  return notionRichTextToMarkdown(block[block.type]?.rich_text);
}

function indentLines(text: string, prefix: string): string[] {
  return text.split("\n").map((line) => (line ? `${prefix}${line}` : line));
}

function renderTable(block: Row): string[] {
  const rows = asArray(block.children).filter((child) => child.type === "table_row");
  if (!rows.length) return [];
  const cells = (row: Row) => asArray(row.table_row?.cells).map((cell) => notionRichTextToMarkdown(cell).replace(/\|/g, "\\|").replace(/\n/g, " "));
  const width = Math.max(...rows.map((row) => cells(row).length), 1);
  const line = (values: string[]) => `| ${Array.from({ length: width }, (_, i) => values[i] ?? "").join(" | ")} |`;
  const out = [line(cells(rows[0])), line(Array.from({ length: width }, () => "---"))];
  for (const row of rows.slice(1)) out.push(line(cells(row)));
  return out;
}

/**
 * Renders a block tree (blocks carrying their already-fetched `children`) as markdown lines, one
 * entry per output line. Headings are shifted down two levels so a page's "# Heading" nests under
 * the document's own "## Description" instead of competing with it. Never throws: a block type this
 * does not know becomes a visible placeholder line.
 */
export function renderNotionBlocks(blocks: Row[]): string {
  const render = (siblings: Row[]): string[] => {
    const out: string[] = [];
    let numbered = 0;
    for (const block of siblings) {
      const type = String(block?.type || "unknown");
      numbered = type === "numbered_list_item" ? numbered + 1 : 0;
      const childLines = (): string[] => render(asArray(block.children));
      const cappedNote = block.__capped ? [UNSUPPORTED("nested content")] : [];
      switch (type) {
        case "paragraph": {
          out.push(blockText(block), ...childLines(), ...cappedNote, "");
          break;
        }
        case "heading_1":
        case "heading_2":
        case "heading_3": {
          const level = Number(type.slice(-1)) + 2;
          out.push(`${"#".repeat(level)} ${blockText(block)}`, ...childLines(), "");
          break;
        }
        case "bulleted_list_item":
        case "numbered_list_item":
        case "to_do": {
          const marker =
            type === "bulleted_list_item" ? "-" : type === "numbered_list_item" ? `${numbered}.` : `- [${block.to_do?.checked ? "x" : " "}]`;
          out.push(`${marker} ${blockText(block)}`, ...childLines().flatMap((l) => indentLines(l, "  ")), ...cappedNote);
          break;
        }
        case "quote":
          out.push(...indentLines(blockText(block), "> "), ...childLines().flatMap((l) => indentLines(l, "> ")), "");
          break;
        case "callout":
          out.push(...indentLines(blockText(block), "> "), ...childLines().flatMap((l) => indentLines(l, "> ")), "");
          break;
        case "toggle":
          out.push(`**${blockText(block)}**`, ...childLines(), ...cappedNote, "");
          break;
        case "code": {
          const lang = String(block.code?.language || "");
          out.push(`\`\`\`${lang === "plain text" ? "" : lang}`, notionRichTextToPlain(block.code?.rich_text), "```", "");
          break;
        }
        case "divider":
          out.push("---", "");
          break;
        case "equation":
          out.push(`$$${String(block.equation?.expression || "")}$$`);
          break;
        case "table":
          out.push(...renderTable(block), "");
          break;
        case "table_row":
          break; // rendered by its parent table
        case "column_list":
        case "column":
        case "synced_block":
          out.push(...childLines(), ...cappedNote);
          break;
        case "child_page":
          out.push(`[Child page: ${String(block.child_page?.title || "Untitled")}]`);
          break;
        case "child_database":
          out.push(`[Child database: ${String(block.child_database?.title || "Untitled")}]`);
          break;
        case "bookmark":
        case "embed":
        case "link_preview": {
          const url = String(block[type]?.url || "");
          out.push(url ? `[${url}](${url})` : UNSUPPORTED(type));
          break;
        }
        case "image":
        case "file":
        case "pdf":
        case "video":
        case "audio": {
          // Hosted file URLs expire within the hour, so only the caption is kept.
          const caption = notionRichTextToPlain(block[type]?.caption).trim();
          out.push(`[${type[0].toUpperCase()}${type.slice(1)}${caption ? `: ${caption}` : ""}]`);
          break;
        }
        default:
          out.push(UNSUPPORTED(type));
      }
    }
    return out;
  };
  return render(blocks)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Markdown -> Notion rich_text (for posting comments) ──

type NotionTextSegment = {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold: true };
};

/** Splits plain text into segments of at most `limit` characters (Notion's per-segment cap). */
function chunkText(text: string, limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

/**
 * Converts the small markdown the ticket comment uses (**bold** and [label](url)) into Notion
 * rich_text, keeping every segment within Notion's 2000-character limit. A comment may carry at most
 * 100 rich_text elements; a body that would exceed that (a very large save) drops formatting and
 * goes out as plain 2000-character chunks, which always fit.
 */
export function markdownToNotionRichText(markdown: string, limit = 2000, maxElements = 100): NotionTextSegment[] {
  const segments: NotionTextSegment[] = [];
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const pushPlain = (content: string, extra: Partial<NotionTextSegment> & { link?: string } = {}) => {
    for (const chunk of chunkText(content, limit)) {
      segments.push({
        type: "text",
        text: extra.link ? { content: chunk, link: { url: extra.link } } : { content: chunk },
        ...(extra.annotations ? { annotations: extra.annotations } : {})
      });
    }
  };
  let last = 0;
  for (const match of markdown.matchAll(pattern)) {
    if (match.index! > last) pushPlain(markdown.slice(last, match.index));
    if (match[1] !== undefined) pushPlain(match[1], { annotations: { bold: true } });
    else pushPlain(match[2], { link: match[3] });
    last = match.index! + match[0].length;
  }
  if (last < markdown.length) pushPlain(markdown.slice(last));
  if (segments.length <= maxElements) return segments;
  return chunkText(markdown, limit).map((content) => ({ type: "text" as const, text: { content } }));
}
