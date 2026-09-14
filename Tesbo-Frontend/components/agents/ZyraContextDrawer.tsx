"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconExternalLink, IconDownload } from "@tabler/icons-react";
import {
  getTestCase,
  getBug,
  getKnowledgeDocument,
  getKnowledgeFile,
  getKnowledgeFileDownloadUrl,
  listJiraTickets,
  type ZyraSourceRef,
  type BugItem,
  type KnowledgeDocument,
  type KnowledgeFile,
  type JiraTicket,
} from "@/lib/api";
import { Drawer, PriorityBadge, SeverityBadge, StatusChip, type Priority } from "@/components/ui";

type Step = { stepNumber?: number; action?: string; expectedResult?: string };

function parseSteps(raw: unknown): Step[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Step[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "testcase"; data: Record<string, unknown> }
  | { kind: "bug"; data: BugItem }
  | { kind: "knowledge_document"; data: KnowledgeDocument }
  | { kind: "knowledge_file"; data: KnowledgeFile }
  | { kind: "jira_ticket"; data: JiraTicket };

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{children}</h4>;
}

function TestcaseDetail({ data }: { data: Record<string, unknown> }) {
  const steps = parseSteps(data.steps);
  const priority = String(data.priority || "P2");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["P0", "P1", "P2", "P3"] as Priority[]).includes(priority as Priority) && <PriorityBadge priority={priority as Priority} />}
        <StatusChip tone="brand">{String(data.status || "Draft")}</StatusChip>
        {data.externalId ? <span className="font-mono text-[11px] text-[var(--muted)]">{String(data.externalId)}</span> : null}
      </div>
      {!!data.description && (
        <div>
          <SectionLabel>Description</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.description)}</p>
        </div>
      )}
      {!!data.preconditions && (
        <div>
          <SectionLabel>Preconditions</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.preconditions)}</p>
        </div>
      )}
      {!!data.testData && (
        <div>
          <SectionLabel>Test data</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.testData)}</p>
        </div>
      )}
      {steps.length > 0 && (
        <div>
          <SectionLabel>Steps</SectionLabel>
          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
                <p className="text-sm font-medium text-[var(--foreground)]">{step.stepNumber ?? i + 1}. {step.action}</p>
                {step.expectedResult && <p className="mt-0.5 text-xs text-[var(--muted)]">Expected: {step.expectedResult}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      {!!data.postconditions && (
        <div>
          <SectionLabel>Postconditions</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.postconditions)}</p>
        </div>
      )}
    </div>
  );
}

