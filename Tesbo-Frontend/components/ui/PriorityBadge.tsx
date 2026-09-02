import type { HTMLAttributes } from "react";
import StatusChip, { type StatusChipProps } from "@/components/ui/StatusChip";

export type Priority = "P0" | "P1" | "P2" | "P3";

/*
 * Basecamp 10259699278 — Test case/bug priority (P0–P3) was rendered three different ways across
 * the Test Case Repository, a Test Run, and the Plans page: a StatusChip fighting its own defaults
 * via `!important` overrides, a hand-rolled dot + monospace text with no chip at all, and (worst)
 * relabelled to word severity levels here on Plans. One StatusChip tone map, used everywhere,
 * keeps a P1 the same shape, size and colour no matter which screen it's read from.
 */
const PRIORITY_TONE: Record<Priority, StatusChipProps["tone"]> = {
  P0: "error",
  P1: "warning",
  P2: "info",
  P3: "neutral",
};

export type PriorityBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  priority: Priority;
};

export default function PriorityBadge({ priority, className, ...props }: PriorityBadgeProps) {
  return (
    <StatusChip tone={PRIORITY_TONE[priority]} className={className} {...props}>
      {priority}
    </StatusChip>
  );
}
