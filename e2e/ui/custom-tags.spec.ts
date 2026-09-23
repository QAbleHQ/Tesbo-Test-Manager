import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { env } from "../utils/env";
import { exec, literal } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The custom tags screens: the per-project settings editor (its own Project Settings sidebar tab,
 * positioned right after Integrations — see settings/page.tsx's visibleTabs), the test case panel's
 * multi-select, and the Execution Report's Group by Tags filter.
 *
 * What makes these worth a browser rather than more API tests: api/custom-tags.spec.ts proves the
 * backend enforces Owner/Manager, but only the screen proves the "Custom Tags" sidebar entry is
 * absent for a QA Engineer rather than present-but-403ing, and that the Execution Report's tag
 * filter actually empties out when the project's catalog is empty instead of falling back to a
 * free-text box.
 *
 * Runs against its own disposable workspace ("custom-tags-ui"), same reasoning as custom-fields-ui.
 */

test.describe("custom tags (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  const states = new Map<string, string>();
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("custom-tags-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    states.set("owner", await writeStorageState(tenant.owner, "custom-tags-ui-owner"));
    states.set("qa", await writeStorageState(tenant.qa, "custom-tags-ui-qa"));
    purgeFixtures(tenant);
  });

  test.afterAll(async () => {
    if (tenant) purgeFixtures(tenant);
    if (api) await api.dispose();
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purgeFixtures(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function purgeFixtures(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM testcases WHERE project_id IN (${projects});`);
    exec(`DELETE FROM custom_tags WHERE project_id IN (${projects});`);
  }

  async function pageAs(browser: import("@playwright/test").Browser, label: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: env.webBaseUrl, storageState: states.get(label)! });
    contexts.push(context);
    return context.newPage();
  }

  function settingsUrl(): string {
    return `/projects/${tenant!.mainProjectId}/settings`;
  }

  function customTagsTabUrl(): string {
    return `/projects/${tenant!.mainProjectId}/settings?tab=customTags`;
  }

  function customTagsUrl(): string {
    return `/projects/${tenant!.mainProjectId}/settings/custom-tags`;
  }

  function testcasesUrl(): string {
    return `/projects/${tenant!.mainProjectId}/testcases`;
  }

  function reportsUrl(): string {
    return `/projects/${tenant!.mainProjectId}/reports`;
  }

  function tagsApiUrl(): string {
    return `/api/projects/${tenant!.mainProjectId}/custom-tags`;
  }

  function tagName(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function defineTag(name: string): Promise<any> {
    const res = await api.post(tagsApiUrl(), { data: { name }, failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  function tagCheckbox(scope: import("@playwright/test").Locator, label: string) {
    return scope.locator("label").filter({ hasText: label }).locator("input[type='checkbox']");
  }

  // ─── The Project Settings sidebar ───────────────────────────────────────────

  test("the Custom Tags settings tab sits under Integrations in the sidebar and is hidden entirely from a QA Engineer", async ({ browser }) => {
    const ownerPage = await pageAs(browser, "owner");
    await ownerPage.goto(settingsUrl());
    const sidebar = ownerPage.locator("nav").filter({ has: ownerPage.getByRole("button", { name: "Integrations" }) });
    await expect(sidebar.getByRole("button", { name: "Custom Tags" })).toBeVisible();
    // Sits directly after Integrations, not nested inside its tab content.
    const labels = await sidebar.getByRole("button").allTextContents();
    const integrationsIndex = labels.indexOf("Integrations");
    expect(labels[integrationsIndex + 1]).toBe("Custom Tags");

    await sidebar.getByRole("button", { name: "Custom Tags" }).click();
    await expect(ownerPage.getByRole("heading", { name: "Custom Tags", exact: true })).toBeVisible();
    await expect(ownerPage.getByRole("link", { name: "Manage custom tags" })).toBeVisible();

    const qaPage = await pageAs(browser, "qa");
    await qaPage.goto(settingsUrl());
    await expect(qaPage.getByRole("button", { name: "Custom Tags" })).toHaveCount(0);
    // Navigating straight to the tab query param doesn't work around the hidden tab either.
    await qaPage.goto(customTagsTabUrl());
    await expect(qaPage.getByRole("heading", { name: "Custom Tags", exact: true })).toHaveCount(0);
  });

  test("a QA Engineer who navigates to the page directly is told it isn't theirs to use", async ({ browser }) => {
    const page = await pageAs(browser, "qa");
    await page.goto(customTagsUrl());
    await expect(page.getByText("Only project owners and managers can manage custom tags.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add tag" })).toHaveCount(0);
  });

  // ─── The settings screen ───────────────────────────────────────────────────

  test("an owner can add a tag and see it listed, then delete it", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(customTagsUrl());

    const name = tagName("Regression");
    await page.getByPlaceholder("e.g. Regression, Smoke, Flaky").fill(name);
    await page.getByRole("button", { name: "Add tag" }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    const listed = await api.get(tagsApiUrl()).then((r) => r.json());
    expect(listed.map((t: any) => t.name)).toContain(name);

    await page.getByRole("button", { name: `Delete tag ${name}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    expect((await api.get(tagsApiUrl()).then((r) => r.json())).map((t: any) => t.name)).not.toContain(name);
  });

  // ─── On the test case panel ─────────────────────────────────────────────────

  test("tags selected on create are saved and remain selected when reopened for edit", async ({ browser }) => {
    const [alpha, beta] = await Promise.all([defineTag(tagName("Alpha")), defineTag(tagName("Beta"))]);

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: "Add test case" }).first().click();

    const panel = page.locator("aside");
    const title = `E2E Custom Tags UI Case ${Date.now()}`;
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    await expect(panel.getByText("Custom Tags", { exact: true })).toBeVisible();
    await tagCheckbox(panel, alpha.name).check();

    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(panel.getByText("Test case created successfully.")).toBeVisible();

    const [created] = await api
      .get(`/api/projects/${tenant!.mainProjectId}/testcases`, { params: { search: title } })
      .then((r) => r.json());
    const assignedAfterCreate = await api.get(`/api/projects/${tenant!.mainProjectId}/testcases/${created.id}/tags`).then((r) => r.json());
    expect(assignedAfterCreate.map((t: any) => t.id)).toEqual([alpha.id]);

    // Reopen for edit: the checkbox reflects what was actually persisted, not just local state.
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: title }).click();
    await expect(tagCheckbox(panel, alpha.name)).toBeChecked();
    await expect(tagCheckbox(panel, beta.name)).not.toBeChecked();

    // Changing the selection and saving replaces the assignment.
    await tagCheckbox(panel, beta.name).check();
    await tagCheckbox(panel, alpha.name).uncheck();
    await panel.getByRole("button", { name: "Save changes" }).click();
    await expect(panel.getByText("Test case updated successfully.")).toBeVisible();

    await expect
      .poll(() => api.get(`/api/projects/${tenant!.mainProjectId}/testcases/${created.id}/tags`).then((r) => r.json()).then((t: any[]) => t.map((x) => x.id)))
      .toEqual([beta.id]);
  });

  test("with no tags in the catalog, the Custom Tags field does not appear on the panel", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: "Add test case" }).first().click();
    const panel = page.locator("aside");
    await expect(panel.getByPlaceholder("Describe what this test case validates")).toBeVisible();
    await expect(panel.getByText("Custom Tags", { exact: true })).toHaveCount(0);
  });

  // ─── Insights -> Execution Report ───────────────────────────────────────────

  test("Group by Tags offers no values for an empty catalog, and the real catalog once tags exist", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(reportsUrl());
    await expect(page.getByRole("heading", { name: "Reports & Insights" })).toBeVisible();
    await page.getByRole("button", { name: /Execution Report/i }).first().click();

    const groupBy = page.locator("select").first();
    await groupBy.selectOption("tags");
    const tagSelect = page.locator("select").nth(1);
    await expect(tagSelect).toBeVisible();
    await expect(tagSelect).toBeDisabled();
    await expect(tagSelect.locator("option")).toHaveCount(1);
    await expect(tagSelect.locator("option").first()).toHaveText("No tags available");

    const tag = await defineTag(tagName("Smoke"));
    await page.reload();
    await page.getByRole("button", { name: /Execution Report/i }).first().click();
    await groupBy.selectOption("tags");
    await expect(tagSelect).toBeEnabled();
    await expect(tagSelect.locator(`option[value="${tag.id}"]`)).toHaveText(tag.name);
  });
});
