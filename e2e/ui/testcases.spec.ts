import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test, type Locator, type Page } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

/** The label isn't tied to its control via for/id, so this walks the DOM structure instead. */
function fieldControl(page: Page, label: string): Locator {
  return page.locator(
    `xpath=//label[normalize-space(text())="${label}"]/following-sibling::*[self::input or self::select or self::textarea]`,
  );
}

test.describe("test case creation", () => {
  test("a user can create a test case from the UI and see it in the list", { tag: '@tesbo.testId("TES-TC-836")' }, async ({ page }) => {
    const title = `UI smoke test case ${Date.now()}`;

    await page.goto(`/projects/${ctx.projectId}/testcases`);
    // Both the toolbar and the empty-state block render an "Add test case" button (an IconPlus
    // glyph, not a literal "+" in the accessible name) when the project has no test cases yet;
    // either one opens the same create panel.
    await page.getByRole("button", { name: "Add test case" }).first().click();

    const panel = page.locator("aside");
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    // Suite/Type/Priority/Automation Type start unselected (see the dedicated test below) and
    // block creation until chosen — pick a value for each so this happy-path test still reaches
    // the create call itself.
    await fieldControl(page, "Suite").selectOption({ label: "No suite" });
    await fieldControl(page, "Type").selectOption("Functional");
    await fieldControl(page, "Priority").selectOption("P2");
    await fieldControl(page, "Automation Type").selectOption("Not Automated");
    await panel.getByRole("button", { name: "Create", exact: true }).click();

    await expect(panel.getByText("Test case created successfully.")).toBeVisible();
    // A separate full-screen backdrop button shares the same "Close panel" aria-label —
    // scope to the panel itself to hit its dedicated close button.
    await panel.getByRole("button", { name: "Close panel" }).click();
    await expect(page.getByRole("button", { name: title })).toBeVisible();

    // Clean up via the API so repeat runs don't accumulate test cases in the smoke project.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const listRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: title },
      });
      const list = await listRes.json();
      const match = list.find((tc: { id: string; title: string }) => tc.title === title);
      if (match) await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`);
    } finally {
      await api.dispose();
    }
  });

  // Regression coverage for: Postconditions, Component and Severity had real DB columns and were
  // already wired through the single create/update routes and the import mapping, but the Create
  // Test Case form itself never exposed inputs for them — so a user could only ever set them via
  // the import wizard, never by hand. "View/Edit" is the same panel as Create here (openViewPanel
  // sets panelMode to "edit" — see testcases/page.tsx), so re-opening the created case IS the
  // View/Edit half of this flow.
  test("Postconditions, Component and Severity can be set on create and are shown when the case is reopened", async ({ page }) => {
    const title = `UI new fields test case ${Date.now()}`;
    const postconditions = "User is redirected to the dashboard.";
    const component = "Login";

    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByRole("button", { name: "Add test case" }).first().click();

    const panel = page.locator("aside");
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    await fieldControl(page, "Postconditions").fill(postconditions);
    await fieldControl(page, "Component").fill(component);
    await fieldControl(page, "Severity").selectOption("Medium");
    await fieldControl(page, "Suite").selectOption({ label: "No suite" });
    await fieldControl(page, "Type").selectOption("Functional");
    await fieldControl(page, "Priority").selectOption("P2");
    await fieldControl(page, "Automation Type").selectOption("Not Automated");
    await panel.getByRole("button", { name: "Create", exact: true }).click();

    await expect(panel.getByText("Test case created successfully.")).toBeVisible();
    await panel.getByRole("button", { name: "Close panel" }).click();

    // Reopening the row loads the edit panel (View/Edit) — the three new fields must come back
    // exactly as saved, proving the round trip through the API rather than just the form state.
    await page.getByRole("button", { name: title }).click();
    await expect(fieldControl(page, "Postconditions")).toHaveValue(postconditions);
    await expect(fieldControl(page, "Component")).toHaveValue(component);
    await expect(fieldControl(page, "Severity")).toHaveValue("Medium");

    // Clean up via the API so repeat runs don't accumulate test cases in the smoke project.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const listRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: title },
      });
      const list = await listRes.json();
      const match = list.find((tc: { id: string; title: string }) => tc.title === title);
      if (match) await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`);
    } finally {
      await api.dispose();
    }
  });

  // Regression coverage for: Create Test Case opened with Suite/Type/Priority/Automation Type
  // pre-set to "No suite"/"Functional"/"P2"/"Not Automated" — real values the user never chose,
  // silently submitted on Create. Status is unaffected by this bug and must keep defaulting to
  // "Draft".
  test("Create Test Case opens with Suite, Type, Priority and Automation Type unselected, and blocks creation until they're chosen", async ({ page }) => {
    const title = `UI unselected defaults test case ${Date.now()}`;

    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByRole("button", { name: "Add test case" }).first().click();

    const panel = page.locator("aside");

    await expect(fieldControl(page, "Suite").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Type").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Priority").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Automation Type").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Status").locator("option:checked")).toHaveText("Draft");

    // Submitting before picking them is blocked with an explicit error, not a silent create.
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      panel.getByText("Select a value for Suite, Type, Priority, Automation Type before creating the test case."),
    ).toBeVisible();
    await expect(panel.getByText("Test case created successfully.")).not.toBeVisible();

    // Selecting all four — including explicitly picking "No suite" — lets the same create through.
    await fieldControl(page, "Suite").selectOption({ label: "No suite" });
    await fieldControl(page, "Type").selectOption("Functional");
    await fieldControl(page, "Priority").selectOption("P2");
    await fieldControl(page, "Automation Type").selectOption("Not Automated");
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(panel.getByText("Test case created successfully.")).toBeVisible();
    await panel.getByRole("button", { name: "Close panel" }).click();

    // Clean up via the API so repeat runs don't accumulate test cases in the smoke project.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const listRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: title },
      });
      const list = await listRes.json();
      const match = list.find((tc: { id: string; title: string }) => tc.title === title);
      if (match) await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`);
    } finally {
      await api.dispose();
    }
  });
});

/*
 * Add suite / Rename suite modals — inline validation and error display.
 *
 * Before this: neither modal caught a failed create/update. An over-length name (the
 * suites.name VARCHAR(255) column, enforced server-side by SUITE_NAME_MAX_LENGTH in
 * legacy.service.ts) rejected with a 400 that nobody caught, becoming an unhandled promise
 * rejection instead of a message in the popup — surfacing as a dev-overlay/console crash
 * rather than feedback where the user was looking. There was also no client-side length cap,
 * so the input itself could grow arbitrarily long before Save was ever pressed (the reported
 * screenshot: a "Rename suite" field overflowing with 900+ characters).
 */
test.describe("suite name validation and error display (UI)", () => {
  test("Add suite modal blocks a blank name inline and caps the name length instead of overflowing", async ({ page }) => {
    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByTitle("Add suite").click();

    const nameInput = page.getByPlaceholder("Enter suite name");
    await expect(nameInput).toBeVisible();

    // Edge case: whitespace-only input. Create stays disabled (mouse path), and pressing Enter
    // — which bypasses the disabled button — now surfaces a message instead of a silent no-op.
    await nameInput.fill("   ");
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    await nameInput.press("Enter");
    await expect(page.getByText("Suite name is required")).toBeVisible();

    // Edge case: a name far past the 255-character column limit is capped by the input itself,
    // and says so — the cap is otherwise invisible (nothing else on screen names the number).
    await nameInput.fill("y".repeat(400));
    await expect(nameInput).toHaveValue("y".repeat(255));
    await expect(page.getByText("Suite name can’t exceed 255 characters.")).toBeVisible();
    // The earlier "required" message clears as soon as the field is valid again.
    await expect(page.getByText("Suite name is required")).toHaveCount(0);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);
  });

  test("Rename suite modal blocks a blank name inline and caps the name length instead of overflowing", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const suiteName = `E2E Rename Validation Suite ${Date.now()}`;
    let suiteId = "";
    try {
      const created = await (
        await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })
      ).json();
      suiteId = created.id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: suiteName, exact: true }).hover();
      await page.getByTitle("Rename suite").click();

      const nameInput = page.getByPlaceholder("Enter suite name");
      await expect(nameInput).toHaveValue(suiteName);

      // Edge case: clearing the name to blank. Save stays disabled, and Enter (which bypasses
      // the disabled button) surfaces the same inline message rather than doing nothing.
      await nameInput.fill("");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await nameInput.press("Enter");
      await expect(page.getByText("Suite name is required")).toBeVisible();

      // Edge case: an over-length paste is capped at the input level, and says so.
      await nameInput.fill("z".repeat(400));
      await expect(nameInput).toHaveValue("z".repeat(255));
      await expect(page.getByText("Suite name can’t exceed 255 characters.")).toBeVisible();

      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      // The suite itself is untouched by any of the above — every rejected attempt stayed
      // client-side.
      const listRes = await api.get(`/api/projects/${ctx.projectId}/suites`);
      const unchanged = (await listRes.json()).find((s: { id: string }) => s.id === suiteId);
      expect(unchanged.name).toBe(suiteName);
    } finally {
      if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("a suite rename that fails on the server surfaces the error inside the modal instead of crashing the page", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const suiteName = `E2E Rename Server Error Suite ${Date.now()}`;
    let suiteId = "";
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));
    try {
      const created = await (
        await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })
      ).json();
      suiteId = created.id;

      // A valid-looking rename that the server rejects anyway (e.g. the suite was deleted from
      // another tab, or any other 400 the client can't predict). Mocked rather than relying on
      // a specific backend rule, so this pins the frontend's error handling in isolation.
      await page.route(`**/api/suites/${suiteId}`, async (route) => {
        if (route.request().method() === "PATCH") {
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: "Suite not found" }),
          });
        } else {
          await route.continue();
        }
      });

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: suiteName, exact: true }).hover();
      await page.getByTitle("Rename suite").click();

      const nameInput = page.getByPlaceholder("Enter suite name");
      await nameInput.fill(`${suiteName} (renamed)`);
      await page.getByRole("button", { name: "Save", exact: true }).click();

      // The error lands inside the still-open modal...
      await expect(page.getByRole("heading", { name: "Rename suite" })).toBeVisible();
      await expect(page.getByText("Suite not found")).toBeVisible();
      // ...the Save button recovers instead of staying stuck on "Saving...",
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
      // ...and nothing escaped as an unhandled exception (the pre-fix failure mode).
      expect(pageErrors, `unexpected page error(s): ${pageErrors.map((e) => e.message).join(", ")}`).toHaveLength(0);
    } finally {
      await page.unroute(`**/api/suites/${suiteId}`);
      if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  /*
   * A response body with neither `error` nor `errors` (a rate limiter, a proxy's bare 502/504,
   * an unhandled 500 from the global exception filter) used to fall back to `String(status)` in
   * lib/api.ts's formatApiError — handing the modal a literal "500" or "429" as the entire
   * message. Covers both a server error and a rate-limit response with the shape those actually
   * have on the wire (no `error` field), asserting the friendly generic sentence appears and the
   * bare code never does.
   */
  for (const { status, label } of [
    { status: 500, label: "an unhandled server error" },
    { status: 429, label: "a rate limit response" },
  ]) {
    test(`a suite rename that fails with ${label} shows a generic message instead of the bare status code`, async ({ page }) => {
      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      const suiteName = `E2E Rename ${status} Suite ${Date.now()}`;
      let suiteId = "";
      try {
        const created = await (
          await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })
        ).json();
        suiteId = created.id;

        await page.route(`**/api/suites/${suiteId}`, async (route) => {
          if (route.request().method() === "PATCH") {
            // Deliberately no `error`/`errors` field — matches what a rate limiter or an
            // upstream proxy actually sends, not a hand-written backend response.
            await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ statusCode: status }) });
          } else {
            await route.continue();
          }
        });

        await page.goto(`/projects/${ctx.projectId}/testcases`);
        await page.getByRole("button", { name: suiteName, exact: true }).hover();
        await page.getByTitle("Rename suite").click();

        const nameInput = page.getByPlaceholder("Enter suite name");
        await nameInput.fill(`${suiteName} (renamed)`);
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect(page.getByRole("heading", { name: "Rename suite" })).toBeVisible();
        await expect(page.getByText(String(status), { exact: true })).toHaveCount(0);
        const expected =
          status === 429
            ? "Too many requests. Please wait a moment and try again."
            : "Something went wrong on our end. Please try again.";
        await expect(page.getByText(expected)).toBeVisible();
      } finally {
        await page.unroute(`**/api/suites/${suiteId}`);
        if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
        await api.dispose();
      }
    });
  }
});

/*
 * Test Case Detail — bugs filed against this case.
 *
 * Before this: the panel had no bugs section at all, so there was no way to see a bug's key/URL
 * from the test case side — only the Test Run flow's unrelated "Defect Key"/"Defect URL" free-text
 * fields existed anywhere near this screen. This asserts the real fix: the panel's own "Bugs" tab
 * shows the actual bug data (integrationIssueKey/externalUrl) under "Bug Key"/"Bug URL", and never
 * borrows the Test Run flow's "Defect" wording.
 */
test.describe("test case detail — linked bugs", () => {
  test("the Bugs tab shows the linked bug's real Bug Key and Bug URL, never Defect terminology", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const title = `E2E TC Detail Bugs ${Date.now()}`;
    let testcaseId = "";
    let bugId = "";
    try {
      const tc = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title } })
      ).json();
      testcaseId = tc.id;
      const bug = await (
        await api.post(`/api/projects/${ctx.projectId}/bugs`, {
          data: {
            title: `E2E Linked Bug ${Date.now()}`,
            integrationProvider: "JIRA",
            integrationIssueKey: "PROJ-9911",
            externalUrl: "https://example.atlassian.net/browse/PROJ-9911",
            links: [{ testcaseId }],
          },
        })
      ).json();
      bugId = bug.id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: title }).click();

      const panel = page.locator("aside");
      await panel.getByRole("button", { name: /^Bugs/ }).click();

      // exact: true — "PROJ-9911" is otherwise a substring match of the Bug URL link's own text
      // (".../browse/PROJ-9911"), so a fuzzy match resolves to both links at once.
      const bugKeyLink = panel.getByRole("link", { name: "PROJ-9911", exact: true });
      await expect(bugKeyLink).toBeVisible();
      await expect(bugKeyLink).toHaveAttribute("href", "https://example.atlassian.net/browse/PROJ-9911");
      await expect(panel.getByRole("link", { name: "https://example.atlassian.net/browse/PROJ-9911" })).toBeVisible();

      await expect(panel.getByText("Bug Key", { exact: true })).toBeVisible();
      await expect(panel.getByText("Bug URL", { exact: true })).toBeVisible();
      await expect(panel.getByText("Defect Key")).toHaveCount(0);
      await expect(panel.getByText("Defect URL")).toHaveCount(0);
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});

// Regression coverage for: the repository table's column headers used to be draggable (a grip
// icon plus HTML5 drag-and-drop) so a user could reorder data columns. That reordering was
// removed; only the per-column resize handle should remain.
test.describe("test case repository table — column drag-and-drop removed", () => {
  test("column headers are no longer draggable, and dragging one does not reorder columns", async ({ page }) => {
    await page.goto(`/projects/${ctx.projectId}/testcases`);

    const headerCells = page.locator("table.tc-repo-table thead tr th");
    // select, ID, Test case title, Priority, Type, Automation Type, Status, Updated (default visible set).
    await expect(headerCells).toHaveCount(8);
    const idHeader = headerCells.nth(1);
    const titleHeader = headerCells.nth(2);
    await expect(idHeader).toContainText("ID");
    await expect(titleHeader).toContainText("Test case title");

    // No draggable attribute left behind on any data column header.
    for (let i = 1; i < 8; i++) {
      expect(await headerCells.nth(i).getAttribute("draggable")).toBeNull();
    }
    // The ID header does carry an icon again now — a sort-toggle icon (ID/Test case title/Priority
    // are sortable columns), added after this test last ran green. That's a different icon for a
    // different, intentional feature, not a regression of the removed drag grip: this asserts it's
    // specifically the sort control (no IconGripVertical import exists anywhere in the component
    // any more) rather than re-asserting "no icon of any kind" in that header.
    await expect(idHeader.getByRole("button", { name: "Sort by ID" })).toBeVisible();

    // A drag attempt from the title header onto the ID header must be inert now — no dataTransfer
    // handlers remain, so this is at most a plain mouse drag, and column order stays put.
    await titleHeader.dragTo(idHeader);

    await expect(headerCells.nth(1)).toContainText("ID");
    await expect(headerCells.nth(2)).toContainText("Test case title");
  });

  test("column resize still works after removing drag-and-drop reordering", async ({ page }) => {
    await page.goto(`/projects/${ctx.projectId}/testcases`);

    const idHeader = page.locator("table.tc-repo-table thead tr th").nth(1);
    const before = await idHeader.evaluate((el) => el.getBoundingClientRect().width);

    const handle = page.getByRole("separator", { name: "Resize ID column" });
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle for the ID column was not found");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    const after = await idHeader.evaluate((el) => el.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before + 30);
  });
});

// The repository's ID/Test case title/Priority column sort, added to match the Test Runs table's
// own column sort (testcases/page.tsx toggleSuiteCasesSort). listTestCases's sortBy/sortDir
// (legacy.service.ts, see api/testcases.spec.ts's "sort" describe) is a real, tested server
// capability, but the screen no longer calls it for this: an initial report that sorting "took too
// long" traced back to every click being its own full refetch, so the page now loads the whole
// filtered batch once (up to MAX_PAGE_SIZE) and sorts/paginates it entirely client-side afterward —
// same architecture the Test Runs table already used. These UI tests cover what the API tests
// can't: that a click actually reorders what's on screen with no fetch at all, and that the one
// thing that still does refetch (an actual filter change) doesn't blank the table while in flight.
test.describe("test case repository table — column sort", () => {
  test("the Test case title header sorts the visible rows ascending, then descending on a second click", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const marker = `UI Sort Title ${Date.now()}`;
    const created: string[] = [];
    try {
      for (const suffix of ["Zeta", "Alpha", "Mango"]) {
        const res = await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `${marker} ${suffix}` } });
        created.push((await res.json()).id);
      }

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByPlaceholder("Search by ID, title, or type").fill(marker);
      // Title cells render as a <button> whose text is the title; the ID column's own button holds
      // only the external id (e.g. "PRO-TC-42"), which never contains this marker, so filtering on
      // marker text is unambiguous regardless of which column position title happens to be in.
      const titleButtons = () => page.locator("table.tc-repo-table tbody tr td button", { hasText: marker });
      await expect(titleButtons()).toHaveCount(3);

      // Once the filtered batch has landed, sorting must not issue any further request to the
      // testcases list endpoint at all — this is the whole point of the fix (a sort click used to be
      // its own full refetch, which is what made it feel slow).
      let listRequestsAfterInitialLoad = 0;
      page.on("request", (req) => {
        if (req.method() === "GET" && new URL(req.url()).pathname === `/api/projects/${ctx.projectId}/testcases`) {
          listRequestsAfterInitialLoad += 1;
        }
      });

      const sortByTitle = page.getByRole("button", { name: "Sort by Test case title" });
      await expect(sortByTitle).toBeVisible();
      await sortByTitle.click();

      await expect(page.getByRole("button", { name: "Sort by Test case title, currently ascending" })).toBeVisible();
      // Polled rather than a one-shot read: the row order updates the instant the click is handled
      // (a client-side derive, not awaiting any response), and while that's effectively synchronous
      // with the click, polling avoids any flakiness in exactly when Playwright observes it.
      await expect.poll(() => titleButtons().allTextContents()).toEqual([`${marker} Alpha`, `${marker} Mango`, `${marker} Zeta`]);

      await sortByTitle.click();
      await expect(page.getByRole("button", { name: "Sort by Test case title, currently descending" })).toBeVisible();
      await expect.poll(() => titleButtons().allTextContents()).toEqual([`${marker} Zeta`, `${marker} Mango`, `${marker} Alpha`]);

      expect(listRequestsAfterInitialLoad, "sorting should not refetch the list from the server").toBe(0);
    } finally {
      for (const id of created) await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("changing a filter keeps the existing rows on screen during the refetch, instead of replacing the table with a loading message", async ({
    page,
  }) => {
    await page.goto(`/projects/${ctx.projectId}/testcases`);
    const firstRow = page.locator("table.tc-repo-table tbody tr").first();
    await expect(firstRow).toBeVisible();

    // Slows down just the repository list's own GET (not the same path's POST, which creates a
    // test case) so the in-flight state can be observed deterministically instead of racing a
    // normally-fast local response.
    await page.route(
      (url) => url.pathname === `/api/projects/${ctx.projectId}/testcases`,
      async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.continue();
      }
    );

    // Sort and pagination no longer touch the network at all (see the test above), so a filter
    // change is the one thing left that still refetches — this is what exercises that refetch path.
    await page.getByPlaceholder("Search by ID, title, or type").fill("zzz-unlikely-to-match-anything-at-all");

    // While that delayed request is in flight: the table's own rows are still there — not torn down
    // and replaced by the full-page "Loading test cases..." message, which only ever applies to the
    // very first load — and a small, non-blocking indicator says a refresh is under way.
    await expect(page.getByText("Loading test cases...")).toHaveCount(0);
    await expect(firstRow).toBeVisible();
    await expect(page.getByText("Updating…")).toBeVisible();

    // And once the delayed response lands, the indicator clears again.
    await expect(page.getByText("Updating…")).toHaveCount(0, { timeout: 5000 });
  });
});
