import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { env } from "../utils/env";
import { exec, literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The custom fields screens: the per-project settings editor, and the two places a field shows up
 * once it exists — the test case panel and the list's filter popover.
 *
 * What makes these worth a browser rather than more API tests: the API decides what is *allowed*,
 * the screen decides what is *offered*. A QA engineer shown an "Add custom field" button that 403s,
 * a Delete button on a field that holds values, or an archived field still offering "Deactivate"
 * are all bugs api/custom-fields.spec.ts cannot see.
 *
 * Runs against its own disposable workspace ("custom-fields-ui"), which provisionRbacTenant puts on
 * Pro. One test downgrades it to Launch to check the upsell and puts it straight back.
 */

const CREATE_MODAL_TITLE = "Add custom field";

test.describe("custom fields (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  const states = new Map<string, string>();
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("custom-fields-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    states.set("owner", await writeStorageState(tenant.owner, "custom-fields-ui-owner"));
    states.set("qa", await writeStorageState(tenant.qa, "custom-fields-ui-qa"));
    purgeFixtures(tenant);
  });

  test.afterAll(async () => {
    if (tenant) {
      purgeFixtures(tenant);
      setProPlan(tenant.organizationId);
    }
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
    exec(`DELETE FROM custom_field_definitions WHERE project_id IN (${projects});`);
    exec(`DELETE FROM testcases WHERE project_id IN (${projects});`);
  }

  /** A page signed in as one of the fixture roles. baseURL isn't inherited by newContext(). */
  async function pageAs(browser: import("@playwright/test").Browser, label: string): Promise<Page> {
    const context = await browser.newContext({ baseURL: env.webBaseUrl, storageState: states.get(label)! });
    contexts.push(context);
    return context.newPage();
  }

  function settingsUrl(): string {
    return `/projects/${tenant!.mainProjectId}/settings/custom-fields`;
  }

  function testcasesUrl(): string {
    return `/projects/${tenant!.mainProjectId}/testcases`;
  }

  function definitionsUrl(): string {
    return `/api/projects/${tenant!.mainProjectId}/custom-fields/definitions`;
  }

  function fieldName(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function defineField(body: Record<string, unknown>): Promise<any> {
    const res = await api.post(definitionsUrl(), {
      data: { name: fieldName(String(body.fieldType ?? "field")), ...body },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  async function listFields(): Promise<any[]> {
    const res = await api.get(definitionsUrl());
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  async function seedTestCase(data: Record<string, unknown>): Promise<any> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title: `E2E CF UI Case ${Date.now()}${Math.floor(Math.random() * 1000)}`, ...data },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  function storedValue(definitionId: string, testcaseId: string): string {
    return scalar(
      `SELECT value::text FROM custom_field_values WHERE definition_id = ${literal(definitionId)} ` +
        `AND testcase_id = ${literal(testcaseId)};`,
    );
  }

  /*
   * The definition editor renders through components/ui/Modal, which portals to <body> and marks
   * both its backdrop and its panel role="presentation" — there is no role="dialog" to target. The
   * panel is the innermost of the two, hence .last().
   */
  function modal(page: Page, title: string): Locator {
    return page
      .locator("div[role='presentation']", { has: page.getByRole("heading", { name: title, exact: true }) })
      .last();
  }

  /*
   * Field labels in this form are plain <label> elements with no htmlFor, so getByLabel can't reach
   * the control. Every Field renders <label> immediately followed by its input, so the adjacent
   * sibling selector is the stable way in.
   */
  function control(scope: Locator, label: string, tag: "input" | "select" | "textarea" = "input"): Locator {
    return scope.locator(`label:text-is("${label}") + ${tag}`);
  }

  function checkbox(scope: Locator, label: string): Locator {
    return scope.locator("label").filter({ hasText: label }).locator("input[type='checkbox']");
  }

  function definitionRow(page: Page, name: string): Locator {
    return page.locator("tbody tr").filter({ hasText: name });
  }

  /*
   * One option row inside CustomFieldOptionsEditor — the row div carries `rounded-md` (used for the
   * drag-over highlight) and contains that option's label <input>, which is how it's told apart
   * from the "Add an option…" row (a sibling div with no `rounded-md` class).
   */
  function optionRow(scope: Locator, label: string): Locator {
    return scope.locator("div.rounded-md").filter({ has: scope.locator(`input[value="${label}"]`) });
  }

  /** DOM order of every saved option row's label, read straight from the inputs. */
  function optionLabelsInDom(scope: Locator): Promise<string[]> {
    return scope.locator("div.rounded-md input[type='text']").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  }

  // ─── The settings screen ───────────────────────────────────────────────────

  test("an owner can add a custom field and see it listed", { tag: '@tesbo.testId("TES-TC-654")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    await expect(page.getByRole("heading", { name: "Custom Fields" })).toBeVisible();

    await page.getByRole("button", { name: "Add custom field" }).click();
    const form = modal(page, CREATE_MODAL_TITLE);
    const name = fieldName("UI Text");
    await control(form, "Field name").fill(name);
    await control(form, "Description / helper text", "textarea").fill("Where the risk sits");
    await control(form, "Field type", "select").selectOption("number");
    await control(form, "Unit").fill("hours");
    await checkbox(form, "Required").check();
    await form.getByRole("button", { name: "Create field" }).click();

    await expect(form).toBeHidden();
    const row = definitionRow(page, name);
    await expect(row).toContainText("Number");
    await expect(row).toContainText("Required");
    await expect(row).toContainText("Active");
    await expect(row).toContainText("Where the risk sits");

    // The screen's own summary is not the proof — the persisted definition is.
    const [persisted] = await listFields();
    expect(persisted).toMatchObject({ name, fieldType: "number", required: true, status: "active" });
    expect(persisted.config.unit).toBe("hours");
  });

  test("a select field can be built with options from the modal", { tag: '@tesbo.testId("TES-TC-655")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());

    await page.getByRole("button", { name: "Add custom field" }).click();
    const form = modal(page, CREATE_MODAL_TITLE);
    const name = fieldName("UI Select");
    await control(form, "Field name").fill(name);
    await control(form, "Field type", "select").selectOption("single_select");

    for (const label of ["Low", "High"]) {
      await form.getByPlaceholder("Add an option").fill(label);
      await form.getByRole("button", { name: "Add", exact: true }).click();
    }
    await form.getByRole("button", { name: "Create field" }).click();
    await expect(form).toBeHidden();

    const [persisted] = await listFields();
    expect(persisted.config.options.map((o: any) => o.label)).toEqual(["Low", "High"]);
    await expect(definitionRow(page, name)).toContainText("Single-Select Dropdown");
  });

  test("multiselect options can be dragged to a new position, and the order persists through save and reopening the field", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());

    await page.getByRole("button", { name: "Add custom field" }).click();
    const form = modal(page, CREATE_MODAL_TITLE);
    const name = fieldName("UI Option Drag");
    await control(form, "Field name").fill(name);
    await control(form, "Field type", "select").selectOption("multi_select");
    for (const label of ["Chrome", "Edge", "Firefox", "Safari"]) {
      await form.getByPlaceholder("Add an option").fill(label);
      await form.getByRole("button", { name: "Add", exact: true }).click();
    }

    // Mirrors the ticket's own example: drag "Safari" to the top.
    await optionRow(form, "Safari").dragTo(optionRow(form, "Chrome"));
    expect(await optionLabelsInDom(form)).toEqual(["Safari", "Chrome", "Edge", "Firefox"]);

    await form.getByRole("button", { name: "Create field" }).click();
    await expect(form).toBeHidden();

    const [persisted] = await listFields();
    expect(persisted.config.options.map((o: any) => o.label)).toEqual(["Safari", "Chrome", "Edge", "Firefox"]);

    // Reopening the field for edit re-sorts by the persisted `order`, so this proves the order
    // survived the round trip through the database — not just that local state looked right
    // before the save request was even sent.
    await definitionRow(page, name).getByRole("button", { name: "Edit" }).click();
    const editForm = modal(page, "Edit custom field");
    expect(await optionLabelsInDom(editForm)).toEqual(["Safari", "Chrome", "Edge", "Firefox"]);
  });

  test("a name the server refuses is reported in the form, and nothing is created", { tag: '@tesbo.testId("TES-TC-656")' }, async ({ browser }) => {
    const existing = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    await page.getByRole("button", { name: "Add custom field" }).click();

    const form = modal(page, CREATE_MODAL_TITLE);
    await control(form, "Field name").fill(existing.name.toUpperCase());
    await form.getByRole("button", { name: "Create field" }).click();

    await expect(form.getByRole("alert")).toContainText("already exists");
    await expect(form).toBeVisible();
    expect(await listFields()).toHaveLength(1);
  });

  /*
   * A multiselect's minSelected/maxSelected inversion (min=4, max=3) validates correctly on the
   * backend (custom-field-validation.ts's validateConfigShape), but the thrown BadRequestException
   * carries a bare { field, message } body — not the { error }/{ errors } shape lib/api.ts's
   * formatApiError otherwise recognizes — so the message was silently dropped in favor of the
   * generic "Something went wrong. Please try again." fallback. Covers the exact scenario the
   * ticket described, plus that a valid min/max still saves normally and that the fix generalizes
   * to another field type's own min/max check (not just this one message).
   */
  test(
    "a multiselect whose minimum exceeds its maximum reports the specific reason, not a generic failure",
    async ({ browser }) => {
      const page = await pageAs(browser, "owner");
      await page.goto(settingsUrl());
      await page.getByRole("button", { name: "Add custom field" }).click();

      const form = modal(page, CREATE_MODAL_TITLE);
      const name = fieldName("UI Multiselect Inverted");
      await control(form, "Field name").fill(name);
      await control(form, "Field type", "select").selectOption("multi_select");
      for (const label of ["One", "Two", "Three"]) {
        await form.getByPlaceholder("Add an option").fill(label);
        await form.getByRole("button", { name: "Add", exact: true }).click();
      }
      await control(form, "Minimum selections").fill("4");
      await control(form, "Maximum selections").fill("3");
      await form.getByRole("button", { name: "Create field" }).click();

      const alert = form.getByRole("alert");
      await expect(alert).toContainText("Minimum selections cannot be greater than maximum selections.");
      await expect(alert).not.toContainText("Something went wrong");
      await expect(form).toBeVisible();
      expect(await listFields()).toHaveLength(0);
    },
  );

  test("a multiselect with a valid minimum/maximum saves normally", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    await page.getByRole("button", { name: "Add custom field" }).click();

    const form = modal(page, CREATE_MODAL_TITLE);
    const name = fieldName("UI Multiselect Valid");
    await control(form, "Field name").fill(name);
    await control(form, "Field type", "select").selectOption("multi_select");
    for (const label of ["One", "Two", "Three"]) {
      await form.getByPlaceholder("Add an option").fill(label);
      await form.getByRole("button", { name: "Add", exact: true }).click();
    }
    await control(form, "Minimum selections").fill("1");
    await control(form, "Maximum selections").fill("3");
    await form.getByRole("button", { name: "Create field" }).click();

    await expect(form).toBeHidden();
    const [persisted] = await listFields();
    expect(persisted).toMatchObject({ name, fieldType: "multi_select" });
    expect(persisted.config.minSelected).toBe(1);
    expect(persisted.config.maxSelected).toBe(3);
  });

  test("a number field's own inverted min/max also reports its specific reason, not a generic failure", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    await page.getByRole("button", { name: "Add custom field" }).click();

    const form = modal(page, CREATE_MODAL_TITLE);
    const name = fieldName("UI Number Inverted");
    await control(form, "Field name").fill(name);
    await control(form, "Field type", "select").selectOption("number");
    await control(form, "Minimum value").fill("10");
    await control(form, "Maximum value").fill("1");
    await form.getByRole("button", { name: "Create field" }).click();

    const alert = form.getByRole("alert");
    await expect(alert).toContainText("min cannot exceed max");
    await expect(alert).not.toContainText("Something went wrong");
    await expect(form).toBeVisible();
    expect(await listFields()).toHaveLength(0);
  });

  test("the order arrows move a field, and the new order is what the project keeps", { tag: '@tesbo.testId("TES-TC-657")' }, async ({ browser }) => {
    const first = await defineField({ fieldType: "text" });
    const second = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    await expect(definitionRow(page, first.name)).toBeVisible();

    await definitionRow(page, second.name).getByRole("button", { name: "Move up" }).click();

    await expect(page.locator("tbody tr").first()).toContainText(second.name);
    await expect
      .poll(async () => (await listFields()).map((d) => d.id))
      .toEqual([second.id, first.id]);
  });

  test("a field can be dragged to a new position, and the order persists after reload", async ({ browser }) => {
    const first = await defineField({ fieldType: "text" });
    const second = await defineField({ fieldType: "text" });
    const third = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    await expect(definitionRow(page, third.name)).toBeVisible();

    // Mirrors the ticket's own example: dragging the last row onto the first row's position moves
    // it to the top, shifting the others down by one — not a swap with one neighbor.
    await definitionRow(page, third.name).dragTo(definitionRow(page, first.name));

    await expect
      .poll(async () => (await listFields()).map((d) => d.id))
      .toEqual([third.id, first.id, second.id]);
    await expect(page.locator("tbody tr").first()).toContainText(third.name);

    // Persists across a reload, not just in the in-memory list the drop already updated.
    await page.reload();
    await expect(page.locator("tbody tr").first()).toContainText(third.name);
    await expect(page.locator("tbody tr").nth(1)).toContainText(first.name);
    await expect(page.locator("tbody tr").nth(2)).toContainText(second.name);
  });

  test("an archived field cannot be dragged, and dropping onto its row does nothing", async ({ browser }) => {
    const archived = await defineField({ fieldType: "text" });
    const active = await defineField({ fieldType: "text" });
    await api.patch(`${definitionsUrl()}/${archived.id}/status`, { data: { status: "archived" } });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    const archivedRow = definitionRow(page, archived.name);
    await expect(archivedRow).toContainText("Archived");

    // No drag handle, no up/down controls — same affordance gap the buttons already had.
    await expect(archivedRow.getByRole("button", { name: "Move up" })).toHaveCount(0);
    await expect(archivedRow.locator("[title='Drag to reorder']")).toHaveCount(0);
    await expect(archivedRow).toHaveAttribute("draggable", "false");

    // Attempting to drag the archived row onto the active one is a no-op: nothing is draggable
    // there, so no dragstart ever fires and the order is unaffected.
    await archivedRow.dragTo(definitionRow(page, active.name));
    await expect
      .poll(async () => (await listFields()).map((d) => d.id))
      .toEqual([archived.id, active.id]);

    // And the reverse — dropping an active row onto the archived one — is refused the same way:
    // the archived row wires up no onDrop handler, so the browser never allows the drop.
    await definitionRow(page, active.name).dragTo(archivedRow);
    await expect
      .poll(async () => (await listFields()).map((d) => d.id))
      .toEqual([archived.id, active.id]);
  });

  test("an active field's row offers Edit, Deactivate, Archive and Delete as accessible, enabled buttons", async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    const row = definitionRow(page, field.name);

    // Icons were added to these buttons for the redesigned Actions column, but the accessible name
    // must still be exactly the plain label — an icon-only button (accessible name overridden by an
    // aria-label instead of visible text) would silently break every other test's
    // `getByRole("button", { name: ... })` locator, so this pins the contract those tests rely on.
    for (const label of ["Edit", "Deactivate", "Archive", "Delete"]) {
      const button = row.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    }
  });

  test("a field can be deactivated and reactivated from the list", { tag: '@tesbo.testId("TES-TC-658")' }, async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    const row = definitionRow(page, field.name);

    await row.getByRole("button", { name: "Deactivate" }).click();
    await expect(row).toContainText("Inactive");
    await expect.poll(async () => (await listFields())[0].status).toBe("inactive");

    await row.getByRole("button", { name: "Activate" }).click();
    await expect(row).toContainText("Active");
    await expect.poll(async () => (await listFields())[0].status).toBe("active");
  });

  test("archiving asks first and leaves the field read-only", { tag: '@tesbo.testId("TES-TC-659")' }, async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    // Archiving goes through window.confirm, which Playwright dismisses by default — an unhandled
    // dialog would silently make this a no-op test.
    page.on("dialog", (dialog) => {
      expect(dialog.message()).toContain("Archived fields become read-only");
      return dialog.accept();
    });
    await page.goto(settingsUrl());

    const row = definitionRow(page, field.name);
    await row.getByRole("button", { name: "Archive" }).click();

    await expect(row).toContainText("Archived");
    // An archived field offers none of the edit affordances, because the API refuses all of them —
    // except Delete, which now works uniformly from any status (see TES-TC-3009: this used to be a
    // dead end for an archived field that also held recorded values).
    await expect(row.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Archive" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Delete" })).toHaveCount(1);
    await expect.poll(async () => (await listFields())[0].status).toBe("archived");
  });

  test("deleting a field now works whether or not it holds values, offering Undo instead of blocking", { tag: '@tesbo.testId("TES-TC-660")' }, async ({ browser }) => {
    const unused = await defineField({ fieldType: "text" });
    const used = await defineField({ fieldType: "text" });
    await seedTestCase({ customFieldValues: { [used.id]: "recorded" } });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());

    // Both are offered Delete now — a field in use is no longer excluded from it.
    const usedRow = definitionRow(page, used.name);
    await expect(usedRow).toContainText("Yes");
    await expect(usedRow.getByRole("button", { name: "Delete" })).toHaveCount(1);

    await definitionRow(page, unused.name).getByRole("button", { name: "Delete" }).click();
    const confirm = modal(page, "Delete custom field");
    await expect(confirm).toContainText(unused.name);
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();

    // The row stays, but as a struck-through "Deleted" placeholder offering only Undo.
    const deletedRow = definitionRow(page, unused.name);
    await expect(deletedRow).toContainText("Deleted");
    await expect(deletedRow.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(deletedRow.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect.poll(async () => (await listFields()).map((d) => d.id)).toEqual([used.id]);
  });

  test("deleting a field in use preserves its recorded value, and Undo restores the row", { tag: '@tesbo.testId("TES-TC-3007")' }, async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await seedTestCase({ customFieldValues: { [field.id]: "keep me" } });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());

    await definitionRow(page, field.name).getByRole("button", { name: "Delete" }).click();
    await modal(page, "Delete custom field").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(definitionRow(page, field.name)).toContainText("Deleted");

    // Gone from the settings list, but the value already on the test case is untouched.
    expect(await listFields()).toHaveLength(0);
    expect(storedValue(field.id, testcase.id)).toBe('"keep me"');

    await definitionRow(page, field.name).getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await listFields()).map((d) => d.id)).toEqual([field.id]);
    const restoredRow = definitionRow(page, field.name);
    await expect(restoredRow).toContainText("Active");
    await expect(restoredRow.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  test("the Undo offer does not survive a page reload", { tag: '@tesbo.testId("TES-TC-3008")' }, async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());

    await definitionRow(page, field.name).getByRole("button", { name: "Delete" }).click();
    await modal(page, "Delete custom field").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(definitionRow(page, field.name)).toContainText("Deleted");

    // Reloading is the user's signal they're done with this session — the row (and its Undo
    // affordance) is local-only state and does not come back, even though the field remains
    // soft-deleted (and technically restorable) in the database.
    await page.reload();
    await expect(definitionRow(page, field.name)).toHaveCount(0);
    await expect(page.getByText("No custom fields yet.")).toBeVisible();
  });

  test("an archived field that also holds values can be deleted directly — no more dead end", { tag: '@tesbo.testId("TES-TC-3009")' }, async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });
    await seedTestCase({ customFieldValues: { [field.id]: "still archived" } });
    await api.patch(`${definitionsUrl()}/${field.id}/status`, { data: { status: "archived" } });

    const page = await pageAs(browser, "owner");
    await page.goto(settingsUrl());
    const row = definitionRow(page, field.name);
    await expect(row).toContainText("Archived");
    await expect(row).toContainText("Yes");

    await row.getByRole("button", { name: "Delete" }).click();
    await modal(page, "Delete custom field").getByRole("button", { name: "Delete", exact: true }).click();

    await expect(definitionRow(page, field.name)).toContainText("Deleted");
    expect(await listFields()).toHaveLength(0);
  });

  test("a QA engineer is told the screen isn't theirs to use", { tag: '@tesbo.testId("TES-TC-661")' }, async ({ browser }) => {
    await defineField({ fieldType: "text" });

    const page = await pageAs(browser, "qa");
    await page.goto(settingsUrl());

    await expect(page.getByText("Only project owners and managers can manage custom fields.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add custom field" })).toHaveCount(0);
  });

  test("on the Launch plan the screen sells the upgrade instead of offering the editor", { tag: '@tesbo.testId("TES-TC-662")' }, async ({ browser }) => {
    resetToLaunch(tenant!.organizationId);
    try {
      const page = await pageAs(browser, "owner");
      await page.goto(settingsUrl());

      await expect(page.getByText("Custom fields are a Pro plan feature")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add custom field" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  test("a workspace that downgrades keeps seeing the fields it already has, with a warning", { tag: '@tesbo.testId("TES-TC-663")' }, async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });
    resetToLaunch(tenant!.organizationId);
    try {
      const page = await pageAs(browser, "owner");
      await page.goto(settingsUrl());

      await expect(definitionRow(page, field.name)).toBeVisible();
      await expect(page.getByText("This workspace is on the Launch plan")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add custom field" })).toBeDisabled();
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  // ─── On the test case panel ────────────────────────────────────────────────

  test("a required custom field is enforced on the create panel and its value is saved", { tag: '@tesbo.testId("TES-TC-664")' }, async ({ browser }) => {
    const placeholder = "e.g. payments";
    const field = await defineField({ fieldType: "text", required: true, config: { placeholder } });

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: "Add test case" }).first().click();

    const panel = page.locator("aside");
    const title = `E2E CF UI Case ${Date.now()}`;
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    await expect(panel.getByText("Custom Fields", { exact: true })).toBeVisible();

    // Saving without the required field must be refused by the screen, not by a 400 the user only
    // sees as a generic failure.
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(panel.getByText(`${field.name} is required`)).toBeVisible();

    await panel.getByPlaceholder(placeholder).fill("Payments");
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    await expect(panel.getByText("Test case created successfully.")).toBeVisible();

    const created = await api
      .get(`/api/projects/${tenant!.mainProjectId}/testcases`, { params: { search: title } })
      .then((r) => r.json());
    expect(created).toHaveLength(1);
    expect(storedValue(field.id, created[0].id)).toBe('"Payments"');
  });

  test("an existing test case shows its custom fields on their own tab", { tag: '@tesbo.testId("TES-TC-665")' }, async ({ browser }) => {
    const single = await defineField({
      fieldType: "single_select",
      config: { options: [{ label: "Low" }, { label: "High" }] },
    });
    const [lowId, highId] = single.config.options.map((o: any) => o.id);
    const testcase = await seedTestCase({ customFieldValues: { [single.id]: lowId } });

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: testcase.title }).click();

    const panel = page.locator("aside");
    await panel.getByRole("button", { name: /^Custom Fields/ }).click();
    // Told apart from the panel's other dropdowns by an option only this field has.
    const select = panel.locator("select").filter({ has: page.locator("option", { hasText: "High" }) });
    await expect(select).toHaveValue(lowId);

    await select.selectOption(highId);
    await panel.getByRole("button", { name: "Save changes" }).click();

    await expect.poll(() => storedValue(single.id, testcase.id)).toBe(`"${highId}"`);
  });

  /*
   * Regression test: an unset single_select/boolean custom field used to render its placeholder
   * <option> with the literal text "—" (CustomFieldValueInput.tsx) — indistinguishable from a
   * disabled text box, unlike every other field type's real placeholder (Input's `placeholder`
   * attribute for text fields, the browser's own empty state for date/number). Fixed to read
   * "Select…", matching the "Select …" placeholder convention already used everywhere else in the
   * app (e.g. CustomFieldFilterPopover's own "Select an option…").
   */
  test("an unset dropdown custom field shows a 'Select…' placeholder, not a bare dash", async ({ browser }) => {
    await defineField({
      fieldType: "single_select",
      config: { options: [{ label: "Chrome" }, { label: "Firefox" }] },
    });
    await defineField({ fieldType: "boolean" });
    // Neither field is given a value — this pins the empty state, not the filled one the test
    // above already covers.
    const testcase = await seedTestCase({});

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: testcase.title }).click();

    const panel = page.locator("aside");
    await panel.getByRole("button", { name: /^Custom Fields/ }).click();

    // Told apart from the panel's other dropdowns by an option only each field has (same
    // convention as the test above).
    const singleSelect = panel.locator("select").filter({ has: page.locator("option", { hasText: "Chrome" }) });
    const booleanSelect = panel.locator("select").filter({ has: page.locator("option", { hasText: "Yes" }) });

    for (const select of [singleSelect, booleanSelect]) {
      await expect(select).toHaveValue("");
      // The placeholder <option>'s own visible label is what the user actually reads — not just
      // the <select>'s resolved value, which was already "" before this fix too.
      const selectedOptionText = await select.evaluate(
        (el: HTMLSelectElement) => el.options[el.selectedIndex]?.textContent?.trim(),
      );
      expect(selectedOptionText).toBe("Select…");
      await expect(select.locator("option", { hasText: "—" })).toHaveCount(0);
    }
  });

  /*
   * Deactivating or archiving a field used to leave it visible on this tab as a locked, read-only
   * box (CustomFieldsSection.tsx's non-active branch) — which is what the earlier "Select…, not a
   * bare dash" fix above was patching the display of. The product decision changed: a non-active
   * field should not appear on this tab at all, active or not, so the panel always mirrors what
   * Project Settings currently has switched on. That locked-box rendering path is now unreachable
   * from here (getValuesForTestCase only returns `status = 'active'` rows) and is exercised, if at
   * all, only by test data these specs don't construct — nothing here should still assert it shows.
   */
  test("a deactivated field disappears from the test case panel, its value survives underneath, and it reappears once reactivated", async ({
    browser,
  }) => {
    const stays = await defineField({ fieldType: "text" });
    const toggled = await defineField({ fieldType: "text" });
    const testcase = await seedTestCase({
      customFieldValues: { [stays.id]: "always shown", [toggled.id]: "still recorded" },
    });
    await api.patch(`${definitionsUrl()}/${toggled.id}/status`, { data: { status: "inactive" } });

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: testcase.title }).click();
    let panel = page.locator("aside");
    await panel.getByRole("button", { name: /^Custom Fields/ }).click();

    await expect(panel.getByText(stays.name)).toBeVisible();
    await expect(panel.getByText(toggled.name)).toHaveCount(0);
    // Hidden from the panel, but nothing was deleted underneath.
    expect(storedValue(toggled.id, testcase.id)).toBe('"still recorded"');

    await api.patch(`${definitionsUrl()}/${toggled.id}/status`, { data: { status: "active" } });
    await page.reload();
    await page.getByRole("button", { name: testcase.title }).click();
    panel = page.locator("aside");
    await panel.getByRole("button", { name: /^Custom Fields/ }).click();
    await expect(panel.getByText(toggled.name)).toBeVisible();
  });

  test("an archived field also disappears from the test case panel, keeping its recorded value", async ({ browser }) => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await seedTestCase({ customFieldValues: { [field.id]: "still there" } });
    await api.patch(`${definitionsUrl()}/${field.id}/status`, { data: { status: "archived" } });

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await page.getByRole("button", { name: testcase.title }).click();
    const panel = page.locator("aside");
    await panel.getByRole("button", { name: /^Custom Fields/ }).click();

    await expect(panel.getByText(field.name)).toHaveCount(0);
    expect(storedValue(field.id, testcase.id)).toBe('"still there"');
  });

  // ─── Filtering the list ────────────────────────────────────────────────────

  test("the custom field filter narrows the test case list", { tag: '@tesbo.testId("TES-TC-666")' }, async ({ browser }) => {
    const single = await defineField({
      fieldType: "single_select",
      config: { options: [{ label: "Alpha" }, { label: "Beta" }] },
    });
    const [alphaId, betaId] = single.config.options.map((o: any) => o.id);
    const alphaCase = await seedTestCase({ customFieldValues: { [single.id]: alphaId } });
    const betaCase = await seedTestCase({ customFieldValues: { [single.id]: betaId } });

    const page = await pageAs(browser, "owner");
    await page.goto(testcasesUrl());
    await expect(page.getByRole("button", { name: alphaCase.title })).toBeVisible();
    await expect(page.getByRole("button", { name: betaCase.title })).toBeVisible();

    await page.getByRole("button", { name: "Custom fields" }).click();
    const popover = page.locator("div").filter({ has: page.getByRole("button", { name: "Add filter" }) }).last();
    await popover.locator("select").nth(0).selectOption(single.id);
    await popover.locator("select").nth(1).selectOption("is");
    await popover.locator("select").nth(2).selectOption(alphaId);
    await popover.getByRole("button", { name: "Add filter" }).click();

    await expect(page.getByRole("button", { name: betaCase.title })).toHaveCount(0);
    await expect(page.getByRole("button", { name: alphaCase.title })).toBeVisible();
    // The trigger carries the count, so an active filter can't be invisible.
    await expect(page.getByRole("button", { name: "Custom fields" })).toContainText("1");
  });
});
