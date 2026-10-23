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

/** A date's local calendar day as "YYYY-MM-DD" — the shape an <input type="date"> and a bug's
 *  dueDate use. toISOString() would give the UTC day, which is the wrong one near midnight. */
export function toLocalDay(input: DateInput = new Date()): string {
  const d = toDate(input);
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A stored calendar day ("YYYY-MM-DD", no time, no zone) as "05 Oct 2026". Parsed as a plain day, never
 *  through the viewer's timezone — `new Date("2026-10-05")` is UTC midnight and would render as the
 *  4th west of Greenwich. Anything that is not a plain day falls through to formatDate. */
export function formatDay(day: string | null | undefined, locale?: string): string {
  if (!day) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return formatDate(day, locale);
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const p = partsOf(d, locale, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return `${p.day} ${p.month} ${p.year}`;
}

/** Today's calendar day ("YYYY-MM-DD") in an IANA timezone — what a workspace's "today" is, whatever the
 *  viewer's own clock says. Falls back to the viewer's local day for a missing or unknown zone. */
export function todayInZone(timeZone?: string | null, now: Date = new Date()): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
      // unknown zone — fall through to the local day
    }
  }
  return toLocalDay(now);
}
