import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { filesForm, pngFile, sizedFile, textFile, type UploadFile } from "../utils/uploads";
import {
  createBug,
  createProject,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * The bugs screen at /projects/:id/bugs — specifically the evidence field on the report and edit
 * modals.
 *
 * Basecamp 10226296533 ("[Bug Attachments] Missing File Type and Size Validations Cause Upload to
 * Get Stuck on Saving"). Two halves, both covered here:
 *
 *   1. the picker itself refuses what the server would refuse, the moment the file is chosen, so an
 *      unsupported or oversized file never becomes a request at all;
 *   2. when the server does refuse an upload, the modal says so instead of sitting on "Saving…" —
 *      the throw used to go nowhere, which is what the reporter saw.
 *
 * The server-side rules are covered in api/attachments.spec.ts; this file is about what the person
 * in front of the screen is told.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** The evidence file input, which is hidden behind the "+ Add files" button. */
function fileInput(page: Page) {
  return page.locator('input[type="file"]');
}

async function openReportModal(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/bugs`);
  // The page's button is "Report Bug"; "Report a Bug" is the MODAL TITLE. Matching the title here
  // waited two minutes for a button that does not exist — the mistake this comment now prevents.
  await page.getByRole("button", { name: "Report Bug" }).first().click();
  // The modal renders without role="dialog", so the title is the anchor.
  await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
}

test.describe("bug evidence validation", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("BUG-U-01 the picker advertises the types it accepts", { tag: '@tesbo.testId("TES-TC-1311")' }, async ({ page }) => {
    await openReportModal(page, projectId);
    // Advisory only — the dialog can always be switched to "All files" — but without it the OS
    // picker offers no guidance at all, which is half of why unsupported files were being chosen.
    const accept = await fileInput(page).getAttribute("accept");
    expect(accept, "the evidence input should carry an accept list").toBeTruthy();
    expect(accept).toContain(".png");
    expect(accept).toContain(".pdf");
    expect(accept).not.toContain(".exe");
  });

  test("BUG-U-02 an unsupported file is named and refused without being staged", { tag: '@tesbo.testId("TES-TC-1312")' }, async ({ page }) => {
    await openReportModal(page, projectId);
    await fileInput(page).setInputFiles({
      name: "malware.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    });

    const rejections = page.getByTestId("evidence-rejections");
    await expect(rejections).toBeVisible();
    await expect(rejections).toContainText("malware.exe");
    await expect(rejections).toContainText(/\.exe/);
    // Staged files are listed with their size; the rejected one must not appear as one.
    await expect(page.getByText("malware.exe", { exact: true })).toHaveCount(0);
  });

  test("BUG-U-03 an oversized file is refused with the limit, before any upload", { tag: '@tesbo.testId("TES-TC-1313")' }, async ({ page }) => {
    await openReportModal(page, projectId);

    // Nothing should reach the API: the point of the client-side check is that a 26MB file is never
    // sent, so a request to the attachments endpoint is itself the failure.
    let uploadAttempted = false;
    await page.route("**/bugs/*/attachments", (route) => {
      uploadAttempted = true;
      return route.abort();
    });

    await fileInput(page).setInputFiles({
      name: "recording.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(26 * 1024 * 1024, 0x61),
    });

    const rejections = page.getByTestId("evidence-rejections");
    await expect(rejections).toBeVisible();
    await expect(rejections).toContainText("recording.mp4");
    await expect(rejections).toContainText("25.0MB");
    expect(uploadAttempted, "an oversized file must not be uploaded before it is rejected").toBeFalsy();
  });

  test("BUG-U-04 a mixed selection keeps the good files and drops only the bad one", { tag: '@tesbo.testId("TES-TC-1314")' }, async ({ page }) => {
    await openReportModal(page, projectId);
    await fileInput(page).setInputFiles([
      { name: "shot-a.png", mimeType: "image/png", buffer: Buffer.from("a") },
      { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
      { name: "shot-b.png", mimeType: "image/png", buffer: Buffer.from("b") },
    ]);

    await expect(page.getByTestId("evidence-rejections")).toContainText("notes.exe");
    // Picking five files and getting one wrong must not discard the other four.
    await expect(page.getByText("shot-a.png")).toBeVisible();
    await expect(page.getByText("shot-b.png")).toBeVisible();
  });

  test("BUG-U-05 a server-side rejection is shown, and the button leaves Saving", { tag: '@tesbo.testId("TES-TC-1315")' }, async ({ page }) => {
    /*
     * The original defect, reproduced from the other side: the client check is bypassed here (the
     * file is a perfectly valid PNG) and the API is made to refuse the upload. Before the fix the
     * throw was swallowed — the modal stayed open, unchanged, with no message.
     */
    await page.route("**/bugs/*/attachments", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "shot.png: .png files aren't supported." }),
      }),
    );

    await openReportModal(page, projectId);
    await page.getByPlaceholder("Brief summary of the bug…").fill(`E2E Evidence Failure ${uniqueSuffix()}`);
    await fileInput(page).setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from("a"),
    });

    // Two "Report Bug" buttons exist while the modal is open — the page's and the modal's submit.
    // The submit is the last one in the DOM.
    const submit = page.getByRole("button", { name: "Report Bug" }).last();
    await submit.click();

    const error = page.getByTestId("create-bug-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("aren't supported");
    // And the modal is usable again rather than stuck mid-save.
    await expect(page.getByRole("button", { name: "Report Bug" }).last()).toBeEnabled();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
  });

  /*
   * The reported defect: createBug() succeeded, the single unbatched attachments request that
   * followed it was refused outright by the server's ten-file-per-request cap, and the modal stayed
   * open with the files still staged — inviting a retry that called createBug() again and produced a
   * duplicate bug. lib/api.ts's uploadBugAttachments now splits anything over the cap into sequential
   * requests, so this is the happy-path half of the fix: nothing above ten files should ever reach
   * that cap in the first place, and one save action still produces exactly one bug.
   */
  test("BUG-U-36 reporting a bug with more than ten attachments creates exactly one bug with every file attached", async ({ page }) => {
    await openReportModal(page, projectId);
    const title = `E2E Many Attachments ${uniqueSuffix()}`;
    await page.getByPlaceholder("Brief summary of the bug…").fill(title);
    await fileInput(page).setInputFiles(
      Array.from({ length: 12 }, (_, i) => ({
        name: `evidence-${i}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(`file contents ${i}`),
      })),
    );

    const submit = page.getByRole("button", { name: "Report Bug" }).last();
    await submit.click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();
    await expect(page.getByTestId("create-bug-error")).toHaveCount(0);

    const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
    const matches = bugs.filter((b: { title: string }) => b.title === title);
    expect(matches, "a single save action must create exactly one bug").toHaveLength(1);

    const bug = await (await api.get(`/api/bugs/${matches[0].id}`)).json();
    expect(bug.attachments, "every staged file must reach the bug, not just the first ten").toHaveLength(12);
  });

  /*
   * The exact failure mode from the Basecamp report, reproduced directly: the attachment request
   * fails once (whatever the reason — over the server's cap, a dropped connection, a validation
   * error), the bug was already created by that same attempt, and the person retries from the still-
   * open modal. Before the fix, retrying re-ran the whole submit handler and called createBug() a
   * second time. Now the bug id from the failed attempt is remembered, so a retry only resumes the
   * attachment upload.
   */
  test("BUG-U-37 a retry after a failed attachment upload does not create a duplicate bug", async ({ page }) => {
    let attempt = 0;
    await page.route("**/bugs/*/attachments", (route) => {
      attempt += 1;
      // The first attachment request this test makes fails; every one after (i.e. the retry) goes
      // through for real.
      if (attempt === 1) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Simulated upload failure" }),
        });
      }
      return route.continue();
    });

    await openReportModal(page, projectId);
    const title = `E2E Duplicate Guard ${uniqueSuffix()}`;
    await page.getByPlaceholder("Brief summary of the bug…").fill(title);
    await fileInput(page).setInputFiles(
      Array.from({ length: 12 }, (_, i) => ({
        name: `evidence-${i}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(`file contents ${i}`),
      })),
    );

    const submit = page.getByRole("button", { name: "Report Bug" }).last();
    await submit.click();
    const error = page.getByTestId("create-bug-error");
    await expect(error).toBeVisible();
    // The modal stays open with the same submit control, exactly what invited the original defect.
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();

    await submit.click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

    const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
    const matches = bugs.filter((b: { title: string }) => b.title === title);
    expect(matches, "the retry must reuse the bug from the failed attempt, not create a second one").toHaveLength(1);

    const bug = await (await api.get(`/api/bugs/${matches[0].id}`)).json();
    expect(bug.attachments, "the retry must still deliver every staged file").toHaveLength(12);
  });
});

/*
 * The bugs list itself — the row controls, the truncating cells and the filters.
 *
 * Four cards, one screen: 10226234070 ("edit and delete icon size is very small not visible
 * properly") and 10218564160 ("Delete button is not visible") are the same faint-glyph defect from
 * two reporters; 10226229423 ("No tool tip pop up is available for log text") is the truncated and
 * unclamped cells; 10226242373 ("Severity filter is missing") is the filter bar. 10217828537 ("Bug
 * edit pop up is not scrollable") was fixed upstream in components/ui/Modal.tsx and is pinned here
 * so it cannot silently regress.
 */
test.describe("bugs list — controls and filters", () => {
  let api: APIRequestContext;
  let projectId: string;
  // Deliberately contains no word that appears on a control ("list", "board", "edit", "delete"):
  // getByRole name matching is substring-based, so a title mentioning the list view matched the view
  // toggle itself and made every test in this block ambiguous.
  const longTitle =
    "E2E long bug title that must be shortened on screen because it is far too long to sit on one line " +
    "and used to push the whole row to six lines tall with no way to read the rest of it";

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    await createBug(api, projectId, { title: `${longTitle} ${uniqueSuffix()}`, severity: "Critical" });
    await createBug(api, projectId, { title: `E2E Low sev bug ${uniqueSuffix()}`, severity: "Low" });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Severity" })).toBeVisible();
  });

  test("BUG-U-06 the row's edit and delete controls are labelled and legibly sized", { tag: '@tesbo.testId("TES-TC-1316")' }, async ({ page }) => {
    const edit = page.getByRole("button", { name: "Edit bug" }).first();
    const del = page.getByRole("button", { name: "Delete bug" }).first();

    // Present and reachable at all — 10218564160 was filed because the delete control read as empty
    // space on the production theme.
    await expect(edit).toBeVisible();
    await expect(del).toBeVisible();

    for (const control of [edit, del]) {
      const box = await control.boundingBox();
      expect(box, "an icon control with no box is not on screen").toBeTruthy();
      // A 32px target with an 18px glyph inside it; the old pairing was 16px in a transparent box.
      expect(box!.height).toBeGreaterThanOrEqual(28);
      expect(box!.width).toBeGreaterThanOrEqual(28);
      const svg = control.locator("svg").first();
      const svgBox = await svg.boundingBox();
      expect(svgBox!.height, "the glyph itself has to be big enough to read").toBeGreaterThanOrEqual(17);
    }

    // The destructive one must not look identical to the safe one.
    const editColor = await edit.evaluate((el) => getComputedStyle(el).color);
    const deleteColor = await del.evaluate((el) => getComputedStyle(el).color);
    expect(deleteColor, "delete should be distinguishable from edit by colour").not.toBe(editColor);
  });

  test("BUG-U-27 the board card's edit and delete controls are labelled and legibly sized", async ({ page }) => {
    // Same defect as BUG-U-06, on the other view: the card's actions were a 14px glyph in a ~22px
    // box, hidden until hover, with no aria-label — reported again as "icon size is very small
    // not visible properly" because Board, not List, is what a project lands on by default.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const card = page.locator('[role="button"]').filter({ hasText: "E2E Low sev bug" }).first();
    await card.hover();

    const edit = card.getByRole("button", { name: "Edit bug" });
    const del = card.getByRole("button", { name: "Delete bug" });

    await expect(edit).toBeVisible();
    await expect(del).toBeVisible();

    for (const control of [edit, del]) {
      const box = await control.boundingBox();
      expect(box, "an icon control with no box is not on screen").toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(28);
      expect(box!.width).toBeGreaterThanOrEqual(28);
      const svg = control.locator("svg").first();
      const svgBox = await svg.boundingBox();
      expect(svgBox!.height, "the glyph itself has to be big enough to read").toBeGreaterThanOrEqual(17);
    }

    const editColor = await edit.evaluate((el) => getComputedStyle(el).color);
    const deleteColor = await del.evaluate((el) => getComputedStyle(el).color);
    expect(deleteColor, "delete should be distinguishable from edit by colour").not.toBe(editColor);
  });

  test("BUG-U-07 a long title is clamped and carries its full text as a tooltip", { tag: '@tesbo.testId("TES-TC-1317")' }, async ({ page }) => {
    const title = page.locator("td span[title]").filter({ hasText: "E2E long bug title" }).first();
    await expect(title).toBeVisible();

    const tooltip = await title.getAttribute("title");
    expect(tooltip, "the full title has to be readable somehow").toContain("no way to read the rest of it");

    // Clamped: the rendered height is a couple of lines, not the eight the raw string would take.
    const box = await title.boundingBox();
    const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
    expect(box!.height, "the title cell should be clamped, not six lines tall").toBeLessThanOrEqual(lineHeight * 2.6);
  });

  test("BUG-U-08 the severity filter narrows the list and clears back", { tag: '@tesbo.testId("TES-TC-1318")' }, async ({ page }) => {
    const rows = page.locator("tbody tr");
    const before = await rows.count();
    expect(before, "the fixture seeds two bugs of different severities").toBeGreaterThanOrEqual(2);

    await page.getByLabel("Filter by severity").selectOption("Critical");
    await expect(page.getByText("E2E Low sev bug")).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(page.locator("tbody").getByText("Critical").first()).toBeVisible();

    await page.getByLabel("Filter by severity").selectOption("");
    await expect(rows).toHaveCount(before);
  });

  test("BUG-U-09 the severity filter is available on the board too", { tag: '@tesbo.testId("TES-TC-1319")' }, async ({ page }) => {
    // Neither filter is gated on the view: both feed the same `filtered` list, which the board's
    // columns are built from as well (see BUG-U-14 below). "Show me the Critical ones" is exactly
    // what the board is for.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const severity = page.getByLabel("Filter by severity");
    await expect(severity).toBeVisible();

    await severity.selectOption("Low");
    await expect(page.getByText("E2E long bug title")).toHaveCount(0);
  });

  test("BUG-U-32 Clear all is hidden with no filters and resets every filter at once", async ({ page }) => {
    const rows = page.locator("tbody tr");
    const before = await rows.count();
    expect(before, "the fixture seeds two bugs of different severities").toBeGreaterThanOrEqual(2);

    const clearAll = page.getByRole("button", { name: "Clear all" });
    await expect(clearAll, "no filters applied yet — there is nothing to clear").toBeHidden();

    // Two independent filter dimensions at once: a dropdown and free text.
    await page.getByLabel("Filter by severity").selectOption("Critical");
    await expect(clearAll).toBeVisible();
    await page.getByPlaceholder("Search bugs…").fill("E2E long bug title");
    await expect(rows).toHaveCount(1);

    await clearAll.click();
    await expect(page.getByLabel("Filter by severity")).toHaveValue("");
    await expect(page.getByPlaceholder("Search bugs…")).toHaveValue("");
    await expect(rows).toHaveCount(before);
    await expect(clearAll).toBeHidden();
  });

  test("BUG-U-33 Clear all resets filters identically on the board view", async ({ page }) => {
    // Same `filtered` list feeds both views (BUG-U-09/BUG-U-14) — Clear all must not be a
    // List-only control.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByLabel("Filter by severity").selectOption("Low");
    await expect(page.getByText("E2E long bug title")).toHaveCount(0);

    const clearAll = page.getByRole("button", { name: "Clear all" });
    await expect(clearAll).toBeVisible();
    await clearAll.click();
    await expect(page.getByLabel("Filter by severity")).toHaveValue("");
    await expect(page.getByText("E2E long bug title")).toBeVisible();
  });

  test("BUG-U-35 whitespace-only search still counts as an active filter", async ({ page }) => {
    // A lone space is truthy but filters nothing visible — Clear all still has to appear and clear it,
    // rather than the button's own "is anything active" check silently trimming it away.
    await page.getByPlaceholder("Search bugs…").fill("   ");
    const clearAll = page.getByRole("button", { name: "Clear all" });
    await expect(clearAll).toBeVisible();

    await clearAll.click();
    await expect(page.getByPlaceholder("Search bugs…")).toHaveValue("");
    await expect(clearAll).toBeHidden();
  });

  test("BUG-U-10 the edit modal scrolls to its own footer instead of the page behind it", { tag: '@tesbo.testId("TES-TC-1320")' }, async ({ page }) => {
    /*
     * Basecamp 10217828537 — "Bug edit pop up is not scrollable thus not able to update bug". Fixed
     * upstream in components/ui/Modal.tsx (dev commit e95da92) by locking the app-shell scroller and
     * putting the overflow on the dialog body; pinned here because it is a shared component and the
     * failure mode — a Save button you cannot reach — silently blocks every edit on the screen.
     */
    await page.getByRole("button", { name: "Edit bug" }).first().click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    // The shell behind the dialog is locked while it is open.
    const shellLocked = await page.evaluate(() => getComputedStyle(document.documentElement).overflow);
    expect(shellLocked).toBe("hidden");

    // And the footer is reachable inside the dialog.
    const save = page.getByRole("button", { name: "Save Changes" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    await expect(save).toBeEnabled();
  });
});

/*
 * Bug priority on the screen — Basecamp 10226247009.
 *
 * The card asked for the field on the report form. A field you can set and never see afterwards is
 * not a field, so the column and the edit round trip are covered here too. The API side (validation,
 * clearing, case handling) lives in api/bugs.spec.ts.
 */
test.describe("bug priority", () => {
  let api: APIRequestContext;
  let projectId: string;
  let triagedTitle: string;
  let untriagedTitle: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    const suffix = uniqueSuffix();
    triagedTitle = `E2E Triaged bug ${suffix}`;
    untriagedTitle = `E2E Untriaged bug ${suffix}`;
    // Seeded through the API rather than the modal: this project has no runs, and driving the form
    // here would be testing the link picker rather than the priority field.
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title: triagedTitle, severity: "High", priority: "P1" },
    });
    await api.post(`/api/projects/${projectId}/bugs`, { data: { title: untriagedTitle, severity: "Low" } });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Priority" })).toBeVisible();
  });

  test("BUG-U-11 the list shows a priority per bug, and an em dash when untriaged", { tag: '@tesbo.testId("TES-TC-1321")' }, async ({ page }) => {
    const triagedRow = page.locator("tbody tr").filter({ hasText: triagedTitle });
    await expect(triagedRow.getByText("P1", { exact: true })).toBeVisible();

    // Untriaged reads as an em dash, not as an invented P2 — the two are different facts.
    const untriagedRow = page.locator("tbody tr").filter({ hasText: untriagedTitle });
    await expect(untriagedRow.getByText("—", { exact: true }).first()).toBeVisible();
    await expect(untriagedRow.getByText(/^P[0-3]$/)).toHaveCount(0);
  });

  test("BUG-U-12 the report form offers priority, opening on Not selected", { tag: '@tesbo.testId("TES-TC-1322")' }, async ({ page }) => {
    await page.getByRole("button", { name: /report a bug/i }).first().click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();

    const priority = page.getByLabel("Bug priority");
    await expect(priority).toBeVisible();
    // Optional by design: "not triaged yet" has to be expressible on the form itself — and the empty
    // choice reads "Not selected", the same wording severity uses.
    await expect(priority).toHaveValue("");
    await expect(priority.locator("option")).toHaveText(["Not selected", "P0", "P1", "P2", "P3"]);
  });

  /*
   * "Priority and Severity Should Display 'Select' by Default When Logging a New Bug". Severity used
   * to open preselected on Medium, so a bug filed without touching it carried a severity nobody
   * chose. Both fields now open on "Not selected", neither is required (product decision on the
   * card), and leaving them alone files the bug with no severity and no priority (V130).
   */
  test("BUG-U-84 the report form opens Severity and Priority on Not selected, and neither is required", async ({ page }) => {
    const title = `E2E Unselected severity ${uniqueSuffix()}`;
    let bugId: string | undefined;
    try {
      await openReportModal(page, projectId);
      const severity = page.getByLabel("Bug severity");
      await expect(severity).toHaveValue("");
      await expect(severity.locator("option")).toHaveText(["Not selected", "Critical", "High", "Medium", "Low"]);
      await expect(page.getByLabel("Bug priority")).toHaveValue("");

      await page.getByPlaceholder("Brief summary of the bug…").fill(title);
      // Two "Report Bug" buttons exist while the modal is open; the submit is the last in the DOM.
      const submit = page.getByRole("button", { name: "Report Bug" }).last();
      await expect(submit, "neither field is required, so the form submits as-is").toBeEnabled();
      await submit.click();
      await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

      const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
      const bug = bugs.find((b: { title: string }) => b.title === title);
      expect(bug, "the bug was filed").toBeTruthy();
      bugId = bug.id;
      // Stored as not selected, not as a Medium nobody picked.
      expect(bug.severity).toBeNull();
      expect(bug.priority ?? null).toBeNull();

      // And the list says so, rather than inventing a badge.
      await page.getByRole("button", { name: "List", exact: true }).click();
      const row = page.locator("tbody tr").filter({ hasText: title });
      await expect(row.getByText(/^(Critical|High|Medium|Low)$/)).toHaveCount(0);
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-85 severity and priority picked on the report form are what gets saved", async ({ page }) => {
    const title = `E2E Chosen severity ${uniqueSuffix()}`;
    let bugId: string | undefined;
    try {
      await openReportModal(page, projectId);
      await page.getByPlaceholder("Brief summary of the bug…").fill(title);
      await page.getByLabel("Bug severity").selectOption("Critical");
      await page.getByLabel("Bug priority").selectOption("P2");
      await page.getByRole("button", { name: "Report Bug" }).last().click();
      await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

      const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
      const bug = bugs.find((b: { title: string }) => b.title === title);
      expect(bug, "the bug was filed").toBeTruthy();
      bugId = bug.id;
      expect(bug.severity).toBe("Critical");
      expect(bug.priority).toBe("P2");

      // Reopening the form starts clean rather than carrying the last choice over.
      await page.getByRole("button", { name: "Report Bug" }).first().click();
      await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Bug severity")).toHaveValue("");
      await expect(page.getByLabel("Bug priority")).toHaveValue("");
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-86 editing a bug can clear its severity to Not selected, and set it again", async ({ page }) => {
    const title = `E2E Clear severity ${uniqueSuffix()}`;
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, { data: { title, severity: "High" } })
    ).json();
    try {
      await page.reload();
      await page.getByRole("button", { name: "List", exact: true }).click();
      const row = page.locator("tbody tr").filter({ hasText: title });
      await expect(row.getByText("High", { exact: true })).toBeVisible();

      await row.getByRole("button", { name: "Edit bug" }).click();
      const severity = page.getByLabel("Severity", { exact: true });
      await expect(severity).toHaveValue("High");
      await expect(severity.locator("option").first()).toHaveText("Not selected");
      await expect(page.getByLabel("Bug priority").locator("option").first()).toHaveText("Not selected");
      await severity.selectOption("");
      await page.getByRole("button", { name: "Save Changes" }).click();

      await expect(row.getByText("High", { exact: true })).toHaveCount(0);
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).severity).toBeNull();

      // And back: clearing is not a one-way door.
      await row.getByRole("button", { name: "Edit bug" }).click();
      await expect(page.getByLabel("Severity", { exact: true })).toHaveValue("");
      await page.getByLabel("Severity", { exact: true }).selectOption("Low");
      await page.getByRole("button", { name: "Save Changes" }).click();
      await expect(row.getByText("Low", { exact: true })).toBeVisible();
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).severity).toBe("Low");
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-13 editing a bug changes its priority and can clear it again", { tag: '@tesbo.testId("TES-TC-1323")' }, async ({ page }) => {
    const row = page.locator("tbody tr").filter({ hasText: triagedTitle });
    await row.getByRole("button", { name: "Edit bug" }).click();

    const priority = page.getByLabel("Bug priority");
    await expect(priority).toHaveValue("P1");
    await priority.selectOption("P0");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(row.getByText("P0", { exact: true })).toBeVisible();

    // And back to untriaged, which the API expresses as an explicit null rather than an omission.
    await row.getByRole("button", { name: "Edit bug" }).click();
    await page.getByLabel("Bug priority").selectOption("");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(row.getByText(/^P[0-3]$/)).toHaveCount(0);
  });

  test("BUG-U-19 the priority filter narrows the list and clears back", async ({ page }) => {
    const rows = page.locator("tbody tr");
    const before = await rows.count();
    expect(before, "the fixture seeds a triaged and an untriaged bug").toBeGreaterThanOrEqual(2);

    await page.getByLabel("Filter by priority").selectOption("P1");
    await expect(page.getByText(untriagedTitle)).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(page.locator("tbody").getByText("P1", { exact: true }).first()).toBeVisible();

    await page.getByLabel("Filter by priority").selectOption("");
    await expect(rows).toHaveCount(before);
  });

  test("BUG-U-20 the priority filter is available on the board too", async ({ page }) => {
    // Same `filtered` list feeds the board's columns as the severity/status filters (BUG-U-09/14) —
    // a priority filter that only existed in List would silently keep narrowing Board after a view
    // switch, with no control there to see or clear it.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const priority = page.getByLabel("Filter by priority");
    await expect(priority).toBeVisible();

    await priority.selectOption("P1");
    await expect(page.getByText(untriagedTitle)).toHaveCount(0);
    await expect(page.getByText(triagedTitle)).toBeVisible();
  });
});

/*
 * Bug "Assign to" — "[Test Runs] Unable to assign test cases for execution". Bugs had no assignee
 * concept before this; the field lives on the report/edit forms next to Severity/Priority. The
 * membership rule and clear-vs-omit semantics are covered in api/bugs.spec.ts; this is what the
 * person filling in the form actually sees.
 */
test.describe("bug assignee", () => {
  let api: APIRequestContext;
  let projectId: string;
  let selfUserId: string;
  let selfLabel: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    const me = await (await api.get("/api/auth/me")).json();
    selfUserId = me.userId;
    const members = await (await api.get(`/api/projects/${projectId}/members`)).json();
    const self = members.find((m: { userId: string }) => m.userId === selfUserId);
    selfLabel = self.name || self.email;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("BUG-U-24 the report form offers Assign to, defaulting to Unassigned, and it persists", { tag: '@tesbo.testId("TES-TC-1917")' }, async ({ page }) => {
    const title = `E2E Assignee Report ${uniqueSuffix()}`;
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "Report Bug" }).first().click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();

    const assign = page.getByLabel("Assign to");
    await expect(assign).toBeVisible();
    await expect(assign).toHaveValue("");
    await assign.selectOption({ label: selfLabel });

    await page.getByPlaceholder("Brief summary of the bug…").fill(title);
    await page.getByRole("button", { name: "Report Bug" }).last().click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

    const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
    const created = bugs.find((b: { title: string }) => b.title === title);
    expect(created.assigneeId).toBe(selfUserId);
  });

  test("BUG-U-25 the report form saves unassigned when no assignee is picked", { tag: '@tesbo.testId("TES-TC-1918")' }, async ({ page }) => {
    const title = `E2E Assignee Report Unassigned ${uniqueSuffix()}`;
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "Report Bug" }).first().click();
    await page.getByPlaceholder("Brief summary of the bug…").fill(title);
    await page.getByRole("button", { name: "Report Bug" }).last().click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

    const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
    const created = bugs.find((b: { title: string }) => b.title === title);
    expect(created.assigneeId).toBeNull();
  });

  test("BUG-U-26 the edit form changes the assignee and can clear it back to Unassigned", { tag: '@tesbo.testId("TES-TC-1919")' }, async ({ page }) => {
    const title = `E2E Assignee Edit ${uniqueSuffix()}`;
    const bug = await createBug(api, projectId, { title, severity: "Medium" });

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    const assign = page.getByLabel("Assign to");
    await expect(assign).toHaveValue("");
    await assign.selectOption({ label: selfLabel });
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeHidden();

    let after = await (await api.get(`/api/bugs/${bug.id}`)).json();
    expect(after.assigneeId).toBe(selfUserId);

    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByLabel("Assign to")).toHaveValue(selfUserId);
    await page.getByLabel("Assign to").selectOption("");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeHidden();

    after = await (await api.get(`/api/bugs/${bug.id}`)).json();
    expect(after.assigneeId).toBeNull();
  });

  /*
   * Assignment itself worked (BUG-U-24/25/26 above); nothing shown it back once set. That gap is
   * what the "assign bug to project members should be available" report actually meant — the field
   * existed, but you had to re-open Edit to see who a bug was assigned to.
   */
  test("BUG-U-27 the list shows who a bug is assigned to, and Unassigned when there isn't one", async ({ page }) => {
    const suffix = uniqueSuffix();
    const assignedTitle = `E2E Assignee Display Assigned ${suffix}`;
    const unassignedTitle = `E2E Assignee Display Unassigned ${suffix}`;
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title: assignedTitle, severity: "Medium", assigneeId: selfUserId },
    });
    await api.post(`/api/projects/${projectId}/bugs`, { data: { title: unassignedTitle, severity: "Medium" } });

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();

    const assignedRow = page.locator("tbody tr").filter({ hasText: assignedTitle });
    await expect(assignedRow.getByText(selfLabel, { exact: true })).toBeVisible();

    const unassignedRow = page.locator("tbody tr").filter({ hasText: unassignedTitle });
    await expect(unassignedRow.getByText("Unassigned", { exact: true })).toBeVisible();
  });

  test("BUG-U-28 the bug details modal shows the assignee", async ({ page }) => {
    const suffix = uniqueSuffix();
    const title = `E2E Assignee Modal ${suffix}`;
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title, severity: "Medium", assigneeId: selfUserId },
    });

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.locator("tbody tr").filter({ hasText: title }).click();
    await expect(page.getByText("Assigned To", { exact: true })).toBeVisible();
    await expect(page.getByText(selfLabel, { exact: true })).toBeVisible();
  });

  test("BUG-U-29 the kanban card shows the assignee's avatar", async ({ page }) => {
    const suffix = uniqueSuffix();
    const title = `E2E Assignee Kanban ${suffix}`;
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title, severity: "Medium", assigneeId: selfUserId },
    });

    await page.goto(`/projects/${projectId}/bugs`);
    const card = page.locator('[role="button"]').filter({ hasText: title }).first();
    await expect(card.getByTitle(selfLabel)).toBeVisible();
  });

  test("BUG-U-30 the assignee filter narrows to that person, Unassigned narrows to bugs with none, and both clear back", async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const assignedTitle = `E2E Assignee Filter Assigned ${suffix}`;
    const unassignedTitle = `E2E Assignee Filter Unassigned ${suffix}`;
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title: assignedTitle, severity: "Medium", assigneeId: selfUserId },
    });
    await api.post(`/api/projects/${projectId}/bugs`, { data: { title: unassignedTitle, severity: "Medium" } });

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();

    const filter = page.getByLabel("Filter by assignee");
    await filter.selectOption({ label: selfLabel });
    await expect(page.getByText(assignedTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(unassignedTitle, { exact: true })).toHaveCount(0);

    await filter.selectOption("unassigned");
    await expect(page.getByText(unassignedTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(assignedTitle, { exact: true })).toHaveCount(0);

    await filter.selectOption("");
    await expect(page.getByText(assignedTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(unassignedTitle, { exact: true })).toBeVisible();
  });

  test("BUG-U-34 Clear all resets the Unassigned sentinel, not just a real assignee", async ({ page }) => {
    // "unassigned" is a sentinel string distinct from "" (no filter) — Clear all has to reset it
    // back to "", not leave it stuck on the sentinel.
    const suffix = uniqueSuffix();
    const unassignedTitle = `E2E Assignee Clear All ${suffix}`;
    await api.post(`/api/projects/${projectId}/bugs`, { data: { title: unassignedTitle, severity: "Medium" } });

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const rows = page.locator("tbody tr");
    const before = await rows.count();

    await page.getByLabel("Filter by assignee").selectOption("unassigned");
    await expect(rows.count()).resolves.toBeLessThan(before);

    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByLabel("Filter by assignee")).toHaveValue("");
    await expect(rows).toHaveCount(before);
  });

  test("BUG-U-31 the assignee filter is available on the board too", async ({ page }) => {
    // Same `filtered` list feeds the board's columns as every other filter on this page
    // (BUG-U-09/20) — an assignee filter that only existed in List would leave Board silently
    // narrowed after a view switch, with no control there to see or clear it.
    const suffix = uniqueSuffix();
    const assignedTitle = `E2E Assignee Filter Board ${suffix}`;
    const unassignedTitle = `E2E Assignee Filter Board Other ${suffix}`;
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title: assignedTitle, severity: "Medium", assigneeId: selfUserId },
    });
    await api.post(`/api/projects/${projectId}/bugs`, { data: { title: unassignedTitle, severity: "Medium" } });

    await page.goto(`/projects/${projectId}/bugs`);
    const filter = page.getByLabel("Filter by assignee");
    await expect(filter).toBeVisible();
    await filter.selectOption({ label: selfLabel });
    await expect(page.getByText(unassignedTitle, { exact: true })).toHaveCount(0);
    await expect(page.getByText(assignedTitle, { exact: true })).toBeVisible();
  });
});

/*
 * The status filter's consistency across Board and List — dev commit cdcd5dd, ported here when the
 * two branches' bugs specs were merged.
 *
 * Reported: the status Select was only rendered while viewMode === "list", but the filtered list it
 * controlled (`filtered`, which feeds the List rows AND the board's kanbanColumns) applied
 * filterStatus regardless of which view was showing. So a filter set in List kept silently narrowing
 * Board after switching — with no control visible there to see it was active or clear it — while
 * Search (never gated on viewMode) already behaved consistently across both. The fix renders the
 * same Select in both views, matching Search.
 *
 * Two changes from dev's original: these run in the screens tenant's own project rather than the
 * shared smoke project, so the "a whole column is empty" assertions hold outright instead of only
 * for statuses a filter provably excludes; and the status filter is addressed by its aria-label,
 * because the severity filter added alongside it (BUG-U-08/09) makes getByRole("combobox")
 * ambiguous.
 */
test.describe("bugs — status filter and search consistency across Board and List", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  /** The board column for `status`, found from its heading so it survives class changes. */
  function kanbanColumn(page: Page, status: string): Locator {
    return page
      .getByRole("heading", { name: status, exact: true })
      .locator("xpath=ancestor::div[contains(@class,'min-w-')][1]");
  }

  /** Two bugs, in different statuses, in a project of this describe's own. */
  async function seedPair(): Promise<{ openTitle: string; inProgressTitle: string; ids: string[] }> {
    const suffix = uniqueSuffix();
    const openTitle = `E2E Bug Filter Open ${suffix}`;
    const inProgressTitle = `E2E Bug Filter InProgress ${suffix}`;
    const open = await createBug(api, projectId, { title: openTitle, severity: "Medium" });
    const inProgress = await createBug(api, projectId, {
      title: inProgressTitle,
      severity: "Medium",
      status: "In Progress",
    });
    return { openTitle, inProgressTitle, ids: [open.id, inProgress.id] };
  }

  async function deleteBugs(ids: string[]): Promise<void> {
    for (const id of ids) await api.delete(`/api/bugs/${id}`, { failOnStatusCode: false });
  }

  test("BUG-U-14 a status filter applied in List stays visible and applied after switching to Board", { tag: '@tesbo.testId("TES-TC-1324")' }, async ({
    page,
  }) => {
    const { openTitle, inProgressTitle, ids } = await seedPair();
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      await page.getByRole("button", { name: "List", exact: true }).click();

      const statusFilter = page.getByLabel("Filter by status");
      await statusFilter.selectOption("Open");
      await expect(page.getByText(openTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "Board", exact: true }).click();

      // The regression itself: the control that shows and edits the filter must still be there and
      // still read "Open" — not just the filtering effect, but visible evidence of why it happens.
      await expect(statusFilter).toBeVisible();
      await expect(statusFilter).toHaveValue("Open");

      await expect(kanbanColumn(page, "In Progress").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "Reopened").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "Closed").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "Open").getByText(openTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);
    } finally {
      await deleteBugs(ids);
    }
  });

  test("BUG-U-15 the filter round-trips back to List unchanged", { tag: '@tesbo.testId("TES-TC-1325")' }, async ({ page }) => {
    const { openTitle, inProgressTitle, ids } = await seedPair();
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      const statusFilter = page.getByLabel("Filter by status");
      await statusFilter.selectOption("In Progress");
      await expect(kanbanColumn(page, "In Progress").getByText(inProgressTitle, { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "List", exact: true }).click();
      await expect(statusFilter).toHaveValue("In Progress");
      await expect(page.getByText(inProgressTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(openTitle, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "Board", exact: true }).click();
      await expect(statusFilter).toHaveValue("In Progress");
    } finally {
      await deleteBugs(ids);
    }
  });

  test("BUG-U-16 a filter that excludes both bugs hides them in both views", { tag: '@tesbo.testId("TES-TC-1326")' }, async ({ page }) => {
    const { openTitle, inProgressTitle, ids } = await seedPair();
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      await page.getByLabel("Filter by status").selectOption("Closed");

      await expect(page.getByText(openTitle, { exact: true })).toHaveCount(0);
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);
      await expect(kanbanColumn(page, "Open").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "In Progress").getByText("No bugs")).toBeVisible();

      await page.getByRole("button", { name: "List", exact: true }).click();
      await expect(page.getByText(openTitle, { exact: true })).toHaveCount(0);
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);
    } finally {
      await deleteBugs(ids);
    }
  });

  test("BUG-U-17 clearing the filter back to All Statuses from Board restores both bugs", { tag: '@tesbo.testId("TES-TC-1327")' }, async ({ page }) => {
    const { openTitle, inProgressTitle, ids } = await seedPair();
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      const statusFilter = page.getByLabel("Filter by status");
      await statusFilter.selectOption("Open");
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);

      // Clearing is only possible from Board because the control used to be hidden there — the
      // concrete edge case the "keep them consistent" fix has to unblock.
      await statusFilter.selectOption("");
      await expect(statusFilter).toHaveValue("");
      await expect(kanbanColumn(page, "Open").getByText(openTitle, { exact: true })).toBeVisible();
      await expect(kanbanColumn(page, "In Progress").getByText(inProgressTitle, { exact: true })).toBeVisible();
    } finally {
      await deleteBugs(ids);
    }
  });

  test("BUG-U-18 a search term persists and keeps filtering after switching views", { tag: '@tesbo.testId("TES-TC-1328")' }, async ({ page }) => {
    const suffix = uniqueSuffix();
    const wantedTitle = `E2E Bug Search ${suffix}`;
    const otherTitle = `E2E Bug Search Other ${suffix}`;
    const wanted = await createBug(api, projectId, { title: wantedTitle, severity: "Medium" });
    const other = await createBug(api, projectId, { title: otherTitle, severity: "Medium" });
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      const search = page.getByPlaceholder("Search bugs…");
      await search.fill(wantedTitle);

      await expect(page.getByText(wantedTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(otherTitle, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "List", exact: true }).click();
      await expect(search).toHaveValue(wantedTitle);
      await expect(page.getByText(wantedTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(otherTitle, { exact: true })).toHaveCount(0);
    } finally {
      await deleteBugs([wanted.id, other.id]);
    }
  });
});

/*
 * The "X open · Y closed · Z total" line under the page title. `openCount` used to be
 * `status === "Open" || status === "Reopened"`, so a project with 1 Open + 1 Reopened bug read
 * "2 open" while the Kanban board directly below it — which gives Reopened its own column — showed
 * only 1 card under "Open". Same page, two different definitions of "open" a few pixels apart. Fixed
 * to count "Open" literally, matching the board's own column exactly.
 */
test.describe("bugs — header status counts", () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
  });

  test.afterAll(async () => {
    if (api) await api.dispose();
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  /** The header subtitle, matched by its fixed " · " shape rather than exact numbers. */
  function headerStats(page: Page): Locator {
    return page.getByText(/^\d+ open · \d+ closed · \d+ total$/);
  }

  test("BUG-U-21 a Reopened bug is not folded into the open count", async ({ page }) => {
    const project = await createProject(api);
    const suffix = uniqueSuffix();
    await createBug(api, project.id, { title: `E2E Header Open ${suffix}`, severity: "Medium" });
    await createBug(api, project.id, {
      title: `E2E Header Reopened ${suffix}`,
      severity: "Medium",
      status: "Reopened",
    });
    await createBug(api, project.id, {
      title: `E2E Header InProgress ${suffix}`,
      severity: "Medium",
      status: "In Progress",
    });
    await createBug(api, project.id, {
      title: `E2E Header Closed ${suffix}`,
      severity: "Medium",
      status: "Closed",
    });
    try {
      await page.goto(`/projects/${project.id}/bugs`);

      // The regression itself: 1 Open + 1 Reopened must read "1 open", not "2 open".
      await expect(headerStats(page)).toHaveText("1 open · 1 closed · 4 total");

      const openColumn = page
        .getByRole("heading", { name: "Open", exact: true })
        .locator("xpath=ancestor::div[contains(@class,'min-w-')][1]");
      const reopenedColumn = page
        .getByRole("heading", { name: "Reopened", exact: true })
        .locator("xpath=ancestor::div[contains(@class,'min-w-')][1]");
      await expect(openColumn.getByText("1", { exact: true })).toBeVisible();
      await expect(reopenedColumn.getByText("1", { exact: true })).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("BUG-U-22 a project with no bugs shows all-zero counts", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto(`/projects/${project.id}/bugs`);
      await expect(headerStats(page)).toHaveText("0 open · 0 closed · 0 total");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("BUG-U-23 the header keeps counting the whole project while a status filter narrows the board", async ({ page }) => {
    const project = await createProject(api);
    const suffix = uniqueSuffix();
    await createBug(api, project.id, { title: `E2E Header Filter Open ${suffix}`, severity: "Medium" });
    const inProgress = await createBug(api, project.id, {
      title: `E2E Header Filter InProgress ${suffix}`,
      severity: "Medium",
      status: "In Progress",
    });
    try {
      await page.goto(`/projects/${project.id}/bugs`);
      await expect(headerStats(page)).toHaveText("1 open · 0 closed · 2 total");

      // Narrowing the board to one status must not shrink the header's project-wide totals.
      await page.getByLabel("Filter by status").selectOption("Open");
      await expect(page.getByText(inProgress.title, { exact: true })).toHaveCount(0);
      await expect(headerStats(page)).toHaveText("1 open · 0 closed · 2 total");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

/*
 * A bug never linked to Jira/Linear has no integrationIssueKey, and until now "Bug Key" had
 * nothing else to show for it anywhere in the app (Test Run, Test Case Detail, and this page all
 * left it blank). Every bug now gets its own per-project sequential id (`<KEY>-BUG-<n>`, the same
 * scheme test cases already have), and these three surfaces — board card, list row, details modal
 * — fall back to it.
 */
test.describe("bug external id (Bug Key fallback)", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("BUG-U-38 the board card, list row, and details modal all show the bug's own external id when it has no tracker key", async ({ page }) => {
    const title = `E2E Bug Key Fallback ${uniqueSuffix()}`;
    // Not the createBug() helper above — it deliberately returns only { id, title } for its many
    // other callers here, and this test needs the full record (integrationIssueKey, externalId).
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, { data: { title, severity: "Medium" } })
    ).json();
    expect(bug.integrationIssueKey, "fixture bug must have no tracker key for this test to mean anything").toBeFalsy();
    expect(bug.externalId).toMatch(/^.+-BUG-\d+$/);

    await page.goto(`/projects/${projectId}/bugs`);

    // Board view (default) — the card shows the id above the title.
    await expect(page.getByText(bug.externalId, { exact: true }).first()).toBeVisible();

    // List view — same id, in the title cell.
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await expect(row.getByText(bug.externalId, { exact: true })).toBeVisible();

    // Details modal — a dedicated "Bug Key" line, not folded into the Jira/Linear link section
    // (which stays hidden here since this bug has no externalUrl).
    await row.click();
    await expect(page.getByText(bug.externalId, { exact: true })).toBeVisible();
  });
});

/*
 * Edit Bug's Jira/Linear field. Before this, the field was a plain URL text box that showed the
 * linked ticket's URL but always saved integrationIssueKey: null on Save — the ticket could never
 * actually be changed from here. This reuses IssuePickerModal (already exercised for Jira/Linear
 * multi-select in ui/executions.spec.ts) in a new "single" mode: pick a ticket and it replaces the
 * one there instead of adding to it. The api/bugs.spec.ts "bug integration link" describe covers
 * the PATCH semantics this depends on (same bug id, provider+key change together); this covers
 * what the picker itself shows and does.
 */
test.describe("bug — editing the linked Jira/Linear ticket", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("BUG-U-39 the current Jira ticket is preselected, and picking a different one updates the same bug", async ({ page }) => {
    const title = `E2E Bug Jira Reselect ${uniqueSuffix()}`;
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, {
        data: {
          title,
          severity: "Medium",
          integrationProvider: "JIRA",
          integrationIssueKey: "KAN-9",
          externalUrl: "https://e2e.atlassian.net/browse/KAN-9",
        },
      })
    ).json();

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: false } }));
    await page.route(`**/api/projects/${projectId}/jira/search-issues**`, (route) =>
      route.fulfill({
        json: {
          list: [
            { provider: "JIRA", key: "KAN-9", summary: "Original ticket", status: "Open", url: "https://e2e.atlassian.net/browse/KAN-9" },
            { provider: "JIRA", key: "KAN-10", summary: "Replacement ticket", status: "Open", url: "https://e2e.atlassian.net/browse/KAN-10" },
          ],
        },
      }),
    );

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    // The currently linked ticket is shown without having to open the picker.
    await expect(page.getByText("KAN-9", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Change issue" }).click();
    await expect(page.getByRole("heading", { name: "Select Jira ticket" })).toBeVisible();
    const picker = page.getByTestId("issue-picker");
    // Selected by default, as a single-select radio row — not the multi-select checkbox flow.
    await expect(picker.locator('input[type="radio"]:checked')).toHaveCount(1);
    await picker.locator("label", { hasText: "Replacement ticket" }).click();
    await picker.getByRole("button", { name: "Select" }).click();

    await expect(page.getByText("KAN-10", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeHidden();

    const afterSave = await (await api.get(`/api/bugs/${bug.id}`)).json();
    expect(afterSave.id, "the same bug must be updated, not a new one").toBe(bug.id);
    expect(afterSave.integrationIssueKey).toBe("KAN-10");
    expect(afterSave.externalUrl).toBe("https://e2e.atlassian.net/browse/KAN-10");

    // Reopening shows the new ticket as current; the old one is gone, not just unshown.
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("KAN-10", { exact: false })).toBeVisible();
    await expect(page.getByText("KAN-9", { exact: true })).toHaveCount(0);
  });

  test("BUG-U-40 the same picker works for Linear tickets", async ({ page }) => {
    const title = `E2E Bug Linear Reselect ${uniqueSuffix()}`;
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, {
        data: {
          title,
          severity: "Medium",
          integrationProvider: "LINEAR",
          integrationIssueKey: "ENG-1",
          externalUrl: "https://linear.app/e2e/issue/ENG-1",
        },
      })
    ).json();

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: false } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/search-issues**`, (route) =>
      route.fulfill({
        json: {
          list: [
            { provider: "LINEAR", key: "ENG-1", summary: "Original linear ticket", status: "Todo", url: "https://linear.app/e2e/issue/ENG-1" },
            { provider: "LINEAR", key: "ENG-2", summary: "Replacement linear ticket", status: "Todo", url: "https://linear.app/e2e/issue/ENG-2" },
          ],
        },
      }),
    );

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Change issue" }).click();
    await expect(page.getByRole("heading", { name: "Select Linear ticket" })).toBeVisible();
    const picker = page.getByTestId("issue-picker");
    await picker.locator("label", { hasText: "Replacement linear ticket" }).click();
    await picker.getByRole("button", { name: "Select" }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeHidden();

    const afterSave = await (await api.get(`/api/bugs/${bug.id}`)).json();
    expect(afterSave.integrationIssueKey).toBe("ENG-2");
    expect(afterSave.integrationProvider).toBe("LINEAR");
  });

  test("BUG-U-41 a bug with no ticket linked yet can have one selected for the first time via Edit", async ({ page }) => {
    const title = `E2E Bug Jira First Link ${uniqueSuffix()}`;
    const bug = await (await api.post(`/api/projects/${projectId}/bugs`, { data: { title, severity: "Medium" } })).json();
    expect(bug.integrationIssueKey).toBeNull();

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: false } }));
    await page.route(`**/api/projects/${projectId}/jira/search-issues**`, (route) =>
      route.fulfill({
        json: { list: [{ provider: "JIRA", key: "KAN-20", summary: "Fresh pick", status: "Open", url: "https://e2e.atlassian.net/browse/KAN-20" }] },
      }),
    );

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /log it in my task management system myself/i }).click();
    await page.getByRole("button", { name: "Jira", exact: true }).click();
    await expect(page.getByText("No issue selected.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Select issue" }).click();
    const picker = page.getByTestId("issue-picker");
    await picker.locator("label", { hasText: "Fresh pick" }).click();
    await picker.getByRole("button", { name: "Select" }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeHidden();

    const afterSave = await (await api.get(`/api/bugs/${bug.id}`)).json();
    expect(afterSave.integrationProvider).toBe("JIRA");
    expect(afterSave.integrationIssueKey).toBe("KAN-20");
  });

  /*
   * The bug found and fixed while wiring this up: switching the system button from Jira to Linear
   * mid-edit left the previously-picked Jira issue in state, which would have saved a Jira key
   * under integrationProvider: "LINEAR" and let it leak into the Linear picker's result list.
   */
  test("BUG-U-42 switching from Jira to Linear drops the previously selected Jira ticket", async ({ page }) => {
    const title = `E2E Bug Provider Switch UI ${uniqueSuffix()}`;
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, {
        data: {
          title,
          severity: "Medium",
          integrationProvider: "JIRA",
          integrationIssueKey: "KAN-30",
          externalUrl: "https://e2e.atlassian.net/browse/KAN-30",
        },
      })
    ).json();

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/search-issues**`, (route) =>
      route.fulfill({
        json: { list: [{ provider: "LINEAR", key: "ENG-30", summary: "Linear pick", status: "Todo", url: "https://linear.app/e2e/issue/ENG-30" }] },
      }),
    );

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();
    await expect(page.getByText("KAN-30", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Linear", exact: true }).click();
    // The stale Jira key must not still be shown as "current" under Linear.
    await expect(page.getByText("KAN-30", { exact: false })).toHaveCount(0);
    await expect(page.getByText("No issue selected.", { exact: true })).toBeVisible();

    // Requirement: switching providers "requires selecting an issue from the new provider" — Save
    // must refuse to persist integrationProvider: "LINEAR" with no key until one is picked.
    await expect(page.getByText("Select a Linear ticket before saving.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    await page.getByRole("button", { name: "Select issue" }).click();
    const picker = page.getByTestId("issue-picker");
    // The Jira ticket must not leak into the Linear picker's list either.
    await expect(picker.getByText("KAN-30", { exact: false })).toHaveCount(0);
    await picker.locator("label", { hasText: "Linear pick" }).click();
    await picker.getByRole("button", { name: "Select" }).click();

    // Picking a ticket from the new provider clears the block.
    await expect(page.getByText("Select a Linear ticket before saving.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeEnabled();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeHidden();

    const afterSave = await (await api.get(`/api/bugs/${bug.id}`)).json();
    expect(afterSave.integrationProvider).toBe("LINEAR");
    expect(afterSave.integrationIssueKey).toBe("ENG-30");
  });

  /*
   * updateBug/createBug store integrationProvider verbatim, with no case normalization (unlike
   * severity/priority, which have dedicated case-insensitive parsers on the backend) — so a bug
   * whose provider was ever written in a case other than "JIRA"/"LINEAR" (an older client, a
   * hand-crafted API call) still has to be detected as that provider on Edit, not fall through to
   * "Other".
   */
  test("BUG-U-43 a Jira link stored in a different case is still detected as Jira, not Other", async ({ page }) => {
    const title = `E2E Bug Provider Case ${uniqueSuffix()}`;
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: {
        title,
        severity: "Medium",
        integrationProvider: "jira",
        integrationIssueKey: "KAN-40",
        externalUrl: "https://e2e.atlassian.net/browse/KAN-40",
      },
    });

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: false } }));

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    // "Jira" reads as the selected system (highlighted like the other "primary"-variant selected
    // buttons elsewhere on this page), not "Other" — and the current ticket is shown.
    const jiraButton = page.getByRole("button", { name: "Jira", exact: true });
    const otherButton = page.getByRole("button", { name: "Other", exact: true });
    const jiraColor = await jiraButton.evaluate((el) => getComputedStyle(el).backgroundColor);
    const otherColor = await otherButton.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(jiraColor, "Jira must read as the selected system, not look identical to unselected Other").not.toBe(otherColor);

    await expect(page.getByText("KAN-40", { exact: false })).toBeVisible();
    await expect(page.getByText("Change issue", { exact: true })).toBeVisible();
    // The plain URL box (what "Other" would show instead) must not be the field in play here.
    await expect(page.getByPlaceholder("https://example.com/browse/BUG-123")).toBeHidden();
  });
});

/*
 * The New Bug / Report a Bug flow's own Jira/Linear selection — the same plain-URL-box gap Edit
 * Bug had (see "bug — editing the linked Jira/Linear ticket" above), but on the create side:
 * "Where should this be tracked?" -> "I'll log it in my task management system myself" ->
 * Jira/Linear used to be a manual URL field with no search, and handleCreate() always sent
 * integrationIssueKey: null. This reuses the identical IssuePickerModal "single" mode fix.
 */
test.describe("bug — selecting a Jira/Linear ticket when reporting a new bug", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("BUG-U-44 reporting a new bug can select a Jira ticket via the searchable picker, and requires one before saving", async ({ page }) => {
    const title = `E2E Bug Create Jira Pick ${uniqueSuffix()}`;

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/jira/search-issues**`, (route) =>
      route.fulfill({
        json: { list: [{ provider: "JIRA", key: "NEW-1", summary: "Newly filed ticket", status: "Open", url: "https://e2e.atlassian.net/browse/NEW-1" }] },
      }),
    );

    await openReportModal(page, projectId);
    await page.getByPlaceholder("Brief summary of the bug…").fill(title);

    await page.getByRole("button", { name: /log it in my task management system myself/i }).click();
    await page.getByRole("button", { name: "Jira", exact: true }).click();

    // A searchable picker, not the plain URL box — and both Jira and Linear are offered.
    await expect(page.getByRole("button", { name: "Linear", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("https://example.com/browse/BUG-123")).toBeHidden();
    await expect(page.getByText("No issue selected.", { exact: true })).toBeVisible();

    const submit = page.getByRole("button", { name: "Report Bug" }).last();
    await expect(submit).toBeDisabled();
    await expect(page.getByText("Select a Jira ticket before saving.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Select issue" }).click();
    await expect(page.getByRole("heading", { name: "Select Jira ticket" })).toBeVisible();
    const picker = page.getByTestId("issue-picker");
    await picker.locator("label", { hasText: "Newly filed ticket" }).click();
    await picker.getByRole("button", { name: "Select" }).click();

    await expect(page.getByText("Select a Jira ticket before saving.", { exact: true })).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

    const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
    const created = bugs.find((b: { title: string }) => b.title === title);
    expect(created, "the newly reported bug").toBeTruthy();
    expect(created.integrationProvider).toBe("JIRA");
    expect(created.integrationIssueKey).toBe("NEW-1");
    expect(created.externalUrl).toBe("https://e2e.atlassian.net/browse/NEW-1");
  });

  test("BUG-U-45 Other keeps the plain URL box on the create form, unaffected by the Jira/Linear picker", async ({ page }) => {
    const title = `E2E Bug Create Other Url ${uniqueSuffix()}`;

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: false } }));

    await openReportModal(page, projectId);
    await page.getByPlaceholder("Brief summary of the bug…").fill(title);

    await page.getByRole("button", { name: /log it in my task management system myself/i }).click();
    await page.getByRole("button", { name: "Other", exact: true }).click();

    const urlBox = page.getByPlaceholder("https://example.com/browse/BUG-123");
    await expect(urlBox).toBeVisible();
    await urlBox.fill("https://example.com/browse/OTHER-9");

    const submit = page.getByRole("button", { name: "Report Bug" }).last();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeHidden();

    const bugs = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
    const created = bugs.find((b: { title: string }) => b.title === title);
    expect(created.integrationProvider).toBeNull();
    expect(created.externalUrl).toBe("https://example.com/browse/OTHER-9");
  });
});

