"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronRight, IconClipboardCheck, IconCopy, IconPlus, IconSettings, IconSparkles } from "@tabler/icons-react";
import {
  authMe,
  continueZyraChatMessage,
  createZyraChatSession,
  getProject,
  getZyraAgent,
  getZyraChatSession,
  listZyraChatSessions,
  sendZyraChatMessage,
  stopZyraChatPlan,
  resumeZyraChatPlan,
  ZYRA_MESSAGE_TIMED_OUT,
  type ZyraAgentState,
  type ZyraChatMessage,
  type ZyraChatSession,
  type ZyraChatTestcaseRow,
} from "@/lib/api";
import { Button, CopyButton, PageLoader, StatusChip, Textarea, PriorityBadge, type Priority } from "@/components/ui";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { ZyraChatReviewPanel } from "@/components/agents/ZyraChatReviewPanel";
import { toTsv } from "@/lib/tsv";
import { renderMarkdown } from "@/lib/markdown";

// ─── Zyra icon badge — gradient sparkle mark used in the header and per-message ──
function ZyraMark({ size = 24 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[7px]"
      style={{ width: size, height: size, background: "linear-gradient(135deg, #7C5FCC 0%, #4F46E5 100%)" }}
    >
      <IconSparkles size={Math.round(size * 0.58)} stroke={1.9} className="text-white" />
    </div>
  );
}

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

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatTime(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function firstStepPreview(value: unknown): string {
  if (!value) return "—";
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first) return "—";
    if (typeof first === "string") return first;
    const n = first.step ?? 1;
    const text = first.action || first.expected || "";
    return text ? `${n} → ${text}` : "—";
  }
  if (typeof value !== "string") return "—";
  try { return firstStepPreview(JSON.parse(value)); } catch { return "—"; }
}

function statusTone(status?: string) {
  if (status === "Approved") return "success" as const;
  if (status === "In Review") return "warning" as const;
  if (status === "Deprecated" || status === "Archived") return "error" as const;
  return "brand" as const;
}

function actionColor(action?: string): string {
  if (action === "archived") return "text-[var(--status-fail-text)]";
  if (action === "updated") return "text-[var(--info-foreground)]";
  if (action === "created") return "text-[var(--success-foreground)]";
  return "text-[var(--muted)]";
}

function summarizeTestcaseActions(rows: ZyraChatTestcaseRow[]): string | null {
  if (!rows.length) return null;
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.action || "suggested";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const proposedCount = (counts["proposed-create"] || 0) + (counts["proposed-update"] || 0) + (counts["proposed-archive"] || 0);
  if (proposedCount === rows.length) return `${rows.length} test case${rows.length === 1 ? "" : "s"} drafted for review`;
  const verb = counts.created ? "generated" : counts.updated ? "updated" : counts.archived ? "archived" : "suggested";
  return `${rows.length} test case${rows.length === 1 ? "" : "s"} ${verb}`;
}

// ─── TestcaseTable ────────────────────────────────────────────────────────────
function TestcaseTable({ rows }: { rows: ZyraChatTestcaseRow[] }) {
  if (!rows.length) return null;
  const tsv = toTsv(
    ["ID", "Title", "Priority", "Status", "First step", "Source"],
    rows.map((row) => [
      row.externalId || row.id || "",
      row.title,
      row.priority || "P2",
      row.status || "Draft",
      firstStepPreview(row.stepsJson),
      row.action || "suggested",
    ])
  );
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--background)] px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          {rows.length} test case{rows.length === 1 ? "" : "s"}
        </span>
        <span title="Copy these test cases as tab-separated values, ready to paste into Excel.">
          <CopyButton value={tsv} label="Copy" copiedLabel="Copied" size="sm" />
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[var(--border)] text-sm">
          <thead className="bg-[var(--background)]">
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">First step</th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {rows.map((row, i) => (
              <tr key={`${row.id || row.externalId || row.title}-${i}`} className="align-top hover:bg-[var(--surface-secondary)] transition-colors">
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[11px] text-[var(--muted)]">{row.externalId || "—"}</span>
                    <StatusChip tone="info" className="w-fit !rounded-full !px-1.5 !py-0 !text-[10px] !font-medium">
                      {row.type || "Functional"}
                    </StatusChip>
                  </div>
                </td>
                <td className="max-w-[280px] px-3 py-3 text-[12px] leading-snug text-[var(--foreground)]">{row.title}</td>
                <td className="px-3 py-3">
                  <PriorityBadge priority={(row.priority || "P2") as Priority} />
                </td>
                <td className="px-3 py-3">
                  <StatusChip tone={statusTone(row.status)} className="!px-[9px] !py-[2px] !text-[11px] !font-medium">
                    {row.status || "Draft"}
                  </StatusChip>
                </td>
                <td className="max-w-[220px] px-3 py-3 text-[11px] leading-snug text-[var(--muted)]">
                  <div className="line-clamp-2">{firstStepPreview(row.stepsJson)}</div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className={`text-[11px] font-semibold capitalize ${actionColor(row.action)}`}>
                      {row.action || "suggested"}
                    </span>
                    <span className="text-[10px] text-[var(--muted)]">AI · Zyra chat</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── JSON recovery ────────────────────────────────────────────────────────────
