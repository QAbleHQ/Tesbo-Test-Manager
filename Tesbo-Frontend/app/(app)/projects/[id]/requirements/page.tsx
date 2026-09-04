"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import React from "react";
import { IconRefresh, IconSettings, IconPlug } from "@tabler/icons-react";
import {
  authMe,
  getProject,
  getJiraStatus,
  getLinearStatus,
  createZyraTask,
  listJiraTickets,
  listLinearTickets,
  listAllTickets,
  listLinkedJiraKeys,
  listLinkedLinearKeys,
  getRequirementsSummary,
  type RequirementsSummary,
  type TicketSourceStats,
} from "@/lib/api";
import { Button, Input, PageLoader, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import { SyncStatusPanel, useSyncRun } from "@/components/integrations/SyncStatusPanel";

const PAGE_SIZE = 25;

type Source = "all" | "jira" | "linear";
type TicketSource = "jira" | "linear";

interface Requirement {
  id: string;
  source: TicketSource;
  key: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  labels: string;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ProviderMeta {
  id: TicketSource;
  label: string;
  logoBg: string;
  logoLetter: string;
  /** Label for the provider's mapping screen — Jira maps projects, Linear maps teams. */
  manageLabel: string;
  getStatus: (projectId: string) => Promise<{ connected: boolean }>;
}

/**
 * Every tracker this page knows how to render. Tabs are filtered down to the ones actually
 * connected, so registering a provider here is all a new integration needs — and one that is
 * never connected never shows up.
 */
const PROVIDERS: ProviderMeta[] = [
  {
    id: "jira",
    label: "Jira",
    logoBg: "#0052CC",
    logoLetter: "J",
    manageLabel: "Jira Projects",
    getStatus: getJiraStatus,
  },
  {
    id: "linear",
    label: "Linear",
    logoBg: "#5E6AD2",
    logoLetter: "L",
    manageLabel: "Linear Teams",
    getStatus: getLinearStatus,
  },
];

const ALL_TAB = { id: "all" as const, label: "All Sources", logoBg: "#5A4F80", logoLetter: "Σ" };

function providerFor(source: TicketSource): ProviderMeta | undefined {
  return PROVIDERS.find((p) => p.id === source);
}

function providerLabel(source: TicketSource): string {
  return providerFor(source)?.label ?? source;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const EMPTY_STATS: TicketSourceStats = { total: 0, covered: 0, uncovered: 0, types: [], statuses: [] };

function jiraStatusTone(status: string): "neutral" | "success" | "warning" | "info" {
  const s = status.toLowerCase();
  if (s === "done" || s === "closed" || s === "resolved") return "success";
  if (s === "in progress" || s === "in review") return "info";
  if (s === "to do" || s === "open" || s === "new" || s === "backlog") return "neutral";
  return "warning";
}

function PriorityIcon({ priority }: { priority: string }) {
  const p = priority?.toLowerCase() ?? "";
  let color = "text-[var(--muted-soft)]";
  if (p === "highest" || p === "critical") color = "text-red-500";
  else if (p === "high") color = "text-orange-500";
  else if (p === "medium") color = "text-yellow-500";
  else if (p === "low") color = "text-[var(--accent-light)]";
  else if (p === "lowest") color = "text-[var(--muted-soft)]";
  return (
    <span className={`text-xs font-medium ${color}`} title={priority}>
      {priority || "—"}
    </span>
  );
}

function IssueTypeIcon({ type }: { type: string }) {
  const t = type?.toLowerCase() ?? "";
  let color = "bg-[var(--surface-tertiary)] text-[var(--muted)]";
  if (t === "bug") color = "bg-[var(--error-soft)] text-[var(--error-foreground)]";
  else if (t === "story" || t === "user story")
    color = "bg-[var(--success-soft)] text-[var(--success-foreground)]";
  else if (t === "epic")
    color = "bg-[var(--ai-soft)] text-[var(--ai-primary)]";
  else if (t === "task" || t === "sub-task")
    color = "bg-[var(--brand-soft)] text-[var(--accent-light)]";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {type || "—"}
    </span>
  );
}

function SourceBadge({ source }: { source: TicketSource }) {
  const provider = providerFor(source);
  if (!provider) return null;
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
      style={{ background: provider.logoBg }}
      title={provider.label}
    >
      {provider.logoLetter}
    </span>
  );
}

function SearchBar({
  value,
  onChange,
  onSearch,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
      className="flex items-center gap-2"
    >
      <div className="relative flex-1 max-w-sm">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-soft)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pl-9"
        />
      </div>
      <Button type="submit" variant="secondary" size="sm">Search</Button>
    </form>
  );
}

