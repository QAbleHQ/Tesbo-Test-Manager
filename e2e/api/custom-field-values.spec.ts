import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Custom field VALUES: what a test case actually carries, and everything downstream of that —
 * per-type validation, defaults, required enforcement, duplication, list filtering and export.
 *
 * Definitions (the schema editor) are covered by api/custom-fields.spec.ts against its own tenant.
 * Both files flip the workspace plan to prove the Pro gate, and spec files run concurrently across
 * workers, so they must not share a workspace.
 *
 * Fixtures are torn down through Postgres: every test wipes this project's definitions and test
 * cases, which cascades the values with them. Doing it through the API would make each test depend
 * on endpoints other tests are busy proving broken.
 */

const OTHER_UUID = "00000000-0000-4000-8000-000000000000";

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test.describe("custom field values", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("custom-field-values");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();
    purgeFixtures(tenant);
  });

  test.afterAll(async () => {
    if (tenant) {
      purgeFixtures(tenant);
      // Left on Pro: the plan test flips it to Launch, and a tenant left on Launch would be refused
      // its second fixture project on the next run's provisioning.
      setProPlan(tenant.organizationId);
    }
    await Promise.all([asOwner, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
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

  function definitionsUrl(projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/custom-fields/definitions`;
  }

  function valuesUrl(testcaseId: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/testcases/${testcaseId}/custom-field-values`;
  }

  function fieldName(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function defineField(body: Record<string, unknown>, projectId?: string): Promise<any> {
    const res = await asOwner.post(definitionsUrl(projectId), {
      data: { name: fieldName(String(body.fieldType ?? "field")), ...body },
      failOnStatusCode: false,
    });
    expect(res.status(), `defining ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function createTestCase(
    data: Record<string, unknown> = {},
    api: APIRequestContext = asOwner,
    projectId?: string,
  ): Promise<APIResponse> {
    return api.post(`/api/projects/${projectId ?? tenant!.mainProjectId}/testcases`, {
      data: { title: `E2E CFV Case ${Date.now()}${Math.floor(Math.random() * 1000)}`, ...data },
      failOnStatusCode: false,
    });
  }

  async function createdTestCase(data: Record<string, unknown> = {}, projectId?: string): Promise<any> {
    const res = await createTestCase(data, asOwner, projectId);
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  async function putValues(
    testcaseId: string,
    values: Record<string, unknown>,
    api: APIRequestContext = asOwner,
  ): Promise<APIResponse> {
    return api.put(valuesUrl(testcaseId), { data: { values }, failOnStatusCode: false });
  }

  async function putValuesOk(testcaseId: string, values: Record<string, unknown>): Promise<void> {
    const res = await putValues(testcaseId, values);
    expect(res.status(), await res.text()).toBe(200);
  }

  async function readValues(testcaseId: string, api: APIRequestContext = asOwner): Promise<any[]> {
    const res = await api.get(valuesUrl(testcaseId));
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  /** The value a single field holds on a test case, straight from the row. */
  function storedValue(definitionId: string, testcaseId: string): string {
    return scalar(
      `SELECT value::text FROM custom_field_values WHERE definition_id = ${literal(definitionId)} ` +
        `AND testcase_id = ${literal(testcaseId)};`,
    );
  }

  function valueRowCount(testcaseId: string): number {
    return Number(scalar(`SELECT COUNT(*) FROM custom_field_values WHERE testcase_id = ${literal(testcaseId)};`));
  }

  function customFieldAuditCount(testcaseId: string): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM audit_logs WHERE action = 'testcase_custom_field_updated' ` +
          `AND entity_id = ${literal(testcaseId)};`,
      ),
    );
  }

  function valueOf(fields: any[], definitionId: string): unknown {
    return fields.find((f) => f.id === definitionId)?.value;
  }

  // ─── The round trip ────────────────────────────────────────────────────────

  test("stores and reads back a value of every field type", { tag: '@tesbo.testId("TES-TC-102")' }, async () => {
    const text = await defineField({ fieldType: "text" });
    const longText = await defineField({ fieldType: "long_text" });
    const boolean = await defineField({ fieldType: "boolean" });
    const single = await defineField({ fieldType: "single_select", config: { options: [{ label: "Low" }, { label: "High" }] } });
    const multi = await defineField({ fieldType: "multi_select", config: { options: [{ label: "iOS" }, { label: "Android" }] } });
    const number = await defineField({ fieldType: "number", config: { min: 0, max: 100, unit: "hours" } });
    const date = await defineField({ fieldType: "date" });

    const testcase = await createdTestCase();
    const highId = single.config.options[1].id;
    const iosId = multi.config.options[0].id;

    await putValuesOk(testcase.id, {
      [text.id]: "Payments",
      [longText.id]: "A longer note about the flow.",
      [boolean.id]: true,
      [single.id]: highId,
      [multi.id]: [iosId],
      [number.id]: 7.5,
      [date.id]: "2026-09-01",
    });

    const fields = await readValues(testcase.id);
    // Ordered by display order, which is creation order here.
    expect(fields.map((f) => f.id)).toEqual([text, longText, boolean, single, multi, number, date].map((d) => d.id));
    expect(valueOf(fields, text.id)).toBe("Payments");
    expect(valueOf(fields, longText.id)).toBe("A longer note about the flow.");
    expect(valueOf(fields, boolean.id)).toBe(true);
    expect(valueOf(fields, single.id)).toBe(highId);
    expect(valueOf(fields, multi.id)).toEqual([iosId]);
    expect(valueOf(fields, number.id)).toBe(7.5);
    expect(valueOf(fields, date.id)).toBe("2026-09-01");

    // The read carries each field's own definition, so a screen can render it without a second call.
    const numberField = fields.find((f) => f.id === number.id);
    expect(numberField).toMatchObject({ key: number.key, name: number.name, fieldType: "number", required: false });
    expect(numberField.config.unit).toBe("hours");
  });

  test("text is trimmed and multi-select selections are de-duplicated on the way in", { tag: '@tesbo.testId("TES-TC-103")' }, async () => {
    const text = await defineField({ fieldType: "text" });
    const multi = await defineField({
      fieldType: "multi_select",
      config: { options: [{ label: "iOS" }, { label: "Android" }] },
    });
    const [iosId, androidId] = multi.config.options.map((o: any) => o.id);
    const testcase = await createdTestCase();

    await putValuesOk(testcase.id, { [text.id]: "  spaced out  ", [multi.id]: [iosId, androidId, iosId] });

    const fields = await readValues(testcase.id);
    expect(valueOf(fields, text.id)).toBe("spaced out");
    expect(valueOf(fields, multi.id)).toEqual([iosId, androidId]);
  });

  test("clearing a value removes the stored row rather than storing an empty one", { tag: '@tesbo.testId("TES-TC-104")' }, async () => {
    const text = await defineField({ fieldType: "text" });
    const multi = await defineField({ fieldType: "multi_select", config: { options: [{ label: "iOS" }] } });
    const testcase = await createdTestCase();
    await putValuesOk(testcase.id, { [text.id]: "temporary", [multi.id]: [multi.config.options[0].id] });
    expect(valueRowCount(testcase.id)).toBe(2);

    await putValuesOk(testcase.id, { [text.id]: "", [multi.id]: [] });

    expect(valueRowCount(testcase.id)).toBe(0);
    const fields = await readValues(testcase.id);
    expect(valueOf(fields, text.id)).toBeNull();
    expect(valueOf(fields, multi.id)).toBeNull();
  });

  // ─── Required fields ───────────────────────────────────────────────────────

  test("a required field must be filled in, and cannot then be emptied", { tag: '@tesbo.testId("TES-TC-105")' }, async () => {
    const optional = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase();
    const required = await defineField({ fieldType: "text", required: true });

    const missing = await putValues(testcase.id, { [optional.id]: "set" });
    expect(missing.status()).toBe(400);
    const body = await missing.json();
    expect(body.errors).toEqual([{ field: required.id, message: `${required.name} is required` }]);
    // The whole write is refused, not partially applied.
    expect(valueRowCount(testcase.id)).toBe(0);

    await putValuesOk(testcase.id, { [optional.id]: "set", [required.id]: "filled" });
    expect(valueRowCount(testcase.id)).toBe(2);

    const cleared = await putValues(testcase.id, { [required.id]: "" });
    expect(cleared.status()).toBe(400);
    expect(storedValue(required.id, testcase.id)).toBe('"filled"');
  });

  test("a field made required after the fact blocks the next save of an existing test case", { tag: '@tesbo.testId("TES-TC-106")' }, async () => {
    const testcase = await createdTestCase();
    const field = await defineField({ fieldType: "text" });

    const madeRequired = await asOwner.patch(`${definitionsUrl()}/${field.id}`, { data: { required: true } });
    expect(madeRequired.ok(), await madeRequired.text()).toBeTruthy();

    // updateTestCase always runs the value writer, even with no custom field values in the body —
    // which is what makes "required from now on" apply to test cases that predate the change.
    const res = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${testcase.id}`, {
      data: { title: `${testcase.title} edited` },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(400);

    const withValue = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${testcase.id}`, {
      data: { title: `${testcase.title} edited`, customFieldValues: { [field.id]: "now filled" } },
      failOnStatusCode: false,
    });
    expect(withValue.status(), await withValue.text()).toBe(200);
  });

  test("an inactive required field does not block a save, and an archived one cannot be written at all", { tag: '@tesbo.testId("TES-TC-107")' }, async () => {
    const testcase = await createdTestCase();
    const inactive = await defineField({ fieldType: "text", required: true });
    const archived = await defineField({ fieldType: "text" });
    await asOwner.patch(`${definitionsUrl()}/${inactive.id}/status`, { data: { status: "inactive" } });
    await asOwner.patch(`${definitionsUrl()}/${archived.id}/status`, { data: { status: "archived" } });

    // Deactivating is the escape hatch for a required field a team no longer wants to fill in.
    await putValuesOk(testcase.id, {});

    // An inactive field still accepts a value when one is offered — it is hidden from new entry,
    // not read-only.
    await putValuesOk(testcase.id, { [inactive.id]: "still writable" });
    expect(storedValue(inactive.id, testcase.id)).toBe('"still writable"');

    const onArchived = await putValues(testcase.id, { [archived.id]: "nope" });
    expect(onArchived.status()).toBe(400);
    expect((await onArchived.json()).errors[0].message).toContain("archived");
    expect(valueRowCount(testcase.id)).toBe(1);
  });

  // ─── Status visibility ─────────────────────────────────────────────────────

  test("only active fields are returned for a test case, whatever else the project also defines", async () => {
    const active1 = await defineField({ fieldType: "text" });
    const inactive = await defineField({ fieldType: "text" });
    const archived = await defineField({ fieldType: "text" });
    const active2 = await defineField({ fieldType: "text" });
    await asOwner.patch(`${definitionsUrl()}/${inactive.id}/status`, { data: { status: "inactive" } });
    await asOwner.patch(`${definitionsUrl()}/${archived.id}/status`, { data: { status: "archived" } });

    const testcase = await createdTestCase();
    const fields = await readValues(testcase.id);
    // display_order preserved among the survivors, with the hidden ones simply missing.
    expect(fields.map((f) => f.id)).toEqual([active1.id, active2.id]);
  });

  test("deactivating a field hides it from the test case's list without touching its recorded value, and it comes back once reactivated", async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase({ customFieldValues: { [field.id]: "kept safe" } });
    expect(valueOf(await readValues(testcase.id), field.id)).toBe("kept safe");

    await asOwner.patch(`${definitionsUrl()}/${field.id}/status`, { data: { status: "inactive" } });
    expect(valueOf(await readValues(testcase.id), field.id)).toBeUndefined();
    // Hiding the field from the response is a read-side filter — the row underneath is untouched.
    expect(storedValue(field.id, testcase.id)).toBe('"kept safe"');

    await asOwner.patch(`${definitionsUrl()}/${field.id}/status`, { data: { status: "active" } });
    expect(valueOf(await readValues(testcase.id), field.id)).toBe("kept safe");
  });

  test("archiving a field hides it from the test case's list too, and its recorded value is preserved even though archiving cannot be undone", async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase({ customFieldValues: { [field.id]: "still there" } });

    await asOwner.patch(`${definitionsUrl()}/${field.id}/status`, { data: { status: "archived" } });
    expect(valueOf(await readValues(testcase.id), field.id)).toBeUndefined();
    expect(storedValue(field.id, testcase.id)).toBe('"still there"');
  });

  test("a value for a field this project does not have is refused", { tag: '@tesbo.testId("TES-TC-108")' }, async () => {
    const testcase = await createdTestCase();
    const foreign = await defineField({ fieldType: "text" }, tenant!.secondProjectId);

    for (const definitionId of [OTHER_UUID, foreign.id]) {
      const res = await putValues(testcase.id, { [definitionId]: "x" });
      expect(res.status(), `value for ${definitionId}`).toBe(400);
      expect((await res.json()).errors[0]).toMatchObject({ field: definitionId, message: "Unknown custom field" });
    }
    expect(valueRowCount(testcase.id)).toBe(0);
  });

  // ─── Per-type validation ───────────────────────────────────────────────────

  test("each field type refuses values that don't belong to it", { tag: '@tesbo.testId("TES-TC-109")' }, async () => {
    const text = await defineField({ fieldType: "text", config: { maxLength: 5 } });
    const boolean = await defineField({ fieldType: "boolean" });
    const single = await defineField({ fieldType: "single_select", config: { options: [{ label: "Only" }] } });
    const multi = await defineField({
      fieldType: "multi_select",
      config: { options: [{ label: "One" }, { label: "Two" }, { label: "Three" }], minSelected: 2, maxSelected: 2 },
    });
    const wholeNumber = await defineField({ fieldType: "number", config: { min: 1, max: 10, decimalsAllowed: false } });
    const pastOnly = await defineField({ fieldType: "date", config: { allowFutureDates: false } });
    const testcase = await createdTestCase();

    const optionIds = multi.config.options.map((o: any) => o.id);
    const rejected: [string, Record<string, unknown>][] = [
      ["number into a text field", { [text.id]: 12 }],
      ["text past its maxLength", { [text.id]: "far too long" }],
      ["string into a boolean field", { [boolean.id]: "true" }],
      ["unknown option id", { [single.id]: OTHER_UUID }],
      ["single-select given a list", { [single.id]: [single.config.options[0].id] }],
      ["multi-select given a bare id", { [multi.id]: optionIds[0] }],
      ["multi-select below minSelected", { [multi.id]: [optionIds[0]] }],
      ["multi-select above maxSelected", { [multi.id]: optionIds }],
      ["string into a number field", { [wholeNumber.id]: "5" }],
      ["number below min", { [wholeNumber.id]: 0 }],
      ["number above max", { [wholeNumber.id]: 11 }],
      ["decimal where decimals are off", { [wholeNumber.id]: 2.5 }],
      ["date in the wrong format", { [pastOnly.id]: "01-09-2026" }],
      ["future date where the future is refused", { [pastOnly.id]: isoDaysFromToday(3) }],
    ];

    for (const [label, values] of rejected) {
      const res = await putValues(testcase.id, values);
      expect(res.status(), label).toBe(400);
      expect((await res.json()).errors, label).toHaveLength(1);
    }
    expect(valueRowCount(testcase.id)).toBe(0);

    // The same fields accept the values they were configured for.
    await putValuesOk(testcase.id, {
      [text.id]: "short",
      [boolean.id]: false,
      [single.id]: single.config.options[0].id,
      [multi.id]: [optionIds[0], optionIds[1]],
      [wholeNumber.id]: 3,
      [pastOnly.id]: isoDaysFromToday(-1),
    });
  });

  test("an option that has been deactivated can no longer be chosen", { tag: '@tesbo.testId("TES-TC-110")' }, async () => {
    const single = await defineField({
      fieldType: "single_select",
      config: { options: [{ label: "Live" }, { label: "Retiring" }] },
    });
    const retiringId = single.config.options[1].id;
    const testcase = await createdTestCase();
    await putValuesOk(testcase.id, { [single.id]: retiringId });

    await asOwner.patch(`${definitionsUrl()}/${single.id}/options/${retiringId}`, { data: { active: false } });

    // Already-recorded values are left alone — history isn't rewritten by a config change...
    expect(storedValue(single.id, testcase.id)).toBe(`"${retiringId}"`);
    const fields = await readValues(testcase.id);
    expect(valueOf(fields, single.id)).toBe(retiringId);

    // ...but nothing new may be pointed at it.
    const other = await createdTestCase();
    const res = await putValues(other.id, { [single.id]: retiringId });
    expect(res.status()).toBe(400);
    expect((await res.json()).errors[0].message).toContain("active option");
  });

  // ─── Defaults ──────────────────────────────────────────────────────────────

  test("a configured default lands on a new test case that says nothing about the field", { tag: '@tesbo.testId("TES-TC-111")' }, async () => {
    const text = await defineField({ fieldType: "text", config: { defaultValue: "unspecified" } });
    const number = await defineField({ fieldType: "number", config: { defaultValue: 3 } });
    const single = await defineField({ fieldType: "single_select", config: { options: [{ label: "Low" }, { label: "High" }] } });
    const lowId = single.config.options[0].id;
    await asOwner.patch(`${definitionsUrl()}/${single.id}`, { data: { config: { defaultOptionId: lowId } } });

    const testcase = await createdTestCase();

    const fields = await readValues(testcase.id);
    expect(valueOf(fields, text.id)).toBe("unspecified");
    expect(valueOf(fields, number.id)).toBe(3);
    expect(valueOf(fields, single.id)).toBe(lowId);
  });

  test("a default never overwrites a value the caller gave, nor one already recorded", { tag: '@tesbo.testId("TES-TC-112")' }, async () => {
    const field = await defineField({ fieldType: "text", config: { defaultValue: "fallback" } });

    const explicit = await createdTestCase({ customFieldValues: { [field.id]: "chosen" } });
    expect(storedValue(field.id, explicit.id)).toBe('"chosen"');

    // Clearing it and saving again must not quietly reinstate the default: an empty value the user
    // chose is still a choice.
    await putValuesOk(explicit.id, { [field.id]: "" });
    expect(valueRowCount(explicit.id)).toBe(0);

    await putValuesOk(explicit.id, { [field.id]: "second choice" });
    await putValuesOk(explicit.id, {});
    expect(storedValue(field.id, explicit.id)).toBe('"second choice"');
  });

  test("an inactive field's default is not applied to new test cases", { tag: '@tesbo.testId("TES-TC-113")' }, async () => {
    const field = await defineField({ fieldType: "text", config: { defaultValue: "fallback" } });
    await asOwner.patch(`${definitionsUrl()}/${field.id}/status`, { data: { status: "inactive" } });

    const testcase = await createdTestCase();
    expect(valueRowCount(testcase.id)).toBe(0);
  });

  // ─── Through the test case endpoints ───────────────────────────────────────

  test("values ride along with test case creation and editing", { tag: '@tesbo.testId("TES-TC-114")' }, async () => {
    const field = await defineField({ fieldType: "text" });

    const created = await createdTestCase({ customFieldValues: { [field.id]: "at creation" } });
    expect(storedValue(field.id, created.id)).toBe('"at creation"');

    const updated = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${created.id}`, {
      data: { customFieldValues: { [field.id]: "at edit" } },
    });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    expect(storedValue(field.id, created.id)).toBe('"at edit"');

    // An invalid value fails the whole save rather than landing a half-updated test case.
    const rejected = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${created.id}`, {
      data: { title: "should not stick", customFieldValues: { [field.id]: 42 } },
      failOnStatusCode: false,
    });
    expect(rejected.status()).toBe(400);
    const reread = await asOwner
      .get(`/api/projects/${tenant!.mainProjectId}/testcases/${created.id}`)
      .then((r) => r.json());
    expect(reread.title).toBe(created.title);
    expect(storedValue(field.id, created.id)).toBe('"at edit"');
  });

  test("duplicating a test case carries its custom field values across", { tag: '@tesbo.testId("TES-TC-115")' }, async () => {
    const text = await defineField({ fieldType: "text" });
    const multi = await defineField({
      fieldType: "multi_select",
      config: { options: [{ label: "iOS" }, { label: "Android" }] },
    });
    const optionIds = multi.config.options.map((o: any) => o.id);
    const source = await createdTestCase({
      customFieldValues: { [text.id]: "carried over", [multi.id]: [optionIds[1]] },
    });

    const res = await asOwner.post(
      `/api/projects/${tenant!.mainProjectId}/testcases/${source.id}/duplicate`,
      { failOnStatusCode: false },
    );
    expect(res.status(), await res.text()).toBe(201);
    const copy = await res.json();

    expect(copy.id).not.toBe(source.id);
    const fields = await readValues(copy.id);
    expect(valueOf(fields, text.id)).toBe("carried over");
    expect(valueOf(fields, multi.id)).toEqual([optionIds[1]]);
    // The original is untouched.
    expect(storedValue(text.id, source.id)).toBe('"carried over"');
  });

  test("deleting a test case takes its values with it", { tag: '@tesbo.testId("TES-TC-116")' }, async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase({ customFieldValues: { [field.id]: "doomed" } });
    expect(valueRowCount(testcase.id)).toBe(1);

    const res = await asOwner.delete(`/api/projects/${tenant!.mainProjectId}/testcases/${testcase.id}`);
    expect(res.ok(), await res.text()).toBeTruthy();

    // A soft-deleted test case must not keep answering for its values either.
    const read = await asOwner.get(valuesUrl(testcase.id), { failOnStatusCode: false });
    expect(read.status()).toBe(404);
  });

  test("reading or writing values needs a test case this project actually holds", { tag: '@tesbo.testId("TES-TC-117")' }, async () => {
    const elsewhere = await createdTestCase({}, tenant!.secondProjectId);

    // "not-a-uuid" belongs here rather than in a validation test: unguarded it reaches Postgres as
    // a failed uuid cast and answers a URL typo with a 500.
    for (const testcaseId of [OTHER_UUID, "not-a-uuid", elsewhere.id]) {
      const read = await asOwner.get(valuesUrl(testcaseId), { failOnStatusCode: false });
      expect(read.status(), `GET values for ${testcaseId}`).toBe(404);

      const write = await putValues(testcaseId, {});
      expect(write.status(), `PUT values for ${testcaseId}`).toBe(404);
    }
  });

  // ─── History ───────────────────────────────────────────────────────────────

  test("a changed value is recorded once, and an unchanged one is not recorded at all", { tag: '@tesbo.testId("TES-TC-118")' }, async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase();

    await putValuesOk(testcase.id, { [field.id]: "first" });
    expect(customFieldAuditCount(testcase.id)).toBe(1);

    // Saving the same value again is not a change and must not pad the history.
    await putValuesOk(testcase.id, { [field.id]: "first" });
    expect(customFieldAuditCount(testcase.id)).toBe(1);

    await putValuesOk(testcase.id, { [field.id]: "second" });
    expect(customFieldAuditCount(testcase.id)).toBe(2);
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  test("a QA engineer can record values even though they cannot configure the fields", { tag: '@tesbo.testId("TES-TC-119")' }, async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase();

    const written = await putValues(testcase.id, { [field.id]: "qa wrote this" }, asQa);
    expect(written.status(), await written.text()).toBe(200);
    expect(storedValue(field.id, testcase.id)).toBe('"qa wrote this"');
    expect(valueOf(await readValues(testcase.id, asQa), field.id)).toBe("qa wrote this");
  });

  test("values are refused to a caller with no session and to a member with no project access", { tag: '@tesbo.testId("TES-TC-120")' }, async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase({ customFieldValues: { [field.id]: "private" } });

    const anonRead = await anon.get(valuesUrl(testcase.id), { failOnStatusCode: false });
    expect([400, 401, 403, 404]).toContain(anonRead.status());
    const anonWrite = await putValues(testcase.id, { [field.id]: "anon" }, anon);
    expect([400, 401, 403, 404]).toContain(anonWrite.status());

    const guestRead = await asGuest.get(valuesUrl(testcase.id), { failOnStatusCode: false });
    expect(guestRead.status()).toBe(404);
    const guestWrite = await putValues(testcase.id, { [field.id]: "guest" }, asGuest);
    expect(guestWrite.status()).toBe(404);

    expect(storedValue(field.id, testcase.id)).toBe('"private"');
  });

  test("the test case list does not hand a project's custom field values to an anonymous caller", { tag: '@tesbo.testId("TES-TC-121")' }, async () => {
    const field = await defineField({ fieldType: "text" });
    await createdTestCase({ customFieldValues: { [field.id]: "commercially sensitive" } });

    const res = await anon.get(`/api/projects/${tenant!.mainProjectId}/testcases`, { failOnStatusCode: false });
    expect([400, 401, 403, 404], `an anonymous list returned ${res.status()}`).toContain(res.status());
  });

  // ─── Plan gating ───────────────────────────────────────────────────────────

  test("on the Launch plan values stay readable, the value endpoint closes, and saving a test case still works", { tag: '@tesbo.testId("TES-TC-122")' }, async () => {
    const field = await defineField({ fieldType: "text" });
    const testcase = await createdTestCase({ customFieldValues: { [field.id]: "recorded on Pro" } });

    resetToLaunch(tenant!.organizationId);
    try {
      // Reading is never gated — a downgraded workspace keeps seeing what it already captured.
      expect(valueOf(await readValues(testcase.id), field.id)).toBe("recorded on Pro");

      const write = await putValues(testcase.id, { [field.id]: "changed on Launch" });
      expect(write.status()).toBe(403);
      expect((await write.json()).error).toContain("Pro");

      // But ordinary test case work must not become collateral damage: create and update carry the
      // values in "skip-if-disabled" mode, so they succeed and simply ignore them.
      const created = await createTestCase({ customFieldValues: { [field.id]: "ignored" } });
      expect(created.status(), await created.text()).toBe(201);
      expect(valueRowCount((await created.json()).id)).toBe(0);

      const updated = await asOwner.put(`/api/projects/${tenant!.mainProjectId}/testcases/${testcase.id}`, {
        data: { title: "still editable on Launch", customFieldValues: { [field.id]: "ignored" } },
        failOnStatusCode: false,
      });
      expect(updated.status(), await updated.text()).toBe(200);
      expect(storedValue(field.id, testcase.id)).toBe('"recorded on Pro"');
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  // ─── Filtering the list ────────────────────────────────────────────────────

  test.describe("filtering the test case list", () => {
    test("every operator narrows the list to the test cases that match", { tag: '@tesbo.testId("TES-TC-124")' }, async () => {
      const text = await defineField({ fieldType: "text" });
      const single = await defineField({
        fieldType: "single_select",
        config: { options: [{ label: "Alpha" }, { label: "Beta" }] },
      });
      const multi = await defineField({
        fieldType: "multi_select",
        config: { options: [{ label: "iOS" }, { label: "Android" }] },
      });
      const boolean = await defineField({ fieldType: "boolean" });
      const number = await defineField({ fieldType: "number" });
      const date = await defineField({ fieldType: "date" });

      const [alphaId, betaId] = single.config.options.map((o: any) => o.id);
      const [iosId, androidId] = multi.config.options.map((o: any) => o.id);
      const yesterday = isoDaysFromToday(-1);
      const tomorrow = isoDaysFromToday(1);

      const chrome = await createdTestCase({
        customFieldValues: {
          [text.id]: "Chrome regression",
          [single.id]: alphaId,
          [multi.id]: [iosId, androidId],
          [boolean.id]: true,
          [number.id]: 5,
          [date.id]: yesterday,
        },
      });
      const safari = await createdTestCase({
        customFieldValues: {
          [text.id]: "Safari smoke",
          [single.id]: betaId,
          [multi.id]: [androidId],
          [boolean.id]: false,
          [number.id]: 50,
          [date.id]: tomorrow,
        },
      });
      const untouched = await createdTestCase();

      async function matching(conditions: unknown[]): Promise<string[]> {
        const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
          params: { customFieldFilters: JSON.stringify(conditions), limit: 500 },
          failOnStatusCode: false,
        });
        expect(res.status(), `${JSON.stringify(conditions)} — ${await res.text()}`).toBe(200);
        return (await res.json()).map((row: any) => row.id).sort();
      }

      const expectations: [string, unknown[], string[]][] = [
        ["contains", [{ definitionId: text.id, operator: "contains", value: "chrome" }], [chrome.id]],
        [
          "does_not_contain",
          [{ definitionId: text.id, operator: "does_not_contain", value: "chrome" }],
          [safari.id, untouched.id],
        ],
        ["is_empty", [{ definitionId: text.id, operator: "is_empty" }], [untouched.id]],
        ["is_not_empty", [{ definitionId: text.id, operator: "is_not_empty" }], [chrome.id, safari.id]],
        ["is", [{ definitionId: single.id, operator: "is", value: alphaId }], [chrome.id]],
        ["is_not", [{ definitionId: single.id, operator: "is_not", value: alphaId }], [safari.id, untouched.id]],
        ["includes_any", [{ definitionId: multi.id, operator: "includes_any", value: [iosId] }], [chrome.id]],
        [
          "includes_all",
          [{ definitionId: multi.id, operator: "includes_all", value: [iosId, androidId] }],
          [chrome.id],
        ],
        ["yes", [{ definitionId: boolean.id, operator: "yes" }], [chrome.id]],
        ["no", [{ definitionId: boolean.id, operator: "no" }], [safari.id]],
        ["equals", [{ definitionId: number.id, operator: "equals", value: 5 }], [chrome.id]],
        ["greater_than", [{ definitionId: number.id, operator: "greater_than", value: 10 }], [safari.id]],
        ["less_than", [{ definitionId: number.id, operator: "less_than", value: 10 }], [chrome.id]],
        [
          "between (number)",
          [{ definitionId: number.id, operator: "between", value: 1, valueTo: 10 }],
          [chrome.id],
        ],
        ["before", [{ definitionId: date.id, operator: "before", value: isoDaysFromToday(0) }], [chrome.id]],
        ["after", [{ definitionId: date.id, operator: "after", value: isoDaysFromToday(0) }], [safari.id]],
        ["on", [{ definitionId: date.id, operator: "on", value: yesterday }], [chrome.id]],
        ["is_overdue", [{ definitionId: date.id, operator: "is_overdue" }], [chrome.id]],
        [
          "between (date)",
          [{ definitionId: date.id, operator: "between", value: yesterday, valueTo: tomorrow }],
          [chrome.id, safari.id],
        ],
        [
          "two conditions, ANDed",
          [
            { definitionId: text.id, operator: "contains", value: "chrome" },
            { definitionId: number.id, operator: "less_than", value: 10 },
          ],
          [chrome.id],
        ],
        [
          "two conditions that cannot both hold",
          [
            { definitionId: text.id, operator: "contains", value: "chrome" },
            { definitionId: number.id, operator: "greater_than", value: 10 },
          ],
          [],
        ],
      ];

      for (const [label, conditions, expected] of expectations) {
        expect(await matching(conditions), label).toEqual([...expected].sort());
      }
    });

    test("a filter the project cannot resolve is refused rather than ignored", { tag: '@tesbo.testId("TES-TC-125")' }, async () => {
      await createdTestCase();

      const cases: [string, string][] = [
        ["unknown definition", JSON.stringify([{ definitionId: OTHER_UUID, operator: "is_not_empty" }])],
        ["malformed json", "not-json"],
      ];

      for (const [label, customFieldFilters] of cases) {
        const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
          params: { customFieldFilters },
          failOnStatusCode: false,
        });
        expect(res.status(), `${label} — ${await res.text()}`).toBe(400);
      }
    });
  });

  // ─── Export ────────────────────────────────────────────────────────────────

  test("the CSV export carries a column per active field, with option labels resolved", { tag: '@tesbo.testId("TES-TC-123")' }, async () => {
    const text = await defineField({ fieldType: "text" });
    const single = await defineField({
      fieldType: "single_select",
      config: { options: [{ label: "Low" }, { label: "High" }] },
    });
    const number = await defineField({ fieldType: "number", config: { unit: "hours" } });
    const boolean = await defineField({ fieldType: "boolean" });
    const inactive = await defineField({ fieldType: "text" });
    await asOwner.patch(`${definitionsUrl()}/${inactive.id}/status`, { data: { status: "inactive" } });

    const highId = single.config.options[1].id;
    const testcase = await createdTestCase({
      customFieldValues: { [text.id]: "Payments", [single.id]: highId, [number.id]: 4, [boolean.id]: true },
    });

    const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/testcases/export/csv`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const csv = await res.text();
    const [header, ...rows] = csv.trim().split("\n");

    for (const definition of [text, single, number, boolean]) {
      expect(header, `header should carry cf_${definition.key}`).toContain(`cf_${definition.key}`);
    }
    // Inactive fields are left out of the export entirely, so a spreadsheet only ever holds the
    // columns a team is currently filling in.
    expect(header).not.toContain(`cf_${inactive.key}`);

    const row = rows.find((line) => line.includes(testcase.externalId))!;
    expect(row, "the exported row").toBeTruthy();
    expect(row).toContain("Payments");
    // Option ids are resolved to their labels, and a number renders with its unit.
    expect(row).toContain("High");
    expect(row).not.toContain(highId);
    expect(row).toContain("4 hours");
    expect(row).toContain("Yes");
  });
});
