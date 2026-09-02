import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The knowledge base screens: the browser at /projects/:id/knowledge-base and the document editor
 * at /knowledge-base/documents/:documentId.
 *
 * What earns a browser here, over the 107 API tests in knowledge-base/kb-files/kb-comments: the API
 * decides what is *allowed*, the screen decides what is *offered* and what it does with a refusal.
 * Three things only a browser sees —
 *
 *   1. The page has NO role gate. Unlike the custom fields settings screen (which derives canManage
 *      from project membership), this one renders every control for everybody and lets the API say
 *      no. So "what does a qa_engineer see, and what happens when they click it" is a real question
 *      with a real answer, and KBU-20/21 pin it.
 *   2. Delete goes through window.confirm(), a native dialog Playwright must be told to handle.
 *      Cancelling it must leave the row alone — a bug that would look identical to a working delete
 *      in any API test.
 *   3. There is no trash UI at all. Delete moves items to trash and the restore endpoints exist and
 *      are owner-or-manager gated, but nothing in the app can reach them. KBU-24 pins that gap so it
 *      stays a deliberate product decision rather than something nobody noticed.
 *
 * Runs against its own disposable workspace ("kb-ui"). Every test starts from an empty knowledge
 * base — the summary counters are absolute numbers, so one leftover folder turns a correct product
 * into a red test in whichever spec happens to run first.
 *
 * Locator notes, all three learned the hard way against the real DOM:
 *
 *   - `Modal` (components/ui/Modal.tsx) renders `role="presentation"`, NOT `role="dialog"`, through a
 *     portal, with its title as an `h2`. `modal()` below scopes to it by that heading.
 *   - `FieldLabel` is a bare `<label>` with no `htmlFor`, so getByLabel() resolves nothing anywhere
 *     on this screen. Inputs are located by placeholder instead.
 *   - "Knowledge base" is BOTH the page `h1` and the root folder's `h2`, so every heading lookup
 *     here needs an explicit level.
 */

