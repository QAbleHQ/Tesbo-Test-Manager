// Sitewide number display format, the counterpart of lib/date.ts. A count shown to a user goes
// through formatNumber so large values read as 5,65,010 rather than 565010.
//
// The locale is fixed (en-IN: the first group is three digits, the rest are two) rather than the
// viewer's own, so the server render and the browser agree and every user sees the same grouping.
// Values under 1,000 are unchanged.

const GROUPED = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return GROUPED.format(value);
}
