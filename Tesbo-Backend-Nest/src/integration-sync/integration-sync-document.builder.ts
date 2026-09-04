import { Injectable } from "@nestjs/common";
import { escapeHtml, truncateForColumn } from "../common/integration-text.util";
import { RemoteComment, RemoteTicket } from "./integration-sync.types";

export interface BuiltDocument {
  title: string;
  markdown: string;
  html: string;
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

/**
 * Composes the Knowledge Base document body for one ticket. Pure (no DB, no network, no clock),
 * so the exact markdown is unit-testable.
 *
 * The `## ` headings are load-bearing, not decoration: RagChunkingService splits on markdown
 * headings and records the heading breadcrumb per chunk, so this structure is what lets Zyra
 * cite "EAD-123 > Comments" rather than an anonymous slice of text.
 */
@Injectable()
export class IntegrationSyncDocumentBuilder {
  buildMirror(ticket: RemoteTicket, comments: RemoteComment[], decisionSummary: string | null): BuiltDocument {
    // knowledge_documents.title is VARCHAR(512) — a summary comfortably under the ticket table's
    // own (much larger) limit can still overflow this smaller, more widely shared column.
    const title = truncateForColumn(`${ticket.issueKey}: ${ticket.summary}`.trim(), 512);
    const sections: string[] = [`# ${title}`];

    const meta: string[] = [];
    const addMeta = (label: string, value: string) => {
      if (value.trim()) meta.push(`- **${label}:** ${value.trim()}`);
    };
    addMeta("Status", ticket.status);
    addMeta("Type", ticket.issueType);
    addMeta("Priority", ticket.priority);
    addMeta("Assignee", ticket.assignee);
    addMeta("Reporter", ticket.reporter);
    addMeta("Labels", ticket.labels);
    addMeta("Created", formatDate(ticket.createdAt));
    addMeta("Updated", formatDate(ticket.updatedAt));
    addMeta("Link", ticket.url);
    // Status/priority/assignee live in the body (not just the ticket table) so a Zyra question
    // like "which high-priority checkout bugs are still open" can match on them semantically.
    if (meta.length) sections.push(meta.join("\n"));

    sections.push("## Description");
    sections.push(ticket.description.trim() || "_No description provided in the source ticket._");

    if (decisionSummary && decisionSummary.trim()) {
      sections.push("## Decisions from discussion");
      sections.push(decisionSummary.trim());
    }

    sections.push("## Comments");
    if (!comments.length) {
      sections.push("_No comments on the source ticket._");
    } else {
      for (const comment of comments) {
        const stamp = formatDate(comment.createdAt);
        sections.push(`### ${comment.author}${stamp ? ` — ${stamp}` : ""}`);
        sections.push(comment.body.trim());
      }
    }

    const markdown = sections.join("\n\n");
    return { title, markdown, html: this.toHtml(sections) };
  }

  // Minimal markdown -> HTML for the KB viewer: headings, bullet lists, and paragraphs. The
  // editor stores rich content as content_json; synced documents are read-only so plain
  // semantic HTML is all the viewer needs.
  private toHtml(sections: string[]): string {
    const out: string[] = [];
    let listBuffer: string[] = [];

    const flushList = () => {
      if (!listBuffer.length) return;
      out.push(`<ul>${listBuffer.map((item) => `<li>${this.inline(item)}</li>`).join("")}</ul>`);
      listBuffer = [];
    };

    for (const section of sections) {
      for (const line of section.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          flushList();
          const level = heading[1].length;
          out.push(`<h${level}>${this.inline(heading[2])}</h${level}>`);
          continue;
        }
        if (trimmed.startsWith("- ")) {
          listBuffer.push(trimmed.slice(2));
          continue;
        }
        flushList();
        out.push(`<p>${this.inline(trimmed)}</p>`);
      }
    }
    flushList();
    return out.join("");
  }

  // Escape first, then re-introduce the two markdown inlines we emit ourselves (**bold** and
  // [text](url)) — so ticket content can never inject markup, but our own formatting survives.
  private inline(text: string): string {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
}
