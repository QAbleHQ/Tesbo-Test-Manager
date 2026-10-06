"use client";

import type { BugPriority, BugSeverity } from "@/lib/api";
import { PriorityBadge, SeverityBadge, StatusChip } from "@/components/ui";
import { avatarColor } from "@/lib/avatarColors";

/*
 * Bug display primitives shared by the bugs list (app/(app)/projects/[id]/bugs/page.tsx) and the
 * full-page bug view (bugs/[bugId]/page.tsx). A Next.js page file cannot export these, so they live
 * here rather than being copied into each screen.
 */

export const BUG_STATUSES = ["Open", "In Progress", "Reopened", "Closed"] as const;
export const BUG_SEVERITIES: BugSeverity[] = ["Critical", "High", "Medium", "Low"];
/*
 * Basecamp 10226247009 — severity says how bad the defect is, priority says how soon it is worked
 * on. P0..P3 mirrors how test cases already express priority and stays visually distinct from
 * severity's words, so a row reading "Critical · P3" is unambiguous. Empty means untriaged.
 */
export const BUG_PRIORITIES: BugPriority[] = ["P0", "P1", "P2", "P3"];

export function BugPriorityBadge({ priority }: { priority: BugPriority | null }) {
  if (!priority) return <span className="text-xs text-[var(--muted-soft)]">—</span>;
  return <PriorityBadge priority={priority} />;
}

/* ───── Assignee avatar ─────
 * Seeded on the assignee's id, not their name, matching the same convention used for executions
 * (cycles/[cycleId]/page.tsx) so a person keeps the same colour everywhere they're shown assigned.
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function MemberAvatar({ name, seed, size = 20 }: { name: string; seed?: string | null; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border-2 border-[var(--surface)] font-semibold text-white"
      style={{ background: avatarColor(seed || name), width: size, height: size, fontSize: size * 0.42 }}
      title={name}
    >
      {getInitials(name)}
    </span>
  );
}

export function BugAssignee({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-xs text-[var(--muted-soft)]">Unassigned</span>;
  // Assigned, but the join in bugSelect turned up no actor_profiles row (a deleted actor). Still a
  // real assignment — distinct from Unassigned — just with nothing to render a name or colour from.
  if (!name) return <span className="text-xs text-[var(--muted-soft)]">Unknown assignee</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <MemberAvatar name={name} seed={id} size={20} />
      <span className="text-xs text-[var(--muted)] truncate max-w-[120px]" title={name}>
        {name}
      </span>
    </span>
  );
}

const STATUS_TONE: Record<string, "error" | "success" | "info" | "warning"> = {
  Open: "error",
  Closed: "success",
  "In Progress": "info",
  Reopened: "warning",
};

/* ───── Status badge ───── */
export function BugStatusBadge({ status }: { status: string }) {
  return (
    <StatusChip tone={STATUS_TONE[status] || "error"}>{status}</StatusChip>
  );
}

/* ───── Severity badge ───── */
export function BugSeverityBadge({ severity }: { severity: BugSeverity | null }) {
  // Not selected renders the same as an untriaged priority (BugPriorityBadge above).
  if (!severity) return <span className="text-xs text-[var(--muted-soft)]">—</span>;
  return <SeverityBadge severity={severity} />;
}
