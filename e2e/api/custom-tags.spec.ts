import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { addRunCases, seedRun } from "../utils/seed";

/*
 * Project custom tags: the Owner/Manager-curated catalog (/api/projects/:id/custom-tags), test case
 * assignment (the testcase create/update body's customTagIds, and GET .../tags to read them back),
 * and the Execution Report's Group by Tags, now keyed on this catalog instead of the free-text
 * automation_tags column.
 *
 * Runs against its own disposable tenant ("custom-tags") since it asserts on QA-Engineer 403s and
 * on a second project's 404s, same reasoning as api/custom-fields.spec.ts.
 */

test.describe("custom tags", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("custom-tags");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    purgeFixtures(tenant);
  });

  test.afterAll(async () => {
    if (tenant) purgeFixtures(tenant);
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
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
    // Child-before-parent: executions.cycle_item_id and cycle_items.cycle_id are both ON DELETE
    // RESTRICT (V111), so a cycle created by the Execution Report test below has to be unwound
    // before the test cases it ran can be deleted.
    exec(
      "DELETE FROM executions WHERE cycle_item_id IN (SELECT ci.id FROM cycle_items ci JOIN cycles c " +
        `ON c.id = ci.cycle_id WHERE c.project_id IN (${projects}));`,
    );
    exec(`DELETE FROM cycle_items WHERE cycle_id IN (SELECT id FROM cycles WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM cycles WHERE project_id IN (${projects});`);
    exec(`DELETE FROM testcases WHERE project_id IN (${projects});`);
    exec(`DELETE FROM custom_tags WHERE project_id IN (${projects});`);
  }

  function tagsUrl(projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/custom-tags`;
  }

  function tagUrl(tagId: string, projectId?: string): string {
    return `${tagsUrl(projectId)}/${tagId}`;
  }

  function testcasesUrl(projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/testcases`;
  }

  function testcaseTagsUrl(testcaseId: string, projectId?: string): string {
    return `${testcasesUrl(projectId)}/${testcaseId}/tags`;
  }

  /** Names are stamped so a re-run against the persistent volume can't collide on the unique index. */
  function tagName(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function post(api: APIRequestContext, body: Record<string, unknown>, projectId?: string): Promise<APIResponse> {
    return api.post(tagsUrl(projectId), { data: body, failOnStatusCode: false });
  }

  async function createTag(body: Record<string, unknown> = {}, api: APIRequestContext = asOwner, projectId?: string): Promise<any> {
    const res = await post(api, { name: tagName("Tag"), ...body }, projectId);
    expect(res.status(), `creating ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function listTags(api: APIRequestContext = asOwner, projectId?: string): Promise<any[]> {
    const res = await api.get(tagsUrl(projectId));
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  async function createTestCase(data: Record<string, unknown> = {}, api: APIRequestContext = asOwner): Promise<any> {
    const res = await api.post(testcasesUrl(), {
      data: { title: `E2E Custom Tag Case ${Date.now()}${Math.floor(Math.random() * 1000)}`, ...data },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  async function getTestCaseTags(testcaseId: string, api: APIRequestContext = asOwner): Promise<any[]> {
    const res = await api.get(testcaseTagsUrl(testcaseId));
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  function tagExists(tagId: string): boolean {
    return scalar(`SELECT COUNT(*) FROM custom_tags WHERE id = ${literal(tagId)};`) === "1";
  }

  // ─── Managing the catalog ───────────────────────────────────────────────────

  test("an owner creates, lists and deletes a tag", async () => {
    const tag = await createTag({ name: tagName("Regression") });
    expect(tag.projectId).toBe(tenant!.mainProjectId);

    const listed = await listTags();
    expect(listed.map((t) => t.id)).toContain(tag.id);

    const deleted = await asOwner.delete(tagUrl(tag.id), { failOnStatusCode: false });
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    expect((await listTags()).map((t) => t.id)).not.toContain(tag.id);
  });

  test("a name is required, and whitespace does not count as one", async () => {
    for (const name of [undefined, "", "   ", "\t\n"]) {
      const res = await post(asOwner, { name });
      expect(res.status(), `name ${JSON.stringify(name)}`).toBe(400);
    }
  });

  test("a name is accepted up to the column limit and refused beyond it", async () => {
    const atLimit = await createTag({ name: "E".repeat(40) });
    expect(atLimit.name).toHaveLength(40);

    const overLimit = await post(asOwner, { name: "E".repeat(41) });
    expect(overLimit.status(), await overLimit.text()).toBe(400);
  });

  test("names collide case-insensitively within a project, but not across projects", async () => {
    const name = tagName("Duplicate");
    const first = await createTag({ name });

    const clash = await post(asOwner, { name: name.toUpperCase() });
    expect(clash.status()).toBe(400);
    expect((await clash.json()).error).toContain("already exists");

    // The same name is free in a different project.
    const otherProject = await createTag({ name }, asOwner, tenant!.secondProjectId);
    expect(otherProject.id).not.toBe(first.id);
  });

  test("deleting an unknown or malformed id is a 404, not a 500", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await asOwner.delete(tagUrl(id), { failOnStatusCode: false });
      expect(res.status(), `DELETE ${id}`).toBe(404);
    }
  });

  test("deleting the same tag twice: the second call finds nothing to delete and 404s", async () => {
    const tag = await createTag();
    const first = await asOwner.delete(tagUrl(tag.id), { failOnStatusCode: false });
    expect(first.ok()).toBeTruthy();
    const second = await asOwner.delete(tagUrl(tag.id), { failOnStatusCode: false });
    expect(second.status()).toBe(404);
  });

  test("deleting a tag that's assigned to test cases removes the assignment, not the test case", async () => {
    const tag = await createTag();
    const testcase = await createTestCase({ customTagIds: [tag.id] });
    expect((await getTestCaseTags(testcase.id)).map((t) => t.id)).toEqual([tag.id]);

    await asOwner.delete(tagUrl(tag.id));
    expect(await getTestCaseTags(testcase.id)).toEqual([]);

    const stillThere = await asOwner.get(`${testcasesUrl()}/${testcase.id}`, { failOnStatusCode: false });
    expect(stillThere.ok()).toBeTruthy();
  });

  // ─── Assigning tags to a test case ──────────────────────────────────────────

  test("tags assigned on create are saved and remain visible on read", async () => {
    const [a, b] = await Promise.all([createTag({ name: tagName("Alpha") }), createTag({ name: tagName("Beta") })]);
    const testcase = await createTestCase({ customTagIds: [a.id, b.id] });
    const assigned = await getTestCaseTags(testcase.id);
    expect(assigned.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("a test case created with no customTagIds has no tags", async () => {
    const testcase = await createTestCase();
    expect(await getTestCaseTags(testcase.id)).toEqual([]);
  });

  test("updating customTagIds replaces the assignment, and an empty array clears it", async () => {
    const [a, b] = await Promise.all([createTag({ name: tagName("A") }), createTag({ name: tagName("B") })]);
    const testcase = await createTestCase({ customTagIds: [a.id] });
    expect((await getTestCaseTags(testcase.id)).map((t) => t.id)).toEqual([a.id]);

    await asOwner.put(`${testcasesUrl()}/${testcase.id}`, { data: { customTagIds: [b.id] } });
    expect((await getTestCaseTags(testcase.id)).map((t) => t.id)).toEqual([b.id]);

    await asOwner.put(`${testcasesUrl()}/${testcase.id}`, { data: { customTagIds: [] } });
    expect(await getTestCaseTags(testcase.id)).toEqual([]);
  });

  test("omitting customTagIds entirely on update leaves existing tags untouched", async () => {
    const tag = await createTag();
    const testcase = await createTestCase({ customTagIds: [tag.id] });
    await asOwner.put(`${testcasesUrl()}/${testcase.id}`, { data: { title: "Renamed, tags untouched" } });
    expect((await getTestCaseTags(testcase.id)).map((t) => t.id)).toEqual([tag.id]);
  });

  test("a tag id from a different project is silently ignored, not a 500 or a leak", async () => {
    const foreignTag = await createTag({ name: tagName("Foreign") }, asOwner);
    // Move it to the second project so it's real, but not reachable from mainProjectId.
    exec(`UPDATE custom_tags SET project_id = ${literal(tenant!.secondProjectId)} WHERE id = ${literal(foreignTag.id)};`);

    const testcase = await createTestCase({ customTagIds: [foreignTag.id] });
    expect(await getTestCaseTags(testcase.id)).toEqual([]);
  });

  test("duplicating a tagged test case copies its tags onto the duplicate", async () => {
    const tag = await createTag();
    const testcase = await createTestCase({ customTagIds: [tag.id] });
    const duplicated = await asOwner.post(`${testcasesUrl()}/${testcase.id}/duplicate`, { failOnStatusCode: false });
    expect(duplicated.ok(), await duplicated.text()).toBeTruthy();
    const dup = await duplicated.json();
    expect((await getTestCaseTags(dup.id)).map((t) => t.id)).toEqual([tag.id]);
  });

  test("a QA Engineer can read the catalog and tag a test case, but cannot create or delete tags", async () => {
    const tag = await createTag({ name: tagName("QA Visible") }, asOwner);
    expect((await listTags(asQa)).map((t) => t.id)).toContain(tag.id);

    const testcase = await createTestCase({}, asOwner);
    const assign = await asQa.put(`${testcasesUrl()}/${testcase.id}`, {
      data: { customTagIds: [tag.id] },
      failOnStatusCode: false,
    });
    expect(assign.ok(), await assign.text()).toBeTruthy();
    expect((await getTestCaseTags(testcase.id)).map((t) => t.id)).toEqual([tag.id]);

    const createRefused = await post(asQa, { name: tagName("QA") });
    expect(createRefused.status()).toBe(403);
    expect((await createRefused.json()).error).toContain("QA Engineers cannot manage custom tags");

    const deleteRefused = await asQa.delete(tagUrl(tag.id), { failOnStatusCode: false });
    expect(deleteRefused.status()).toBe(403);
    expect(tagExists(tag.id)).toBe(true);
  });

  test("a manager can create and delete tags", async () => {
    const tag = await createTag({ name: tagName("Manager") }, asManager);
    const deleted = await asManager.delete(tagUrl(tag.id), { failOnStatusCode: false });
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  test("every route refuses a caller with no session", async () => {
    const tag = await createTag();
    const testcase = await createTestCase();

    const routes: [string, () => Promise<APIResponse>][] = [
      ["GET list", () => anon.get(tagsUrl(), { failOnStatusCode: false })],
      ["POST create", () => post(anon, { name: tagName("Anon") })],
      ["DELETE", () => anon.delete(tagUrl(tag.id), { failOnStatusCode: false })],
      ["GET testcase tags", () => anon.get(testcaseTagsUrl(testcase.id), { failOnStatusCode: false })],
    ];
    for (const [label, call] of routes) {
      const res = await call();
      expect([400, 401, 403, 404], `${label} should refuse an anonymous caller`).toContain(res.status());
    }
    expect(tagExists(tag.id)).toBe(true);
  });

  test("a workspace member with no access to the project cannot see or change its tags", async () => {
    const tag = await createTag();
    expect((await asGuest.get(tagsUrl(), { failOnStatusCode: false })).status()).toBe(404);
    expect((await post(asGuest, { name: tagName("Guest") })).status()).toBe(404);
    expect((await asGuest.delete(tagUrl(tag.id), { failOnStatusCode: false })).status()).toBe(404);
    expect(tagExists(tag.id)).toBe(true);
  });

  test("a tag from another project is unreachable from this one", async () => {
    const tag = await createTag({ name: tagName("Cross") }, asOwner);
    exec(`UPDATE custom_tags SET project_id = ${literal(tenant!.secondProjectId)} WHERE id = ${literal(tag.id)};`);

    const res = await asOwner.delete(tagUrl(tag.id), { failOnStatusCode: false });
    expect(res.status()).toBe(404);
    expect(tagExists(tag.id)).toBe(true);
  });

  // ─── Execution Report — Group by Tags ───────────────────────────────────────

  test("Group by Tags groups by the assigned catalog tag and filters by tag id", async () => {
    const [smoke, regression] = await Promise.all([
      createTag({ name: tagName("smoke") }),
      createTag({ name: tagName("regression") }),
    ]);
    const tagged = await createTestCase({ customTagIds: [smoke.id, regression.id] });
    const untagged = await createTestCase();

    const run = await seedRun(asOwner, tenant!.mainProjectId, { name: `E2E Custom Tags Run ${Date.now()}` });
    await addRunCases(asOwner, run.id, [tagged.id, untagged.id]);

    const grouped = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/reports/execution?filterBy=tags`);
    const body = await grouped.json();
    const byId = new Map(body.rows.map((r: any) => [r.groupId, r]));
    expect((byId.get(smoke.id) as any).total).toBe(1);
    expect((byId.get(regression.id) as any).total).toBe(1);
    expect((byId.get("untagged") as any).total).toBe(1);

    const filtered = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/reports/execution?filterBy=tags&filterValue=${smoke.id}`,
    );
    const filteredBody = await filtered.json();
    expect(filteredBody.rows.map((r: any) => r.groupId)).toContain(smoke.id);
    expect(filteredBody.rows.map((r: any) => r.groupId)).not.toContain("untagged");
  });

  test("a project with no custom tags reports an empty catalog", async () => {
    expect(await listTags(asOwner, tenant!.secondProjectId)).toEqual([]);
  });
});
