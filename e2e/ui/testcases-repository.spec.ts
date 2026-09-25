import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The test case repository screen at /projects/:id/testcases — its header counters, its search box,
 * and its column picker.
 *
 * Three reported tickets:
 *
 *   - BetterBugs 6a7c17a8 — "Test Case Repository count is not updated after deleting test cases".
 *     The screen reports the same number in four places (the TOTAL/DRAFT/APPROVED/DEPRECATED stat
 *     cards, the "N test cases across M suites" subtitle, the suite tree's per-suite counts, and the
 *     "N results" footer) and the report is that they stop agreeing with reality after a delete.
 *     TCR-01..04 assert all four move together, after a single delete and after a bulk one.
 *   - BetterBugs 6a7c1f86 — "Can we have search clear button". There is none: the input is a bare
 *     `<input>` with a magnifier icon and nothing to empty it, so clearing a search means selecting
 *     the text by hand. TCR-05 is expected RED. (The knowledge base screen next door already has a
 *     "Clear" control, so this is an inconsistency as well as a gap.)
 *   - BetterBugs 6a7c217f — "User is able to unselect all Columns types", with the reporter's note
 *     "3 status should not changeable / ID, TC title, Priority". `toggleColumnVisible` has no notion
 *     of a locked column, so every field including ID and the title can be switched off, leaving a
 *     table of bare checkboxes. TCR-06..07 are expected RED.
 *
 * Why its own disposable workspace ("repo-ui"): the header counters are ABSOLUTE numbers for the
 * whole project. Any other spec creating or deleting a case in the same project moves them
 * mid-assertion, and spec files run concurrently. This screen cannot share a project with anything.
 *
 * Locator notes:
 *   - A row's title cell is a button (see ui/testcases-pagination.spec.ts), so rows are located by
 *     `getByRole("button", { name: title })`.
 *   - The pagination footer carries `data-testid="testcases-pagination"` and holds the "N results".
 *   - The Columns control is PORTALED out of the table into the filter bar, so it is found on the
 *     page rather than inside the table element.
 *   - Search is debounced 250ms into `debouncedSuiteSearch`; assertions wait on the row set, not a
 *     fixed delay.
 */

