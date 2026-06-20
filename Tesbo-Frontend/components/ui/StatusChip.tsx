import type { HTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

// Generic UI tones (for non-test-execution use)
type StatusTone =
  | "neutral"
  | "brand"
  | "ai"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "confidenceHigh"
  | "confidenceMedium"
  | "confidenceLow"
  // Test execution states (maps to the 8 semantic status tokens)
  | "pass"
  | "fail"
  | "blocked"
  | "skipped"
  | "inReview"
  | "draft"
  | "running"
  | "notRun";

const toneMap: Record<StatusTone, { chip: string; dot: string }> = {
  neutral: {
    chip: "border border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]",
    dot: "bg-[var(--ink-400)]",
  },
  brand: {
    chip: "border border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--brand-primary)]",
    dot: "bg-[var(--brand-primary)]",
  },
  ai: {
    chip: "border border-[var(--ai-border)] bg-[var(--ai-soft)] text-[var(--ai-primary)]",
    dot: "bg-[var(--ai-primary)]",
  },
  success: {
    chip: "border border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success-foreground)]",
    dot: "bg-[var(--success)]",
  },
  warning: {
    chip: "border border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning-foreground)]",
    dot: "bg-[var(--warning)]",
  },
  error: {
    chip: "border border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--error-foreground)]",
    dot: "bg-[var(--error)]",
  },
  info: {
    chip: "border border-[var(--info-border)] bg-[var(--info-soft)] text-[var(--info-foreground)]",
    dot: "bg-[var(--info)]",
  },
  confidenceHigh: {
    chip: "border border-[var(--confidence-high-border)] bg-[var(--confidence-high-soft)] text-[var(--confidence-high-foreground)]",
    dot: "bg-[var(--confidence-high)]",
  },
  confidenceMedium: {
    chip: "border border-[var(--confidence-medium-border)] bg-[var(--confidence-medium-soft)] text-[var(--confidence-medium-foreground)]",
    dot: "bg-[var(--confidence-medium)]",
  },
  confidenceLow: {
    chip: "border border-[var(--confidence-low-border)] bg-[var(--confidence-low-soft)] text-[var(--confidence-low-foreground)]",
    dot: "bg-[var(--confidence-low)]",
  },
  // ── Test execution states ──────────────────────────────────────────
  pass: {
    chip: "bg-[var(--status-pass-fill)] text-[var(--status-pass-text)]",
    dot: "bg-[var(--status-pass-dot)]",
  },
  fail: {
    chip: "bg-[var(--status-fail-fill)] text-[var(--status-fail-text)]",
    dot: "bg-[var(--status-fail-dot)]",
  },
  blocked: {
    chip: "bg-[var(--status-blocked-fill)] text-[var(--status-blocked-text)]",
    dot: "bg-[var(--status-blocked-dot)]",
  },
  skipped: {
    chip: "bg-[var(--status-skipped-fill)] text-[var(--status-skipped-text)]",
    dot: "bg-[var(--status-skipped-dot)]",
  },
  inReview: {
    chip: "bg-[var(--status-inreview-fill)] text-[var(--status-inreview-text)]",
    dot: "bg-[var(--status-inreview-dot)]",
  },
  draft: {
    chip: "bg-[var(--status-draft-fill)] text-[var(--status-draft-text)]",
    dot: "bg-[var(--status-draft-dot)]",
  },
  running: {
    chip: "bg-[var(--status-running-fill)] text-[var(--status-running-text)]",
    dot: "bg-[var(--status-running-dot)]",
  },
  notRun: {
    chip: "bg-[var(--status-notrun-fill)] text-[var(--status-notrun-text)]",
    dot: "bg-[var(--status-notrun-dot)]",
  },
};

export type StatusChipProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTone;
  /** Show animated pulse dot (for live/running states) */
  live?: boolean;
  /** Always show the status dot */
  dot?: boolean;
};

export default function StatusChip({
  className,
  tone = "neutral",
  live = false,
  dot = false,
  children,
  ...props
}: StatusChipProps) {
  const { chip, dot: dotColor } = toneMap[tone];
  const showDot = live || dot;

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-5",
        chip,
        className,
      )}
      {...props}
    >
      {showDot ? (
        <span
          className={cx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            dotColor,
            live && "animate-pulse",
          )}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}