function BugDetail({ data }: { data: BugItem }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={data.severity} />
        {data.priority && <PriorityBadge priority={data.priority} />}
        <StatusChip tone="brand">{data.status}</StatusChip>
        <span className="font-mono text-[11px] text-[var(--muted)]">{data.externalId}</span>
      </div>
      {!!data.description && (
        <div>
          <SectionLabel>Description</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{data.description}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        {data.reporterName && <span>Reported by: <span className="text-[var(--foreground)]">{data.reporterName}</span></span>}
        {data.assigneeName && <span>Assigned to: <span className="text-[var(--foreground)]">{data.assigneeName}</span></span>}
        <span>Created: <span className="text-[var(--foreground)]">{new Date(data.createdAt).toLocaleDateString()}</span></span>
      </div>
      {data.externalUrl && (
        <a href={data.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline">
          Open in tracker <IconExternalLink size={13} stroke={1.9} />
        </a>
      )}
    </div>
  );
}

function KnowledgeDocumentDetail({ data, projectId }: { data: KnowledgeDocument; projectId: string }) {
  return (
    <div className="space-y-4">
      <StatusChip tone="brand">{data.status}</StatusChip>
      {data.contentText ? (
        <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{data.contentText}</p>
      ) : (
        <p className="text-sm text-[var(--muted)]">This document has no text content yet.</p>
      )}
      <Link
        href={`/projects/${projectId}/knowledge-base/documents/${data.id}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline"
      >
        Open full page <IconExternalLink size={13} stroke={1.9} />
      </Link>
    </div>
  );
}

function KnowledgeFileDetail({ data, projectId }: { data: KnowledgeFile; projectId: string }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        <span>Type: <span className="text-[var(--foreground)]">{data.mimeType || "Unknown"}</span></span>
        {data.fileSize != null && <span>Size: <span className="text-[var(--foreground)]">{Math.round(data.fileSize / 1024)} KB</span></span>}
        <span>Uploaded: <span className="text-[var(--foreground)]">{new Date(data.createdAt).toLocaleDateString()}</span></span>
      </div>
      <a
        href={getKnowledgeFileDownloadUrl(projectId, data.id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline"
      >
        Download <IconDownload size={13} stroke={1.9} />
      </a>
    </div>
  );
}

function JiraTicketDetail({ data }: { data: JiraTicket }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone="brand">{data.status}</StatusChip>
        {data.priority && <span className="text-xs text-[var(--muted)]">{data.priority}</span>}
        <span className="font-mono text-[11px] text-[var(--muted)]">{data.jiraIssueKey}</span>
      </div>
      {!!data.description && (
        <div>
          <SectionLabel>Description</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{data.description}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        {data.reporter && <span>Reporter: <span className="text-[var(--foreground)]">{data.reporter}</span></span>}
        {data.assignee && <span>Assignee: <span className="text-[var(--foreground)]">{data.assignee}</span></span>}
        {data.labels && <span>Labels: <span className="text-[var(--foreground)]">{data.labels}</span></span>}
      </div>
      {data.jiraUrl && (
        <a href={data.jiraUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline">
          Open in Jira <IconExternalLink size={13} stroke={1.9} />
        </a>
      )}
    </div>
  );
}

// The exact NotFoundException body each single-item GET throws (legacy.service.ts: kbDocument,
// kbFile, getTestCaseForUser, getBugForUser) when the row is gone or soft-deleted. A citation is a
// historical record of what informed a past reply, kept even after its source is later edited or
// deleted (see zyraSourceRefIndex's own comment) — so this is an expected, not-broken outcome, and
// deserves a plain explanation instead of the bare backend string surfacing as if something failed.
const NOT_FOUND_MESSAGE: Partial<Record<ZyraSourceRef["type"], string>> = {
  testcase: "Test case not found",
  bug: "Bug not found",
  knowledge_document: "Document not found",
  knowledge_file: "File not found",
};

const STALE_SOURCE_MESSAGE: Record<ZyraSourceRef["type"], string> = {
  testcase: "This test case is no longer available — it looks like it was deleted after Zyra cited it here.",
  bug: "This bug is no longer available — it looks like it was deleted after Zyra cited it here.",
  knowledge_document:
    "This knowledge base document is no longer available — it may have been deleted, or its source (e.g. a connected Jira sync) may have been disconnected, since Zyra cited it here.",
  knowledge_file: "This knowledge base file is no longer available — it looks like it was deleted after Zyra cited it here.",
  jira_ticket: "This Jira ticket could not be found — it may have been unlinked or removed from the sync since Zyra cited it here.",
};

const TYPE_TITLE: Record<ZyraSourceRef["type"], string> = {
  knowledge_document: "Knowledge base document",
  knowledge_file: "Knowledge base file",
  jira_ticket: "Jira ticket",
  testcase: "Test case",
  bug: "Bug",
};

/**
 * Read-only detail view for one citation from ZyraCitationsList — fetched fresh by the ref's real
 * id/type (never the model's claim, never hardcoded), so what opens is always the actual current
 * record. Deliberately does not reuse the testcases/bugs pages' heavy edit panels: those are
 * create/edit forms with tabs and save handlers, the wrong shape for "look at what Zyra cited."
 */
export function ZyraContextDrawer({
  projectId,
  reference,
  onClose,
}: {
  projectId: string;
  reference: ZyraSourceRef;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    async function load() {
      try {
        if (reference.type === "testcase") {
          const data = await getTestCase(projectId, reference.id);
          if (!cancelled) setState({ kind: "testcase", data });
        } else if (reference.type === "bug") {
          const data = await getBug(reference.id);
          if (!cancelled) setState({ kind: "bug", data });
        } else if (reference.type === "knowledge_document") {
          const data = await getKnowledgeDocument(projectId, reference.id);
          if (!cancelled) setState({ kind: "knowledge_document", data });
        } else if (reference.type === "knowledge_file") {
          const data = await getKnowledgeFile(projectId, reference.id);
          if (!cancelled) setState({ kind: "knowledge_file", data });
        } else {
          // No single-ticket-by-id route exists; the list endpoint's `search` is a substring
          // ILIKE, so "PRO-1" would also match "PRO-10" — exact-match the real key client-side
          // rather than trust the first/only row a substring search happens to return.
          const { list } = await listJiraTickets(projectId, { search: reference.id, limit: 10 });
          const match = list.find((t) => t.jiraIssueKey === reference.id);
          if (!match) throw new Error(STALE_SOURCE_MESSAGE.jira_ticket);
          if (!cancelled) setState({ kind: "jira_ticket", data: match });
        }
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : "Failed to load this item.";
        const message = rawMessage === NOT_FOUND_MESSAGE[reference.type] ? STALE_SOURCE_MESSAGE[reference.type] : rawMessage;
        if (!cancelled) setState({ kind: "error", message });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, reference.type, reference.id]);

  const titleText =
    state.kind === "testcase" ? String(state.data.title || reference.title) :
    state.kind === "bug" ? state.data.title :
    state.kind === "knowledge_document" ? state.data.title :
    state.kind === "knowledge_file" ? state.data.fileName :
    state.kind === "jira_ticket" ? state.data.summary :
    reference.title;

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{TYPE_TITLE[reference.type]}</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-[var(--foreground)]">{titleText}</p>
        </div>
      }
    >
      <div className="p-5">
        {state.kind === "loading" && <p className="text-sm text-[var(--muted)]">Loading…</p>}
        {state.kind === "error" && <p className="text-sm text-[var(--error-foreground)]">{state.message}</p>}
        {state.kind === "testcase" && <TestcaseDetail data={state.data} />}
        {state.kind === "bug" && <BugDetail data={state.data} />}
        {state.kind === "knowledge_document" && <KnowledgeDocumentDetail data={state.data} projectId={projectId} />}
        {state.kind === "knowledge_file" && <KnowledgeFileDetail data={state.data} projectId={projectId} />}
        {state.kind === "jira_ticket" && <JiraTicketDetail data={state.data} />}
      </div>
    </Drawer>
  );
}