// Models routinely emit *almost* valid JSON — an unescaped quote or a literal newline
// inside a long markdown string. Strict JSON.parse rejects the whole envelope, which is
// how a raw blob ends up rendered in the chat. Escape control chars and any quote that
// isn't a real terminator (a terminator is followed only by whitespace and , : } ] or EOF).
function repairLooseJson(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!inString) {
      out.push(char);
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) { out.push(char); escaped = false; continue; }
    if (char === "\\") { out.push(char); escaped = true; continue; }
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (j >= text.length || next === "," || next === ":" || next === "}" || next === "]") {
        out.push(char);
        inString = false;
      } else {
        out.push('\\"');
      }
      continue;
    }
    if (char === "\n") out.push("\\n");
    else if (char === "\r") out.push("\\r");
    else if (char === "\t") out.push("\\t");
    else if (char < " ") out.push(" ");
    else out.push(char);
  }
  return out.join("");
}

// Last resort when even the repaired envelope won't parse: lift the string field out of the
// text directly, so the user reads prose instead of an envelope.
function salvageJsonField(text: string, field: string): string {
  const start = text.indexOf(`"${field}"`);
  if (start < 0) return "";
  const colon = text.indexOf(":", start + field.length + 2);
  if (colon < 0) return "";
  let cursor = colon + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  if (text[cursor] !== '"') return "";
  cursor++;
  const chars: string[] = [];
  let escaped = false;
  for (; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (escaped) {
      chars.push(char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char);
      escaped = false;
      continue;
    }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') {
      let j = cursor + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (j >= text.length || next === "," || next === "}") break;
    }
    chars.push(char);
  }
  return chars.join("").trim();
}

