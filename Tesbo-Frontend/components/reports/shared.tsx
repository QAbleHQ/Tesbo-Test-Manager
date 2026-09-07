"use client";

import { Card } from "@/components/ui";

export function statusTone(
  s: string | null,
): "neutral" | "brand" | "ai" | "success" | "warning" | "error" | "info" | "blocked" | "skipped" | "retest" | "notRun" {
  if (!s) return "neutral";
  const map: Record<string, "success" | "error" | "warning" | "info" | "neutral" | "blocked" | "skipped" | "retest" | "notRun"> = {
    Passed: "success", Failed: "error", Skipped: "skipped", Blocked: "blocked", Retest: "retest",
    Untested: "notRun", Open: "error", Closed: "success", "In Progress": "info", Planning: "warning",
    Completed: "success", Draft: "neutral", Approved: "success", "In Review": "info", Deprecated: "neutral",
  };
  return map[s] ?? "neutral";
}

export function MetricCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <Card className="p-4 text-center">
      <p className="text-[20px] font-bold leading-none" style={{ color: color ?? "var(--foreground)" }}>{value}</p>
      <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">{label}</p>
      {sub && <p className="mt-1 text-[11px] text-[var(--muted-soft)]">{sub}</p>}
    </Card>
  );
}

export function SectionCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[var(--foreground)]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-[13px] text-[var(--muted-soft)]">{label}</p>
    </div>
  );
}
