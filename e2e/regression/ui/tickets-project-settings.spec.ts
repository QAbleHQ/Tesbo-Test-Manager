import { expect, test } from "@playwright/test";
import { accountA, apiContext, ticket, unique } from "../fixtures";

/*
 * Reported-ticket regressions for Project Settings → Test Environments.
 * Card 10221899361, BetterBugs 6a86cede, filed against .../settings?tab=testRuns.
 *
 * This is one of the few cards in this folder whose fix genuinely shipped, so every test here is a
 * real green assertion rather than an expected-red one. handleAddEnvironment() validates both of the
 * cases the card is about:
 *
 *   no name / no URL              -> "Environment name is required" / "Environment URL is required"
 *   name already in the list      -> "An environment with this name already exists"   (case-insensitive)
 *
 * (The wording above follows lib/validation.ts's validateEnvironmentName/Url; the original card text
 * was "Environment name and URL are required." / "Environment name already exists.")
 *
 * The screen has TWO steps, which is the thing to get right when reading these tests: **Add** stages
 * an environment into local component state and clears the two inputs; **Save** is what PATCHes the
 * project. So validation is asserted on Add, and persistence on Save. A test that only clicked Save
 * would exercise the half-typed-draft fallback in the submit handler instead of the validation the
 * ticket is actually about.
 *
 * Environments live inside the project's `settings` JSON blob, so persistence is verified against
 * GET /api/projects/:id, never against the on-screen toast — the suite's convention is that a
 * message is not evidence.
 */