test.describe("knowledge base (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  let rootFolderId = "";
  const states = new Map<string, string>();
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("kb-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    states.set("owner", await writeStorageState(tenant.owner, "kb-ui-owner"));
    states.set("qa", await writeStorageState(tenant.qa, "kb-ui-qa"));
    states.set("guest", await writeStorageState(tenant.guest, "kb-ui-guest"));

    purgeKb(tenant);
    const tree = await api.get(kbUrl("/folders/tree"));
    expect(tree.status(), `resolving the KB root folder — ${await tree.text()}`).toBe(200);
    rootFolderId = (await tree.json()).id;
  });

  test.afterAll(async () => {
    if (tenant) purgeKb(tenant);
    if (api) await api.dispose();
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purgeKb(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function kbUrl(suffix: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/knowledge-base${suffix}`;
  }

  function purgeKb(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(
      `DELETE FROM knowledge_document_versions WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id IN (${projects}));`,
    );
    exec(`DELETE FROM knowledge_document_comments WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_files WHERE project_id IN (${projects});`);
    // The root is kept: `is_root` rows are only ever written by project creation, so deleting one
    // makes the whole knowledge base unreachable for the rest of the run.
    exec(`DELETE FROM knowledge_folders WHERE project_id IN (${projects}) AND is_root = false;`);
  }

  /** Stamped so a re-run against the persistent volume can't collide on the unique name index. */
  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function openKb(browser: Browser, as: "owner" | "qa" | "guest" = "owner"): Promise<Page> {
    const ctx = await browser.newContext({ storageState: states.get(as) });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base`);
    await expect(page.getByRole("heading", { name: "Knowledge base", level: 1 })).toBeVisible();
    return page;
  }

  /** The panel of an open Modal, scoped by its `h2` title — there is no role="dialog" to use. */
  function modal(page: Page, title: string): Locator {
    return page
      .locator('div[role="presentation"]')
      .filter({ has: page.getByRole("heading", { name: title, level: 2 }) })
      .last();
  }

  /** The item table's row for a named folder/document/file. */
  function row(page: Page, name: string): Locator {
    return page.getByRole("row").filter({ hasText: name });
  }

  /** The row-action (⋯) trigger. The Actions cell nests a button inside a button. */
  function rowMenu(page: Page, name: string): Locator {
    return row(page, name).getByRole("cell").last().getByRole("button").first();
  }

  /**
   * The open dropdown's panel.
   *
   * Menu (components/knowledge-base/Menu.tsx) portals to document.body and positions itself with an
   * INLINE `position: fixed` so it is never clipped by the table's overflow wrapper. Modal portals
   * to body too, but positions itself with a class — so the inline style is what tells the two
   * apart, and scoping to it is what stops a menu item from colliding with an identically-named
   * button elsewhere ("Create folder" is a MenuItem, the empty state's call to action, AND the
   * create modal's submit button).
   */
  function menuPanel(page: Page): Locator {
    return page.locator('body > div[style*="position: fixed"]');
  }

  /** Opens the "New" menu and picks one of its three entries. */
  async function newMenu(page: Page, item: "Create folder" | "Create document" | "Upload file") {
    // The trigger nests a button inside a button, so the name matches twice.
    await page.getByRole("button", { name: "New", exact: true }).first().click();
    await menuPanel(page).getByRole("button", { name: item, exact: true }).click();
  }

  /**
   * The folder tree's own row, by its visible name — distinct from the item table's `row()`.
   * Rename and Move are only offered from this row's ⋯ menu (components/knowledge-base/FolderTree.tsx),
   * not from the table.
   */
  function treeRow(page: Page, name: string): Locator {
    return page.locator('div[role="button"]').filter({ hasText: name }).first();
  }

  /** Opens a tree row's ⋯ menu and picks one of its entries. */
  async function openTreeMenu(page: Page, folderName: string, action: "Create subfolder" | "Rename" | "Move" | "Delete") {
    // `.last()` because a folder with children also renders a leading expand/collapse chevron
    // button — the ⋯ trigger (with its IconDots svg) is always the last real <button> in the row.
    await treeRow(page, folderName).locator("button:has(svg)").last().click();
    await menuPanel(page).getByRole("button", { name: action, exact: true }).click();
  }

  /**
   * The floating error toast (fixed + high z-index so it stacks above an open Modal, which portals
   * its own overlay at z-50 — see the `error` state's render in page.tsx). Scoped away from a
   * modal's own inline FieldError, which shares the same `role="alert"` but renders inside the
   * dialog panel instead.
   */
  function errorToast(page: Page): Locator {
    return page.locator(".fixed.bottom-5.right-5[role=\"alert\"]");
  }

  async function createFolder(page: Page, name: string) {
    await newMenu(page, "Create folder");
    const dialog = modal(page, "Create folder");
    await dialog.getByPlaceholder("e.g. Payment Module").fill(name);
    await dialog.getByRole("button", { name: "Create folder" }).click();
  }

  function folderCount(): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_root = false AND is_deleted = false;`,
      ),
    );
  }

  function documentCount(): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND is_deleted = false;`,
      ),
    );
  }

  /**
   * A mirrored (Jira/Linear) document exactly as a real sync would leave it — seeded directly since
   * producing one for real means a live Jira/Linear call, which this suite cannot make (see
   * api/integrations.spec.ts's file-level note). `createdAt`/`updatedAt` are given explicit,
   * distinct values so "Added on" and "Last updated" can be told apart in the rendered table instead
   * of both coincidentally reading "Today".
   */
  function seedMirrorDocument(title: string, externalId: string, createdDaysAgo: number, updatedDaysAgo: number): string {
    exec(
      "INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, content_html, " +
        "document_type, status, source_provider, source_external_id, source_role, is_read_only, created_at, updated_at) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, ${literal(rootFolderId)}, ${literal(title)}, ` +
        "'seeded by the e2e suite', '<p>seeded by the e2e suite</p>', 'requirement_note', 'published', 'jira', " +
        `${literal(externalId)}, 'mirror', true, now() - interval '${createdDaysAgo} days', now() - interval '${updatedDaysAgo} days');`,
    );
    return scalar(
      `SELECT id FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND source_external_id = ${literal(externalId)} AND source_role = 'mirror';`,
    );
  }

  function seedSyncEvent(documentId: string, eventType: "created" | "updated", changedSummary: string | null): void {
    exec(
      "INSERT INTO knowledge_document_sync_events (document_id, provider, event_type, changed_summary) VALUES (" +
        `${literal(documentId)}, 'jira', ${literal(eventType)}, ${changedSummary === null ? "NULL" : literal(changedSummary)});`,
    );
  }

  /** The row's info-icon trigger (Change history) — present only on a synced (mirror) row. */
  function changeHistoryTrigger(page: Page, name: string): Locator {
    return row(page, name).getByRole("button", { name: "Change history" });
  }

  // ─── The primary flow ──────────────────────────────────────────────────────

  test("KBU-01 a folder is created from the New menu and appears in the table and the tree", { tag: '@tesbo.testId("TES-TC-1000")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    const name = stamp("Folder");

    await createFolder(page, name);

    // User-visible outcome first...
    await expect(row(page, name)).toBeVisible();
    // ...then the persisted state, which is what the next page load will read.
    expect(folderCount()).toBe(1);

    // And the tree in the left sidebar, which is a separate render from the table.
    await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible();
  });

  test("KBU-02 a document created from a template is stored with the template's body", { tag: '@tesbo.testId("TES-TC-1001")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    const title = stamp("Doc");

    await newMenu(page, "Create document");
    const dialog = modal(page, "Create document");
    await dialog.getByPlaceholder("e.g. Login Requirements").fill(title);
    // "Test Plan" is one of the six DOCUMENT_TEMPLATES. A template is the difference between a
    // document with real contentHtml and an empty one, and contentText is what search reads.
    await dialog.getByRole("button", { name: /Test Plan/ }).click();
    await dialog.getByRole("button", { name: "Create document" }).click();

    // Creating a document does not drop you back on the table — it opens the new document straight
    // away, which is the point of picking a template. Assert where the user actually lands.
    await expect(page).toHaveURL(/\/knowledge-base\/documents\/[0-9a-f-]{36}$/);
    // The title is an editable field on this screen, not a heading.
    await expect(page.getByPlaceholder("Untitled document")).toHaveValue(title);
    // The template's headings are in the editor, not left for the user to type.
    await expect(page.locator(".ProseMirror").first()).toContainText("Test Strategy");

    expect(documentCount()).toBe(1);

    // And it is in the table once you go back.
    await page.getByRole("link", { name: /Back to Knowledge base/ }).click();
    await expect(row(page, title)).toBeVisible();

    const body = scalar(
      `SELECT COALESCE(content_text, '') FROM knowledge_documents WHERE project_id = ${literal(tenant!.mainProjectId)} AND title = ${literal(title)};`,
    );
    expect(body.trim(), "a templated document is created with its body already filled in").not.toBe("");
  });

  test("KBU-03 a document is opened, edited, saved, and the change survives a reload", { tag: '@tesbo.testId("TES-TC-1002")' }, async ({ browser }) => {
    const created = await api.post(kbUrl("/documents"), {
      data: { title: stamp("Editable"), folderId: rootFolderId, documentType: "general" },
    });
    expect(created.status()).toBe(201);
    const documentId = (await created.json()).id;

    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${documentId}`);

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible();

    const sentence = `Edited by KBU-03 at ${Date.now()}`;
    await editor.click();
    await page.keyboard.type(sentence);
    await page.getByRole("button", { name: "Save" }).click();

    // Assert on what was persisted, not on the toast: the save is only real if a reload shows it.
    await expect
      .poll(
        () => scalar(`SELECT COALESCE(content_text, '') FROM knowledge_documents WHERE id = ${literal(documentId)};`),
        { message: "the edit reaches the stored document" },
      )
      .toContain(sentence);

    await page.reload();
    await expect(page.locator(".ProseMirror").first()).toContainText(sentence);
  });

  test("KBU-04 an uploaded file appears in the table and is counted in the summary", { tag: '@tesbo.testId("TES-TC-1003")' }, async ({ browser }) => {
    const page = await openKb(browser);
    const fileName = `kbu-04-${Date.now()}.txt`;

    await newMenu(page, "Upload file");
    const dialog = modal(page, "Upload files");
    // The real input is hidden behind a drop zone; setInputFiles drives it directly.
    await dialog.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("KBU-04 upload fixture"),
    });
    await dialog.getByRole("button", { name: /Upload/ }).click();

    await expect(row(page, fileName)).toBeVisible();

    const summary = await (await api.get(kbUrl("/summary"))).json();
    expect(summary.files, "the summary counts the uploaded file").toBe(1);
  });

  // ─── Validation ────────────────────────────────────────────────────────────

  test("KBU-05 the create button stays disabled for an empty or whitespace-only folder name", { tag: '@tesbo.testId("TES-TC-1004")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    await newMenu(page, "Create folder");
    const dialog = modal(page, "Create folder");
    const submit = dialog.getByRole("button", { name: "Create folder" });
    const input = dialog.getByPlaceholder("e.g. Payment Module");

    // The screen's validation here is a disabled control, not an error message — `disabled={!name
    // .trim()}`. Whitespace has to be treated as empty, which is the half a length check misses.
    await expect(submit, "nothing typed yet").toBeDisabled();
    await input.fill("   ");
    await expect(submit, "whitespace is not a name").toBeDisabled();
    await input.fill("real");
    await expect(submit).toBeEnabled();

    await page.keyboard.press("Escape");
    expect(folderCount(), "no folder was created while proving the control is gated").toBe(0);
  });

  test("KBU-06 two folders cannot share a name under the same parent, but can under different ones", async ({
    browser,
  }) => {
    const page = await openKb(browser);
    const shared = stamp("Shared");

    await createFolder(page, shared);
    await expect(row(page, shared)).toBeVisible();

    // Same name, same parent — the API refuses, and no second row may appear. The refusal names
    // the exact field just submitted, so it must land inline next to "Folder name" in the dialog
    // that is still open — not as the page-level toast, which the dialog's own overlay would hide
    // from view while it's up.
    await createFolder(page, shared);
    const dialog = modal(page, "Create folder");
    await expect(dialog, "the dialog stays open so the inline error is visible").toBeVisible();
    await expect(dialog.getByText(/a folder with this name already exists/i)).toBeVisible();
    await expect(errorToast(page), "a field-specific error must not also surface as a toast").toHaveCount(0);
    await expect
      .poll(() => folderCount(), { message: "a duplicate name under the same parent is refused" })
      .toBe(1);
    await page.keyboard.press("Escape");

    // The same name under a different parent is legitimate.
    const other = await api.post(kbUrl("/folders"), {
      data: { name: stamp("Other"), parentFolderId: rootFolderId },
    });
    const otherId = (await other.json()).id;
    const nested = await api.post(kbUrl("/folders"), { data: { name: shared, parentFolderId: otherId } });
    expect(nested.status(), "the same name under a different parent is allowed").toBe(201);
  });

  test("KBU-07 the create button stays disabled for an empty or whitespace-only document title", { tag: '@tesbo.testId("TES-TC-1005")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    await newMenu(page, "Create document");
    const dialog = modal(page, "Create document");
    const submit = dialog.getByRole("button", { name: "Create document" });
    const input = dialog.getByPlaceholder("e.g. Login Requirements");

    await expect(submit).toBeDisabled();
    await input.fill("   ");
    await expect(submit, "whitespace is not a title").toBeDisabled();

    await page.keyboard.press("Escape");
    expect(documentCount()).toBe(0);
  });

  // ─── Delete, and the native confirm ────────────────────────────────────────

  test("KBU-08 cancelling the delete confirmation leaves the item alone", { tag: '@tesbo.testId("TES-TC-1006")' }, async ({ browser }) => {
    const page = await openKb(browser);
    const name = stamp("Keep");
    await createFolder(page, name);
    await expect(row(page, name)).toBeVisible();

    // Delete goes through window.confirm(). Playwright auto-dismisses dialogs by default, but the
    // dismissal is the behaviour under test, so it is handled explicitly and its text asserted.
    let message = "";
    page.once("dialog", (dialog) => {
      message = dialog.message();
      void dialog.dismiss();
    });

    await rowMenu(page, name).click();
    await menuPanel(page).getByRole("button", { name: "Delete", exact: true }).click();

    // Polled, not read straight after the click: confirmFolderDelete asks the API what is in the
    // folder before it can word the message, so the dialog fires a round trip later.
    await expect
      .poll(() => message, { message: "the user is told where the item goes" })
      .toContain("trash");
    await expect(row(page, name)).toBeVisible();
    expect(folderCount(), "dismissing the confirm must not delete anything").toBe(1);
  });

  test("KBU-09 accepting the confirmation soft-deletes the item and drops it from the table", { tag: '@tesbo.testId("TES-TC-1007")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    const name = stamp("Doomed");
    await createFolder(page, name);
    await expect(row(page, name)).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await rowMenu(page, name).click();
    await menuPanel(page).getByRole("button", { name: "Delete", exact: true }).click();

    await expect(row(page, name)).toHaveCount(0);

    // Soft delete, not a hard one: the row survives with is_deleted set, which is what makes the
    // (UI-less) restore endpoint in KBU-24 meaningful.
    await expect
      .poll(
        () =>
          scalar(
            `SELECT COALESCE(is_deleted::text, '') FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = ${literal(name)};`,
          ),
        { message: "delete is a soft delete" },
      )
      .toBe("true");
  });

  /*
   * The delete confirmation has to describe what will happen to THIS folder.
   *
   * Both halves of this were product bugs, in opposite directions. The folder tree claimed "this
   * folder contains documents/files" unconditionally, so an empty folder warned about contents that
   * did not exist; and the table's row menu never mentioned contents at all, so deleting a full
   * folder gave no hint that everything inside went with it. Two tests, because a fix that only
   * addresses one direction is still wrong.
   */
  test("KBU-10 deleting a folder with contents warns that the contents go too", { tag: '@tesbo.testId("TES-TC-1008")' }, async ({ browser }) => {
    const parent = stamp("Parent");
    const folder = await api.post(kbUrl("/folders"), { data: { name: parent, parentFolderId: rootFolderId } });
    const parentId = (await folder.json()).id;
    await api.post(kbUrl("/documents"), {
      data: { title: stamp("Child"), folderId: parentId, documentType: "general" },
    });

    const page = await openKb(browser);

    let message = "";
    page.once("dialog", (dialog) => {
      message = dialog.message();
      void dialog.dismiss();
    });

    await rowMenu(page, parent).click();
    await menuPanel(page).getByRole("button", { name: "Delete", exact: true }).click();

    await expect
      .poll(() => message, { message: "the confirm fires and names the consequence" })
      .toContain("contents");
  });

  test("KBU-10b deleting an EMPTY folder from the tree does not claim it has contents", { tag: '@tesbo.testId("TES-TC-1009")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    const empty = stamp("Empty");
    await createFolder(page, empty);
    await expect(row(page, empty)).toBeVisible();

    let message = "";
    page.once("dialog", (dialog) => {
      message = dialog.message();
      void dialog.dismiss();
    });

    // Driven through the FOLDER TREE, not the row menu — deliberately. This is the path that used to
    // assert "This folder contains documents/files" unconditionally, so an empty folder was warned
    // about contents it did not have. Running it through the row menu instead would pass even
    // against the unfixed build and prove nothing.
    const folderTree = page.getByRole("complementary").filter({ hasText: "Folders" });
    const node = folderTree.getByRole("button", { name: empty, exact: true });
    await node.getByRole("button").first().click();
    await menuPanel(page).getByRole("button", { name: "Delete", exact: true }).click();

    await expect.poll(() => message, { message: "the confirm fires" }).not.toBe("");
    expect(message, "an empty folder must not be described as having contents").not.toContain("contents");
  });

  // ─── Browsing: filter, search, empty states ────────────────────────────────

  test("KBU-11 an empty knowledge base renders its zero counts rather than an error", { tag: '@tesbo.testId("TES-TC-1010")' }, async ({ browser }) => {
    const page = await openKb(browser);

    // A fresh project has the root folder and nothing in it. The header states that in words —
    // and the count excludes the root, so an empty knowledge base reads "0 folders", not "1".
    await expect(page.getByText("0 items across 0 folders")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Something went wrong");

    const summary = await (await api.get(kbUrl("/summary"))).json();
    expect(summary.documents).toBe(0);
    expect(summary.files).toBe(0);
  });

  test("KBU-12 the type filter narrows the table to folders or documents", { tag: '@tesbo.testId("TES-TC-1011")' }, async ({ browser }) => {
    const folderName = stamp("FilterFolder");
    const docTitle = stamp("FilterDoc");
    await api.post(kbUrl("/folders"), { data: { name: folderName, parentFolderId: rootFolderId } });
    await api.post(kbUrl("/documents"), {
      data: { title: docTitle, folderId: rootFolderId, documentType: "general" },
    });

    const page = await openKb(browser);
    await expect(row(page, folderName)).toBeVisible();
    await expect(row(page, docTitle)).toBeVisible();

    // Two comboboxes sit side by side — type filter first, sort second.
    const typeFilter = page.getByRole("combobox").first();

    await typeFilter.selectOption({ label: "Folder" });
    await expect(row(page, folderName)).toBeVisible();
    await expect(row(page, docTitle), "a document is not a folder").toHaveCount(0);

    await typeFilter.selectOption({ label: "Document" });
    await expect(row(page, docTitle)).toBeVisible();
    await expect(row(page, folderName)).toHaveCount(0);

    await typeFilter.selectOption({ label: "All types" });
    await expect(row(page, folderName)).toBeVisible();
    await expect(row(page, docTitle)).toBeVisible();
  });

  test("KBU-13 search matches a document's body, not only its title", { tag: '@tesbo.testId("TES-TC-1012")' }, async ({ browser }) => {
    const title = stamp("Findable");
    const needle = `kbu13needle${Date.now()}`;
    const created = await api.post(kbUrl("/documents"), {
      data: { title, folderId: rootFolderId, documentType: "general" },
    });
    const documentId = (await created.json()).id;
    await api.put(kbUrl(`/documents/${documentId}`), {
      data: { contentText: `A body containing ${needle}`, contentHtml: `<p>A body containing ${needle}</p>` },
    });

    // A second document that cannot match, so the assertion proves FILTERING and not merely that a
    // freshly created document is somewhere in the list.
    const decoyTitle = stamp("Unfindable");
    await api.post(kbUrl("/documents"), {
      data: { title: decoyTitle, folderId: rootFolderId, documentType: "general" },
    });

    const page = await openKb(browser);
    await expect(row(page, title)).toBeVisible();
    await expect(row(page, decoyTitle)).toBeVisible();

    // Enter, not fill() alone: this screen's search is a FORM, and searchQuery — the only state the
    // results read — is set in onSubmit. Typing without submitting leaves the unfiltered list on
    // screen, so an assertion that the document is visible would pass without searching at all.
    await page.getByPlaceholder("Search knowledge base…").fill(needle);
    await page.getByPlaceholder("Search knowledge base…").press("Enter");

    // The title does not contain the needle, so a hit proves the body was searched.
    await expect(row(page, title)).toBeVisible();
    await expect(row(page, decoyTitle), "a non-matching document must drop out").toHaveCount(0);
  });

  test("KBU-14 a whitespace-only search term matches nothing rather than everything", { tag: '@tesbo.testId("TES-TC-1013")' }, async ({ browser }) => {
    const present = stamp("Present");
    await api.post(kbUrl("/folders"), { data: { name: present, parentFolderId: rootFolderId } });

    const page = await openKb(browser);
    await expect(row(page, present)).toBeVisible();

    await page.getByPlaceholder("Search knowledge base…").fill("   ");

    // Whitespace is not a query. The risk this pins is the opposite of a crash: silently falling
    // back to "match everything" looks like a working search until someone trusts the result.
    const results = await (await api.get(kbUrl("/search?q=%20%20%20"))).json();
    const rows = Array.isArray(results) ? results : (results.results ?? results.items ?? []);
    expect(rows.length, "an empty search term matches nothing").toBe(0);
  });

  // ─── Authorization, which this page does not gate ──────────────────────────

  test("KBU-20 a qa_engineer is shown the controls and can create — the page has no role gate", { tag: '@tesbo.testId("TES-TC-1014")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser, "qa");

    // Deliberately asserting the current, ungated design rather than a hoped-for one: a project
    // member of any role may create in the knowledge base (the API allows it), so the button being
    // present is correct. KBU-21 covers the account that genuinely cannot.
    await expect(page.getByRole("button", { name: "New", exact: true }).first()).toBeVisible();

    const name = stamp("QaFolder");
    await createFolder(page, name);
    await expect(row(page, name)).toBeVisible();
    expect(folderCount()).toBe(1);
  });

  test("KBU-21 a workspace member with no access to the project cannot use the knowledge base", { tag: '@tesbo.testId("TES-TC-1015")' }, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: states.get("guest") });
    contexts.push(ctx);
    const page = await ctx.newPage();

    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base`);
    await page.waitForLoadState("domcontentloaded");

    // Whatever the screen chooses to render, it must not be a working knowledge base: no create
    // affordance for a project this account is not a member of.
    await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  });

  test("KBU-22 a folder from another project is not reachable through this project's URL", { tag: '@tesbo.testId("TES-TC-1016")' }, async ({
    browser,
  }) => {
    const secondRoot = (await (await api.get(kbUrl("/folders/tree", tenant!.secondProjectId))).json()).id;
    const foreign = await api.post(kbUrl("/folders", tenant!.secondProjectId), {
      data: { name: stamp("Foreign"), parentFolderId: secondRoot },
    });
    expect(foreign.status()).toBe(201);
    const foreignId = (await foreign.json()).id;

    const page = await openKb(browser);
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base?folderId=${foreignId}`);
    await page.waitForLoadState("domcontentloaded");

    // The screen must not render another project's folder, and the endpoint behind it must refuse.
    const items = await api.get(kbUrl(`/folders/${foreignId}/items`), { failOnStatusCode: false });
    expect([403, 404], "a folder from another project is not reachable through this one").toContain(
      items.status(),
    );
  });

  test("KBU-23 a malformed document id in the URL does not throw in the page", { tag: '@tesbo.testId("TES-TC-1017")' }, async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/not-a-uuid`);
    await page.waitForLoadState("domcontentloaded");

    expect(errors, "a URL typo must not throw an uncaught error in the page").toEqual([]);
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  // ─── The gap this suite is here to pin ─────────────────────────────────────

  test("KBU-24 deleted items are unreachable from the UI — restore is API-only", { tag: '@tesbo.testId("TES-TC-1018")' }, async ({ browser }) => {
    const name = stamp("Trashed");
    const created = await api.post(kbUrl("/folders"), { data: { name, parentFolderId: rootFolderId } });
    const folderId = (await created.json()).id;
    await api.delete(kbUrl(`/folders/${folderId}`));

    const page = await openKb(browser);

    // The row is gone from the browser...
    await expect(row(page, name)).toHaveCount(0);
    // ...and nothing on the screen offers a way back to it.
    for (const label of [/^trash$/i, /deleted items/i, /restore/i]) {
      await expect(
        page.getByText(label),
        `the KB screen offers no way to reach deleted items (${label})`,
      ).toHaveCount(0);
    }

    // But the endpoint exists and works, which is what makes this a gap rather than a design.
    const restored = await api.patch(kbUrl(`/folders/${folderId}/restore`));
    expect(restored.status(), "restore works over the API — only the UI cannot reach it").toBe(200);
  });
  // ─── Blank documents (BetterBugs 6a7da01c) ─────────────────────────────────
  //
  // "user should not be able to save blank documents add some validation".
  //
  // KBU-07 already covers the CREATE modal refusing an empty title. These two are about the editor,
  // which is a different code path and currently unguarded: handleTitleChange feeds scheduleSave
  // directly, and scheduleSave's only precondition is a payload size ceiling. So a title can be
  // cleared to nothing and autosaved, and the document then shows as "Untitled" everywhere it is
  // listed. Both tests are expected RED until the editor validates before saving.

  test("KBU-25 a document's title cannot be emptied and saved", { tag: '@tesbo.testId("TES-TC-1019")' }, async ({ browser }) => {
    const title = stamp("KeepsTitle");
    const created = await api.post(kbUrl("/documents"), {
      data: { title, folderId: rootFolderId, documentType: "general" },
    });
    const documentId = (await created.json()).id;

    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${documentId}`);

    const titleBox = page.getByPlaceholder("Untitled document");
    await expect(titleBox).toHaveValue(title);
    await titleBox.fill("");
    await titleBox.blur();

    // The editor autosaves on a debounce, so give it longer than the debounce to do the wrong thing
    // before concluding it did not.
    await expect(page.getByText(/Unsaved changes|Saving…|Saved/)).toBeVisible();
    await page.waitForTimeout(2_000);

    expect(
      scalar(`SELECT title FROM knowledge_documents WHERE id = ${literal(documentId)};`),
      "an emptied title must not be persisted",
    ).toBe(title);
  });

  test("KBU-26 a whitespace-only title is refused the same way an empty one is", { tag: '@tesbo.testId("TES-TC-1020")' }, async ({ browser }) => {
    const title = stamp("WhitespaceTitle");
    const created = await api.post(kbUrl("/documents"), {
      data: { title, folderId: rootFolderId, documentType: "general" },
    });
    const documentId = (await created.json()).id;

    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${documentId}`);

    const titleBox = page.getByPlaceholder("Untitled document");
    await expect(titleBox).toHaveValue(title);
    // Spaces are the loophole an empty-string check alone leaves open — the stored title then looks
    // present to the database and blank to every human reading the list.
    await titleBox.fill("      ");
    await titleBox.blur();
    await page.waitForTimeout(2_000);

    const stored = scalar(`SELECT title FROM knowledge_documents WHERE id = ${literal(documentId)};`);
    expect(stored.trim(), "a whitespace-only title must not be persisted").not.toBe("");
  });

  // ─── Search feedback while typing (BetterBugs 6a7dae14) ────────────────────

  test("KBU-27 search either filters as you type or offers a visible Search control", { tag: '@tesbo.testId("TES-TC-1021")' }, async ({ browser }) => {
    const present = stamp("TypeAheadHit");
    const absent = stamp("TypeAheadMiss");
    for (const name of [present, absent]) {
      await api.post(kbUrl("/folders"), { data: { name, parentFolderId: rootFolderId } });
    }

    const page = await openKb(browser);
    await expect(row(page, present)).toBeVisible();
    await expect(row(page, absent)).toBeVisible();

    // Typed character by character and deliberately NOT submitted.
    await page.getByPlaceholder("Search knowledge base…").pressSequentially(present, { delay: 20 });

    /*
     * The ticket accepts either resolution, so this test does too — it fails only if NEITHER is
     * offered, which is the state the reporter hit: results arrive only on Enter and there is no
     * button saying so, leaving the screen looking broken mid-type.
     *
     * The "Clear" button next to the box does not count: it appears only once a search has already
     * been submitted, so it cannot tell a user how to submit one.
     */
    const filteredAsTyped = await row(page, absent)
      .waitFor({ state: "detached", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);

    const searchControl = page
      .getByRole("button", { name: /^Search$/i })
      .or(page.locator('button[type="submit"]').filter({ hasText: /search/i }));
    const hasSearchButton = await searchControl.first().isVisible().catch(() => false);

    expect(
      filteredAsTyped || hasSearchButton,
      "typing filtered nothing and no Search button was offered — the user cannot tell how to search",
    ).toBe(true);
  });
  // ─── Upload affordances and error copy ─────────────────────────────────────

  /*
   * Basecamp 10199159265 / BetterBugs 6a7da3ff — "Supported file types and maximum file size are not
   * displayed in Knowledge Base upload popup".
   *
   * The modal says only "Drag and drop files here, or click to browse". The rules it does not mention
   * are real and enforced server-side:
   *
   *   - `KB_ALLOWED_EXTENSIONS` — 33 extensions; anything else is refused with
   *     "This file type is not supported: <name>"
   *   - `KB_MAX_UPLOAD_SIZE` — MAX_UPLOAD_SIZE or 100 MB, enforced by FilesInterceptor
   *   - `FilesInterceptor("files", 10)` — at most 10 files per request
   *
   * and the refusal is ATOMIC: one unsupported file in a batch rejects the whole batch. So a user who
   * is not told the rules loses the entire upload to a single wrong file. The `<input type="file">`
   * also carries no `accept`, so the OS picker offers files the product will reject.
   *
   * Expected RED. The assertion is deliberately about the limits being DISCLOSED, not about exact
   * wording — any copy naming the formats and the size satisfies it.
   */
  test("KBU-28 the upload modal states which files are allowed and how large they may be", { tag: '@tesbo.testId("TES-TC-1022")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    await newMenu(page, "Upload file");
    const dialog = modal(page, "Upload file");
    await expect(dialog).toBeVisible();

    const copy = ((await dialog.textContent()) ?? "").toLowerCase();

    // The size ceiling, however it is phrased ("100 MB", "100MB", "max 100 mb").
    expect(copy, "the modal never mentions a maximum file size").toMatch(/\d+\s*(mb|gb)/);

    // A representative sample of the allowed list, so the copy has to actually enumerate formats
    // rather than say "supported files only".
    const named = ["pdf", "docx", "xlsx", "png", "csv"].filter((ext) => copy.includes(ext));
    expect(
      named.length,
      `the modal names none of the supported formats — copy was: ${copy.trim().slice(0, 200)}`,
    ).toBeGreaterThan(0);

    // And the picker itself should not offer what the server will refuse.
    const accept = await dialog.locator('input[type="file"]').getAttribute("accept");
    expect(accept, "the file input has no accept attribute, so the OS picker offers rejected types").toBeTruthy();
  });

  /*
   * Basecamp 10199144861 / BetterBugs 6a7da27f — "Technical API error displayed to user during folder
   * drag-and-drop upload".
   *
   * Dropping a FOLDER yields DataTransfer entries with no readable file, the upload request fails, and
   * the page renders what `lib/api.ts` threw:
   *
   *   "Failed to fetch — browser blocked or could not reach the API. Confirm NEXT_PUBLIC_API_URL,
   *    HTTPS, and that the backend allows this page's origin in CORS_ALLOWED_ORIGINS."
   *
   * That string is a developer diagnostic. It names three environment variables and tells the user to
   * check a CORS allowlist, which is not theirs to check — and because the throw lives in the shared
   * `api()` wrapper, EVERY network failure anywhere in the app shows it, not just this upload.
   *
   * The failure is provoked here by aborting the upload request rather than by dropping a real folder:
   * Playwright cannot synthesise a directory drop, and the defect is not in the folder handling — it
   * is in what the page does with any failed request. Aborting reproduces the exact `Failed to fetch`
   * branch the reporter hit.
   *
   * Expected RED until the diagnostic moves to the console and the user gets plain copy.
   */
  test("KBU-29 a failed upload shows plain copy, not the API/CORS diagnostic", { tag: '@tesbo.testId("TES-TC-1023")' }, async ({ browser }) => {
    const page = await openKb(browser);

    await page.route(/\/knowledge-base\/files/, (route) =>
      route.request().method() === "POST" ? route.abort("failed") : route.continue(),
    );

    await newMenu(page, "Upload file");
    const dialog = modal(page, "Upload file");
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: "kbu29.txt", mimeType: "text/plain", buffer: Buffer.from("KBU-29") });
    await dialog.getByRole("button", { name: /^Upload/ }).click();

    // Something must be said — silence would be its own bug.
    const alert = page.getByText(/fail|error|unable|could not/i).first();
    await expect(alert).toBeVisible();
    const shown = (await page.locator("body").textContent()) ?? "";

    for (const leak of ["NEXT_PUBLIC_API_URL", "CORS_ALLOWED_ORIGINS", "HTTPS", "Failed to fetch"]) {
      expect(shown, `the page showed the internal diagnostic "${leak}" to the user`).not.toContain(leak);
    }
  });

  /*
   * Basecamp 10199215592 / BetterBugs 6a7da94c — "Full folder name is not visible when truncated".
   *
   * Both places a folder name appears clip it with `className="truncate"` and neither carries a
   * `title`: `FolderTree.tsx`'s tree node and the item table's name cell. The reporter asked for a
   * tooltip on hover, which `title` is the accessible, zero-JS way to provide.
   *
   * Expected RED.
   */
  test("KBU-30 a long folder name is readable in full from a tooltip", { tag: '@tesbo.testId("TES-TC-1024")' }, async ({ browser }) => {
    /*
     * Comfortably past the tree's width, so it genuinely truncates, but within the folder-name cap.
     *
     * The cap is KB_FOLDER_NAME_MAX_LENGTH = 50 (LegacyService, mirrored in Tesbo-Frontend's
     * lib/validation.ts) — a name longer than that is a 400 now, so the old 124-character fixture
     * could no longer be created at all. 50 characters in a sidebar tree still truncates, which is
     * all this test needs; the subject here is the tooltip, not the length limit (KB-A-58 owns that).
     * Sliced rather than hand-sized because stamp()'s random suffix varies in width, and the slice
     * keeps the whole timestamp so re-runs still can't collide.
     */
    const longName = `${stamp("VeryLongFolderName")} ${"Segment".repeat(12)}`.slice(0, 50);
    const created = await api.post(kbUrl("/folders"), {
      data: { name: longName, parentFolderId: rootFolderId },
    });
    expect(created.ok(), `creating the long-named folder — ${await created.text()}`).toBeTruthy();

    const page = await openKb(browser);

    // The tree node and the table cell are two separate renders of the same name; the reporter saw
    // the tree, but a user reads whichever is in front of them.
    const treeNode = page.locator("span.truncate", { hasText: longName.slice(0, 40) }).first();
    await expect(treeNode).toBeVisible();

    const withTitle = page.locator(`[title=${JSON.stringify(longName)}]`);
    await expect(
      withTitle.first(),
      "no element exposes the full folder name, so a truncated name cannot be read at all",
    ).toBeAttached();
  });
  /*
   * Basecamp 10199290648 — "Resolving a comment deletes the comment and its replies".
   *
   * It does not: resolve sets is_resolved (delete is a separate endpoint), the list endpoint still
   * returns the thread, and it can be reopened — all pinned API-side by KBC-A-10..13. What the
   * reporter actually hit was a disappearance: a resolved thread is hidden from the default view, and
   * the only thing saying so was a 12px grey underlined link in the header's far corner. When the
   * resolved thread is the LAST open one the entire list empties at once, which reads as destruction.
   *
   * Asserts the behaviour is non-destructive AND that the screen says so. Fails against the old UI on
   * the chip locator and on the empty-state wording.
   */
  test("KBU-31 resolving a comment hides it without ever looking like a deletion", { tag: '@tesbo.testId("TES-TC-1025")' }, async ({ browser }) => {
    const docName = stamp("Comment doc");
    const created = await api.post(kbUrl("/documents"), {
      data: { title: docName, folderId: rootFolderId, contentText: "Body under discussion." },
      failOnStatusCode: false,
    });
    expect(created.status(), `seeding the document — ${await created.text()}`).toBe(201);
    const documentId = (await created.json()).id;

    const threadBody = stamp("Please review this passage");
    const thread = await api.post(kbUrl(`/documents/${documentId}/comments`), {
      data: { body: threadBody },
      failOnStatusCode: false,
    });
    expect(thread.status(), `seeding the thread — ${await thread.text()}`).toBe(201);
    const threadId = (await thread.json()).id;
    const replyBody = stamp("Agreed");
    await api.post(kbUrl(`/documents/${documentId}/comments`), {
      data: { body: replyBody, parentCommentId: threadId },
      failOnStatusCode: false,
    });

    const page = await openKb(browser);
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${documentId}`);

    // The thread and its reply are both on screen, and there is nothing resolved yet.
    await expect(page.getByText(threadBody)).toBeVisible();
    await expect(page.getByText(replyBody)).toBeVisible();
    await expect(page.getByTestId("toggle-resolved-comments")).toHaveCount(0);

    await page.getByRole("button", { name: /Resolve/ }).first().click();

    // It leaves the default view — that part is intended.
    await expect(page.getByText(threadBody)).toHaveCount(0);
    await expect(page.getByText(replyBody)).toHaveCount(0);

    // But the screen must make it obvious the thread was kept, not destroyed.
    const chip = page.getByTestId("toggle-resolved-comments");
    await expect(chip, "nothing prominent says where the resolved thread went").toBeVisible();
    await expect(chip).toContainText("1 resolved");
    // This was the only open thread, so the list is now empty — the moment the reporter read as a
    // deletion. The empty state has to say otherwise.
    await expect(page.getByText(/Nothing was deleted/i)).toBeVisible();

    // And it is genuinely recoverable from the UI.
    await chip.click();
    await expect(page.getByText(threadBody)).toBeVisible();
    await expect(page.getByText(replyBody), "the reply was not restored with its thread").toBeVisible();
    await page.getByRole("button", { name: /Reopen/ }).first().click();
    await expect(page.getByTestId("toggle-resolved-comments")).toHaveCount(0);
    await expect(page.getByText(threadBody)).toBeVisible();

    // Proof it was never deleted: the API still serves both rows, undeleted.
    const listed = await (await api.get(kbUrl(`/documents/${documentId}/comments`))).json();
    const bodies = listed.map((c: { body: string }) => c.body);
    expect(bodies, "the thread or its reply was actually deleted").toContain(threadBody);
    expect(bodies).toContain(replyBody);
  });

  // ─── Error placement: inline in the dialog vs. a floating toast ────────────
  //
  // Basecamp report: a rename's permission error rendered as a page-level banner, invisible behind
  // the still-open Modal (which portals its own overlay at z-50) until the dialog was closed — and,
  // separately, a duplicate-name refusal (a message about the very field just submitted) surfaced
  // the same way instead of inline next to the input. Three tests: the two error-worthy field
  // conflicts land inline in their own dialogs (renaming a folder, moving one into its own
  // subtree), and a permission refusal — which isn't about any field on screen — floats above the
  // dialog as a toast instead of hiding behind it.

  test("KBU-32 renaming a folder to a name already taken under the same parent is refused inline, not as a toast", { tag: '@tesbo.testId("TES-TC-1339")' }, async ({
    browser,
  }) => {
    const page = await openKb(browser);
    const shared = stamp("Taken");
    const toRename = stamp("Renaming");
    await createFolder(page, shared);
    await createFolder(page, toRename);
    await expect(row(page, toRename)).toBeVisible();

    await openTreeMenu(page, toRename, "Rename");
    const dialog = modal(page, "Rename folder");
    await dialog.locator("input").fill(shared);
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect(dialog, "the dialog stays open so the inline error is visible").toBeVisible();
    await expect(dialog.getByText(/a folder with this name already exists/i)).toBeVisible();
    await expect(errorToast(page), "a field-specific error must not also surface as a toast").toHaveCount(0);
    expect(
      scalar(
        `SELECT name FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = ${literal(toRename)};`,
      ),
      "the rejected rename must not have been persisted",
    ).toBe(toRename);
  });

  test("KBU-33 moving a folder into its own subfolder is refused inline under the destination field, not as a toast", { tag: '@tesbo.testId("TES-TC-1340")' }, async ({
    browser,
  }) => {
    const parentName = stamp("MoveParent");
    const parent = await api.post(kbUrl("/folders"), { data: { name: parentName, parentFolderId: rootFolderId } });
    expect(parent.status()).toBe(201);
    const parentId = (await parent.json()).id;
    const childName = stamp("MoveChild");
    const child = await api.post(kbUrl("/folders"), { data: { name: childName, parentFolderId: parentId } });
    expect(child.status()).toBe(201);
    const childId = (await child.json()).id;

    const page = await openKb(browser);
    // Expand the tree so the child row (and the parent's row menu) are actually on screen.
    await page.getByRole("button", { name: parentName, exact: true }).first().click();
    await expect(page.getByRole("button", { name: childName, exact: true }).first()).toBeVisible();

    await openTreeMenu(page, parentName, "Move");
    const dialog = modal(page, "Move to folder");
    // The destination list only excludes the folder being moved itself, not its descendants — so
    // its own child is a selectable (and, on submit, refused) option.
    await dialog.locator("select").selectOption(childId);
    await dialog.getByRole("button", { name: "Move" }).click();

    await expect(dialog, "the dialog stays open so the inline error is visible").toBeVisible();
    await expect(dialog.getByText(/cannot be moved into itself/i)).toBeVisible();
    await expect(errorToast(page), "a field-specific error must not also surface as a toast").toHaveCount(0);
    expect(
      scalar(`SELECT parent_folder_id FROM knowledge_folders WHERE id = ${literal(parentId)};`),
      "the rejected move must not have changed the folder's parent",
    ).toBe(rootFolderId);
  });

  test("KBU-34 a permission refusal on rename floats above the still-open dialog as a toast, not a hidden page banner", { tag: '@tesbo.testId("TES-TC-1341")' }, async ({
    browser,
  }) => {
    const ownersFolder = stamp("OwnersFolder");
    const created = await api.post(kbUrl("/folders"), { data: { name: ownersFolder, parentFolderId: rootFolderId } });
    expect(created.status()).toBe(201);

    // qa_engineer: not owner/manager, and did not create this folder — kbRequireMutateAccess
    // (legacy.service.ts) refuses with "You can only modify items you created".
    const page = await openKb(browser, "qa");
    await expect(row(page, ownersFolder)).toBeVisible();

    await openTreeMenu(page, ownersFolder, "Rename");
    const dialog = modal(page, "Rename folder");
    await dialog.locator("input").fill(stamp("Attempted"));
    await dialog.getByRole("button", { name: "Save" }).click();

    const toast = errorToast(page).filter({ hasText: "You can only modify items you created" });
    await expect(toast, "the permission refusal must be visible, not silently absorbed").toBeVisible();
    // Not a client-side validation message — it can only have come back from the API, so this also
    // proves the toast is reachable while the dialog it was triggered from is still open.
    await expect(dialog, "the rename dialog must still be open underneath the toast").toBeVisible();

    // The mechanism of the fix: `position: fixed` plus a z-index above the Modal's own z-50
    // overlay is what makes the toast render on top instead of behind it.
    await expect.poll(() => toast.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    await expect
      .poll(() => toast.evaluate((el) => Number(getComputedStyle(el).zIndex)))
      .toBeGreaterThan(50);

    expect(
      scalar(`SELECT name FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} AND name = ${literal(ownersFolder)};`),
      "the refused rename must not have been persisted",
    ).toBe(ownersFolder);
  });

  // ─── Nightly sync cron follow-through: "Added on", "Last updated", and the change-history popover ──

  test("KBU-35 a synced row shows distinct Added on / Last updated dates, its icon sits in Last updated, and a plain row has no icon", { tag: '@tesbo.testId("TES-TC-254")' }, async ({ browser }) => {
    const mirrorTitle = stamp("E2E-80: Synced ticket");
    seedMirrorDocument(mirrorTitle, "kbu-added-on-1", 5, 0);

    const plainTitle = stamp("Plain human document");
    exec(
      "INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, document_type, status) VALUES (" +
        `${literal(tenant!.organizationId)}, ${literal(tenant!.mainProjectId)}, ${literal(rootFolderId)}, ${literal(plainTitle)}, 'not synced', 'general', 'draft');`,
    );

    const page = await openKb(browser);
    await expect(page.getByRole("columnheader", { name: "Added on" })).toBeVisible();

    const mirrorRow = row(page, mirrorTitle);
    await expect(mirrorRow).toBeVisible();
    const cells = await mirrorRow.getByRole("cell").allTextContents();
    // Name, Type, Updated by, Added on, Last updated, Size, Actions (no search query active, so
    // the Folder path column is absent) — Added on (created 5 days ago) must read differently from
    // Last updated (touched moments ago), not just coincidentally both say "Today".
    expect(cells[3]).not.toContain("Today");
    expect(cells[4]).toContain("Today");

    // The icon lives in the Last updated cell, not Type — assert it directly rather than just
    // "somewhere in the row", since that's the exact placement that was reported wrong.
    const lastUpdatedCell = mirrorRow.getByRole("cell").nth(4);
    await expect(lastUpdatedCell.getByRole("button", { name: "Change history" })).toBeVisible();
    await expect(mirrorRow.getByRole("cell").nth(1).getByRole("button", { name: "Change history" })).toHaveCount(0);

    // A synced row gets the info icon; a plain, human-authored row does not — there is no change
    // timeline to show for it.
    await expect(changeHistoryTrigger(page, mirrorTitle)).toBeVisible();
    await expect(changeHistoryTrigger(page, plainTitle)).toHaveCount(0);
  });

  test("KBU-36 the change-history popover opens on hover as well as click, and lists the timeline newest first", { tag: '@tesbo.testId("TES-TC-255")' }, async ({ browser }) => {
    const title = stamp("E2E-81: Has history");
    const documentId = seedMirrorDocument(title, "kbu-added-on-2", 5, 0);
    seedSyncEvent(documentId, "created", null);
    seedSyncEvent(documentId, "updated", "Status: To Do -> In Progress updated.");

    const page = await openKb(browser);
    const panel = menuPanel(page);

    // Hovering, not clicking, must open it — this is the behavior that was reported broken.
    await changeHistoryTrigger(page, title).hover();
    await expect(panel.getByText("Change history")).toBeVisible();
    await expect(panel.getByText("Status: To Do -> In Progress updated.")).toBeVisible();
    await expect(panel.getByText("Added", { exact: false }).first()).toBeVisible();

    // Moving onto the popover itself (not away from the row) must not close it.
    await panel.hover();
    await expect(panel).toBeVisible();

    // Moving away closes it again.
    await page.getByRole("heading", { name: "Knowledge base", level: 1 }).hover();
    await expect(panel).not.toBeVisible();

    // Click opens it too, independent of hover (covers touch/keyboard users with no real hover).
    await changeHistoryTrigger(page, title).click();
    await expect(menuPanel(page).getByText("Change history")).toBeVisible();

    // An outside click closes it — the only way a tap-only device can dismiss it.
    await page.getByRole("heading", { name: "Knowledge base", level: 1 }).click();
    await expect(menuPanel(page)).toHaveCount(0);

    // A document with no change history recorded (e.g. one mirrored before this feature shipped)
    // shows a plain empty state rather than an error or a blank popup.
    const untracked = stamp("E2E-82: No history recorded");
    seedMirrorDocument(untracked, "kbu-added-on-3", 1, 1);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Knowledge base", level: 1 })).toBeVisible();
    await changeHistoryTrigger(page, untracked).hover();
    await expect(menuPanel(page).getByText("No change history recorded yet.")).toBeVisible();
  });

  test("KBU-37 the popover paginates 5 per page with calendar/clock icons in DD/MM/YYYY 12-hour format, and never crops off-screen", { tag: '@tesbo.testId("TES-TC-258")' }, async ({ browser }) => {
    const title = stamp("E2E-83: Long timeline");
    const documentId = seedMirrorDocument(title, "kbu-added-on-4", 3, 0);
    for (let i = 1; i <= 7; i++) seedSyncEvent(documentId, "updated", `Change ${i}`);

    const page = await openKb(browser);
    // Narrow enough that the table's right-hand columns — where the icon now lives, in Last
    // updated — crowd the screen edge, the exact layout the cropping was reported against.
    await page.setViewportSize({ width: 700, height: 720 });

    await changeHistoryTrigger(page, title).click();
    const panel = menuPanel(page);
    await expect(panel).toBeVisible();

    // Never off-screen on any edge, regardless of where the trigger sits in the row.
    const viewport = page.viewportSize();
    await expect(async () => {
      const box = await panel.boundingBox();
      expect(box, "the popover must report a real bounding box").not.toBeNull();
      if (!box || !viewport) return;
      expect(box.x, "popover left edge is off-screen").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "popover right edge overflows the viewport").toBeLessThanOrEqual(viewport.width);
      expect(box.y, "popover top edge is off-screen").toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, "popover bottom edge overflows the viewport").toBeLessThanOrEqual(viewport.height);
    }).toPass();

    // Calendar and clock icons (Tabler icons render as inline <svg>) on every entry.
    const firstEntry = panel.locator("li").first();
    await expect(firstEntry.locator("svg")).toHaveCount(2);

    // DD/MM/YYYY and 12-hour HH:MM:SS AM/PM — the seeded events are `now()`, so today's date must
    // render in exactly that format, and the time must carry a literal AM/PM marker.
    const now = new Date();
    const expectedDate = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
    await expect(firstEntry).toContainText(expectedDate);
    await expect(firstEntry).toContainText(/\d{2}:\d{2}:\d{2} (AM|PM)/);

    // Page 1 of a 7-event timeline: exactly 5 rows, newest ("Change 7") first, Next enabled and
    // Previous disabled — there is nowhere earlier to go from the first page.
    await expect(panel.locator("li")).toHaveCount(5);
    await expect(panel.getByText("Change 7", { exact: false })).toBeVisible();
    const nextButton = panel.getByRole("button", { name: "Next" });
    const previousButton = panel.getByRole("button", { name: "Previous" });
    await expect(previousButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();
    await expect(panel.getByText("Page 1")).toBeVisible();

    await nextButton.click();
    // Page 2: the remaining 2 (oldest) rows, Next now disabled — nothing further to page to.
    await expect(panel.getByText("Page 2")).toBeVisible();
    await expect(panel.locator("li")).toHaveCount(2);
    await expect(panel.getByText("Change 1", { exact: false })).toBeVisible();
    await expect(nextButton).toBeDisabled();
    await expect(previousButton).toBeEnabled();

    await previousButton.click();
    await expect(panel.getByText("Page 1")).toBeVisible();
    await expect(panel.getByText("Change 7", { exact: false })).toBeVisible();
  });

  test("KBU-38 a synced document's View history shows the change timeline with date/time/who, not a version list — a plain document is unaffected", { tag: '@tesbo.testId("TES-TC-260")' }, async ({ browser }) => {
    const mirrorTitle = stamp("E2E-84: View history mirror");
    const documentId = seedMirrorDocument(mirrorTitle, "kbu-view-history-1", 2, 0);
    seedSyncEvent(documentId, "updated", "Description updated.");

    const ctx = await browser.newContext({ storageState: states.get("owner") });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${documentId}`);

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "View history" }).click();

    // The modal is titled "Change history" for a mirror, not "Version history" — same distinction
    // as the info-icon popover, since a mirror has no manually saved versions to list.
    const changeHistoryDialog = modal(page, "Change history");
    await expect(changeHistoryDialog).toBeVisible();
    await expect(changeHistoryDialog.getByText("Description updated.")).toBeVisible();
    // No triggering user was seeded (a nightly-style event) — labelled explicitly, not blank.
    await expect(changeHistoryDialog.getByText("Nightly sync", { exact: false })).toBeVisible();
    // Calendar + clock icons, and the DD/MM/YYYY + 12-hour time format, same as the popover.
    await expect(changeHistoryDialog.locator("li").first().locator("svg")).toHaveCount(2);
    await expect(changeHistoryDialog).toContainText(/\d{2}:\d{2}:\d{2} (AM|PM)/);
    // "Restore" only makes sense against a manually saved version — never offered for a mirror.
    await expect(changeHistoryDialog.getByRole("button", { name: "Restore" })).toHaveCount(0);
    // Modal.tsx has no close button — Escape (or a backdrop click) is how it dismisses.
    await page.keyboard.press("Escape");

    // A second mirror with no sync-event rows (e.g. synced before this feature existed) gets the
    // same empty state as the popover, not a misleading "No earlier versions yet."
    const untrackedTitle = stamp("E2E-85: View history mirror, no events");
    const untrackedId = seedMirrorDocument(untrackedTitle, "kbu-view-history-2", 1, 1);
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${untrackedId}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "View history" }).click();
    await expect(modal(page, "Change history").getByText("No change history recorded yet.")).toBeVisible();
    // Modal.tsx has no close button — Escape (or a backdrop click) is how it dismisses.
    await page.keyboard.press("Escape");

    // A regular, human-authored document is entirely unaffected: still "Version history", still
    // the plain empty state, since it has never been saved yet either.
    const created = await api.post(kbUrl("/documents"), { data: { title: stamp("Plain doc"), folderId: rootFolderId } });
    expect(created.status()).toBe(201);
    const plainDocumentId = (await created.json()).id;
    await page.goto(`/projects/${tenant!.mainProjectId}/knowledge-base/documents/${plainDocumentId}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "View history" }).click();
    const versionDialog = modal(page, "Version history");
    await expect(versionDialog).toBeVisible();
    await expect(versionDialog.getByText("No earlier versions yet.")).toBeVisible();
  });
});