/*
 * Field order — Report a Bug vs Edit Bug.
 *
 * "Fix field sequence inconsistency between Log New Bug and Edit Bug": Edit Bug used to render
 * Status/Severity/Priority/Assign-to as a trailing block after the Jira/Linear section, while
 * Report a Bug put Severity/Priority/Assign-to right after Description — so editing an existing
 * bug and reporting a new one showed the same fields in a different order. Both forms must now
 * read Title -> Description -> Severity -> Priority -> Assign to -> Evidence -> Linked Test
 * Case(s) & Run(s) -> Where should this be tracked? -> Which system?, with Edit Bug's extra
 * Status field (there is no "not yet saved" status to edit on create) placed without disturbing
 * that shared sequence.
 */
test.describe("bug — field order matches between Report a Bug and Edit Bug", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  /** Every <label> inside the open modal's body, in DOM order, whitespace-normalized. */
  async function modalFieldLabels(page: Page, modalTitle: string): Promise<string[]> {
    const heading = page.getByRole("heading", { name: modalTitle, exact: true });
    const body = heading.locator("xpath=following-sibling::div[1]");
    const raw = await body.locator("label").allTextContents();
    return raw.map((t) => t.replace(/\s+/g, " ").trim());
  }

  /** Asserts each expected substring is found, in order, among the given labels. */
  function assertAscending(labels: string[], expected: string[]) {
    let last = -1;
    for (const needle of expected) {
      const idx = labels.findIndex((label, i) => i > last && label.includes(needle));
      expect(idx, `expected "${needle}" after index ${last} in [${labels.join(" | ")}]`).toBeGreaterThan(last);
      last = idx;
    }
  }

  const COMMON_ORDER = [
    "Bug Title",
    "Description",
    "Severity",
    "Priority",
    "Assign to",
    "Evidence",
    "Linked Test Case",
    "Where should this be tracked?",
    "Which system?",
  ];

  test("BUG-U-46 Report a Bug lists fields in the common order", async ({ page }) => {
    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: false } }));

    await openReportModal(page, projectId);
    // Reveals "Which system?" too, so the full common order can be checked in one pass.
    await page.getByRole("button", { name: /log it in my task management system myself/i }).click();

    const labels = await modalFieldLabels(page, "Report a Bug");
    assertAscending(labels, COMMON_ORDER);
  });

  test("BUG-U-47 Edit Bug lists fields in the same order, with Status added ahead of Severity without disturbing it", async ({ page }) => {
    const title = `E2E Bug Field Order ${uniqueSuffix()}`;
    await createBug(api, projectId, { title });

    await page.route(`**/api/projects/${projectId}/jira/status`, (route) => route.fulfill({ json: { connected: true } }));
    await page.route(`**/api/projects/${projectId}/linear/status`, (route) => route.fulfill({ json: { connected: false } }));

    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tbody tr").filter({ hasText: title });
    await row.getByRole("button", { name: "Edit bug" }).click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /log it in my task management system myself/i }).click();

    const labels = await modalFieldLabels(page, "Edit Bug");
    assertAscending(labels, COMMON_ORDER);

    // Status has no create-mode equivalent, so it isn't part of COMMON_ORDER — but it still must
    // sit right after Description and ahead of Severity, not trailing the Jira/Linear section the
    // way it used to.
    const statusIdx = labels.findIndex((l) => l === "Status");
    const descIdx = labels.findIndex((l) => l === "Description");
    const severityIdx = labels.findIndex((l) => l.includes("Severity"));
    expect(statusIdx, "Status must be present in Edit Bug").toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(descIdx);
    expect(statusIdx).toBeLessThan(severityIdx);
  });
});