test.describe("test case repository (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  let ownerState = "";
  const contexts: BrowserContext[] = [];

  /** Cases seeded per test, removed in afterEach so every test starts from a known total. */
  let seededIds: string[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("repo-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    ownerState = await writeStorageState(tenant.owner, "repo-ui-owner");
    await purgeCases();
  });

  test.afterAll(async () => {
    if (tenant) await purgeCases();
    if (api) await api.dispose();
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(async () => {
    if (tenant) await purgeCases();
    seededIds = [];
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Empties the project of test cases and suites.
   *
   * Through the API, not psql, so soft-delete semantics and the `testcases_active` view stay exactly
   * what the product does — a hand-written DELETE would leave the counters reading from a state the
   * product can never actually produce.
   */
  async function purgeCases(): Promise<void> {
    const listed = await api.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      params: { limit: 200, offset: 0 },
      failOnStatusCode: false,
    });
    if (listed.ok()) {
      const ids = (await listed.json()).map((tc: { id: string }) => tc.id);
      if (ids.length) {
        await api.post(`/api/projects/${tenant!.mainProjectId}/testcases/bulk-delete`, {
          data: { testcaseIds: ids },
          failOnStatusCode: false,
        });
      }
    }
    const suites = await api.get(`/api/projects/${tenant!.mainProjectId}/suites`, { failOnStatusCode: false });
    if (suites.ok()) {
      for (const suite of await suites.json()) {
        await api.delete(`/api/projects/${tenant!.mainProjectId}/suites/${suite.id}`, { failOnStatusCode: false });
      }
    }
  }

  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function seedSuite(name: string, parentId?: string): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/suites`, {
      data: parentId ? { name, parentId } : { name },
    });
    expect(res.ok(), `seeding suite ${name} — ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
  }

  async function seedCase(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title, ...extra },
    });
    expect(res.ok(), `seeding case ${title} — ${await res.text()}`).toBeTruthy();
    const id = (await res.json()).id;
    seededIds.push(id);
    return id;
  }

  /** The live count straight from the database, as the yardstick every screen number is held to. */
  function storedCaseCount(): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND deleted_at IS NULL;`,
      ),
    );
  }

  async function openRepository(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: ownerState });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/testcases`);
    await expect(page.getByRole("heading", { name: "Test case repository", level: 1 })).toBeVisible();
    return page;
  }

  function pagination(page: Page): Locator {
    return page.getByTestId("testcases-pagination");
  }

  /** The number printed above a stat card's label ("Total", "Draft", "Approved", "Deprecated"). */
  async function statCard(page: Page, label: string): Promise<number> {
    const value = await page.evaluate((wanted) => {
      const labelEl = Array.from(document.querySelectorAll("div")).find(
        (d) => d.textContent?.trim().toLowerCase() === (wanted as string).toLowerCase() && d.children.length === 0,
      );
      return labelEl?.previousElementSibling?.textContent?.trim() ?? "";
    }, label);
    return Number(value);
  }

  function subtitle(page: Page): Locator {
    return page.getByText(/\d+ test cases? across \d+ suites?/);
  }

  function searchBox(page: Page): Locator {
    return page.getByPlaceholder("Search by ID, title, or type");
  }

  function row(page: Page, title: string): Locator {
    return page.getByRole("button", { name: title });
  }

  /** Selects rows by ticking their checkboxes, then runs a bulk action to completion. */
  async function bulkDelete(page: Page, titles: string[]): Promise<void> {
    for (const title of titles) {
      const tableRow = page.getByRole("row").filter({ hasText: title });
      await tableRow.getByRole("checkbox").first().check();
    }
    await expect(page.getByText(`${titles.length} selected`)).toBeVisible();
    await page.getByRole("button", { name: "Bulk actions" }).click();
    await page.getByRole("combobox").filter({ hasText: /Select an action/ }).selectOption("delete");
    await expect(page.getByText(/permanently deletes the selected test cases/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
  }

  // ─── The counters after a delete ───────────────────────────────────────────

  test("TCR-01 every counter on the screen agrees before anything is deleted", { tag: '@tesbo.testId("TES-TC-1072")' }, async ({ browser }) => {
    const suiteName = stamp("CountSuite");
    const suiteId = await seedSuite(suiteName);
    const titles = [stamp("CountA"), stamp("CountB"), stamp("CountC")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);

    expect(storedCaseCount()).toBe(3);
    expect(await statCard(page, "Total")).toBe(3);
    expect(await statCard(page, "Approved")).toBe(3);
    await expect(subtitle(page)).toContainText("3 test cases");
    await expect(pagination(page)).toContainText("3 results");
  });

  test("TCR-02 deleting one test case decrements every counter", { tag: '@tesbo.testId("TES-TC-1073")' }, async ({ browser }) => {
    const suiteId = await seedSuite(stamp("DeleteOneSuite"));
    const titles = [stamp("DelA"), stamp("DelB"), stamp("DelC")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);
    await expect(pagination(page)).toContainText("3 results");

    await bulkDelete(page, [titles[0]]);

    // The row goes, and so must every number that described it. The reported bug is precisely that
    // the row disappeared while the counters kept the old figure.
    await expect(row(page, titles[0])).toHaveCount(0);
    await expect(pagination(page)).toContainText("2 results");
    await expect(subtitle(page)).toContainText("2 test cases");
    await expect.poll(() => statCard(page, "Total"), { message: "the TOTAL card follows the delete" }).toBe(2);
    await expect.poll(() => statCard(page, "Approved")).toBe(2);
    expect(storedCaseCount(), "and the screen agrees with the database").toBe(2);
  });

  test("TCR-03 a bulk delete decrements every counter by the number removed", { tag: '@tesbo.testId("TES-TC-1074")' }, async ({ browser }) => {
    const suiteId = await seedSuite(stamp("BulkDeleteSuite"));
    const titles = [stamp("BulkA"), stamp("BulkB"), stamp("BulkC"), stamp("BulkD"), stamp("BulkE")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);
    await expect(pagination(page)).toContainText("5 results");

    await bulkDelete(page, titles.slice(0, 3));

    await expect(pagination(page)).toContainText("2 results");
    await expect(subtitle(page)).toContainText("2 test cases");
    await expect.poll(() => statCard(page, "Total")).toBe(2);
    expect(storedCaseCount()).toBe(2);
    for (const gone of titles.slice(0, 3)) await expect(row(page, gone)).toHaveCount(0);
    for (const kept of titles.slice(3)) await expect(row(page, kept)).toBeVisible();
  });

  test("TCR-04 the suite tree's count follows a delete too", { tag: '@tesbo.testId("TES-TC-1075")' }, async ({ browser }) => {
    const suiteName = stamp("TreeCountSuite");
    const suiteId = await seedSuite(suiteName);
    const titles = [stamp("TreeA"), stamp("TreeB"), stamp("TreeC")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);
    const suiteRow = page.getByRole("button", { name: new RegExp(suiteName) });
    await expect(suiteRow).toContainText("3");

    await bulkDelete(page, [titles[0], titles[1]]);

    // The tree is rendered from a separate fetch to the table's, which is exactly how the two came
    // to disagree in the report.
    await expect
      .poll(async () => (await suiteRow.textContent())?.includes("1"), {
        message: "the suite's own count follows the delete",
      })
      .toBe(true);
    await expect(page.getByText("All test cases").locator("..")).toContainText("1");
  });

  test("TCR-05 the search box offers a control to clear it", { tag: '@tesbo.testId("TES-TC-1076")' }, async ({ browser }) => {
    const titles = [stamp("ClearHit"), stamp("ClearMiss")];
    for (const title of titles) await seedCase(title);

    const page = await openRepository(browser);
    await expect(pagination(page)).toContainText("2 results");

    await searchBox(page).fill(titles[0]);
    await expect(row(page, titles[1])).toHaveCount(0);

    /*
     * The control has to live with the search box and has to be reachable without a keyboard — the
     * reporter's complaint was having to select the text by hand to get back to the full list.
     *
     * Scoped to the search box's own container so the filter chips' X buttons and the bulk bar's
     * "Clear selection" cannot satisfy this by accident: neither empties the search.
     */
    const searchGroup = page.locator("label").filter({ has: searchBox(page) });
    const clearControl = searchGroup
      .getByRole("button")
      .or(searchGroup.locator('[aria-label*="lear" i]'))
      .first();

    await expect(clearControl, "no way to clear the search without editing the text by hand").toBeVisible();

    await clearControl.click();
    await expect(searchBox(page)).toHaveValue("");
    await expect(row(page, titles[1]), "clearing restores the hidden rows").toBeVisible();
    await expect(pagination(page)).toContainText("2 results");
  });

  // ─── The column picker ─────────────────────────────────────────────────────

  test("TCR-06 ID, title and priority cannot be switched off", { tag: '@tesbo.testId("TES-TC-1077")' }, async ({ browser }) => {
    await seedCase(stamp("ColumnsCase"));
    const page = await openRepository(browser);

    // `exact` matters: getByRole name matching is a substring match, and a seeded case titled
    // "E2E ColumnsCase …" makes the row match "Columns" alongside the toolbar control.
    await page.getByRole("button", { name: "Columns", exact: true }).click();

    // The reporter's note names these three: without an ID or a title a row cannot be identified at
    // all, and the screenshot shows a table of bare checkboxes once they are all off.
    for (const label of ["ID", "Test case title", "Priority"]) {
      const checkbox = page.getByRole("checkbox").and(page.locator(`xpath=//label[.//span[text()=${JSON.stringify(label)}]]//input`));
      await expect(checkbox, `${label} should be present in the picker`).toHaveCount(1);
      await expect(checkbox, `${label} must start visible`).toBeChecked();
      await expect(checkbox, `${label} must not be de-selectable`).toBeDisabled();
    }
  });

  test("TCR-07 the table can never be left with no data columns", { tag: '@tesbo.testId("TES-TC-1078")' }, async ({ browser }) => {
    const title = stamp("NoBlankTable");
    await seedCase(title);
    const page = await openRepository(browser);

    // `exact` matters: getByRole name matching is a substring match, and a seeded case titled
    // "E2E ColumnsCase …" makes the row match "Columns" alongside the toolbar control.
    await page.getByRole("button", { name: "Columns", exact: true }).click();

    // Turn off everything the picker will let us turn off.
    const checkboxes = page.getByRole("checkbox", { disabled: false });
    for (let i = (await checkboxes.count()) - 1; i >= 0; i--) {
      const box = checkboxes.nth(i);
      if (await box.isChecked()) await box.uncheck();
    }
    await page.keyboard.press("Escape");

    // Whatever the picker allowed, the row must still identify itself. A table of nothing but
    // selection checkboxes is not a state the user should be able to reach.
    await expect(row(page, title), "the row must still be identifiable").toBeVisible();
    const headers = page.getByRole("columnheader");
    expect(await headers.count(), "at least one data column must survive").toBeGreaterThan(1);
  });

  /*
   * Regression: column order used to be a stored preference (RepositoryTestCaseTable's old
   * `dataOrder`), left over from when headers could be dragged to reorder — a preference saved
   * before Severity/Component existed (or from before drag-reorder was removed entirely) kept its
   * stale order forever, with any newly-added column silently appended at the very end regardless
   * of where the code's own default put it. That's why Severity/Component always trailed after
   * Updated on an existing browser even after the code's default order changed. Order is now fixed
   * in code (DATA_ORDER) and never read from or written to storage, so it can't drift like that.
   */
  test("TCR-20 data columns render in a fixed order regardless of a stale stored preference", async ({ browser }) => {
    await seedCase(stamp("ColumnOrder"));
    const page = await openRepository(browser);

    // A preference saved before Severity/Component existed — exactly the shape that used to freeze
    // the old, incomplete order forever. `dataOrder` is intentionally absent from TablePrefs now,
    // so this stale value must simply be ignored rather than read back.
    await page.evaluate((pid) => {
      window.localStorage.setItem(
        `tesbo-repo-tc-table:v1:${pid}`,
        JSON.stringify({ dataOrder: ["id", "title", "priority", "type", "automation", "status", "updated"] }),
      );
    }, tenant!.mainProjectId);
    await page.reload();

    await page.getByRole("button", { name: "Columns", exact: true }).click();
    for (const label of ["Jira", "Component", "Severity"]) {
      const checkbox = page.getByRole("checkbox").and(page.locator(`xpath=//label[.//span[text()=${JSON.stringify(label)}]]//input`));
      if (!(await checkbox.isChecked())) await checkbox.check();
    }
    await page.keyboard.press("Escape");

    const headers = page.locator("table.tc-repo-table thead tr th");
    // Bulk-select is index 0; Suite stays hidden (only shows with the suite panel collapsed).
    const expectedOrder = [
      "ID",
      "Test case title",
      "Jira",
      "Component",
      "Priority",
      "Severity",
      "Type",
      "Automation Type",
      "Status",
      "Updated",
    ];
    await expect(headers).toHaveCount(expectedOrder.length + 1);
    for (const [i, label] of expectedOrder.entries()) {
      await expect(headers.nth(i + 1), `header ${i + 1} should be "${label}"`).toContainText(label);
    }
  });

  // ─── Cases that belong to no suite ─────────────────────────────────────────

  /*
   * Basecamp 10194323432 / BetterBugs 6a7c1e9d — "DRAFT count not updated after APPROVED", reported
   * against a project whose screen showed "All test cases 1" in the suite panel while the stat cards
   * read TOTAL 50 / DRAFT 24 / APPROVED 26. The Draft number looked invented because the sidebar
   * said the repository held a single case.
   *
   * Neither number was stale. The sidebar badge was `suites.reduce((sum, s) => sum + s.testCaseCount,
   * 0)`, and listSuites counts cases through `t.suite_id = s.id` — so every case with no suite was
   * counted by no suite row, and the badge reported only the cases that happened to be filed. The
   * create form leaves suiteId null by default and import leaves it null when no suite column is
   * mapped, so "most of the repository is unfiled" is the normal case, not a corner one.
   *
   * TCR-08 fails against that code: the badge and the subtitle read 1 instead of 4.
   */
  test("TCR-08 the repository counters include cases that belong to no suite", { tag: '@tesbo.testId("TES-TC-1079")' }, async ({ browser }) => {
    const suiteName = stamp("FiledSuite");
    const suiteId = await seedSuite(suiteName);
    const filed = stamp("Filed");
    await seedCase(filed, { suiteId });
    // Exactly how the create form and a suite-less import leave them.
    const unfiled = [stamp("Unfiled A"), stamp("Unfiled B"), stamp("Unfiled C")];
    for (const title of unfiled) await seedCase(title);

    const stored = storedCaseCount();
    expect(stored, "fixture should hold 1 filed + 3 unfiled cases").toBe(4);

    const page = await openRepository(browser);

    // The suite's own badge is right to say 1 — it holds one case. What must not say 1 is anything
    // claiming to describe the whole repository.
    await expect(
      page.getByText(`${stored} test cases across`),
      "the subtitle must count unfiled cases",
    ).toBeVisible();
    expect(await statCard(page, "Total"), "the Total stat card").toBe(stored);
    await expect(pagination(page).getByText(`${stored} results`)).toBeVisible();

    // The "All test cases" badge: the sidebar button's own trailing count, not the suite's.
    const allCasesBadge = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.trim().startsWith("All test cases"),
      );
      return button?.lastElementChild?.textContent?.trim() ?? "";
    });
    expect(
      Number(allCasesBadge),
      `"All test cases" reported ${allCasesBadge} for a repository holding ${stored}`,
    ).toBe(stored);

    // And every unfiled case is genuinely reachable from that view, so the number is not merely
    // patched to agree while the rows stay hidden.
    for (const title of unfiled) await expect(row(page, title)).toBeVisible();
    await expect(row(page, filed)).toBeVisible();
  });
  /*
   * Basecamp 10212879823 / 10212867874 — the same project that reported "All test cases 26" against a
   * TOTAL of 33. TCR-08 covers the count; this covers reaching the 7 that were missing.
   *
   * Fails against the old screen: there is no "No suites" node at all.
   */
  test("TCR-09 a No suites node lists the cases that belong to no suite", { tag: '@tesbo.testId("TES-TC-1080")' }, async ({ browser }) => {
    const suiteName = stamp("FiledSuite");
    const suiteId = await seedSuite(suiteName);
    const filed = stamp("Filed");
    await seedCase(filed, { suiteId });
    const unfiled = [stamp("Unfiled A"), stamp("Unfiled B")];
    for (const title of unfiled) await seedCase(title);

    const page = await openRepository(browser);

    const noSuites = page.getByRole("button", { name: /No suites/ });
    await expect(noSuites, "the suite tree offers no way to reach unfiled cases").toBeVisible();
    await expect(noSuites, "the node should count the 2 unfiled cases").toContainText("2");

    await noSuites.click();

    // Only the unfiled cases, and the filed one is gone — the node filters rather than just counting.
    for (const title of unfiled) await expect(row(page, title)).toBeVisible();
    await expect(row(page, filed), "a filed case appeared under No suites").toHaveCount(0);
    await expect(pagination(page).getByText("2 results")).toBeVisible();

    // The view names itself rather than showing a bare "Suite" chip.
    await expect(page.getByText("No suites").last()).toBeVisible();

    // The stat cards stay project-wide — they describe the repository, not the current node.
    expect(await statCard(page, "Total"), "the Total card must not follow the node filter").toBe(
      storedCaseCount(),
    );
  });

  test("TCR-10 the No suites node disappears once every case is filed", { tag: '@tesbo.testId("TES-TC-1081")' }, async ({ browser }) => {
    // The node is only meaningful when something is unfiled; a tidy project should not gain an
    // empty row in its tree.
    const suiteId = await seedSuite(stamp("AllFiledSuite"));
    const title = stamp("AllFiled");
    await seedCase(title, { suiteId });

    const page = await openRepository(browser);
    await expect(row(page, title)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /No suites/ }),
      "a project with nothing unfiled should show no No suites node",
    ).toHaveCount(0);
  });
  /*
   * Basecamp 10212766570 — the screen half. Archived cases are out of the default list now, so the
   * screen must say so (the DEPRECATED tile still counts them, and an unexplained "33 test cases"
   * above "30 results" is the same count confusion this screen was already reported for), and an
   * archived row must not look like a live one when it IS shown.
   */
  test("TCR-11 archived cases are hidden by default, disclosed, and marked when shown", { tag: '@tesbo.testId("TES-TC-1082")' }, async ({
    browser,
  }) => {
    const liveTitle = stamp("Live case");
    const archivedTitle = stamp("Archived case");
    await seedCase(liveTitle);
    await seedCase(archivedTitle, { status: "Archived" });

    const page = await openRepository(browser);

    // Hidden by default, and the footer agrees with the rows on screen.
    await expect(row(page, liveTitle)).toBeVisible();
    await expect(row(page, archivedTitle), "an archived case is in the default list").toHaveCount(0);
    await expect(pagination(page).getByText("1 result")).toBeVisible();

    // Disclosed rather than silently dropped, and the chip says how many.
    const chip = page.getByTestId("archived-hidden-chip");
    await expect(chip, "nothing tells the user archived cases are being hidden").toBeVisible();
    await expect(chip).toContainText("1");

    // The DEPRECATED tile still counts it, so the repository's own accounting is unchanged.
    expect(await statCard(page, "Deprecated"), "the Deprecated tile lost the archived case").toBe(1);

    // The chip reveals them, and the archived row is visibly distinct from a live one.
    await chip.click();
    await expect(row(page, archivedTitle)).toBeVisible();
    await expect(row(page, liveTitle), "the Archived filter should show only archived").toHaveCount(0);
    const archivedRow = page.locator('tr[data-archived="true"]');
    await expect(archivedRow, "an archived row is not marked as archived").toHaveCount(1);
    await expect(archivedRow).toContainText(archivedTitle);
  });
  /*
   * Basecamp 10194318194 — filed as the question "Can we move Priority and Automation Type
   * separately", against Test case > Select all > Bulk action.
   *
   * Underneath the ask was silent data loss. The three selects opened pre-set to Draft / P2 / Not
   * Automated and ALL THREE were always sent, so changing only Priority also reset every selected
   * case's Status to Draft and its Automation to Not Automated. On a 25-case selection that is 50
   * fields overwritten to answer one question — and it manufactures Drafts nobody asked for, which is
   * its own reporting confusion.
   *
   * Each field now defaults to "Leave unchanged" and only chosen fields are sent (the API already
   * COALESCEs an omitted one). TCR-12 fails against the old modal: the untouched fields come back
   * rewritten.
   */
  test("TCR-12 a bulk edit changes only the field that was set, leaving the others alone", { tag: '@tesbo.testId("TES-TC-1083")' }, async ({
    browser,
  }) => {
    const title = stamp("BulkScoped");
    // Deliberately none of the old defaults, so any overwrite is unmistakable.
    await seedCase(title, { status: "Approved", priority: "P0", automationStatus: "Automated" });

    const page = await openRepository(browser);
    await expect(row(page, title)).toBeVisible();

    await page.getByRole("row").filter({ hasText: title }).getByRole("checkbox").first().check();
    await expect(page.getByText("1 selected")).toBeVisible();
    await page.getByRole("button", { name: "Bulk actions" }).click();
    await page.getByRole("combobox").filter({ hasText: /Select an action/ }).selectOption("update");

    // Every field starts on "Leave unchanged" — the old modal pre-selected real values here, which is
    // what made an accidental overwrite the default behaviour rather than an opt-in.
    const selects = page.getByRole("combobox");
    const statusSelect = selects.nth(1);
    const prioritySelect = selects.nth(2);
    const automationSelect = selects.nth(3);
    for (const [field, select] of [
      ["Status", statusSelect],
      ["Priority", prioritySelect],
      ["Automation Type", automationSelect],
    ] as const) {
      expect(
        await select.inputValue(),
        `${field} does not default to "Leave unchanged" — an untouched field will be written`,
      ).toBe("");
    }

    // Change Priority only, which is exactly what the reporter wanted to do.
    await prioritySelect.selectOption("P1");
    await page.getByRole("button", { name: "Confirm" }).click();

    // Priority moved...
    await expect(page.getByRole("row").filter({ hasText: title })).toContainText("P1");

    // ...and nothing else did. Asserted against the API, not the row, so a stale render cannot pass it.
    const listed = await api.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      params: { search: title, limit: 10 },
      failOnStatusCode: false,
    });
    expect(listed.ok()).toBeTruthy();
    const updated = (await listed.json())[0];
    expect(updated, "the case vanished from the list").toBeTruthy();
    expect(updated.priority, "the field that was chosen should have changed").toBe("P1");
    expect(updated.status, "Status was overwritten by a bulk edit that never touched it").toBe("Approved");
    expect(
      updated.automationStatus,
      "Automation Type was overwritten by a bulk edit that never touched it",
    ).toBe("Automated");
  });

  test("TCR-13 a bulk edit can still set several fields at once when they are chosen", { tag: '@tesbo.testId("TES-TC-1084")' }, async ({
    browser,
  }) => {
    // The opt-in default must not have cost the ability to change more than one field deliberately.
    const title = stamp("BulkMulti");
    await seedCase(title, { status: "Approved", priority: "P0", automationStatus: "Automated" });

    const page = await openRepository(browser);
    await page.getByRole("row").filter({ hasText: title }).getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Bulk actions" }).click();
    await page.getByRole("combobox").filter({ hasText: /Select an action/ }).selectOption("update");

    const selects = page.getByRole("combobox");
    await selects.nth(1).selectOption("Deprecated");
    await selects.nth(2).selectOption("P2");
    await page.getByRole("button", { name: "Confirm" }).click();

    const listed = await api.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      params: { search: title, limit: 10, includeArchived: "true" },
      failOnStatusCode: false,
    });
    const updated = (await listed.json())[0];
    expect(updated.status).toBe("Deprecated");
    expect(updated.priority).toBe("P2");
    // The one left alone is still untouched.
    expect(updated.automationStatus).toBe("Automated");
  });

  // ─── Parent suites roll up their sub-suites' test cases ────────────────────
  /*
   * Reported bug: "Parent suits not showing test cases even though sub suite has test cases".
   * Repro: a parent suite ("test case Import test", badge 86) shows "No test cases found" when
   * selected directly, while its child ("Activity", badge 86) shows all 86 when selected. Expected:
   * selecting a suite shows every case filed anywhere in its subtree, not only a case whose suite_id
   * literally equals the selected id.
   *
   * Fails against the old screen: listTestCases matched `suite_id = $n` exactly, and the sidebar
   * badge was a client-side, one-level-only sum computed from the same direct-only counts — so a
   * parent whose cases live entirely on its child showed 0 in both the table and (for a 3rd level,
   * not reachable through this 2-level tree widget) potentially the badge too.
   *
   * No @tesbo.testId tag: new coverage, no matching case in the live Tesbo project yet.
   */
  test("TCR-14 selecting a parent suite shows its child suite's test cases", async ({ browser }) => {
    const parentName = stamp("ParentSuite");
    const childName = stamp("ChildSuite");
    const parentId = await seedSuite(parentName);
    const childId = await seedSuite(childName, parentId);
    const titles = [stamp("RollupA"), stamp("RollupB")];
    for (const title of titles) await seedCase(title, { suiteId: childId });

    const page = await openRepository(browser);

    // The parent's own sidebar badge already rolls up its child's cases — this is the number the
    // report's screenshot showed as "86" while the list beneath it read "No test cases found".
    const parentRow = page.getByRole("button", { name: new RegExp(parentName) });
    await expect(parentRow, "the parent's sidebar badge must include its child's cases").toContainText("2");

    // Selecting the PARENT — not the child — is the exact reported repro.
    await parentRow.click();
    for (const title of titles) {
      await expect(row(page, title), "a child suite's case is missing from its parent's list").toBeVisible();
    }
    await expect(pagination(page)).toContainText("2 results");

    // The child, selected directly, still shows exactly its own cases — the already-working path
    // this fix must not disturb.
    await page.getByTestId(`suite-expand-${parentId}`).click();
    const childRow = page.getByRole("button", { name: new RegExp(childName) });
    await childRow.click();
    for (const title of titles) await expect(row(page, title)).toBeVisible();
    await expect(pagination(page)).toContainText("2 results");
  });

  test("TCR-15 a suite with no cases of its own, only a child's, is the exact reported repro", async ({ browser }) => {
    // Same shape as TCR-14 but named for the precise complaint: the parent has ZERO direct cases —
    // every one of them lives on the child — which is what made "No test cases found" so misleading
    // (the parent looked empty, not merely under-counted).
    const parentName = stamp("EmptyParent");
    const childName = stamp("OnlyChild");
    const parentId = await seedSuite(parentName);
    const childId = await seedSuite(childName, parentId);
    const title = stamp("OnlyOnChild");
    await seedCase(title, { suiteId: childId });

    const page = await openRepository(browser);
    await page.getByRole("button", { name: new RegExp(parentName) }).click();

    await expect(row(page, title), "the parent showed no cases though its child has one").toBeVisible();
    await expect(pagination(page)).toContainText("1 result");
  });

  /*
   * "Select all N matching" (selectAllMatchingCases, page.tsx) re-fetches with the SAME suite
   * filter as the table it's paging through, to reach rows beyond the loaded page. It has to carry
   * includeDescendants exactly like the table fetch does — the bug this catches: the button offers
   * "Select all 3 matching" (suiteCasesTotal, from the now-fixed recursive fetch) but its own fetch
   * quietly used the old exact-match filter, found zero of the parent's (all on the child) cases,
   * and silently selected nothing at all.
   */
  test("TCR-16 'Select all N matching' reaches a parent suite's descendant cases too", async ({ browser }) => {
    const parentName = stamp("SelectAllParent");
    const childName = stamp("SelectAllChild");
    const parentId = await seedSuite(parentName);
    const childId = await seedSuite(childName, parentId);
    const titles = [stamp("SelAllA"), stamp("SelAllB"), stamp("SelAllC")];
    for (const title of titles) await seedCase(title, { suiteId: childId });

    const page = await openRepository(browser);
    await page.getByRole("button", { name: new RegExp(parentName) }).click();
    for (const title of titles) await expect(row(page, title)).toBeVisible();

    // Select just one row by hand, so "Select all N matching" (which only appears while the
    // selection is smaller than the total) has something to expand.
    await page.getByRole("row").filter({ hasText: titles[0] }).getByRole("checkbox").first().check();
    await expect(page.getByText("1 selected")).toBeVisible();

    const selectAllLink = page.getByTestId("select-all-matching");
    await expect(selectAllLink, "the link should offer to reach all 3 matching cases").toContainText("3");
    await selectAllLink.click();
    await expect(
      page.getByText("3 selected"),
      "selecting all matching must reach the child's cases, not silently select none",
    ).toBeVisible();

    await page.getByRole("button", { name: "Bulk actions" }).click();
    await page.getByRole("combobox").filter({ hasText: /Select an action/ }).selectOption("delete");
    await expect(page.getByText(/permanently deletes the selected test cases/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();

    for (const title of titles) await expect(row(page, title)).toHaveCount(0);
    await expect.poll(() => storedCaseCount(), { message: "all 3 must actually be deleted, not just deselected" }).toBe(0);
  });

  /*
   * suiteNameMap (page.tsx) used to prepend only one level of parent name ("Parent / Child"). That
   * was invisible for a 3rd level because a grandchild's case could never appear while browsing an
   * ancestor at all — the parent-suite rollup bug meant the row itself never showed up. Now that
   * fetch is recursive, such a row reaches this table for the first time, and a one-level label
   * would silently read "Child / Grandchild" — missing "Root /" — as if it belonged one level
   * higher than it does.
   */
  test("TCR-17 the Suite column shows the full ancestor path for a case nested three levels deep", async ({
    browser,
  }) => {
    const rootName = stamp("PathRoot");
    const childName = stamp("PathChild");
    const grandchildName = stamp("PathGrandchild");
    const rootId = await seedSuite(rootName);
    const childId = await seedSuite(childName, rootId);
    const grandchildId = await seedSuite(grandchildName, childId);
    const title = stamp("DeepCase");
    await seedCase(title, { suiteId: grandchildId });

    const page = await openRepository(browser);

    // The tree widget only ever renders 2 levels, so the root is the only way to reach this case at
    // all — exactly what the parent-suite rollup fix made newly reachable.
    await page.getByRole("button", { name: new RegExp(rootName) }).click();
    await expect(row(page, title), "the root should show its grandchild's case").toBeVisible();

    // Suite is hidden by default (RepositoryTestCaseTable's DEFAULT_VISIBLE) — show it.
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const suiteCheckbox = page
      .getByRole("checkbox")
      .and(page.locator(`xpath=//label[.//span[text()="Suite"]]//input`));
    await suiteCheckbox.check();
    await page.keyboard.press("Escape");

    const targetRow = page.getByRole("row").filter({ hasText: title });
    await expect(
      targetRow,
      "the Suite column truncated to one level, dropping the root",
    ).toContainText(`${rootName} / ${childName} / ${grandchildName}`);
  });

  // ─── Export scopes to the selected suite ────────────────────────────────────
  /*
   * Basecamp-style report: "Exporting a specific suite exports all test cases" — selecting a suite in
   * this tree and clicking Export downloaded the whole project regardless. testcases/page.tsx's
   * "Export as CSV"/"Export as Excel" links were built from getExportUrl(projectId, format) alone,
   * with no suiteId (or any other active filter) in the URL at all, so the backend had nothing to
   * filter by even once it gained the ability to. Fixed by threading the same suite/filter state the
   * on-screen table already fetches with into the export link. The actual file contents (does the
   * backend really honor the query param) are covered at the API level in
   * e2e/api/import-export.spec.ts; this proves the UI link itself carries the selected suite, which
   * is the half of the regression that lived entirely in the frontend.
   */
  test("TCR-18 the Export menu links carry the selected suite, not just the project", async ({ browser }) => {
    const suiteName = stamp("ExportSuite");
    const suiteId = await seedSuite(suiteName);
    const inSuite = stamp("ExportInSuite");
    await seedCase(inSuite, { suiteId });
    const outsideSuite = stamp("ExportOutside");
    await seedCase(outsideSuite);

    const page = await openRepository(browser);

    // Before selecting a suite, the export links carry no suiteId — the "All test cases" export is
    // unchanged.
    await page.getByRole("button", { name: "Export" }).click();
    const unfilteredCsvHref = await page.getByRole("link", { name: "Export as CSV" }).getAttribute("href");
    expect(unfilteredCsvHref, "the whole-project export must not carry a suiteId").not.toContain("suiteId=");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: new RegExp(suiteName) }).click();
    await expect(row(page, inSuite)).toBeVisible();

    await page.getByRole("button", { name: "Export" }).click();
    const csvHref = await page.getByRole("link", { name: "Export as CSV" }).getAttribute("href");
    expect(
      csvHref,
      "the export link must carry the selected suite, not silently export the whole project",
    ).toContain(`suiteId=${suiteId}`);

    const xlsxHref = await page.getByRole("link", { name: "Export as Excel" }).getAttribute("href");
    expect(xlsxHref).toContain(`suiteId=${suiteId}`);
  });

  /*
   * Basecamp-style report: "[Test Cases] Exported Test Cases Lose Their Original Sequence" —
   * export always sorted by most-recently-updated regardless of the repository table's own order,
   * so editing an old case moved it to the top of the export without moving it on screen. Fixed by
   * having export share the table's own order-by logic (LegacyService.buildTestcaseOrderBySql) and
   * having the frontend's Export links carry the table's active column sort
   * (currentTestCaseExportFilters in testcases/page.tsx), the same way TCR-18 covers the suite
   * filter. Whether a sorted export's ROWS actually come back in that order is covered at the API
   * level in e2e/api/import-export.spec.ts; this proves the link the UI builds carries the sort.
   */
  test("TCR-19 the Export menu links carry the repository table's active column sort", async ({ browser }) => {
    await seedCase(stamp("SortLink"));
    const page = await openRepository(browser);

    await page.getByRole("button", { name: "Sort by Test case title" }).click();

    await page.getByRole("button", { name: "Export" }).click();
    const csvHref = await page.getByRole("link", { name: "Export as CSV" }).getAttribute("href");
    expect(csvHref, "the export link must carry the table's active sort column").toContain("sortBy=title");
    expect(csvHref, "…and its direction").toContain("sortDir=asc");

    const xlsxHref = await page.getByRole("link", { name: "Export as Excel" }).getAttribute("href");
    expect(xlsxHref).toContain("sortBy=title");
    expect(xlsxHref).toContain("sortDir=asc");
  });
});
