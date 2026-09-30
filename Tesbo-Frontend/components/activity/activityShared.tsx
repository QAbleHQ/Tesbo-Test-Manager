import {
  IconBooks,
  IconBug,
  IconClipboardList,
  IconFileText,
  IconFolder,
  IconFolders,
  IconMail,
  IconMessage,
  IconPaperclip,
  IconPlayerPlay,
  IconSparkles,
  IconStack2,
  IconUsers,
} from "@tabler/icons-react";
import type { ActivityLogItem, ActivitySummary } from "@/lib/api";
import { Card, CardBody, StatusChip, type StatusChipProps } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import { OwnerAvatar } from "@/components/testplans/PlanCard";
import { type ReactNode } from "react";

// A workspace-scoped activity row also carries which project it belongs to (null for
// pure workspace-level events like invites/membership changes with no project context).
export type AnyActivityLogItem = ActivityLogItem & { projectId?: string | null; projectName?: string | null };

export const DATE_FILTERS = [
  { value: "", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

export function sinceFor(dateFilter: string): string | undefined {
  if (!dateFilter) return undefined;
  const now = new Date();
  if (dateFilter === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  const days = dateFilter === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

// action -> [badge label, StatusChip tone]
const ACTION_META: Record<string, [string, StatusChipProps["tone"]]> = {
  created: ["Created", "success"],
  testcase_created: ["Created", "success"],
  project_created: ["Created", "success"],
  zyra_created: ["Generated", "ai"],
  zyra_suite_created: ["Generated", "ai"],
  updated: ["Updated", "info"],
  testcase_updated: ["Updated", "info"],
  zyra_updated: ["Updated", "ai"],
  zyra_moved_to_suite: ["Moved", "ai"],
  zyra_archived: ["Archived", "ai"],
  deleted: ["Deleted", "error"],
  testcase_deleted: ["Deleted", "error"],
  project_deleted: ["Deleted", "error"],
  testcase_bulk_created: ["Imported", "success"],
  testcase_bulk_updated: ["Bulk updated", "info"],
  testcase_bulk_deleted: ["Bulk deleted", "error"],
  approved: ["Approved", "success"],
  rejected: ["Rejected", "warning"],
  restored: ["Restored", "neutral"],
  restored_version: ["Restored", "neutral"],
  moved: ["Moved", "neutral"],
  renamed: ["Renamed", "neutral"],
  duplicated: ["Duplicated", "neutral"],
  uploaded: ["Uploaded", "info"],
  execution_evidence_uploaded: ["Evidence added", "info"],
  zyra_chat_ai_failed: ["AI error", "error"],
  project_member_added: ["Added", "success"],
  project_member_role_changed: ["Role changed", "info"],
  project_member_removed: ["Removed", "error"],
  workspace_member_added: ["Added", "success"],
  workspace_member_role_changed: ["Role changed", "info"],
  workspace_member_removed: ["Removed", "error"],
  invitation_sent: ["Invited", "info"],
  invitation_cancelled: ["Cancelled", "error"],
  invitation_resent: ["Resent", "info"],
  invitation_accepted: ["Joined", "success"],
  custom_field_created: ["Created", "success"],
  custom_field_renamed: ["Renamed", "neutral"],
  custom_field_required_toggled: ["Updated", "info"],
  custom_field_config_updated: ["Updated", "info"],
  custom_field_option_added: ["Option added", "success"],
  custom_field_option_deactivated: ["Option deactivated", "warning"],
  custom_field_option_reactivated: ["Option reactivated", "success"],
  custom_field_reordered: ["Reordered", "neutral"],
  custom_field_deactivated: ["Deactivated", "warning"],
  custom_field_reactivated: ["Activated", "success"],
  custom_field_archived: ["Archived", "error"],
  custom_field_deleted: ["Deleted", "error"],
  testcase_custom_field_updated: ["Custom field updated", "info"],
  commented: ["Commented", "neutral"],
  bug_created: ["Created", "success"],
  bug_updated: ["Updated", "info"],
  bug_status_changed: ["Status changed", "info"],
  bug_severity_changed: ["Severity changed", "info"],
  bug_priority_changed: ["Priority changed", "info"],
  bug_assignee_changed: ["Assigned", "info"],
  bug_attachment_added: ["Attachment added", "info"],
  bug_attachment_deleted: ["Attachment deleted", "error"],
  bug_mentioned: ["Mentioned", "neutral"],
  bug_deleted: ["Deleted", "error"],
};

export function actionMeta(action: string): [string, StatusChipProps["tone"]] {
  if (ACTION_META[action]) return ACTION_META[action];
  if (action.includes("delet")) return [titleCase(action), "error"];
  if (action.includes("approv")) return [titleCase(action), "success"];
  if (action.includes("reject") || action.includes("block")) return [titleCase(action), "warning"];
  if (action.startsWith("zyra")) return [titleCase(action.replace(/^zyra_/, "")), "ai"];
  if (action.includes("creat")) return [titleCase(action), "success"];
  if (action.includes("updat")) return [titleCase(action), "info"];
  return [titleCase(action), "neutral"];
}

export function titleCase(action: string): string {
  return action
    .replace(/^testcase_/, "")
    .replace(/^zyra_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const ENTITY_META: Record<string, [string, typeof IconFileText]> = {
  testcase: ["Test Case", IconFileText],
  suite: ["Suite", IconFolders],
  plan: ["Plan", IconClipboardList],
  cycle: ["Test Run", IconPlayerPlay],
  bug: ["Bug", IconBug],
  knowledge_folder: ["Folder", IconBooks],
  knowledge_document: ["Knowledge document", IconBooks],
  knowledge_file: ["File", IconPaperclip],
  execution: ["Execution", IconPlayerPlay],
  zyra_chat: ["Zyra chat", IconMessage],
  project: ["Project", IconFolder],
  project_member: ["Project member", IconUsers],
  workspace_member: ["Workspace member", IconUsers],
  invitation: ["Invitation", IconMail],
  custom_field_definition: ["Custom Field", IconStack2],
};

export function entityMeta(entityType: string): [string, typeof IconFileText] {
  return ENTITY_META[entityType] || [titleCase(entityType), IconFileText];
}

export function safeParseDiff(diff: string | null): Record<string, unknown> | null {
  if (!diff) return null;
  try {
    const parsed = JSON.parse(diff);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Derives a one-line description only from fields that genuinely changed or were logged —
// never fabricates copy for actions with no real diff/reason data behind them.
export function describeActivity(item: ActivityLogItem): string | null {
  const diff = safeParseDiff(item.diff);
  if (item.action === "testcase_updated" && diff?.before && diff?.after) {
    const before = diff.before as Record<string, unknown>;
    const after = diff.after as Record<string, unknown>;
    if (before.status !== after.status && after.status) return `Status changed to ${after.status}.`;
    if (before.priority !== after.priority && after.priority) return `Priority changed to ${after.priority}.`;
    if (before.suite_id !== after.suite_id) return "Moved to a different suite.";
  }
  if (diff?.reason && typeof diff.reason === "string") return diff.reason;
  if (item.action === "zyra_moved_to_suite" && typeof diff?.movedCount === "number") {
    return `Moved ${diff.movedCount} test case${diff.movedCount === 1 ? "" : "s"} to this suite.`;
  }
  if (item.action === "testcase_bulk_created" && Array.isArray(diff?.testcaseIds)) {
    return `Imported ${(diff.testcaseIds as unknown[]).length} test case(s).`;
  }
  if (item.action === "testcase_bulk_updated" && Array.isArray(diff?.testcaseIds)) {
    return `Bulk-updated ${(diff.testcaseIds as unknown[]).length} test case(s).`;
  }
  if (item.action === "testcase_bulk_deleted" && Array.isArray(diff?.testcaseIds)) {
    return `Deleted ${(diff.testcaseIds as unknown[]).length} test case(s).`;
  }
  if (item.action === "execution_evidence_uploaded" && Array.isArray(diff?.files)) {
    const count = (diff.files as unknown[]).length;
    return `${count} file${count === 1 ? "" : "s"} attached as evidence.`;
  }
  if (item.action === "zyra_chat_ai_failed" && typeof diff?.message === "string") {
    return diff.message;
  }
  if ((item.action === "project_member_role_changed" || item.action === "workspace_member_role_changed") && diff?.from && diff?.to) {
    return `Role changed from ${diff.from} to ${diff.to}.`;
  }
  if ((item.action === "project_member_added" || item.action === "workspace_member_added") && typeof diff?.role === "string") {
    return `Added as ${diff.role}.`;
  }
  if ((item.action === "project_member_removed" || item.action === "workspace_member_removed") && typeof diff?.role === "string") {
    return `Removed (was ${diff.role}).`;
  }
  if (item.action === "invitation_sent" && typeof diff?.role === "string") {
    return `Invited as ${diff.role}.`;
  }
  if (item.action === "invitation_accepted" && typeof diff?.role === "string") {
    return `Joined as ${diff.role}.`;
  }
  if ((item.action === "bug_status_changed" || item.action === "bug_severity_changed" || item.action === "bug_priority_changed") && diff) {
    const field = item.action.replace(/^bug_|_changed$/g, "");
    return `${field.charAt(0).toUpperCase()}${field.slice(1)} changed from ${diff.from || "None"} to ${diff.to || "None"}.`;
  }
  if (item.action === "bug_assignee_changed" && diff) {
    return diff.toName ? `Assigned to ${diff.toName}.` : "Unassigned.";
  }
  if ((item.action === "bug_attachment_added" || item.action === "bug_attachment_deleted") && typeof diff?.fileName === "string") {
    return diff.fileName;
  }
  if (item.action === "bug_mentioned" && typeof diff?.mentionedName === "string") {
    return `Mentioned ${diff.mentionedName} in a comment.`;
  }
  if (item.action === "project_created") return "Project created.";
  if (item.action === "project_deleted") return "Project deleted.";
  if (item.action === "testcase_custom_field_updated" && typeof diff?.fieldName === "string") {
    const after = diff.after;
    if (after == null || after === "" || (Array.isArray(after) && after.length === 0)) {
      return `Custom field "${diff.fieldName}" cleared.`;
    }
    return `Custom field "${diff.fieldName}" changed to ${JSON.stringify(after)}.`;
  }
  if (item.action === "custom_field_renamed" && typeof diff?.before === "string" && typeof diff?.after === "string") {
    return `Renamed from "${diff.before}" to "${diff.after}".`;
  }
  if (item.action === "custom_field_required_toggled") {
    return diff?.after ? "Marked as required." : "Marked as optional.";
  }
  if ((item.action === "custom_field_option_added" || item.action === "custom_field_option_deactivated" || item.action === "custom_field_option_reactivated") && typeof diff?.label === "string") {
    return `Option "${diff.label}".`;
  }
  return null;
}

export function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function groupByDate<T extends ActivityLogItem>(items: T[]): { label: string; items: T[] }[] {
  const groups: Map<string, T[]> = new Map();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const item of items) {
    const d = new Date(item.createdAt);
    let label: string;
    if (d.toDateString() === today.toDateString()) label = "Today";
    else if (d.toDateString() === yesterday.toDateString()) label = "Yesterday";
    else label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

export function ZyraMark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, background: "linear-gradient(135deg, #7C5FCC 0%, #4F46E5 100%)" }}
    >
      <IconSparkles size={Math.round(size * 0.5)} stroke={1.9} className="text-white" />
    </div>
  );
}

export function ActorAvatar({ item }: { item: ActivityLogItem }) {
  if (item.actorKind === "agent" && item.actorName) return <ZyraMark size={32} />;
  const name = item.actorName || item.actorEmail;
  if (name) return <OwnerAvatar name={name} seed={item.actorId} />;
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
      style={{ background: "var(--surface-secondary)", color: "var(--muted)" }}
      title="System"
    >
      SY
    </span>
  );
}

// Shared feed row. When `item.projectName` is present (the workspace-wide feed spans
// multiple projects), a small project label is shown next to the entity chip so an
// owner can tell at a glance which project a row belongs to.
export function ActivityRow({ item }: { item: AnyActivityLogItem }) {
  const [badgeLabel, tone] = actionMeta(item.action);
  const [entityLabel, EntityIcon] = entityMeta(item.entityType);
  const actorDisplay = item.actorKind === "agent" ? item.actorName || "Zyra" : item.actorName || item.actorEmail || "System";
  const description = describeActivity(item);

  return (
    <div className="grid grid-cols-[32px_1fr_auto] items-start gap-3 py-3">
      <ActorAvatar item={item} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[13px] font-medium"
            style={{ color: item.actorKind === "agent" ? "var(--ai-primary)" : "var(--foreground)" }}
          >
            {actorDisplay}
          </span>
          <StatusChip tone={tone}>{badgeLabel}</StatusChip>
          <span className="flex items-center gap-1 text-[13px] text-[var(--muted)]">
            <EntityIcon size={13} stroke={1.75} />
            {entityLabel}
          </span>
          {item.entityName && <span className="text-[13px] font-medium text-[var(--foreground)]">{item.entityName}</span>}
          {item.projectName && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
              <IconFolder size={11} stroke={1.75} />
              {item.projectName}
            </span>
          )}
        </div>
        {description && <p className="mt-1 text-[12px] text-[var(--muted-soft)]">{description}</p>}
      </div>
      <div className="shrink-0 text-right" title={formatAbsolute(item.createdAt)}>
        <div className="text-[12px] text-[var(--muted)]">{formatRelative(item.createdAt)}</div>
        <div className="mt-0.5 font-mono text-[11px] text-[var(--muted-soft)]">{formatAbsolute(item.createdAt)}</div>
      </div>
    </div>
  );
}

function SummaryCardHeader({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">{children}</div>
  );
}

const WEEKLY_ROWS: { key: keyof ActivitySummary["weekly"]; label: string; dot: string }[] = [
  { key: "created", label: "Created", dot: "bg-[var(--success)]" },
  { key: "updated", label: "Updated", dot: "bg-[var(--info)]" },
  { key: "aiActions", label: "AI Actions", dot: "bg-[var(--ai-primary)]" },
  { key: "deleted", label: "Deleted", dot: "bg-[var(--error)]" },
];

export function ActivitySummaryPanel({ summary }: { summary: ActivitySummary | null }) {
  if (!summary || summary.weekly.total === 0) return null;
  const topMemberCount = summary.activeMembers[0]?.count || 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="p-4">
          <SummaryCardHeader>This week</SummaryCardHeader>
          <div className="flex flex-col">
            {WEEKLY_ROWS.map((row, i) => (
              <div
                key={row.key}
                className={cx(
                  "flex items-center justify-between py-2",
                  i < WEEKLY_ROWS.length - 1 && "border-b border-[var(--border-subtle)]"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", row.dot)} aria-hidden />
                  <span className="text-[12px] text-[var(--muted)]">{row.label}</span>
                </div>
                <span className="text-[13px] font-semibold text-[var(--foreground)]">{summary.weekly[row.key]}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-[var(--border-subtle)] pt-3">
            <span className="text-[11px] text-[var(--muted)]">Total events</span>
            <span className="text-[13px] font-bold text-[var(--foreground)]">{summary.weekly.total}</span>
          </div>
        </CardBody>
      </Card>

      {summary.activeMembers.length > 0 && (
        <Card>
          <CardBody className="p-4">
            <SummaryCardHeader>Active members</SummaryCardHeader>
            <div className="flex flex-col gap-3">
              {summary.activeMembers.map((m) => {
                const isAgent = m.actorKind === "agent";
                const label = isAgent ? m.actorName || "Zyra AI" : m.actorName || m.actorEmail || "Unknown";
                const pct = Math.round((m.count / topMemberCount) * 100);
                return (
                  <div key={m.actorId} className="flex items-center gap-2.5">
                    {isAgent ? <ZyraMark size={24} /> : <OwnerAvatar name={label} seed={m.actorId} />}
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[12px] font-medium"
                        style={{ color: isAgent ? "var(--ai-primary)" : "var(--foreground)" }}
                      >
                        {label}
                      </div>
                      <div className="text-[11px] text-[var(--muted)]">
                        {m.count} action{m.count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="h-[3px] w-12 shrink-0 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: isAgent ? "var(--ai-primary)" : "var(--brand-primary)" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {summary.byEntityType.length > 0 && (
        <Card>
          <CardBody className="p-4">
            <SummaryCardHeader>By entity type</SummaryCardHeader>
            <div className="flex flex-col gap-2.5">
              {summary.byEntityType.map((e) => {
                const [label, Icon] = entityMeta(e.entityType);
                return (
                  <div key={e.entityType} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} stroke={1.75} className="text-[var(--muted)]" />
                      <span className="text-[12px] text-[var(--muted)]">{label}</span>
                    </div>
                    <span className="text-[12px] font-medium text-[var(--foreground)]">{e.count}</span>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
