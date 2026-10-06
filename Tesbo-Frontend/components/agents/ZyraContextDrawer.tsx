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
  getCustomFieldValues,
  getJiraTicket,
  type ZyraSourceRef,
  type BugItem,
  type KnowledgeDocument,
  type KnowledgeFile,
  type JiraTicket,
  type CustomFieldValue,
} from "@/lib/api";
import { Drawer, PriorityBadge, SeverityBadge, StatusChip, type Priority, type Severity } from "@/components/ui";
import { formatCustomFieldValueForDisplay, isCustomFieldValueEmpty } from "@/components/customFields/customFieldTypes";
import { renderMarkdown } from "@/lib/markdown";
import { useZyraText } from "@/lib/zyra-i18n";

// Document-type labels: same 5 entries as the Knowledge Base document page's own DOC_TYPE_LABELS,
// kept in lib/zyra-i18n.ts as "doctype.<type>" so they localize with the surrounding Zyra session.

// Same tones as components/ui/SeverityBadge.tsx (not exported there); SeverityBadge always renders
// the English value as its label, so a Russian label needs its own chip.
const SEVERITY_TONE: Record<Severity, "error" | "warning" | "neutral" | "success"> = {
  Critical: "error",
  High: "warning",
  Medium: "neutral",
  Low: "success",
};

/**
 * SeverityBadge with a localized label: identical to it in English (same tone map, same text), but
 * shows the Russian severity word when the surrounding Zyra session/task is Russian. Display only —
 * the value itself stays the English severity. Exported for the review panel and the task-board surfaces too.
 */
export function ZyraSeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const t = useZyraText();
  if (t.lang === "en") return <SeverityBadge severity={severity} className={className} />;
  return (
    <StatusChip tone={SEVERITY_TONE[severity]} className={className}>
      {t.value("severity", severity)}
    </StatusChip>
  );
}

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
  // `message` is the API's own error text (null: no usable message); `stale`: it was the known
  // "not found" body for this source type, shown as the localized stale-source explanation instead.
  | { kind: "error"; message: string | null; stale: boolean }
  | { kind: "testcase"; data: Record<string, unknown>; customFields: CustomFieldValue[] }
  | { kind: "bug"; data: BugItem }
  | { kind: "knowledge_document"; data: KnowledgeDocument }
  | { kind: "knowledge_file"; data: KnowledgeFile }
  | { kind: "jira_ticket"; data: JiraTicket };

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{children}</h4>;
}