/*
 * Bug Details as a right-side detail panel. It used to be a small centred modal; it now uses the
 * shared Drawer the Test Run detail panel uses (components/ui/Drawer.tsx), with the same content
 * and the same Edit / Delete / Close actions. These pin the placement, that nothing was dropped in
 * the move, and that every action and dismissal still does what it did in the modal.
 */
test.describe("bug details panel", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  /** The panel body. Drawer renders without role="dialog", so the page labels its own section. */
  function panelBody(page: Page): Locator {
    return page.getByRole("region", { name: "Bug details" });
  }

  /**
   * The whole drawer surface (header + body). The section sits in Drawer's scroll wrapper, whose
   * parent is the panel itself, two levels up. Drawer is shared and its close button has no
   * aria-label, so this is also how that header control is reached: it is the panel's first button.
   */
  function panel(page: Page): Locator {
    return panelBody(page).locator("xpath=../..");
  }

  async function openFromList(page: Page, title: string): Promise<void> {
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.locator("tbody tr").filter({ hasText: title }).click();
    await expect(panelBody(page)).toBeVisible();
  }

  test("BUG-U-48 opening a bug shows a full-height panel docked to the right, with every detail and action", async ({ page }) => {
    const suffix = uniqueSuffix();
    const cycle = await (await api.post(`/api/projects/${projectId}/cycles`, { data: { name: `E2E Panel Run ${suffix}` } })).json();
    const testcase = await (
      await api.post(`/api/projects/${projectId}/testcases`, { data: { title: `E2E Panel Case ${suffix}` } })
    ).json();
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
    const me = await (await api.get("/api/auth/me")).json();
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, {
        data: {
          title: `E2E Panel Bug ${suffix}`,
          description: `Panel description ${suffix}`,
          severity: "High",
          priority: "P1",
          assigneeId: me.userId,
          links: [{ testcaseId: testcase.id, cycleId: cycle.id }],
        },
      })
    ).json();
    try {
      await openFromList(page, bug.title);

      // Placement: right edge of the viewport, full height, the Drawer's 480px width.
      const viewport = page.viewportSize()!;
      const box = (await panel(page).boundingBox())!;
      expect(box.x + box.width).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(box.y).toBeLessThanOrEqual(1);
      expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
      expect(box.width).toBeLessThanOrEqual(481);
      expect(box.x, "a centred modal would leave room on the right").toBeGreaterThan(viewport.width / 2);

      // Header: eyebrow, key and title.
      const surface = panel(page);
      await expect(surface.getByText("Bug Details", { exact: true })).toBeVisible();
      await expect(surface.getByText(bug.externalId, { exact: true })).toBeVisible();
      await expect(surface.getByRole("heading", { name: bug.title })).toBeVisible();

      // Body: every field the modal had.
      const body = panelBody(page);
      for (const label of ["Description", "Severity", "Priority", "Status", "Linked Test Cases & Runs", "Reported By", "Assigned To", "Reported On"]) {
        await expect(body.getByText(label, { exact: true }), label).toBeVisible();
      }
      await expect(body.getByText(`Panel description ${suffix}`)).toBeVisible();
      await expect(body.getByText("High", { exact: true })).toBeVisible();
      await expect(body.getByText("P1", { exact: true })).toBeVisible();
      await expect(body.getByText("Open", { exact: true })).toBeVisible();
      await expect(body.getByText(testcase.title)).toBeVisible();
      await expect(body.getByText(`— ${cycle.name}`)).toBeVisible();

      // Footer actions.
      for (const name of ["Edit", "Close", "Delete Bug"]) {
        await expect(body.getByRole("button", { name, exact: true })).toBeVisible();
      }
      await expect(body.getByRole("link", { name: "Open full page" })).toHaveAttribute(
        "href",
        `/projects/${projectId}/bugs/${bug.id}`,
      );
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      await api.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await api.delete(`/api/testcases/${testcase.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-49 a board card opens the same panel", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Panel Board ${uniqueSuffix()}` });
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page.locator('[role="button"]').filter({ hasText: bug.title }).first().click();
      await expect(panelBody(page)).toBeVisible();
      await expect(panel(page).getByRole("heading", { name: bug.title })).toBeVisible();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-50 Close, the header close button, Escape and a backdrop click each dismiss the panel", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Panel Dismiss ${uniqueSuffix()}` });
    try {
      await openFromList(page, bug.title);
      await panelBody(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(panelBody(page)).toBeHidden();

      await page.locator("tbody tr").filter({ hasText: bug.title }).click();
      await panel(page).locator("button").first().click();
      await expect(panelBody(page)).toBeHidden();

      await page.locator("tbody tr").filter({ hasText: bug.title }).click();
      await expect(panelBody(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panelBody(page)).toBeHidden();

      await page.locator("tbody tr").filter({ hasText: bug.title }).click();
      await expect(panelBody(page)).toBeVisible();
      // The backdrop fills the viewport behind the right-docked panel; its far left is backdrop.
      await page.mouse.click(10, page.viewportSize()!.height / 2);
      await expect(panelBody(page)).toBeHidden();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  /** The full page's in-place Edit Bug card. */
  function fullPageEditForm(page: Page): Locator {
    return page.getByRole("region", { name: "Edit bug" });
  }

  /** FieldLabel has no htmlFor, so the title is reached as the first input after its label. */
  function fullPageTitleInput(page: Page): Locator {
    return fullPageEditForm(page).locator("xpath=.//label[contains(., 'Bug Title')]/following::input[1]");
  }

  test("BUG-U-51 Edit opens the full bug page straight into its edit form, and Cancel leaves it on the bug", async ({ page }) => {
    // Was: Edit opened the Edit Bug dialog over the list. Changed on request — the panel's Edit now
    // goes to the full-page form (the list row / board card pencil still use the dialog, BUG-U-13).
    const bug = await createBug(api, projectId, { title: `E2E Panel Edit ${uniqueSuffix()}` });
    try {
      await openFromList(page, bug.title);
      await panelBody(page).getByRole("button", { name: "Edit", exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs/${bug.id}\\?edit=1$`));
      await expect(panelBody(page)).toHaveCount(0);
      await expect(fullPageEditForm(page)).toBeVisible();
      await expect(fullPageTitleInput(page)).toHaveValue(bug.title);
      // In place, not the dialog: the form spans the page's main column.
      const formBox = (await fullPageEditForm(page).boundingBox())!;
      const mainBox = (await fullPageEditForm(page).locator("xpath=ancestor::main[1]").boundingBox())!;
      expect(formBox.width).toBeGreaterThan(mainBox.width - 60);

      await fullPageEditForm(page).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(fullPageEditForm(page)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Bug details" })).toBeVisible();
      // The flag is dropped, so a refresh shows the bug rather than reopening the form.
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs/${bug.id}$`));
      await page.reload();
      await expect(page.getByRole("region", { name: "Bug details" })).toBeVisible();
      await expect(fullPageEditForm(page)).toHaveCount(0);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-70 saving the full-page form opened from the panel's Edit persists and shows the bug", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Panel Edit Save ${uniqueSuffix()}` });
    const renamed = `${bug.title} saved`;
    try {
      await openFromList(page, bug.title);
      await panelBody(page).getByRole("button", { name: "Edit", exact: true }).click();
      await fullPageTitleInput(page).fill(renamed);
      await fullPageEditForm(page).getByLabel("Severity").selectOption("Critical");
      await page.getByRole("button", { name: "Save Changes" }).click();

      await expect(fullPageEditForm(page)).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs/${bug.id}$`));
      await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
      await expect(page.getByRole("region", { name: "Bug details" }).getByText("Critical", { exact: true })).toBeVisible();

      const persisted = await (await api.get(`/api/bugs/${bug.id}`)).json();
      expect(persisted.title).toBe(renamed);
      expect(persisted.severity).toBe("Critical");
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-52 Delete Bug asks for confirmation, and confirming removes the bug", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Panel Delete ${uniqueSuffix()}` });
    try {
      await openFromList(page, bug.title);
      await panelBody(page).getByRole("button", { name: "Delete Bug", exact: true }).click();
      await expect(panelBody(page)).toBeHidden();
      // The confirm modal's title is the only "Delete Bug" text left once the panel is gone.
      await expect(page.getByText("Delete Bug", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      await expect(page.locator("tbody tr").filter({ hasText: bug.title })).toHaveCount(0);
      expect((await api.get(`/api/bugs/${bug.id}`, { failOnStatusCode: false })).status()).toBe(404);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-53 an untriaged, unassigned, unlinked bug shows its empty states, and no Last updated", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Panel Empty ${uniqueSuffix()}` });
    try {
      await openFromList(page, bug.title);
      const body = panelBody(page);
      // Neither severity nor priority was given, so both read "Not selected" (V130).
      await expect(body.getByText("Not selected", { exact: true })).toHaveCount(2);
      await expect(body.getByText("Unassigned", { exact: true })).toBeVisible();
      await expect(body.getByText("Not linked", { exact: true })).toBeVisible();
      // No description was given, so the section is omitted rather than rendered empty.
      await expect(body.getByText("Description", { exact: true })).toHaveCount(0);
      await expect(body.getByText(/^Last updated:/)).toHaveCount(0);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-54 Last updated appears once the bug has been edited", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Panel Updated ${uniqueSuffix()}` });
    try {
      await api.patch(`/api/bugs/${bug.id}`, { data: { status: "In Progress" } });
      await openFromList(page, bug.title);
      await expect(panelBody(page).getByText(/^Last updated:/)).toBeVisible();
      await expect(panelBody(page).getByText("In Progress", { exact: true })).toBeVisible();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-55 a long description scrolls inside the panel while the footer actions stay on screen", async ({ page }) => {
    const description = Array.from({ length: 150 }, (_, i) => `Line ${i + 1} of a long reproduction`).join("\n");
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, { data: { title: `E2E Panel Long ${uniqueSuffix()}`, description } })
    ).json();
    try {
      await openFromList(page, bug.title);
      const body = panelBody(page);
      const viewportHeight = page.viewportSize()!.height;

      // The footer is pinned: fully inside the viewport without any scrolling.
      const edit = body.getByRole("button", { name: "Edit", exact: true });
      await expect(edit).toBeInViewport({ ratio: 1 });
      const editBox = (await edit.boundingBox())!;
      expect(editBox.y + editBox.height).toBeLessThanOrEqual(viewportHeight);

      // The body is what scrolls, and scrolling it reaches the last line.
      const scroller = body.locator(":scope > div").first();
      const overflows = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(overflows, "a 150-line description must overflow the panel body").toBe(true);
      await body.getByText("Line 150 of a long reproduction").scrollIntoViewIfNeeded();
      await expect(body.getByText("Line 150 of a long reproduction")).toBeInViewport();
      await expect(edit).toBeInViewport({ ratio: 1 });
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * The full-page bug view at /projects/:id/bugs/:bugId — the panel's "Open full page" target, the
 * way the execute page is for the Test Run panel. It renders the same BugDetailsBody as the panel
 * and the same EditBugModal as the list, so these cover the route, the navigation in and out of
 * it, and its own Edit / Delete wiring; the modal's form behaviour is covered by the Edit Bug
 * specs above.
 */
test.describe("bug full page", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  /** The page's details card. Labelled by the page itself; nothing here has role="dialog". */
  function details(page: Page): Locator {
    return page.getByRole("region", { name: "Bug details" });
  }

  test("BUG-U-56 Open full page goes from the panel to the bug's own page, with every detail and a way back", async ({ page }) => {
    const suffix = uniqueSuffix();
    const bug = await (
      await api.post(`/api/projects/${projectId}/bugs`, {
        data: { title: `E2E Full Page ${suffix}`, description: `Full page description ${suffix}`, severity: "Critical", priority: "P0" },
      })
    ).json();
    try {
      await page.goto(`/projects/${projectId}/bugs`);
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.locator("tbody tr").filter({ hasText: bug.title }).click();
      await page.getByRole("link", { name: "Open full page" }).click();

      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs/${bug.id}$`));
      await expect(page.getByRole("heading", { level: 1, name: bug.title })).toBeVisible();
      await expect(page.getByText(bug.externalId, { exact: true }).first()).toBeVisible();
      // The side panel is not what is showing: the list page and its drawer are gone.
      await expect(page.locator("tbody tr")).toHaveCount(0);

      const card = details(page);
      for (const label of ["Description", "Severity", "Priority", "Status", "Linked Test Cases & Runs", "Reported By", "Assigned To", "Reported On"]) {
        await expect(card.getByText(label, { exact: true }), label).toBeVisible();
      }
      await expect(card.getByText(`Full page description ${suffix}`)).toBeVisible();
      await expect(card.getByText("Critical", { exact: true })).toBeVisible();
      await expect(card.getByText("P0", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete Bug", exact: true })).toBeVisible();

      // Breadcrumb back to the list. Scoped to the page header: the app sidebar has its own
      // "Bugs" link.
      await page.locator("header").getByRole("link", { name: "Bugs", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs$`));
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  /** The in-page Edit Bug card (the list uses a dialog; this page edits in place). */
  function editForm(page: Page): Locator {
    return page.getByRole("region", { name: "Edit bug" });
  }

  /** FieldLabel is not tied to its input (no htmlFor), so getByLabel cannot reach the title; it
   *  is the first input after the "Bug Title" label. */
  function titleInput(page: Page): Locator {
    return editForm(page).locator("xpath=.//label[contains(., 'Bug Title')]/following::input[1]");
  }

  test("BUG-U-57 Edit on the full page edits in place, saves, and the page shows the new values", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Full Page Edit ${uniqueSuffix()}` });
    const renamed = `${bug.title} renamed`;
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      await page.getByRole("button", { name: "Edit", exact: true }).click();

      // In place, like the Test Run execute page: the form card replaces the details card, the
      // header's Edit/Delete give way to the form's own actions, and no dialog opens over it.
      await expect(editForm(page)).toBeVisible();
      await expect(details(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete Bug", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2, name: "Edit Bug" })).toBeVisible();
      const formBox = (await editForm(page).boundingBox())!;
      const mainBox = (await editForm(page).locator("xpath=ancestor::main[1]").boundingBox())!;
      expect(formBox.width, "the form spans the page, it is not a centred dialog").toBeGreaterThan(mainBox.width - 60);

      await expect(titleInput(page)).toHaveValue(bug.title);
      await titleInput(page).fill(renamed);
      await editForm(page).getByLabel("Bug priority").selectOption("P2");
      await page.getByRole("button", { name: "Save Changes" }).click();

      await expect(editForm(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
      await expect(details(page).getByText("P2", { exact: true })).toBeVisible();

      const persisted = await (await api.get(`/api/bugs/${bug.id}`)).json();
      expect(persisted.title).toBe(renamed);
      expect(persisted.priority).toBe("P2");
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-61 Cancel on the in-place edit discards the change and restores the details", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Full Page Cancel ${uniqueSuffix()}` });
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await titleInput(page).fill(`${bug.title} discarded`);
      await editForm(page).getByRole("button", { name: "Cancel", exact: true }).click();

      await expect(editForm(page)).toHaveCount(0);
      await expect(details(page)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: bug.title, exact: true })).toBeVisible();
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).title).toBe(bug.title);

      // Reopening starts from the stored bug, not the discarded draft.
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(titleInput(page)).toHaveValue(bug.title);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-62 the full page uses the page width, with no extra side gutters around the details", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Full Page Width ${uniqueSuffix()}` });
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      const card = (await details(page).boundingBox())!;
      const main = (await details(page).locator("xpath=ancestor::main[1]").boundingBox())!;
      // Only main's own px-6 (24px a side) separates the card from the page edges — the same
      // gutter the execute page has, not a centred max-width column.
      expect(card.x - main.x).toBeLessThanOrEqual(25);
      expect(main.x + main.width - (card.x + card.width)).toBeLessThanOrEqual(25);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-58 Delete on the full page can be cancelled, and confirming it deletes and returns to the list", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Full Page Delete ${uniqueSuffix()}` });
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);

      await page.getByRole("button", { name: "Delete Bug", exact: true }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: bug.title })).toBeVisible();
      expect((await api.get(`/api/bugs/${bug.id}`, { failOnStatusCode: false })).status()).toBe(200);

      await page.getByRole("button", { name: "Delete Bug", exact: true }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs$`));
      expect((await api.get(`/api/bugs/${bug.id}`, { failOnStatusCode: false })).status()).toBe(404);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-59 an unknown or deleted bug id says so and links back to the list", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Full Page Gone ${uniqueSuffix()}` });
    await api.delete(`/api/bugs/${bug.id}`);

    for (const id of [bug.id, "00000000-0000-0000-0000-000000000000"]) {
      await page.goto(`/projects/${projectId}/bugs/${id}`);
      await expect(page.getByText("This bug could not be found. It may have been deleted.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete Bug", exact: true })).toHaveCount(0);
    }
    await page.getByRole("link", { name: "Back to Bugs" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/bugs$`));
  });

  test("BUG-U-60 a signed-out visitor is sent to log in and never sees the bug", async ({ browser }) => {
    const bug = await createBug(api, projectId, { title: `E2E Full Page Anon ${uniqueSuffix()}` });
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anon = await ctx.newPage();
      await anon.goto(`/projects/${projectId}/bugs/${bug.id}`);
      await expect(anon).toHaveURL(/\/login/);
      await expect(anon.getByText(bug.title)).toHaveCount(0);
    } finally {
      await ctx.close();
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * The Comments section at the bottom of Bug Details (components/bugs/BugComments.tsx) — in the side
 * panel and on the full page. The API contract (validation, ordering, access) is in
 * api/bugs.spec.ts "bug comments"; this is what the person reading the bug sees and does.
 */
test.describe("bug comments", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  type SeededComment = { id: string; authorName: string; body: string; createdAt: string };

  function commentsUrl(bugId: string) {
    return `/api/projects/${projectId}/bugs/${bugId}/comments`;
  }

  /** Every request the page makes for this bug's comments, for route interception. */
  function commentsRoute(bugId: string) {
    return `**/api/projects/${projectId}/bugs/${bugId}/comments`;
  }

  async function seedComment(bugId: string, body: string): Promise<SeededComment> {
    const res = await api.post(commentsUrl(bugId), { data: { body } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  /** The panel body; Drawer has no role="dialog", so the page labels its own section. */
  function panelBody(page: Page): Locator {
    return page.getByRole("region", { name: "Bug details" });
  }

  function comments(scope: Locator): Locator {
    return scope.getByRole("region", { name: "Comments" });
  }

  async function openPanel(page: Page, title: string): Promise<void> {
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.locator("tbody tr").filter({ hasText: title }).click();
    await expect(panelBody(page)).toBeVisible();
  }

  test("BUG-U-63 the panel lists existing comments oldest first, each with its author and timestamp, below the details", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Comments List ${uniqueSuffix()}` });
    try {
      const first = await seedComment(bug.id, "First look: reproduces on Chrome.");
      const second = await seedComment(bug.id, "Second look:\nalso on Firefox.");
      await openPanel(page, bug.title);

      const section = comments(panelBody(page));
      await expect(section.getByText("Comments (2)")).toBeVisible();
      const items = section.getByTestId("bug-comment");
      await expect(items).toHaveCount(2);
      for (const [i, c] of [first, second].entries()) {
        await expect(items.nth(i).getByText(c.authorName, { exact: true })).toBeVisible();
        await expect(items.nth(i).locator("time")).toHaveAttribute("datetime", c.createdAt);
      }
      await expect(items.nth(0)).toContainText("First look: reproduces on Chrome.");
      // Line breaks in a comment survive (whitespace-pre-wrap), rather than collapsing into one line.
      await expect(items.nth(1).getByText(/Second look:\s+also on Firefox\./)).toBeVisible();

      // Placement: after the last details field, inside the scrolling body, above the footer.
      const reportedOn = (await panelBody(page).getByText("Reported On", { exact: true }).boundingBox())!;
      const sectionBox = (await section.boundingBox())!;
      expect(sectionBox.y).toBeGreaterThan(reportedOn.y);
      const footerEdit = panelBody(page).getByRole("button", { name: "Edit", exact: true });
      await section.scrollIntoViewIfNeeded();
      expect((await section.boundingBox())!.y).toBeLessThan((await footerEdit.boundingBox())!.y);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-64 a bug with no comments says so, and Add Comment stays disabled until there is text", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Comments Empty ${uniqueSuffix()}` });
    try {
      await openPanel(page, bug.title);
      const section = comments(panelBody(page));
      await expect(section.getByText("No comments yet.")).toBeVisible();
      const add = section.getByRole("button", { name: "Add Comment" });
      await expect(add).toBeDisabled();
      await section.getByLabel("Add a comment").fill("   \n  ");
      await expect(add, "whitespace alone is not a comment").toBeDisabled();
      await section.getByLabel("Add a comment").fill("Now there is text");
      await expect(add).toBeEnabled();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-65 adding a comment shows it straight away, clears the box, and it is saved", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Comments Add ${uniqueSuffix()}` });
    const body = `Added from the panel ${uniqueSuffix()}`;
    try {
      await openPanel(page, bug.title);
      const section = comments(panelBody(page));
      await expect(section.getByText("No comments yet.")).toBeVisible();

      // Count list fetches: the new comment must come from the POST response, not a refetch.
      let listFetches = 0;
      await page.route(commentsRoute(bug.id), (route) => {
        if (route.request().method() === "GET") listFetches += 1;
        return route.continue();
      });

      await section.getByLabel("Add a comment").fill(`  ${body}  `);
      await section.getByRole("button", { name: "Add Comment" }).click();

      const items = section.getByTestId("bug-comment");
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText(body);
      await expect(section.getByText("No comments yet.")).toHaveCount(0);
      await expect(section.getByText("Comments (1)")).toBeVisible();
      await expect(section.getByLabel("Add a comment")).toHaveValue("");
      expect(listFetches).toBe(0);

      const persisted = await (await api.get(commentsUrl(bug.id))).json();
      expect(persisted.list.map((c: { body: string }) => c.body)).toEqual([body]);
      await expect(items.first().getByText(persisted.list[0].authorName, { exact: true })).toBeVisible();

      // And it is still there when the bug is opened again.
      await page.unroute(commentsRoute(bug.id));
      await openPanel(page, bug.title);
      await expect(comments(panelBody(page)).getByTestId("bug-comment")).toHaveCount(1);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-66 a failed post shows the server's reason, keeps the draft, and a retry succeeds", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Comments Post Error ${uniqueSuffix()}` });
    const body = `Retry me ${uniqueSuffix()}`;
    try {
      await openPanel(page, bug.title);
      const section = comments(panelBody(page));
      await expect(section.getByText("No comments yet.")).toBeVisible();

      await page.route(commentsRoute(bug.id), (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Comment service unavailable." }) })
          : route.continue(),
      );
      await section.getByLabel("Add a comment").fill(body);
      await section.getByRole("button", { name: "Add Comment" }).click();

      await expect(section.getByTestId("bug-comment-error")).toContainText("Comment service unavailable.");
      await expect(section.getByLabel("Add a comment")).toHaveValue(body);
      await expect(section.getByTestId("bug-comment")).toHaveCount(0);
      await expect(section.getByRole("button", { name: "Add Comment" })).toBeEnabled();

      await page.unroute(commentsRoute(bug.id));
      await section.getByRole("button", { name: "Add Comment" }).click();
      await expect(section.getByTestId("bug-comment")).toHaveCount(1);
      await expect(section.getByTestId("bug-comment-error")).toHaveCount(0);
      const persisted = await (await api.get(commentsUrl(bug.id))).json();
      expect(persisted.total, "the failed attempt must not have stored anything").toBe(1);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-67 comments show a loading state, and a failed load offers Retry", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Comments Load Error ${uniqueSuffix()}` });
    try {
      await seedComment(bug.id, "Visible after retry");
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let failNext = true;
      await page.route(commentsRoute(bug.id), async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        if (failNext) {
          failNext = false;
          // Hold the first load open long enough to see the loading state, then fail it.
          await held;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Upstream timeout" }) });
        }
        return route.continue();
      });

      await openPanel(page, bug.title);
      const section = comments(panelBody(page));
      await expect(section.getByText("Loading comments…")).toBeVisible();
      release();

      await expect(section.getByRole("alert")).toContainText("Couldn't load comments: Upstream timeout");
      await expect(section.getByText("No comments yet."), "a failed load is not an empty list").toHaveCount(0);
      await section.getByRole("button", { name: "Retry" }).click();
      await expect(section.getByTestId("bug-comment")).toHaveCount(1);
      await expect(section.getByText("Visible after retry")).toBeVisible();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-68 switching to another bug shows that bug's comments, not the previous one's", async ({ page }) => {
    const a = await createBug(api, projectId, { title: `E2E Comments Switch A ${uniqueSuffix()}` });
    const b = await createBug(api, projectId, { title: `E2E Comments Switch B ${uniqueSuffix()}` });
    try {
      await seedComment(a.id, "Only on bug A");
      await openPanel(page, a.title);
      await expect(comments(panelBody(page)).getByText("Only on bug A")).toBeVisible();
      await comments(panelBody(page)).getByLabel("Add a comment").fill("Unsent draft for A");

      await panelBody(page).getByRole("button", { name: "Close", exact: true }).click();
      await page.locator("tbody tr").filter({ hasText: b.title }).click();
      const section = comments(panelBody(page));
      await expect(section.getByText("No comments yet.")).toBeVisible();
      await expect(section.getByText("Only on bug A")).toHaveCount(0);
      await expect(section.getByLabel("Add a comment")).toHaveValue("");
    } finally {
      await api.delete(`/api/bugs/${a.id}`, { failOnStatusCode: false });
      await api.delete(`/api/bugs/${b.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-69 the full bug page shows the same comments and can add one", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Comments Full Page ${uniqueSuffix()}` });
    const body = `Added from the full page ${uniqueSuffix()}`;
    try {
      const seeded = await seedComment(bug.id, "Seeded before opening");
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      const section = comments(page.getByRole("region", { name: "Bug details" }));
      await expect(section.getByTestId("bug-comment")).toHaveCount(1);
      await expect(section.getByText(seeded.authorName, { exact: true })).toBeVisible();

      await section.getByLabel("Add a comment").fill(body);
      await section.getByRole("button", { name: "Add Comment" }).click();
      await expect(section.getByTestId("bug-comment")).toHaveCount(2);
      await expect(section.getByTestId("bug-comment").nth(1)).toContainText(body);

      const persisted = await (await api.get(commentsUrl(bug.id))).json();
      expect(persisted.list.map((c: { body: string }) => c.body)).toEqual(["Seeded before opening", body]);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * The Attachments section of Bug Details (components/bugs/BugAttachments.tsx): image thumbnails
 * with an in-app preview, filename links for everything else, and Open/View + Delete on every file.
 * Upload, storage and the delete endpoint itself are covered in api/attachments.spec.ts.
 */
test.describe("bug attachments in Bug Details", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  type Attachment = { id: string; fileName: string };

  /** A bug with these files attached, through the same upload route the Report Bug form uses. */
  async function bugWith(label: string, files: UploadFile[]): Promise<{ id: string; title: string; attachments: Attachment[] }> {
    const bug = await createBug(api, projectId, { title: `E2E Attachments ${label} ${uniqueSuffix()}` });
    // The route takes at most 10 files per request (FilesInterceptor's cap), as the UI batches too.
    for (let i = 0; i < files.length; i += 10) {
      const res = await api.post(`/api/projects/${projectId}/bugs/${bug.id}/attachments`, {
        multipart: filesForm(files.slice(i, i + 10)),
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }
    const full = await (await api.get(`/api/bugs/${bug.id}`)).json();
    return { ...bug, attachments: full.attachments };
  }

  function downloadUrl(attachmentId: string) {
    return `/api/projects/${projectId}/bugs/attachments/${attachmentId}/download`;
  }

  function panelBody(page: Page): Locator {
    return page.getByRole("region", { name: "Bug details" });
  }

  async function openPanel(page: Page, title: string): Promise<void> {
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.locator("tbody tr").filter({ hasText: title }).click();
    await expect(panelBody(page)).toBeVisible();
  }

  /** True once the browser actually decoded the image — a broken or unauthorised src stays 0×0. */
  async function expectDecoded(img: Locator): Promise<void> {
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
      .toBe(true);
  }

  test("BUG-U-71 images show as thumbnails and other files as filename links, each with Open/View and Delete", async ({ page }) => {
    const bug = await bugWith("Mixed", [
      pngFile("shot-one.png"),
      pngFile("shot-two.png"),
      sizedFile("report.pdf", 2048, "application/pdf"),
      textFile("console.txt"),
    ]);
    try {
      await openPanel(page, bug.title);
      const body = panelBody(page);
      await expect(body.getByText("Attachments (4)")).toBeVisible();

      const thumbs = body.getByTestId("bug-attachment-image");
      await expect(thumbs).toHaveCount(2);
      for (const name of ["shot-one.png", "shot-two.png"]) {
        const thumb = thumbs.filter({ hasText: name });
        await expectDecoded(thumb.getByRole("img", { name }));
        await expect(thumb.getByRole("button", { name: `View ${name}` }).first()).toBeVisible();
        await expect(thumb.getByRole("button", { name: `Delete ${name}` })).toBeVisible();
      }

      const rows = body.getByTestId("bug-attachment-file");
      await expect(rows).toHaveCount(2);
      for (const name of ["report.pdf", "console.txt"]) {
        const att = bug.attachments.find((a) => a.fileName === name)!;
        const row = rows.filter({ hasText: name });
        await expect(row.getByRole("img")).toHaveCount(0);
        // Open keeps the existing behaviour for non-images: the file's download route, in a new tab.
        const open = row.getByRole("link", { name: `Open ${name}` });
        await expect(open).toHaveAttribute("href", new RegExp(`${downloadUrl(att.id)}$`));
        await expect(open).toHaveAttribute("target", "_blank");
        await expect(row.getByRole("link", { name, exact: true })).toHaveAttribute("href", new RegExp(`${downloadUrl(att.id)}$`));
        await expect(row.getByRole("button", { name: `Delete ${name}` })).toBeVisible();
      }
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-72 View opens the full image in a preview, and closing it keeps Bug Details open", async ({ page }) => {
    const bug = await bugWith("Preview", [pngFile("preview-me.png")]);
    try {
      await openPanel(page, bug.title);
      await panelBody(page).getByRole("button", { name: "View preview-me.png" }).first().click();

      const preview = page.getByRole("region", { name: "Attachment preview" });
      await expect(preview).toBeVisible();
      await expect(preview.getByRole("heading", { name: "preview-me.png" })).toBeVisible();
      await expectDecoded(preview.getByRole("img", { name: "preview-me.png" }));
      await expect(preview.getByRole("link", { name: "Download" })).toHaveAttribute(
        "href",
        new RegExp(`${downloadUrl(bug.attachments[0].id)}$`),
      );

      await preview.getByRole("button", { name: "Close preview" }).click();
      await expect(preview).toHaveCount(0);
      await expect(panelBody(page)).toBeVisible();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-73 deleting an image asks first; Cancel keeps it, confirming removes it from the panel and the server", async ({ page }) => {
    const bug = await bugWith("Delete Image", [pngFile("keep.png"), pngFile("remove.png")]);
    const removed = bug.attachments.find((a) => a.fileName === "remove.png")!;
    try {
      await openPanel(page, bug.title);
      const body = panelBody(page);

      await body.getByRole("button", { name: "Delete remove.png" }).click();
      await expect(page.getByText("Delete attachment", { exact: true })).toBeVisible();
      await expect(page.getByText(`Delete "remove.png" from this bug?`, { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(body.getByTestId("bug-attachment-image")).toHaveCount(2);
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).attachments).toHaveLength(2);

      await body.getByRole("button", { name: "Delete remove.png" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(body.getByTestId("bug-attachment-image")).toHaveCount(1);
      await expect(body.getByTestId("bug-attachment-image").filter({ hasText: "keep.png" })).toBeVisible();
      await expect(body.getByText("Attachments (1)")).toBeVisible();
      // The panel is still the same bug — deleting a file is not deleting the bug.
      await expect(body).toBeVisible();

      const after = await (await api.get(`/api/bugs/${bug.id}`)).json();
      expect(after.attachments.map((a: Attachment) => a.fileName)).toEqual(["keep.png"]);
      expect((await api.get(downloadUrl(removed.id), { failOnStatusCode: false })).ok()).toBe(false);

      // And the list was refreshed: reopening shows one file, not a stale two.
      await page.reload();
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.locator("tbody tr").filter({ hasText: bug.title }).click();
      await expect(panelBody(page).getByTestId("bug-attachment-image")).toHaveCount(1);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-74 a non-image file can be deleted from the full bug page, and the last one removes the section", async ({ page }) => {
    const bug = await bugWith("Delete File", [sizedFile("spec.pdf", 1024, "application/pdf")]);
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      const card = page.getByRole("region", { name: "Bug details" });
      await expect(card.getByTestId("bug-attachment-file")).toHaveCount(1);
      await card.getByRole("button", { name: "Delete spec.pdf" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      await expect(card.getByTestId("bug-attachment-file")).toHaveCount(0);
      await expect(card.getByText(/^Attachments/)).toHaveCount(0);
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).attachments).toEqual([]);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-75 a failed delete says so and leaves the attachment in place", async ({ page }) => {
    const bug = await bugWith("Delete Error", [pngFile("stuck.png")]);
    try {
      await openPanel(page, bug.title);
      await page.route("**/api/bugs/attachments/*", (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Storage is unavailable." }) })
          : route.continue(),
      );
      await panelBody(page).getByRole("button", { name: "Delete stuck.png" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      await expect(panelBody(page).getByTestId("bug-attachment-error")).toContainText("Storage is unavailable.");
      await expect(panelBody(page).getByTestId("bug-attachment-image")).toHaveCount(1);
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).attachments).toHaveLength(1);
    } finally {
      await page.unroute("**/api/bugs/attachments/*");
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-77 the Edit Bug form shows thumbnails for existing image attachments, and none for other files", async ({ page }) => {
    const bug = await bugWith("Edit Thumbs", [pngFile("edit-shot.png"), sizedFile("edit-notes.pdf", 1024, "application/pdf")]);
    try {
      // Both ways into Edit Bug render the same field: the full-page form and the list's dialog.
      await page.goto(`/projects/${projectId}/bugs/${bug.id}?edit=1`);
      const form = page.getByRole("region", { name: "Edit bug" });
      await expect(form.getByTestId("evidence-thumbnail")).toHaveCount(1);
      await expectDecoded(form.getByRole("img", { name: "edit-shot.png" }));
      await expect(form.getByRole("img", { name: "edit-notes.pdf" })).toHaveCount(0);
      await expect(form.getByRole("link", { name: "edit-notes.pdf" })).toBeVisible();

      await page.goto(`/projects/${projectId}/bugs`);
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.locator("tbody tr").filter({ hasText: bug.title }).getByRole("button", { name: "Edit bug" }).click();
      await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();
      await expectDecoded(page.getByRole("img", { name: "edit-shot.png" }));
      await expect(page.getByTestId("evidence-thumbnail")).toHaveCount(1);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-78 a newly picked image is previewed before saving, and removing it removes the preview", async ({ page }) => {
    const bug = await createBug(api, projectId, { title: `E2E Attachments Staged ${uniqueSuffix()}` });
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}?edit=1`);
      const form = page.getByRole("region", { name: "Edit bug" });
      const png = pngFile("picked.png");
      const txt = textFile("picked.txt");
      await form.locator('input[type="file"]').setInputFiles([
        { name: png.name, mimeType: png.mimeType, buffer: png.body },
        { name: txt.name, mimeType: txt.mimeType, buffer: txt.body },
      ]);

      await expect(form.getByText("picked.txt")).toBeVisible();
      await expect(form.getByTestId("evidence-thumbnail")).toHaveCount(1);
      await expectDecoded(form.getByRole("img", { name: "picked.png" }));
      // Nothing is uploaded until Save.
      expect((await (await api.get(`/api/bugs/${bug.id}`)).json()).attachments).toEqual([]);

      await form.locator("li", { hasText: "picked.png" }).getByRole("button").click();
      await expect(form.getByTestId("evidence-thumbnail")).toHaveCount(0);
      await expect(form.getByText("picked.txt")).toBeVisible();
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-76 many attachments wrap inside the panel without widening it", async ({ page }) => {
    const files = [
      ...Array.from({ length: 10 }, (_, i) => pngFile(`Screenshot 2026-09-11 1${String(i).padStart(5, "0")} with a long name.png`)),
      sizedFile("Tesbo_RAG_Testing_Report_with_a_very_long_file_name_indeed.docx", 1024, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ];
    const bug = await bugWith("Many", files);
    try {
      await openPanel(page, bug.title);
      const body = panelBody(page);
      await expect(body.getByTestId("bug-attachment-image")).toHaveCount(10);
      await expect(body.getByTestId("bug-attachment-file")).toHaveCount(1);

      // No horizontal overflow: the scroll area is no wider than the panel it sits in.
      const scroller = body.locator(":scope > div").first();
      const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const panelBox = (await body.boundingBox())!;
      for (const box of await body.getByTestId("bug-attachment-image").evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().right),
      )) {
        expect(box).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      }
      // The footer actions are still where they were.
      await expect(body.getByRole("button", { name: "Delete Bug", exact: true })).toBeInViewport({ ratio: 1 });
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});

/*
 * Bug Details' Activity section: the bug's own history (from the project activity feed, filtered
 * to this bug) beside Comments on the full page, stacked under it in the narrow side panel. The
 * logging itself — which actions, which actor — is specified in api/bugs.spec.ts "bug activity";
 * these tests are about what the screen shows.
 */
test.describe("bug activity", () => {
  let api: APIRequestContext;
  let projectId: string;
  let actorName: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  /** A fresh bug, plus the name the feed attributes its creation to (the screens user). */
  async function seedBug(label: string) {
    const bug = await createBug(api, projectId, { title: `E2E Activity ${label} ${uniqueSuffix()}` });
    const feed = await (
      await api.get(`/api/projects/${projectId}/activity`, { params: { entityType: "bug", entityId: bug.id } })
    ).json();
    actorName = feed.list.find((i: { action: string }) => i.action === "bug_created")?.actorName;
    expect(actorName, "the bug_created row names who filed the bug").toBeTruthy();
    return bug;
  }

  function detailsRegion(page: Page): Locator {
    return page.getByRole("region", { name: "Bug details" });
  }

  test("BUG-U-79 the full page shows Activity beside Comments, oldest first, naming the actor of each entry", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const bug = await seedBug("Page");
    try {
      await api.patch(`/api/bugs/${bug.id}`, { data: { status: "In Progress", priority: "P1" } });
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);

      const activity = detailsRegion(page).getByRole("region", { name: "Activity" });
      const comments = detailsRegion(page).getByRole("region", { name: "Comments" });
      const entries = activity.getByTestId("bug-activity");
      await expect(entries).toHaveCount(3);
      await expect(entries.nth(0)).toContainText(`${actorName} created the bug`);
      await expect(entries.nth(1)).toContainText(`${actorName} changed status from Open to In Progress`);
      await expect(entries.nth(2)).toContainText(`${actorName} changed priority from None to P1`);
      await expect(entries.nth(0).locator("time")).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);

      // Side by side: same row, Activity to the right of Comments.
      const c = (await comments.boundingBox())!;
      const a = (await activity.boundingBox())!;
      expect(Math.abs(a.y - c.y)).toBeLessThan(4);
      expect(a.x).toBeGreaterThan(c.x + c.width - 4);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-80 posting a comment adds its entry to Activity without a reload, and Comments still works as before", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const bug = await seedBug("Comment");
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      const activity = detailsRegion(page).getByRole("region", { name: "Activity" });
      const comments = detailsRegion(page).getByRole("region", { name: "Comments" });
      await expect(activity.getByTestId("bug-activity")).toHaveCount(1);

      await comments.getByLabel("Add a comment").fill("Seen again on build 12");
      await comments.getByRole("button", { name: "Add Comment" }).click();
      await expect(comments.getByTestId("bug-comment")).toHaveCount(1);
      await expect(activity.getByTestId("bug-activity").last()).toContainText(`${actorName} added a comment`);

      const persisted = await (await api.get(`/api/projects/${projectId}/bugs/${bug.id}/comments`)).json();
      expect(persisted.list.map((x: { body: string }) => x.body)).toEqual(["Seen again on build 12"]);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-81 on a narrow screen Activity stacks below Comments", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    const bug = await seedBug("Narrow");
    try {
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      const activity = detailsRegion(page).getByRole("region", { name: "Activity" });
      const comments = detailsRegion(page).getByRole("region", { name: "Comments" });
      await expect(activity.getByTestId("bug-activity")).toHaveCount(1);
      const c = (await comments.boundingBox())!;
      const a = (await activity.boundingBox())!;
      expect(a.y).toBeGreaterThanOrEqual(c.y + c.height - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll").toBe(true);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-82 the side panel shows the bug's Activity under its Comments", async ({ page }) => {
    const bug = await seedBug("Panel");
    try {
      await api.patch(`/api/bugs/${bug.id}`, { data: { status: "Closed" } });
      await page.goto(`/projects/${projectId}/bugs`);
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.locator("tbody tr").filter({ hasText: bug.title }).click();

      const activity = detailsRegion(page).getByRole("region", { name: "Activity" });
      await expect(activity.getByTestId("bug-activity")).toHaveCount(2);
      await expect(activity.getByTestId("bug-activity").last()).toContainText(`${actorName} closed the bug (was Open)`);
      const c = (await detailsRegion(page).getByRole("region", { name: "Comments" }).boundingBox())!;
      expect((await activity.boundingBox())!.y).toBeGreaterThan(c.y);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });

  test("BUG-U-83 when the activity request fails the section says so and offers Retry, and Comments is unaffected", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const bug = await seedBug("Failure");
    try {
      let fail = true;
      await page.route(`**/api/projects/${projectId}/activity?**`, (route) =>
        fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) }) : route.continue(),
      );
      await page.goto(`/projects/${projectId}/bugs/${bug.id}`);
      const activity = detailsRegion(page).getByRole("region", { name: "Activity" });
      await expect(activity.getByRole("alert")).toContainText("Couldn't load activity");
      await expect(detailsRegion(page).getByRole("region", { name: "Comments" }).getByText("No comments yet.")).toBeVisible();

      fail = false;
      await activity.getByRole("button", { name: "Retry" }).click();
      await expect(activity.getByTestId("bug-activity")).toHaveCount(1);
    } finally {
      await api.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
    }
  });
});
