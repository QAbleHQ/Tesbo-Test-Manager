import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

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
