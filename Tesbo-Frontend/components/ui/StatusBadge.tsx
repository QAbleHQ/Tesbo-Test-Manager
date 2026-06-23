import type { HTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

/**
 * Test execution state badge — 6px dot + label text, pill-shaped, tinted fill.
 * Implements the Tesbo Design Guidelines v2 status badge spec exactly.
 */
export type TestStatus =
  | "pass"
  | "fail"
  | "blocked"
  | "skipped"
  | "in_review"
  | "draft"
  | "running"
  | "not_run";

const statusConfig: Record<
  TestStatus,
  { label: string; textVar: string; dotVar: string; fillVar: string; pulse?: boolean }
> = {
  pass: {
    label: "Pass",
    textVar: "--status-pass-text",
    dotVar: "--status-pass-dot",
    fillVar: "--status-pass-fill",
  },
  fail: {
    label: "Fail",
    textVar: "--status-fail-text",
    dotVar: "--status-fail-dot",
    fillVar: "--status-fail-fill",
  },
  blocked: {
    label: "Blocked",
    textVar: "--status-blocked-text",
    dotVar: "--status-blocked-dot",
    fillVar: "--status-blocked-fill",
  },
  skipped: {
    label: "Skipped",
    textVar: "--status-skipped-text",
    dotVar: "--status-skipped-dot",
    fillVar: "--status-skipped-fill",
  },
  in_review: {
    label: "In review",
    textVar: "--status-inreview-text",
    dotVar: "--status-inreview-dot",
    fillVar: "--status-inreview-fill",
  },
  draft: {
    label: "Draft",
    textVar: "--status-draft-text",
    dotVar: "--status-draft-dot",
    fillVar: "--status-draft-fill",
  },
  running: {
    label: "Running",
    textVar: "--status-running-text",
    dotVar: "--status-running-dot",
    fillVar: "--status-running-fill",
    pulse: true,
  },
  not_run: {
    label: "Not run",
    textVar: "--status-notrun-text",
    dotVar: "--status-notrun-dot",
    fillVar: "--status-notrun-fill",
  },
};

export type StatusBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  status: TestStatus;
};

export default function StatusBadge({ status, className, ...props }: StatusBadgeProps) {
  const cfg = statusConfig[status];

  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-5 transition-colors duration-150", className)}
      style={{
        background: `var(${cfg.fillVar})`,
        color: `var(${cfg.textVar})`,
      }}
      {...props}
    >
      <span
        className={cx("h-1.5 w-1.5 shrink-0 rounded-full", cfg.pulse && "animate-pulse")}
        style={{ background: `var(${cfg.dotVar})` }}
        aria-hidden
      />
      {cfg.label}
    </span>
  );
}
