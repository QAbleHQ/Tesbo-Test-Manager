// Text helpers shared by LegacyService and the integration-sync module. They live here rather
// than in legacy.service.ts because LegacyService imports IntegrationSyncService (to enqueue a
// run), so anything the sync processors also need would otherwise close an import cycle.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Flattens Atlassian Document Format (the shape Jira returns for descriptions and comment
// bodies) down to plain text. ADF is a recursive {type, content[], text} tree; we keep block
// nodes (paragraphs, list items, headings, ...) on separate lines while concatenating the
// inline runs *within* a block (text split across bold/italic/link marks, mentions, etc.)
// directly, so a mid-sentence mark doesn't inject a spurious line break.
const ADF_INLINE_CONTAINER_TYPES = new Set(["paragraph", "heading", "codeBlock"]);

function adfNodeToText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfNodeToText).filter(Boolean).join("\n");
  if (typeof node !== "object") return String(node);

  const record = node as Record<string, any>;
  if (record.type === "hardBreak") return "\n";
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    const separator = ADF_INLINE_CONTAINER_TYPES.has(record.type) ? "" : "\n";
    return record.content.map(adfNodeToText).filter(Boolean).join(separator);
  }
  return "";
}

export function jiraDescriptionToText(value: unknown): string {
  return adfNodeToText(value).trim();
}
