import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createProject,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
} from "../utils/screens-tenant";

/*
 * The Reports & Insights screen at /projects/:id/reports — the export controls.
 *
 * Basecamp 10218723531 ("Reports & Insights > Export buttons are not working"). All three were dead:
 * the top bar's Export button and the nav's "Export CSV" / "Export PDF" rows were markup with
 * title="Coming soon" and no handler. The top bar and the nav's CSV/Excel rows are real exports now;
 * "Export PDF" was removed rather than wired, because no PDF pipeline exists to point it at.
 *
 * The recurring assertion is that the control is ALIVE — that nothing on this screen still carries
 * "Coming soon" or cursor-not-allowed — plus that each link asks for the view actually on screen.
 * The files themselves (headers, rows, filters, formats) are covered in api/reports.spec.ts.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

function exportButton(page: Page) {
  return page.getByTestId("reports-export");
}

/** Opens the top bar's export menu and returns it. */
async function openExportMenu(page: Page) {
  await exportButton(page).click();
  const menu = page.getByTestId("reports-export-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("reports export controls", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    // One executed run, so the Execution Report tab has a filterable row rather than an empty state.
    await seedRun(api, projectId, { statuses: ["Passed", "Failed"], status: "Completed" });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/reports`);
    await expect(page.getByRole("heading", { name: "Reports & Insights" })).toBeVisible();
  });

  test("RPT-U-01 the Export button is a live control, not a Coming soon placeholder", { tag: '@tesbo.testId("TES-TC-1360")' }, async ({ page }) => {
    const button = exportButton(page);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    // The exact shape of the original defect: a title of "Coming soon" and a not-allowed cursor.
    await expect(button).not.toHaveAttribute("title", "Coming soon");
    expect(await button.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("not-allowed");
    // And nothing anywhere on the screen still advertises an export that isn't built.
    await expect(page.locator('[title="Coming soon"]')).toHaveCount(0);
    await expect(page.getByText("Export PDF")).toHaveCount(0);
  });

  test("RPT-U-02 the menu offers CSV and Excel for the view on screen", { tag: '@tesbo.testId("TES-TC-1361")' }, async ({ page }) => {
    const menu = await openExportMenu(page);
    await expect(menu).toContainText("Overview");

    await expect(page.getByTestId("reports-export-csv")).toHaveAttribute(
      "href",
      /\/reports\/export\/csv\?view=overview/,
    );
    await expect(page.getByTestId("reports-export-xlsx")).toHaveAttribute(
      "href",
      /\/reports\/export\/xlsx\?view=overview/,
    );
  });

  test("RPT-U-03 switching tabs switches what gets exported", { tag: '@tesbo.testId("TES-TC-1362")' }, async ({ page }) => {
    // Six views share one button, so the link has to follow the nav — exporting the overview while
    // looking at Traceability is the quietly-wrong-file failure this guards.
    const cases: [string, string][] = [
      ["Execution Report", "execution"],
      ["Traceability", "matrix"],
      ["Repository", "repository"],
      ["AI Insights", "insights"],
      ["Trends", "trends"],
    ];
    for (const [navLabel, view] of cases) {
      await page.getByRole("button", { name: new RegExp(navLabel, "i") }).first().click();
      const menu = await openExportMenu(page);
      await expect(menu).toContainText(new RegExp(navLabel.split(" ")[0], "i"));
      await expect(page.getByTestId("reports-export-csv")).toHaveAttribute(
        "href",
        new RegExp(`view=${view}`),
      );
      // Close it again so the next iteration's click lands on the button, not the open menu.
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 400);
    }
  });

  test("RPT-U-04 the nav's own export rows point at the same file", { tag: '@tesbo.testId("TES-TC-1363")' }, async ({ page }) => {
    await expect(page.getByTestId("reports-nav-export-csv")).toHaveAttribute(
      "href",
      /\/reports\/export\/csv\?view=overview/,
    );
    await expect(page.getByTestId("reports-nav-export-xlsx")).toHaveAttribute(
      "href",
      /\/reports\/export\/xlsx\?view=overview/,
    );
  });

  test("RPT-U-05 the CSV link really serves a file to this session", { tag: '@tesbo.testId("TES-TC-1364")' }, async ({ page }) => {
    /*
     * Followed with page.request rather than by clicking: the anchor opens in a new tab, and a
     * download that starts inside a popup emits its event on the popup rather than this page, which
     * makes the click-and-wait form flaky for reasons that have nothing to do with the export. Going
     * through page.request keeps the session cookie and still proves the whole path — the href the UI
     * built, the auth on it, the headers, and the first line of the file.
     */
    await openExportMenu(page);
    const href = (await page.getByTestId("reports-export-csv").getAttribute("href")) ?? "";
    expect(href).toBeTruthy();

    const res = await page.request.get(href);
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain('filename="report-overview.csv"');
    const body = await res.text();
    expect(body.split("\n")[0]).toBe("section,label,metric,value");
    expect(body.length).toBeGreaterThan("section,label,metric,value".length);
  });

  test("RPT-U-06 the Execution Report's filter travels with its export", { tag: '@tesbo.testId("TES-TC-1365")' }, async ({ page }) => {
    await page.getByRole("button", { name: /Execution Report/i }).first().click();

    // The tab's "Filter by" select; its options are the grouping dimensions.
    const filterBy = page.locator("select").first();
    await filterBy.selectOption("priority");
    // The value select appears once a dimension other than "overall" is chosen.
    const filterValue = page.locator("select").nth(1);
    await expect(filterValue).toBeVisible();
    const option = (await filterValue.locator("option").nth(1).getAttribute("value")) ?? "";
    test.skip(!option, "this project has no priority buckets to filter by");
    await filterValue.selectOption(option);

    await openExportMenu(page);
    const href = (await page.getByTestId("reports-export-csv").getAttribute("href")) ?? "";
    expect(href).toContain("view=execution");
    expect(href).toContain("filterBy=priority");
    expect(href).toContain(`filterValue=${encodeURIComponent(option)}`);
  });
});

/*
 * "[Insights] Execution Report — Show Full Run Name on Hover". The chart's run-name labels are a
 * fixed w-32 and truncate with an ellipsis; the only way to read a long name was the native `title`,
 * whose ~1s delay made it look absent. A styled tooltip now shows the full name on hover — only
 * when the label is actually cut off, so short names behave as before.
 */
test.describe("execution report run-name tooltip", () => {
  let api: APIRequestContext;
  let projectId: string;
  const stamp = Date.now();
  const longName = `E2E Tooltip Long Run Name That Cannot Fit In The Chart Label Column ${stamp}`;
  const shortName = `R${stamp % 100000}`;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    projectId = (await createProject(api)).id;
    await seedRun(api, projectId, { name: longName, statuses: ["Passed", "Failed"], status: "Completed" });
    await seedRun(api, projectId, { name: shortName, statuses: ["Passed"], status: "Completed" });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/reports`);
    await page.getByRole("button", { name: /Execution Report/i }).first().click();
    await expect(page.getByRole("heading", { name: /Execution status by/i })).toBeVisible();
  });

  test("RPT-U-TIP-1 hovering a truncated run name shows the full name, and leaving hides it", async ({ page }) => {
    const label = page.getByText(longName, { exact: true });
    await expect(label).toHaveCount(1);
    // Precondition: the label really is truncated, otherwise this test proves nothing.
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // The native title is gone, so the browser doesn't stack a second tooltip on top.
    await expect(label).not.toHaveAttribute("title", /.*/);

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveCount(0);
    await label.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(longName);

    // Truncation and the row layout are unchanged while the tooltip is up.
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    await page.mouse.move(5, 5);
    await expect(tooltip).toHaveCount(0);
  });

  test("RPT-U-TIP-2 a short run name that fits shows no tooltip", async ({ page }) => {
    const label = page.getByText(shortName, { exact: true });
    await expect(label).toBeVisible();
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
    await label.hover();
    // Give a would-be tooltip the chance to render before asserting it did not.
    await page.waitForTimeout(300);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });

  test("RPT-U-TIP-3 the bars and totals still render beside the labels", async ({ page }) => {
    const row = page.getByText(longName, { exact: true }).locator("xpath=ancestor::div[contains(@class,'items-center')][1]");
    await expect(row.locator('[title="Passed: 1"]')).toBeVisible();
    await expect(row.locator('[title="Failed: 1"]')).toBeVisible();
    await expect(row.getByText("2", { exact: true })).toBeVisible();
  });
});

