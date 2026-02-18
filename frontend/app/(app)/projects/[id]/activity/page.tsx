"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { authMe, getProject, listActivity, type ActivityLogItem } from "@/lib/api";

const ENTITY_FILTERS = [
  { value: "", label: "All" },
  { value: "testcase", label: "Test Cases" },
  { value: "suite", label: "Suites" },
  { value: "plan", label: "Plans" },
  { value: "cycle", label: "Test Runs" },
  { value: "jira", label: "Jira Sync" },
] as const;

const ACTION_LABELS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  bulk_updated: "Bulk Updated",
  bulk_deleted: "Bulk Deleted",
  ai_generated: "AI Generated",
  synced: "Synced",
  connected: "Connected",
  disconnected: "Disconnected",
};

const ENTITY_LABELS: Record<string, string> = {
  testcase: "Test Case",
  suite: "Suite",
  jira: "Jira",
  plan: "Plan",
  cycle: "Test Run",
  bug: "Bug",
};

const ACTION_COLORS: Record<string, string> = {
  created: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  updated: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  deleted: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  bulk_updated: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  bulk_deleted: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  ai_generated: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
  synced: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  connected: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  disconnected: "bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300",
};

const ENTITY_ICONS: Record<string, string> = {
  testcase: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4",
  suite: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z",
  jira: "M13 10V3L4 14h7v7l9-11h-7z",
  plan: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  cycle: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function formatFullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function groupByDate(items: ActivityLogItem[]): { date: string; items: ActivityLogItem[] }[] {
  const groups: Map<string, ActivityLogItem[]> = new Map();
  for (const item of items) {
    const d = new Date(item.createdAt);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let label: string;
    if (d.toDateString() === today.toDateString()) {
      label = "Today";
    } else if (d.toDateString() === yesterday.toDateString()) {
      label = "Yesterday";
    } else {
      label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }
  return Array.from(groups.entries()).map(([date, items]) => ({ date, items }));
}

const PAGE_SIZE = 30;

export default function ActivityPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [activities, setActivities] = useState<ActivityLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [entityFilter, setEntityFilter] = useState("");
  const [offset, setOffset] = useState(0);

  const fetchActivities = useCallback(
    async (reset: boolean, filter: string) => {
      const newOffset = reset ? 0 : offset;
      if (reset) setLoading(true);
      else setLoadingMore(true);
      try {
        const res = await listActivity(projectId, {
          limit: PAGE_SIZE,
          offset: newOffset,
          entityType: filter || undefined,
        });
        if (reset) {
          setActivities(res.list);
        } else {
          setActivities((prev) => [...prev, ...res.list]);
        }
        setTotal(res.total);
        setOffset(newOffset + res.list.length);
      } catch {
        if (reset) setActivities([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId, offset]
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
    });
  }, [projectId, router]);

  useEffect(() => {
    setOffset(0);
    fetchActivities(true, entityFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, entityFilter]);

  const hasMore = activities.length < total;
  const groups = groupByDate(activities);
  const projectName = project ? (project.name as string) ?? "" : "";

  if (loading && !project) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/projects" className="hover:text-zinc-700 dark:hover:text-zinc-300">
            Projects
          </Link>
          <span>/</span>
          <Link
            href={`/projects/${projectId}/dashboard`}
            className="hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            {projectName}
          </Link>
          <span>/</span>
          <span className="text-zinc-900 dark:text-zinc-100">Activity</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Activity
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Track all actions performed in this project with timestamps.
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-6">
        {ENTITY_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setEntityFilter(f.value)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              entityFilter === f.value
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Activity Timeline */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <svg
            className="animate-spin h-6 w-6 text-zinc-400"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        </div>
      ) : activities.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-12 text-center">
          <svg
            className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="mt-4 text-zinc-500 dark:text-zinc-400 font-medium">
            No activity yet
          </p>
          <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">
            Actions like creating test cases, updating suites, and syncing Jira will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <div key={group.date}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-3 sticky top-0 bg-zinc-50 dark:bg-zinc-950 py-1 z-10">
                {group.date}
              </h3>
              <div className="relative pl-6 border-l-2 border-zinc-200 dark:border-zinc-700 space-y-0">
                {group.items.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center pt-4">
              <button
                onClick={() => fetchActivities(false, entityFilter)}
                disabled={loadingMore}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function ActivityRow({ item }: { item: ActivityLogItem }) {
  const actionLabel = ACTION_LABELS[item.action] || item.action;
  const entityLabel = ENTITY_LABELS[item.entityType] || item.entityType;
  const colorClass = ACTION_COLORS[item.action] || "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  const iconPath = ENTITY_ICONS[item.entityType] || ENTITY_ICONS.testcase;
  const actorDisplay = item.actorName || item.actorEmail || "System";

  return (
    <div className="relative pb-5 group">
      {/* Timeline dot */}
      <div className="absolute -left-[25px] top-1 w-3 h-3 rounded-full border-2 border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 group-hover:border-blue-400 dark:group-hover:border-blue-500 transition-colors" />

      <div className="rounded-lg border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-zinc-200 dark:hover:border-zinc-700 transition-colors">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="mt-0.5 p-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800">
            <svg
              className="w-4 h-4 text-zinc-500 dark:text-zinc-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
            </svg>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {actorDisplay}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}
              >
                {actionLabel}
              </span>
              <span className="text-sm text-zinc-500 dark:text-zinc-400">
                {entityLabel}
              </span>
            </div>

            {item.entityName && (
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300 truncate">
                {item.entityName}
              </p>
            )}

            <p
              className="mt-1 text-xs text-zinc-400 dark:text-zinc-500"
              title={formatFullTimestamp(item.createdAt)}
            >
              {formatTimestamp(item.createdAt)} · {formatFullTimestamp(item.createdAt)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
