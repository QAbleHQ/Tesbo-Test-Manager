import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { resetToLaunch, setGraceWindow, setProPlan } from "../utils/billing-db";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Custom field DEFINITIONS: the per-project schema editor behind
 * /api/projects/:projectId/custom-fields/definitions.
 *
 * Values recorded against those definitions live in api/custom-field-values.spec.ts, which owns its
 * own workspace. Splitting the two is not cosmetic: both files flip their workspace's plan to prove
 * the Pro gate, and different spec FILES still run concurrently across workers, so a shared tenant
 * would let one file's downgrade land inside the other file's assertions.
 *
 * Runs against its own disposable workspace ("custom-fields"), which provisionRbacTenant puts on
 * Pro — custom fields are a Pro feature, so on Launch every configuration call here would 403 for
 * reasons that have nothing to do with what the test is asking about.
 *
 * Teardown deletes definitions through Postgres rather than the DELETE endpoint: that endpoint is
 * itself under test (it refuses fields that hold values), so a test proving it refuses must not
 * depend on it to clean up.
 */

/** The ceiling validateConfigShape enforces on `maxLength`, per text-ish type. */
const MAX_LENGTH_CEILING = { text: 10_000, long_text: 50_000 };

/** custom_field_definitions.name is VARCHAR(160). */
const NAME_COLUMN_LIMIT = 160;

