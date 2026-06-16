"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { PageHeader, StandardPageLayout } from "@/components/workflows";

function formatTime(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function stepsPreview(value: unknown) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((step) => {
      if (typeof step === "string") return step;
      return [step.step, step.action, step.expected].filter(Boolean).join(" - ");
    }).filter(Boolean).join(" | ");
  }
  if (typeof value !== "string") return String(value);
  try {
    return stepsPreview(JSON.parse(value));
  } catch {
    return value;
  }
}

function TestcaseTable({ rows }: { rows: ZyraChatTestcaseRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[var(--border)] text-sm">
          <thead className="bg-[var(--surface-secondary)] text-left text-xs font-semibold uppercase text-[var(--muted)]">
            <tr>
              <th className="px-3 py-2">Case</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Coverage</th>
              <th className="px-3 py-2">Zyra action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {rows.map((row, index) => (
              <tr key={`${row.id || row.externalId || row.title}-${index}`} className="align-top">
                <td className="max-w-[320px] px-3 py-3">
                  <div className="font-semibold text-[var(--foreground)]">{row.externalId ? `${row.externalId} ` : ""}{row.title}</div>
                  {row.type && <div className="mt-1 text-xs text-[var(--muted)]">{row.type}</div>}
                </td>
                <td className="px-3 py-3 text-[var(--foreground)]">{row.priority || "P2"}</td>
                <td className="px-3 py-3 text-[var(--foreground)]">{row.status || "Draft"}</td>
                <td className="max-w-[420px] px-3 py-3 text-[var(--muted)]">
                  <div>{row.expectedSummary || row.preconditions || "Coverage details available in the testcase."}</div>
                  {row.stepsJson ? <div className="mt-1 line-clamp-2 text-xs">{stepsPreview(row.stepsJson)}</div> : null}
                </td>
                <td className="max-w-[240px] px-3 py-3">
                  <div className="font-medium capitalize text-[var(--foreground)]">{row.action || "suggested"}</div>
                  {row.reason && <div className="mt-1 text-xs text-[var(--muted)]">{row.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ZyraChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[92%] rounded-lg border px-4 py-3 ${isUser ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]"}`}>
        <div className="whitespace-pre-wrap text-sm leading-6">{message.content}</div>
        {!isUser && message.reasoningSummary && (
          <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted)]">
            <span className="font-semibold text-[var(--foreground)]">Zyra reasoning summary: </span>
            {message.reasoningSummary}
          </div>
        )}
        {!isUser && <TestcaseTable rows={message.testcases || []} />}
        <div className={`mt-2 text-[11px] ${isUser ? "text-white/75" : "text-[var(--muted)]"}`}>{formatTime(message.createdAt)}</div>
      </div>
    </article>
  );
}

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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSession || !input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);
    setError(null);
    const optimistic: ZyraChatMessage = {
      id: `local-${Date.now()}`,
      sessionId: activeSession.id,
      projectId,
      userId: null,
      role: "user",
      content: text,
      reasoningSummary: null,
      actionType: null,
      status: "sent",
      testcases: [],
      activity: [],
      createdAt: new Date().toISOString(),
    };
    setActiveSession((prev) => prev ? { ...prev, messages: [...(prev.messages || []), optimistic] } : prev);
    try {
      const result = await sendZyraChatMessage(projectId, activeSession.id, text);
      setActiveSession(result.session);
      void refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Zyra could not answer.");
      setActiveSession((prev) => prev ? { ...prev, messages: (prev.messages || []).filter((item) => item.id !== optimistic.id) } : prev);
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title="Zyra chat" />}>
        <div className="flex min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">Loading Zyra chat...</div>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Zyra chat"
          subtitle="Chat with Zyra about product behavior, coverage gaps, testcase updates, and edge-case design."
          actions={
            <div className="flex flex-wrap gap-2">
              <Link href={`/projects/${projectId}/agents/tasks`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Task board</Link>
              <Link href={`/projects/${projectId}/agents/zyra/settings`} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">Settings</Link>
            </div>
          }
        />
      }
    >
      {error && <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>}

      <div className="grid min-h-[calc(100vh-220px)] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--foreground)]">Session history</h2>
              <p className="text-xs text-[var(--muted)]">{agent?.agent.active ? "Provider active" : "Local fallback ready"}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void createSession()}>New</Button>
          </div>
          <div className="max-h-[calc(100vh-300px)] overflow-y-auto p-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => void openSession(session.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${activeSession?.id === session.id ? "bg-[var(--surface-secondary)] text-[var(--foreground)]" : "text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"}`}
              >
                <span className="block truncate font-medium">{session.title}</span>
                <span className="mt-1 block text-xs">{formatTime(session.updatedAt)}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-[560px] flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]">
          <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">{activeSession?.title || "Zyra chat"}</h2>
            <p className="text-xs text-[var(--muted)]">Ask about covered features, missing edge cases, or request testcase creation and updates.</p>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {!messages.length && (
              <div className="mx-auto max-w-2xl rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
                Try: “What checkout edge cases do we cover?”, “Create testcases for password reset rate limiting”, or “Mark TC-12 for update with accessibility checks”.
              </div>
            )}
            {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {sending && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--muted)]">
                Zyra is reviewing knowledge, repository coverage, and testcase metadata...
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={onSubmit} className="border-t border-[var(--border)] bg-[var(--surface)] p-4">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={3}
              placeholder="Ask Zyra about product coverage, missing cases, or testcase updates..."
              className="resize-none"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--muted)]">Zyra logs testcase create/update/archive actions to activity.</p>
              <Button type="submit" disabled={!input.trim() || sending}>{sending ? "Thinking..." : "Send"}</Button>
            </div>
          </form>
        </section>
      </div>
    </StandardPageLayout>
  );
}
