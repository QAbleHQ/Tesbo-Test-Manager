import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { emailDomain } from "../utils/env";
import { zipEntryNames, zipEntryText } from "../utils/zip";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  detachUserByEmail,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  setProjectRole,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Knowledge Base v2 — folders, documents, versions, AI memory, search, summary, export.
 *
 * Wave 5. Comments live in api/kb-comments.spec.ts and files in api/kb-files.spec.ts, each on its own
 * disposable workspace: all three files delete folders recursively, and a recursive delete in one
 * would take the others' fixtures with it if they shared a project.
 *
 * The permission model here is not the workspace role matrix the rest of the suite tests, and the
 * difference is the point of the ROLE block below:
 *
 *   - reads (tree, summary, get, list, items, search)  →  any project member
 *   - mutations (update / move / delete)               →  owner, manager, OR the item's own creator
 *     (kbRequireMutateAccess) — so a qa_engineer may edit what they made and nothing else
 *   - restore-from-trash and AI-memory approve/reject  →  owner or manager only
 *     (kbRequireOwnerOrManager) — the only three operations that gate is used for
 *
 * Teardown goes through Postgres because the DELETE endpoints are themselves under test (they
 * soft-delete, refuse the root folder, and cascade), so a test proving what delete does must not
 * depend on delete to clean up.
 */

