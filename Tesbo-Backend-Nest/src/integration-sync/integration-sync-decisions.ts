import { safeFetch } from "../common/safe-fetch";
import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { DECISION_PROMPT_CHAR_BUDGET } from "./integration-sync.constants";
import { RemoteComment, RemoteTicket } from "./integration-sync.types";

export interface ChatAllocation {
  provider: string;
  api_key: string;
  default_model: string | null;
  base_url: string | null;
  auth_header_name: string | null;
  auth_scheme: string | null;
  is_active: boolean;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function chatCompletionsUrl(baseUrl?: string | null): string {
  const value = trimTrailingSlashes(String(baseUrl || "").trim());
  if (!value) return "https://api.openai.com/v1/chat/completions";
  if (value.endsWith("/chat/completions")) return value;
  if (value.endsWith("/v1")) return `${value}/chat/completions`;
  return `${value}/v1/chat/completions`;
}

function anthropicMessagesUrl(baseUrl?: string | null): string {
  const value = trimTrailingSlashes(String(baseUrl || "").trim());
  if (!value) return "https://api.anthropic.com/v1/messages";
  if (value.endsWith("/messages")) return value;
  if (value.endsWith("/v1")) return `${value}/messages`;
  return `${value}/v1/messages`;
}

const SYSTEM_PROMPT = [
  "You distil a software ticket's comment thread into the decisions it produced.",
  "Output 1-6 markdown bullets, one decision each. No preamble, no closing summary, no headings.",
  "A decision is something settled: a root cause agreed, an approach chosen, a scope cut, a rejected alternative, an owner assigned, a deferral.",
  "Attribute each bullet to the person and date when the thread makes them clear, e.g. '- Scope cut to Safari only (Sam Ortiz, 5 Mar).'",
  "Ignore status noise, greetings, and duplicate restatements.",
  "If the thread contains no actual decisions, reply with exactly: NONE"
].join(" ");

/**
 * Turns a ticket's comment thread into a short "decisions" list for the mirrored KB document.
 *
 * Resolves its own AI allocation for the same reason rag-ai-allocation.ts does — the processors
 * live outside LegacyModule and must not depend back on it. Unlike embeddings, chat completions
 * work on Anthropic too, so both providers are supported here.
 *
 * Never throws: a failure means the document is written without a decisions section, which is a
 * degraded document rather than a failed sync.
 */
@Injectable()
export class IntegrationSyncDecisions {
  private readonly logger = new Logger(IntegrationSyncDecisions.name);

  constructor(private readonly db: DatabaseService) {}

  async resolveAllocation(projectId: string): Promise<ChatAllocation | null> {
    const res = await this.db
      .query<ChatAllocation>(
        `SELECT k.provider, k.api_key, k.default_model, k.base_url, k.auth_header_name, k.auth_scheme, k.is_active
         FROM project_ai_key_allocations a
         JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
         WHERE a.project_id = $1`,
        [projectId]
      )
      .catch(() => ({ rows: [] as ChatAllocation[] }));
    const key = res.rows[0];
    if (!key || !key.is_active) return null;
    const provider = String(key.provider || "").toLowerCase();
    if (provider !== "openai" && provider !== "anthropic") return null;
    return key;
  }

  async summarize(allocation: ChatAllocation, ticket: RemoteTicket, comments: RemoteComment[]): Promise<string | null> {
    if (!comments.length) return null;

    const thread = this.buildThread(comments);
    const userPrompt = [
      `Ticket ${ticket.issueKey}: ${ticket.summary}`,
      ticket.description.trim() ? `\nDescription:\n${ticket.description.trim().slice(0, 2000)}` : "",
      `\nComment thread (${comments.length} comment${comments.length === 1 ? "" : "s"}):\n${thread}`
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const provider = String(allocation.provider || "").toLowerCase();
      const raw = provider === "anthropic" ? await this.callAnthropic(allocation, userPrompt) : await this.callOpenAI(allocation, userPrompt);
      const text = raw.trim();
      // The model is instructed to emit exactly NONE when a thread settled nothing — treat that
      // as "no decisions section" rather than writing the literal word into the document.
      if (!text || /^none\.?$/i.test(text)) return null;
      return text;
    } catch (err) {
      this.logger.warn(`Decision summary failed for ${ticket.issueKey}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Newest comments carry the settled decisions, so when a thread exceeds the prompt budget we
  // keep the tail rather than the head.
  private buildThread(comments: RemoteComment[]): string {
    const rendered = comments.map((comment) => {
      const stamp = comment.createdAt ? new Date(comment.createdAt).toISOString().slice(0, 10) : "";
      return `${comment.author}${stamp ? ` (${stamp})` : ""}: ${comment.body}`;
    });
    const kept: string[] = [];
    let used = 0;
    for (let i = rendered.length - 1; i >= 0; i -= 1) {
      const entry = rendered[i];
      if (used + entry.length > DECISION_PROMPT_CHAR_BUDGET) break;
      kept.unshift(entry);
      used += entry.length;
    }
    return (kept.length ? kept : [rendered[rendered.length - 1].slice(0, DECISION_PROMPT_CHAR_BUDGET)]).join("\n\n");
  }

  private async callOpenAI(allocation: ChatAllocation, userPrompt: string): Promise<string> {
    const authHeader = String(allocation.auth_header_name || "Authorization");
    const scheme = String(allocation.auth_scheme ?? "Bearer").trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const cleanKey = String(allocation.api_key || "").replace(/^bearer\s+/i, "").trim();
    headers[authHeader] = scheme ? `${scheme} ${cleanKey}` : cleanKey;

    const res = await safeFetch(chatCompletionsUrl(allocation.base_url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: allocation.default_model || "gpt-4o-mini",
        max_tokens: 600,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      })
    });
    if (!res.ok) throw new Error(`openai chat failed (${res.status})`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return String(data.choices?.[0]?.message?.content || "");
  }

  private async callAnthropic(allocation: ChatAllocation, userPrompt: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    const cleanKey = String(allocation.api_key || "").replace(/^bearer\s+/i, "").trim();
    const customHeader = allocation.auth_header_name && allocation.auth_header_name.toLowerCase() !== "authorization";
    if (customHeader) {
      const scheme = allocation.auth_scheme ? String(allocation.auth_scheme).trim() : "";
      headers[String(allocation.auth_header_name)] = scheme ? `${scheme} ${cleanKey}` : cleanKey;
    } else {
      headers["x-api-key"] = cleanKey;
    }

    const res = await safeFetch(anthropicMessagesUrl(allocation.base_url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: allocation.default_model || "claude-sonnet-4-6",
        max_tokens: 600,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
    if (!res.ok) throw new Error(`anthropic messages failed (${res.status})`);
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    return (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => String(block.text || ""))
      .join("\n");
  }
}
