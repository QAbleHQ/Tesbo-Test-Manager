import type { APIRequestContext } from "@playwright/test";

/**
 * Helpers for the plan / run Start Date and Due Date specs.
 *
 * "Today" is the workspace's calendar day (organizations.timezone), not the test runner's, so the
 * specs ask the API which zone the caller's workspace is in and compute the day there — the same
 * rule the product applies when it decides a due date is "today" or "overdue".
 */

/** The calendar day it is right now in `timeZone`, as YYYY-MM-DD. */
export function dayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** `day` shifted by `days` calendar days (negative = earlier). */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The active workspace's IANA timezone, as the API reports it. */
export async function workspaceTimezone(api: APIRequestContext): Promise<string> {
  const res = await api.get("/api/workspace");
  const body = await res.json();
  return body.timezone;
}

/** Today in the caller's workspace timezone, plus helpers for the days around it. */
export async function workspaceDays(api: APIRequestContext) {
  const timezone = await workspaceTimezone(api);
  const today = dayIn(timezone);
  return {
    timezone,
    today,
    yesterday: shiftDay(today, -1),
    tomorrow: shiftDay(today, 1),
    inDays: (n: number) => shiftDay(today, n),
  };
}
