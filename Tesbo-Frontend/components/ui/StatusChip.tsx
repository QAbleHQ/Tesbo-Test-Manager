import type { HTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

type StatusTone = "neutral" | "brand" | "ai" | "success" | "warning" | "error" | "info";

const toneMap: Record<StatusTone, string> = {
  neutral: "bg-[var(--surface-tertiary)] text-[var(--foreground)]",
  brand: "bg-[var(--brand-soft)] text-[var(--brand-primary)]",
  ai: "bg-[var(--ai-soft)] text-[var(--ai-primary)]",
  success: "bg-[var(--success-soft)] text-[var(--success)]",
  warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
  error: "bg-[var(--error-soft)] text-[var(--error)]",
  info: "bg-[var(--info-soft)] text-[var(--info)]",
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
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold",
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