test.describe("project settings — test environments", () => {
  const settingsUrl = () => `/projects/${accountA().projectId}/settings?tab=testRuns`;

  const nameInput = "Environment name";
  const urlInput = "https://staging.example.com";

  /*
   * These tests write into account A's real project, shared with the rest of the suite, and Save
   * rewrites the whole environments array rather than appending to it. So the settings blob is
   * captured before each test and restored after, which is both the cleanup and the reason a failed
   * test cannot leave the project altered for whatever runs next.
   */
  /*
   * `captured` is tracked separately from the value itself, and that distinction is load-bearing: a
   * project whose settings column is still NULL — the normal state of a freshly created project, so
   * the likely state on a new environment — would otherwise be indistinguishable from "we never read
   * it", and the restore would be skipped exactly where it is needed. The environments this file adds
   * would then be left behind in a shared project.
   */
  let originalSettings: unknown = null;
  let captured = false;

  test.beforeEach(async () => {
    const api = await apiContext();
    try {
      const project = await (await api.get(`/api/projects/${accountA().projectId}`)).json();
      originalSettings = project.settings ?? null;
      captured = true;
    } finally {
      await api.dispose();
    }
  });

  test.afterEach(async () => {
    if (!captured) return;
    const api = await apiContext();
    try {
      await api.patch(`/api/projects/${accountA().projectId}`, {
        // An empty settings object where there was none: this screen's own save path would write one
        // anyway, and it leaves no environment behind, which is the property that matters.
        data: { settings: originalSettings ?? {} },
        failOnStatusCode: false,
      });
    } finally {
      await api.dispose();
    }
    captured = false;
  });

  async function storedEnvironments(): Promise<Array<{ name: string; url: string }>> {
    const api = await apiContext();
    try {
      const project = await (await api.get(`/api/projects/${accountA().projectId}`)).json();
      // The API returns the jsonb object. (This helper used to JSON.parse a string, which only worked
      // because the double-encoding bug stored settings as a jsonb string.)
      const settings = typeof project.settings === "string" ? JSON.parse(project.settings) : (project.settings ?? {});
      return Array.isArray(settings.testRunEnvironments) ? settings.testRunEnvironments : [];
    } finally {
      await api.dispose();
    }
  }

  test(
    ticket("REG-ENV-01", "10221899361", "adding a name with no URL is refused"),
    { tag: '@tesbo.testId("TES-TC-1301")' },
    async ({ page }) => {
      await page.goto(settingsUrl());

      const name = unique("Env");
      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText("Environment URL is required")).toBeVisible();
      // Refused means not staged: the name is still in the box, waiting to be completed.
      await expect(page.getByPlaceholder(nameInput)).toHaveValue(name);
    },
  );

  test(
    ticket("REG-ENV-02", "10221899361", "adding a URL with no name is refused"),
    { tag: '@tesbo.testId("TES-TC-1302")' },
    async ({ page }) => {
      await page.goto(settingsUrl());

      await page.getByPlaceholder(urlInput).fill("https://reg-no-name.example.com");
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText("Environment name is required")).toBeVisible();
      await expect(page.getByPlaceholder(urlInput)).toHaveValue("https://reg-no-name.example.com");
    },
  );

  test(
    ticket("REG-ENV-03", "10221899361", "a complete environment stages, saves, and reads back from the API"),
    { tag: '@tesbo.testId("TES-TC-1303")' },
    async ({ page }) => {
      // The happy path, so that a future tightening of the validation cannot start refusing valid
      // input and still pass REG-ENV-01/02.
      await page.goto(settingsUrl());

      const name = unique("Env");
      const url = `https://reg-${Date.now()}.example.com`;

      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(url);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      // Staged: the inputs clear and the row appears in the table above them.
      await expect(page.getByPlaceholder(nameInput)).toHaveValue("");
      await expect(page.getByText(name)).toBeVisible();

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project settings saved.")).toBeVisible();

      expect(
        await storedEnvironments(),
        "the saved environment should be readable back from the project",
      ).toEqual(expect.arrayContaining([expect.objectContaining({ name, url })]));
    },
  );

  test(
    ticket("REG-ENV-04", "10221899361", "a duplicate environment name is refused, whatever its casing"),
    { tag: '@tesbo.testId("TES-TC-1304")' },
    async ({ page }) => {
      /*
       * The second validation the fix added. Asserted with a DIFFERENT CASING on purpose: the check
       * is `item.name.toLowerCase() === name.toLowerCase()`, so an assertion that reused the exact
       * same string would still pass if someone replaced it with a plain `===` comparison, and the
       * case-insensitivity — the part that is easy to lose in a refactor — would go untested.
       */
      await page.goto(settingsUrl());

      const name = unique("Env");
      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(`https://first-${Date.now()}.example.com`);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByPlaceholder(nameInput)).toHaveValue("");

      await page.getByPlaceholder(nameInput).fill(name.toUpperCase());
      await page.getByPlaceholder(urlInput).fill(`https://second-${Date.now()}.example.com`);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText("An environment with this name already exists")).toBeVisible();

      // And it really was not staged — saving now must persist exactly one entry for that name.
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project settings saved.")).toBeVisible();

      const matching = (await storedEnvironments()).filter(
        (e) => e.name.toLowerCase() === name.toLowerCase(),
      );
      expect(matching, "the duplicate must not have been added alongside the original").toHaveLength(1);
    },
  );

  test(
    ticket("REG-ENV-05", "settings-save-500", "an added environment is a draft until Save persists it"),
    { tag: '@tesbo.testId("TES-TC-3027")' },
    async ({ page }) => {
      await page.goto(settingsUrl());
      const before = await storedEnvironments();

      const name = unique("Draft");
      const url = `https://draft-${Date.now()}.example.com`;
      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(url);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText(name)).toBeVisible();
      await expect(page.getByText("(unsaved)")).toBeVisible();
      expect(await storedEnvironments(), "Add alone must not persist anything").toEqual(before);

      // Leaving without Save discards the draft.
      await page.reload();
      await expect(page.getByText(name)).toHaveCount(0);
      expect(await storedEnvironments()).toEqual(before);

      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(url);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      // The inline success message, green and announced as a status, not an alert.
      const ok = page.getByRole("status").filter({ hasText: "Project settings saved." });
      await expect(ok).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText("(unsaved)")).toHaveCount(0);
      expect(await storedEnvironments()).toEqual(expect.arrayContaining([expect.objectContaining({ name, url })]));

      await page.reload();
      await expect(page.getByText(name)).toBeVisible();
    },
  );

  test(
    ticket("REG-ENV-06", "settings-save-500", "text typed but never added is not saved, and Save says so"),
    { tag: '@tesbo.testId("TES-TC-3028")' },
    async ({ page }) => {
      await page.goto(settingsUrl());
      const before = await storedEnvironments();

      await page.getByPlaceholder(nameInput).fill(unique("Typed"));
      await page.getByPlaceholder(urlInput).fill(`https://typed-${Date.now()}.example.com`);
      await page.getByRole("button", { name: "Save", exact: true }).click();

      await expect(page.getByRole("alert").filter({ hasText: "Click Add" })).toBeVisible();
      await expect(page.getByText("Project settings saved.")).toHaveCount(0);
      expect(await storedEnvironments(), "nothing may be saved while input is pending").toEqual(before);

      // Whitespace-only input is not pending input.
      await page.getByPlaceholder(nameInput).fill("   ");
      await page.getByPlaceholder(urlInput).fill("");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Project settings saved." })).toBeVisible();
    },
  );

  test(
    ticket("REG-ENV-07", "settings-save-500", "a failed save shows the server error inline and keeps the drafts"),
    { tag: '@tesbo.testId("TES-TC-3029")' },
    async ({ page }) => {
      await page.route("**/api/projects/*", async (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) });
      });
      await page.goto(settingsUrl());
      const before = await storedEnvironments();

      const name = unique("Fail");
      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(`https://fail-${Date.now()}.example.com`);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      await expect(page.getByRole("alert").filter({ hasText: "Internal server error" })).toBeVisible();
      await expect(page.getByText("Project settings saved.")).toHaveCount(0);
      // Draft survives so the user can retry, and is still flagged unsaved.
      await expect(page.getByText(name)).toBeVisible();
      await expect(page.getByText("(unsaved)")).toBeVisible();
      expect(await storedEnvironments()).toEqual(before);
    },
  );

  test(
    ticket("REG-ENV-08", "settings-save-500", "removing an environment only takes effect on Save"),
    { tag: '@tesbo.testId("TES-TC-3030")' },
    async ({ page }) => {
      const api = await apiContext();
      const keep = { name: unique("Keep"), url: `https://keep-${Date.now()}.example.com` };
      const drop = { name: unique("Drop"), url: `https://drop-${Date.now()}.example.com` };
      try {
        await api.patch(`/api/projects/${accountA().projectId}`, { data: { settings: { testRunEnvironments: [keep, drop] } } });
        await page.goto(settingsUrl());

        await page.getByRole("row", { name: new RegExp(drop.name) }).getByRole("button", { name: "Remove" }).click();
        await expect(page.getByText(drop.name)).toHaveCount(0);
        expect(await storedEnvironments(), "Remove alone must not persist").toHaveLength(2);

        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Project settings saved." })).toBeVisible();
        expect(await storedEnvironments()).toEqual([keep]);
      } finally {
        await api.dispose();
      }
    },
  );
});
