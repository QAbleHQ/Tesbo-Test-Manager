export interface UserMetrics {
  newUsers: number;
  totalUsers: number;
  dau: number;
  engagedUsers: number;
}

/**
 * numerator / denominator as a percentage with exactly 2 decimals ("10.00%", "14.58%", "0.00%").
 *
 * Integer arithmetic on purpose: toFixed() rounds the binary float, so a true 14.575 can print as
 * 14.57. Here the value is rounded half-up in hundredths of a percent. A zero denominator (no users
 * yet) is 0.00%, never NaN or Infinity.
 */
export function percent(numerator: number, denominator: number): string {
  if (denominator <= 0 || numerator <= 0) return "0.00%";
  const hundredths = Math.floor((numerator * 20000 + denominator) / (denominator * 2));
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}%`;
}

/** "2026-10-07" -> "October 7, 2026". Pure calendar maths: the date is already an IST calendar day. */
export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

/** Basecamp rich-text body for one report day. */
export function buildReportHtml(reportDate: string, tz: string, m: UserMetrics): string {
  const row = (label: string, value: string | number) => `<li>${label}: <strong>${value}</strong></li>`;
  return [
    "<h1>📈 Analytics Report</h1>",
    `<div><em>${longDate(reportDate)} · ${tz}</em></div>`,
    "<hr>",
    "<div><strong>User Analysis</strong></div>",
    "<ul>",
    row("New Users Today", m.newUsers),
    row("Total Users", m.totalUsers),
    row("Daily Active Users (DAU)", m.dau),
    row("Daily Login Rate", percent(m.dau, m.totalUsers)),
    row("Daily Engaged Users", m.engagedUsers),
    row("Engagement Rate", percent(m.engagedUsers, m.totalUsers)),
    "</ul>"
  ].join("");
}
