// Sitewide date/time display format. Every place a timestamp is shown to a user should go through
// one of these instead of calling toLocaleDateString/toLocaleString directly — bare calls render
// differently per viewer OS/browser locale, which is the inconsistency this file exists to remove.
//
// Standard shapes:
//   formatDate:     "05 Oct 2026"
//   formatTime:     "06:21 PM"
//   formatDateTime: "05 Oct 2026, 06:21 PM"
//   formatRelative: "Just now" / "5m ago" / "2h ago" / "Yesterday" / "3d ago", falling back to
//                   formatDate once older than a week.
//
// `locale` is optional and only needed where a surface already supports translation (Zyra/agents,
// via lib/zyra-i18n.ts's `t.locale`) — it localizes month names and the AM/PM marker while keeping
// the same "DD Mon YYYY" / "HH:MM <period>" shape, built from Intl.DateTimeFormat parts rather than
// locale-ordered output so the shape itself never varies by locale.

export type DateInput = string | number | Date | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function partsOf(date: Date, locale: string | undefined, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat(locale, options).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return map;
}

export function formatDate(input: DateInput, locale?: string): string {
  const d = toDate(input);
  if (!d) return "—";
  const p = partsOf(d, locale, { day: "2-digit", month: "short", year: "numeric" });
  return `${p.day} ${p.month} ${p.year}`;
}

export function formatTime(input: DateInput, locale?: string): string {
  const d = toDate(input);
  if (!d) return "—";
  const p = partsOf(d, locale, { hour: "2-digit", minute: "2-digit", hour12: true });
  const period = p.dayPeriod?.toUpperCase();
  return period ? `${p.hour}:${p.minute} ${period}` : `${p.hour}:${p.minute}`;
}

export function formatDateTime(input: DateInput, locale?: string): string {
  const d = toDate(input);
  if (!d) return "—";
  return `${formatDate(d, locale)}, ${formatTime(d, locale)}`;
}

export function formatRelative(input: DateInput, locale?: string): string {
  const d = toDate(input);
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return "Just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return formatDate(d, locale);
}
