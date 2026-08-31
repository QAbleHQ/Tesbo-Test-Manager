import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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

  test("BUG-U-12 the report form offers priority, defaulting to not set", { tag: '@tesbo.testId("TES-TC-1322")' }, async ({ page }) => {
    await page.getByRole("button", { name: /report a bug/i }).first().click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();

    const priority = page.getByLabel("Bug priority");
    await expect(priority).toBeVisible();
    // Optional by design: "not triaged yet" has to be expressible on the form itself.
    await expect(priority).toHaveValue("");
    await expect(priority.locator("option")).toHaveCount(5);
    for (const value of ["P0", "P1", "P2", "P3"]) {
      await expect(priority.locator(`option[value="${value}"]`)).toHaveCount(1);
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
