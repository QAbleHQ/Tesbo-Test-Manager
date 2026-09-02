import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const STATE_PATH = path.join(__dirname, "../.auth/state.json");

function apiContext() {
  return pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
}

test.describe("project settings", () => {
  test("a user can rename a project and update its description from settings", { tag: '@tesbo.testId("TES-TC-805")' }, async ({ page }) => {
    const api = await apiContext();
    let projectId: string | undefined;

    try {
      const suffix = Date.now().toString().slice(-8);
      const name = `UI Settings Project ${suffix}`;
      // Explicit key: projectKey() truncates to 16 chars from the start, and this name is
      // long enough that an auto-derived key would drop the timestamp and collide on rerun.
      const created = await (
        await api.post("/api/projects", { data: { name, key: `E2EUISET${suffix}` } })
      ).json();
      projectId = created.id;

      // The General tab is the default — no ?tab= needed. Name/Description have no
      // id/label pairing in the markup, so scope structurally within the form.
      await page.goto(`/projects/${projectId}/settings`);
      const updatedName = `${name} (renamed via UI)`;
      await page.locator('form input[type="text"]').first().fill(updatedName);
      await page.locator("form textarea").fill("Updated via the e2e UI suite");
      await page.getByRole("button", { name: "Save", exact: true }).click();

      await expect(page.getByText("Project settings saved.")).toBeVisible();

      const fetched = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(fetched.name).toBe(updatedName);
      expect(fetched.description).toBe("Updated via the e2e UI suite");
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("a user can set a project's icon from settings, and clear it back to automatic", async ({ page }) => {
    const api = await apiContext();
    let projectId: string | undefined;

    try {
      const suffix = Date.now().toString().slice(-8);
      const name = `UI Icon Settings Project ${suffix}`;
      const created = await (
        await api.post("/api/projects", { data: { name, key: `E2EUIICON${suffix}` } })
      ).json();
      projectId = created.id;

      await page.goto(`/projects/${projectId}/settings`);
      await page.getByRole("button", { name: "Icon color #4C5FD5" }).click();
      await page.getByRole("textbox", { name: "Custom icon letter or emoji" }).fill("Q");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project settings saved.")).toBeVisible();

      const afterSet = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(afterSet.settings.icon).toEqual({ color: "#4C5FD5", glyph: "Q" });

      // Reloading re-derives the picker's state from what was actually persisted, not from
      // whatever the form happened to hold in memory.
      await page.reload();
      await expect(page.getByRole("button", { name: "Icon color #4C5FD5" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("textbox", { name: "Custom icon letter or emoji" })).toHaveValue("Q");

      await page.getByRole("button", { name: "Automatic color" }).click();
      await page.getByRole("textbox", { name: "Custom icon letter or emoji" }).fill("");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project settings saved.")).toBeVisible();

      const afterClear = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(afterClear.settings.icon).toEqual({ color: null, glyph: null });
    } finally {
      if (projectId) await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("the delete confirmation blocks a mismatched name and only deletes on an exact match", { tag: '@tesbo.testId("TES-TC-806")' }, async ({
    page,
  }) => {
    const api = await apiContext();
    const suffix = Date.now().toString().slice(-8);
    const name = `UI Delete Project ${suffix}`;
    const created = await (
      await api.post("/api/projects", { data: { name, key: `E2EUIDEL${suffix}` } })
    ).json();
    const projectId = created.id;

    try {
      await page.goto(`/projects/${projectId}/settings`);
      await page.getByRole("button", { name: "Delete project", exact: true }).click();

      // Modal.tsx has no role="dialog" and doesn't unmount the page behind it, so scope to
      // the modal's own container (the heading's parent) to avoid colliding with the General
      // tab's own text inputs still sitting in the DOM underneath.
      const modal = page.getByRole("heading", { name: "Confirm project deletion" }).locator("..");
      await expect(modal).toBeVisible();

      await modal.locator('input[type="text"]').fill("definitely not the project name");
      await modal.getByRole("button", { name: "Delete project permanently" }).click();
      await expect(
        page.getByText("Project deletion cancelled. Entered name does not match."),
      ).toBeVisible();
      expect((await api.get(`/api/projects/${projectId}`)).ok()).toBeTruthy();

      await modal.locator('input[type="text"]').fill(name);
      await modal.getByRole("button", { name: "Delete project permanently" }).click();
      await page.waitForURL(/\/projects$/);

      const getAfterDelete = await api.get(`/api/projects/${projectId}`, { failOnStatusCode: false });
      expect(getAfterDelete.status()).toBe(404);
    } finally {
      // Best-effort: only fires if an assertion above failed before the real delete happened.
      await api.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });
});
