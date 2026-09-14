"use client";

/* ═══════════════════ Shared chart primitives for Reports & Insights ═══════════════════ */

export const STATUS_COLORS: Record<string, string> = {
  Passed: "var(--status-pass-dot)",
  Failed: "var(--status-fail-dot)",
  Blocked: "var(--status-blocked-dot)",
  Skipped: "var(--status-skipped-dot)",
  Untested: "var(--status-notrun-dot)",
  Retest: "var(--status-retest-dot)",
};

export const STATUS_KEYS = ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"] as const;

export const PRIORITY_COLORS: Record<string, string> = {
  P0: "var(--error)",
  P1: "var(--warning)",
  P2: "var(--info)",
  P3: "var(--muted-soft)",
};

export { AVATAR_COLORS as SUITE_PALETTE } from "@/lib/avatarColors";

export function DonutChart({
  data,
  size = 160,
  centerLabel,
  centerSub,
}: {
  data: { label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--border)" strokeWidth="3" />
        <text x="18" y="19.5" textAnchor="middle" className="text-[3.5px] fill-[var(--muted-soft)] font-medium">
          No data
        </text>
      </svg>
    );
  }
  const radius = 15.915;
  const circumference = 2 * Math.PI * radius;
  const segments = data.reduce<{ label: string; value: number; color: string; pct: number; cumulative: number }[]>((acc, d) => {
    const pct = d.value / total;
    const cumulative = acc.length > 0 ? acc[acc.length - 1].cumulative + acc[acc.length - 1].pct : 0;
    return [...acc, { ...d, pct, cumulative }];
  }, []);

  return (
    <svg width={size} height={size} viewBox="0 0 36 36">
      {segments.map((d) => {
        if (d.value === 0) return null;
        const segmentLength = d.pct * circumference;
        const dashArray = `${segmentLength} ${circumference - segmentLength}`;
        const dashOffset = -d.cumulative * circumference;
        return (
          <circle
            key={d.label}
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            stroke={d.color}
            strokeWidth="3.5"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 18 18)"
          />
        );
      })}
      <text x="18" y="17" textAnchor="middle" className="text-[5px] font-bold fill-[var(--foreground)]">
        {centerLabel ?? total}
      </text>
      <text x="18" y="21" textAnchor="middle" className="text-[2.5px] fill-[var(--muted-soft)] font-medium">
        {centerSub || "Total"}
      </text>
    </svg>
  );
}

export function HorizontalBarChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-2.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 truncate text-right text-[12px] text-[var(--muted)]">{d.label}</span>
          <div className="h-5 flex-1 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${(d.value / max) * 100}%`, background: d.color, minWidth: d.value > 0 ? "8px" : "0px" }}
            />
          </div>
          <span className="w-8 shrink-0 text-right font-mono text-[12px] font-medium text-[var(--muted)]">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

export function StackedBarChart<T extends { groupId: string; groupName: string; total: number }>({
  rows,
  statusKeys = STATUS_KEYS as unknown as string[],
}: {
  rows: T[];
  statusKeys?: string[];
}) {
  if (rows.length === 0) return <p className="py-8 text-center text-[13px] text-[var(--muted-soft)]">No data available</p>;
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.groupId} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-right text-[12px] text-[var(--muted)]" title={row.groupName}>
            {row.groupName}
          </span>
          <div className="flex h-6 flex-1 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
            {statusKeys.map((status) => {
              const val = Number((row as unknown as Record<string, number | string>)[status]) || 0;
              if (val === 0) return null;
              const pct = (val / maxTotal) * 100;
              return (
                <div
                  key={status}
                  className="h-full transition-all duration-500"
                  style={{ width: `${pct}%`, background: STATUS_COLORS[status], minWidth: "4px" }}
                  title={`${status}: ${val}`}
                />
              );
            })}
          </div>
          <span className="w-8 shrink-0 text-right font-mono text-[12px] font-medium text-[var(--muted)]">{row.total}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════ Line / area chart — used for pass-rate trend sparklines ═══════════════════ */
