"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  authMe,
  createZyraChatSession,
  getZyraAgent,
  getZyraChatSession,
  listZyraChatSessions,
  sendZyraChatMessage,
  type ZyraAgentState,
  type ZyraChatMessage,
  type ZyraChatSession,
  type ZyraChatTestcaseRow,
} from "@/lib/api";
import { Button, Textarea } from "@/components/ui";
import { PageHeader } from "@/components/workflows";

// ─── Quick actions shown on empty chat ───────────────────────────────────────
const QUICK_ACTIONS = [
  { label: "Generate smoke tests", prompt: "Generate smoke test cases covering the most critical user flows in this project." },
  { label: "Find coverage gaps", prompt: "Analyze existing test cases and identify the most important areas of missing coverage." },
  { label: "Add negative scenarios", prompt: "Add negative test cases for the main features, focusing on invalid inputs and error states." },
  { label: "Improve expected results", prompt: "Review existing test cases and rewrite any weak or vague expected results to be more specific." },
  { label: "Regression test cases", prompt: "Generate a regression test suite that covers the core product functionality." },
  { label: "Review this module", prompt: "Review all test cases in this project and identify duplicates, outdated cases, and weak coverage." },
  { label: "Edge cases", prompt: "Create edge case test scenarios covering boundary values, empty states, and unexpected inputs." },
  { label: "API test cases", prompt: "Generate API test cases for the main endpoints covering success, error, and boundary scenarios." },
];

