import type { HTMLAttributes } from "react";
import StatusChip, { type StatusChipProps } from "@/components/ui/StatusChip";

export type Severity = "Critical" | "High" | "Medium" | "Low";

// See PriorityBadge's comment (Basecamp 10259699278) — same fix, for bug severity.
const SEVERITY_TONE: Record<Severity, StatusChipProps["tone"]> = {
  Critical: "error",
  High: "warning",
  Medium: "neutral",
  Low: "success",
};

export type SeverityBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  severity: Severity;
};

export default function SeverityBadge({ severity, className, ...props }: SeverityBadgeProps) {
  return (
    <StatusChip tone={SEVERITY_TONE[severity]} className={className} {...props}>
      {severity}
    </StatusChip>
  );
}