/*
 * "[Insights] Keep Execution Distribution Visible When Scrolling". The status list renders one row
 * per run, and the Distribution card sat in the same grid row with its content centred — so 300+
 * runs stretched the row and left the donut hundreds of pixels down, behind a wall of blank space.
 * The list now scrolls inside its own card and Distribution keeps its natural height at the top.
 * Seeds more runs than fit the list's height, so the scrolling is actually exercised.
 */
test.describe("execution report distribution stays in view", () => {
  let api: APIRequestContext;
  let projectId: string;
  const RUNS = 15;

  test.beforeAll(async () => {
    if (skipReason) return;
    test.setTimeout(240_000);
    api = await screensApi();
    projectId = (await createProject(api)).id;
    for (let i = 0; i < RUNS; i++) {
      await seedRun(api, projectId, { name: `E2E Distribution Run ${i + 1}`, statuses: [i % 2 ? "Passed" : "Failed"], status: "Completed" });
    }
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    // Wide enough for the side-by-side (lg) layout the fix applies to.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${projectId}/reports`);
    await page.getByRole("button", { name: /Execution Report/i }).first().click();
    await expect(page.getByRole("heading", { name: /Execution status by/i })).toBeVisible();
  });

  test("RPT-U-DIST-1 the list scrolls on its own and Distribution sits at the top beside it, in view", async ({ page }) => {
    const list = page.getByTestId("execution-status-list");
    const distribution = page.getByRole("heading", { name: "Distribution", exact: true });
    const listHeading = page.getByRole("heading", { name: /Execution status by/i });

    // Precondition: more rows than the list shows, otherwise there is nothing to prove.
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), "the list overflows its own height").toBe(true);
    expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");

    // Both cards' headings line up at the top, and Distribution is on screen without scrolling.
    const [d, l] = [await distribution.boundingBox(), await listHeading.boundingBox()];
    expect(Math.abs(d!.y - l!.y), "Distribution starts level with the list").toBeLessThan(4);
    await expect(distribution).toBeInViewport();
    await expect(page.getByText("Passed (7)")).toBeInViewport();

    // Scrolling the list moves its rows, not the page — Distribution stays exactly where it was.
    const pageScrollBefore = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
    await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByText(`E2E Distribution Run ${RUNS}`, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(pageScrollBefore);
    expect((await distribution.boundingBox())!.y).toBeCloseTo(d!.y, 0);
    // Every run is still in the chart — the fix only changes how it scrolls.
    for (let i = 1; i <= RUNS; i++) await expect(page.getByText(`E2E Distribution Run ${i}`, { exact: true })).toHaveCount(1);
  });

  test("RPT-U-DIST-2 on a narrow screen the cards still stack, with the list at full height", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    const list = page.getByTestId("execution-status-list");
    // Below lg nothing changed: no inner scrolling, and Distribution comes after the list.
    expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    const [d, l] = [await page.getByRole("heading", { name: "Distribution", exact: true }).boundingBox(), await list.boundingBox()];
    expect(d!.y).toBeGreaterThan(l!.y + l!.height);
  });
});