function TestcaseDetail({ data, customFields }: { data: Record<string, unknown>; customFields: CustomFieldValue[] }) {
  const t = useZyraText();
  const steps = parseSteps(data.steps);
  const priority = String(data.priority || "P2");
  const populatedCustomFields = customFields.filter((f) => !isCustomFieldValueEmpty(f.value));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["P0", "P1", "P2", "P3"] as Priority[]).includes(priority as Priority) && <PriorityBadge priority={priority as Priority} />}
        <StatusChip tone="brand">{t.value("testcaseStatus", String(data.status || "Draft"))}</StatusChip>
        {data.externalId ? <span className="font-mono text-[11px] text-[var(--muted)]">{String(data.externalId)}</span> : null}
      </div>
      {!!data.description && (
        <div>
          <SectionLabel>{t("drawer.description")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.description)}</p>
        </div>
      )}
      {!!data.preconditions && (
        <div>
          <SectionLabel>{t("col.preconditions")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.preconditions)}</p>
        </div>
      )}
      {!!data.testData && (
        <div>
          <SectionLabel>{t("drawer.testData")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.testData)}</p>
        </div>
      )}
      {steps.length > 0 && (
        <div>
          <SectionLabel>{t("col.steps")}</SectionLabel>
          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2">
                <p className="text-sm font-medium text-[var(--foreground)]">{step.stepNumber ?? i + 1}. {step.action}</p>
                {step.expectedResult && <p className="mt-0.5 text-xs text-[var(--muted)]">{t("drawer.expectedPrefix")}{step.expectedResult}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      {!!data.postconditions && (
        <div>
          <SectionLabel>{t("drawer.postconditions")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.postconditions)}</p>
        </div>
      )}
      {!!data.attachments && (
        <div>
          <SectionLabel>{t("drawer.notes")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{String(data.attachments)}</p>
        </div>
      )}
      {populatedCustomFields.length > 0 && (
        <div>
          <SectionLabel>{t("drawer.customFields")}</SectionLabel>
          <div className="space-y-2">
            {populatedCustomFields.map((field) => (
              <div key={field.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-[var(--muted)]">{field.name}:</span>
                <span className="text-[var(--foreground)]">{formatCustomFieldValueForDisplay(field, field.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BugDetail({ data }: { data: BugItem }) {
  const t = useZyraText();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {data.severity && <ZyraSeverityBadge severity={data.severity} />}
        {data.priority && <PriorityBadge priority={data.priority} />}
        <StatusChip tone="brand">{data.status}</StatusChip>
        <span className="font-mono text-[11px] text-[var(--muted)]">{data.externalId}</span>
      </div>
      {!!data.description && (
        <div>
          <SectionLabel>{t("drawer.description")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{data.description}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        {data.reporterName && <span>{t("drawer.reportedBy")}<span className="text-[var(--foreground)]">{data.reporterName}</span></span>}
        {data.assigneeName && <span>{t("drawer.assignedTo")}<span className="text-[var(--foreground)]">{data.assigneeName}</span></span>}
        <span>{t("drawer.created")}<span className="text-[var(--foreground)]">{new Date(data.createdAt).toLocaleDateString(t.locale)}</span></span>
      </div>
      {data.attachments.length > 0 && (
        <div>
          <SectionLabel>{t("drawer.evidence")}</SectionLabel>
          <ul className="space-y-1">
            {data.attachments.map((file) => (
              <li key={file.id} className="text-xs text-[var(--muted)]">
                {file.fileName} <span className="text-[var(--muted-soft)]">({Math.round(file.fileSize / 1024)} {t("drawer.kb")})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.externalUrl && (
        <a href={data.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline">
          {t("drawer.openInTracker")} <IconExternalLink size={13} stroke={1.9} />
        </a>
      )}
    </div>
  );
}

function KnowledgeDocumentDetail({ data, projectId }: { data: KnowledgeDocument; projectId: string }) {
  const t = useZyraText();
  const providerLabel = data.sourceProvider === "linear" ? "Linear" : "Jira";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone="brand">{data.status}</StatusChip>
        <span className="text-xs text-[var(--muted)]">{t.opt(`doctype.${data.documentType}`) || data.documentType}</span>
      </div>
      {data.contentText ? (
        <div
          className="zyra-prose break-words text-sm text-[var(--foreground)]"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(data.contentText) }}
        />
      ) : (
        <p className="text-sm text-[var(--muted)]">{t("drawer.noText")}</p>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        {data.sourceProvider && (
          <span>
            {t("drawer.syncedFrom", { provider: providerLabel })}
            {data.syncedByName ? t("drawer.syncedBy", { name: data.syncedByName }) : ""}
            {data.sourceSyncedAt ? t("drawer.syncedOn", { date: new Date(data.sourceSyncedAt).toLocaleString(t.locale) }) : ""}
          </span>
        )}
        {data.reviewedAt && <span>{t("drawer.reviewedOn")}<span className="text-[var(--foreground)]">{new Date(data.reviewedAt).toLocaleDateString(t.locale)}</span></span>}
      </div>
      <Link
        href={`/projects/${projectId}/knowledge-base/documents/${data.id}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline"
      >
        {t("drawer.openFull")} <IconExternalLink size={13} stroke={1.9} />
      </Link>
    </div>
  );
}

function KnowledgeFileDetail({ data, projectId }: { data: KnowledgeFile; projectId: string }) {
  const t = useZyraText();
  return (
    <div className="space-y-4">
      {data.originalFileName && data.originalFileName !== data.fileName && (
        <p className="text-sm text-[var(--foreground)]">{data.originalFileName}</p>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        <span>{t("drawer.type")}<span className="text-[var(--foreground)]">{data.mimeType || t("drawer.unknown")}</span></span>
        {data.fileSize != null && <span>{t("drawer.size")}<span className="text-[var(--foreground)]">{Math.round(data.fileSize / 1024)} {t("drawer.kb")}</span></span>}
        <span>{t("drawer.uploaded")}<span className="text-[var(--foreground)]">{new Date(data.createdAt).toLocaleDateString(t.locale)}</span></span>
      </div>
      <a
        href={getKnowledgeFileDownloadUrl(projectId, data.id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline"
      >
        {t("drawer.download")} <IconDownload size={13} stroke={1.9} />
      </a>
    </div>
  );
}

function JiraTicketDetail({ data }: { data: JiraTicket }) {
  const t = useZyraText();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone="brand">{data.status}</StatusChip>
        {data.issueType && <span className="text-xs text-[var(--muted)]">{data.issueType}</span>}
        {data.priority && <span className="text-xs text-[var(--muted)]">{data.priority}</span>}
        <span className="font-mono text-[11px] text-[var(--muted)]">{data.jiraIssueKey}</span>
      </div>
      {!!data.description && (
        <div>
          <SectionLabel>{t("drawer.description")}</SectionLabel>
          <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">{data.description}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
        {data.reporter && <span>{t("drawer.reporter")}<span className="text-[var(--foreground)]">{data.reporter}</span></span>}
        {data.assignee && <span>{t("drawer.assignee")}<span className="text-[var(--foreground)]">{data.assignee}</span></span>}
        {data.labels && <span>{t("drawer.labels")}<span className="text-[var(--foreground)]">{data.labels}</span></span>}
        {data.jiraUpdatedAt && <span>{t("drawer.updated")}<span className="text-[var(--foreground)]">{new Date(data.jiraUpdatedAt).toLocaleDateString(t.locale)}</span></span>}
      </div>
      {data.jiraUrl && (
        <a href={data.jiraUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-light)] hover:underline">
          {t("drawer.openInJira")} <IconExternalLink size={13} stroke={1.9} />
        </a>
      )}
    </div>
  );
}

// The exact NotFoundException body each single-item GET throws (legacy.service.ts: kbDocument,
// kbFile, getTestCaseForUser, getBugForUser, jiraTicketByKey) when the row is gone or soft-deleted. A citation is a
// historical record of what informed a past reply, kept even after its source is later edited or
// deleted (see zyraSourceRefIndex's own comment) — so this is an expected, not-broken outcome, and
// deserves a plain explanation instead of the bare backend string surfacing as if something failed.
// These stay English: they are compared against the API's own error text, never displayed. The
// explanation shown instead is the localized "drawer.stale.<type>" key in lib/zyra-i18n.ts.
const NOT_FOUND_MESSAGE: Partial<Record<ZyraSourceRef["type"], string>> = {
  testcase: "Test case not found",
  bug: "Bug not found",
  knowledge_document: "Document not found",
  knowledge_file: "File not found",
  jira_ticket: "Jira ticket not found",
};

// Drawer header per source type: "drawer.typeTitle.<type>" in lib/zyra-i18n.ts.

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
  const t = useZyraText();

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    async function load() {
      try {
        if (reference.type === "testcase") {
          const data = await getTestCase(projectId, reference.id);
          // custom-field-values requires the row's real uuid, never the external id reference.id
          // may carry — see getValuesForTestCase in custom-fields.service.ts.
          const customFields = await getCustomFieldValues(projectId, String(data.id)).catch(() => []);
          if (!cancelled) setState({ kind: "testcase", data, customFields });
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
          // Exact-key lookup, not the Requirements list endpoint: that one only lists the currently
          // enabled mapping's tickets (and pages a substring search), so a ticket Zyra read from a
          // since-re-mapped Jira project — or one past the first page of "PRO-1…" matches — reported
          // as not found. See jiraTicketByKey in legacy.service.ts.
          const data = await getJiraTicket(projectId, reference.id);
          if (!cancelled) setState({ kind: "jira_ticket", data });
        }
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : null;
        const stale = rawMessage !== null && rawMessage === NOT_FOUND_MESSAGE[reference.type];
        if (!cancelled) setState({ kind: "error", message: rawMessage, stale });
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
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{t.opt(`drawer.typeTitle.${reference.type}`) || reference.type}</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-[var(--foreground)]">{titleText}</p>
        </div>
      }
    >
      <div className="p-5">
        {state.kind === "loading" && <p className="text-sm text-[var(--muted)]">{t("drawer.loading")}</p>}
        {state.kind === "error" && (
          <p className="text-sm text-[var(--error-foreground)]">
            {state.stale ? t.opt(`drawer.stale.${reference.type}`) : state.message ?? t("drawer.failedLoad")}
          </p>
        )}
        {state.kind === "testcase" && <TestcaseDetail data={state.data} customFields={state.customFields} />}
        {state.kind === "bug" && <BugDetail data={state.data} />}
        {state.kind === "knowledge_document" && <KnowledgeDocumentDetail data={state.data} projectId={projectId} />}
        {state.kind === "knowledge_file" && <KnowledgeFileDetail data={state.data} projectId={projectId} />}
        {state.kind === "jira_ticket" && <JiraTicketDetail data={state.data} />}
      </div>
    </Drawer>
  );
}
