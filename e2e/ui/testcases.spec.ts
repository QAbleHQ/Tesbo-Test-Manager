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
    // Suite/Type/Priority/Automation Type start unselected (see the dedicated test below), but
    // this happy-path test still exercises picking a value for each explicitly.
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

  // Priority is the one exception to the blank defaults below: it opens on "Not set" and saves as
  // "Not set" (a case whose priority nobody has chosen yet), not "" and not P2.
  // Suite, Type, Priority, Automation Type, Component and Severity are all optional on Create:
  // Create Test Case must open with the dropdowns on "Select"/"No suite" and Component empty,
  // and leaving every one of them untouched must both (a) succeed, and (b) persist them as blank/
  // null rather than a real value the user never chose. The form always includes these fields in
  // its payload (testcases/page.tsx), blank or not, so an untouched field reaches the API as an
  // explicit "" — insertTestCaseWithClient in legacy.service.ts now only applies its "P2"/
  // "Functional"/"Not Automated" fallbacks when the key is missing entirely (import/Zyra/MCP,
  // which never send this form's payload shape), not when it's sent blank. Status is excluded:
  // it has no "Select" placeholder and is never left blank, so it keeps defaulting to "Draft".
  test("Create Test Case opens with Suite, Type, Priority, Automation Type and Component unselected/empty, and creating without filling them saves them blank rather than defaulted", async ({ page }) => {
    const title = `UI unselected defaults test case ${Date.now()}`;

    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByRole("button", { name: "Add test case" }).first().click();

    const panel = page.locator("aside");

    await expect(fieldControl(page, "Suite").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Type").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Priority").locator("option:checked")).toHaveText("Not set");
    await expect(fieldControl(page, "Automation Type").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Component")).toHaveValue("");
    await expect(fieldControl(page, "Severity").locator("option:checked")).toHaveText("Select");
    await expect(fieldControl(page, "Status").locator("option:checked")).toHaveText("Draft");

    // Submit with all of the above left untouched — no client-side error, a real create.
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(panel.getByText("Test case created successfully.")).toBeVisible();
    await panel.getByRole("button", { name: "Close panel" }).click();

    // Persisted state, not just the toast: the API-visible row must carry blank/null values,
    // not the "No suite"/"Functional"/"P2"/"Not Automated" defaults this used to silently apply.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const listRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: title },
      });
      const list = await listRes.json();
      const match = list.find((tc: { id: string; title: string }) => tc.title === title);
      expect(match).toBeTruthy();
      expect(match.suiteId).toBeNull();
      expect(match.type).toBeNull();
      expect(match.priority).toBe("Not set");
      expect(match.automationStatus).toBeNull();
      expect(match.component).toBeFalsy();
      expect(match.severity).toBeFalsy();
      // Status is the one field NOT covered by this optional-field fix — it keeps its default.
      expect(match.status).toBe("Draft");

      if (match) await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`);
    } finally {
      await api.dispose();
    }
  });

  // Companion to the create-time test above: fillFormFromTestCase (testcases/page.tsx) used to
  // re-populate a reopened case's Type/Automation Type with "Functional"/"Not Automated" whenever
  // the stored value was blank, and Suite with whatever suite the repository view happened to be
  // filtered on — so a case saved blank by the fix above would silently gain a real value the
  // moment it was opened and saved again, undoing the fix on the very next edit. Priority is
  // excluded from that regression (an empty string isn't nullish, so it already round-tripped).
  test("Edit Test Case shows a blank Type/Priority/Automation Type/Suite/Severity as Select/No suite, and saving with no changes keeps them blank", async ({ page }) => {
    const title = `UI edit blank fields test case ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let testcaseId = "";
    try {
      const created = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title, priority: "", type: "", automationStatus: "", severity: "", component: "" },
        })
      ).json();
      testcaseId = created.id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: title }).click();

      const panel = page.locator("aside");
      await expect(fieldControl(page, "Suite").locator("option:checked")).toHaveText("No suite");
      await expect(fieldControl(page, "Type").locator("option:checked")).toHaveText("Select");
      await expect(fieldControl(page, "Priority").locator("option:checked")).toHaveText("Select");
      await expect(fieldControl(page, "Automation Type").locator("option:checked")).toHaveText("Select");
      await expect(fieldControl(page, "Severity").locator("option:checked")).toHaveText("Select");

      // Save without touching anything.
      await panel.getByRole("button", { name: "Save changes" }).click();
      await expect(panel.getByText("Test case updated successfully.")).toBeVisible();

      const after = await (
        await api.get(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`)
      ).json();
      expect(after.suiteId).toBeNull();
      expect(after.type).toBeFalsy();
      expect(after.priority).toBe("");
      expect(after.automationStatus).toBeFalsy();
      expect(after.severity).toBeFalsy();
    } finally {
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("repository row shows an em dash in Type and Automation Type when a case has none", async ({ page }) => {
    const title = `UI blank type row ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let testcaseId = "";
    try {
      testcaseId = (
        await (
          await api.post(`/api/projects/${ctx.projectId}/testcases`, {
            data: { title, priority: "", type: "", automationStatus: "" },
          })
        ).json()
      ).id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByPlaceholder(/Search by ID/).fill(title);
      const row = page.getByRole("row").filter({ hasText: title });
      await expect(row).toBeVisible();
      // Type and Automation Type columns are in the default set; with no values both must read "—".
      const headers = await page.getByRole("columnheader").allInnerTexts();
      for (const name of ["TYPE", "AUTOMATION"]) {
        const idx = headers.findIndex((h) => h.toUpperCase().includes(name));
        expect(idx, `${name} column present`).toBeGreaterThanOrEqual(0);
        await expect(row.getByRole("cell").nth(idx)).toHaveText("—");
      }
    } finally {
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("repository Updated column shows the full date including the year, not truncated", async ({ page }) => {
    const title = `UI updated col width ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let testcaseId = "";
    try {
      testcaseId = (await (await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title } })).json()).id;
      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByPlaceholder(/Search by ID/).fill(title);
      const row = page.getByRole("row").filter({ hasText: title });
      await expect(row).toBeVisible();
      const headers = await page.getByRole("columnheader").allInnerTexts();
      const idx = headers.findIndex((h) => h.toUpperCase().includes("UPDATED"));
      expect(idx).toBeGreaterThanOrEqual(0);
      const span = row.getByRole("cell").nth(idx).locator("span").first();
      await expect(span).toHaveText(/\d{2} \w{3} \d{4}/);
      // truncate renders an ellipsis when scrollWidth exceeds clientWidth.
      const clipped = await span.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(clipped).toBe(false);
    } finally {
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  // A case that already has real values must not be disturbed by the fix above — reopening and
  // saving it unchanged has to round-trip the exact values it already had.
  test("Edit Test Case preserves existing Type/Priority/Automation Type/Suite values when saved with no changes", async ({ page }) => {
    const title = `UI edit populated fields test case ${Date.now()}`;
    const suiteName = `E2E Edit Preserve Suite ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let testcaseId = "";
    let suiteId = "";
    try {
      const suite = await (
        await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })
      ).json();
      suiteId = suite.id;
      const created = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title, priority: "P1", type: "Regression", automationStatus: "Automated", suiteId },
        })
      ).json();
      testcaseId = created.id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: title }).click();

      const panel = page.locator("aside");
      await expect(fieldControl(page, "Suite").locator("option:checked")).toHaveText(suiteName);
      await expect(fieldControl(page, "Type").locator("option:checked")).toHaveText("Regression");
      await expect(fieldControl(page, "Priority").locator("option:checked")).toHaveText("P1");
      await expect(fieldControl(page, "Automation Type").locator("option:checked")).toHaveText("Automated");

      await panel.getByRole("button", { name: "Save changes" }).click();
      await expect(panel.getByText("Test case updated successfully.")).toBeVisible();

      const after = await (
        await api.get(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`)
      ).json();
      expect(after.suiteId).toBe(suiteId);
      expect(after.type).toBe("Regression");
      expect(after.priority).toBe("P1");
      expect(after.automationStatus).toBe("Automated");
    } finally {
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  // "[MCP] Test case created by MCP is not adding Severity" — the MCP create_testcase tool stored
  // whatever severity string it was sent ("Major"), which this dropdown can't select, so the detail
  // panel showed "Select". See the matching api/mcp.spec.ts block for the refusal side.
  test("a test case created through MCP with a severity shows that severity in Test Case Detail", async ({ page }) => {
    const title = `UI MCP severity test case ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    // Cookie-free: AuthMiddleware prefers a session cookie over the bearer token, and a real MCP
    // client never sends one (same reasoning as callMcpTool in api/mcp.spec.ts).
    const mcpApi = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    let tokenId = "";
    let testcaseId = "";
    try {
      const tokenBody = await (
        await api.post(`/api/projects/${ctx.projectId}/apikeys`, { data: { name: `E2E UI MCP severity ${Date.now()}`, scopes: ["write"] } })
      ).json();
      tokenId = tokenBody.id;
      const rpc = await mcpApi.post(`/api/projects/${ctx.projectId}/mcp`, {
        headers: { Authorization: `Bearer ${tokenBody.token}` },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_testcase", arguments: { title, severity: "high", priority: "P1", component: "Buzz" } },
        },
      });
      const body = await rpc.json();
      expect(body.error).toBeUndefined();
      const created = JSON.parse(body.result.content[0].text);
      testcaseId = created.id;
      expect(created.severity).toBe("High");

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: title }).click();
      await expect(fieldControl(page, "Severity")).toHaveValue("High");
      await expect(fieldControl(page, "Severity").locator("option:checked")).toHaveText("High");
      // Neighbouring fields from the same MCP call still land.
      await expect(fieldControl(page, "Priority")).toHaveValue("P1");
      await expect(fieldControl(page, "Component")).toHaveValue("Buzz");
    } finally {
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      if (tokenId) await api.delete(`/api/projects/${ctx.projectId}/apikeys/${tokenId}`, { failOnStatusCode: false });
      await mcpApi.dispose();
      await api.dispose();
    }
  });

  // Regression coverage for: the Bulk actions modal let you update Status, Priority and Automation
  // Type across many test cases at once, but had no Severity field at all — so clearing a wave of
  // false-positive "Critical" severities, for example, required opening each case individually.
  test("Bulk actions updates Severity (alongside Priority) across every selected test case", async ({ page }) => {
    const titleA = `UI bulk severity A ${Date.now()}`;
    const titleB = `UI bulk severity B ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let idA = "";
    let idB = "";
    try {
      idA = (await (await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: titleA, severity: "Low", priority: "P3" } })).json()).id;
      idB = (await (await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: titleB, severity: "Low", priority: "P3" } })).json()).id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("row", { name: titleA }).getByLabel(`Select ${titleA}`).check();
      await page.getByRole("row", { name: titleB }).getByLabel(`Select ${titleB}`).check();

      // Modal (components/ui/Modal.tsx) renders its title as a plain <h2>, with no role="dialog" —
      // so this is identified by its heading, not a dialog role, matching the rest of this file's
      // modal-locator pattern (see the "Rename suite" modal tests below).
      await page.getByRole("button", { name: "Bulk actions" }).click();
      await expect(page.getByRole("heading", { name: "Bulk actions" })).toBeVisible();
      await fieldControl(page, "Action").selectOption({ label: "Update status / priority / severity / automation type" });
      await fieldControl(page, "Severity").selectOption("Critical");
      await fieldControl(page, "Priority").selectOption("P0");
      await page.getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByRole("heading", { name: "Bulk actions" })).toBeHidden();

      for (const id of [idA, idB]) {
        const after = await (await api.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json();
        expect(after.severity).toBe("Critical");
        expect(after.priority).toBe("P0");
      }
    } finally {
      if (idA) await api.delete(`/api/projects/${ctx.projectId}/testcases/${idA}`, { failOnStatusCode: false });
      if (idB) await api.delete(`/api/projects/${ctx.projectId}/testcases/${idB}`, { failOnStatusCode: false });
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

// The repository's ID/Test case title/Priority column sort (testcases/page.tsx toggleSuiteCasesSort).
// Paging and sorting are server-side (limit/offset/sortBy on the list endpoint, see
// api/testcases.spec.ts's "sort" and "repository paging" describes), so a header click is a request
// for the first page in that order. It briefly used to sort a 500-row batch in the browser; that
// capped the table at 500 rows, which is why it moved back. These UI tests cover what the API tests
// can't: that a click reorders what's on screen, asks the server for the sort, and that the
// refetch doesn't blank the table while in flight.
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

      // The server does the sorting, so each click must reach the list endpoint with that sort.
      const sortRequests: string[] = [];
      page.on("request", (req) => {
        const url = new URL(req.url());
        if (req.method() === "GET" && url.pathname === `/api/projects/${ctx.projectId}/testcases` && url.searchParams.has("sortBy")) {
          sortRequests.push(`${url.searchParams.get("sortBy")}:${url.searchParams.get("sortDir")}`);
        }
      });

      const sortByTitle = page.getByRole("button", { name: "Sort by Test case title" });
      await expect(sortByTitle).toBeVisible();
      await sortByTitle.click();

      await expect(page.getByRole("button", { name: "Sort by Test case title, currently ascending" })).toBeVisible();
      // Polled: the new order lands when the sorted page's response does.
      await expect.poll(() => titleButtons().allTextContents()).toEqual([`${marker} Alpha`, `${marker} Mango`, `${marker} Zeta`]);

      await sortByTitle.click();
      await expect(page.getByRole("button", { name: "Sort by Test case title, currently descending" })).toBeVisible();
      await expect.poll(() => titleButtons().allTextContents()).toEqual([`${marker} Zeta`, `${marker} Mango`, `${marker} Alpha`]);

      expect(sortRequests, "each click asks the server for that sort").toEqual(expect.arrayContaining(["title:asc", "title:desc"]));
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

    // A filter change refetches (as do sort and paging); this exercises that refetch path.
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

// Regression coverage for: Severity and Component are real testcases columns, already wired
// through create/edit and export (see "Postconditions, Component and Severity can be set..."
// above), but the repository list endpoint itself omitted both, so the column selector had
// nothing to show even once a column existed for them.
test.describe("test case repository table — Severity and Component columns", () => {
  test("Severity and Component can be shown via the column selector, display the right value, survive a reload, and hide again", async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const marker = `UI Severity Component ${Date.now()}`;
    const created: string[] = [];
    try {
      const withValues = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `${marker} with values`, severity: "Critical", component: "Checkout" },
      });
      created.push((await withValues.json()).id);
      // No severity/component set — the column must render an em dash, not a blank cell.
      const withoutValues = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `${marker} without values` },
      });
      created.push((await withoutValues.json()).id);

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByPlaceholder("Search by ID, title, or type").fill(marker);
      const rows = () => page.locator("table.tc-repo-table tbody tr");
      await expect(rows()).toHaveCount(2);

      const headerCells = page.locator("table.tc-repo-table thead tr th");
      // Hidden by default, same as Suite and Jira.
      const defaultHeaderText = (await headerCells.allTextContents()).join(" | ");
      expect(defaultHeaderText).not.toContain("Severity");
      expect(defaultHeaderText).not.toContain("Component");
      const defaultCount = await headerCells.count();

      const columnsButton = page.getByRole("button", { name: "Columns" });
      await columnsButton.click();
      await page.locator("label", { hasText: "Severity" }).locator('input[type="checkbox"]').click();
      await page.locator("label", { hasText: "Component" }).locator('input[type="checkbox"]').click();
      await columnsButton.click(); // toggles the menu closed again

      await expect(headerCells).toHaveCount(defaultCount + 2);
      const headerTexts = await headerCells.allTextContents();
      const severityIdx = headerTexts.findIndex((t) => t.includes("Severity"));
      const componentIdx = headerTexts.findIndex((t) => t.includes("Component"));
      expect(severityIdx, "Severity header should be present once enabled").toBeGreaterThan(-1);
      expect(componentIdx, "Component header should be present once enabled").toBeGreaterThan(-1);

      const rowWithValues = rows().filter({ hasText: `${marker} with values` });
      const rowWithoutValues = rows().filter({ hasText: `${marker} without values` });
      await expect(rowWithValues.locator("td").nth(severityIdx)).toHaveText("Critical");
      await expect(rowWithValues.locator("td").nth(componentIdx)).toHaveText("Checkout");
      await expect(rowWithoutValues.locator("td").nth(severityIdx)).toHaveText("—");
      await expect(rowWithoutValues.locator("td").nth(componentIdx)).toHaveText("—");

      // Persistence: a reload must keep both columns visible, same as any other column toggle.
      await page.reload();
      await page.getByPlaceholder("Search by ID, title, or type").fill(marker);
      await expect(rows()).toHaveCount(2);
      await expect(headerCells).toHaveCount(defaultCount + 2);

      // Hiding them again removes the columns and that choice persists too.
      await columnsButton.click();
      await page.locator("label", { hasText: "Severity" }).locator('input[type="checkbox"]').click();
      await page.locator("label", { hasText: "Component" }).locator('input[type="checkbox"]').click();
      await columnsButton.click();
      await expect(headerCells).toHaveCount(defaultCount);

      await page.reload();
      await page.getByPlaceholder("Search by ID, title, or type").fill(marker);
      await expect(rows()).toHaveCount(2);
      const headerTextAfterHide = (await headerCells.allTextContents()).join(" | ");
      expect(headerTextAfterHide).not.toContain("Severity");
      expect(headerTextAfterHide).not.toContain("Component");
    } finally {
      for (const id of created) await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});

// Regression coverage for: testcases.source_refs (added in V101_testcase_citations.sql, and always
// written by Zyra) was never rendered anywhere after a case was saved — it only ever flashed in the
// transient pre-acceptance review screen. Same "column selector had nothing to show" shape as
// Severity/Component above, plus the detail panel's Overview tab, which reads the same data from the
// single-testcase GET rather than from the repository list endpoint.
test.describe("test case repository table and detail panel — Context column", () => {
  test("Context can be shown via the column selector, shows the placeholder or a citation count, and survives a reload", async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const marker = `UI Context ${Date.now()}`;
    const created: string[] = [];
    try {
      const withCitationRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: {
          title: `${marker} with citation`,
          sourceRefs: [{ type: "bug", id: "E2E-NONEXISTENT-BUG", title: "A past citation" }],
        },
      });
      created.push((await withCitationRes.json()).id);
      // No citations — the column must render the same placeholder Zyra's own review screen
      // (ZyraCitationsList) shows for an uncited draft, not a blank cell.
      const withoutCitationRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `${marker} without citation` },
      });
      created.push((await withoutCitationRes.json()).id);

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByPlaceholder("Search by ID, title, or type").fill(marker);
      const rows = () => page.locator("table.tc-repo-table tbody tr");
      await expect(rows()).toHaveCount(2);

      const headerCells = page.locator("table.tc-repo-table thead tr th");
      // Hidden by default, same as Suite/Jira/Severity/Component.
      const defaultHeaderText = (await headerCells.allTextContents()).join(" | ");
      expect(defaultHeaderText).not.toContain("Context");
      const defaultCount = await headerCells.count();

      const columnsButton = page.getByRole("button", { name: "Columns" });
      await columnsButton.click();
      await page.locator("label", { hasText: "Context" }).locator('input[type="checkbox"]').click();
      await columnsButton.click();

      await expect(headerCells).toHaveCount(defaultCount + 1);
      const headerTexts = await headerCells.allTextContents();
      const contextIdx = headerTexts.findIndex((t) => t.includes("Context"));
      expect(contextIdx, "Context header should be present once enabled").toBeGreaterThan(-1);

      const rowWithCitation = rows().filter({ hasText: `${marker} with citation` });
      const rowWithoutCitation = rows().filter({ hasText: `${marker} without citation` });
      await expect(rowWithCitation.locator("td").nth(contextIdx)).toContainText("Context used (1)");
      await expect(rowWithoutCitation.locator("td").nth(contextIdx)).toContainText("No specific source cited");

      // Persistence: a reload must keep the column visible, same as any other column toggle.
      await page.reload();
      await page.getByPlaceholder("Search by ID, title, or type").fill(marker);
      await expect(rows()).toHaveCount(2);
      await expect(headerCells).toHaveCount(defaultCount + 1);

      await columnsButton.click();
      await page.locator("label", { hasText: "Context" }).locator('input[type="checkbox"]').click();
      await columnsButton.click();
      await expect(headerCells).toHaveCount(defaultCount);
    } finally {
      for (const id of created) await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("clicking a citation in the Context column opens a menu, and clicking the cited item opens its live content in a drawer", async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const marker = `UI Context Drawer ${Date.now()}`;
    const created: string[] = [];
    try {
      // The cited item is a real, resolvable test case in this project, so the drawer opened from
      // the citation loads that case's actual live content rather than a stale-source message.
      const citedRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `${marker} cited case` },
      });
      const cited = await citedRes.json();
      created.push(cited.id);

      const withCitationRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: {
          title: `${marker} with citation`,
          sourceRefs: [{ type: "testcase", id: cited.id, title: cited.title }],
        },
      });
      created.push((await withCitationRes.json()).id);

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByPlaceholder("Search by ID, title, or type").fill(`${marker} with citation`);
      const columnsButton = page.getByRole("button", { name: "Columns" });
      await columnsButton.click();
      await page.locator("label", { hasText: "Context" }).locator('input[type="checkbox"]').click();
      await columnsButton.click();

      await page.getByRole("button", { name: "Context used (1)" }).click();
      await page.getByRole("button", { name: cited.title, exact: false }).click();

      const drawer = page.locator('div[role="presentation"]').last();
      await expect(drawer.getByText("Test case", { exact: true })).toBeVisible();
      await expect(drawer.getByText(cited.title)).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      for (const id of created) await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("the detail panel has a dedicated Context tab showing the same citations as the repository table", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const marker = `UI Context Panel ${Date.now()}`;
    const created: string[] = [];
    try {
      const citedRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `${marker} cited case` },
      });
      const cited = await citedRes.json();
      created.push(cited.id);

      const withCitationRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: {
          title: `${marker} with citation`,
          sourceRefs: [{ type: "testcase", id: cited.id, title: cited.title }],
        },
      });
      created.push((await withCitationRes.json()).id);
      const withoutCitationRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `${marker} without citation` },
      });
      created.push((await withoutCitationRes.json()).id);

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      const panel = page.locator("aside");

      await page.getByPlaceholder("Search by ID, title, or type").fill(`${marker} with citation`);
      await page.getByRole("button", { name: `${marker} with citation` }).click();
      await panel.getByRole("button", { name: "Context (1)" }).click();
      const citationCard = panel.getByRole("button", { name: cited.title, exact: false });
      await expect(citationCard).toBeVisible();
      await expect(citationCard).toContainText("Test case");

      // Clicking the cited item opens its live content in a drawer.
      await citationCard.click();
      const drawer = page.locator('div[role="presentation"]').last();
      await expect(drawer.getByText(cited.title)).toBeVisible();
      await page.keyboard.press("Escape");
      await panel.getByRole("button", { name: "Close panel" }).click();

      await page.getByPlaceholder("Search by ID, title, or type").fill(`${marker} without citation`);
      await page.getByRole("button", { name: `${marker} without citation` }).click();
      // No count suffix when there's nothing to cite.
      await expect(panel.getByRole("button", { name: "Context", exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "Context", exact: true }).click();
      await expect(panel.getByText("No specific source cited")).toBeVisible();
    } finally {
      for (const id of created) await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});

// The Create/Edit panel's Priority, Type and Automation Type dropdowns are fixed lists. A case whose
// stored value is not in the list shows "Select" and can never be saved back as that value, so the
// values a migrated case can carry have to be offered.
test.describe("Not set priority and the added Type / Automation Type values", () => {
  test("Create Test Case offers Not set, the added Types and To Be Automated, and saves the chosen values", async ({ page }) => {
    const title = `UI new values test case ${Date.now()}`;
    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByRole("button", { name: "Add test case" }).first().click();
    const panel = page.locator("aside");
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);

    const options = async (label: string) => fieldControl(page, label).locator("option").allTextContents();
    expect(await options("Priority")).toEqual(["Select", "P0", "P1", "P2", "P3", "Not set"]);
    const types = await options("Type");
    for (const t of ["Other", "Acceptance", "Usability", "Compatibility", "Exploratory"]) expect(types).toContain(t);
    expect(await options("Automation Type")).toContain("To Be Automated");

    await fieldControl(page, "Suite").selectOption({ label: "No suite" });
    await fieldControl(page, "Type").selectOption("Other");
    await fieldControl(page, "Priority").selectOption("Not set");
    await fieldControl(page, "Automation Type").selectOption("To Be Automated");
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(panel.getByText("Test case created successfully.")).toBeVisible();

    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const list = await (await api.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: title } })).json();
      const match = list.find((tc: { title: string }) => tc.title === title);
      expect(match, "the created case is listed").toBeTruthy();
      expect(match.priority).toBe("Not set");
      expect(match.type).toBe("Other");
      expect(match.automationStatus).toBe("To Be Automated");
      await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`, { failOnStatusCode: false });
    } finally {
      await api.dispose();
    }
  });

  test("Edit Test Case shows a case stored as Not set / Exploratory / To Be Automated as exactly those values, and saving with no changes keeps them", async ({ page }) => {
    const title = `UI edit new values test case ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let testcaseId = "";
    try {
      const created = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title, priority: "Not set", type: "Exploratory", automationStatus: "To Be Automated" },
        })
      ).json();
      testcaseId = created.id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: title }).click();
      const panel = page.locator("aside");
      await expect(fieldControl(page, "Priority").locator("option:checked")).toHaveText("Not set");
      await expect(fieldControl(page, "Type").locator("option:checked")).toHaveText("Exploratory");
      await expect(fieldControl(page, "Automation Type").locator("option:checked")).toHaveText("To Be Automated");

      await panel.getByRole("button", { name: "Save changes" }).click();
      await expect(panel.getByText("Test case updated successfully.")).toBeVisible();
      const after = await (await api.get(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`)).json();
      expect(after.priority).toBe("Not set");
      expect(after.type).toBe("Exploratory");
      expect(after.automationStatus).toBe("To Be Automated");
    } finally {
      if (testcaseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("the Add Test Cases picker's Priority and Type filters offer Not set and the added Types, and filtering by Not set keeps only those cases", async ({ page }) => {
    const stamp = Date.now();
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const caseIds: string[] = [];
    let cycleId = "";
    try {
      const notSet = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `UI picker NotSet ${stamp}`, priority: "Not set", type: "Exploratory" } })
      ).json();
      const p1 = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: `UI picker P1 ${stamp}`, priority: "P1" } })
      ).json();
      caseIds.push(notSet.id, p1.id);
      const cycle = await (
        await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI picker filters ${stamp}` } })
      ).json();
      cycleId = cycle.id;

      await page.goto(`/projects/${ctx.projectId}/cycles/${cycleId}`);
      await page.getByRole("button", { name: "Add Test Cases" }).click();
      await expect(page.getByText("Add Test Cases to Run")).toBeVisible();
      // The picker's selects are the last ones on the page (the run table's own filters sit behind a popover).
      const priority = page.locator("select").filter({ hasText: "All Priorities" }).last();
      const type = page.locator("select").filter({ hasText: "All Types" }).last();
      expect(await priority.locator("option").allTextContents()).toContain("Not set");
      const typeOptions = await type.locator("option").allTextContents();
      for (const t of ["Sanity", "API", "UI", "Acceptance", "Usability", "Compatibility", "Exploratory", "Other"]) expect(typeOptions).toContain(t);

      await page.getByPlaceholder("Search by title or ID…").fill(`UI picker ${stamp}`);
      await priority.selectOption("Not set");
      await expect(page.getByText(`UI picker NotSet ${stamp}`)).toBeVisible();
      await expect(page.getByText(`UI picker P1 ${stamp}`)).toHaveCount(0);
    } finally {
      if (cycleId) await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
      for (const id of caseIds) await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});

test.describe("suite description and preconditions in the repository", () => {
  test("Add suite saves a description and preconditions, and the suite header shows them", async ({ page }) => {
    const stamp = Date.now();
    const suiteName = `UI Suite Text ${stamp}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let suiteId = "";
    try {
      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByTitle("Add suite").click();
      await page.getByPlaceholder("Enter suite name").fill(suiteName);
      await page.getByPlaceholder("What does this suite cover?").fill("Login and session flows\nSecond line");
      await page.getByPlaceholder("What must be true before running these test cases?").fill("An agency account exists");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      const row = (await (await api.get(`/api/projects/${ctx.projectId}/suites`)).json()).find((s: { name: string }) => s.name === suiteName);
      suiteId = row.id;
      expect(row.description).toBe("Login and session flows\nSecond line");
      expect(row.preconditions).toBe("An agency account exists");

      await page.getByRole("button", { name: suiteName, exact: true }).click();
      const details = page.getByTestId("suite-details");
      await expect(details).toContainText("Login and session flows");
      await expect(details).toContainText("Second line");
      await expect(details).toContainText("An agency account exists");
    } finally {
      if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("a suite with no text shows no details block", async ({ page }) => {
    const suiteName = `UI Suite No Text ${Date.now()}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let suiteId = "";
    try {
      suiteId = (await (await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })).json()).id;
      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: suiteName, exact: true }).click();
      await expect(page.getByText(suiteName, { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("suite-details")).toHaveCount(0);
    } finally {
      if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("Rename suite opens with the saved text, saves edits, clears them, and a child suite stays under its parent", async ({ page }) => {
    const stamp = Date.now();
    const parentName = `UI Suite Parent ${stamp}`;
    const childName = `UI Suite Child ${stamp}`;
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let parentId = "";
    let childId = "";
    try {
      parentId = (await (await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: parentName } })).json()).id;
      childId = (
        await (
          await api.post(`/api/projects/${ctx.projectId}/suites`, {
            data: { name: childName, parentId, description: "Saved description", preconditions: "Saved preconditions" },
          })
        ).json()
      ).id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByTestId(`suite-expand-${parentId}`).click();
      const childRow = page.getByRole("button", { name: new RegExp(childName) }).first();
      await childRow.hover();
      await page.getByTitle("Rename suite").click();

      const description = page.getByPlaceholder("What does this suite cover?");
      const preconditions = page.getByPlaceholder("What must be true before running these test cases?");
      await expect(description).toHaveValue("Saved description");
      await expect(preconditions).toHaveValue("Saved preconditions");

      await description.fill("Edited description");
      await preconditions.fill("");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      const after = (await (await api.get(`/api/projects/${ctx.projectId}/suites`)).json()).find((s: { id: string }) => s.id === childId);
      expect(after.description).toBe("Edited description");
      expect(after.preconditions).toBe("");
      expect(after.parentId, "editing the text must not move the suite to the root").toBe(parentId);

      await page.getByRole("button", { name: new RegExp(childName) }).first().click();
      const details = page.getByTestId("suite-details");
      await expect(details).toContainText("Edited description");
      await expect(details).not.toContainText("Preconditions");
    } finally {
      if (parentId) await api.delete(`/api/suites/${parentId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("the suite text fields cap at 20000 characters instead of overflowing", async ({ page }) => {
    await page.goto(`/projects/${ctx.projectId}/testcases`);
    await page.getByTitle("Add suite").click();
    const description = page.getByPlaceholder("What does this suite cover?");
    await description.fill("y".repeat(20500));
    await expect(description).toHaveValue("y".repeat(20000));
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);
  });
});

/*
 * Add suite opens the suite it just created.
 *
 * Before this: a successful create only appended the suite to the tree and closed the modal, leaving
 * the view on whatever suite was selected before — the user had to find and click the new suite by
 * hand. The selection is the ?suiteId= URL param (the same one a tree click sets), so every
 * assertion here pins the URL to the id the API actually stored, never to a name.
 */
test.describe("Add suite opens the newly created suite", () => {
  const suitesUrl = `/api/projects/${ctx.projectId}/suites`;
  // Neither select is tied to a label (the modal's Select may also sit in a wrapper), so each is
  // found by the placeholder option only it carries.
  const statusFilter = (page: Page) => page.locator("select", { has: page.locator("option", { hasText: "All statuses" }) });
  const parentSelect = (page: Page) => page.locator("select", { has: page.locator("option", { hasText: "No parent (top-level suite)" }) });

  async function createFromModal(page: Page, name: string, parentName?: string) {
    await page.getByTitle("Add suite").click();
    await page.getByPlaceholder("Enter suite name").fill(name);
    if (parentName) await parentSelect(page).selectOption({ label: parentName });
    await page.getByRole("button", { name: "Create", exact: true }).click();
  }

  async function liveSuites(api: Awaited<ReturnType<typeof pwRequest.newContext>>) {
    return (await (await api.get(suitesUrl)).json()) as Array<{ id: string; name: string; parentId: string | null }>;
  }

  const suiteInUrl = (id: string) => new RegExp(`[?&]suiteId=${id}(&|$)`);

  test("selects the new suite, shows its empty case list, and Back returns to the previous suite", async ({ page }) => {
    const stamp = Date.now();
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const priorName = `E2E Open New Suite Prior ${stamp}`;
    const newName = `E2E Open New Suite ${stamp}`;
    const caseTitle = `E2E Open New Suite case ${stamp}`;
    const suiteIds: string[] = [];
    let caseId = "";
    try {
      const priorId = (await (await api.post(suitesUrl, { data: { name: priorName } })).json()).id;
      suiteIds.push(priorId);
      caseId = (await (await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: caseTitle, suiteId: priorId } })).json()).id;

      await page.goto(`/projects/${ctx.projectId}/testcases?suiteId=${priorId}`);
      await expect(page.getByRole("button", { name: caseTitle })).toBeVisible();

      await createFromModal(page, newName);
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      const created = (await liveSuites(api)).find((s) => s.name === newName);
      expect(created, "the suite was persisted").toBeTruthy();
      suiteIds.push(created!.id);
      expect(created!.parentId).toBeNull();

      await expect(page).toHaveURL(suiteInUrl(created!.id));
      await expect(page.getByText(newName, { exact: true }).first()).toBeVisible();
      // The previous suite's case is gone: the list really reloaded for the new (empty) suite.
      await expect(page.getByText("This suite has no test cases yet.")).toBeVisible();
      await expect(page.getByRole("button", { name: caseTitle })).toHaveCount(0);

      // A push, not a replace — the previous suite is one Back away, exactly as after a tree click.
      await page.goBack();
      await expect(page).toHaveURL(suiteInUrl(priorId));
      await expect(page.getByRole("button", { name: caseTitle })).toBeVisible();
    } finally {
      if (caseId) await api.delete(`/api/projects/${ctx.projectId}/testcases/${caseId}`, { failOnStatusCode: false });
      for (const id of suiteIds) await api.delete(`/api/suites/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("selects the new suite by id when an existing suite already has the same name", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const name = `E2E Open New Suite Twin ${Date.now()}`;
    const suiteIds: string[] = [];
    try {
      const existingId = (await (await api.post(suitesUrl, { data: { name } })).json()).id;
      suiteIds.push(existingId);

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await createFromModal(page, name);
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      const twins = (await liveSuites(api)).filter((s) => s.name === name);
      expect(twins).toHaveLength(2);
      const newId = twins.find((s) => s.id !== existingId)!.id;
      suiteIds.push(newId);
      await expect(page).toHaveURL(suiteInUrl(newId));
    } finally {
      for (const id of suiteIds) await api.delete(`/api/suites/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("selects a new child suite and shows it under its expanded parent", async ({ page }) => {
    const stamp = Date.now();
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const parentName = `E2E Open New Suite Parent ${stamp}`;
    const childName = `E2E Open New Suite Child ${stamp}`;
    let parentId = "";
    try {
      parentId = (await (await api.post(suitesUrl, { data: { name: parentName } })).json()).id;

      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await createFromModal(page, childName, parentName);
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      const child = (await liveSuites(api)).find((s) => s.name === childName);
      expect(child?.parentId).toBe(parentId);
      await expect(page).toHaveURL(suiteInUrl(child!.id));
      await expect(page.getByRole("button", { name: childName, exact: true })).toBeVisible();
      await expect(page.getByText("This suite has no test cases yet.")).toBeVisible();
    } finally {
      // Deleting the parent takes the child with it.
      if (parentId) await api.delete(`/api/suites/${parentId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("keeps the active list filters when switching to the new suite", async ({ page }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const name = `E2E Open New Suite Filtered ${Date.now()}`;
    let suiteId = "";
    try {
      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await statusFilter(page).selectOption("Draft");

      await createFromModal(page, name);
      await expect(page.getByPlaceholder("Enter suite name")).toHaveCount(0);

      suiteId = (await liveSuites(api)).find((s) => s.name === name)!.id;
      await expect(page).toHaveURL(suiteInUrl(suiteId));
      await expect(statusFilter(page)).toHaveValue("Draft");
      await expect(page.getByText("No test cases match your current filters.")).toBeVisible();
    } finally {
      if (suiteId) await api.delete(`/api/suites/${suiteId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("a failed create keeps the modal open with the error and does not change the selected suite", async ({ page }) => {
    const stamp = Date.now();
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const priorName = `E2E Open New Suite Fail Prior ${stamp}`;
    const failedName = `E2E Open New Suite Fail ${stamp}`;
    const createRoute = `**/api/projects/${ctx.projectId}/suites`;
    let priorId = "";
    try {
      priorId = (await (await api.post(suitesUrl, { data: { name: priorName } })).json()).id;
      await page.goto(`/projects/${ctx.projectId}/testcases?suiteId=${priorId}`);

      await page.route(createRoute, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 500, json: { error: "Simulated suite create failure" } })
          : route.continue(),
      );
      await createFromModal(page, failedName);

      await expect(page.getByText("Simulated suite create failure")).toBeVisible();
      await expect(page.getByPlaceholder("Enter suite name")).toHaveValue(failedName);
      await expect(page).toHaveURL(suiteInUrl(priorId));
      expect((await liveSuites(api)).some((s) => s.name === failedName)).toBe(false);
    } finally {
      await page.unroute(createRoute);
      if (priorId) await api.delete(`/api/suites/${priorId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});
