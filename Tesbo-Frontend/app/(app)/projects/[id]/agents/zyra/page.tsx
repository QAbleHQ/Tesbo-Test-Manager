"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconClipboardCheck, IconCopy, IconPencil, IconPlus, IconSettings, IconSparkles, IconTrash } from "@tabler/icons-react";
import {
  continueZyraChatMessage,
  createZyraChatSession,
  deleteZyraChatSession,
  getZyraAgent,
  getZyraChatSession,
  listZyraChatSessions,
  openZyraTurnProgress,
  renameZyraChatSession,
  sendZyraChatMessage,
  stopZyraChatPlan,
  resumeZyraChatPlan,
  ZYRA_MESSAGE_TIMED_OUT,
  ZYRA_MESSAGE_RESUMING,
  ZYRA_RESUME_ATTEMPT_CAP,
  type ZyraAgentState,
  type ZyraChatMessage,
  type ZyraChatSession,
  type ZyraChatTestcaseRow,
  type ZyraTurnProgressEvent,
} from "@/lib/api";
import {
  Button,
  ConfirmModal,
  CopyButton,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Modal,
  PageLoader,
  StatusChip,
  Textarea,
  PriorityBadge,
  type Priority,
} from "@/components/ui";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { Breadcrumbs } from "@/components/workflows";
import { ZyraChatReviewPanel } from "@/components/agents/ZyraChatReviewPanel";
import { ZyraCitationsList } from "@/components/agents/ZyraCitations";
import { toTsv } from "@/lib/tsv";
import { renderMarkdown } from "@/lib/markdown";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";

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
function TestcaseTable({ rows, projectId }: { rows: ZyraChatTestcaseRow[]; projectId: string }) {
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
                <td className="max-w-[220px] px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <span className={`text-[11px] font-semibold capitalize ${actionColor(row.action)}`}>
                      {row.action || "suggested"}
                    </span>
                    <span className="text-[10px] text-[var(--muted)]">AI · Zyra chat</span>
                    <ZyraCitationsList refs={row.sourceRefs} projectId={projectId} />
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
  backlogSteps,
  finishedBacklog,
  onContinue,
}: {
  message: ZyraChatMessage;
  projectId: string;
  // The live progress backlog for THIS message's in-flight resume, if any is known. Empty
  // whenever this message isn't currently resuming, or (a reload mid-resume, no client-side
  // turnId survives that) no step data was ever available for it.
  backlogSteps?: ZyraBacklogStep[];
  // The finished log for a message that already completed, kept for the rest of this page
  // session (see messageBacklogs in the parent component). Undefined for a message sent before
  // this feature existed, or one whose progress stream never fired a single stage.
  finishedBacklog?: ZyraFinishedBacklog;
  // Only ever invoked from the Continue affordance below, which only renders for a timed-out turn —
  // the happy path (a message that answered normally) never touches this prop at all.
  onContinue: (messageId: string, opts?: { narrow?: boolean }) => Promise<void>;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  // Guards only the click-to-ack round trip (fast — the backend responds before the actual resume
  // finishes) against a double-click; the potentially-minutes-long wait itself is shown by
  // ResumingBubble below, driven by message.status === ZYRA_MESSAGE_RESUMING from the server, not
  // by local state — so a second tab watching the same message sees the identical experience.
  const [clicking, setClicking] = useState(false);
  const { text, testcases, reasoning } = isUser ? { text: message.content, testcases: [], reasoning: null } : resolveContent(message);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleContinueClick(opts?: { narrow?: boolean }) {
    if (clicking) return;
    setClicking(true);
    try {
      await onContinue(message.id, opts);
    } finally {
      setClicking(false);
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

  // A resume is actually running server-side — no reply content to show yet (the message row still
  // carries the OLD "I didn't hear back in time" text until the resume lands), so this replaces the
  // normal bubble entirely rather than sitting alongside stale content and a now-hidden button.
  if (message.status === ZYRA_MESSAGE_RESUMING) {
    return <ZyraBacklog steps={backlogSteps || []} />;
  }

  const metaLabel = summarizeTestcaseActions(testcases);
  // Proposed rows aren't in the repository yet — they get the review panel (select/edit/discard/
  // save) instead of the plain read-only table, and don't count toward "View test cases" below.
  const proposedRows = testcases.filter((row) => typeof row.action === "string" && row.action.startsWith("proposed-"));
  const appliedRows = testcases.filter((row) => !(typeof row.action === "string" && row.action.startsWith("proposed-")));
  // Defense-in-depth, independent of the backend guard: a reply that routed as a mutation but carries
  // no rows and no review panel to show is a sign something upstream failed silently — surface that
  // instead of leaving the bubble looking like an ordinary, uneventful answer. Never fires for a
  // healthy turn: a genuine create/update/archive always carries either applied rows or a
  // reviewRequestId with proposed rows.
  //
  // Found by review: "mixed" — reachable whenever the router's intent is create/update/archive and
  // the model itself reports actionType "mixed" (normalizeZyraChatDecision trusts that value as-is)
  // — was missing from this list, leaving exactly the same phantom-success shape unguarded for a
  // mixed-operation turn (e.g. "create + archive in one request") whose operations end up filtered
  // to nothing. "suite" is deliberately still excluded: create_suite/move_to_suite write
  // immediately, so a suite-only turn legitimately has no testcases row to show.
  const missingStructuredData =
    !isUser &&
    ["create", "update", "archive", "mixed"].includes(message.actionType || "") &&
    testcases.length === 0 &&
    !message.reviewRequestId;

  return (
    <article className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ZyraMark size={24} />
        <span className="text-xs font-semibold text-[var(--foreground)]">Zyra</span>
        {metaLabel && <span className="text-[11px] text-[var(--muted)]">{metaLabel}</span>}
      </div>

      {finishedBacklog && finishedBacklog.steps.length > 0 && (
        <details className="w-full max-w-[720px]">
          <summary className="cursor-pointer select-none border-l-2 border-emerald-500 pl-2 font-mono text-[11px] text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300">
            [DONE] {zyraFormatDuration(finishedBacklog.durationMs)} · {finishedBacklog.steps.length} steps
            {zyraFinishedOutcome(finishedBacklog.steps) ? ` · ${zyraFinishedOutcome(finishedBacklog.steps)}` : ""}
          </summary>
          <div className="mt-1.5 flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
            {finishedBacklog.steps.map((step) => <ZyraBacklogRow key={step.stage} step={step} now={step.activatedAt} />)}
          </div>
        </details>
      )}

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

      <TestcaseTable rows={appliedRows} projectId={projectId} />
      {message.reviewRequestId && proposedRows.length > 0 && (
        <ZyraChatReviewPanel projectId={projectId} reviewRequestId={message.reviewRequestId} initialRows={proposedRows} />
      )}
      {missingStructuredData && (
        <p className="mt-1 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          ⚠️ Zyra didn&apos;t return structured data for this reply — nothing above should be treated as saved or staged. Try asking again.
        </p>
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
        {message.status === ZYRA_MESSAGE_TIMED_OUT && message.resumeAttempt < ZYRA_RESUME_ATTEMPT_CAP && (
          <Button type="button" size="sm" variant="ai" onClick={() => void handleContinueClick()} disabled={clicking}>
            Continue
          </Button>
        )}
        <time className="ml-auto font-mono text-[10px] text-[var(--muted)]">{formatTime(message.createdAt)}</time>
      </div>

      {/* This turn has failed to resume at its original size repeatedly — offering the identical
          Continue again would just repeat the same multi-minute wait for the same result. A
          narrowed retry (same size the existing generation-failure retry already uses) is offered
          instead, with an explicit, deliberate escape hatch back to the original size rather than a
          hard dead end. */}
      {message.status === ZYRA_MESSAGE_TIMED_OUT && message.resumeAttempt >= ZYRA_RESUME_ATTEMPT_CAP && (
        <div className="flex flex-col items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          <span>
            This has timed out {message.resumeAttempt + 1} times in a row. The batch may be too large for the provider to finish in time.
          </span>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" variant="ai" onClick={() => void handleContinueClick({ narrow: true })} disabled={clicking}>
              Continue with a smaller batch (5 cases)
            </Button>
            <button
              type="button"
              onClick={() => void handleContinueClick()}
              disabled={clicking}
              className="text-[11px] font-medium text-amber-700 underline decoration-dotted hover:text-amber-800 disabled:opacity-50 dark:text-amber-400 dark:hover:text-amber-300"
            >
              Try the original size again anyway
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ─── ZyraBacklog ──────────────────────────────────────────────────────────────
// Live, step-by-step narration of one turn (a normal send or a Continue resume both drive the
// same component, keyed by turnId, see submitMessage/handleContinue/watchZyraTurnProgress). Each
// step's `meta` is the accurate, capability-gated data the backend actually gathered/did (see
// legacy.service.ts's onStage call sites); this component only formats it.
//
// Styled as a test-run log, not a chat assistant's checklist: a QA engineer already reads CI
// output daily, so bracketed status tags and a commit-graph rail read as native rather than as
// one more reskin of the icon-badge pattern every AI chat product uses.
type ZyraBacklogStep = {
  stage: string;
  status: "active" | "done";
  meta?: Record<string, unknown>;
  // Client-observed, stamped once when this step object is created (i.e. the moment it became
  // the active step) — used for the active step's own counter and, for the first context:* step,
  // the "# gathering context" group's timestamp. Never recalculated after creation.
  activatedAt: number;
};

/** The finished log kept for the rest of this page session, keyed by the real message id it produced. */
type ZyraFinishedBacklog = { steps: ZyraBacklogStep[]; durationMs: number };

const ZYRA_STAGE_LABELS: Record<string, string> = {
  received: "Received your request",
  "context:knowledge": "Knowledge Base",
  "context:jira": "Jira",
  "context:testcases": "Existing Test Cases",
  "context:bugs": "Bugs",
  routing: "Deciding what to do",
  generating: "Generating your test cases",
  staging: "Staging results",
  finalizing: "Finalizing",
};

function zyraFormatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/**
 * 8 once this turn is known to route to `create` (a step named `generating` has actually fired),
 * 7 otherwise. Deliberately NOT hardcoded to 8: an answer/list/archive turn never reaches
 * `generating` at all, and claiming an 8th step that will never arrive would stall the fill rule
 * short instead of ever reaching full.
 */
function zyraTotalKnownSteps(steps: ZyraBacklogStep[]): number {
  return steps.some((s) => s.stage === "generating") ? 8 : 7;
}

/** A short "what happened" summary for a step's row, never inventing anything not in `meta`. */
function zyraBacklogSummary(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  if (meta.skipped) return `skipped: ${String(meta.reason || "disabled")}`;
  if (Array.isArray(meta.items)) {
    const count = typeof meta.count === "number" ? meta.count : meta.items.length;
    return count === 0 ? "none found" : `${count} found`;
  }
  if (meta.operationCounts && typeof meta.operationCounts === "object") {
    const parts = Object.entries(meta.operationCounts as Record<string, number>).map(([type, count]) => `${count} ${type}`);
    return parts.length ? parts.join(", ") : "nothing to stage";
  }
  if (typeof meta.savedCount === "number" || typeof meta.proposedCount === "number") {
    const saved = Number(meta.savedCount || 0);
    const proposed = Number(meta.proposedCount || 0);
    const parts = [saved ? `${saved} saved` : "", proposed ? `${proposed} proposed for review` : ""].filter(Boolean);
    return parts.length ? parts.join(", ") : "nothing changed";
  }
  if (typeof meta.requestedCount === "number") {
    return `${meta.requestedCount} requested${meta.suiteName ? ` into "${String(meta.suiteName)}"` : ""}`;
  }
  if (typeof meta.totalContextItems === "number") return `${meta.totalContextItems} context items`;
  return "";
}

/** The finished disclosure's one-line outcome, read off whatever `finalizing` actually reported. */
function zyraFinishedOutcome(steps: ZyraBacklogStep[]): string {
  const finalStep = steps.find((s) => s.stage === "finalizing");
  return finalStep ? zyraBacklogSummary(finalStep.meta) : "";
}

/** `[RUN]` / `[OK]` / `[SKIP]` / `[--]`, matched to the row's marker fill below. */
function zyraStatusTag(step: ZyraBacklogStep): { text: string; className: string } {
  if (step.status === "active") return { text: "[RUN]", className: "text-[var(--brand-primary)]" };
  if (step.meta?.skipped) return { text: "[SKIP]", className: "text-amber-500" };
  if (Array.isArray(step.meta?.items) && (step.meta!.items as unknown[]).length === 0) return { text: "[--]", className: "text-[var(--muted-2)]" };
  return { text: "[OK]", className: "text-emerald-500" };
}

function zyraMarkerClass(step: ZyraBacklogStep): string {
  if (step.status === "active") return "bg-[var(--brand-primary)] animate-pulse";
  if (step.meta?.skipped) return "bg-amber-500";
  if (Array.isArray(step.meta?.items) && (step.meta!.items as unknown[]).length === 0) return "border border-[var(--muted-2)] bg-transparent";
  return "bg-emerald-500";
}

/** The item-row tag: a real key when the source has one, `DOC` for a knowledge item (no key of its own), nothing for a bug (its `id` is a UUID, never shown). */
function zyraItemTag(stage: string, item: Record<string, unknown>): string {
  if (item.externalId) return String(item.externalId);
  if (item.key) return String(item.key);
  if (stage === "context:knowledge") return "DOC";
  return "";
}

/** One row, expandable when its step carries named items. Item titles/summaries are user-authored (a doc title, a Jira summary) and rendered as plain text, never markdown/HTML. */
function ZyraBacklogRow({ step, now }: { step: ZyraBacklogStep; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const items = Array.isArray(step.meta?.items) ? (step.meta!.items as Array<Record<string, unknown>>) : null;
  const canExpand = Boolean(items && items.length > 0);
  const summary = zyraBacklogSummary(step.meta);
  const tag = zyraStatusTag(step);
  const label = ZYRA_STAGE_LABELS[step.stage] || step.stage;
  const ownElapsed = step.status === "active" ? zyraFormatDuration(now - step.activatedAt) : null;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={`flex w-full items-baseline gap-1.5 text-left text-[11.5px] ${canExpand ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={step.status === "active" ? "font-semibold text-[var(--foreground)]" : "text-[var(--muted)]"}>{label}</span>
        <span className={`font-mono text-[10px] ${tag.className}`}>{tag.text}</span>
        {summary && <span className="truncate text-[var(--muted-2)]">{summary}</span>}
        {ownElapsed && <span className="font-mono text-[10px] tabular-nums text-[var(--muted-2)]">{ownElapsed}</span>}
        {canExpand && <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--muted-2)]">{expanded ? "-" : "+"}</span>}
      </button>
      {expanded && items && (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-0.5 text-[11px] text-[var(--muted)]">
          {items.slice(0, 10).map((item, i) => {
            const itemTag = zyraItemTag(step.stage, item);
            const title = String(item.title || item.summary || "");
            return (
              <li key={i} className="flex items-baseline gap-1.5 overflow-hidden">
                {itemTag && <span className="shrink-0 font-mono text-[10px] text-[var(--brand-primary)]">{itemTag}</span>}
                <span className="truncate">{title}</span>
              </li>
            );
          })}
          {items.length > 10 && <li className="italic text-[var(--muted-2)]">+{items.length - 10} more</li>}
        </ul>
      )}
    </div>
  );
}

function ZyraBacklog({ steps }: { steps: ZyraBacklogStep[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Anchor for the zero-steps fallback below, since there's no step to read activatedAt off yet.
  // Client-observed only, same honesty caveat as everywhere else in this component: it reads as
  // "this page has been watching for Ns," true even when the underlying work started earlier.
  const [mountedAt] = useState(() => Date.now());

  if (steps.length === 0) {
    // No step data yet (a brand-new send whose first SSE event hasn't landed) or none ever
    // arrived (a reload mid-resume lost the client-side turnId, or the progress feature is
    // disabled). Honest either way: work is happening, no further detail is known.
    return (
      <div className="flex items-start gap-2">
        <ZyraMark size={24} />
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 font-mono text-[11px] tabular-nums text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse bg-[var(--brand-primary)]" />
          zyra is working on this · {zyraFormatDuration(now - mountedAt)} elapsed
        </div>
      </div>
    );
  }

  const totalSteps = zyraTotalKnownSteps(steps);
  const turnElapsed = zyraFormatDuration(now - steps[0].activatedAt);
  let contextHeaderShown = false;

  return (
    <div className="flex items-start gap-2">
      <ZyraMark size={24} />
      <div className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5">
        <div className="mb-1.5 font-mono text-[11px] tabular-nums text-[var(--muted)]">
          zyra · turn {steps.length}/{totalSteps} · {turnElapsed}
        </div>
        <div className="mb-2 h-px w-full overflow-hidden bg-[var(--border)]">
          <div
            className="h-full bg-gradient-to-r from-[var(--brand-primary)] to-[#4F46E5] transition-all duration-500"
            style={{ width: `${Math.min(100, Math.round((steps.length / totalSteps) * 100))}%` }}
          />
        </div>
        <div className="flex flex-col">
          {steps.map((step, i) => {
            const isFirstContext = step.stage.startsWith("context:") && !contextHeaderShown;
            if (isFirstContext) contextHeaderShown = true;
            return (
              <div key={step.stage} className="flex gap-2.5">
                <div className="flex w-2.5 flex-none flex-col items-center">
                  <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 ${zyraMarkerClass(step)}`} />
                  {i < steps.length - 1 && <span className="w-px flex-1 bg-[var(--border)]" />}
                </div>
                <div className="min-w-0 flex-1 pb-1.5">
                  {isFirstContext && (
                    <div className="mb-1 font-mono text-[10px] text-[var(--muted-2)]">
                      # gathering context · {zyraFormatDuration(step.activatedAt - steps[0].activatedAt)}
                    </div>
                  )}
                  <ZyraBacklogRow step={step} now={now} />
                </div>
              </div>
            );
          })}
        </div>
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

// ─── RenameSessionModal ───────────────────────────────────────────────────────
function RenameSessionModal({
  open,
  initialTitle,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  initialTitle: string;
  saving: boolean;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [titleError, setTitleError] = useState("");
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setTitleError("");
    }
  }, [open, initialTitle]);

  async function handleSaveClick() {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("Conversation name is required");
      return;
    }
    try {
      await onSave(trimmed);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : "Failed to rename conversation.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Rename conversation">
      <div className="space-y-4">
        <Field>
          <FieldLabel>Conversation name</FieldLabel>
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError("");
            }}
            autoFocus
            maxLength={240}
          />
          {titleError && <FieldError>{titleError}</FieldError>}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" disabled={!title.trim() || saving} onClick={handleSaveClick}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </Modal>
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
  const { currentUser } = useAppData();
  const { project } = useProjectData();
  const projectName = String(project.name || "");

  // Take over the shared TopBar with this page's breadcrumb + actions (portaled below),
  // matching the full-bleed IDE-workspace pattern used by the Test Cases / Plan Details screens.
  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [agent, setAgent] = useState<ZyraAgentState | null>(null);
  const [sessions, setSessions] = useState<ZyraChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ZyraChatSession | null>(null);
  // Live progress backlog, keyed by turnId (not messageId: a normal send has no message id at
  // all until the turn completes). Purely a display enhancement, never authoritative: ZyraBacklog
  // renders straight off message.status either way, this only adds step-by-step detail on top.
  // Moved into messageBacklogs (below) the moment a turn settles, so this map only ever holds
  // in-flight turns.
  const [turnBacklogs, setTurnBacklogs] = useState<Record<string, ZyraBacklogStep[]>>({});
  // The finished log for a message that already completed, keyed by the message's real id, kept
  // for the rest of this page session (not database-persisted — a reload loses it, same as the
  // rest of this feature). Powers the "[DONE]" disclosure on a normal completed reply.
  const [messageBacklogs, setMessageBacklogs] = useState<Record<string, ZyraFinishedBacklog>>({});
  // messageId -> turnId, for a Continue resume's MessageBubble to find its own entry in
  // turnBacklogs above. Never set for a normal send (there's no message id yet to key by; that
  // path reads turnBacklogs[sendingTurnId] directly instead).
  const [resumeTurnIds, setResumeTurnIds] = useState<Record<string, string>>({});
  // The turnId for the currently-sending normal message in THIS session, if any — cleared once
  // submitMessage settles either way.
  const [sendingTurnId, setSendingTurnId] = useState<string | null>(null);
  // Every EventSource opened by watchZyraTurnProgress, so it can be closed on a session switch or
  // unmount rather than lingering until its own terminal event arrives (see the cleanup effect
  // below) — the backend resume/send itself is already detached from any HTTP connection, so
  // closing this early only stops a now-irrelevant live narration stream, never the actual work.
  const openEventSourcesRef = useRef<EventSource[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  // Keyed by session id, not a single flag, so an in-flight send in one conversation never shows
  // as "thinking" or disables the input in a different conversation the user has switched to.
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(new Set());
  const [stoppingPlan, setStoppingPlan] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ZyraChatSession | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ZyraChatSession | null>(null);
  const [deleting, setDeleting] = useState(false);
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
  // Derived, not stored: reflects only whether the CURRENTLY VIEWED session has a send in flight.
  const sending = activeSession ? pendingSessionIds.has(activeSession.id) : false;
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

  async function handleRenameSave(title: string) {
    if (!renameTarget) return;
    const targetId = renameTarget.id;
    setRenaming(true);
    try {
      const updated = await renameZyraChatSession(projectId, targetId, title);
      setSessions((prev) => prev.map((s) => (s.id === targetId ? { ...s, title: updated.title, updatedAt: updated.updatedAt } : s)));
      setActiveSession((prev) => (prev && prev.id === targetId ? { ...prev, title: updated.title, updatedAt: updated.updatedAt } : prev));
      setRenameTarget(null);
    } finally {
      setRenaming(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setDeleting(true);
    try {
      await deleteZyraChatSession(projectId, targetId);
      const remaining = sessions.filter((s) => s.id !== targetId);
      setSessions(remaining);
      setDeleteTarget(null);
      if (activeSession?.id === targetId) {
        // Same fallback loadData() uses when there is no session to show: fall back to the most
        // recently used remaining conversation, or start a fresh one if none are left.
        const nextVisible = remaining.find((s) => s.hasMessages);
        if (nextVisible) await openSession(nextVisible.id);
        else await createSession();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete conversation.");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  const loadData = useCallback(async () => {
    try {
      const [agentData, sessionData] = await Promise.all([
        getZyraAgent(projectId),
        refreshSessions(),
      ]);
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
    if (!currentUser) router.replace("/login");
    else void loadData();
  }, [loadData, router, currentUser]);

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

  // Durable fallback for a Continue resume running in the background (see continueZyraChatMessage)
  // — SSE (openZyraTurnProgress) is a pure enhancement that can legitimately say nothing (feature
  // flag off, a reload lost the turnId, a network blip); this poll is what actually detects
  // completion regardless, the same "watch a detached background job" shape the task-board page
  // uses (5s, paused while the tab is hidden, in-flight-guarded so overlapping ticks never stack).
  const hasResumingMessage = (activeSession?.messages || []).some((m) => m.status === ZYRA_MESSAGE_RESUMING);
  const resumePollInFlightRef = useRef(false);
  useEffect(() => {
    if (!hasResumingMessage || !activeSessionId) return;
    const interval = setInterval(() => {
      if (resumePollInFlightRef.current || document.hidden) return;
      resumePollInFlightRef.current = true;
      getZyraChatSession(projectId, activeSessionId)
        .then((fresh) => setActiveSession((prev) => (prev && prev.id === activeSessionId ? fresh : prev)))
        .catch(() => undefined)
        .finally(() => { resumePollInFlightRef.current = false; });
    }, 5000);
    return () => clearInterval(interval);
  }, [hasResumingMessage, activeSessionId, projectId]);

  // Closes every open progress stream on a session switch or on unmount — the backend resume/send
  // itself is unaffected (already detached from any HTTP connection by the time this component
  // could react to it), this only stops a now-irrelevant live narration stream from lingering.
  useEffect(() => {
    return () => {
      openEventSourcesRef.current.forEach((source) => source.close());
      openEventSourcesRef.current = [];
    };
  }, [activeSessionId]);

  async function submitMessage(text: string) {
    if (!activeSession || !text.trim() || pendingSessionIds.has(activeSession.id)) return;
    const sessionId = activeSession.id;
    const trimmed = text.trim();
    setInput("");
    setPendingSessionIds((prev) => new Set(prev).add(sessionId));
    setError(null);
    const optimistic: ZyraChatMessage = {
      id: `local-${Date.now()}`,
      sessionId,
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
      resumeAttempt: 0,
    };
    // Guarded by session id, not just truthiness: if the user has switched to a different
    // conversation by the time this resolves, that conversation's view must not be touched.
    setActiveSession((prev) => prev && prev.id === sessionId ? { ...prev, messages: [...(prev.messages || []), optimistic] } : prev);
    const turnId = crypto.randomUUID();
    setSendingTurnId(turnId);
    // sendZyraChatMessage below starts its fetch() synchronously (an async function's body runs up
    // to its first await immediately) — capturing the promise before opening the SSE stream, rather
    // than awaiting it first, is what fires the POST before the GET without blocking on the whole
    // turn: opening this stream only after the full reply arrived would mean it could never show
    // anything live, defeating the point.
    const sendPromise = sendZyraChatMessage(projectId, sessionId, trimmed, { turnId });
    watchZyraTurnProgress(sessionId, turnId);
    try {
      const result = await sendPromise;
      setActiveSession((prev) => prev && prev.id === sessionId ? result.session : prev);
      void refreshSessions();
      // Belt and suspenders: the SSE "complete" event already does this (see watchZyraTurnProgress),
      // but SSE was never meant to be authoritative here (feature flag off, a dropped connection) —
      // this fires from the awaited response itself, independent of whether that event ever arrived.
      finishTurn(turnId, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Zyra could not answer.";
      setError(msg);
      setActiveSession((prev) => prev && prev.id === sessionId ? { ...prev, messages: (prev.messages || []).filter((m) => m.id !== optimistic.id) } : prev);
    } finally {
      setPendingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setSendingTurnId(null);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }

  // Resumes a turn the provider never answered in time (message.status === ZYRA_MESSAGE_TIMED_OUT).
  // Deliberately does not touch `sending`/`sendingTurnId` — those drive the normal send/response
  // cycle, and this is a distinct, per-message action (MessageBubble tracks its own click-guard
  // state) so a Continue click can never look like or interfere with an ordinary in-flight send.
  //
  // Fire-and-forget on the backend: this call itself returns fast (`accepted` tells us whether OUR
  // click is the one driving the resume), and the actual multi-minute work is watched afterward via
  // the resume-poller above plus, when accepted, a best-effort SSE progress stream — never awaited
  // here, since the whole point is to never hold this promise open for minutes again.
  async function handleContinue(messageId: string, opts?: { narrow?: boolean }) {
    if (!activeSession) return;
    setError(null);
    const sessionId = activeSession.id;
    const turnId = crypto.randomUUID();
    setResumeTurnIds((prev) => ({ ...prev, [messageId]: turnId }));
    try {
      const result = await continueZyraChatMessage(projectId, sessionId, messageId, { turnId, narrow: opts?.narrow });
      setActiveSession((prev) => (prev && prev.id === sessionId ? result.session : prev));
      void refreshSessions();
      if (result.accepted) watchZyraTurnProgress(sessionId, turnId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume that turn. Try again.");
    }
  }

  // Moves a settled turn's step list out of turnBacklogs (in-flight only) into messageBacklogs
  // (kept for the message it produced, for the rest of this page session). `resultPayload` is
  // whatever shape the "complete" SSE event or the awaited POST response carries — both are
  // `{ message: { id }, session }`, so this works from either call site. A no-op if the turn has
  // no steps recorded (progress streaming was off or nothing ever arrived) or was already moved
  // by the other call site, so it's always safe to call from both.
  function finishTurn(turnId: string, resultPayload: unknown) {
    setTurnBacklogs((prev) => {
      const existing = prev[turnId];
      if (!existing || existing.length === 0) return prev;
      const doneSteps = existing.map((s) => ({ ...s, status: "done" as const }));
      const finishedMessageId = (resultPayload as { message?: { id?: string } } | null | undefined)?.message?.id;
      if (finishedMessageId) {
        const durationMs = Date.now() - doneSteps[0].activatedAt;
        setMessageBacklogs((mb) => (finishedMessageId in mb ? mb : { ...mb, [finishedMessageId]: { steps: doneSteps, durationMs } }));
      }
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
  }

  // Opens the SSE stream for one turn (a normal send or a Continue resume, both share this) and
  // accumulates its stage narration into turnBacklogs, keyed by turnId. Order matters for a normal
  // send (see zyra-progress.service.ts's own doc comment: the POST must fire before this GET opens,
  // or the progress entry may not exist yet) — submitMessage/handleContinue both already guarantee
  // that. Closes itself on any terminal event so the browser's default EventSource auto-reconnect
  // never keeps hammering a turn that has already finished, and is also tracked in
  // openEventSourcesRef so a session switch or unmount can close it early too.
  function watchZyraTurnProgress(sessionId: string, turnId: string) {
    const source = openZyraTurnProgress(projectId, sessionId, turnId);
    openEventSourcesRef.current.push(source);
    const stop = () => {
      source.close();
      openEventSourcesRef.current = openEventSourcesRef.current.filter((s) => s !== source);
    };
    source.onmessage = (evt) => {
      let event: ZyraTurnProgressEvent;
      try {
        event = JSON.parse(evt.data) as ZyraTurnProgressEvent;
      } catch {
        return;
      }
      if (event.kind === "stage") {
        setTurnBacklogs((prev) => {
          const existing = (prev[turnId] || []).map((s) => ({ ...s, status: "done" as const }));
          return { ...prev, [turnId]: [...existing, { stage: event.stage, status: "active" as const, meta: event.meta, activatedAt: Date.now() }] };
        });
        return;
      }
      // complete / error / unknown are all terminal for this stream. "complete" carries the real
      // message id, which is what lets finishTurn attach the finished log to that message; error/
      // unknown carry nothing usable, so the in-flight entry is just dropped with no [DONE] chip
      // for that turn (matches the "no backlog data" fallback already covered elsewhere).
      finishTurn(turnId, event.kind === "complete" ? event.payload : undefined);
      stop();
    };
    source.onerror = stop;
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
            <Breadcrumbs
              items={[
                { label: "Projects", href: "/projects" },
                { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
                { label: "Zyra" },
              ]}
            />,
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
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => void openSession(session.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void openSession(session.id);
                        }
                      }}
                      className={`group flex w-full cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        isActive
                          ? "border-[var(--brand-border)] bg-[var(--surface-secondary)]"
                          : "border-transparent hover:bg-[var(--surface-secondary)]"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <span className={`block truncate text-[12px] font-medium ${isActive ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                          {session.title}
                        </span>
                        <span className="mt-0.5 block font-mono text-[11px] text-[var(--muted-soft)]">
                          {formatTime(session.updatedAt)}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          title="Rename conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenameTarget(session);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--accent-light)]"
                        >
                          <IconPencil size={12} stroke={1.75} />
                        </button>
                        <button
                          type="button"
                          title="Delete conversation"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(session);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--error-foreground)]"
                        >
                          <IconTrash size={12} stroke={1.75} />
                        </button>
                      </div>
                    </div>
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

                {messages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    projectId={projectId}
                    backlogSteps={resumeTurnIds[msg.id] ? turnBacklogs[resumeTurnIds[msg.id]] : undefined}
                    finishedBacklog={messageBacklogs[msg.id]}
                    onContinue={handleContinue}
                  />
                ))}
                {sending && <ZyraBacklog steps={(sendingTurnId && turnBacklogs[sendingTurnId]) || []} />}
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

      <RenameSessionModal
        open={!!renameTarget}
        initialTitle={renameTarget?.title || ""}
        saving={renaming}
        onClose={() => setRenameTarget(null)}
        onSave={handleRenameSave}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete conversation"
        message={`Delete "${deleteTarget?.title || "this conversation"}"? This permanently removes its message history and cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        loading={deleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

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
