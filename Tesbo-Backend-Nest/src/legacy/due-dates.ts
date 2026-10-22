import { BadRequestException } from "@nestjs/common";

/**
 * Start / due dates for test plans and test runs.
 *
 * Both are calendar days ("YYYY-MM-DD", stored as DATE). "Today", "due today" and "overdue" are
 * always judged in the workspace's timezone, never the server's or the caller's.
 */

export const DEFAULT_WORKSPACE_TIMEZONE = "Asia/Kolkata";

/** How many days before the due date the "due soon" notification goes out. */
export const DUE_SOON_LEAD_DAYS = 1;

export type DuePhase = "due_soon" | "due_today" | "overdue";

/** A valid "YYYY-MM-DD" calendar day, or null for absent / null / "". Throws 400 for anything else. */
export function parseDay(value: unknown, field: string, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  // Round-trip through Date so an impossible day such as 2026-02-30 is refused, not rolled into March.
  const valid = !!match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === text;
  if (!valid) throw new BadRequestException({ error: `${label} must be a valid date in YYYY-MM-DD format`, field });
  return text;
}

export function isValidTimezone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day it is right now in `timeZone`, as "YYYY-MM-DD". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const zone = isValidTimezone(timeZone) ? timeZone : DEFAULT_WORKSPACE_TIMEZONE;
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The hour of day (0-23) it is right now in `timeZone`. */
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const zone = isValidTimezone(timeZone) ? timeZone : DEFAULT_WORKSPACE_TIMEZONE;
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }).format(now);
  return Number(hour) % 24;
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "25 Oct 2026" — the shape the rest of the product shows dates in. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${String(d).padStart(2, "0")} ${month} ${y}`;
}

/**
 * Where a due date stands against today: `overdue` once it is in the past, `due_today` on the day,
 * `due_soon` inside the lead window, null otherwise (or with no due date). Callers decide whether the
 * item is still open — a completed item is never any of these.
 */
export function duePhase(dueDate: string | null | undefined, today: string): DuePhase | null {
  if (!dueDate) return null;
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "due_today";
  if (dueDate <= addDays(today, DUE_SOON_LEAD_DAYS)) return "due_soon";
  return null;
}

/** Due Date cannot be earlier than Start Date. Either side being unset is fine. */
export function assertDateRange(startDate: string | null | undefined, dueDate: string | null | undefined): void {
  if (startDate && dueDate && dueDate < startDate) {
    throw new BadRequestException({ error: "Due date cannot be earlier than the start date", field: "dueDate" });
  }
}

/** What an update body says about the two dates, resolved against what is stored. */
export interface DateChange {
  startDate: string | null;
  dueDate: string | null;
  /** The body names dueDate as null / "" — the due date is being removed. */
  clearsDueDate: boolean;
}

/**
 * Reads startDate / dueDate off an update body and validates them against the stored row.
 *  - absent key        → unchanged
 *  - dueDate null / "" → cleared (a plan or run may have no due date)
 *  - startDate null / "" → refused: a start date, once given, cannot be removed
 */
export function resolveDateChange(
  body: Record<string, unknown>,
  current: { startDate: string | null; dueDate: string | null }
): DateChange {
  const hasStart = Object.prototype.hasOwnProperty.call(body, "startDate") && body.startDate !== undefined;
  const hasDue = Object.prototype.hasOwnProperty.call(body, "dueDate") && body.dueDate !== undefined;
  if (hasStart && (body.startDate === null || body.startDate === "")) {
    throw new BadRequestException({ error: "Start date cannot be removed", field: "startDate" });
  }
  const startDate = hasStart ? parseDay(body.startDate, "startDate", "Start date") : null;
  const clearsDueDate = hasDue && (body.dueDate === null || body.dueDate === "");
  const dueDate = hasDue && !clearsDueDate ? parseDay(body.dueDate, "dueDate", "Due date") : null;
  const effectiveStart = startDate ?? current.startDate;
  const effectiveDue = clearsDueDate ? null : dueDate ?? current.dueDate;
  assertDateRange(effectiveStart, effectiveDue);
  return { startDate, dueDate, clearsDueDate };
}