export default function RequirementsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<Source>("all");
  const [connectedSources, setConnectedSources] = useState<TicketSource[]>([]);
  const [summary, setSummary] = useState<RequirementsSummary | null>(null);
  const [tickets, setTickets] = useState<Requirement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [coverageFilter, setCoverageFilter] = useState<"" | "covered" | "uncovered">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [linkedJiraKeys, setLinkedJiraKeys] = useState<Set<string>>(new Set());
  const [jiraKeyCounts, setJiraKeyCounts] = useState<Record<string, number>>({});
  const [linkedLinearKeys, setLinkedLinearKeys] = useState<Set<string>>(new Set());
  const [linearKeyCounts, setLinearKeyCounts] = useState<Record<string, number>>({});
  const [syncError, setSyncError] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");

  // One polled run per provider. Both hooks are called unconditionally (React rules) and gate
  // their own fetching on whether that provider is connected.
  const jiraSync = useSyncRun(projectId, "jira", connectedSources.includes("jira"));
  const linearSync = useSyncRun(projectId, "linear", connectedSources.includes("linear"));
  const syncByProvider: Record<TicketSource, ReturnType<typeof useSyncRun>> = { jira: jiraSync, linear: linearSync };
  const anySyncActive = jiraSync.isActive || linearSync.isActive;
  const syncStarting = jiraSync.starting || linearSync.starting;

  // Only successfully connected trackers are offered as tabs; "All Sources" earns its place
  // once there is more than one of them to combine.
  const connectedProviders = PROVIDERS.filter((p) => connectedSources.includes(p.id));
  const sourceTabs: Array<{ id: Source; label: string; logoBg: string; logoLetter: string }> =
    connectedProviders.length > 1 ? [ALL_TAB, ...connectedProviders] : connectedProviders;
  const anyConnected = connectedProviders.length > 0;
  const sourceConnected = source === "all" ? anyConnected : connectedSources.includes(source);
  const stats = summary?.[source] ?? EMPTY_STATS;
  const coveragePct = stats.total ? Math.round((stats.covered / stats.total) * 100) : 0;
  const connectedPhrase = anyConnected
    ? joinLabels(connectedProviders.map((p) => p.label))
    : "your connected issue tracker";

  function tcCountFor(req: Requirement): number {
    return req.source === "jira" ? jiraKeyCounts[req.key] || 0 : linearKeyCounts[req.key] || 0;
  }

  function isLinked(req: Requirement): boolean {
    return req.source === "jira" ? linkedJiraKeys.has(req.key) : linkedLinearKeys.has(req.key);
  }

  const loadTickets = useCallback(
    async (
      activeSource: Source,
      pageNum: number,
      query: string,
      filters: { issueType?: string; status?: string; coverage?: "" | "covered" | "uncovered" }
    ) => {
      const listParams = {
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
        search: query || undefined,
        issueType: filters.issueType || undefined,
        status: filters.status || undefined,
        coverage: filters.coverage || undefined,
      };
      try {
        if (activeSource === "all") {
          const data = await listAllTickets(projectId, listParams);
          setTickets(
            data.list.map((t) => ({
              id: t.id, source: t.source, key: t.key, summary: t.summary, description: t.description,
              issueType: t.issueType, status: t.status, priority: t.priority, assignee: t.assignee,
              reporter: t.reporter, labels: t.labels, url: t.url, createdAt: t.createdAt, updatedAt: t.updatedAt,
            }))
          );
          setTotal(data.total);
        } else if (activeSource === "jira") {
          const data = await listJiraTickets(projectId, listParams);
          setTickets(
            data.list.map((t) => ({
              id: t.id, source: "jira", key: t.jiraIssueKey, summary: t.summary, description: t.description,
              issueType: t.issueType, status: t.status, priority: t.priority, assignee: t.assignee,
              reporter: t.reporter, labels: t.labels, url: t.jiraUrl, createdAt: t.jiraCreatedAt, updatedAt: t.jiraUpdatedAt,
            }))
          );
          setTotal(data.total);
        } else {
          const data = await listLinearTickets(projectId, listParams);
          setTickets(
            data.list.map((t) => ({
              id: t.id, source: "linear", key: t.linearIssueKey, summary: t.summary, description: t.description,
              issueType: t.issueType, status: t.status, priority: t.priority, assignee: t.assignee,
              reporter: t.reporter, labels: t.labels, url: t.linearUrl, createdAt: t.linearCreatedAt, updatedAt: t.linearUpdatedAt,
            }))
          );
          setTotal(data.total);
        }
      } catch {
        /* ignore */
      }
    },
    [projectId]
  );

  const refreshLinkedKeys = useCallback(async () => {
    const [jiraKeysRes, linearKeysRes] = await Promise.all([
      listLinkedJiraKeys(projectId).catch(() => ({ keys: [], counts: {} })),
      listLinkedLinearKeys(projectId).catch(() => ({ keys: [], counts: {} })),
    ]);
    setLinkedJiraKeys(new Set(jiraKeysRes.keys));
    setJiraKeyCounts(jiraKeysRes.counts ?? {});
    setLinkedLinearKeys(new Set(linearKeysRes.keys));
    setLinearKeyCounts(linearKeysRes.counts ?? {});
  }, [projectId]);

  const refreshSummary = useCallback(async () => {
    const data = await getRequirementsSummary(projectId).catch(() => null);
    setSummary(data);
  }, [projectId]);

  useEffect(() => {
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const statuses = await Promise.all(
        PROVIDERS.map((p) => p.getStatus(projectId).catch(() => ({ connected: false })))
      );
      const connected = PROVIDERS.filter((_, i) => statuses[i].connected).map((p) => p.id);
      setConnectedSources(connected);
      // With a single tracker connected there is no "All Sources" tab to sit under, so open
      // straight onto that provider and keep the active tab in sync with what's rendered.
      const initialSource: Source = connected.length === 1 ? connected[0] : "all";
      setSource(initialSource);
      await loadTickets(initialSource, 0, "", {});
      await Promise.all([refreshLinkedKeys(), refreshSummary()]);
      getProject(projectId).then((p) => setProjectName(String(p.name || ""))).catch(() => setProjectName(""));
      setLoading(false);
    })();
  }, [projectId, loadTickets, refreshLinkedKeys, refreshSummary, router]);

  useEffect(() => {
    if (!loading) loadTickets(source, page, search, { issueType: typeFilter, status: statusFilter, coverage: coverageFilter });
  }, [source, page, search, typeFilter, statusFilter, coverageFilter, loadTickets, loading]);

  // Pull the freshly synced tickets in on the active -> settled edge only. Reloading on every
  // poll tick would refetch the whole list every two seconds for the length of the run.
  const syncWasActiveRef = useRef(false);
  useEffect(() => {
    if (syncWasActiveRef.current && !anySyncActive) {
      void loadTickets(source, page, search, { issueType: typeFilter, status: statusFilter, coverage: coverageFilter });
      void refreshSummary();
      void refreshLinkedKeys();
    }
    syncWasActiveRef.current = anySyncActive;
  }, [anySyncActive, source, page, search, typeFilter, statusFilter, coverageFilter, loadTickets, refreshSummary, refreshLinkedKeys]);

  function handleSourceChange(next: Source) {
    setSource(next);
    setPage(0);
    setSearch("");
    setSearchInput("");
    setTypeFilter("");
    setStatusFilter("");
    setCoverageFilter("");
    setExpandedId(null);
  }

  // Fires the runs and returns; the ticket list is refreshed by the effect below when the last
  // run settles, rather than by awaiting a sync that now takes minutes.
  async function handleSync() {
    setSyncError(null);
    const targets = PROVIDERS.filter((p) => (source === "all" ? connectedSources.includes(p.id) : source === p.id));
    await Promise.all(targets.map((p) => syncByProvider[p.id].start()));
  }

  async function handleGenerateFromTicket(ticket: Requirement, mode: "generate" | "regenerate") {
    setGeneratingKey(ticket.key);
    setSyncError(null);
    try {
      const existingCount = tcCountFor(ticket);
      const provider = providerLabel(ticket.source);
      const story = `${ticket.key}: ${ticket.summary}`;
      const context = [
        ticket.description,
        ticket.status ? `Status: ${ticket.status}` : "",
        ticket.priority ? `Priority: ${ticket.priority}` : "",
        mode === "regenerate"
          ? `Regenerate testcase coverage for ${ticket.key}. Update existing linked testcases where coverage overlaps, and add new testcases for new or changed ${provider} requirements. Mark regenerated cases clearly with Zyra/${provider} tags. Existing linked testcase count: ${existingCount}.`
          : `Generate testcase coverage for ${ticket.key}. Mark generated cases clearly with Zyra/${provider} tags.`
      ].filter(Boolean).join("\n\n");
      await createZyraTask(projectId, {
        story,
        context,
        jiraIssueKeys: ticket.source === "jira" ? [ticket.key] : undefined,
        linearIssueKeys: ticket.source === "linear" ? [ticket.key] : undefined,
      });
      router.push(`/projects/${projectId}/agents/tasks`);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Failed to create Zyra task from ticket.");
    } finally {
      setGeneratingKey(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading) {
    return <PageLoader variant="screen" />;
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Requirements"
          subtitle={`Requirements to be developed, synced from ${connectedPhrase}, and turned into test coverage with Zyra. Full documents live in the Knowledge base's Requirements folder.`}
          breadcrumb={
            <Breadcrumbs
              items={[
                { label: "Projects", href: "/projects" },
                { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
                { label: "Requirements" },
              ]}
            />
          }
          actions={
            <Link
              href={`/projects/${projectId}/settings?tab=integrations`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
            >
              <IconSettings size={15} stroke={1.75} />
              Manage integrations
            </Link>
          }
        />
      }
    >
      {/* Source tabs + coverage stat strip */}
      {(anyConnected || tickets.length > 0) && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          {sourceTabs.length > 0 && (
            <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
              {sourceTabs.map((tab) => {
                const count = summary?.[tab.id]?.total ?? 0;
                const active = source === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleSourceChange(tab.id)}
                    className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-[var(--brand-primary)] text-white"
                        : "text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    <span
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
                      style={{ background: tab.logoBg }}
                    >
                      {tab.logoLetter}
                    </span>
                    {tab.label}
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[11px] font-mono ${
                        active ? "bg-white/20" : "bg-[var(--surface-tertiary)] text-[var(--muted)]"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-center min-w-[64px]">
              <div className="text-base font-semibold text-[var(--foreground)]">{stats.total}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--muted-soft)]">Total</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-center min-w-[64px]">
              <div className="text-base font-semibold text-[var(--success-foreground)]">{stats.covered}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--muted-soft)]">Covered</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-center min-w-[64px]">
              <div className="text-base font-semibold text-[var(--warning-foreground)]">{stats.uncovered}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--muted-soft)]">Uncovered</div>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 min-w-[120px]">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-[var(--muted-soft)]">Coverage</span>
                <span className="text-sm font-semibold text-[var(--foreground)]">{coveragePct}%</span>
              </div>
              <div className="h-1 rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--success)] transition-[width]" style={{ width: `${coveragePct}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {sourceConnected && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncStarting || anySyncActive}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--surface-tertiary)] text-[var(--foreground)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-tertiary)] disabled:opacity-50 transition-colors"
            >
              <IconRefresh size={15} stroke={1.75} className={anySyncActive ? "animate-spin" : undefined} />
              {syncStarting ? "Starting…" : anySyncActive ? "Syncing…" : `Sync ${source === "all" ? "all sources" : providerLabel(source)}`}
            </button>
            {source !== "all" && (
              <Link
                href={`/projects/${projectId}/settings/integrations/${source}`}
                className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
              >
                Manage
              </Link>
            )}
            <Link
              href={`/projects/${projectId}/knowledge-base`}
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
            >
              View in Knowledge base
            </Link>
          </div>
          <span className="text-sm text-[var(--muted)]">
            {total} requirement{total !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Live per-provider run state. Kept visible after a run settles so the last sync's outcome
          (and who ran it) explains what's in the Knowledge Base right now. */}
      {sourceConnected &&
        PROVIDERS.filter((p) => (source === "all" ? connectedSources.includes(p.id) : source === p.id)).map((p) => (
          <SyncStatusPanel key={p.id} run={syncByProvider[p.id].run} label={p.label} />
        ))}

      {(syncError || jiraSync.error || linearSync.error) && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-4 py-2.5 text-sm text-[var(--error-foreground)]">
          <span>{syncError || jiraSync.error || linearSync.error}</span>
          <button type="button" onClick={() => setSyncError(null)} className="ml-3 text-[var(--error-foreground)] hover:opacity-80">
            Dismiss
          </button>
        </div>
      )}

      {!sourceConnected && tickets.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-[var(--brand-soft)] flex items-center justify-center">
            <IconPlug size={26} stroke={1.75} className="text-[var(--accent-light)]" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
            {source === "all"
              ? "Connect an Issue Tracker to Get Started"
              : `Connect ${providerLabel(source)} to Get Started`}
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] max-w-sm mx-auto">
            Connect an issue tracker in project settings to automatically import tickets as
            requirements and use them as context for generating test cases.
          </p>
          <Link
            href={`/projects/${projectId}/settings?tab=integrations`}
            style={{ color: "#fff" }}
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-[var(--brand-primary)] px-5 py-2 text-sm font-semibold !text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
          >
            Go to Project Settings
          </Link>
        </div>
      )}

      {sourceConnected && tickets.length === 0 && !search && !typeFilter && !statusFilter && !coverageFilter && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">No Requirements Synced Yet</h2>
          <p className="mt-2 text-sm text-[var(--muted)] max-w-sm mx-auto">
            Click &quot;Sync&quot; to pull tickets from your connected projects.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              onClick={handleSync}
              disabled={syncStarting || anySyncActive}
              className="rounded-lg bg-[var(--brand-primary)] text-white px-5 py-2 text-sm font-medium hover:bg-[var(--brand-hover)] disabled:opacity-50 transition-colors"
            >
              {syncStarting ? "Starting…" : anySyncActive ? "Syncing…" : "Sync Tickets"}
            </button>
            {source !== "all" && (
              <Link
                href={`/projects/${projectId}/settings/integrations/${source}`}
                className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
              >
                Manage {providerFor(source)?.manageLabel ?? providerLabel(source)}
              </Link>
            )}
          </div>
        </div>
      )}

      {(tickets.length > 0 || search || typeFilter || statusFilter || coverageFilter) && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchBar
              value={searchInput}
              onChange={setSearchInput}
              onSearch={() => {
                setPage(0);
                setSearch(searchInput);
              }}
              placeholder="Search by key or summary…"
            />
            <select
              value={typeFilter}
              onChange={(e) => { setPage(0); setTypeFilter(e.target.value); }}
              className="h-9 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--foreground)] outline-none"
            >
              <option value="">All types</option>
              {stats.types.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => { setPage(0); setStatusFilter(e.target.value); }}
              className="h-9 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--foreground)] outline-none"
            >
              <option value="">All statuses</option>
              {stats.statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              value={coverageFilter}
              onChange={(e) => { setPage(0); setCoverageFilter(e.target.value as "" | "covered" | "uncovered"); }}
              className="h-9 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--foreground)] outline-none"
            >
              <option value="">Coverage: All</option>
              <option value="covered">Covered</option>
              <option value="uncovered">Uncovered</option>
            </select>
            {(search || typeFilter || statusFilter || coverageFilter) && (
              <button
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                  setTypeFilter("");
                  setStatusFilter("");
                  setCoverageFilter("");
                  setPage(0);
                }}
                className="text-sm text-[var(--accent-light)] hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="flex items-center justify-between text-sm text-[var(--muted)]">
            <span>
              {total} requirement{total !== 1 ? "s" : ""}
              {search && <> matching &quot;{search}&quot;</>}
            </span>
            <span>
              Page {page + 1} of {totalPages}
            </span>
          </div>

          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 900 }}>
              <thead>
                <tr className="bg-[var(--surface-secondary)] border-b border-[var(--border)]">
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-28">Key</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)]">Summary</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-24">Type</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-36">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-20">Priority</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-32">Assignee</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-24">Coverage</th>
                  <th className="text-right px-4 py-2.5 font-medium text-[var(--muted-soft)] w-64">Action</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => {
                  const linked = isLinked(ticket);
                  const tcCount = tcCountFor(ticket);
                  return (
                    <React.Fragment key={ticket.id}>
                      <tr
                        onClick={() => setExpandedId(expandedId === ticket.id ? null : ticket.id)}
                        className="border-b border-[var(--border-subtle)] hover:bg-[var(--surface-secondary)]/30 cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {source === "all" && <SourceBadge source={ticket.source} />}
                            <a
                              href={ticket.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="font-mono text-xs text-[var(--accent-light)] hover:underline"
                            >
                              {ticket.key}
                            </a>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[var(--foreground)] truncate max-w-xs">
                          {ticket.summary}
                        </td>
                        <td className="px-4 py-2.5">
                          <IssueTypeIcon type={ticket.issueType} />
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusChip tone={jiraStatusTone(ticket.status)}>{ticket.status}</StatusChip>
                        </td>
                        <td className="px-4 py-2.5">
                          <PriorityIcon priority={ticket.priority} />
                        </td>
                        <td className="px-4 py-2.5 text-[var(--muted-soft)] text-xs truncate">
                          {ticket.assignee || "Unassigned"}
                        </td>
                        <td className="px-4 py-2.5">
                          {tcCount > 0 ? (
                            <div className="flex items-center gap-1.5">
                              <div className="w-8 h-1 rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
                                <div className="h-full w-full rounded-full bg-[var(--success)]" />
                              </div>
                              <span className="text-[11px] font-mono font-medium text-[var(--success-foreground)]">{tcCount} TC</span>
                            </div>
                          ) : (
                            <span className="text-[11px] text-[var(--muted-soft)]">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="inline-flex items-center gap-2">
                            {linked && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--success-foreground)]">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                {tcCount} saved
                              </span>
                            )}
                            {linked ? (
                              <>
                                <Link
                                  href={`/projects/${projectId}/testcases?${ticket.source === "jira" ? "jiraIssueKey" : "linearIssueKey"}=${encodeURIComponent(ticket.key)}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-semibold text-[var(--foreground)] shadow-sm hover:bg-[var(--surface-secondary)]"
                                >
                                  View testcases
                                </Link>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleGenerateFromTicket(ticket, "regenerate");
                                  }}
                                  disabled={generatingKey === ticket.key}
                                  className="rounded-lg bg-[var(--brand-primary)] px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)] disabled:opacity-50"
                                >
                                  {generatingKey === ticket.key ? "Assigning..." : "Regenerate with Zyra"}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleGenerateFromTicket(ticket, "generate");
                                }}
                                disabled={generatingKey === ticket.key}
                                className="rounded-lg bg-[var(--brand-primary)] px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)] disabled:opacity-50"
                              >
                                {generatingKey === ticket.key ? "Assigning..." : "Assign to Zyra"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === ticket.id && (
                        <tr key={`${ticket.id}-detail`} className="bg-[var(--surface-secondary)]/20">
                          <td colSpan={8} className="px-4 py-4">
                            <div className="space-y-3">
                              {ticket.description && (
                                <div>
                                  <h4 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide mb-1">
                                    Description
                                  </h4>
                                  <p className="text-sm text-[var(--muted)] whitespace-pre-wrap max-h-48 overflow-y-auto">
                                    {ticket.description}
                                  </p>
                                </div>
                              )}
                              <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
                                {ticket.reporter && (
                                  <span>Reporter: <span className="text-[var(--muted)]">{ticket.reporter}</span></span>
                                )}
                                {ticket.labels && (
                                  <span>Labels: <span className="text-[var(--muted)]">{ticket.labels}</span></span>
                                )}
                                {ticket.createdAt && (
                                  <span>Created: <span className="text-[var(--muted)]">{new Date(ticket.createdAt).toLocaleDateString()}</span></span>
                                )}
                                {ticket.updatedAt && (
                                  <span>Updated: <span className="text-[var(--muted)]">{new Date(ticket.updatedAt).toLocaleDateString()}</span></span>
                                )}
                              </div>
                              <a
                                href={ticket.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block text-xs text-[var(--accent-light)] hover:underline"
                              >
                                Open in {providerLabel(ticket.source)} →
                              </a>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <span className="rounded-lg bg-[var(--brand-primary)] px-3 py-1.5 text-sm font-mono font-medium text-white">
                {page + 1}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </StandardPageLayout>
  );
}
