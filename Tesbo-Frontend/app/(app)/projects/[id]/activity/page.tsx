"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo } from "react";
import { IconActivity, IconSearch } from "@tabler/icons-react";
import {
  authMe,
  getActivitySummary,
  getProject,
  listActivity,
  listProjectMembers,
  type ActivitySummary,
  type ActivityLogItem,
} from "@/lib/api";
import { Button, EmptyStateBlock, Select } from "@/components/ui";
import { PageHeader, StandardPageLayout, Breadcrumbs } from "@/components/workflows";
import {
  ActivityRow,
  ActivitySummaryPanel,
  DATE_FILTERS,
  groupByDate,
  sinceFor,
} from "@/components/activity/activityShared";

const TYPE_FILTERS = [
  { value: "", label: "All types" },
  { value: "testcase", label: "Test cases" },
  { value: "suite", label: "Suites" },
  { value: "plan", label: "Test plans" },
  { value: "cycle", label: "Test runs" },
  { value: "bug", label: "Bugs" },
  { value: "knowledge_folder,knowledge_document,knowledge_file", label: "Knowledge base" },
  { value: "custom_field_definition", label: "Custom fields" },
] as const;

const PAGE_SIZE = 30;

export default function ActivityPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [members, setMembers] = useState<{ userId: string; name: string; email: string }[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [activities, setActivities] = useState<ActivityLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const [typeFilter, setTypeFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchActivities = useCallback(
    async (reset: boolean, currentOffset: number) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);
      try {
        const res = await listActivity(projectId, {
          limit: PAGE_SIZE,
          offset: currentOffset,
          entityType: typeFilter || undefined,
          actorId: actorFilter || undefined,
          search: search || undefined,
          since: sinceFor(dateFilter),
        });
        setActivities((prev) => (reset ? res.list : [...prev, ...res.list]));
        setTotal(res.total);
        setOffset(currentOffset + res.list.length);
      } catch {
        if (reset) setActivities([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId, typeFilter, actorFilter, search, dateFilter]
  );

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => setProject(p))
        .catch(() => router.replace("/projects"));
      listProjectMembers(projectId)
        .then((list) => setMembers(list))
        .catch(() => setMembers([]));
      getActivitySummary(projectId)
        .then((s) => setSummary(s))
        .catch(() => setSummary(null));
    });
  }, [projectId, router]);

  useEffect(() => {
    fetchActivities(true, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, typeFilter, actorFilter, search, dateFilter]);

  const hasMore = activities.length < total;
  const groups = useMemo(() => groupByDate(activities), [activities]);
  const projectName = project ? ((project.name as string) ?? "") : "";

  const breadcrumb = (
    <Breadcrumbs
      items={[
        { label: "Projects", href: "/projects" },
        { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
        { label: "Activity" },
      ]}
    />
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Activity"
          subtitle="A full audit log of all actions taken across this project — who did what and when."
          breadcrumb={breadcrumb}
        />
      }
    >
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-6">
          {/* Filter toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-[150px]">
                <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  {TYPE_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-[150px]">
                <Select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
                  <option value="">Anyone</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name || m.email}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-[130px]">
                <Select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
                  {DATE_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <label className="flex h-9 w-full max-w-[240px] items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors focus-within:border-[var(--denim-200)] sm:w-[240px]">
              <IconSearch size={14} stroke={1.75} className="shrink-0" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search activity…"
                className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--ink-300)]"
              />
            </label>
          </div>

          {/* Feed */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="h-6 w-6 animate-spin text-[var(--muted)]" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : activities.length === 0 ? (
            <EmptyStateBlock
              title="No activity yet"
              description="Actions like creating test cases, updating suites, and Zyra AI actions will appear here."
              icon={<IconActivity size={28} stroke={1.5} />}
            />
          ) : (
            <div className="space-y-1">
              {groups.map((group) => (
                <div key={group.label}>
                  <h3 className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--background)] py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                    {group.label}
                  </h3>
                  <div className="divide-y divide-[var(--border-subtle)]">
                    {group.items.map((item) => (
                      <ActivityRow key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              ))}

              {hasMore && (
                <div className="flex justify-center pt-5">
                  <Button variant="secondary" size="md" onClick={() => fetchActivities(false, offset)} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-6">
          <ActivitySummaryPanel summary={summary} />
        </div>
      </div>
    </StandardPageLayout>
  );
}
