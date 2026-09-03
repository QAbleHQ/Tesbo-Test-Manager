import type { HTMLAttributes } from "react";
import {
  IconChevronsUp,
  IconChevronUp,
  IconMinus,
  IconChevronDown,
} from "@tabler/icons-react";
import { cx } from "@/components/ui/cx";

export type Priority = "critical" | "high" | "medium" | "low";

const priorityConfig: Record<
  Priority,
  { label: string; color: string; Icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }> }
> = {
  // Theme tokens, not literal hexes: the fixed colours these carried never followed the theme, so
  // three of the four sat at 1.96–2.23:1 in dark mode, and "High" was unreadable in light too.
  critical: { label: "Critical", color: "var(--error-foreground)", Icon: IconChevronsUp },
  high:     { label: "High",     color: "var(--warning-foreground)", Icon: IconChevronUp },
  medium:   { label: "Medium",   color: "var(--status-notrun-text)", Icon: IconMinus },
  low:      { label: "Low",      color: "var(--success-foreground)", Icon: IconChevronDown },
};

export type PriorityBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  priority: Priority;
};

export default function PriorityBadge({ priority, className, ...props }: PriorityBadgeProps) {
  const { label, color, Icon } = priorityConfig[priority];

  return (
    <span
      className={cx("inline-flex items-center gap-1 text-[12px] font-medium", className)}
      style={{ color }}
      {...props}
    >
      <Icon size={14} stroke={2} />
      {label}
    </span>
  );
}
