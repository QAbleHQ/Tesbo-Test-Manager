import { avatarColor } from "@/lib/avatarColors";

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function statusTone(status: string): "neutral" | "brand" | "ai" | "success" | "warning" | "error" | "info" {
  switch (status) {
    case "Planning":
      return "warning";
    case "In Progress":
      return "info";
    case "Completed":
      return "success";
    default:
      return "neutral";
  }
}

export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const totalMinutes = Math.round((end - start) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatDate(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function RunAvatar({ name }: { name: string }) {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold tracking-wide text-white"
      style={{ background: avatarColor(name) }}
    >
      {getInitials(name)}
    </div>
  );
}

export function RunProgressBar({
  passed,
  failed,
  blocked,
  skipped,
  total,
}: {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  total: number;
}) {
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="flex h-[5px] gap-0.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
      {passed > 0 && <div className="h-full" style={{ width: pct(passed), background: "var(--status-pass-dot)" }} />}
      {failed > 0 && <div className="h-full" style={{ width: pct(failed), background: "var(--status-fail-dot)" }} />}
      {blocked > 0 && <div className="h-full" style={{ width: pct(blocked), background: "var(--status-blocked-dot)" }} />}
      {skipped > 0 && <div className="h-full" style={{ width: pct(skipped), background: "var(--status-skipped-dot)" }} />}
    </div>
  );
}
