import Link from "next/link";
import {
  IconPencil,
  IconPlayerPlay,
  IconClock,
  IconTrash,
} from "@tabler/icons-react";
import { Card } from "@/components/ui";
import type { PlanListItem } from "@/lib/api";
import { computePassRate } from "@/lib/executionMetrics";

export type PlanStatus = "active" | "draft";

const STATUS_META: Record<PlanStatus, { label: string; text: string; dot: string; fill: string }> = {
  active: { label: "Active", text: "var(--status-pass-text)", dot: "var(--status-pass-dot)", fill: "var(--status-pass-fill)" },
  draft: { label: "Draft", text: "var(--muted)", dot: "var(--muted-soft)", fill: "var(--surface-tertiary)" },
};

import { avatarColor } from "@/lib/avatarColors";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function planStatus(plan: PlanListItem): PlanStatus {
  return plan.runCount > 0 ? "active" : "draft";
}

export function formatLastRun(lastRunAt: string | null): string {
  if (!lastRunAt) return "Never run";
  const ts = new Date(lastRunAt).getTime();
  if (Number.isNaN(ts)) return "Never run";
  const diffMs = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "Ran just now";
  if (diffMs < hour) return `Ran ${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `Ran ${Math.floor(diffMs / hour)}h ago`;
  return `Ran ${Math.floor(diffMs / day)}d ago`;
}

function passRateColor(pct: number): string {
  if (pct >= 90) return "var(--success)";
  if (pct >= 70) return "var(--warning)";
  return "var(--error)";
}

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium"
      style={{ background: meta.fill, color: meta.text }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

// Seeded on the owner's id, not their name — matches every other person avatar (top bar, team
// avatars, activity, admins) so the same person keeps the same colour everywhere. Part of
// Basecamp 10198836413.
export function OwnerAvatar({ name, seed }: { name: string; seed?: string | null }) {
  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
      style={{ background: avatarColor(seed || name) }}
      title={name}
    >
      {getInitials(name)}
    </span>
  );
}

function PassRateBar({ passed, failed, blocked }: { passed: number; failed: number; blocked: number }) {
  const total = passed + failed + blocked;
  const pct = computePassRate({ passed, failed, blocked });
  const width = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</span>
        <span className="font-mono text-[12px] font-semibold" style={{ color: pct !== null ? passRateColor(pct) : "var(--muted-soft)" }}>
          {pct !== null ? `${pct}%` : "No runs"}
        </span>
      </div>
      <div className="flex h-[5px] gap-0.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        {passed > 0 && <div className="h-full" style={{ width: width(passed), background: "var(--status-pass-dot)" }} />}
        {failed > 0 && <div className="h-full" style={{ width: width(failed), background: "var(--status-fail-dot)" }} />}
        {blocked > 0 && <div className="h-full" style={{ width: width(blocked), background: "var(--status-blocked-dot)" }} />}
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-pass-dot)" }} />
          {passed} passed
        </span>
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-fail-dot)" }} />
          {failed} failed
        </span>
        {blocked > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-blocked-dot)" }} />
            {blocked} blocked
          </span>
        )}
      </div>
    </div>
  );
}

type PlanCardProps = {
  plan: PlanListItem;
  projectId: string;
  ownerName: string | null;
  canManage: boolean;
  onDelete: (plan: PlanListItem) => void;
};

export function PlanCard({ plan, projectId, ownerName, canManage, onDelete }: PlanCardProps) {
  const status = planStatus(plan);
  const detailHref = `/projects/${projectId}/plans/${plan.id}`;

  return (
    <Card className="group relative flex h-full flex-col p-5 transition-colors hover:border-[var(--border-strong)]">
      <div className="mb-3.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={detailHref} className="truncate text-[14px] font-semibold text-[var(--foreground)] hover:text-[var(--accent-light)]">
              {plan.name}
            </Link>
            <PlanStatusBadge status={status} />
            {plan.targetRelease && (
              <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--ai-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ai-primary)]">
                {plan.targetRelease}
              </span>
            )}
          </div>
          {plan.description && (
            <p className="mt-1 line-clamp-1 text-[12px] leading-5 text-[var(--muted-soft)]">{plan.description}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Link
            href={detailHref}
            title="Open plan"
            className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
          >
            <IconPlayerPlay size={13} stroke={1.75} />
          </Link>
          <Link
            href={detailHref}
            title="Edit plan"
            className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
          >
            <IconPencil size={13} stroke={1.75} />
          </Link>
          {canManage && (
            <button
              type="button"
              title="Delete plan"
              onClick={() => onDelete(plan)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:border-[var(--error)] hover:text-[var(--error-foreground)]"
            >
              <IconTrash size={13} stroke={1.75} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-3.5">
        <PassRateBar passed={plan.passed} failed={plan.failed} blocked={plan.blocked} />
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--border-subtle)] pt-3">
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
          <IconPlayerPlay size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
          <span className="font-mono text-[var(--foreground)]">{plan.runCount}</span> runs
        </span>
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted-soft)]">
          <IconClock size={13} stroke={1.75} />
          {formatLastRun(plan.lastRunAt)}
        </span>
        <div className="flex-1" />
        {ownerName && <OwnerAvatar name={ownerName} seed={plan.ownerId} />}
      </div>
    </Card>
  );
}