test.describe("knowledge base v2 — folders and documents", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  /** The project's root folder id, resolved once from the tree endpoint. */
  let rootFolderId = "";

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("knowledge-base");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();

    purgeKb(tenant);
    backfillMissingRootFolder(tenant);
    const tree = await asOwner.get(kbUrl("/folders/tree"));
    expect(tree.status(), `resolving the KB root folder — ${await tree.text()}`).toBe(200);
    rootFolderId = (await tree.json()).id;
  });

  test.afterAll(async () => {
    if (tenant) purgeKb(tenant);
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /*
   * Every test starts from an empty knowledge base.
   *
   * Not tidiness: the summary counters and the "nothing was written" assertions are absolute
   * numbers, so one leftover folder from an earlier test turns a correct product into a red test —
   * and the failure lands in whichever test happens to run first, which is not the one at fault.
   */
  test.afterEach(() => {
    if (tenant) purgeKb(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function kbUrl(suffix: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/knowledge-base${suffix}`;
  }

  /**
   * Wipes every non-root KB row in both fixture projects.
   *
   * Documents before folders isn't required (no FK cascade is relied on), but the root folder is
   * kept deliberately: it is created by the project bootstrap, `is_root` rows cannot be recreated
   * through the API, and every other test in the file hangs its fixtures off it.
   */
  function purgeKb(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM knowledge_document_versions WHERE document_id IN (SELECT id FROM knowledge_documents WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM knowledge_document_comments WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_files WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_folders WHERE project_id IN (${projects}) AND is_root = false;`);
    // The v1 flat notes live in their own table and are counted absolutely by KB-A-53.
    exec(`DELETE FROM knowledge_base_items WHERE project_id IN (${projects});`);
  }

  /** Names are stamped so a re-run against the persistent volume can't collide on the unique index. */
  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  /**
   * Gives a fixture project the knowledge_folders root that project creation should have seeded.
   *
   * This backfills rows left behind by the defect KB-A-00 covers: createOrgAndProject did not call
   * seedKnowledgeBaseDefaults, so any workspace bootstrapped through onboarding by a pre-fix build
   * has a first project with no root folder. That state cannot be repaired through the API — `is_root`
   * rows are only ever written by project creation — so it is arranged directly, which is this
   * suite's convention for a fixture the API cannot express.
   *
   * It is NOT a way of hiding the bug: KB-A-00 drives the real onboarding endpoint on a brand-new
   * workspace and fails if the seeding is missing. This only stops one stale fixture row from
   * masking the other 54 tests behind an unrelated failure.
   */
  function backfillMissingRootFolder(t: RbacTenant): void {
    for (const projectId of [t.mainProjectId, t.secondProjectId]) {
      const existing = scalar(
        `SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(projectId)} AND is_root = true;`,
      );
      if (existing !== "0") continue;
      exec(
        "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
          `VALUES (${literal(t.organizationId)}, ${literal(projectId)}, NULL, 'Knowledge base', true);`,
      );
    }
  }

  async function createFolder(
    body: Record<string, unknown>,
    api: APIRequestContext = asOwner,
  ): Promise<any> {
    const res = await api.post(kbUrl("/folders"), { data: body, failOnStatusCode: false });
    expect(res.status(), `creating folder ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function createDocument(
    body: Record<string, unknown>,
    api: APIRequestContext = asOwner,
  ): Promise<any> {
    const res = await api.post(kbUrl("/documents"), {
      data: { folderId: rootFolderId, ...body },
      failOnStatusCode: false,
    });
    expect(res.status(), `creating document ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  function isDeleted(table: "knowledge_folders" | "knowledge_documents", id: string): boolean {
    return scalar(`SELECT is_deleted FROM ${table} WHERE id = ${literal(id)};`) === "t";
  }

  /**
   * Every method+path pair a caller with no session must be refused on.
   *
   * 400 is in the accepted set because `requireUser` throws BadRequestException("Authentication
   * required") rather than a 401 — that is app-wide, not a Knowledge Base quirk, and the rest of the
   * suite (attachments, custom fields) already pins the same set. What matters here is that the call
   * is refused and nothing is written; the status-code wart is recorded as a finding in
   * docs/e2e-coverage-waves.md rather than fixed inside this wave, since changing it is an API
   * contract change across every route.
   */
  async function expectUnauthenticated(res: APIResponse, what: string): Promise<void> {
    expect([400, 401, 403, 404], `${what} answered an anonymous caller with ${res.status()}: ${await res.text()}`)
      .toContain(res.status());
  }

  // ─── Project bootstrap: the knowledge base has to exist before anything else ──

  test("KB-A-00 a workspace's first project, created through onboarding, has a usable knowledge base", { tag: '@tesbo.testId("TES-TC-332")' }, async () => {
    // Regression test. createOrgAndProject inserted its project without calling
    // seedKnowledgeBaseDefaults, which createProject does — so the FIRST project of every workspace
    // (the one a new signup lands in) had no knowledge_folders root. The folder tree 404'd there and
    // createKnowledgeFolder silently made an orphan second root with parent_folder_id = NULL.
    //
    // Driven through the real endpoint on a brand-new user rather than asserted against a fixture,
    // because the fixture workspaces already exist and their bootstrap can't be replayed.
    const email = `e2e-kb-onboarding-${Date.now()}@${emailDomain}`;
    const user = seedFixtureUser(email, "E2E KB Onboarding");
    const api = await loginAs(user);
    let projectId = "";
    try {
      const created = await api.post("/api/onboarding/org-and-project", {
        data: { orgName: `E2E KB Onboarding Org ${Date.now()}`, projectName: `E2E KB First Project ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(created.status(), `bootstrapping a workspace — ${await created.text()}`).toBe(201);
      const body = await created.json();
      projectId = body.projectId;

      // The tree is the knowledge base's entry point: every screen and every create call resolves
      // the root through it, so a project without one has no working knowledge base at all.
      const tree = await api.get(`/api/projects/${projectId}/knowledge-base/folders/tree`, {
        failOnStatusCode: false,
      });
      expect(
        tree.status(),
        `a freshly onboarded project has no knowledge-base root folder — ${await tree.text()}`,
      ).toBe(200);
      const root = await tree.json();
      expect(root.isRoot).toBe(true);
      expect(root.children).toEqual([]);

      // Exactly one root, and a folder created without a parent hangs off it rather than becoming
      // a second orphan root.
      expect(
        scalar(`SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(projectId)} AND is_root = true;`),
      ).toBe("1");
      const folder = await api.post(`/api/projects/${projectId}/knowledge-base/folders`, {
        data: { name: "First folder" },
        failOnStatusCode: false,
      });
      expect(folder.status()).toBe(201);
      expect((await folder.json()).parentFolderId).toBe(root.id);
    } finally {
      /*
       * The workspace and project rows are deliberately left behind.
       *
       * audit_logs is append-only — an `audit_logs_prevent_mutation` trigger refuses both DELETE and
       * UPDATE — and audit_logs.project_id is ON DELETE SET NULL, so removing a project that has
       * logged any activity makes Postgres attempt exactly the update the trigger forbids. Creating
       * the folder above logs activity, so this project cannot be removed by design, and forcing it
       * (session_replication_role) would mean defeating an audit control from a test.
       *
       * What is cleaned is the part that could affect another test: the knowledge rows, and the
       * user's memberships, so this throwaway user holds no workspace on the next run.
       */
      if (projectId) exec(`DELETE FROM knowledge_folders WHERE project_id = ${literal(projectId)};`);
      exec(`UPDATE users SET default_project_id = NULL WHERE id = ${literal(user.userId)};`);
      detachUserByEmail(email);
      await api.dispose();
    }
  });

  // ─── Folders: the primary create → read → rename → move → delete flow ──────

  test("KB-A-01 a folder is created under the root, appears in the tree, and reads back with a breadcrumb", { tag: '@tesbo.testId("TES-TC-333")' }, async () => {
    const name = stamp("Folder");
    const folder = await createFolder({ name, description: "created by the e2e suite" });
    expect(folder.name).toBe(name);
    expect(folder.parentFolderId).toBe(rootFolderId);
    expect(folder.isDeleted).toBe(false);

    const tree = await asOwner.get(kbUrl("/folders/tree"));
    expect(tree.status()).toBe(200);
    const root = await tree.json();
    expect(root.isRoot).toBe(true);
    expect(root.children.map((c: any) => c.id)).toContain(folder.id);

    const read = await asOwner.get(kbUrl(`/folders/${folder.id}`));
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.name).toBe(name);
    // The breadcrumb is root-first, so a UI can render "Knowledge base / Folder" without a lookup.
    expect(body.breadcrumb.map((b: any) => b.id)).toEqual([rootFolderId, folder.id]);
  });

  test("KB-A-02 a nested folder tree nests in the response, not just in the rows", { tag: '@tesbo.testId("TES-TC-334")' }, async () => {
    const parent = await createFolder({ name: stamp("Parent") });
    const child = await createFolder({ name: stamp("Child"), parentFolderId: parent.id });
    const grandchild = await createFolder({ name: stamp("Grandchild"), parentFolderId: child.id });

    const root = await (await asOwner.get(kbUrl("/folders/tree"))).json();
    const parentNode = root.children.find((c: any) => c.id === parent.id);
    expect(parentNode, "the parent folder is missing from the tree").toBeTruthy();
    const childNode = parentNode.children.find((c: any) => c.id === child.id);
    expect(childNode, "the child folder did not nest under its parent").toBeTruthy();
    expect(childNode.children.map((c: any) => c.id)).toEqual([grandchild.id]);

    const crumbs = (await (await asOwner.get(kbUrl(`/folders/${grandchild.id}`))).json()).breadcrumb;
    expect(crumbs.map((b: any) => b.id)).toEqual([rootFolderId, parent.id, child.id, grandchild.id]);
  });

  test("KB-A-03 a folder is renamed and its description updated", { tag: '@tesbo.testId("TES-TC-335")' }, async () => {
    const folder = await createFolder({ name: stamp("Before"), description: "first" });
    const renamed = stamp("After");
    const res = await asOwner.patch(kbUrl(`/folders/${folder.id}`), {
      data: { name: renamed, description: "second" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(renamed);
    expect(body.description).toBe("second");
    expect(scalar(`SELECT name FROM knowledge_folders WHERE id = ${literal(folder.id)};`)).toBe(renamed);
  });

  test("KB-A-04 a folder moves to a new parent, and cannot be moved into its own subtree", { tag: '@tesbo.testId("TES-TC-336")' }, async () => {
    const a = await createFolder({ name: stamp("A") });
    const b = await createFolder({ name: stamp("B") });
    const childOfA = await createFolder({ name: stamp("A-child"), parentFolderId: a.id });

    const moved = await asOwner.patch(kbUrl(`/folders/${childOfA.id}/move`), {
      data: { parentFolderId: b.id },
      failOnStatusCode: false,
    });
    expect(moved.status()).toBe(200);
    expect((await moved.json()).parentFolderId).toBe(b.id);

    // Into itself, and into a descendant: both are cycles and both must be refused.
    const intoItself = await asOwner.patch(kbUrl(`/folders/${a.id}/move`), {
      data: { parentFolderId: a.id },
      failOnStatusCode: false,
    });
    expect(intoItself.status()).toBe(400);
    expect(JSON.stringify(await intoItself.json())).toContain("cannot be moved into itself");

    const deepChild = await createFolder({ name: stamp("A-deep"), parentFolderId: a.id });
    const intoDescendant = await asOwner.patch(kbUrl(`/folders/${a.id}/move`), {
      data: { parentFolderId: deepChild.id },
      failOnStatusCode: false,
    });
    expect(intoDescendant.status()).toBe(400);

    // The refusal left the tree alone.
    expect(scalar(`SELECT parent_folder_id FROM knowledge_folders WHERE id = ${literal(a.id)};`)).toBe(
      rootFolderId,
    );
  });

  test("KB-A-05 deleting a folder soft-deletes its whole subtree, documents included", { tag: '@tesbo.testId("TES-TC-337")' }, async () => {
    const parent = await createFolder({ name: stamp("Doomed") });
    const child = await createFolder({ name: stamp("Doomed-child"), parentFolderId: parent.id });
    const doc = await createDocument({ title: stamp("Doomed doc"), folderId: child.id });

    const res = await asOwner.delete(kbUrl(`/folders/${parent.id}`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Soft, not hard: the rows survive so restore has something to bring back.
    expect(isDeleted("knowledge_folders", parent.id)).toBe(true);
    expect(isDeleted("knowledge_folders", child.id)).toBe(true);
    expect(isDeleted("knowledge_documents", doc.id)).toBe(true);

    // And they are gone from every read path.
    expect((await asOwner.get(kbUrl(`/folders/${parent.id}`), { failOnStatusCode: false })).status()).toBe(404);
    const root = await (await asOwner.get(kbUrl("/folders/tree"))).json();
    expect(root.children.map((c: any) => c.id)).not.toContain(parent.id);
    const docs = await (await asOwner.get(kbUrl("/documents"))).json();
    expect(docs.list.map((d: any) => d.id)).not.toContain(doc.id);
  });

  test("KB-A-06 the root folder can be neither moved nor deleted", { tag: '@tesbo.testId("TES-TC-338")' }, async () => {
    const target = await createFolder({ name: stamp("Elsewhere") });

    const moved = await asOwner.patch(kbUrl(`/folders/${rootFolderId}/move`), {
      data: { parentFolderId: target.id },
      failOnStatusCode: false,
    });
    expect(moved.status()).toBe(400);
    expect(JSON.stringify(await moved.json())).toContain("root folder cannot be moved");

    const deleted = await asOwner.delete(kbUrl(`/folders/${rootFolderId}`), { failOnStatusCode: false });
    expect(deleted.status()).toBe(400);
    expect(JSON.stringify(await deleted.json())).toContain("root folder cannot be deleted");

    // Still there, still root — the guard is not merely cosmetic.
    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(rootFolderId)};`)).toBe("f");
    expect((await (await asOwner.get(kbUrl("/folders/tree"))).json()).id).toBe(rootFolderId);
  });

  test("KB-A-07 a deleted folder is restored by an owner", { tag: '@tesbo.testId("TES-TC-339")' }, async () => {
    const folder = await createFolder({ name: stamp("Restorable") });
    await asOwner.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false });
    expect(isDeleted("knowledge_folders", folder.id)).toBe(true);

    const res = await asOwner.patch(kbUrl(`/folders/${folder.id}/restore`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).isDeleted).toBe(false);
    const root = await (await asOwner.get(kbUrl("/folders/tree"))).json();
    expect(root.children.map((c: any) => c.id)).toContain(folder.id);
  });

  // ─── Folders: validation and boundaries ────────────────────────────────────

  test("KB-A-08 a folder name that is empty, whitespace-only, or missing is refused with a message", { tag: '@tesbo.testId("TES-TC-340")' }, async () => {
    for (const body of [{}, { name: "" }, { name: "   " }, { name: "\t\n" }]) {
      const res = await asOwner.post(kbUrl("/folders"), { data: body, failOnStatusCode: false });
      expect(res.status(), `${JSON.stringify(body)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("Folder name is required");
    }
    // Nothing was written on the way to any of those refusals.
    expect(
      scalar(
        `SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(tenant!.mainProjectId)} ` +
          "AND is_root = false;",
      ),
    ).toBe("0");
  });

  test("KB-A-09 two folders cannot share a name under the same parent, but can under different ones", { tag: '@tesbo.testId("TES-TC-341")' }, async () => {
    const name = stamp("Twin");
    const first = await createFolder({ name });

    const duplicate = await asOwner.post(kbUrl("/folders"), { data: { name }, failOnStatusCode: false });
    expect(duplicate.status()).toBe(400);
    expect(JSON.stringify(await duplicate.json())).toContain("already exists");

    // Same name, different parent: allowed, because the unique index is scoped to the parent.
    const elsewhere = await createFolder({ name: stamp("Host") });
    const twin = await createFolder({ name, parentFolderId: elsewhere.id });
    expect(twin.name).toBe(name);
    expect(twin.id).not.toBe(first.id);

    // ...and the collision is re-raised when a move would create it.
    const collide = await asOwner.patch(kbUrl(`/folders/${twin.id}/move`), {
      data: { parentFolderId: rootFolderId },
      failOnStatusCode: false,
    });
    expect(collide.status()).toBe(400);
    expect(JSON.stringify(await collide.json())).toContain("already exists");
  });

  test("KB-A-10 move requires a parentFolderId, and refuses one that does not exist", { tag: '@tesbo.testId("TES-TC-342")' }, async () => {
    const folder = await createFolder({ name: stamp("Mover") });

    const missing = await asOwner.patch(kbUrl(`/folders/${folder.id}/move`), {
      data: {},
      failOnStatusCode: false,
    });
    expect(missing.status()).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("parentFolderId is required");

    const unknown = await asOwner.patch(kbUrl(`/folders/${folder.id}/move`), {
      data: { parentFolderId: "11111111-1111-4111-8111-111111111111" },
      failOnStatusCode: false,
    });
    expect(unknown.status()).toBe(404);
  });

  test("KB-A-11 a folder from another project cannot be read, renamed, moved or deleted through this one", { tag: '@tesbo.testId("TES-TC-343")' }, async () => {
    // Created in the SECOND project, then reached for through the first one's URL.
    const res = await asOwner.post(kbUrl("/folders", tenant!.secondProjectId), {
      data: { name: stamp("Other project") },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(201);
    const foreign = await res.json();

    for (const attempt of [
      asOwner.get(kbUrl(`/folders/${foreign.id}`), { failOnStatusCode: false }),
      asOwner.get(kbUrl(`/folders/${foreign.id}/items`), { failOnStatusCode: false }),
      asOwner.patch(kbUrl(`/folders/${foreign.id}`), { data: { name: stamp("x") }, failOnStatusCode: false }),
      asOwner.patch(kbUrl(`/folders/${foreign.id}/move`), {
        data: { parentFolderId: rootFolderId },
        failOnStatusCode: false,
      }),
      asOwner.delete(kbUrl(`/folders/${foreign.id}`), { failOnStatusCode: false }),
    ]) {
      const r = await attempt;
      expect(r.status(), `a cross-project folder id answered ${r.status()}: ${await r.text()}`).toBe(404);
    }
    // The folder in the other project is untouched.
    expect(scalar(`SELECT is_deleted FROM knowledge_folders WHERE id = ${literal(foreign.id)};`)).toBe("f");
  });

  test("KB-A-12 a malformed folder id is a 404, not a 500", { tag: '@tesbo.testId("TES-TC-344")' }, async () => {
    for (const bad of ["not-a-uuid", "12345", "%20"]) {
      for (const attempt of [
        asOwner.get(kbUrl(`/folders/${bad}`), { failOnStatusCode: false }),
        asOwner.get(kbUrl(`/folders/${bad}/items`), { failOnStatusCode: false }),
        asOwner.patch(kbUrl(`/folders/${bad}`), { data: { name: "x" }, failOnStatusCode: false }),
        asOwner.delete(kbUrl(`/folders/${bad}`), { failOnStatusCode: false }),
      ]) {
        const res = await attempt;
        expect(
          res.status(),
          `folder id "${bad}" answered ${res.status()} — a failed uuid cast surfacing raw: ${await res.text()}`,
        ).toBeLessThan(500);
      }
    }
  });

  // ─── Folder items listing ─────────────────────────────────────────────────

  test("KB-A-13 a folder's items list carries its subfolders, documents and their type tags", { tag: '@tesbo.testId("TES-TC-345")' }, async () => {
    const folder = await createFolder({ name: stamp("Listing") });
    const sub = await createFolder({ name: stamp("Listing-sub"), parentFolderId: folder.id });
    const doc = await createDocument({ title: stamp("Listing doc"), folderId: folder.id });

    const res = await asOwner.get(kbUrl(`/folders/${folder.id}/items`));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.folder.id).toBe(folder.id);
    expect(body.folder.breadcrumb.map((b: any) => b.id)).toEqual([rootFolderId, folder.id]);
    expect(body.total).toBe(2);

    const byId = new Map(body.items.map((i: any) => [i.id, i]));
    expect((byId.get(sub.id) as any).type).toBe("folder");
    expect((byId.get(doc.id) as any).type).toBe("document");
    // search_vector is a tsvector and has no business in a JSON payload.
    expect(byId.get(doc.id)).not.toHaveProperty("searchVector");
  });

  test("KB-A-14 an empty folder lists as empty rather than erroring", { tag: '@tesbo.testId("TES-TC-346")' }, async () => {
    const folder = await createFolder({ name: stamp("Empty") });
    const body = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items`))).json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("KB-A-15 the items list filters by search across both folder names and document titles", { tag: '@tesbo.testId("TES-TC-347")' }, async () => {
    const folder = await createFolder({ name: stamp("Filterable") });
    const marker = `zqx${Date.now()}`;
    const matchingSub = await createFolder({ name: `Sub ${marker}`, parentFolderId: folder.id });
    const matchingDoc = await createDocument({ title: `Doc ${marker}`, folderId: folder.id });
    await createDocument({ title: stamp("Unrelated"), folderId: folder.id });

    const res = await asOwner.get(kbUrl(`/folders/${folder.id}/items?search=${marker}`));
    const body = await res.json();
    expect(body.items.map((i: any) => i.id).sort()).toEqual([matchingSub.id, matchingDoc.id].sort());

    // A search nothing matches is an empty list, not everything.
    const none = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items?search=nothingmatchesthis`))).json();
    expect(none.items).toEqual([]);
  });

  // ─── Documents ────────────────────────────────────────────────────────────

  test("KB-A-16 a document is created, read back with its folder breadcrumb, and listed", { tag: '@tesbo.testId("TES-TC-348")' }, async () => {
    const folder = await createFolder({ name: stamp("Docs") });
    const title = stamp("Document");
    const doc = await createDocument({
      title,
      folderId: folder.id,
      contentHtml: "<p>hello</p>",
      contentText: "hello",
      contentJson: { type: "doc", content: [] },
    });
    expect(doc.title).toBe(title);
    expect(doc.status).toBe("draft");
    expect(doc.documentType).toBe("general");
    expect(doc.isDeleted).toBe(false);

    const read = await asOwner.get(kbUrl(`/documents/${doc.id}`));
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.contentHtml).toBe("<p>hello</p>");
    expect(body.breadcrumb.map((b: any) => b.id)).toEqual([rootFolderId, folder.id]);

    const list = await (await asOwner.get(kbUrl("/documents"))).json();
    expect(list.list.map((d: any) => d.id)).toContain(doc.id);
  });

  test("KB-A-17 a document requires a title and an existing folder", { tag: '@tesbo.testId("TES-TC-349")' }, async () => {
    for (const body of [
      { folderId: rootFolderId },
      { title: "", folderId: rootFolderId },
      { title: "   ", folderId: rootFolderId },
    ]) {
      const res = await asOwner.post(kbUrl("/documents"), { data: body, failOnStatusCode: false });
      expect(res.status(), `${JSON.stringify(body)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("title is required");
    }

    const noFolder = await asOwner.post(kbUrl("/documents"), {
      data: { title: stamp("Homeless") },
      failOnStatusCode: false,
    });
    expect(noFolder.status()).toBe(400);
    expect(JSON.stringify(await noFolder.json())).toContain("folderId is required");

    const unknownFolder = await asOwner.post(kbUrl("/documents"), {
      data: { title: stamp("Lost"), folderId: "11111111-1111-4111-8111-111111111111" },
      failOnStatusCode: false,
    });
    expect(unknownFolder.status()).toBe(404);
  });

  test("KB-A-18 the documents list filters by documentType and excludes deleted documents", { tag: '@tesbo.testId("TES-TC-350")' }, async () => {
    const general = await createDocument({ title: stamp("General doc") });
    const memory = await createDocument({ title: stamp("Memory doc"), documentType: "ai_memory" });
    const doomed = await createDocument({ title: stamp("Deleted doc") });
    await asOwner.delete(kbUrl(`/documents/${doomed.id}`), { failOnStatusCode: false });

    const filtered = await (await asOwner.get(kbUrl("/documents?documentType=ai_memory"))).json();
    const ids = filtered.list.map((d: any) => d.id);
    expect(ids).toContain(memory.id);
    expect(ids).not.toContain(general.id);

    const all = await (await asOwner.get(kbUrl("/documents"))).json();
    expect(all.list.map((d: any) => d.id)).not.toContain(doomed.id);

    // An unknown documentType matches nothing rather than falling back to everything.
    const unknown = await (await asOwner.get(kbUrl("/documents?documentType=no-such-type"))).json();
    expect(unknown.list).toEqual([]);
    expect(unknown.total).toBe(0);
  });

  test("KB-A-19 a document is moved between folders", { tag: '@tesbo.testId("TES-TC-351")' }, async () => {
    const from = await createFolder({ name: stamp("From") });
    const to = await createFolder({ name: stamp("To") });
    const doc = await createDocument({ title: stamp("Travelling"), folderId: from.id });

    const res = await asOwner.patch(kbUrl(`/documents/${doc.id}/move`), {
      data: { folderId: to.id },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).folderId).toBe(to.id);

    const fromItems = await (await asOwner.get(kbUrl(`/folders/${from.id}/items`))).json();
    expect(fromItems.items.map((i: any) => i.id)).not.toContain(doc.id);
    const toItems = await (await asOwner.get(kbUrl(`/folders/${to.id}/items`))).json();
    expect(toItems.items.map((i: any) => i.id)).toContain(doc.id);

    const missing = await asOwner.patch(kbUrl(`/documents/${doc.id}/move`), {
      data: {},
      failOnStatusCode: false,
    });
    expect(missing.status()).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("folderId is required");
  });

  test("KB-A-20 a duplicate lands beside the original as an independent draft named (copy)", { tag: '@tesbo.testId("TES-TC-352")' }, async () => {
    const folder = await createFolder({ name: stamp("Dupes") });
    const original = await createDocument({
      title: stamp("Original"),
      folderId: folder.id,
      contentHtml: "<p>body</p>",
      contentText: "body",
    });

    const res = await asOwner.post(kbUrl(`/documents/${original.id}/duplicate`), { failOnStatusCode: false });
    expect(res.status()).toBe(201);
    const copy = await res.json();
    expect(copy.id).not.toBe(original.id);
    expect(copy.title).toBe(`${original.title} (copy)`);
    expect(copy.contentHtml).toBe("<p>body</p>");
    expect(copy.folderId).toBe(folder.id);
    expect(copy.status).toBe("draft");

    // Independent: editing the copy leaves the original alone.
    await asOwner.patch(kbUrl(`/documents/${copy.id}`), {
      data: { contentHtml: "<p>changed</p>", contentText: "changed" },
      failOnStatusCode: false,
    });
    const reread = await (await asOwner.get(kbUrl(`/documents/${original.id}`))).json();
    expect(reread.contentHtml).toBe("<p>body</p>");
  });

  test("KB-A-21 a deleted document is soft-deleted and restored by an owner", { tag: '@tesbo.testId("TES-TC-353")' }, async () => {
    const doc = await createDocument({ title: stamp("Recoverable") });

    const deleted = await asOwner.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false });
    expect(deleted.status()).toBe(200);
    expect(isDeleted("knowledge_documents", doc.id)).toBe(true);
    expect((await asOwner.get(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })).status()).toBe(404);

    const restored = await asOwner.patch(kbUrl(`/documents/${doc.id}/restore`), { failOnStatusCode: false });
    expect(restored.status()).toBe(200);
    expect((await restored.json()).isDeleted).toBe(false);
    expect((await asOwner.get(kbUrl(`/documents/${doc.id}`))).status()).toBe(200);
  });

  test("KB-A-22 a document from another project is not reachable through this project's URL", { tag: '@tesbo.testId("TES-TC-354")' }, async () => {
    const created = await asOwner.post(kbUrl("/documents", tenant!.secondProjectId), {
      data: {
        title: stamp("Foreign doc"),
        folderId: (await (await asOwner.get(kbUrl("/folders/tree", tenant!.secondProjectId))).json()).id,
      },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const foreign = await created.json();

    for (const attempt of [
      asOwner.get(kbUrl(`/documents/${foreign.id}`), { failOnStatusCode: false }),
      asOwner.patch(kbUrl(`/documents/${foreign.id}`), { data: { title: "x" }, failOnStatusCode: false }),
      asOwner.patch(kbUrl(`/documents/${foreign.id}/move`), {
        data: { folderId: rootFolderId },
        failOnStatusCode: false,
      }),
      asOwner.post(kbUrl(`/documents/${foreign.id}/duplicate`), { failOnStatusCode: false }),
      asOwner.get(kbUrl(`/documents/${foreign.id}/versions`), { failOnStatusCode: false }),
      asOwner.delete(kbUrl(`/documents/${foreign.id}`), { failOnStatusCode: false }),
    ]) {
      const r = await attempt;
      expect(r.status(), `a cross-project document id answered ${r.status()}: ${await r.text()}`).toBe(404);
    }
    expect(scalar(`SELECT is_deleted FROM knowledge_documents WHERE id = ${literal(foreign.id)};`)).toBe("f");
  });

  test("KB-A-23 a malformed document id is a 404, not a 500", { tag: '@tesbo.testId("TES-TC-355")' }, async () => {
    for (const bad of ["not-a-uuid", "0"]) {
      for (const attempt of [
        asOwner.get(kbUrl(`/documents/${bad}`), { failOnStatusCode: false }),
        asOwner.get(kbUrl(`/documents/${bad}/versions`), { failOnStatusCode: false }),
        asOwner.patch(kbUrl(`/documents/${bad}`), { data: { title: "x" }, failOnStatusCode: false }),
        asOwner.post(kbUrl(`/documents/${bad}/duplicate`), { failOnStatusCode: false }),
        asOwner.delete(kbUrl(`/documents/${bad}`), { failOnStatusCode: false }),
      ]) {
        const res = await attempt;
        expect(
          res.status(),
          `document id "${bad}" answered ${res.status()}: ${await res.text()}`,
        ).toBeLessThan(500);
      }
    }
  });

  // ─── Versions ─────────────────────────────────────────────────────────────

  test("KB-A-24 editing a document snapshots the version it replaced, and the snapshot restores", { tag: '@tesbo.testId("TES-TC-356")' }, async () => {
    const doc = await createDocument({
      title: stamp("Versioned"),
      contentHtml: "<p>v1</p>",
      contentText: "v1",
    });

    // No edit yet, so no history.
    const before = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(before.total).toBe(0);

    const edited = await asOwner.patch(kbUrl(`/documents/${doc.id}`), {
      data: { contentHtml: "<p>v2</p>", contentText: "v2" },
      failOnStatusCode: false,
    });
    expect(edited.status()).toBe(200);
    expect((await edited.json()).contentHtml).toBe("<p>v2</p>");

    const versions = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(versions.total).toBe(1);
    // The snapshot holds what was there BEFORE the edit — that is the point of taking it.
    expect(versions.list[0].versionNumber).toBe(1);
    expect(versions.list[0].title).toBe(doc.title);

    const restored = await asOwner.post(kbUrl(`/documents/${doc.id}/restore-version`), {
      data: { versionId: versions.list[0].id },
      failOnStatusCode: false,
    });
    expect(restored.status()).toBe(201);
    expect((await restored.json()).contentHtml).toBe("<p>v1</p>");

    // Restoring is itself reversible: the pre-restore state was snapshotted too.
    const after = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(after.total).toBe(2);
    expect(after.list[0].versionNumber).toBe(2);
  });

  test("KB-A-25 a second edit inside the snapshot window does not take a second snapshot", { tag: '@tesbo.testId("TES-TC-357")' }, async () => {
    const doc = await createDocument({ title: stamp("Coalescing"), contentText: "a" });
    await asOwner.patch(kbUrl(`/documents/${doc.id}`), { data: { contentText: "b" }, failOnStatusCode: false });
    await asOwner.patch(kbUrl(`/documents/${doc.id}`), { data: { contentText: "c" }, failOnStatusCode: false });

    // KB_VERSION_SNAPSHOT_MINUTES is 15: two edits seconds apart share one snapshot, so a typing
    // session doesn't produce a version per keystroke.
    const versions = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(versions.total).toBe(1);
  });

  test("KB-A-26 an edit that changes nothing takes no snapshot at all", { tag: '@tesbo.testId("TES-TC-358")' }, async () => {
    const doc = await createDocument({ title: stamp("Unchanged"), contentText: "same", contentHtml: "<p>same</p>" });
    const res = await asOwner.patch(kbUrl(`/documents/${doc.id}`), {
      data: { title: doc.title, contentText: "same", contentHtml: "<p>same</p>" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const versions = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(versions.total).toBe(0);
  });

  test("KB-A-27 restore-version refuses a version id that belongs to another document", { tag: '@tesbo.testId("TES-TC-359")' }, async () => {
    const a = await createDocument({ title: stamp("Doc A"), contentText: "a1" });
    const b = await createDocument({ title: stamp("Doc B"), contentText: "b1" });
    await asOwner.patch(kbUrl(`/documents/${a.id}`), { data: { contentText: "a2" }, failOnStatusCode: false });
    const aVersions = await (await asOwner.get(kbUrl(`/documents/${a.id}/versions`))).json();

    const res = await asOwner.post(kbUrl(`/documents/${b.id}/restore-version`), {
      data: { versionId: aVersions.list[0].id },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("Version not found");

    for (const bad of [{}, { versionId: "" }, { versionId: "not-a-uuid" }]) {
      const bad404 = await asOwner.post(kbUrl(`/documents/${b.id}/restore-version`), {
        data: bad,
        failOnStatusCode: false,
      });
      expect(bad404.status(), `${JSON.stringify(bad)} — ${await bad404.text()}`).toBeLessThan(500);
    }
  });

  test("KB-A-60 two concurrent restore requests serialise instead of racing — no duplicate version_number, no 500", { tag: '@tesbo.testId("TES-TC-1923")' }, async () => {
    const doc = await createDocument({ title: stamp("Concurrent"), contentText: "v1" });
    await asOwner.patch(kbUrl(`/documents/${doc.id}`), { data: { contentText: "v2" }, failOnStatusCode: false });
    const before = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(before.total).toBe(1);
    const versionId = before.list[0].id;

    // Both requests target the same version. Whichever's transaction commits first snapshots the
    // "v2" it found and overwrites to "v1"; the second then finds current content already equal to
    // the version it's restoring (the no-op guard) and applies no second snapshot. Before the
    // advisory lock, both could instead read the same MAX(version_number) and either collide on the
    // new unique constraint (500) or silently insert two rows claiming the same number.
    const [a, b] = await Promise.all([
      asOwner.post(kbUrl(`/documents/${doc.id}/restore-version`), { data: { versionId }, failOnStatusCode: false }),
      asOwner.post(kbUrl(`/documents/${doc.id}/restore-version`), { data: { versionId }, failOnStatusCode: false }),
    ]);
    for (const res of [a, b]) expect(res.status(), await res.text()).toBe(201);

    const after = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    const numbers = after.list.map((v: { versionNumber: number }) => v.versionNumber);
    expect(new Set(numbers).size, `version numbers must be unique: ${JSON.stringify(numbers)}`).toBe(numbers.length);
    expect(after.total, "one real restore's snapshot, plus the no-op second restore taking none").toBe(2);

    const final = await (await asOwner.get(kbUrl(`/documents/${doc.id}`))).json();
    expect(final.contentText).toBe("v1");
  });

  test("KB-A-61 restoring a version whose content already matches the current document takes no new snapshot", { tag: '@tesbo.testId("TES-TC-1924")' }, async () => {
    const doc = await createDocument({ title: stamp("NoopRestore"), contentText: "same" });
    await asOwner.patch(kbUrl(`/documents/${doc.id}`), { data: { contentText: "changed" }, failOnStatusCode: false });
    // Back to "same" within the 15-minute coalescing window (KB-A-25) — still just the one snapshot,
    // holding "same", which is what the current document already reads again.
    await asOwner.patch(kbUrl(`/documents/${doc.id}`), { data: { contentText: "same" }, failOnStatusCode: false });
    const versions = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(versions.total).toBe(1);
    const versionId = versions.list[0].id;

    const restored = await asOwner.post(kbUrl(`/documents/${doc.id}/restore-version`), {
      data: { versionId },
      failOnStatusCode: false,
    });
    expect(restored.status(), await restored.text()).toBe(201);

    const after = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    expect(after.total, "an identical restore must not pile up a junk version").toBe(1);
  });

  test("KB-A-62 restore-version refuses a document that has been soft-deleted", { tag: '@tesbo.testId("TES-TC-1925")' }, async () => {
    const doc = await createDocument({ title: stamp("DeletedBeforeRestore"), contentText: "v1" });
    await asOwner.patch(kbUrl(`/documents/${doc.id}`), { data: { contentText: "v2" }, failOnStatusCode: false });
    const versions = await (await asOwner.get(kbUrl(`/documents/${doc.id}/versions`))).json();
    const versionId = versions.list[0].id;

    expect((await asOwner.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })).status()).toBe(200);

    const res = await asOwner.post(kbUrl(`/documents/${doc.id}/restore-version`), {
      data: { versionId },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("Document not found");
  });

  // ─── AI memory approval ───────────────────────────────────────────────────

  test("KB-A-28 an ai_memory document is approved, and re-editing it drops back to draft for review", { tag: '@tesbo.testId("TES-TC-360")' }, async () => {
    const doc = await createDocument({
      title: stamp("AI memory"),
      documentType: "ai_memory",
      contentText: "learned something",
    });
    expect(doc.status).toBe("draft");

    const approved = await asOwner.patch(kbUrl(`/documents/${doc.id}/approve-ai-memory`), {
      failOnStatusCode: false,
    });
    expect(approved.status()).toBe(200);
    const body = await approved.json();
    expect(body.status).toBe("approved");
    expect(body.reviewedBy).toBe(tenant!.owner.userId);
    expect(body.reviewedAt).toBeTruthy();

    // An approved memory that is then edited is no longer the thing that was approved.
    const edited = await asOwner.patch(kbUrl(`/documents/${doc.id}`), {
      data: { contentText: "learned something else" },
      failOnStatusCode: false,
    });
    expect(edited.status()).toBe(200);
    const after = await edited.json();
    expect(after.status).toBe("draft");
    expect(after.reviewedBy).toBeNull();
    expect(after.reviewedAt).toBeNull();
  });

  test("KB-A-29 an ai_memory document is rejected, and the status endpoints refuse a general document", { tag: '@tesbo.testId("TES-TC-361")' }, async () => {
    const memory = await createDocument({ title: stamp("Rejectable"), documentType: "ai_memory" });
    const rejected = await asOwner.patch(kbUrl(`/documents/${memory.id}/reject-ai-memory`), {
      failOnStatusCode: false,
    });
    expect(rejected.status()).toBe(200);
    expect((await rejected.json()).status).toBe("rejected");

    const general = await createDocument({ title: stamp("Just a doc") });
    for (const action of ["approve-ai-memory", "reject-ai-memory"]) {
      const res = await asOwner.patch(kbUrl(`/documents/${general.id}/${action}`), { failOnStatusCode: false });
      expect(res.status(), `${action} accepted a general document`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("AI memory documents");
    }
    // The general document's status was not moved by the refusal.
    expect((await (await asOwner.get(kbUrl(`/documents/${general.id}`))).json()).status).toBe("draft");
  });

  test("KB-A-30 an ai_memory document's status cannot be set through a plain update", { tag: '@tesbo.testId("TES-TC-362")' }, async () => {
    const memory = await createDocument({ title: stamp("Status guard"), documentType: "ai_memory" });
    const res = await asOwner.patch(kbUrl(`/documents/${memory.id}`), {
      data: { status: "approved" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    // Approval is an explicit review action; letting the generic update set it would bypass the
    // owner-or-manager gate on approve-ai-memory entirely.
    expect((await res.json()).status).toBe("draft");
    expect(scalar(`SELECT status FROM knowledge_documents WHERE id = ${literal(memory.id)};`)).toBe("draft");
  });

  test("KB-A-31 a general document's status is set through a plain update", { tag: '@tesbo.testId("TES-TC-363")' }, async () => {
    const doc = await createDocument({ title: stamp("Publishable") });
    const res = await asOwner.patch(kbUrl(`/documents/${doc.id}`), {
      data: { status: "published" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("published");
  });

  // ─── Search and summary ───────────────────────────────────────────────────

  test("KB-A-32 search finds folders and documents by name, and scopes to the requested type", { tag: '@tesbo.testId("TES-TC-364")' }, async () => {
    const marker = `kbs${Date.now()}`;
    const folder = await createFolder({ name: `Folder ${marker}` });
    const doc = await createDocument({
      title: `Document ${marker}`,
      folderId: folder.id,
      contentText: "some searchable prose",
    });

    const all = await (await asOwner.get(kbUrl(`/search?q=${marker}`))).json();
    const ids = all.list.map((i: any) => i.id);
    expect(ids).toContain(folder.id);
    expect(ids).toContain(doc.id);
    // Each hit carries the trail to it, so a result list can be rendered with locations.
    for (const hit of all.list) expect(Array.isArray(hit.breadcrumb)).toBe(true);

    const foldersOnly = await (await asOwner.get(kbUrl(`/search?q=${marker}&type=folder`))).json();
    expect(foldersOnly.list.map((i: any) => i.id)).toEqual([folder.id]);
    expect(foldersOnly.list[0].type).toBe("folder");

    const docsOnly = await (await asOwner.get(kbUrl(`/search?q=${marker}&type=document`))).json();
    expect(docsOnly.list.map((i: any) => i.id)).toEqual([doc.id]);
    expect(docsOnly.list[0]).not.toHaveProperty("searchVector");
  });

  test("KB-A-33 search matches document body text, not only the title", { tag: '@tesbo.testId("TES-TC-365")' }, async () => {
    const marker = `bodyword${Date.now()}`;
    const doc = await createDocument({
      title: stamp("Prose"),
      contentText: `a paragraph mentioning ${marker} in the middle`,
      contentHtml: `<p>a paragraph mentioning ${marker} in the middle</p>`,
    });

    const res = await (await asOwner.get(kbUrl(`/search?q=${marker}`))).json();
    expect(
      res.list.map((i: any) => i.id),
      "full-text search did not find a word that is only in the body",
    ).toContain(doc.id);
  });

  test("KB-A-34 an empty search term returns nothing rather than everything", { tag: '@tesbo.testId("TES-TC-366")' }, async () => {
    await createDocument({ title: stamp("Present") });
    for (const q of ["", "   "]) {
      const res = await asOwner.get(kbUrl(`/search?q=${encodeURIComponent(q)}`));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.list, `q="${q}" returned rows`).toEqual([]);
      expect(body.total).toBe(0);
    }
    // A term nothing matches is also empty, and does not fall back.
    const none = await (await asOwner.get(kbUrl("/search?q=zzzznomatchzzzz"))).json();
    expect(none.total).toBe(0);
  });

  test("KB-A-35 search excludes deleted items and does not cross into another project", { tag: '@tesbo.testId("TES-TC-367")' }, async () => {
    const marker = `del${Date.now()}`;
    const doc = await createDocument({ title: `Doomed ${marker}` });
    await asOwner.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false });
    const afterDelete = await (await asOwner.get(kbUrl(`/search?q=${marker}`))).json();
    expect(afterDelete.list.map((i: any) => i.id)).not.toContain(doc.id);

    // A document in the second project must not surface in the first project's search.
    const secondRoot = (await (await asOwner.get(kbUrl("/folders/tree", tenant!.secondProjectId))).json()).id;
    const foreignMarker = `frn${Date.now()}`;
    const foreign = await asOwner.post(kbUrl("/documents", tenant!.secondProjectId), {
      data: { title: `Foreign ${foreignMarker}`, folderId: secondRoot },
      failOnStatusCode: false,
    });
    expect(foreign.status()).toBe(201);
    const here = await (await asOwner.get(kbUrl(`/search?q=${foreignMarker}`))).json();
    expect(here.total).toBe(0);
  });

  test("KB-A-36 the summary counts folders, documents and files, excluding the root and deleted rows", { tag: '@tesbo.testId("TES-TC-368")' }, async () => {
    const empty = await (await asOwner.get(kbUrl("/summary"))).json();
    // The root folder is a container, not a listable item, so it is not counted.
    expect(empty).toEqual({ folders: 0, documents: 0, files: 0, total: 0 });

    const folder = await createFolder({ name: stamp("Counted") });
    await createFolder({ name: stamp("Counted-sub"), parentFolderId: folder.id });
    const doc = await createDocument({ title: stamp("Counted doc"), folderId: folder.id });

    const filled = await (await asOwner.get(kbUrl("/summary"))).json();
    expect(filled.folders).toBe(2);
    expect(filled.documents).toBe(1);
    expect(filled.total).toBe(filled.documents + filled.files);

    await asOwner.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false });
    const afterDelete = await (await asOwner.get(kbUrl("/summary"))).json();
    expect(afterDelete.documents).toBe(0);

    await asOwner.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false });
    const afterFolderDelete = await (await asOwner.get(kbUrl("/summary"))).json();
    expect(afterFolderDelete.folders, "the recursive delete's subfolder is still counted").toBe(0);
  });

  // ─── Export ───────────────────────────────────────────────────────────────

  test("KB-A-37 a folder exports as a zip whose entries mirror the folder structure", { tag: '@tesbo.testId("TES-TC-369")' }, async () => {
    const folder = await createFolder({ name: stamp("Exported") });
    const sub = await createFolder({ name: "Nested", parentFolderId: folder.id });
    await createDocument({
      title: "Top level doc",
      folderId: folder.id,
      contentHtml: "<p>top</p>",
    });
    await createDocument({ title: "Nested doc", folderId: sub.id, contentHtml: "<p>nested</p>" });

    const res = await asOwner.get(kbUrl(`/folders/${folder.id}/export`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/zip");
    expect(res.headers()["content-disposition"]).toContain(".zip");

    const zip = await res.body();
    const names = zipEntryNames(zip);
    expect(names).toContain("Top level doc.html");
    // Folder structure is preserved as directories, so a nested document keeps its path.
    expect(names).toContain("Nested/Nested doc.html");
    // Each document is a self-contained HTML file, not a fragment — it has to open on its own.
    const html = zipEntryText(zip, "Nested/Nested doc.html") ?? "";
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<p>nested</p>");
    expect(html).toContain("<title>Nested doc</title>");
  });

  test("KB-A-38 exporting the root folder is allowed and names the archive for the knowledge base", { tag: '@tesbo.testId("TES-TC-370")' }, async () => {
    await createDocument({ title: "Root level doc", contentHtml: "<p>x</p>" });
    const res = await asOwner.get(kbUrl(`/folders/${rootFolderId}/export`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain("Knowledge");
    expect(zipEntryNames(await res.body())).toContain("Root level doc.html");
  });

  test("KB-A-39 exporting an empty folder produces a valid, empty archive rather than an error", { tag: '@tesbo.testId("TES-TC-371")' }, async () => {
    const folder = await createFolder({ name: stamp("Nothing here") });
    const res = await asOwner.get(kbUrl(`/folders/${folder.id}/export`), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const zip = await res.body();
    // A valid archive with no entries — the end-of-central-directory record alone, 22 bytes. It has
    // to still parse as a zip, or the browser reports a corrupt download rather than an empty one.
    expect(zip.length).toBeGreaterThanOrEqual(22);
    expect(zipEntryNames(zip)).toEqual([]);
  });

  test("KB-A-40 export refuses an unknown folder and a folder in another project", { tag: '@tesbo.testId("TES-TC-372")' }, async () => {
    const unknown = await asOwner.get(kbUrl("/folders/11111111-1111-4111-8111-111111111111/export"), {
      failOnStatusCode: false,
    });
    expect(unknown.status()).toBe(404);

    const foreignRoot = (await (await asOwner.get(kbUrl("/folders/tree", tenant!.secondProjectId))).json()).id;
    const foreign = await asOwner.get(kbUrl(`/folders/${foreignRoot}/export`), { failOnStatusCode: false });
    expect(foreign.status()).toBe(404);
  });

  // ─── Authorization: no session ────────────────────────────────────────────

  test("KB-A-41 no knowledge-base v2 route answers a caller with no session", { tag: '@tesbo.testId("TES-TC-373")' }, async () => {
    const folder = await createFolder({ name: stamp("Guarded") });
    const doc = await createDocument({ title: stamp("Guarded doc"), folderId: folder.id });

    // Thunks, not promises: a list of already-started requests keeps firing after the first
    // assertion fails, and its tail then rejects with "Request context disposed" once afterAll
    // tears the contexts down — noise that buries the one real failure.
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["GET /folders/tree", () => anon.get(kbUrl("/folders/tree"), { failOnStatusCode: false })],
      ["GET /summary", () => anon.get(kbUrl("/summary"), { failOnStatusCode: false })],
      ["GET /search", () => anon.get(kbUrl("/search?q=x"), { failOnStatusCode: false })],
      ["GET /documents", () => anon.get(kbUrl("/documents"), { failOnStatusCode: false })],
      ["GET /folders/:id", () => anon.get(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false })],
      ["GET /folders/:id/items", () => anon.get(kbUrl(`/folders/${folder.id}/items`), { failOnStatusCode: false })],
      ["GET /folders/:id/export", () => anon.get(kbUrl(`/folders/${folder.id}/export`), { failOnStatusCode: false })],
      ["GET /documents/:id", () => anon.get(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })],
      [
        "GET /documents/:id/versions",
        () => anon.get(kbUrl(`/documents/${doc.id}/versions`), { failOnStatusCode: false }),
      ],
      ["POST /folders", () => anon.post(kbUrl("/folders"), { data: { name: "anon" }, failOnStatusCode: false })],
      [
        "POST /documents",
        () =>
          anon.post(kbUrl("/documents"), {
            data: { title: "anon", folderId: rootFolderId },
            failOnStatusCode: false,
          }),
      ],
      [
        "PATCH /folders/:id",
        () => anon.patch(kbUrl(`/folders/${folder.id}`), { data: { name: "anon" }, failOnStatusCode: false }),
      ],
      [
        "PATCH /folders/:id/move",
        () =>
          anon.patch(kbUrl(`/folders/${folder.id}/move`), {
            data: { parentFolderId: rootFolderId },
            failOnStatusCode: false,
          }),
      ],
      [
        "PATCH /folders/:id/restore",
        () => anon.patch(kbUrl(`/folders/${folder.id}/restore`), { failOnStatusCode: false }),
      ],
      ["DELETE /folders/:id", () => anon.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false })],
      [
        "PATCH /documents/:id",
        () => anon.patch(kbUrl(`/documents/${doc.id}`), { data: { title: "anon" }, failOnStatusCode: false }),
      ],
      [
        "PATCH /documents/:id/move",
        () =>
          anon.patch(kbUrl(`/documents/${doc.id}/move`), { data: { folderId: rootFolderId }, failOnStatusCode: false }),
      ],
      [
        "PATCH /documents/:id/restore",
        () => anon.patch(kbUrl(`/documents/${doc.id}/restore`), { failOnStatusCode: false }),
      ],
      [
        "POST /documents/:id/duplicate",
        () => anon.post(kbUrl(`/documents/${doc.id}/duplicate`), { failOnStatusCode: false }),
      ],
      [
        "POST /documents/:id/restore-version",
        () =>
          anon.post(kbUrl(`/documents/${doc.id}/restore-version`), {
            data: { versionId: "11111111-1111-4111-8111-111111111111" },
            failOnStatusCode: false,
          }),
      ],
      [
        "PATCH /documents/:id/approve-ai-memory",
        () => anon.patch(kbUrl(`/documents/${doc.id}/approve-ai-memory`), { failOnStatusCode: false }),
      ],
      [
        "PATCH /documents/:id/reject-ai-memory",
        () => anon.patch(kbUrl(`/documents/${doc.id}/reject-ai-memory`), { failOnStatusCode: false }),
      ],
      ["DELETE /documents/:id", () => anon.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })],
    ];

    for (const [what, attempt] of attempts) await expectUnauthenticated(await attempt(), what);

    // Nothing an anonymous caller sent through changed the fixtures.
    expect(isDeleted("knowledge_folders", folder.id)).toBe(false);
    expect(isDeleted("knowledge_documents", doc.id)).toBe(false);
    expect(scalar(`SELECT title FROM knowledge_documents WHERE id = ${literal(doc.id)};`)).toBe(doc.title);
  });

  // ─── Authorization: the wrong tenant, and the wrong project ───────────────

  test("KB-A-42 a workspace member with no project access is refused every knowledge-base route", { tag: '@tesbo.testId("TES-TC-374")' }, async () => {
    const folder = await createFolder({ name: stamp("Members only") });
    const doc = await createDocument({ title: stamp("Members only doc"), folderId: folder.id });

    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["tree", () => asGuest.get(kbUrl("/folders/tree"), { failOnStatusCode: false })],
      ["summary", () => asGuest.get(kbUrl("/summary"), { failOnStatusCode: false })],
      ["search", () => asGuest.get(kbUrl("/search?q=x"), { failOnStatusCode: false })],
      ["documents", () => asGuest.get(kbUrl("/documents"), { failOnStatusCode: false })],
      ["folder", () => asGuest.get(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false })],
      ["items", () => asGuest.get(kbUrl(`/folders/${folder.id}/items`), { failOnStatusCode: false })],
      ["export", () => asGuest.get(kbUrl(`/folders/${folder.id}/export`), { failOnStatusCode: false })],
      ["document", () => asGuest.get(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })],
      ["create folder", () => asGuest.post(kbUrl("/folders"), { data: { name: "guest" }, failOnStatusCode: false })],
      [
        "create document",
        () =>
          asGuest.post(kbUrl("/documents"), {
            data: { title: "guest", folderId: rootFolderId },
            failOnStatusCode: false,
          }),
      ],
      ["delete folder", () => asGuest.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false })],
      ["delete document", () => asGuest.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })],
    ];

    for (const [what, attempt] of attempts) {
      const res = await attempt();
      expect(
        [403, 404],
        `${what} answered a non-member of the project with ${res.status()}: ${await res.text()}`,
      ).toContain(res.status());
    }
    expect(isDeleted("knowledge_folders", folder.id)).toBe(false);
    expect(isDeleted("knowledge_documents", doc.id)).toBe(false);
  });

  // ─── The role matrix inside the project ───────────────────────────────────

  test("KB-A-43 a qa_engineer reads the knowledge base and creates in it", { tag: '@tesbo.testId("TES-TC-375")' }, async () => {
    const tree = await asQa.get(kbUrl("/folders/tree"), { failOnStatusCode: false });
    expect(tree.status()).toBe(200);
    expect((await asQa.get(kbUrl("/summary"), { failOnStatusCode: false })).status()).toBe(200);
    expect((await asQa.get(kbUrl("/search?q=x"), { failOnStatusCode: false })).status()).toBe(200);

    const folder = await createFolder({ name: stamp("QA folder") }, asQa);
    expect(folder.createdBy).toBe(tenant!.qa.userId);
    const doc = await createDocument({ title: stamp("QA doc"), folderId: folder.id }, asQa);
    expect(doc.createdBy).toBe(tenant!.qa.userId);
  });

  test("KB-A-44 a qa_engineer may edit and delete what they created, but not what someone else did", { tag: '@tesbo.testId("TES-TC-376")' }, async () => {
    const mine = await createFolder({ name: stamp("QA owns") }, asQa);
    const theirs = await createFolder({ name: stamp("Owner owns") });
    const myDoc = await createDocument({ title: stamp("QA doc"), folderId: mine.id }, asQa);
    const theirDoc = await createDocument({ title: stamp("Owner doc"), folderId: theirs.id });

    // Their own: allowed.
    expect(
      (
        await asQa.patch(kbUrl(`/folders/${mine.id}`), { data: { name: stamp("QA renamed") }, failOnStatusCode: false })
      ).status(),
    ).toBe(200);
    expect(
      (
        await asQa.patch(kbUrl(`/documents/${myDoc.id}`), { data: { title: stamp("QA retitled") }, failOnStatusCode: false })
      ).status(),
    ).toBe(200);

    // Someone else's: refused, with the reason the product gives.
    const folderRefusal = await asQa.patch(kbUrl(`/folders/${theirs.id}`), {
      data: { name: stamp("QA meddling") },
      failOnStatusCode: false,
    });
    expect(folderRefusal.status()).toBe(403);
    expect(JSON.stringify(await folderRefusal.json())).toContain("only modify items you created");

    for (const attempt of [
      asQa.patch(kbUrl(`/documents/${theirDoc.id}`), { data: { title: "no" }, failOnStatusCode: false }),
      asQa.patch(kbUrl(`/documents/${theirDoc.id}/move`), { data: { folderId: mine.id }, failOnStatusCode: false }),
      asQa.delete(kbUrl(`/documents/${theirDoc.id}`), { failOnStatusCode: false }),
      asQa.delete(kbUrl(`/folders/${theirs.id}`), { failOnStatusCode: false }),
      asQa.patch(kbUrl(`/folders/${theirs.id}/move`), { data: { parentFolderId: mine.id }, failOnStatusCode: false }),
    ]) {
      const res = await attempt;
      expect(res.status(), `a qa_engineer got ${res.status()} on someone else's item`).toBe(403);
    }
    expect(isDeleted("knowledge_folders", theirs.id)).toBe(false);
    expect(scalar(`SELECT title FROM knowledge_documents WHERE id = ${literal(theirDoc.id)};`)).toBe(theirDoc.title);

    // Their own delete does go through.
    expect((await asQa.delete(kbUrl(`/documents/${myDoc.id}`), { failOnStatusCode: false })).status()).toBe(200);
  });

  test("KB-A-45 a manager edits and deletes anyone's items", { tag: '@tesbo.testId("TES-TC-377")' }, async () => {
    const theirs = await createFolder({ name: stamp("Owner's") });
    const theirDoc = await createDocument({ title: stamp("Owner's doc"), folderId: theirs.id });

    expect(
      (
        await asManager.patch(kbUrl(`/documents/${theirDoc.id}`), {
          data: { title: stamp("Manager retitled") },
          failOnStatusCode: false,
        })
      ).status(),
    ).toBe(200);
    expect((await asManager.delete(kbUrl(`/folders/${theirs.id}`), { failOnStatusCode: false })).status()).toBe(200);
    expect(isDeleted("knowledge_folders", theirs.id)).toBe(true);
  });

  test("KB-A-46 restore-from-trash and AI-memory review are owner-or-manager only", { tag: '@tesbo.testId("TES-TC-378")' }, async () => {
    const folder = await createFolder({ name: stamp("QA's own") }, asQa);
    const doc = await createDocument({ title: stamp("QA's own doc"), folderId: folder.id }, asQa);
    // Deliberately in the root, not in `folder`: the folder is deleted below, and a delete cascades
    // to the documents inside it (KB-A-46b) — which would make the review calls 404 on a missing
    // document instead of 403 on the role, passing for the wrong reason.
    const memory = await createDocument(
      { title: stamp("QA's memory"), documentType: "ai_memory", folderId: rootFolderId },
      asQa,
    );

    // A qa_engineer may delete what they created...
    expect((await asQa.delete(kbUrl(`/documents/${doc.id}`), { failOnStatusCode: false })).status()).toBe(200);
    // ...but restoring is a separate gate — kbRequireOwnerOrManager, not kbRequireMutateAccess —
    // so they cannot pull their own item back out of the trash.
    const restore = await asQa.patch(kbUrl(`/documents/${doc.id}/restore`), { failOnStatusCode: false });
    expect(restore.status()).toBe(403);
    expect(JSON.stringify(await restore.json())).toContain("owners and managers");
    expect(isDeleted("knowledge_documents", doc.id)).toBe(true);

    await asQa.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false });
    expect((await asQa.patch(kbUrl(`/folders/${folder.id}/restore`), { failOnStatusCode: false })).status()).toBe(403);

    // Same gate on the review actions, even on a document the qa_engineer created.
    for (const action of ["approve-ai-memory", "reject-ai-memory"]) {
      const res = await asQa.patch(kbUrl(`/documents/${memory.id}/${action}`), { failOnStatusCode: false });
      expect(res.status(), `${action} let a qa_engineer through`).toBe(403);
    }
    expect(scalar(`SELECT status FROM knowledge_documents WHERE id = ${literal(memory.id)};`)).toBe("draft");

    // A manager is allowed both.
    expect(
      (await asManager.patch(kbUrl(`/documents/${memory.id}/approve-ai-memory`), { failOnStatusCode: false })).status(),
    ).toBe(200);
    expect((await asManager.patch(kbUrl(`/documents/${doc.id}/restore`), { failOnStatusCode: false })).status()).toBe(200);
  });

  test("KB-A-46b restoring a folder does not bring its contents back — each item is restored on its own", { tag: '@tesbo.testId("TES-TC-930")' }, async () => {
    const folder = await createFolder({ name: stamp("Trashed together") });
    const doc = await createDocument({ title: stamp("Went with it"), folderId: folder.id });

    // Deleting the folder cascades: the document inside goes with it (KB-A-05 pins that half).
    await asOwner.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false });
    expect(isDeleted("knowledge_documents", doc.id)).toBe(true);

    // Restoring the folder does NOT cascade back. This asymmetry is worth pinning rather than
    // discovering: a folder pulled out of the trash comes back EMPTY, and someone who restores it
    // and sees nothing has no reason to think the documents are still recoverable one by one.
    const restored = await asOwner.patch(kbUrl(`/folders/${folder.id}/restore`), { failOnStatusCode: false });
    expect(restored.status()).toBe(200);
    expect(isDeleted("knowledge_folders", folder.id)).toBe(false);
    expect(isDeleted("knowledge_documents", doc.id)).toBe(true);

    const items = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items`))).json();
    expect(items.items, "the restored folder came back with its contents").toEqual([]);

    // The document is still individually recoverable, which is what makes the above survivable.
    expect((await asOwner.patch(kbUrl(`/documents/${doc.id}/restore`), { failOnStatusCode: false })).status()).toBe(200);
    const afterItemRestore = await (await asOwner.get(kbUrl(`/folders/${folder.id}/items`))).json();
    expect(afterItemRestore.items.map((i: any) => i.id)).toEqual([doc.id]);
  });

  test("KB-A-47 a project role of manager is what grants the wider access, not the workspace role", { tag: '@tesbo.testId("TES-TC-380")' }, async () => {
    // The qa_engineer is promoted inside the PROJECT only; their workspace role stays qa_engineer.
    // kbProjectRole reads project_members, so this must be enough to widen what they may edit.
    const theirs = await createFolder({ name: stamp("Owner's again") });
    try {
      setProjectRole(tenant!.mainProjectId, tenant!.qa.userId, "manager");
      const res = await asQa.patch(kbUrl(`/folders/${theirs.id}`), {
        data: { name: stamp("Now allowed") },
        failOnStatusCode: false,
      });
      expect(res.status(), `a project-level manager was refused: ${await res.text()}`).toBe(200);
    } finally {
      setProjectRole(tenant!.mainProjectId, tenant!.qa.userId, "qa_engineer");
    }
  });

  // ─── Read-only provider mirrors ───────────────────────────────────────────

  test("KB-A-48 a document synced from a provider refuses body edits and says why", { tag: '@tesbo.testId("TES-TC-381")' }, async () => {
    const doc = await createDocument({ title: stamp("Jira mirror"), contentText: "mirrored" });
    // Arranged in Postgres: is_read_only is set by the integration sync, which needs a live Jira.
    exec(
      `UPDATE knowledge_documents SET is_read_only = true, source_provider = 'jira' ` +
        `WHERE id = ${literal(doc.id)};`,
    );

    const res = await asOwner.patch(kbUrl(`/documents/${doc.id}`), {
      data: { contentText: "edited by hand" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    const message = JSON.stringify(await res.json());
    expect(message).toContain("synced from Jira");
    // The message has to name the alternative, because the editor offers no other route.
    expect(message).toContain("comment");
    expect(scalar(`SELECT content_text FROM knowledge_documents WHERE id = ${literal(doc.id)};`)).toBe("mirrored");

    // Moving and deleting a mirror are still allowed — only the body is provider-owned.
    const elsewhere = await createFolder({ name: stamp("Mirror home") });
    expect(
      (
        await asOwner.patch(kbUrl(`/documents/${doc.id}/move`), {
          data: { folderId: elsewhere.id },
          failOnStatusCode: false,
        })
      ).status(),
    ).toBe(200);
  });

  // ─── Knowledge Base v1 (the superseded flat notes surface) ────────────────

  test("KB-A-49 the v1 notes surface stores and reads a note", { tag: '@tesbo.testId("TES-TC-382")' }, async () => {
    const title = stamp("v1 note");
    const created = await asOwner.post(kbUrl(""), {
      data: { title, content: "v1 body" },
      failOnStatusCode: false,
    });
    expect(created.status()).toBe(201);
    const note = await created.json();
    expect(note.title).toBe(title);
    expect(note.itemType).toBe("note");

    const list = await asOwner.get(kbUrl(""), { failOnStatusCode: false });
    expect(list.status()).toBe(200);
    expect((await list.json()).list.map((i: any) => i.id)).toContain(note.id);

    const read = await asOwner.get(kbUrl(`/${note.id}`), { failOnStatusCode: false });
    expect(read.status()).toBe(200);
    expect((await read.json()).content).toBe("v1 body");

    const updated = await asOwner.patch(kbUrl(`/${note.id}`), {
      data: { title: `${title} edited` },
      failOnStatusCode: false,
    });
    expect(updated.status()).toBe(200);
    expect(scalar(`SELECT title FROM knowledge_base_items WHERE id = ${literal(note.id)};`)).toBe(`${title} edited`);

    const deleted = await asOwner.delete(kbUrl(`/${note.id}`), { failOnStatusCode: false });
    expect(deleted.status()).toBe(200);
    expect(scalar(`SELECT COUNT(*) FROM knowledge_base_items WHERE id = ${literal(note.id)};`)).toBe("0");
  });

  test("KB-A-50 the v1 notes list filters by type and search", { tag: '@tesbo.testId("TES-TC-383")' }, async () => {
    const marker = `v1s${Date.now()}`;
    const match = await asOwner.post(kbUrl(""), {
      data: { title: `Note ${marker}`, content: "body" },
      failOnStatusCode: false,
    });
    const matchId = (await match.json()).id;
    await asOwner.post(kbUrl(""), { data: { title: stamp("Other note"), content: "x" }, failOnStatusCode: false });

    try {
      const searched = await (await asOwner.get(kbUrl(`?search=${marker}`))).json();
      expect(searched.list.map((i: any) => i.id)).toEqual([matchId]);

      const byType = await (await asOwner.get(kbUrl("?type=note"))).json();
      expect(byType.list.map((i: any) => i.id)).toContain(matchId);

      const wrongType = await (await asOwner.get(kbUrl("?type=no-such-type"))).json();
      expect(wrongType.list).toEqual([]);
    } finally {
      exec(`DELETE FROM knowledge_base_items WHERE project_id = ${literal(tenant!.mainProjectId)};`);
    }
  });

  test("KB-A-51 the v1 notes surface does not answer a caller with no session", { tag: '@tesbo.testId("TES-TC-384")' }, async () => {
    const created = await asOwner.post(kbUrl(""), {
      data: { title: stamp("v1 guarded"), content: "secret" },
      failOnStatusCode: false,
    });
    const note = await created.json();

    try {
      const attempts: Array<[string, () => Promise<APIResponse>]> = [
        ["GET /knowledge-base", () => anon.get(kbUrl(""), { failOnStatusCode: false })],
        ["POST /knowledge-base", () => anon.post(kbUrl(""), { data: { title: "anon" }, failOnStatusCode: false })],
        ["GET /knowledge-base/:itemId", () => anon.get(kbUrl(`/${note.id}`), { failOnStatusCode: false })],
        [
          "PATCH /knowledge-base/:itemId",
          () => anon.patch(kbUrl(`/${note.id}`), { data: { title: "anon rewrote this" }, failOnStatusCode: false }),
        ],
        ["DELETE /knowledge-base/:itemId", () => anon.delete(kbUrl(`/${note.id}`), { failOnStatusCode: false })],
      ];
      for (const [what, attempt] of attempts) await expectUnauthenticated(await attempt(), what);

      // And the note is untouched — the refusal has to be before the write, not after it.
      expect(scalar(`SELECT title FROM knowledge_base_items WHERE id = ${literal(note.id)};`)).toBe(
        (await created.json()).title,
      );
    } finally {
      exec(`DELETE FROM knowledge_base_items WHERE id = ${literal(note.id)};`);
    }
  });

  test("KB-A-52 the v1 notes surface does not answer a member of another project", { tag: '@tesbo.testId("TES-TC-385")' }, async () => {
    const created = await asOwner.post(kbUrl(""), {
      data: { title: stamp("v1 scoped"), content: "secret" },
      failOnStatusCode: false,
    });
    const note = await created.json();

    try {
      for (const attempt of [
        asGuest.get(kbUrl(""), { failOnStatusCode: false }),
        asGuest.get(kbUrl(`/${note.id}`), { failOnStatusCode: false }),
        asGuest.patch(kbUrl(`/${note.id}`), { data: { title: "guest rewrote this" }, failOnStatusCode: false }),
        asGuest.delete(kbUrl(`/${note.id}`), { failOnStatusCode: false }),
      ]) {
        const res = await attempt;
        expect(
          [403, 404],
          `the v1 notes surface answered a non-member with ${res.status()}: ${await res.text()}`,
        ).toContain(res.status());
      }
      expect(scalar(`SELECT COUNT(*) FROM knowledge_base_items WHERE id = ${literal(note.id)};`)).toBe("1");
    } finally {
      exec(`DELETE FROM knowledge_base_items WHERE id = ${literal(note.id)};`);
    }
  });

  test("KB-A-53 the v1 upload endpoint reports that it is not implemented rather than pretending to work", { tag: '@tesbo.testId("TES-TC-386")' }, async () => {
    const res = await asOwner.post(kbUrl("/upload"), { data: {}, failOnStatusCode: false });
    // Whatever it answers, it must not claim success — an upload UI wired to a stub that returns 2xx
    // with no row is worse than one that reports the truth.
    if (res.status() < 300) {
      const body = await res.json();
      expect(body.error, "the v1 upload stub answered 2xx with no error field").toBeTruthy();
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
    expect(
      scalar(
        `SELECT COUNT(*) FROM knowledge_base_items WHERE project_id = ${literal(tenant!.mainProjectId)};`,
      ),
    ).toBe("0");
  });

  test("KB-A-54 the v1 per-item file route does not leak another project's item", { tag: '@tesbo.testId("TES-TC-387")' }, async () => {
    const created = await asOwner.post(kbUrl(""), {
      data: { title: stamp("v1 file item"), content: "x" },
      failOnStatusCode: false,
    });
    const note = await created.json();
    try {
      const res = await anon.get(kbUrl(`/${note.id}/file`), { failOnStatusCode: false });
      await expectUnauthenticated(res, "GET /knowledge-base/:itemId/file");
    } finally {
      exec(`DELETE FROM knowledge_base_items WHERE id = ${literal(note.id)};`);
    }
  });
  // ─── The agent-managed memory document ────────────────────────────────────

  /*
   * Basecamp 10212786541 — "Zyra ai Memory > Able to delete AI memory doc from knowledge base".
   *
   * Zyra keeps its project memory in a knowledge document titled exactly "Zyra AI Memory". It is a
   * real document on purpose (pinned into RAG context, and readable so a team can see what Zyra has
   * learned) but it is not a user document: deleting it discards everything Zyra remembers, and a
   * RENAME is worse than a delete — rememberZyraMemory and zyraMemoryText both find it BY TITLE, so a
   * renamed document is silently abandoned and a second, empty memory starts beside it.
   *
   * All three tests fail against the unfixed code, where the document had no protection at all.
   */
  const ZYRA_MEMORY_TITLE = "Zyra AI Memory";

  test("KB-A-55 the Zyra memory document cannot be deleted or renamed", { tag: '@tesbo.testId("TES-TC-931")' }, async () => {
    // Created with the real title, which is the only thing the guard keys on.
    const memory = await createDocument({ title: ZYRA_MEMORY_TITLE });
    try {
      const deleted = await asOwner.delete(kbUrl(`/documents/${memory.id}`), { failOnStatusCode: false });
      expect(
        deleted.status(),
        `deleting Zyra's memory answered ${deleted.status()}: ${await deleted.text()}`,
      ).toBeGreaterThanOrEqual(400);
      expect(isDeleted("knowledge_documents", memory.id), "Zyra's memory was deleted").toBe(false);

      const renamed = await asOwner.patch(kbUrl(`/documents/${memory.id}`), {
        data: { title: "Team notes" },
        failOnStatusCode: false,
      });
      expect(
        renamed.status(),
        `renaming Zyra's memory answered ${renamed.status()}: ${await renamed.text()}`,
      ).toBeGreaterThanOrEqual(400);
      expect(
        scalar(`SELECT title FROM knowledge_documents WHERE id = ${literal(memory.id)};`),
        "Zyra's memory was renamed, which detaches it from the agent",
      ).toBe(ZYRA_MEMORY_TITLE);
    } finally {
      // The guard is the point of the test, so the row is removed directly rather than through the API.
      exec(`DELETE FROM knowledge_documents WHERE id = ${literal(memory.id)};`);
    }
  });

  test("KB-A-56 its body is still editable, and ordinary documents are still deletable", { tag: '@tesbo.testId("TES-TC-932")' }, async () => {
    // The protection is deliberately narrow: the document is readable and writable content-wise
    // (rememberZyraMemory prepends to whatever is there), and nothing else changed about the KB.
    const memory = await createDocument({ title: ZYRA_MEMORY_TITLE });
    const ordinary = await createDocument({ title: stamp("Ordinary doc") });
    try {
      const edited = await asOwner.patch(kbUrl(`/documents/${memory.id}`), {
        data: { contentText: "Zyra learned something." },
        failOnStatusCode: false,
      });
      expect(edited.status(), `editing the memory body — ${await edited.text()}`).toBeLessThan(400);

      const deleted = await asOwner.delete(kbUrl(`/documents/${ordinary.id}`), { failOnStatusCode: false });
      expect(deleted.status(), `deleting an ordinary doc — ${await deleted.text()}`).toBeLessThan(400);
      expect(isDeleted("knowledge_documents", ordinary.id)).toBe(true);
    } finally {
      exec(`DELETE FROM knowledge_documents WHERE id IN (${literal(memory.id)}, ${literal(ordinary.id)});`);
    }
  });

  test("KB-A-57 deleting the folder it sits in does not take the memory document with it", { tag: '@tesbo.testId("TES-TC-933")' }, async () => {
    /*
     * The folder cascade soft-deletes every document under the folder in one statement, which was a
     * way around the per-document guard: delete the AI memory folder, lose the memory. It is now
     * excluded from the cascade AND re-homed to the root, because a surviving document pointing at a
     * deleted folder would appear in no listing — kept but invisible is worse than a clear refusal.
     */
    const folder = await createFolder({ name: stamp("AI memory folder") });
    const memory = await createDocument({ title: ZYRA_MEMORY_TITLE, folderId: folder.id });
    const sibling = await createDocument({ title: stamp("Sibling doc"), folderId: folder.id });
    try {
      const res = await asOwner.delete(kbUrl(`/folders/${folder.id}`), { failOnStatusCode: false });
      expect(res.status(), `deleting the folder — ${await res.text()}`).toBeLessThan(400);

      // The sibling goes, as it always did — the cascade still works.
      expect(isDeleted("knowledge_documents", sibling.id), "the cascade stopped working").toBe(true);
      // The memory survives, and is reachable rather than orphaned under a deleted folder.
      expect(isDeleted("knowledge_documents", memory.id), "Zyra's memory died with its folder").toBe(false);
      const parent = scalar(
        `SELECT coalesce(f.is_root::text, 'no-folder') FROM knowledge_documents d ` +
          `LEFT JOIN knowledge_folders f ON f.id = d.folder_id WHERE d.id = ${literal(memory.id)};`,
      );
      // "true", not "t": the query casts with `is_root::text`, and boolean::text renders as
      // true/false. "t" is only psql's display form for an *uncast* boolean column.
      expect(parent, "Zyra's memory was left pointing at a deleted folder").toBe("true");

      // And Zyra can still find it, which is the whole point: it is looked up by title.
      const listed = await asOwner.get(kbUrl("/documents"), { failOnStatusCode: false });
      expect(listed.status()).toBe(200);
      expect(
        (await listed.json()).some((d: { id: string }) => d.id === memory.id),
        "Zyra's memory survived but is no longer listed anywhere",
      ).toBe(true);
    } finally {
      exec(`DELETE FROM knowledge_documents WHERE id IN (${literal(memory.id)}, ${literal(sibling.id)});`);
      exec(`DELETE FROM knowledge_folders WHERE id = ${literal(folder.id)};`);
    }
  });
  // ─── Folder name length, and what a folder reports as its size ────────────

  test("KB-A-58 an over-long folder name is refused with a 400, never a 500", { tag: '@tesbo.testId("TES-TC-934")' }, async () => {
    /*
     * Basecamp 10199204536 — "[Knowledge Base → Folders] Internal Server Error occurs when renaming a
     * folder with a long name". `knowledge_folders.name` is VARCHAR(255) and neither create nor rename
     * bounded the input, so a longer name reached Postgres, raised 22001
     * (string_data_right_truncation), and — no handler catching that code — answered 500.
     *
     * The enforced limit is the product cap, KB_FOLDER_NAME_MAX_LENGTH = 50, not the column width:
     * folder names render in narrow tree/breadcrumb UI, and the frontend refuses at the same 50 via
     * lib/validation.ts. The boundary asserted here moved from 255 to 50 with that cap — the 500 this
     * ticket reported is still pinned by the 256-character case below, which now has to be a 400 for
     * the product reason before it can ever reach the column.
     *
     * Both paths are asserted: rename is what was reported, create had the identical gap.
     */
    const folder = await createFolder({ name: stamp("Rename target") });
    const overCap = "L".repeat(51);
    const overColumn = "L".repeat(256);
    try {
      const renamed = await asOwner.patch(kbUrl(`/folders/${folder.id}`), {
        data: { name: overCap },
        failOnStatusCode: false,
      });
      expect(
        renamed.status(),
        `renaming to a 51-character name answered ${renamed.status()}: ${await renamed.text()}`,
      ).toBe(400);
      // The message has to name the limit, or the user cannot tell what to shorten it to.
      expect(await renamed.text()).toMatch(/at most 50 characters/i);
      // And nothing was written.
      expect(scalar(`SELECT name FROM knowledge_folders WHERE id = ${literal(folder.id)};`)).not.toBe(overCap);

      // The original repro — longer than the column itself — must still be a 400, never a 500.
      const renamedLong = await asOwner.patch(kbUrl(`/folders/${folder.id}`), {
        data: { name: overColumn },
        failOnStatusCode: false,
      });
      expect(
        renamedLong.status(),
        `renaming to a 256-character name answered ${renamedLong.status()}: ${await renamedLong.text()}`,
      ).toBe(400);
      expect(scalar(`SELECT name FROM knowledge_folders WHERE id = ${literal(folder.id)};`)).not.toBe(overColumn);

      const created = await asOwner.post(kbUrl("/folders"), {
        data: { name: overCap, parentFolderId: rootFolderId },
        failOnStatusCode: false,
      });
      expect(created.status(), `creating a 51-character name answered ${created.status()}`).toBe(400);

      // The boundary itself is accepted — 50 is a legal name, so the guard must be off-by-none.
      const atLimit = "A".repeat(50);
      const ok = await asOwner.patch(kbUrl(`/folders/${folder.id}`), {
        data: { name: atLimit },
        failOnStatusCode: false,
      });
      expect(ok.status(), `a 50-character name was refused — ${await ok.text()}`).toBeLessThan(400);
      expect(scalar(`SELECT name FROM knowledge_folders WHERE id = ${literal(folder.id)};`)).toBe(atLimit);
    } finally {
      exec(`DELETE FROM knowledge_folders WHERE id = ${literal(folder.id)};`);
    }
  });

  test("KB-A-59 a folder reports the size and document count of everything beneath it", { tag: '@tesbo.testId("TES-TC-935")' }, async () => {
    /*
     * Basecamp 10199231000 — "Folder size is not displayed in Knowledge Base even when documents are
     * present". The folders branch of listKnowledgeFolderItems was a bare `SELECT kf.*`, so a folder row
     * carried no size at all and the table rendered "—" for every one.
     *
     * Recursive on purpose: a total that stopped at direct children would under-report any folder whose
     * content sits in a subfolder, which is the normal shape once a KB is organised. Documents are text
     * rows with no file behind them, so they are counted rather than folded into the byte figure.
     */
    const parent = await createFolder({ name: stamp("Sized parent") });
    const child = await createFolder({ name: stamp("Sized child"), parentFolderId: parent.id });
    const docs = [
      await createDocument({ title: stamp("Direct doc"), folderId: parent.id, contentText: "x".repeat(120) }),
      await createDocument({ title: stamp("Nested doc"), folderId: child.id, contentText: "y".repeat(80) }),
    ];
    try {
      const listed = await asOwner.get(kbUrl(`/folders/${rootFolderId}/items`), { failOnStatusCode: false });
      expect(listed.status(), `listing the root — ${await listed.text()}`).toBe(200);
      const row = (await listed.json()).items.find((i: { id: string }) => i.id === parent.id);
      expect(row, "the parent folder is not in the root listing").toBeTruthy();

      // Both documents counted, including the one nested a level down.
      expect(
        row.documentCount,
        "the folder does not report the documents beneath it — the Size column stays blank",
      ).toBe(2);
      // No files were uploaded, so the byte total is 0 rather than absent.
      expect(row.fileBytes, "fileBytes is missing from the folder row").toBe(0);
      expect(row.fileCount).toBe(0);

      // A document reports its own text length, so a docs-only folder is not blank either.
      const inParent = await asOwner.get(kbUrl(`/folders/${parent.id}/items`), { failOnStatusCode: false });
      const docRow = (await inParent.json()).items.find((i: { id: string }) => i.id === docs[0].id);
      expect(docRow.fileSize, "a document reports no size").toBe(120);
    } finally {
      exec(`DELETE FROM knowledge_documents WHERE id IN (${docs.map((d) => literal(d.id)).join(", ")});`);
      exec(`DELETE FROM knowledge_folders WHERE id IN (${literal(child.id)}, ${literal(parent.id)});`);
    }
  });
});
