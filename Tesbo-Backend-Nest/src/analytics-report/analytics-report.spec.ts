import { buildReportHtml, longDate, percent } from "./analytics-report.format";
import { AnalyticsReportService } from "./analytics-report.service";
import { parseQuestionUrl } from "./basecamp.client";

describe("percent", () => {
  it.each([
    [3, 212, "1.42%"], // the report in the screenshot
    [1, 10, "10.00%"],
    [7, 48, "14.58%"],
    [1, 3, "33.33%"],
    [2, 3, "66.67%"],
    [212, 212, "100.00%"],
    [0, 212, "0.00%"],
    [5, 0, "0.00%"], // no users yet: never NaN or Infinity
    [0, 0, "0.00%"]
  ])("%i / %i -> %s", (n, d, expected) => expect(percent(n, d)).toBe(expected));

  it("rounds an exact half-hundredth up (583/4000 is exactly 14.575%)", () => {
    expect(percent(583, 4000)).toBe("14.58%");
    expect(percent(1, 8)).toBe("12.50%");
  });

  it("always has exactly 2 decimals", () => {
    for (const [n, d] of [[1, 2], [1, 7], [9, 10], [123, 456]]) expect(percent(n, d)).toMatch(/^\d+\.\d{2}%$/);
  });
});

describe("report body", () => {
  it("labels the day being reported, in long form", () => {
    expect(longDate("2026-10-07")).toBe("October 7, 2026");
    expect(longDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("renders all six metrics with the right labels", () => {
    const html = buildReportHtml("2026-10-07", "Asia/Kolkata", { newUsers: 1, totalUsers: 212, dau: 3, engagedUsers: 1 });
    expect(html).toContain("Analytics Report");
    expect(html).toContain("October 7, 2026 · Asia/Kolkata");
    expect(html).toContain("New Users Today: <strong>1</strong>");
    expect(html).toContain("Total Users: <strong>212</strong>");
    expect(html).toContain("Daily Active Users (DAU): <strong>3</strong>");
    expect(html).toContain("Daily Login Rate: <strong>1.42%</strong>");
    expect(html).toContain("Daily Engaged Users: <strong>1</strong>");
    expect(html).toContain("Engagement Rate: <strong>0.47%</strong>");
  });

  it("renders a zero-activity day without NaN", () => {
    const html = buildReportHtml("2026-10-07", "Asia/Kolkata", { newUsers: 0, totalUsers: 0, dau: 0, engagedUsers: 0 });
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain("Daily Login Rate: <strong>0.00%</strong>");
  });
});

describe("parseQuestionUrl", () => {
  it("reads bucket and question ids from the check-in URL", () => {
    expect(parseQuestionUrl("https://3.basecamp.com/5705339/buckets/47793887/questions/10370979699")).toEqual({
      bucketId: "47793887",
      questionId: "10370979699"
    });
  });
  it("rejects a URL that is not a check-in question", () => {
    expect(parseQuestionUrl("https://3.basecamp.com/5705339/projects/1")).toBeNull();
  });
});

describe("AnalyticsReportService.run", () => {
  const fullConfig = {
    analyticsReportEnabled: true,
    basecampClientId: "id",
    basecampClientSecret: "secret",
    basecampRefreshToken: "refresh",
    basecampAccountId: "5705339",
    basecampAnalyticsQuestionUrl: ""
  };

  function make(overrides: Record<string, unknown> = {}, opts: { claimRows?: number; postError?: Error } = {}) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO analytics_report_runs")) return { rows: opts.claimRows === 0 ? [] : [{ report_date: "x" }] };
      if (sql.includes("AS new_users")) return { rows: [{ new_users: "1", total_users: "212", dau: "3", engaged: "1" }] };
      if (sql.includes("- 1, 'YYYY-MM-DD'")) return { rows: [{ d: "2026-10-07" }] };
      return { rows: [] };
    });
    const postAnswer = jest.fn(async () => {
      if (opts.postError) throw opts.postError;
      return 4242;
    });
    const svc = new AnalyticsReportService({ query } as any, { ...fullConfig, ...overrides } as any, { postAnswer } as any);
    return { svc, query, postAnswer };
  }

  it("does nothing unless explicitly enabled (production-only gate)", async () => {
    const { svc, query, postAnswer } = make({ analyticsReportEnabled: false });
    await expect(svc.run()).resolves.toBe("disabled");
    expect(query).not.toHaveBeenCalled();
    expect(postAnswer).not.toHaveBeenCalled();
  });

  it("skips quietly when a Basecamp setting is missing", async () => {
    const { svc, postAnswer } = make({ basecampRefreshToken: "" });
    await expect(svc.run()).resolves.toBe("not_configured");
    expect(postAnswer).not.toHaveBeenCalled();
  });

  it("reports the previous IST day and posts it grouped on that day", async () => {
    const { svc, postAnswer } = make();
    await expect(svc.run()).resolves.toBe("posted");
    expect(postAnswer).toHaveBeenCalledTimes(1);
    const [html, groupOn] = postAnswer.mock.calls[0] as unknown as [string, string];
    expect(groupOn).toBe("2026-10-07");
    expect(html).toContain("October 7, 2026");
  });

  it("does not post a day that is already posted or being posted", async () => {
    const { svc, postAnswer } = make({}, { claimRows: 0 });
    await expect(svc.run("2026-10-07")).resolves.toBe("already_done");
    expect(postAnswer).not.toHaveBeenCalled();
  });

  it("releases the claim and rethrows when Basecamp fails, so the retry can post", async () => {
    const { svc, query } = make({}, { postError: new Error("HTTP 503") });
    await expect(svc.run("2026-10-07")).rejects.toThrow("HTTP 503");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET claimed_at = now() - interval"))).toBe(true);
  });

  it("excludes mailinator and e2e accounts from every count", async () => {
    const { svc, query } = make();
    await svc.metrics("2026-10-07");
    const sql = String(query.mock.calls[0][0]);
    expect(sql.match(/@mailinator\.com/g)).toHaveLength(4);
    expect(sql.match(/e2e-%/g)).toHaveLength(4);
  });

  it("counts engaged as activity without a login that day", async () => {
    const { svc, query } = make();
    await svc.metrics("2026-10-07");
    expect(String(query.mock.calls[0][0])).toContain("a.engaged AND NOT a.logged_in");
  });
});