/*
 * "[Insights] Fix Execution Velocity Chart Label Overlapping". Every run name was cut to a fixed 8
 * characters + "…" whatever the room, and 12 bars across the chart leave each ~33 of its 400 units —
 * less than a 9-character label needs — so neighbours ran into each other, and names sharing a prefix
 * all read the same. Labels are now cut to their own slot, and the full name shows on hover.
 */
test.describe("execution velocity labels", () => {
  let api: APIRequestContext;
  let projectId: string;
  const RUNS = 12;
  const name = (i: number) => `E2E Velocity Run Sharing A Long Prefix ${i}`;

  test.beforeAll(async () => {
    if (skipReason) return;
    test.setTimeout(240_000);
    api = await screensApi();
    projectId = (await createProject(api)).id;
    for (let i = 1; i <= RUNS; i++) await seedRun(api, projectId, { name: name(i), statuses: ["Passed"], status: "Completed" });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${projectId}/reports`);
    await page.getByRole("button", { name: /Trends/i }).first().click();
    await expect(page.getByRole("heading", { name: "Execution velocity" })).toBeVisible();
  });

  function chartCard(page: Page, heading: string) {
    return page.getByRole("heading", { name: heading, exact: true }).locator("xpath=..");
  }

  test("RPT-U-VEL-1 labels fit their bars without overlapping, one per run", async ({ page }) => {
    const bars = chartCard(page, "Execution velocity").locator("g[data-bar-index]");
    await expect(bars).toHaveCount(RUNS);
    const boxes = await bars.locator("text").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
    boxes.sort((a, b) => a.left - b.left);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i - 1].right, `label ${i} overlaps label ${i + 1}`).toBeLessThanOrEqual(boxes[i].left);
    }
  });

  test("RPT-U-VEL-2 hovering a bar shows its full run name; leaving hides it", async ({ page }) => {
    const bars = chartCard(page, "Execution velocity").locator("g[data-bar-index]");
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveCount(0);
    // Every label is cut (the names are far longer than a slot), so each one has a full name to show.
    const labels = await bars.locator("text").allTextContents();
    expect(labels.every((l) => l.endsWith("…")), `labels: ${labels.join(" | ")}`).toBe(true);
    await bars.first().hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/^E2E Velocity Run Sharing A Long Prefix \d+$/);
    await page.mouse.move(5, 5);
    await expect(tooltip).toHaveCount(0);
  });

  test("RPT-U-VEL-3 the Bug discovery chart is untouched: its week labels, no hover tooltip", async ({ page }) => {
    const card = chartCard(page, "Bug discovery rate");
    const labels = await card.locator("svg text").allTextContents();
    for (const label of labels) expect(label).toMatch(/^\d{2}-\d{2}$/);
    if (labels.length) {
      await card.locator("svg g").first().hover();
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    }
  });
});

/*
 * "[Insights] UI issue in Priority and status labels". On the Traceability table the Priority and
 * Status columns were 70px / 90px in a fixed-layout table, so a "Medium" or "Approved" chip spilled
 * into the next column. A priority outside P0-P3 also rendered with no tone at all.
 */
test.describe("traceability priority and status labels", () => {
  let api: APIRequestContext;
  let projectId: string;
  let runId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    projectId = (await createProject(api)).id;
    const stamp = Date.now();
    const caseIds: string[] = [];
    for (const [i, priority] of ["P2", "Medium"].entries()) {
      const res = await api.post(`/api/projects/${projectId}/testcases`, {
        data: { title: `E2E Trace Label ${i} ${stamp}`, priority, status: "Approved" },
      });
      caseIds.push((await res.json()).id);
    }
    const run = await (await api.post(`/api/projects/${projectId}/cycles`, { data: { name: `E2E Trace Run ${stamp}` } })).json();
    runId = run.id;
    await api.post(`/api/cycles/${runId}/testcases`, { data: { testcaseIds: caseIds } });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test("RPT-U-TRACE-1 priority and status chips sit inside their own cells, and an off-scale priority still shows its label", async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/reports`);
    await page.getByRole("button", { name: /Traceability/i }).first().click();

    const rows = page.locator("tbody tr").filter({ hasText: "E2E Trace Label" });
    await expect(rows).toHaveCount(2);

    // "Medium" has no P-level tone; it must still be shown as written.
    await expect(page.locator("tbody").getByText("Medium", { exact: true })).toBeVisible();
    await expect(page.locator("tbody").getByText("P2", { exact: true })).toBeVisible();

    for (const label of ["P2", "Medium", "Approved"]) {
      const chip = page.locator("tbody").getByText(label, { exact: true }).first();
      const cell = chip.locator("xpath=ancestor::td[1]");
      const c = (await chip.boundingBox())!;
      const k = (await cell.boundingBox())!;
      expect(c.x, `${label} starts inside its cell`).toBeGreaterThanOrEqual(k.x - 0.5);
      expect(c.x + c.width, `${label} ends inside its cell`).toBeLessThanOrEqual(k.x + k.width + 0.5);
    }
  });
});
