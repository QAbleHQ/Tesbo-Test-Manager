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
  critical: { label: "Critical", color: "#A32D2D", Icon: IconChevronsUp },
  high:     { label: "High",     color: "#D97C0A", Icon: IconChevronUp },
  medium:   { label: "Medium",   color: "#185FA5", Icon: IconMinus },
  low:      { label: "Low",      color: "#3B6D11", Icon: IconChevronDown },
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