export function TrendLineChart({
  points,
  labels,
  width = 600,
  height = 140,
  color = "var(--brand-primary)",
}: {
  points: (number | null)[];
  labels?: string[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const valid = points.filter((p): p is number => p !== null);
  if (valid.length === 0) {
    return <p className="py-8 text-center text-[13px] text-[var(--muted-soft)]">Not enough run history yet</p>;
  }
  const padX = 8;
  const padY = 12;
  const w = width - padX * 2;
  const h = height - padY * 2;
  const min = Math.min(0, ...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const tx = (i: number) => padX + (points.length > 1 ? (i / (points.length - 1)) * w : w / 2);
  const ty = (v: number) => padY + h - ((v - min) / range) * h;

  const coords = points.map((v, i) => (v === null ? null : { x: tx(i), y: ty(v) }));
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const c of coords) {
    if (c === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(c);
    }
  }
  if (current.length) segments.push(current);

  const gradId = `tlc-${color.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height, overflow: "visible" }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {segments.map((seg, si) => {
        const line = seg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        const area = `${line} L${seg[seg.length - 1].x.toFixed(1)},${(padY + h).toFixed(1)} L${seg[0].x.toFixed(1)},${(padY + h).toFixed(1)} Z`;
        return (
          <g key={si}>
            <path d={area} fill={`url(#${gradId})`} />
            <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            {seg.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="3" fill={color} stroke="var(--surface)" strokeWidth="1.5" />
            ))}
          </g>
        );
      })}
      {labels && labels.length === points.length && (
        <>
          <text x={padX} y={height - 2} textAnchor="start" className="fill-[var(--muted-soft)]" style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}>
            {labels[0]}
          </text>
          <text x={width - padX} y={height - 2} textAnchor="end" className="fill-[var(--muted-soft)]" style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}>
            {labels[labels.length - 1]}
          </text>
        </>
      )}
    </svg>
  );
}

/* ═══════════════════ Simple vertical bar chart — execution velocity / bug discovery ═══════════════════ */
export function VerticalBarChart({
  data,
  width = 400,
  height = 100,
  color = "var(--brand-primary)",
}: {
  data: { label: string; value: number }[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length === 0) return <p className="py-8 text-center text-[13px] text-[var(--muted-soft)]">No data available</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const slot = width / data.length;
  const bw = Math.min(slot * 0.55, 48);
  return (
    <svg viewBox={`0 0 ${width} ${height + 18}`} className="w-full">
      {data.map((d, i) => {
        const bh = Math.max((d.value / max) * height, d.value > 0 ? 2 : 0);
        const x = i * slot + (slot - bw) / 2;
        return (
          <g key={i}>
            <rect x={x} y={height - bh} width={bw} height={bh} rx="3" fill={color} opacity={0.8} />
            <text
              x={x + bw / 2}
              y={height + 13}
              textAnchor="middle"
              className="fill-[var(--muted-soft)]"
              style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ═══════════════════ Health-score gauge (semi-circle, 0-100) ═══════════════════ */
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
}

function arcPath(cx: number, cy: number, r: number, ir: number, startAngle: number, endAngle: number) {
  const [sx, sy] = polarToCartesian(cx, cy, r, startAngle);
  const [ex, ey] = polarToCartesian(cx, cy, r, endAngle);
  const [ix, iy] = polarToCartesian(cx, cy, ir, endAngle);
  const [ox, oy] = polarToCartesian(cx, cy, ir, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M${sx.toFixed(1)},${sy.toFixed(1)} A${r},${r} 0 ${largeArc} 1 ${ex.toFixed(1)},${ey.toFixed(1)} L${ix.toFixed(1)},${iy.toFixed(1)} A${ir},${ir} 0 ${largeArc} 0 ${ox.toFixed(1)},${oy.toFixed(1)} Z`;
}

export function HealthGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const color = clamped >= 70 ? "var(--success)" : clamped >= 40 ? "var(--warning)" : "var(--error)";
  const track = arcPath(100, 110, 75, 59, 210, 510);
  const value = arcPath(100, 110, 75, 59, 210, 210 + (clamped / 100) * 300);
  return (
    <svg viewBox="0 0 200 160" className="block h-full w-full">
      <path d={track} fill="var(--surface-secondary)" />
      <path d={value} fill={color} />
      <text x="100" y="100" textAnchor="middle" dominantBaseline="middle" className="fill-[var(--foreground)] font-bold" style={{ fontSize: "28px" }}>
        {clamped}
      </text>
      <text x="100" y="120" textAnchor="middle" dominantBaseline="middle" className="fill-[var(--muted-soft)]" style={{ fontSize: "11px" }}>
        / 100
      </text>
    </svg>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: it.color }} />
          {it.label}
        </div>
      ))}
    </div>
  );
}
