import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

// A project-level prerequisite for creating a test run at all — not itself part of the
// scenario being exercised, so it's seeded via the API rather than through Settings UI.
const ENV_NAME = "E2E Scenario Env";

test.describe("full test-management scenario", () => {
  test("a test case moves from creation through a run to a filed bug, and the plan reflects it", { tag: '@tesbo.testId("TES-TC-669")' }, async ({
    page,
  }) => {
    test.slow(); // a long, multi-page journey — give it more room than the focused smoke tests

    const suffix = Date.now();
    const caseTitle = `E2E Scenario Case ${suffix}`;
    const planName = `E2E Scenario Plan ${suffix}`;
    const runName = `E2E Scenario Run ${suffix}`;
    const bugTitle = `Failed: ${caseTitle}`;

    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    let testcaseId: string | undefined;
    let planId: string | undefined;
    let cycleId: string | undefined;
    let bugId: string | undefined;

    try {
      // ── Prerequisite: the project needs at least one test environment configured before
      // the "Create Test Run" UI will allow submitting the form at all.
      const project = await (await api.get(`/api/projects/${ctx.projectId}`)).json();
      // settings is a jsonb column, so the driver hands it back already parsed — api/projects.spec.ts
      // asserts on it as an object. Re-parsing threw ("[object Object]" is not valid JSON) as soon as
      // the project had any settings at all, so this only bit from the second run onwards against the
      // persistent volume, once this very test had written testRunEnvironments.
      const settings =
        typeof project.settings === "string" ? JSON.parse(project.settings) : (project.settings ?? {});
      const environments: Array<{ name: string; url: string }> = settings.testRunEnvironments || [];
      if (!environments.some((e) => e.name === ENV_NAME)) {
        await api.patch(`/api/projects/${ctx.projectId}`, {
          data: {
            settings: JSON.stringify({
              ...settings,
              testRunEnvironments: [...environments, { name: ENV_NAME, url: env.webBaseUrl }],
            }),
          },
        });
      }

      // ── 1. Create a test case from the Test Case repository UI ──
      await page.goto(`/projects/${ctx.projectId}/testcases`);
      await page.getByRole("button", { name: "Add test case" }).first().click();
      const casePanel = page.locator("aside");
      await casePanel.getByPlaceholder("Describe what this test case validates").fill(caseTitle);
      await casePanel.getByRole("button", { name: "Create", exact: true }).click();
      await expect(casePanel.getByText("Test case created successfully.")).toBeVisible();
      await casePanel.getByRole("button", { name: "Close panel" }).click();
      await expect(page.getByRole("button", { name: caseTitle })).toBeVisible();

      const caseListRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: caseTitle },
      });
      const createdCase = (await caseListRes.json()).find(
        (tc: { id: string; title: string }) => tc.title === caseTitle,
      );
      expect(createdCase).toBeTruthy();
      testcaseId = createdCase.id;

      // The "Add Test Cases" run picker only allows Approved cases — approve it the way a
      // reviewer would before it's scheduled into a run. Not itself part of the UI journey
      // under test, so done directly via the API.
      await api.put(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, {
        data: { status: "Approved" },
      });

      // ── 2. Create a test plan from the Test Plans UI ──
      await page.goto(`/projects/${ctx.projectId}/plans`);
      await page.getByRole("button", { name: "New test plan" }).click();
      const planForm = page.locator("form", { has: page.getByPlaceholder("e.g. Sprint 12 Regression") });
      await planForm.getByPlaceholder("e.g. Sprint 12 Regression").fill(planName);
      await planForm.getByRole("button", { name: "Create Test Plan", exact: true }).click();
      await page.waitForURL(/\/plans\/[^/]+$/);
      planId = page.url().split("/plans/")[1];
      expect(planId).toBeTruthy();

      // ── 3. Create a test run from the Test Runs UI ──
      await page.goto(`/projects/${ctx.projectId}/cycles`);
      await page.getByRole("button", { name: "Create Test Run", exact: true }).first().click();
      const createRunModal = page.getByRole("heading", { name: "Create Test Run" }).locator("..");
      await createRunModal.getByPlaceholder("e.g. Sprint 42 Regression").fill(runName);
      await createRunModal.getByRole("combobox").selectOption(ENV_NAME);
      await createRunModal.getByRole("button", { name: "Create Test Run", exact: true }).click();
      await expect(createRunModal).toBeHidden();

      // ── 4. Open the new run and add the approved test case to it ──
      await page.getByRole("link", { name: runName }).click();
      await page.waitForURL(/\/cycles\/[^/]+$/);
      cycleId = page.url().split("/cycles/")[1];
      expect(cycleId).toBeTruthy();

      await page.getByRole("button", { name: "Add Test Cases" }).click();
      const pickerModal = page.getByRole("heading", { name: "Add Test Cases to Run" }).locator("..");
      await pickerModal.getByPlaceholder("Search by title or ID…").fill(caseTitle);
      await pickerModal.locator("tr", { hasText: caseTitle }).locator('input[type="checkbox"]').check();
      await pickerModal.getByRole("button", { name: "Add 1 Case", exact: true }).click();
      await expect(pickerModal).toBeHidden();
      await expect(page.getByRole("button", { name: caseTitle })).toBeVisible();

      // ── 5. Start the run and execute the case as Failed ──
      await page.getByRole("button", { name: "Start Execution" }).click();
      await expect(page.getByRole("button", { name: "Mark Completed" })).toBeVisible();

      await page.getByRole("combobox").first().selectOption("Failed");
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      await expect(page.getByPlaceholder("Brief summary of the bug…")).toHaveValue(bugTitle);
      await page.getByRole("button", { name: "Report Bug", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();
      await expect(page.getByRole("combobox").first()).toHaveValue("Failed");

      const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
      const filedBug = (await bugsRes.json()).find((b: { title: string }) => b.title === bugTitle);
      expect(filedBug).toBeTruthy();
      expect(
        filedBug.links.some(
          (l: { testcaseId: string; cycleId: string }) => l.testcaseId === testcaseId && l.cycleId === cycleId,
        ),
      ).toBeTruthy();
      bugId = filedBug.id;

      // ── 6. The filed bug shows up on the Bugs board ──
      await page.goto(`/projects/${ctx.projectId}/bugs`);
      await expect(page.getByText(bugTitle)).toBeVisible();

      // ── 7. Link the run to the plan, and confirm the plan's progress reflects the failure ──
      await page.goto(`/projects/${ctx.projectId}/plans/${planId}`);
      await page.getByRole("button", { name: "Link existing run" }).click();
      const linkModal = page.getByRole("heading", { name: "Link Existing Test Run" }).locator("..");
      await linkModal.locator("li", { hasText: runName }).getByRole("button", { name: "Link" }).click();
      await expect(linkModal).toBeHidden();

      await expect(page.getByRole("link", { name: runName })).toBeVisible();
      await expect(page.getByText("1 failed")).toBeVisible();

      const progressRes = await api.get(`/api/plans/${planId}/progress`);
      const progress = await progressRes.json();
      expect(progress.totalCases).toBe(1);
      expect(progress.failed).toBe(1);
      expect(progress.passed).toBe(0);
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
      if (cycleId) await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
      if (planId) await api.delete(`/api/plans/${planId}`, { failOnStatusCode: false });
      if (testcaseId) {
        await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, {
          failOnStatusCode: false,
        });
      }
      await api.dispose();
    }
  });
});
