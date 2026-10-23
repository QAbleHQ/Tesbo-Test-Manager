import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { dbControlAvailable, exec, literal } from "../utils/psql";

/*
 * Settings > API tokens (/projects/:id/settings/api-tokens).
 *
 * API tokens expire (90 days by default), so the screen has to say when, and has to say it before
 * the token stops working rather than after. A token that quietly lapses with nothing on the page to
 * hint at it turns into a broken CI pipeline and a support ticket instead of a rotation.
 *
 * Table columns: Name, Token, Scopes, Status, Last used, Created, Expires, Action. The cell indexes
 * below follow that order.
 *
 * Runs as account A, the owner of the smoke project, who is allowed to manage tokens. Every test
 * creates its own token and removes it in `finally`.
 */

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const PAGE_URL = `/projects/${ctx.projectId}/settings/api-tokens`;

const COL = { name: 0, token: 1, scopes: 2, status: 3, lastUsed: 4, created: 5, expires: 6, action: 7 } as const;

async function issue(request: APIRequestContext, label: string, data: Record<string, unknown> = {}) {
  const name = `E2E UI Token ${label} ${Date.now()}`;
  const res = await request.post(`/api/projects/${ctx.projectId}/apikeys`, { data: { name, scopes: ["read"], ...data } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { name, ...(await res.json()) } as { name: string; id: string; expiresAt: string; token: string };
}

async function remove(request: APIRequestContext, id: string | undefined) {
  if (id) await request.delete(`/api/projects/${ctx.projectId}/apikeys/${id}`, { failOnStatusCode: false });
}

function rowFor(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

test.describe("API tokens screen: expiry", () => {
  test("every token carries a Status and an Expires column, and the page explains expiry", async ({ page, request }) => {
    const token = await issue(request, "Columns", { expiresInDays: 7 });
    try {
      await page.goto(PAGE_URL);
      for (const heading of ["Status", "Expires"]) {
        await expect(page.getByRole("columnheader", { name: heading })).toBeVisible();
      }
      // Said once, above the table, for everyone who can see the page (including those who cannot manage tokens).
      await expect(page.getByTestId("token-expiry-help")).toContainText("Tokens expire automatically");
      await expect(page.getByTestId("token-expiry-help")).toContainText("cannot be renewed");

      const row = rowFor(page, token.name);
      await expect(row).toHaveCount(1);
      const cells = row.getByRole("cell");
      await expect(cells.nth(COL.status)).toHaveText("Active");
      await expect(cells.nth(COL.lastUsed)).toHaveText("Never");
      // The date is the stored instant, formatted in the user's locale; the relative line is the part that
      // tells them how long they have.
      const expires = cells.nth(COL.expires);
      await expect(expires).toContainText(String(new Date(token.expiresAt).getFullYear()));
      await expect(expires).toContainText("Expires in 7 days");
      await expect(row).toHaveAttribute("data-token-status", "active");
      await expect(cells.nth(COL.action)).toContainText("Revoke");
    } finally {
      await remove(request, token.id);
    }
  });

  test("a token 14 days or less from expiry is flagged as expiring soon; a later one is not", async ({ page, request }) => {
    const soon = await issue(request, "Soon", { expiresInDays: 5 });
    const later = await issue(request, "Later", { expiresInDays: 90 });
    try {
      await page.goto(PAGE_URL);
      const soonLine = rowFor(page, soon.name).getByText("Expires in 5 days");
      const laterLine = rowFor(page, later.name).getByText(/^Expires in (89|90) days$/);
      await expect(soonLine).toBeVisible();
      await expect(laterLine).toBeVisible();
      // Amber for the warning, the quiet muted tone otherwise. Both are still Active: nothing has lapsed yet.
      await expect(soonLine).toHaveClass(/warning-foreground/);
      await expect(laterLine).not.toHaveClass(/warning-foreground/);
      for (const name of [soon.name, later.name]) {
        await expect(rowFor(page, name).getByRole("cell").nth(COL.status)).toHaveText("Active");
      }
    } finally {
      await remove(request, soon.id);
      await remove(request, later.id);
    }
  });

  test("an expired token is marked Expired, says how long ago, and offers Remove rather than Revoke", async ({ page, request }) => {
    test.skip(!dbControlAvailable(), "needs `docker compose exec postgres psql` to age a token past its expiry");
    const live = await issue(request, "Live");
    const dead = await issue(request, "Dead");
    try {
      exec(`UPDATE api_tokens SET expires_at = now() - interval '3 days' WHERE id = ${literal(dead.id)};`);
      await page.goto(PAGE_URL);

      const deadRow = rowFor(page, dead.name);
      await expect(deadRow).toHaveAttribute("data-token-status", "expired");
      await expect(deadRow.getByRole("cell").nth(COL.status)).toHaveText("Expired");
      const deadExpires = deadRow.getByRole("cell").nth(COL.expires);
      await expect(deadExpires).toContainText("Expired 3 days ago");
      await expect(deadExpires.getByText("Expired 3 days ago")).toHaveClass(/error-foreground/);
      await expect(deadRow.getByRole("button", { name: "Remove" })).toBeVisible();
      await expect(deadRow.getByRole("button", { name: "Revoke" })).toHaveCount(0);

      // Beside a live token, which is not dragged into the same state.
      const liveRow = rowFor(page, live.name);
      await expect(liveRow).toHaveAttribute("data-token-status", "active");
      await expect(liveRow.getByRole("cell").nth(COL.status)).toHaveText("Active");

      // Still listed, so a user chasing a 401 can see which token died. Removing it deletes the row for good.
      await deadRow.getByRole("button", { name: "Remove" }).click();
      await expect(rowFor(page, dead.name)).toHaveCount(0);
      const listed = (await (await request.get(`/api/projects/${ctx.projectId}/apikeys`)).json()) as Array<{ id: string }>;
      expect(listed.some((t) => t.id === dead.id), "Remove did not delete the token").toBe(false);
      expect(listed.some((t) => t.id === live.id), "Remove deleted the wrong token").toBe(true);
    } finally {
      await remove(request, dead.id);
      await remove(request, live.id);
    }
  });

  test("a token that just lapsed today reads 'Expired today', and one expiring within a day reads 'in 1 day'", async ({ page, request }) => {
    test.skip(!dbControlAvailable(), "needs `docker compose exec postgres psql` to set exact expiry times");
    const lapsed = await issue(request, "Today");
    const tomorrow = await issue(request, "Tomorrow");
    try {
      exec(`UPDATE api_tokens SET expires_at = now() - interval '2 hours' WHERE id = ${literal(lapsed.id)};`);
      exec(`UPDATE api_tokens SET expires_at = now() + interval '3 hours' WHERE id = ${literal(tomorrow.id)};`);
      await page.goto(PAGE_URL);
      await expect(rowFor(page, lapsed.name).getByRole("cell").nth(COL.status)).toHaveText("Expired");
      await expect(rowFor(page, lapsed.name)).toContainText("Expired today");
      await expect(rowFor(page, tomorrow.name).getByRole("cell").nth(COL.status)).toHaveText("Active");
      await expect(rowFor(page, tomorrow.name)).toContainText("Expires in 1 day");
    } finally {
      await remove(request, lapsed.id);
      await remove(request, tomorrow.id);
    }
  });

  test("a token with no expiry (one that predates expiry) shows Active and 'Never', not an invalid date", async ({ page, request }) => {
    // Tokens issued before expiry existed are migrated to 90 days, so the product no longer issues
    // this state. The column must still render it rather than "Invalid Date" if a row ever has none.
    // Forced through the API response, since no endpoint can create one.
    const token = await issue(request, "Legacy");
    try {
      await page.route(`**/api/projects/${ctx.projectId}/apikeys`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        const rows = (await response.json()) as Array<Record<string, unknown>>;
        await route.fulfill({ response, json: rows.map((r) => (r.id === token.id ? { ...r, expiresAt: null } : r)) });
      });
      await page.goto(PAGE_URL);
      const row = rowFor(page, token.name);
      await expect(row.getByRole("cell").nth(COL.status)).toHaveText("Active");
      await expect(row.getByRole("cell").nth(COL.expires)).toHaveText("Never");
      await expect(row).not.toContainText("Invalid");
      await expect(row).not.toContainText("Expires in");
    } finally {
      await remove(request, token.id);
    }
  });
});

test.describe("API tokens screen: creating a token", () => {
  test("the create form offers expiry choices, defaulting to 90 days", async ({ page }) => {
    await page.goto(PAGE_URL);
    await page.getByRole("button", { name: "Create token" }).first().click();

    const select = page.locator("#token-expiry");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("90");
    await expect(select.locator("option")).toHaveText(["30 days", "90 days (recommended)", "180 days", "1 year"]);
    await expect(page.getByText("After this date, requests using the token are rejected")).toBeVisible();
  });

  test("the chosen lifetime is what the token gets, and the copy-your-token step says when it expires", async ({ page, request }) => {
    const name = `E2E UI Token Create ${Date.now()}`;
    let tokenId: string | undefined;
    try {
      await page.goto(PAGE_URL);
      await page.getByRole("button", { name: "Create token" }).first().click();
      await page.getByPlaceholder(/Claude Code/).fill(name);
      await page.locator("#token-expiry").selectOption("30");
      await page.locator("form").getByRole("button", { name: "Create token" }).click();

      // The one moment the user is looking at the secret is the moment to say it will stop working.
      const reveal = page.getByTestId("token-reveal-expiry");
      await expect(reveal).toBeVisible();
      await expect(reveal).toContainText("This token expires on");
      await expect(reveal).toContainText("return 401");

      const listed = (await (await request.get(`/api/projects/${ctx.projectId}/apikeys`)).json()) as Array<{
        id: string;
        name: string;
        expiresAt: string;
      }>;
      const created = listed.find((t) => t.name === name);
      tokenId = created?.id;
      expect(created, "the token was not created").toBeTruthy();
      const days = (Date.parse(created!.expiresAt) - Date.now()) / 86_400_000;
      expect(days, "the 30-day choice was not applied").toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
      // The date on screen is that same instant.
      await expect(reveal).toContainText(String(new Date(created!.expiresAt).getFullYear()));

      await page.getByRole("button", { name: "Done" }).click();
      await expect(rowFor(page, name).getByRole("cell").nth(COL.status)).toHaveText("Active");
      await expect(rowFor(page, name)).toContainText("Expires in 30 days");
    } finally {
      await remove(request, tokenId);
    }
  });

  test("leaving the lifetime alone creates a 90-day token", async ({ page, request }) => {
    const name = `E2E UI Token Default ${Date.now()}`;
    let tokenId: string | undefined;
    try {
      await page.goto(PAGE_URL);
      await page.getByRole("button", { name: "Create token" }).first().click();
      await page.getByPlaceholder(/Claude Code/).fill(name);
      await page.locator("form").getByRole("button", { name: "Create token" }).click();
      await expect(page.getByTestId("token-reveal-expiry")).toBeVisible();

      const listed = (await (await request.get(`/api/projects/${ctx.projectId}/apikeys`)).json()) as Array<{
        id: string;
        name: string;
        expiresAt: string;
      }>;
      const created = listed.find((t) => t.name === name);
      tokenId = created?.id;
      const days = (Date.parse(created!.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThan(91);
    } finally {
      await remove(request, tokenId);
    }
  });
});