function parseLooseJson(text: string): Record<string, unknown> | null {
  for (const candidate of [text, repairLooseJson(text)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Renders leftover JSON as readable markdown when no reply field can be recovered — a
// structured blob is still never shown raw.
function jsonToMarkdown(value: unknown, depth = 0): string {
  const label = (key: string) =>
    key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rendered = jsonToMarkdown(item, depth + 1);
        return rendered ? `- ${rendered.replace(/\n/g, " ")}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => {
        const rendered = jsonToMarkdown(val, depth + 1);
        if (!rendered) return "";
        if (depth === 0) return `### ${label(key)}\n\n${rendered}`;
        return rendered.includes("\n") ? `**${label(key)}**\n${rendered}` : `**${label(key)}:** ${rendered}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
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
    const parsed = parseLooseJson(trimmed);
    if (parsed) {
      if (typeof parsed.reply === "string" && parsed.reply.trim()) {
        text = parsed.reply.trim();
      } else {
        // No reply field — render whatever the envelope does carry, minus the plumbing keys.
        const rest = { ...parsed };
        delete rest.action;
        delete rest.actionType;
        delete rest.operations;
        delete rest.testcases;
        delete rest.reasoningSummary;
        text = jsonToMarkdown(rest) || text;
      }
      if (!reasoning && typeof parsed.reasoningSummary === "string" && parsed.reasoningSummary) {
        reasoning = parsed.reasoningSummary;
      }
      if (Array.isArray(parsed.testcases) && parsed.testcases.length > 0 && testcases.length === 0) {
        testcases = parsed.testcases as ZyraChatTestcaseRow[];
      }
    } else {
      // Unparseable even after repair — pull the fields out textually rather than
      // falling through and rendering the raw envelope.
      const salvagedReply = salvageJsonField(trimmed, "reply");
      const salvagedReasoning = salvageJsonField(trimmed, "reasoningSummary");
      if (salvagedReply) text = salvagedReply;
      if (!reasoning && salvagedReasoning) reasoning = salvagedReasoning;
    }
  }

  return { text, testcases, reasoning };
}

// ─── MessageBubble ────────────────────────────────────────────────────────────
function MessageBubble({
  message,
  projectId,
  onContinue,
}: {
  message: ZyraChatMessage;
  projectId: string;
  // Only ever invoked from the Continue button below, which only renders for a timed-out turn — the
  // happy path (a message that answered normally) never touches this prop at all.
  onContinue: (messageId: string) => Promise<void>;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [resuming, setResuming] = useState(false);
  const { text, testcases, reasoning } = isUser ? { text: message.content, testcases: [], reasoning: null } : resolveContent(message);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleContinueClick() {
    if (resuming) return;
    setResuming(true);
    try {
      await onContinue(message.id);
    } finally {
      setResuming(false);
    }
  }

  if (isUser) {
    return (
      <article className="flex justify-end">
        <div className="flex max-w-[70%] flex-col items-end gap-1">
          <div className="rounded-[10px] border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--foreground)]">
            <div className="whitespace-pre-wrap">{text}</div>
          </div>
          <time className="px-1 font-mono text-[10px] text-[var(--muted)]">{formatTime(message.createdAt)}</time>
        </div>
      </article>
    );
  }

  const metaLabel = summarizeTestcaseActions(testcases);
  // Proposed rows aren't in the repository yet — they get the review panel (select/edit/discard/
  // save) instead of the plain read-only table, and don't count toward "View test cases" below.
  const proposedRows = testcases.filter((row) => typeof row.action === "string" && row.action.startsWith("proposed-"));
  const appliedRows = testcases.filter((row) => !(typeof row.action === "string" && row.action.startsWith("proposed-")));

  return (
    <article className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ZyraMark size={24} />
        <span className="text-xs font-semibold text-[var(--foreground)]">Zyra</span>
        {metaLabel && <span className="text-[11px] text-[var(--muted)]">{metaLabel}</span>}
      </div>

      {reasoning && (
        <details className="w-full max-w-[720px]">
          <summary className="cursor-pointer text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] select-none">
            Zyra reasoning
          </summary>
          <div className="mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted)]">
            {reasoning}
          </div>
        </details>
      )}

      <div
        className="zyra-prose max-w-[720px] text-[13px] leading-[1.7] text-[var(--muted)]"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />

      <TestcaseTable rows={appliedRows} />
      {message.reviewRequestId && proposedRows.length > 0 && (
        <ZyraChatReviewPanel projectId={projectId} reviewRequestId={message.reviewRequestId} initialRows={proposedRows} />
      )}

      <div className="flex items-center gap-2">
        {appliedRows.length > 0 && (
          <Link
            href={`/projects/${projectId}/testcases`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] font-medium text-[var(--muted)] hover:border-[var(--brand-border)] hover:text-[var(--foreground)]"
          >
            <IconClipboardCheck size={13} stroke={1.9} />
            View test cases
          </Link>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] font-medium text-[var(--muted)] hover:border-[var(--brand-border)] hover:text-[var(--foreground)]"
        >
          <IconCopy size={13} stroke={1.9} />
          {copied ? "Copied" : "Copy"}
        </button>
        {/* Only ever shown for a turn the provider never answered in time — never on a normal reply. */}
        {message.status === ZYRA_MESSAGE_TIMED_OUT && (
          <Button type="button" size="sm" variant="ai" onClick={handleContinueClick} disabled={resuming}>
            {resuming ? "Resuming…" : "Continue"}
          </Button>
        )}
        <time className="ml-auto font-mono text-[10px] text-[var(--muted)]">{formatTime(message.createdAt)}</time>
      </div>
    </article>
  );
}

// ─── ThinkingBubble ───────────────────────────────────────────────────────────
function ThinkingBubble() {
  return (
    <div className="flex items-center gap-2">
      <ZyraMark size={24} />
      <div className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

// ─── PlanProgressBubble ───────────────────────────────────────────────────────
function PlanProgressBubble({ plan }: { plan: { doneCount: number; totalCount: number } }) {
  const pct = plan.totalCount > 0 ? Math.round((plan.doneCount / plan.totalCount) * 100) : 0;
  return (
    <div className="flex items-start gap-2">
      <ZyraMark size={24} />
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-xs text-[var(--muted)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-primary)] animate-pulse" />
        Generating remaining scenarios — {plan.doneCount}/{plan.totalCount} covered ({pct}%). Review what&apos;s in so far; more will appear here shortly.
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
        <Link href="/settings?tab=ai" className="inline-flex items-center justify-center gap-1 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700">
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

  // Take over the shared TopBar with this page's breadcrumb + actions (portaled below),
  // matching the full-bleed IDE-workspace pattern used by the Test Cases / Plan Details screens.
  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [projectName, setProjectName] = useState("");
  const [agent, setAgent] = useState<ZyraAgentState | null>(null);
  const [sessions, setSessions] = useState<ZyraChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ZyraChatSession | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stoppingPlan, setStoppingPlan] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Guards the mount effect against firing loadData twice for the same mount (React 18 dev
  // double-invoke, or the effect re-running before the first pass resolves) — without it, two
  // concurrent runs can each see zero sessions and each create an empty one. Does not protect
  // against two genuinely separate mounts (e.g. two tabs) racing each other; the sidebar filter
  // below is what keeps any such leftover empty session out of view either way.
  const loadStartedRef = useRef(false);
  const creatingSessionRef = useRef(false);
  const messages = useMemo(() => activeSession?.messages || [], [activeSession]);
  // The sidebar is a history of conversations that actually happened — a session nobody ever sent
  // a message in (including one still being created) has nothing to show and shouldn't clutter or
  // duplicate in the list. `hasMessages` only comes back on list responses (see api.ts), so a
  // session missing the field reads as empty and is filtered out until refreshSessions() sees it
  // with its first message.
  const visibleSessions = useMemo(() => sessions.filter((session) => session.hasMessages), [sessions]);

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
    // A double-click on "New", or a second caller landing here while the first request is still
    // in flight, would otherwise fire two POSTs and hand back two distinct empty sessions.
    if (creatingSessionRef.current) return;
    creatingSessionRef.current = true;
    setCreatingSession(true);
    try {
      const session = await createZyraChatSession(projectId);
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
      setActiveSession(session);
      setTimeout(() => textareaRef.current?.focus(), 100);
    } finally {
      creatingSessionRef.current = false;
      setCreatingSession(false);
    }
  }, [projectId]);

  const loadData = useCallback(async () => {
    try {
      const [project, agentData, sessionData] = await Promise.all([
        getProject(projectId),
        getZyraAgent(projectId),
        refreshSessions(),
      ]);
      setProjectName(String(project.name || ""));
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
    if (loadStartedRef.current) return;
    loadStartedRef.current = true;
    authMe().then((me) => {
      if (!me) router.replace("/login");
      else void loadData();
    });
  }, [loadData, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  // While Zyra is actively working through a batched "all possible cases" plan, poll for
  // the new chat messages it posts as each batch finishes — they arrive without the user
  // sending anything, so the normal send/response cycle never picks them up on its own.
  // A paused plan isn't running, so there's nothing new to poll for until it's resumed.
  const isPlanRunning = activeSession?.activePlan?.status === "running";
  const activeSessionId = activeSession?.id;
  useEffect(() => {
    if (!isPlanRunning || !activeSessionId) return;
    const interval = setInterval(() => {
      getZyraChatSession(projectId, activeSessionId)
        .then((fresh) => {
          setActiveSession((prev) => (prev && prev.id === activeSessionId ? fresh : prev));
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(interval);
  }, [isPlanRunning, activeSessionId, projectId]);

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

  // Resumes a turn the provider never answered in time (message.status === ZYRA_MESSAGE_TIMED_OUT).
  // Deliberately does not touch `sending`/ThinkingBubble — those drive the normal send/response cycle,
  // and this is a distinct, per-message action (MessageBubble tracks its own "Resuming…" state) so a
  // Continue click can never look like or interfere with an ordinary in-flight send.
  async function handleContinue(messageId: string) {
    if (!activeSession) return;
    setError(null);
    try {
      const result = await continueZyraChatMessage(projectId, activeSession.id, messageId);
      setActiveSession(result.session);
      void refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume that turn — try again.");
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

  async function handleStopPlan() {
    if (!activeSession || stoppingPlan) return;
    setStoppingPlan(true);
    try {
      const session = await stopZyraChatPlan(projectId, activeSession.id);
      setActiveSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop Zyra.");
    } finally {
      setStoppingPlan(false);
    }
  }

  async function handleResumePlan() {
    if (!activeSession || stoppingPlan) return;
    setStoppingPlan(true);
    try {
      const session = await resumeZyraChatPlan(projectId, activeSession.id);
      setActiveSession(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume Zyra.");
    } finally {
      setStoppingPlan(false);
    }
  }

  return (
    // Full-bleed, full-height IDE-style workspace — same pattern as the Test Cases / Plan
    // Details screens. `tc-fullbleed` makes the wrapping .tesbo-page drop its centered
    // 1280px cap + padding, so this fills the whole content region below the 3.5rem TopBar.
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* This page takes over the shared TopBar: breadcrumb (start slot) + actions (end slot). */}
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--accent-light)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <span className="font-medium text-[var(--accent-light)]">Zyra</span>
            </nav>,
            topBarStartEl,
          )}
        {topBarEndEl &&
          createPortal(
            <div className="flex flex-wrap items-center gap-2">
              {agent && (
                <StatusChip tone={agent.agent.active ? "success" : "warning"} dot>
                  {agent.agent.active ? "AI connected" : "No AI key"}
                </StatusChip>
              )}
              <Link href={`/projects/${projectId}/agents/tasks`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
                <IconClipboardCheck size={15} stroke={1.9} />
                Task board
              </Link>
              <Link href={`/projects/${projectId}/agents/zyra/settings`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]">
                <IconSettings size={15} stroke={1.9} />
                Settings
              </Link>
            </div>,
            topBarEndEl,
          )}

        {/* Title + subtitle row */}
        <div className="mb-3 flex shrink-0 items-center gap-2.5 pl-4">
          <ZyraMark size={28} />
          <div>
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">Zyra</h1>
            <p className="mt-[1px] text-[13px] text-[var(--muted-soft)]">
              AI test case assistant — generate, update, and manage test cases through conversation.
            </p>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="ml-4 mb-3 shrink-0 rounded-xl border border-[var(--error)]/40 bg-[var(--error-soft)] px-4 py-3 text-sm text-[var(--error-foreground)] flex items-start justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="shrink-0 text-[var(--error-foreground)]/60 hover:text-[var(--error-foreground)]">✕</button>
          </div>
        )}

        {loading ? (
          <PageLoader
            variant="inline"
            label="Loading Zyra…"
            className="min-h-0 flex-1 rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]"
          />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">

            {/* ── Session sidebar ─────────────────────────────────────────── */}
            <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              {/* Sidebar header */}
              <div className="shrink-0 flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">Conversations</p>
                  <p className="text-[11px] text-[var(--muted)]">
                    {visibleSessions.length} {visibleSessions.length === 1 ? "session" : "sessions"}
                  </p>
                </div>
                <Button size="sm" variant="secondary" disabled={creatingSession} onClick={() => void createSession()}>
                  <IconPlus size={13} stroke={2} />
                  New
                </Button>
              </div>

              {/* Session list — scrollable */}
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {visibleSessions.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-[var(--muted)]">No conversations yet</p>
                )}
                {visibleSessions.map((session) => {
                  const isActive = activeSession?.id === session.id;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => void openSession(session.id)}
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        isActive
                          ? "border-[var(--brand-border)] bg-[var(--surface-secondary)]"
                          : "border-transparent hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      <span className={`block truncate text-[12px] font-medium ${isActive ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                        {session.title}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-[var(--muted-soft)]">
                        {formatTime(session.updatedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* ── Chat area ───────────────────────────────────────────────── */}
            <section className="flex flex-1 min-w-0 flex-col bg-[var(--surface-secondary)] overflow-hidden">
              {/* Chat header — fixed */}
              <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
                <p className="text-sm font-semibold text-[var(--foreground)]">{activeSession?.title || "Zyra"}</p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  {agent?.aiKey ? (
                    <>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{agent.aiKey.provider}</span>
                      <span className="text-[var(--border)]">·</span>
                      <span className="font-mono text-[11px] text-[var(--muted)]">{agent.aiKey.defaultModel || "default model"}</span>
                    </>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">No AI key connected</span>
                  )}
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

                {messages.map((msg) => <MessageBubble key={msg.id} message={msg} projectId={projectId} onContinue={handleContinue} />)}
                {sending && <ThinkingBubble />}
                {!sending && isPlanRunning && activeSession?.activePlan && <PlanProgressBubble plan={activeSession.activePlan} />}
                <div ref={endRef} />
              </div>

              {/* Input — fixed at bottom */}
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                {activeSession?.activePlan?.status === "paused" && (
                  <div className="mb-2.5 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <span>
                      Paused — {activeSession.activePlan.doneCount}/{activeSession.activePlan.totalCount} scenarios covered.
                    </span>
                    <Button type="button" size="sm" variant="secondary" onClick={handleResumePlan} disabled={stoppingPlan}>
                      {stoppingPlan ? "Resuming…" : "Resume"}
                    </Button>
                  </div>
                )}
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
                    <div className="flex items-center gap-2">
                      {isPlanRunning && (
                        <Button type="button" size="sm" variant="secondary" onClick={handleStopPlan} disabled={stoppingPlan}>
                          {stoppingPlan ? "Stopping…" : "Stop"}
                        </Button>
                      )}
                      <Button type="submit" size="sm" disabled={!input.trim() || sending || !agent?.agent.active}>
                        {sending ? "Thinking..." : "Send"}
                      </Button>
                    </div>
                  </div>
                </form>
              </div>
            </section>
          </div>
        )}
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
    </main>
  );
}
