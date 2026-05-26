import type { HTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

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
  | "confidenceLow";

const toneMap: Record<StatusTone, string> = {
  neutral: "border border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]",
  brand: "border border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--brand-primary)]",
  ai: "border border-[var(--ai-border)] bg-[var(--ai-soft)] text-[var(--ai-primary)]",
  success: "border border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success-foreground)]",
  warning: "border border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning-foreground)]",
  error: "border border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--error-foreground)]",
  info: "border border-[var(--info-border)] bg-[var(--info-soft)] text-[var(--info-foreground)]",
  confidenceHigh:
    "border border-[var(--confidence-high-border)] bg-[var(--confidence-high-soft)] text-[var(--confidence-high-foreground)]",
  confidenceMedium:
    "border border-[var(--confidence-medium-border)] bg-[var(--confidence-medium-soft)] text-[var(--confidence-medium-foreground)]",
  confidenceLow:
    "border border-[var(--confidence-low-border)] bg-[var(--confidence-low-soft)] text-[var(--confidence-low-foreground)]",
};

export type StatusChipProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusTone;
  live?: boolean;
};

export default function StatusChip({
  className,
  tone = "neutral",
  live = false,
  children,
  ...props
}: StatusChipProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold",
        toneMap[tone],
        className,
      )}
      {...props}
    >
      {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}