test.describe("custom field definitions", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  /** A test case fixture, so "this field has recorded values" is reachable. */
  let testcaseId: string;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("custom-fields");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();

    // Created before any definition exists: a required field with no default would refuse this.
    purgeDefinitions(tenant);
    const created = await asOwner.post(`/api/projects/${tenant.mainProjectId}/testcases`, {
      data: { title: `E2E Custom Field Case ${Date.now()}` },
    });
    testcaseId = (await created.json()).id;
  });

  test.afterAll(async () => {
    if (tenant) {
      purgeDefinitions(tenant);
      // Left on Pro: the plan tests below flip it to Launch, and a tenant left on Launch would be
      // refused its second fixture project on the next run's provisioning.
      setProPlan(tenant.organizationId);
      if (testcaseId) {
        await asOwner.delete(`/api/projects/${tenant.mainProjectId}/testcases/${testcaseId}`, {
          failOnStatusCode: false,
        });
      }
    }
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    if (tenant) purgeDefinitions(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function purgeDefinitions(t: RbacTenant): void {
    exec(
      `DELETE FROM custom_field_definitions WHERE project_id IN (${literal(t.mainProjectId)}, ` +
        `${literal(t.secondProjectId)});`,
    );
  }

  function definitionsUrl(projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/custom-fields/definitions`;
  }

  function definitionUrl(definitionId: string, projectId?: string): string {
    return `${definitionsUrl(projectId)}/${definitionId}`;
  }

  /** Names are stamped so a re-run against the persistent volume can't collide on the unique index. */
  function fieldName(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function post(api: APIRequestContext, body: Record<string, unknown>, projectId?: string): Promise<APIResponse> {
    return api.post(definitionsUrl(projectId), { data: body, failOnStatusCode: false });
  }

  /** Creates a definition and fails the test if the product refused it. */
  async function createField(body: Record<string, unknown>, api: APIRequestContext = asOwner): Promise<any> {
    const res = await post(api, body);
    expect(res.status(), `creating ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function textField(overrides: Record<string, unknown> = {}): Promise<any> {
    return createField({ name: fieldName("Text"), fieldType: "text", ...overrides });
  }

  async function selectField(overrides: Record<string, unknown> = {}): Promise<any> {
    return createField({
      name: fieldName("Select"),
      fieldType: "single_select",
      config: { options: [{ label: "Alpha" }, { label: "Beta" }] },
      ...overrides,
    });
  }

  async function listFields(api: APIRequestContext = asOwner, query = ""): Promise<any[]> {
    const res = await api.get(`${definitionsUrl()}${query}`);
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  }

  /** Records a value directly, so "this field is in use" doesn't depend on the value endpoint. */
  function recordValue(definitionId: string, value: unknown): void {
    exec(
      `INSERT INTO custom_field_values (definition_id, testcase_id, value) VALUES ` +
        `(${literal(definitionId)}, ${literal(testcaseId)}, ${literal(JSON.stringify(value))}::jsonb) ` +
        "ON CONFLICT (definition_id, testcase_id) DO UPDATE SET value = EXCLUDED.value;",
    );
  }

  function storedStatus(definitionId: string): string {
    return scalar(`SELECT status FROM custom_field_definitions WHERE id = ${literal(definitionId)};`);
  }

  function storedOrder(definitionId: string): number {
    return Number(
      scalar(`SELECT display_order FROM custom_field_definitions WHERE id = ${literal(definitionId)};`),
    );
  }

  function definitionExists(definitionId: string): boolean {
    return scalar(`SELECT COUNT(*) FROM custom_field_definitions WHERE id = ${literal(definitionId)};`) === "1";
  }

  /** Delete is a soft-delete: the row survives with deleted_at set, rather than disappearing. */
  function isSoftDeleted(definitionId: string): boolean {
    return scalar(`SELECT deleted_at IS NOT NULL FROM custom_field_definitions WHERE id = ${literal(definitionId)};`) === "t";
  }

  function restoreUrl(definitionId: string, projectId?: string): string {
    return `${definitionUrl(definitionId, projectId)}/restore`;
  }

  // ─── Creation ──────────────────────────────────────────────────────────────

  test("creates a field of every supported type, normalising each type's config", { tag: '@tesbo.testId("TES-TC-126")' }, async () => {
    const specs: { fieldType: string; config?: Record<string, unknown>; expected?: Record<string, unknown> }[] = [
      { fieldType: "text", config: { maxLength: 40, placeholder: "e.g. high" } },
      { fieldType: "long_text", config: { maxLength: 4000 } },
      // The two flags below are filled in by the server when omitted — asserting the defaults is
      // the point: a definition created with an empty config must still render deterministically.
      { fieldType: "boolean", config: {}, expected: { displayFormat: "yes_no" } },
      { fieldType: "single_select", config: { options: [{ label: "Low" }, { label: "High" }] } },
      { fieldType: "multi_select", config: { options: [{ label: "iOS" }, { label: "Android" }] } },
      { fieldType: "number", config: { min: 0, max: 10 }, expected: { decimalsAllowed: true } },
      { fieldType: "date", config: {}, expected: { allowPastDates: true, allowFutureDates: true } },
    ];

    const created: any[] = [];
    for (const spec of specs) {
      const definition = await createField({
        name: fieldName(spec.fieldType),
        fieldType: spec.fieldType,
        description: `${spec.fieldType} field`,
        config: spec.config,
      });
      expect(definition.fieldType).toBe(spec.fieldType);
      expect(definition.status).toBe("active");
      expect(definition.required).toBe(false);
      expect(definition.isUsed).toBe(false);
      expect(definition.createdBy).toBe(tenant!.owner.userId);
      for (const [key, value] of Object.entries(spec.expected ?? {})) {
        expect(definition.config[key], `${spec.fieldType}.config.${key}`).toEqual(value);
      }
      created.push(definition);
    }

    // display_order counts up from 0 in creation order, which is the order the list comes back in.
    expect(created.map((d) => d.displayOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const listed = await listFields();
    expect(listed.map((d) => d.id)).toEqual(created.map((d) => d.id));

    // Every select option is given a server-side id, whatever the client sent.
    const select = created.find((d) => d.fieldType === "single_select");
    expect(select.config.options).toHaveLength(2);
    for (const option of select.config.options) {
      expect(option.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(option.active).toBe(true);
    }
  });

  test("the generated key is a slug of the name and does not move when the field is renamed", { tag: '@tesbo.testId("TES-TC-127")' }, async () => {
    const definition = await createField({ name: "E2E Risk Level!", fieldType: "text" });
    expect(definition.key).toMatch(/^e2e-risk-level-[0-9a-f]{4}$/);

    const renamed = await asOwner.patch(definitionUrl(definition.id), { data: { name: fieldName("Renamed") } });
    expect((await renamed.json()).key).toBe(definition.key);
  });

  test("a field created with active:false lands inactive", { tag: '@tesbo.testId("TES-TC-128")' }, async () => {
    const definition = await createField({ name: fieldName("Dormant"), fieldType: "text", active: false });
    expect(definition.status).toBe("inactive");
    expect(storedStatus(definition.id)).toBe("inactive");
  });

  test("a field can be created as required", { tag: '@tesbo.testId("TES-TC-129")' }, async () => {
    const definition = await createField({ name: fieldName("Mandatory"), fieldType: "text", required: true });
    expect(definition.required).toBe(true);
  });

  test("a name is required, and whitespace does not count as one", { tag: '@tesbo.testId("TES-TC-130")' }, async () => {
    for (const name of [undefined, "", "   ", "\t\n"]) {
      const res = await post(asOwner, { name, fieldType: "text" });
      expect(res.status(), `name ${JSON.stringify(name)}`).toBe(400);
      expect((await res.json()).error).toContain("name is required");
    }
  });

  test("names collide case-insensitively, but an archived field frees its name again", { tag: '@tesbo.testId("TES-TC-131")' }, async () => {
    const name = fieldName("Duplicate");
    const first = await createField({ name, fieldType: "text" });

    const clash = await post(asOwner, { name: name.toUpperCase(), fieldType: "number" });
    expect(clash.status()).toBe(400);
    expect((await clash.json()).error).toContain("already exists");

    await asOwner.patch(`${definitionUrl(first.id)}/status`, { data: { status: "archived" } });
    const reused = await createField({ name, fieldType: "text" });
    expect(reused.id).not.toBe(first.id);
  });

  test(
    "a name reserved for a built-in test case column is rejected on create and on rename",
    { tag: '@tesbo.testId("TES-TC-170")' },
    async () => {
      // Once this field started appearing as a real column in the export/import template
      // (Tesbo-Backend-Nest/src/legacy/legacy.controller.ts's template()), a field named e.g.
      // "Title" or "externalId" would land on the exact same normalized header as the built-in
      // column — see RESERVED_TESTCASE_HEADERS. Blocked at the source rather than worked around
      // downstream in every place that generates a file.
      for (const reserved of ["Title", "EXTERNALID", "Estimated Duration", "Expected Result"]) {
        const res = await post(asOwner, { name: reserved, fieldType: "text" });
        expect(res.status(), `creating a field named "${reserved}"`).toBe(400);
        expect((await res.json()).error).toContain("reserved");
      }

      const definition = await textField();
      const renamed = await asOwner.patch(definitionUrl(definition.id), {
        data: { name: "Status" },
        failOnStatusCode: false,
      });
      expect(renamed.status()).toBe(400);
      expect((await renamed.json()).error).toContain("reserved");
    },
  );

  test("fieldType must be one of the seven supported types", { tag: '@tesbo.testId("TES-TC-132")' }, async () => {
    for (const fieldType of [undefined, "", "string", "TEXT", "dropdown", 7]) {
      const res = await post(asOwner, { name: fieldName("Bad type"), fieldType });
      expect(res.status(), `fieldType ${JSON.stringify(fieldType)}`).toBe(400);
      expect((await res.json()).error).toContain("Invalid fieldType");
    }
  });

  test("a select field needs at least one usable option", { tag: '@tesbo.testId("TES-TC-133")' }, async () => {
    const cases: { label: string; options: unknown }[] = [
      { label: "no options key", options: undefined },
      { label: "empty list", options: [] },
      { label: "blank label", options: [{ label: "  " }] },
    ];
    for (const { label, options } of cases) {
      for (const fieldType of ["single_select", "multi_select"]) {
        const res = await post(asOwner, { name: fieldName(label), fieldType, config: { options } });
        expect(res.status(), `${fieldType} with ${label}`).toBe(400);
        expect((await res.json()).field).toBe("options");
      }
    }
  });

  test("option labels within a field must be unique, case-insensitively", { tag: '@tesbo.testId("TES-TC-134")' }, async () => {
    const res = await post(asOwner, {
      name: fieldName("Dup options"),
      fieldType: "single_select",
      config: { options: [{ label: "Chrome" }, { label: "chrome" }] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain("Duplicate option label");
  });

  test("maxLength is bounded by the per-type ceiling", { tag: '@tesbo.testId("TES-TC-135")' }, async () => {
    for (const [fieldType, ceiling] of Object.entries(MAX_LENGTH_CEILING)) {
      const atCeiling = await createField({ name: fieldName(`${fieldType} max`), fieldType, config: { maxLength: ceiling } });
      expect(atCeiling.config.maxLength).toBe(ceiling);

      for (const maxLength of [0, -1, 1.5, ceiling + 1, "40"]) {
        const res = await post(asOwner, { name: fieldName(`${fieldType} bad`), fieldType, config: { maxLength } });
        expect(res.status(), `${fieldType} maxLength ${maxLength}`).toBe(400);
        expect((await res.json()).field).toBe("maxLength");
      }
    }
  });

  test("a default value has to fit the field it belongs to", { tag: '@tesbo.testId("TES-TC-136")' }, async () => {
    const cases: { label: string; body: Record<string, unknown> }[] = [
      { label: "number default on a text field", body: { fieldType: "text", config: { defaultValue: 12 } } },
      {
        label: "default longer than maxLength",
        body: { fieldType: "text", config: { maxLength: 3, defaultValue: "abcd" } },
      },
      { label: "string default on a number field", body: { fieldType: "number", config: { defaultValue: "3" } } },
      { label: "default below min", body: { fieldType: "number", config: { min: 5, defaultValue: 1 } } },
      { label: "default above max", body: { fieldType: "number", config: { max: 5, defaultValue: 9 } } },
      {
        label: "decimal default with decimals switched off",
        body: { fieldType: "number", config: { decimalsAllowed: false, defaultValue: 1.5 } },
      },
      { label: "string default on a boolean field", body: { fieldType: "boolean", config: { defaultValue: "yes" } } },
      { label: "US-format default date", body: { fieldType: "date", config: { defaultValue: "12/31/2026" } } },
      { label: "non-date default date", body: { fieldType: "date", config: { defaultValue: "someday" } } },
      {
        label: "past default when past dates are refused",
        body: { fieldType: "date", config: { allowPastDates: false, defaultValue: "2001-01-01" } },
      },
    ];

    for (const { label, body } of cases) {
      const res = await post(asOwner, { name: fieldName(label), ...body });
      expect(res.status(), label).toBe(400);
      expect((await res.json()).field, label).toBe("defaultValue");
    }
  });

  test("number config rejects an inverted range and an oversized unit", { tag: '@tesbo.testId("TES-TC-137")' }, async () => {
    const inverted = await post(asOwner, { name: fieldName("Inverted"), fieldType: "number", config: { min: 10, max: 1 } });
    expect(inverted.status()).toBe(400);
    expect((await inverted.json()).message).toContain("min cannot exceed max");

    const unit = await post(asOwner, {
      name: fieldName("Long unit"),
      fieldType: "number",
      config: { unit: "u".repeat(33) },
    });
    expect(unit.status()).toBe(400);
    expect((await unit.json()).field).toBe("unit");
  });

  test("multi-select selection bounds have to be satisfiable", { tag: '@tesbo.testId("TES-TC-138")' }, async () => {
    const options = [{ label: "One" }, { label: "Two" }];
    const tooMany = await post(asOwner, {
      name: fieldName("Too many"),
      fieldType: "multi_select",
      config: { options, maxSelected: 3 },
    });
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).field).toBe("maxSelected");

    const inverted = await post(asOwner, {
      name: fieldName("Inverted selection"),
      fieldType: "multi_select",
      config: { options, minSelected: 2, maxSelected: 1 },
    });
    expect(inverted.status()).toBe(400);
    expect((await inverted.json()).field).toBe("minSelected");

    const negative = await post(asOwner, {
      name: fieldName("Negative selection"),
      fieldType: "multi_select",
      config: { options, minSelected: -1 },
    });
    expect(negative.status()).toBe(400);
  });

  test("a default selection must point at an option that is actually selectable", { tag: '@tesbo.testId("TES-TC-139")' }, async () => {
    const single = await post(asOwner, {
      name: fieldName("Ghost default"),
      fieldType: "single_select",
      config: { options: [{ label: "Only" }], defaultOptionId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(single.status()).toBe(400);
    expect((await single.json()).field).toBe("defaultOptionId");

    // An option supplied as inactive can't be the default either — the field would open with a
    // value nobody is allowed to re-select.
    const inactiveId = "11111111-1111-4111-8111-111111111111";
    const multi = await post(asOwner, {
      name: fieldName("Inactive default"),
      fieldType: "multi_select",
      config: {
        options: [{ id: inactiveId, label: "Retired", active: false }, { label: "Live" }],
        defaultOptionIds: [inactiveId],
      },
    });
    expect(multi.status()).toBe(400);
    expect((await multi.json()).field).toBe("defaultOptionIds");
  });

  test("a name is accepted up to the column limit and refused beyond it", { tag: '@tesbo.testId("TES-TC-140")' }, async () => {
    const atLimit = await createField({ name: "E".repeat(NAME_COLUMN_LIMIT), fieldType: "text" });
    expect(atLimit.name).toHaveLength(NAME_COLUMN_LIMIT);

    // A name Postgres can't store must come back as a validation error, not a 500.
    const overLimit = await post(asOwner, { name: "E".repeat(NAME_COLUMN_LIMIT + 1), fieldType: "text" });
    expect(overLimit.status(), await overLimit.text()).toBe(400);
  });

  // ─── Reading ───────────────────────────────────────────────────────────────

  test("the list can be narrowed by status, and archived fields are excluded unless asked for", { tag: '@tesbo.testId("TES-TC-141")' }, async () => {
    const active = await textField();
    const inactive = await textField({ active: false });
    const archived = await textField();
    await asOwner.patch(`${definitionUrl(archived.id)}/status`, { data: { status: "archived" } });

    const all = await listFields();
    expect(all.map((d) => d.id).sort()).toEqual([active.id, inactive.id, archived.id].sort());

    const onlyActive = await listFields(asOwner, "?status=active");
    expect(onlyActive.map((d) => d.id)).toEqual([active.id]);

    const live = await listFields(asOwner, "?status=active,inactive");
    expect(live.map((d) => d.id).sort()).toEqual([active.id, inactive.id].sort());

    const onlyArchived = await listFields(asOwner, "?status=archived");
    expect(onlyArchived.map((d) => d.id)).toEqual([archived.id]);
  });

  test("a single definition can be read back, and an unreachable id is a 404 rather than a 500", { tag: '@tesbo.testId("TES-TC-142")' }, async () => {
    const definition = await textField();
    const res = await asOwner.get(definitionUrl(definition.id));
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).id).toBe(definition.id);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const missing = await asOwner.get(definitionUrl(id), { failOnStatusCode: false });
      expect(missing.status(), `GET definitions/${id} — ${await missing.text()}`).toBe(404);
    }
  });

  test("an id Postgres cannot even parse is answered like any other unknown field", { tag: '@tesbo.testId("TES-TC-143")' }, async () => {
    // Every one of these compares `id = $1` against a uuid column: unguarded, a typo in the URL
    // raises 22P02 and surfaces as a 500 rather than a 404.
    const routes: [string, () => Promise<APIResponse>][] = [
      ["PATCH update", () => asOwner.patch(definitionUrl("not-a-uuid"), { data: { name: fieldName("X") }, failOnStatusCode: false })],
      [
        "PATCH status",
        () => asOwner.patch(`${definitionUrl("not-a-uuid")}/status`, { data: { status: "archived" }, failOnStatusCode: false }),
      ],
      [
        "POST option",
        () => asOwner.post(`${definitionUrl("not-a-uuid")}/options`, { data: { label: "X" }, failOnStatusCode: false }),
      ],
      [
        "PATCH option",
        () =>
          asOwner.patch(`${definitionUrl("not-a-uuid")}/options/also-not-a-uuid`, {
            data: { active: false },
            failOnStatusCode: false,
          }),
      ],
      ["DELETE", () => asOwner.delete(definitionUrl("not-a-uuid"), { failOnStatusCode: false })],
    ];

    for (const [label, call] of routes) {
      const res = await call();
      expect(res.status(), `${label} with a malformed id — ${await res.text()}`).toBe(404);
    }
  });

  test("isUsed reports whether any test case has recorded a value for the field", { tag: '@tesbo.testId("TES-TC-144")' }, async () => {
    const definition = await textField();
    expect((await asOwner.get(definitionUrl(definition.id)).then((r) => r.json())).isUsed).toBe(false);

    recordValue(definition.id, "recorded");
    expect((await asOwner.get(definitionUrl(definition.id)).then((r) => r.json())).isUsed).toBe(true);
    expect((await listFields()).find((d) => d.id === definition.id).isUsed).toBe(true);
  });

  // ─── Update ────────────────────────────────────────────────────────────────

  test("name, description and required can be edited after creation", { tag: '@tesbo.testId("TES-TC-145")' }, async () => {
    const definition = await createField({
      name: fieldName("Editable"),
      fieldType: "text",
      description: "before",
      required: false,
    });

    const nextName = fieldName("Edited");
    const res = await asOwner.patch(definitionUrl(definition.id), {
      data: { name: nextName, description: "after", required: true },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const updated = await res.json();
    expect(updated).toMatchObject({ name: nextName, description: "after", required: true });
    expect(updated.updatedBy).toBe(tenant!.owner.userId);

    const persisted = await asOwner.get(definitionUrl(definition.id)).then((r) => r.json());
    expect(persisted).toMatchObject({ name: nextName, description: "after", required: true });
  });

  test("a partial config patch merges into the stored config instead of replacing it", { tag: '@tesbo.testId("TES-TC-146")' }, async () => {
    const definition = await textField({ config: { maxLength: 20, placeholder: "keep me" } });

    const updated = await asOwner
      .patch(definitionUrl(definition.id), { data: { config: { maxLength: 50 } } })
      .then((r) => r.json());

    expect(updated.config.maxLength).toBe(50);
    expect(updated.config.placeholder).toBe("keep me");
  });

  test("the field type is fixed at creation", { tag: '@tesbo.testId("TES-TC-147")' }, async () => {
    const definition = await textField();
    const res = await asOwner.patch(definitionUrl(definition.id), {
      data: { fieldType: "number" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("Field type cannot be changed");
    expect((await asOwner.get(definitionUrl(definition.id)).then((r) => r.json())).fieldType).toBe("text");
  });

  test("a rename cannot take a live field's name, but may re-case its own", { tag: '@tesbo.testId("TES-TC-148")' }, async () => {
    const other = await textField();
    const definition = await createField({ name: fieldName("Own name"), fieldType: "text" });

    const clash = await asOwner.patch(definitionUrl(definition.id), {
      data: { name: other.name.toLowerCase() },
      failOnStatusCode: false,
    });
    expect(clash.status()).toBe(400);
    expect((await clash.json()).error).toContain("already exists");

    const recased = await asOwner.patch(definitionUrl(definition.id), { data: { name: definition.name.toUpperCase() } });
    expect(recased.ok(), await recased.text()).toBeTruthy();
    expect((await recased.json()).name).toBe(definition.name.toUpperCase());
  });

  test("an update needs a non-empty name and an existing definition", { tag: '@tesbo.testId("TES-TC-149")' }, async () => {
    const definition = await textField();
    const blank = await asOwner.patch(definitionUrl(definition.id), { data: { name: "   " }, failOnStatusCode: false });
    expect(blank.status()).toBe(400);

    const missing = await asOwner.patch(definitionUrl("00000000-0000-4000-8000-000000000000"), {
      data: { name: fieldName("Ghost") },
      failOnStatusCode: false,
    });
    expect(missing.status()).toBe(404);
  });

  test("an archived field is read-only", { tag: '@tesbo.testId("TES-TC-150")' }, async () => {
    const definition = await selectField();
    await asOwner.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" } });

    const edit = await asOwner.patch(definitionUrl(definition.id), {
      data: { name: fieldName("Resurrected") },
      failOnStatusCode: false,
    });
    expect(edit.status()).toBe(400);
    expect((await edit.json()).error).toContain("read-only");

    const option = await asOwner.post(`${definitionUrl(definition.id)}/options`, {
      data: { label: "Gamma" },
      failOnStatusCode: false,
    });
    expect(option.status()).toBe(400);

    const reactivate = await asOwner.patch(`${definitionUrl(definition.id)}/status`, {
      data: { status: "active" },
      failOnStatusCode: false,
    });
    expect(reactivate.status()).toBe(400);
    expect((await reactivate.json()).error).toContain("cannot be reactivated");
    expect(storedStatus(definition.id)).toBe("archived");
  });

  // ─── Status lifecycle ──────────────────────────────────────────────────────

  test("a field can be deactivated and brought back, and archiving is one-way", { tag: '@tesbo.testId("TES-TC-151")' }, async () => {
    const definition = await textField();

    const deactivated = await asOwner.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "inactive" } });
    expect((await deactivated.json()).status).toBe("inactive");
    expect(storedStatus(definition.id)).toBe("inactive");

    const reactivated = await asOwner.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "active" } });
    expect((await reactivated.json()).status).toBe("active");

    const archived = await asOwner.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" } });
    expect((await archived.json()).status).toBe("archived");
    expect(storedStatus(definition.id)).toBe("archived");
  });

  test("an unknown status value is refused", { tag: '@tesbo.testId("TES-TC-152")' }, async () => {
    const definition = await textField();
    for (const status of [undefined, "", "deleted", "ACTIVE", 1]) {
      const res = await asOwner.patch(`${definitionUrl(definition.id)}/status`, {
        data: { status },
        failOnStatusCode: false,
      });
      expect(res.status(), `status ${JSON.stringify(status)}`).toBe(400);
    }
    expect(storedStatus(definition.id)).toBe("active");
  });

  // ─── Options ───────────────────────────────────────────────────────────────

  test("an option can be appended to a select field", { tag: '@tesbo.testId("TES-TC-153")' }, async () => {
    const definition = await selectField();
    const res = await asOwner.post(`${definitionUrl(definition.id)}/options`, { data: { label: " Gamma " } });
    expect(res.ok(), await res.text()).toBeTruthy();

    const options = (await res.json()).config.options;
    expect(options).toHaveLength(3);
    expect(options[2]).toMatchObject({ label: "Gamma", active: true, order: 2 });
    expect(options[2].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("appending an option refuses a duplicate label, a blank one, and a non-select field", { tag: '@tesbo.testId("TES-TC-154")' }, async () => {
    const definition = await selectField();

    const duplicate = await asOwner.post(`${definitionUrl(definition.id)}/options`, {
      data: { label: "alpha" },
      failOnStatusCode: false,
    });
    expect(duplicate.status()).toBe(400);
    expect((await duplicate.json()).error).toContain("Duplicate option label");

    for (const label of [undefined, "", "   "]) {
      const blank = await asOwner.post(`${definitionUrl(definition.id)}/options`, {
        data: { label },
        failOnStatusCode: false,
      });
      expect(blank.status(), `label ${JSON.stringify(label)}`).toBe(400);
    }

    const text = await textField();
    const wrongType = await asOwner.post(`${definitionUrl(text.id)}/options`, {
      data: { label: "Nope" },
      failOnStatusCode: false,
    });
    expect(wrongType.status()).toBe(400);
    expect((await wrongType.json()).error).toContain("Only select fields have options");

    const missing = await asOwner.post(`${definitionUrl("00000000-0000-4000-8000-000000000000")}/options`, {
      data: { label: "Nope" },
      failOnStatusCode: false,
    });
    expect(missing.status()).toBe(404);
  });

  test("an option can be deactivated and reactivated without losing its id", { tag: '@tesbo.testId("TES-TC-155")' }, async () => {
    const definition = await selectField();
    const optionId = definition.config.options[0].id;

    const off = await asOwner.patch(`${definitionUrl(definition.id)}/options/${optionId}`, { data: { active: false } });
    expect(off.ok(), await off.text()).toBeTruthy();
    expect((await off.json()).config.options.find((o: any) => o.id === optionId).active).toBe(false);

    const on = await asOwner.patch(`${definitionUrl(definition.id)}/options/${optionId}`, { data: { active: true } });
    expect((await on.json()).config.options.find((o: any) => o.id === optionId).active).toBe(true);
  });

  test("toggling an option that does not belong to the field is a 404", { tag: '@tesbo.testId("TES-TC-156")' }, async () => {
    const definition = await selectField();
    const res = await asOwner.patch(`${definitionUrl(definition.id)}/options/00000000-0000-4000-8000-000000000000`, {
      data: { active: false },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toContain("Option not found");
  });

  // ─── Ordering ──────────────────────────────────────────────────────────────

  test("reordering rewrites display order and the order the list comes back in", { tag: '@tesbo.testId("TES-TC-157")' }, async () => {
    const first = await textField();
    const second = await textField();
    const third = await textField();

    const res = await asOwner.post(`${definitionsUrl()}/reorder`, {
      data: { orderedIds: [third.id, first.id, second.id] },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    expect([storedOrder(third.id), storedOrder(first.id), storedOrder(second.id)]).toEqual([0, 1, 2]);
    expect((await listFields()).map((d) => d.id)).toEqual([third.id, first.id, second.id]);
  });

  test("a reorder has to name exactly the project's live fields", { tag: '@tesbo.testId("TES-TC-158")' }, async () => {
    const first = await textField();
    const second = await textField();
    const archived = await textField();
    await asOwner.patch(`${definitionUrl(archived.id)}/status`, { data: { status: "archived" } });

    const rejected: [string, unknown][] = [
      ["empty", []],
      ["missing key", undefined],
      ["not an array", first.id],
      ["a subset", [first.id]],
      ["an unknown id", [first.id, second.id, "00000000-0000-4000-8000-000000000000"]],
      // Archived fields are excluded from the reorderable set — they sort after everything and the
      // UI hides their arrows, so including one is a client that has drifted from the server.
      ["an archived field", [first.id, second.id, archived.id]],
    ];

    for (const [label, orderedIds] of rejected) {
      const res = await asOwner.post(`${definitionsUrl()}/reorder`, {
        data: { orderedIds },
        failOnStatusCode: false,
      });
      expect(res.status(), `reorder with ${label}`).toBe(400);
    }

    // The live pair, without the archived one, is the set the endpoint expects.
    const accepted = await asOwner.post(`${definitionsUrl()}/reorder`, {
      data: { orderedIds: [second.id, first.id] },
    });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    expect(storedOrder(second.id)).toBe(0);
  });

  // ─── Deletion ──────────────────────────────────────────────────────────────
  //
  // Delete is a soft-delete (deleted_at/deleted_by), not a row removal: an in-use field used to be
  // permanently un-deletable (409 FORCE_ARCHIVE), and an archived field that was also in use had no
  // lifecycle action left at all — Edit/Deactivate/Archive hide once archived, and the old delete
  // endpoint refused any in-use field regardless of status. Soft-delete works uniformly from any
  // status and never destroys a recorded value.

  test("an unused field can be deleted; the row survives soft-deleted and disappears from the list", { tag: '@tesbo.testId("TES-TC-159")' }, async () => {
    const definition = await textField();
    const res = await asOwner.delete(definitionUrl(definition.id));
    expect(res.ok(), await res.text()).toBeTruthy();

    expect(definitionExists(definition.id)).toBe(true);
    expect(isSoftDeleted(definition.id)).toBe(true);
    expect(await listFields()).toHaveLength(0);
  });

  test("a field holding recorded values can now be deleted too, and the values are kept", { tag: '@tesbo.testId("TES-TC-160")' }, async () => {
    const definition = await textField();
    recordValue(definition.id, "in use");

    const res = await asOwner.delete(definitionUrl(definition.id));
    expect(res.ok(), await res.text()).toBeTruthy();
    expect(isSoftDeleted(definition.id)).toBe(true);
    expect(
      scalar(`SELECT COUNT(*) FROM custom_field_values WHERE definition_id = ${literal(definition.id)};`),
    ).toBe("1");
  });

  test("an archived field can be deleted directly — the old dead end for an archived, in-use field is closed", { tag: '@tesbo.testId("TES-TC-3001")' }, async () => {
    const definition = await textField();
    recordValue(definition.id, "in use");
    await asOwner.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" } });

    const res = await asOwner.delete(definitionUrl(definition.id));
    expect(res.ok(), await res.text()).toBeTruthy();
    expect(isSoftDeleted(definition.id)).toBe(true);
  });

  test("deleting the same field twice: the second call finds nothing to delete and 404s", { tag: '@tesbo.testId("TES-TC-3002")' }, async () => {
    const definition = await textField();
    const first = await asOwner.delete(definitionUrl(definition.id));
    expect(first.ok(), await first.text()).toBeTruthy();

    const second = await asOwner.delete(definitionUrl(definition.id), { failOnStatusCode: false });
    expect(second.status()).toBe(404);
  });

  test("a deleted field is unreachable through get/update/status/reorder, and its name frees up immediately", { tag: '@tesbo.testId("TES-TC-3003")' }, async () => {
    const name = fieldName("Freed on delete");
    const definition = await createField({ name, fieldType: "text" });
    await asOwner.delete(definitionUrl(definition.id));

    expect((await asOwner.get(definitionUrl(definition.id), { failOnStatusCode: false })).status()).toBe(404);
    expect(
      (await asOwner.patch(definitionUrl(definition.id), { data: { name: "x" }, failOnStatusCode: false })).status(),
    ).toBe(404);
    expect(
      (
        await asOwner.patch(`${definitionUrl(definition.id)}/status`, {
          data: { status: "archived" },
          failOnStatusCode: false,
        })
      ).status(),
    ).toBe(404);
    const reorder = await asOwner.post(`${definitionsUrl()}/reorder`, {
      data: { orderedIds: [definition.id] },
      failOnStatusCode: false,
    });
    expect(reorder.status()).toBe(400);

    // Unlike an archived field's name (freed immediately too), a brand new field can reuse this
    // one's exact name right away without waiting on anything.
    const reused = await createField({ name, fieldType: "number" });
    expect(reused.id).not.toBe(definition.id);
  });

  test("a deleted field's already-recorded value still shows read-only on the test case that has it", { tag: '@tesbo.testId("TES-TC-3004")' }, async () => {
    const definition = await textField();
    recordValue(definition.id, "kept for history");
    await asOwner.delete(definitionUrl(definition.id));

    const values = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/testcases/${testcaseId}/custom-field-values`);
    expect(values.ok(), await values.text()).toBeTruthy();
    const row = (await values.json()).find((v: any) => v.id === definition.id);
    expect(row, "deleted field's recorded value").toBeTruthy();
    expect(row.value).toBe("kept for history");

    // But it is gone from the definitions list, so nothing can newly assign this field elsewhere.
    expect(await listFields()).toHaveLength(0);
  });

  test("restoring a deleted field undoes the delete and it reappears exactly as it was", { tag: '@tesbo.testId("TES-TC-3005")' }, async () => {
    const definition = await createField({ name: fieldName("Restorable"), fieldType: "text", required: true });
    await asOwner.delete(definitionUrl(definition.id));

    const restored = await asOwner.post(restoreUrl(definition.id));
    expect(restored.ok(), await restored.text()).toBeTruthy();
    const body = await restored.json();
    expect(body.id).toBe(definition.id);
    expect(body.name).toBe(definition.name);
    expect(body.required).toBe(true);
    expect(isSoftDeleted(definition.id)).toBe(false);
    expect((await listFields()).map((d: any) => d.id)).toContain(definition.id);
  });

  test("restore refuses a field that was never deleted, one already restored, and an unknown id", { tag: '@tesbo.testId("TES-TC-3006")' }, async () => {
    const live = await textField();
    expect((await asOwner.post(restoreUrl(live.id), { failOnStatusCode: false })).status()).toBe(404);

    const deleted = await textField();
    await asOwner.delete(definitionUrl(deleted.id));
    const firstRestore = await asOwner.post(restoreUrl(deleted.id));
    expect(firstRestore.ok()).toBeTruthy();
    // Already restored — the same call again has nothing left to undo.
    expect((await asOwner.post(restoreUrl(deleted.id), { failOnStatusCode: false })).status()).toBe(404);

    expect(
      (await asOwner.post(restoreUrl("00000000-0000-4000-8000-000000000000"), { failOnStatusCode: false })).status(),
    ).toBe(404);
  });

  test("deleting a definition that isn't reachable from this project is a 404", { tag: '@tesbo.testId("TES-TC-161")' }, async () => {
    const elsewhere = await createField({ name: fieldName("Other project"), fieldType: "text" }, asOwner);
    // Move it to the tenant's second project: same workspace, different project, so only the
    // project scoping in the query can tell them apart.
    exec(
      `UPDATE custom_field_definitions SET project_id = ${literal(tenant!.secondProjectId)} ` +
        `WHERE id = ${literal(elsewhere.id)};`,
    );

    for (const id of [elsewhere.id, "00000000-0000-4000-8000-000000000000"]) {
      const res = await asOwner.delete(definitionUrl(id), { failOnStatusCode: false });
      expect(res.status(), `DELETE definitions/${id}`).toBe(404);
    }
    expect(definitionExists(elsewhere.id)).toBe(true);
    expect(isSoftDeleted(elsewhere.id)).toBe(false);

    const restore = await asOwner.post(restoreUrl(elsewhere.id), { failOnStatusCode: false });
    expect(restore.status(), "restore on a definition from another project").toBe(404);
  });

  test("a definition belonging to another project cannot be read or edited through this one", { tag: '@tesbo.testId("TES-TC-162")' }, async () => {
    const elsewhere = await createField({ name: fieldName("Foreign"), fieldType: "text" });
    exec(
      `UPDATE custom_field_definitions SET project_id = ${literal(tenant!.secondProjectId)} ` +
        `WHERE id = ${literal(elsewhere.id)};`,
    );

    const read = await asOwner.get(definitionUrl(elsewhere.id), { failOnStatusCode: false });
    expect(read.status()).toBe(404);

    const edit = await asOwner.patch(definitionUrl(elsewhere.id), {
      data: { name: fieldName("Hijacked") },
      failOnStatusCode: false,
    });
    expect(edit.status()).toBe(404);

    const status = await asOwner.patch(`${definitionUrl(elsewhere.id)}/status`, {
      data: { status: "archived" },
      failOnStatusCode: false,
    });
    expect(status.status()).toBe(404);
    expect(storedStatus(elsewhere.id)).toBe("active");
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  test("every definition route refuses a caller with no session", { tag: '@tesbo.testId("TES-TC-163")' }, async () => {
    const definition = await selectField();
    const optionId = definition.config.options[0].id;

    const routes: [string, () => Promise<APIResponse>][] = [
      ["GET list", () => anon.get(definitionsUrl(), { failOnStatusCode: false })],
      ["GET one", () => anon.get(definitionUrl(definition.id), { failOnStatusCode: false })],
      ["POST create", () => post(anon, { name: fieldName("Anon"), fieldType: "text" })],
      ["PATCH update", () => anon.patch(definitionUrl(definition.id), { data: { name: "x" }, failOnStatusCode: false })],
      [
        "POST reorder",
        () => anon.post(`${definitionsUrl()}/reorder`, { data: { orderedIds: [definition.id] }, failOnStatusCode: false }),
      ],
      [
        "PATCH status",
        () =>
          anon.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" }, failOnStatusCode: false }),
      ],
      [
        "POST option",
        () => anon.post(`${definitionUrl(definition.id)}/options`, { data: { label: "Anon" }, failOnStatusCode: false }),
      ],
      [
        "PATCH option",
        () =>
          anon.patch(`${definitionUrl(definition.id)}/options/${optionId}`, {
            data: { active: false },
            failOnStatusCode: false,
          }),
      ],
      ["DELETE", () => anon.delete(definitionUrl(definition.id), { failOnStatusCode: false })],
      ["POST restore", () => anon.post(restoreUrl(definition.id), { failOnStatusCode: false })],
    ];

    for (const [label, call] of routes) {
      const res = await call();
      expect([400, 401, 403, 404], `${label} should refuse an anonymous caller`).toContain(res.status());
    }

    // Nothing the anonymous caller sent may have landed.
    expect(storedStatus(definition.id)).toBe("active");
    expect((await listFields()).map((d) => d.id)).toEqual([definition.id]);
  });

  test("a workspace member with no access to the project cannot see or change its fields", { tag: '@tesbo.testId("TES-TC-164")' }, async () => {
    const definition = await textField();

    const list = await asGuest.get(definitionsUrl(), { failOnStatusCode: false });
    expect(list.status()).toBe(404);

    const read = await asGuest.get(definitionUrl(definition.id), { failOnStatusCode: false });
    expect(read.status()).toBe(404);

    const create = await post(asGuest, { name: fieldName("Guest"), fieldType: "text" });
    expect(create.status()).toBe(404);

    const remove = await asGuest.delete(definitionUrl(definition.id), { failOnStatusCode: false });
    expect(remove.status()).toBe(404);
    expect(definitionExists(definition.id)).toBe(true);

    const restore = await asGuest.post(restoreUrl(definition.id), { failOnStatusCode: false });
    expect(restore.status()).toBe(404);
  });

  test("a QA engineer may read the project's fields but not configure them", { tag: '@tesbo.testId("TES-TC-165")' }, async () => {
    const definition = await selectField();
    const optionId = definition.config.options[0].id;

    const listed = await listFields(asQa);
    expect(listed.map((d) => d.id)).toEqual([definition.id]);
    expect((await asQa.get(definitionUrl(definition.id))).ok()).toBeTruthy();

    const refused: [string, () => Promise<APIResponse>][] = [
      ["create", () => post(asQa, { name: fieldName("QA"), fieldType: "text" })],
      ["rename", () => asQa.patch(definitionUrl(definition.id), { data: { name: "x" }, failOnStatusCode: false })],
      [
        "reorder",
        () => asQa.post(`${definitionsUrl()}/reorder`, { data: { orderedIds: [definition.id] }, failOnStatusCode: false }),
      ],
      [
        "status",
        () =>
          asQa.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" }, failOnStatusCode: false }),
      ],
      [
        "add option",
        () => asQa.post(`${definitionUrl(definition.id)}/options`, { data: { label: "QA" }, failOnStatusCode: false }),
      ],
      [
        "toggle option",
        () =>
          asQa.patch(`${definitionUrl(definition.id)}/options/${optionId}`, {
            data: { active: false },
            failOnStatusCode: false,
          }),
      ],
      ["delete", () => asQa.delete(definitionUrl(definition.id), { failOnStatusCode: false })],
      ["restore", () => asQa.post(restoreUrl(definition.id), { failOnStatusCode: false })],
    ];

    for (const [label, call] of refused) {
      const res = await call();
      expect(res.status(), `QA engineer ${label}`).toBe(403);
      expect((await res.json()).error, `QA engineer ${label}`).toContain("QA Engineers cannot manage custom fields");
    }

    expect(storedStatus(definition.id)).toBe("active");
  });

  test("a manager can configure fields", { tag: '@tesbo.testId("TES-TC-166")' }, async () => {
    const definition = await createField({ name: fieldName("Manager"), fieldType: "text" }, asManager);
    const renamed = await asManager.patch(definitionUrl(definition.id), { data: { required: true } });
    expect(renamed.ok(), await renamed.text()).toBeTruthy();

    const archived = await asManager.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" } });
    expect(archived.ok()).toBeTruthy();
    expect(storedStatus(definition.id)).toBe("archived");

    const deleted = await asManager.delete(definitionUrl(definition.id));
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    expect(isSoftDeleted(definition.id)).toBe(true);
  });

  // ─── Plan gating ───────────────────────────────────────────────────────────

  test("on the Launch plan the existing fields stay readable but nothing can be configured", { tag: '@tesbo.testId("TES-TC-167")' }, async () => {
    const definition = await selectField();
    const optionId = definition.config.options[0].id;

    resetToLaunch(tenant!.organizationId);
    try {
      // Reading is deliberately never gated: a workspace that downgrades must not lose sight of the
      // fields its test cases already carry.
      const listed = await listFields();
      expect(listed.map((d) => d.id)).toEqual([definition.id]);
      expect((await asOwner.get(definitionUrl(definition.id))).ok()).toBeTruthy();

      const gated: [string, () => Promise<APIResponse>][] = [
        ["create", () => post(asOwner, { name: fieldName("Launch"), fieldType: "text" })],
        ["rename", () => asOwner.patch(definitionUrl(definition.id), { data: { name: "x" }, failOnStatusCode: false })],
        [
          "reorder",
          () =>
            asOwner.post(`${definitionsUrl()}/reorder`, {
              data: { orderedIds: [definition.id] },
              failOnStatusCode: false,
            }),
        ],
        [
          "status",
          () =>
            asOwner.patch(`${definitionUrl(definition.id)}/status`, {
              data: { status: "archived" },
              failOnStatusCode: false,
            }),
        ],
        [
          "add option",
          () =>
            asOwner.post(`${definitionUrl(definition.id)}/options`, { data: { label: "Launch" }, failOnStatusCode: false }),
        ],
        [
          "toggle option",
          () =>
            asOwner.patch(`${definitionUrl(definition.id)}/options/${optionId}`, {
              data: { active: false },
              failOnStatusCode: false,
            }),
        ],
        ["delete", () => asOwner.delete(definitionUrl(definition.id), { failOnStatusCode: false })],
        ["restore", () => asOwner.post(restoreUrl(definition.id), { failOnStatusCode: false })],
      ];

      for (const [label, call] of gated) {
        const res = await call();
        expect(res.status(), `Launch plan ${label}`).toBe(403);
        expect((await res.json()).error, `Launch plan ${label}`).toContain("Pro");
      }

      expect(storedStatus(definition.id)).toBe("active");
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  test("a workspace inside its downgrade grace window keeps configuring fields", { tag: '@tesbo.testId("TES-TC-168")' }, async () => {
    resetToLaunch(tenant!.organizationId);
    setGraceWindow(tenant!.organizationId, 5);
    try {
      const definition = await textField();
      const archived = await asOwner.patch(`${definitionUrl(definition.id)}/status`, { data: { status: "archived" } });
      expect(archived.ok(), await archived.text()).toBeTruthy();
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });

  test("once the grace window has closed the Pro gate closes with it", { tag: '@tesbo.testId("TES-TC-169")' }, async () => {
    const definition = await textField();
    setGraceWindow(tenant!.organizationId, -1);
    try {
      const res = await post(asOwner, { name: fieldName("Expired"), fieldType: "text" });
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("Pro");
      expect((await listFields()).map((d) => d.id)).toEqual([definition.id]);
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });
});