// ─── Markdown renderer ────────────────────────────────────────────────────────
function mdInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function mdTable(lines: string[]): string {
  const isSep = (l: string) => /^\|[\s\-:|]+\|$/.test(l.trim());
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const data = lines.filter(l => !isSep(l));
  if (!data.length) return "";
  const [hdr, ...rows] = data;
  const thead = `<thead><tr>${cells(hdr).map(h => `<th>${mdInline(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(r => `<tr>${cells(r).map(c => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="zyra-md-table-wrap"><table class="zyra-md-table">${thead}${tbody}</table></div>`;
}

function renderMarkdown(text: string): string {
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

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatTime(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function stepsPreview(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((step) => {
      if (typeof step === "string") return step;
      return [step.step, step.action, step.expected].filter(Boolean).join(" → ");
    }).filter(Boolean).slice(0, 3).join(" | ");
  }
  if (typeof value !== "string") return String(value);
  try { return stepsPreview(JSON.parse(value)); } catch { return value; }
}

// ─── TestcaseTable ────────────────────────────────────────────────────────────
function TestcaseTable({ rows }: { rows: ZyraChatTestcaseRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[var(--border)] text-sm">
          <thead className="bg-[var(--surface-secondary)]">
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              <th className="px-4 py-2.5">Test case</th>
              <th className="px-3 py-2.5">Priority</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Coverage</th>
              <th className="px-3 py-2.5">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {rows.map((row, i) => (
              <tr key={`${row.id || row.externalId || row.title}-${i}`} className="align-top hover:bg-[var(--surface-secondary)] transition-colors">
                <td className="max-w-[280px] px-4 py-3">
                  <div className="font-medium text-[var(--foreground)]">
                    {row.externalId && <span className="mr-1 text-[var(--muted)]">{row.externalId}</span>}
                    {row.title}
                  </div>
                  {row.type && <div className="mt-0.5 text-[11px] text-[var(--muted)]">{row.type}</div>}
                </td>
                <td className="px-3 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${row.priority === "P1" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : row.priority === "P3" ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"}`}>
                    {row.priority || "P2"}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-[var(--muted)]">{row.status || "Draft"}</td>
                <td className="max-w-[360px] px-3 py-3 text-xs text-[var(--muted)]">
                  <div className="line-clamp-2">{row.expectedSummary || row.preconditions || "—"}</div>
                  {!!row.stepsJson && <div className="mt-1 line-clamp-1 text-[10px] opacity-70">{stepsPreview(row.stepsJson)}</div>}
                </td>
                <td className="px-3 py-3">
                  <span className={`text-xs font-medium capitalize ${row.action === "archived" ? "text-red-500" : row.action === "updated" ? "text-blue-500" : row.action === "created" ? "text-green-600 dark:text-green-400" : "text-[var(--muted)]"}`}>
                    {row.action || "suggested"}
                  </span>
                  {row.reason && <div className="mt-0.5 text-[10px] text-[var(--muted)] line-clamp-2">{row.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── resolveContent ───────────────────────────────────────────────────────────
// message.content may be a raw JSON blob from the AI when the backend fallback
// stored the full structured response as-is. Extract reply + testcases from it.
function resolveContent(message: ZyraChatMessage): { text: string; testcases: ZyraChatTestcaseRow[]; reasoning: string | null } {
  let text = message.content ?? "";
  let testcases: ZyraChatTestcaseRow[] = message.testcases ?? [];
  let reasoning = message.reasoningSummary ?? null;

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (typeof parsed.reply === "string" && parsed.reply) text = parsed.reply;
        if (!reasoning && typeof parsed.reasoningSummary === "string" && parsed.reasoningSummary) {
          reasoning = parsed.reasoningSummary;
        }
        if (Array.isArray(parsed.testcases) && parsed.testcases.length > 0 && testcases.length === 0) {
          testcases = parsed.testcases as ZyraChatTestcaseRow[];
        }
      }
    } catch {
      // Not JSON — use content as-is
    }
  }

  return { text, testcases, reasoning };
}

// ─── MessageBubble ────────────────────────────────────────────────────────────
function MessageBubble({ message }: { message: ZyraChatMessage }) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const { text, testcases, reasoning } = isUser ? { text: message.content, testcases: [], reasoning: null } : resolveContent(message);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <article className={`group flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`mt-1 h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${isUser ? "bg-[var(--brand-primary)] text-white" : "bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]"}`}>
        {isUser ? "You" : "Z"}
      </div>

      <div className={`flex-1 ${isUser ? "items-end" : "items-start"} flex flex-col gap-1 min-w-0`}>
        {!isUser && reasoning && (
          <details className="max-w-[88%] w-full mb-1">
            <summary className="cursor-pointer text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] select-none">
              Zyra reasoning
            </summary>
            <div className="mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted)]">
              {reasoning}
            </div>
          </details>
        )}

        <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${isUser ? "rounded-tr-sm bg-[var(--brand-primary)] text-white" : "rounded-tl-sm border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"}`}>
          {isUser ? (
            <div className="whitespace-pre-wrap">{text}</div>
          ) : (
            <div
              className="zyra-prose"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
            />
          )}

          {!isUser && <TestcaseTable rows={testcases} />}
        </div>

        <div className={`flex items-center gap-2 px-1 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
          <time className="text-[10px] text-[var(--muted)]">{formatTime(message.createdAt)}</time>
          {!isUser && (
            <button
              type="button"
              onClick={handleCopy}
              className="text-[10px] text-[var(--muted)] opacity-0 group-hover:opacity-100 transition-opacity hover:text-[var(--foreground)]"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// ─── ThinkingBubble ───────────────────────────────────────────────────────────
function ThinkingBubble() {
  return (
    <div className="flex gap-3">
      <div className="mt-1 h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]">Z</div>
      <div className="rounded-2xl rounded-tl-sm border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

// ─── NoKeyBanner ─────────────────────────────────────────────────────────────
function NoKeyBanner({ projectId }: { projectId: string }) {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-center">
      <div className="text-2xl mb-2">⚡</div>
      <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">AI provider not connected</h3>
      <p className="mt-2 text-xs text-amber-700/80 dark:text-amber-400/80">
        Zyra needs an Anthropic or OpenAI key allocated to this project before it can respond.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <Link href="/settings/integrations" className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700">
          Set up AI key
        </Link>
        <Link href={`/projects/${projectId}/agents/zyra/settings`} className="text-xs text-amber-700/70 hover:underline dark:text-amber-400/70">
          Check Zyra settings
        </Link>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ZyraChatPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [agent, setAgent] = useState<ZyraAgentState | null>(null);
  const [sessions, setSessions] = useState<ZyraChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ZyraChatSession | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messages = useMemo(() => activeSession?.messages || [], [activeSession]);

  const refreshSessions = useCallback(async () => {
    const data = await listZyraChatSessions(projectId);
    setSessions(data.list);
    return data.list;
  }, [projectId]);

  const openSession = useCallback(async (sessionId: string) => {
    const session = await getZyraChatSession(projectId, sessionId);
    setActiveSession(session);
  }, [projectId]);

  const createSession = useCallback(async () => {
    const session = await createZyraChatSession(projectId);
    setSessions((prev) => [session, ...prev]);
    setActiveSession(session);
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [projectId]);

  const loadData = useCallback(async () => {
    try {
      const [agentData, sessionData] = await Promise.all([getZyraAgent(projectId), refreshSessions()]);
      setAgent(agentData);
      if (sessionData[0]) await openSession(sessionData[0].id);
      else await createSession();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Zyra chat.");
    } finally {
      setLoading(false);
    }
  }, [createSession, openSession, projectId, refreshSessions]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  async function submitMessage(text: string) {
    if (!activeSession || !text.trim() || sending) return;
    const trimmed = text.trim();
    setInput("");
    setSending(true);
    setError(null);
    const optimistic: ZyraChatMessage = {
      id: `local-${Date.now()}`,
      sessionId: activeSession.id,
      projectId,
      userId: null,
      role: "user",
      content: trimmed,
      reasoningSummary: null,
      actionType: null,
      status: "sent",
      testcases: [],
      activity: [],
      createdAt: new Date().toISOString(),
    };
    setActiveSession((prev) => prev ? { ...prev, messages: [...(prev.messages || []), optimistic] } : prev);
    try {
      const result = await sendZyraChatMessage(projectId, activeSession.id, trimmed);
      setActiveSession(result.session);
      void refreshSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Zyra could not answer.";
      setError(msg);
      setActiveSession((prev) => prev ? { ...prev, messages: (prev.messages || []).filter((m) => m.id !== optimistic.id) } : prev);
    } finally {
      setSending(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submitMessage(input);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage(input);
    }
  }

  function onQuickAction(prompt: string) {
    setInput(prompt);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  // ─── Page header (shared between loading and loaded states) ─────────────────
  const pageHeader = (
    <PageHeader
      title="Zyra"
      subtitle="AI test case assistant — generate, update, and manage test cases through conversation."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {agent && (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${agent.agent.active ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${agent.agent.active ? "bg-green-500" : "bg-amber-500"}`} />
              {agent.agent.active ? "AI connected" : "No AI key"}
            </span>
          )}
          <Link href={`/projects/${projectId}/agents/tasks`} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
            Task board
          </Link>
          <Link href={`/projects/${projectId}/agents/zyra/settings`} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
            Settings
          </Link>
        </div>
      }
    />
  );

  if (loading) {
    return (
      // calc subtracts tesbo-page vertical padding (2rem top + 2.75rem bottom = 4.75rem)
      <div className="flex flex-col w-full" style={{ height: "calc(100vh - 4.75rem)" }}>
        {pageHeader}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center space-y-2">
            <div className="h-8 w-8 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin mx-auto" />
            <p className="text-sm text-[var(--muted)]">Loading Zyra...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    // Full-height flex column — fills the available viewport minus tesbo-page vertical padding
    <div className="flex flex-col w-full" style={{ height: "calc(100vh - 4.75rem)" }}>
      {pageHeader}

      {/* Error banner */}
      {error && (
        <div className="mb-3 shrink-0 rounded-xl border border-[var(--error)]/40 bg-[var(--error-soft)] px-4 py-3 text-sm text-[var(--error)] flex items-start justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 text-[var(--error)]/60 hover:text-[var(--error)]">✕</button>
        </div>
      )}

      {/* Main grid — flex-1 + min-h-0 so it takes remaining height without overflowing */}
      <div className="flex-1 min-h-0 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)] pb-6">

        {/* ── Session sidebar ─────────────────────────────────────────── */}
        <aside className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          {/* Sidebar header */}
          <div className="shrink-0 flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">Conversations</p>
              <p className="text-[11px] text-[var(--muted)]">
                {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void createSession()}>+ New</Button>
          </div>

          {/* Session list — scrollable */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {sessions.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-[var(--muted)]">No conversations yet</p>
            )}
            {sessions.map((session) => {
              const isActive = activeSession?.id === session.id;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => void openSession(session.id)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors border-l-2 ${
                    isActive
                      ? "border-[var(--brand-primary)] bg-[var(--surface-secondary)]"
                      : "border-transparent hover:bg-[var(--surface-secondary)]"
                  }`}
                >
                  <span className={`block truncate text-[13px] font-medium ${isActive ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                    {session.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-[var(--muted-soft)]">
                    {formatTime(session.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ── Chat area ───────────────────────────────────────────────── */}
        <section className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] overflow-hidden min-h-0">
          {/* Chat header — fixed */}
          <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
            <p className="text-sm font-semibold text-[var(--foreground)]">{activeSession?.title || "Zyra"}</p>
            <p className="text-xs text-[var(--muted)]">
              {agent?.aiKey
                ? `${agent.aiKey.provider.toUpperCase()} · ${agent.aiKey.defaultModel || "default model"}`
                : "No AI key connected"}
            </p>
          </div>

          {/* Messages — scrollable */}
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
            {!messages.length && (
              <div className="flex h-full flex-col items-center justify-center gap-6 py-8">
                {!agent?.agent.active ? (
                  <NoKeyBanner projectId={projectId} />
                ) : (
                  <>
                    <div className="text-center max-w-md">
                      <div className="mx-auto mb-3 h-12 w-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-xl font-bold text-white">Z</div>
                      <h3 className="text-base font-semibold text-[var(--foreground)]">How can I help?</h3>
                      <p className="mt-1 text-sm text-[var(--muted)]">
                        Generate test cases, find coverage gaps, update existing tests, or review your test suite — all through conversation.
                      </p>
                    </div>
                    <div className="w-full max-w-2xl">
                      <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Quick actions</p>
                      <div className="flex flex-wrap gap-2">
                        {QUICK_ACTIONS.map((action) => (
                          <button
                            key={action.label}
                            type="button"
                            onClick={() => onQuickAction(action.prompt)}
                            className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--foreground)] transition-all hover:border-[var(--brand-primary)] hover:shadow-sm active:scale-95"
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)}
            {sending && <ThinkingBubble />}
            <div ref={endRef} />
          </div>

          {/* Input — fixed at bottom */}
          <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <form onSubmit={onSubmit}>
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={3}
                placeholder={
                  agent?.agent.active
                    ? "Ask Zyra to generate, update, or review test cases..."
                    : "Connect an AI key to start chatting with Zyra"
                }
                disabled={sending || !agent?.agent.active}
                className="resize-none"
              />
              <div className="mt-2.5 flex items-center justify-between gap-3">
                <p className="text-[11px] text-[var(--muted)]">
                  <kbd className="rounded border border-[var(--border)] bg-[var(--surface-secondary)] px-1 py-0.5 font-mono text-[10px]">Enter</kbd>{" "}send
                  {" · "}
                  <kbd className="rounded border border-[var(--border)] bg-[var(--surface-secondary)] px-1 py-0.5 font-mono text-[10px]">Shift+Enter</kbd>{" "}new line
                </p>
                <Button type="submit" size="sm" disabled={!input.trim() || sending || !agent?.agent.active}>
                  {sending ? "Thinking..." : "Send"}
                </Button>
              </div>
            </form>
          </div>
        </section>
      </div>

      {/* Inline styles for markdown prose */}
      <style>{`
        .zyra-prose strong { font-weight: 600; }
        .zyra-prose em { font-style: italic; }
        .zyra-prose .inline-code {
          font-family: ui-monospace, monospace;
          font-size: 0.8em;
          background: var(--surface-secondary);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 1px 4px;
        }
        .zyra-prose ul {
          list-style: disc;
          padding-left: 1.25rem;
          margin: 0.5rem 0;
        }
        .zyra-prose li { margin: 0.2rem 0; }
      `}</style>
    </div>
  );
}
