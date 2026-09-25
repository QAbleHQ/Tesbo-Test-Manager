import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, randomUUID } from "crypto";
import { DatabaseService } from "../database/database.service";
import { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import { isUuid, LegacyService } from "../legacy/legacy.service";
import { buildCustomFieldFiltersSql } from "./custom-field-filters";
import { applyDefaultIfMissing, isEmptyValue, validateAndNormalizeValue, validateConfigShape } from "./custom-field-validation";
import {
  CustomFieldDefinitionDto,
  CustomFieldFilterInput,
  CustomFieldValueDto,
  FieldOption,
  FieldStatus,
  FieldType,
  normalizeTestcaseHeader,
  QueryRunner,
  RESERVED_TESTCASE_HEADERS
} from "./custom-fields.types";

type Body = Record<string, any>;

/**
 * The project-scoped half of a value write — the field definitions, plus the fact that the plan gate
 * already passed. Loaded once by loadWriteContext and reused across every row of a bulk write.
 */
export interface CustomFieldWriteContext {
  definitions: Body[];
  definitionsById: Map<string, Body>;
}

const FIELD_TYPES: FieldType[] = ["text", "long_text", "boolean", "single_select", "multi_select", "number", "date"];

/** custom_field_definitions.name is VARCHAR(160) — a longer one has to be refused, not attempted. */
const NAME_MAX_LENGTH = 160;

/**
 * Answers "no such field" for an id Postgres could not even cast.
 *
 * Every lookup below compares `id = $1` against a uuid column, so a malformed id raises 22P02 and
 * surfaces as a 500. A typo in a URL is not an internal error — it is a field this caller cannot
 * reach, which is exactly what a well-formed id that doesn't exist gets.
 */
function requireDefinitionId(definitionId: string): void {
  if (!isUuid(definitionId)) throw new NotFoundException({ error: "Custom field not found" });
}

function requireFieldName(name: string): void {
  if (!name) throw new BadRequestException({ error: "name is required" });
  if (name.length > NAME_MAX_LENGTH) {
    throw new BadRequestException({ error: `name must be ${NAME_MAX_LENGTH} characters or fewer` });
  }
  // A field named e.g. "Title" or "externalId" would land on the same normalized column header as
  // a fixed test case field the moment it starts appearing in the CSV/XLSX export or the import
  // template/commit — see RESERVED_TESTCASE_HEADERS. Rejecting it here is the actual fix; nothing
  // downstream can rename a field the user is actively relying on being called that.
  if (RESERVED_TESTCASE_HEADERS.has(normalizeTestcaseHeader(name))) {
    throw new BadRequestException({ error: "This name is reserved for a built-in test case field" });
  }
}

const DEFINITION_SELECT = `
  SELECT d.*, EXISTS (SELECT 1 FROM custom_field_values v WHERE v.definition_id = d.id) AS is_used
  FROM custom_field_definitions d
`;

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(?:^-)|(?:-$)/g, "")
      .slice(0, 60) || "field"
  );
}

function mapDefinitionRow(row: Body): CustomFieldDefinitionDto {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    fieldType: row.field_type,
    status: row.status,
    required: row.required,
    displayOrder: row.display_order,
    config: row.config || {},
    isUsed: Boolean(row.is_used),
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly planLimits: PlanLimitsService,
    private readonly projectLookup: ProjectLookupService,
    @Inject(forwardRef(() => LegacyService)) private readonly legacy: LegacyService
  ) {}

  private async requireConfigAccess(userId: string | null | undefined, projectId: string) {
    const project = await this.legacy.requireProjectAccess(userId, projectId);
    await this.planLimits.assertCustomFieldsEnabled(project.organization_id);
    const callerRole = this.legacy.normalizeRole(project.caller_role);
    if (callerRole === "qa_engineer") {
      throw new ForbiddenException({ error: "QA Engineers cannot manage custom fields" });
    }
    return project;
  }

  async listDefinitions(userId: string | null | undefined, projectId: string, statuses?: FieldStatus[]): Promise<CustomFieldDefinitionDto[]> {
    await this.legacy.requireProjectAccess(userId, projectId);
    const values: unknown[] = [projectId];
    let statusFilter = "";
    if (statuses?.length) {
      values.push(statuses);
      statusFilter = ` AND d.status = ANY($${values.length})`;
    }
    const res = await this.db.query(
      `${DEFINITION_SELECT} WHERE d.project_id = $1 AND d.deleted_at IS NULL${statusFilter} ORDER BY d.display_order, d.created_at`,
      values
    );
    return res.rows.map(mapDefinitionRow);
  }

  async getDefinition(userId: string | null | undefined, projectId: string, definitionId: string): Promise<CustomFieldDefinitionDto> {
    await this.legacy.requireProjectAccess(userId, projectId);
    requireDefinitionId(definitionId);
    const res = await this.db.query(`${DEFINITION_SELECT} WHERE d.id = $1 AND d.project_id = $2 AND d.deleted_at IS NULL`, [definitionId, projectId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Custom field not found" });
    return mapDefinitionRow(res.rows[0]);
  }

  async createDefinition(userId: string | null | undefined, projectId: string, body: Body): Promise<CustomFieldDefinitionDto> {
    await this.requireConfigAccess(userId, projectId);

    const name = String(body.name || "").trim();
    requireFieldName(name);
    const fieldType = body.fieldType as FieldType;
    if (!FIELD_TYPES.includes(fieldType)) throw new BadRequestException({ error: "Invalid fieldType" });
    const config = validateConfigShape(fieldType, body.config);
    const status: FieldStatus = body.active === false ? "inactive" : "active";

    const clash = await this.db.query(
      "SELECT 1 FROM custom_field_definitions WHERE project_id = $1 AND lower(name) = lower($2) AND status <> 'archived' AND deleted_at IS NULL",
      [projectId, name]
    );
    if (clash.rows[0]) throw new BadRequestException({ error: "A field with this name already exists" });

    let key = "";
    for (let attempt = 0; attempt < 5 && !key; attempt++) {
      const candidate = `${slugify(name)}-${randomBytes(2).toString("hex")}`;
      const exists = await this.db.query("SELECT 1 FROM custom_field_definitions WHERE project_id = $1 AND key = $2", [projectId, candidate]);
      if (!exists.rows[0]) key = candidate;
    }
    if (!key) throw new BadRequestException({ error: "Could not generate a unique field key, please try again" });

    const orderRes = await this.db.query<{ next: number }>(
      "SELECT COALESCE(MAX(display_order) + 1, 0) AS next FROM custom_field_definitions WHERE project_id = $1",
      [projectId]
    );

    const res = await this.db.query(
      `INSERT INTO custom_field_definitions
       (project_id, key, name, description, field_type, status, required, display_order, config, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)
       RETURNING *, false AS is_used`,
      [projectId, key, name, body.description || null, fieldType, status, Boolean(body.required), orderRes.rows[0].next, JSON.stringify(config), userId]
    );
    const dto = mapDefinitionRow(res.rows[0]);
    await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_field_created", "custom_field_definition", dto.id, dto.name, { after: dto });
    return dto;
  }

  async updateDefinition(userId: string | null | undefined, projectId: string, definitionId: string, body: Body): Promise<CustomFieldDefinitionDto> {
    await this.requireConfigAccess(userId, projectId);
    requireDefinitionId(definitionId);

    const existingRes = await this.db.query(`${DEFINITION_SELECT} WHERE d.id = $1 AND d.project_id = $2 AND d.deleted_at IS NULL`, [
      definitionId,
      projectId
    ]);
    if (!existingRes.rows[0]) throw new NotFoundException({ error: "Custom field not found" });
    const existing = mapDefinitionRow(existingRes.rows[0]);
    if (existing.status === "archived") throw new BadRequestException({ error: "Archived fields are read-only" });
    if (body.fieldType && body.fieldType !== existing.fieldType) {
      throw new BadRequestException({ error: "Field type cannot be changed after creation" });
    }

    let name = existing.name;
    if (body.name !== undefined) {
      name = String(body.name || "").trim();
      requireFieldName(name);
      if (name.toLowerCase() !== existing.name.toLowerCase()) {
        const clash = await this.db.query(
          "SELECT 1 FROM custom_field_definitions WHERE project_id = $1 AND lower(name) = lower($2) AND status <> 'archived' AND deleted_at IS NULL AND id <> $3",
          [projectId, name, definitionId]
        );
        if (clash.rows[0]) throw new BadRequestException({ error: "A field with this name already exists" });
      }
    }

    const mergedConfig = body.config !== undefined ? { ...existing.config, ...body.config } : existing.config;
    const config = validateConfigShape(existing.fieldType, mergedConfig);
    const required = body.required !== undefined ? Boolean(body.required) : existing.required;
    const description = body.description !== undefined ? body.description || null : existing.description;

    const res = await this.db.query(
      `UPDATE custom_field_definitions
       SET name = $3, description = $4, required = $5, config = $6::jsonb, updated_by = $7, updated_at = now()
       WHERE id = $1 AND project_id = $2
       RETURNING *, (SELECT EXISTS (SELECT 1 FROM custom_field_values v WHERE v.definition_id = $1)) AS is_used`,
      [definitionId, projectId, name, description, required, JSON.stringify(config), userId]
    );
    const dto = mapDefinitionRow(res.rows[0]);
    await this.logConfigChangeEvents(projectId, userId, existing, dto);
    return dto;
  }

  private async logConfigChangeEvents(
    projectId: string,
    userId: string | null | undefined,
    before: CustomFieldDefinitionDto,
    after: CustomFieldDefinitionDto
  ): Promise<void> {
    const uid = userId ?? null;
    let matched = false;
    if (before.name !== after.name) {
      await this.legacy.logProjectActivity(projectId, uid, "custom_field_renamed", "custom_field_definition", after.id, after.name, {
        before: before.name,
        after: after.name
      });
      matched = true;
    }
    if (before.required !== after.required) {
      await this.legacy.logProjectActivity(projectId, uid, "custom_field_required_toggled", "custom_field_definition", after.id, after.name, {
        before: before.required,
        after: after.required
      });
      matched = true;
    }
    const beforeOptions = before.config.options || [];
    const afterOptions = after.config.options || [];
    const beforeById = new Map(beforeOptions.map((o) => [o.id, o]));
    for (const option of afterOptions) {
      const prior = beforeById.get(option.id);
      if (!prior) {
        await this.legacy.logProjectActivity(projectId, uid, "custom_field_option_added", "custom_field_definition", after.id, after.name, {
          optionId: option.id,
          label: option.label
        });
        matched = true;
      } else if (prior.active && !option.active) {
        await this.legacy.logProjectActivity(projectId, uid, "custom_field_option_deactivated", "custom_field_definition", after.id, after.name, {
          optionId: option.id,
          label: option.label
        });
        matched = true;
      }
    }
    if (!matched && JSON.stringify(before.config) !== JSON.stringify(after.config)) {
      await this.legacy.logProjectActivity(projectId, uid, "custom_field_config_updated", "custom_field_definition", after.id, after.name, {
        before: before.config,
        after: after.config
      });
    }
  }

  async addOption(userId: string | null | undefined, projectId: string, definitionId: string, label: string): Promise<CustomFieldDefinitionDto> {
    await this.requireConfigAccess(userId, projectId);
    requireDefinitionId(definitionId);
    const trimmed = String(label || "").trim();
    if (!trimmed) throw new BadRequestException({ error: "label is required" });

    return this.db.transaction(async (client) => {
      const res = await client.query(`SELECT * FROM custom_field_definitions WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
        definitionId,
        projectId
      ]);
      const row = res.rows[0];
      if (!row) throw new NotFoundException({ error: "Custom field not found" });
      if (row.status === "archived") throw new BadRequestException({ error: "Archived fields are read-only" });
      if (row.field_type !== "single_select" && row.field_type !== "multi_select") {
        throw new BadRequestException({ error: "Only select fields have options" });
      }
      const options: FieldOption[] = row.config?.options || [];
      if (options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase())) {
        throw new BadRequestException({ error: "Duplicate option label" });
      }
      const option: FieldOption = { id: randomUUID(), label: trimmed, active: true, order: options.length };
      const nextConfig = { ...row.config, options: [...options, option] };

      const updateRes = await client.query(
        `UPDATE custom_field_definitions SET config = $3::jsonb, updated_by = $4, updated_at = now()
         WHERE id = $1 AND project_id = $2
         RETURNING *, (SELECT EXISTS (SELECT 1 FROM custom_field_values v WHERE v.definition_id = $1)) AS is_used`,
        [definitionId, projectId, JSON.stringify(nextConfig), userId]
      );
      const dto = mapDefinitionRow(updateRes.rows[0]);
      await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_field_option_added", "custom_field_definition", dto.id, dto.name, {
        optionId: option.id,
        label: option.label
      });
      return dto;
    });
  }

  async setOptionActive(
    userId: string | null | undefined,
    projectId: string,
    definitionId: string,
    optionId: string,
    active: boolean
  ): Promise<CustomFieldDefinitionDto> {
    await this.requireConfigAccess(userId, projectId);
    requireDefinitionId(definitionId);

    return this.db.transaction(async (client) => {
      const res = await client.query(`SELECT * FROM custom_field_definitions WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
        definitionId,
        projectId
      ]);
      const row = res.rows[0];
      if (!row) throw new NotFoundException({ error: "Custom field not found" });
      if (row.status === "archived") throw new BadRequestException({ error: "Archived fields are read-only" });
      const options: FieldOption[] = row.config?.options || [];
      const option = options.find((o) => o.id === optionId);
      if (!option) throw new NotFoundException({ error: "Option not found" });
      option.active = active;
      const nextConfig = { ...row.config, options };

      const updateRes = await client.query(
        `UPDATE custom_field_definitions SET config = $3::jsonb, updated_by = $4, updated_at = now()
         WHERE id = $1 AND project_id = $2
         RETURNING *, (SELECT EXISTS (SELECT 1 FROM custom_field_values v WHERE v.definition_id = $1)) AS is_used`,
        [definitionId, projectId, JSON.stringify(nextConfig), userId]
      );
      const dto = mapDefinitionRow(updateRes.rows[0]);
      await this.legacy.logProjectActivity(
        projectId,
        userId ?? null,
        active ? "custom_field_option_reactivated" : "custom_field_option_deactivated",
        "custom_field_definition",
        dto.id,
        dto.name,
        { optionId: option.id, label: option.label }
      );
      return dto;
    });
  }

  async reorderDefinitions(userId: string | null | undefined, projectId: string, orderedIds: string[]): Promise<void> {
    await this.requireConfigAccess(userId, projectId);
    if (!Array.isArray(orderedIds) || !orderedIds.length) throw new BadRequestException({ error: "orderedIds is required" });

    const current = await this.db.query<{ id: string }>(
      "SELECT id FROM custom_field_definitions WHERE project_id = $1 AND status <> 'archived' AND deleted_at IS NULL",
      [projectId]
    );
    const currentIds = new Set(current.rows.map((r) => r.id));
    const incomingIds = new Set(orderedIds);
    const matches = currentIds.size === incomingIds.size && [...currentIds].every((id) => incomingIds.has(id));
    if (!matches) throw new BadRequestException({ error: "orderedIds must exactly match the project's active/inactive custom fields" });

    await this.db.transaction(async (client) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          "UPDATE custom_field_definitions SET display_order = $3, updated_by = $4, updated_at = now() WHERE id = $1 AND project_id = $2",
          [orderedIds[i], projectId, i, userId]
        );
      }
    });
    await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_field_reordered", "project", projectId, null, { order: orderedIds });
  }

  async setStatus(userId: string | null | undefined, projectId: string, definitionId: string, status: FieldStatus): Promise<CustomFieldDefinitionDto> {
    await this.requireConfigAccess(userId, projectId);
    requireDefinitionId(definitionId);
    if (!["active", "inactive", "archived"].includes(status)) throw new BadRequestException({ error: "Invalid status" });

    const existingRes = await this.db.query(`${DEFINITION_SELECT} WHERE d.id = $1 AND d.project_id = $2 AND d.deleted_at IS NULL`, [
      definitionId,
      projectId
    ]);
    if (!existingRes.rows[0]) throw new NotFoundException({ error: "Custom field not found" });
    const existing = mapDefinitionRow(existingRes.rows[0]);
    if (existing.status === "archived") throw new BadRequestException({ error: "Archived fields cannot be reactivated" });

    const res = await this.db.query(
      `UPDATE custom_field_definitions SET status = $3, updated_by = $4, updated_at = now()
       WHERE id = $1 AND project_id = $2
       RETURNING *, (SELECT EXISTS (SELECT 1 FROM custom_field_values v WHERE v.definition_id = $1)) AS is_used`,
      [definitionId, projectId, status, userId]
    );
    const dto = mapDefinitionRow(res.rows[0]);
    const action = status === "archived" ? "custom_field_archived" : status === "active" ? "custom_field_reactivated" : "custom_field_deactivated";
    await this.legacy.logProjectActivity(projectId, userId ?? null, action, "custom_field_definition", dto.id, dto.name, {
      before: existing.status,
      after: status
    });
    return dto;
  }

  /**
   * Soft-delete: sets deleted_at/deleted_by rather than removing the row, so recorded values on
   * test cases that already hold one are never destroyed (see getValuesForTestCase's `OR v.id IS
   * NOT NULL` carve-out) and the action works uniformly regardless of `status` or `isUsed` — the
   * two things that used to leave an in-use, archived field with no lifecycle action left at all.
   *
   * Guarded by `deleted_at IS NULL` so a second delete of the same field (double-click, a second
   * tab, a retried request) finds nothing to update and surfaces the same 404 as a truly unknown
   * id, instead of silently double-logging the activity feed.
   */
  async deleteDefinition(userId: string | null | undefined, projectId: string, definitionId: string): Promise<void> {
    await this.requireConfigAccess(userId, projectId);
    requireDefinitionId(definitionId);

    const res = await this.db.query(
      `UPDATE custom_field_definitions SET deleted_at = now(), deleted_by = $3, updated_by = $3, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [definitionId, projectId, userId ?? null]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Custom field not found" });
    const dto = mapDefinitionRow(res.rows[0]);
    await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_field_deleted", "custom_field_definition", dto.id, dto.name, { before: dto });
  }

  /**
   * Undoes a delete. Only reachable while the field is still soft-deleted — once
   * CustomFieldDefinitionList's session-local "Undo" affordance is gone (the settings page was
   * reloaded), nothing in the product calls this anymore, but the row itself remains restorable
   * at the database layer indefinitely; this is the only path back.
   */
  async restoreDefinition(userId: string | null | undefined, projectId: string, definitionId: string): Promise<CustomFieldDefinitionDto> {
    await this.requireConfigAccess(userId, projectId);
    requireDefinitionId(definitionId);

    const res = await this.db.query(
      `UPDATE custom_field_definitions SET deleted_at = NULL, deleted_by = NULL, updated_by = $3, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND deleted_at IS NOT NULL
       RETURNING *, (SELECT EXISTS (SELECT 1 FROM custom_field_values v WHERE v.definition_id = $1)) AS is_used`,
      [definitionId, projectId, userId ?? null]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Deleted custom field not found" });
    const dto = mapDefinitionRow(res.rows[0]);
    await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_field_restored", "custom_field_definition", dto.id, dto.name, { after: dto });
    return dto;
  }

  async getValuesForTestCase(userId: string | null | undefined, projectId: string, testcaseId: string): Promise<CustomFieldValueDto[]> {
    await this.legacy.requireProjectAccess(userId, projectId);
    if (!isUuid(testcaseId)) throw new NotFoundException({ error: "Test case not found" });
    const tc = await this.db.query("SELECT 1 FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL", [testcaseId, projectId]);
    if (!tc.rows[0]) throw new NotFoundException({ error: "Test case not found" });

    const res = await this.db.query(
      `SELECT d.id, d.key, d.name, d.description, d.field_type, d.status, d.required, d.config, d.display_order, v.value
       FROM custom_field_definitions d
       LEFT JOIN custom_field_values v ON v.definition_id = d.id AND v.testcase_id = $2
       WHERE d.project_id = $1 AND d.status = 'active' AND (d.deleted_at IS NULL OR v.id IS NOT NULL)
       ORDER BY d.display_order`,
      [projectId, testcaseId]
    );
    return res.rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description ?? null,
      fieldType: row.field_type,
      status: row.status,
      required: row.required,
      displayOrder: row.display_order,
      config: row.config || {},
      value: row.value ?? null
    }));
  }

  /**
   * Core value-write path. `mode` controls how the Pro-plan gate behaves:
   * - "enforce" (dedicated PUT .../custom-field-values endpoint): a project-access check
   *   is performed and a disabled plan throws the paywall 403.
   * - "skip-if-disabled" (embedded in legacy.service.ts's createTestCase/updateTestCase,
   *   invoked on every test case save regardless of whether the project uses custom
   *   fields): a disabled plan silently no-ops instead of throwing, so ordinary test case
   *   creation/editing on Launch-plan workspaces is never affected by this feature.
   */
  async setValuesForTestCase(
    actorId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    values: Body,
    runner: QueryRunner = this.db,
    mode: "enforce" | "skip-if-disabled" = "enforce",
    options: { testCaseIsNew?: boolean } = {}
  ): Promise<void> {
    if (mode === "enforce") {
      await this.legacy.requireProjectAccess(actorId, projectId);
      // The caller reaches this route through a project they can see, but the test case id is their
      // own input — without this it could name ANY test case in the deployment, including another
      // workspace's, and this method would happily write values onto it. "skip-if-disabled" callers
      // (createTestCase/updateTestCase) don't need the check: they resolved the row themselves.
      if (!isUuid(testcaseId)) throw new NotFoundException({ error: "Test case not found" });
      const owned = await this.db.query("SELECT 1 FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL", [
        testcaseId,
        projectId
      ]);
      if (!owned.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    }

    const context = await this.loadWriteContext(projectId, runner, mode);
    if (!context) return;
    await this.setValuesWithContext(actorId, projectId, testcaseId, values, context, runner, options);
  }

  /**
   * Reads the half of a value write that depends only on the project: whether the plan allows custom
   * fields, and the project's field definitions.
   *
   * Split out so a bulk caller can read it once for a whole batch. The test case import used to reach
   * setValuesForTestCase once per row and pay these three queries per row, on every import, including
   * on projects that define no custom fields at all.
   *
   * Returns null only in "skip-if-disabled" mode, meaning "the plan has this switched off, write
   * nothing"; "enforce" throws the paywall error instead.
   */
  async loadWriteContext(
    projectId: string,
    runner: QueryRunner = this.db,
    mode: "enforce" | "skip-if-disabled" = "skip-if-disabled"
  ): Promise<CustomFieldWriteContext | null> {
    try {
      // Memoized per-request by ProjectLookupService when `runner` is the default pool (the common
      // case here); bypassed to a live read through `runner` untouched when a caller passes an
      // explicit transaction client, so this never serves a stale value to a caller reading inside
      // the testcase-external-id advisory lock (see ProjectLookupService's own doc comment).
      const project = await this.projectLookup.getProjectBasics(projectId, runner === this.db ? undefined : runner);
      const organizationId = project?.organizationId;
      if (organizationId) await this.planLimits.assertCustomFieldsEnabled(organizationId);
    } catch (err) {
      if (mode === "skip-if-disabled") return null;
      throw err;
    }

    const definitionsRes = await runner.query<Body>("SELECT * FROM custom_field_definitions WHERE project_id = $1 AND deleted_at IS NULL", [
      projectId
    ]);
    const definitions = definitionsRes.rows;
    return { definitions, definitionsById: new Map(definitions.map((d) => [d.id, d])) };
  }

  /**
   * Validates one test case's incoming values against the project's definitions, folds in the
   * configured defaults, and enforces required fields — all in memory, touching no database.
   *
   * Separated from the write so the bulk import can validate a whole file up front and then insert
   * every surviving row's values in a single statement. Against a remote database that is the whole
   * game: a round trip costs far more than any of this arithmetic.
   *
   * `existing` is what the test case already holds, and is empty for a row being created.
   */
  normalizeValues(
    values: Body,
    context: CustomFieldWriteContext,
    existing: Map<string, unknown> = new Map()
  ): { normalized: Body; errors: { field: string; message: string }[] } {
    const { definitions, definitionsById } = context;
    const errors: { field: string; message: string }[] = [];
    const normalized: Body = {};

    for (const [definitionId, raw] of Object.entries(values || {})) {
      const definition = definitionsById.get(definitionId);
      if (!definition) {
        errors.push({ field: definitionId, message: "Unknown custom field" });
        continue;
      }
      if (definition.status === "archived") {
        errors.push({ field: definitionId, message: "Cannot set a value for an archived field" });
        continue;
      }
      if (isEmptyValue(raw)) {
        normalized[definitionId] = null;
        continue;
      }
      try {
        normalized[definitionId] = validateAndNormalizeValue(definitionId, definition.field_type, definition.config || {}, raw);
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as { message?: string };
          errors.push({ field: definitionId, message: response?.message || "Invalid value" });
        } else {
          throw err;
        }
      }
    }

    for (const definition of definitions) {
      if (definition.status !== "active") continue;
      if (Object.prototype.hasOwnProperty.call(values || {}, definition.id)) continue;
      if (existing.has(definition.id)) continue;
      const fallback = applyDefaultIfMissing(definition.config || {}, definition.field_type);
      if (fallback !== undefined) normalized[definition.id] = fallback;
    }

    for (const definition of definitions) {
      if (definition.status !== "active" || !definition.required) continue;
      const effective = Object.prototype.hasOwnProperty.call(normalized, definition.id)
        ? normalized[definition.id]
        : existing.get(definition.id);
      if (isEmptyValue(effective)) errors.push({ field: definition.id, message: `${definition.name} is required` });
    }

    return { normalized, errors };
  }

  /**
   * The subset of a brand new test case's normalized values that is actually worth a row.
   *
   * The single-row path reaches the same conclusion by comparing each value against what the test
   * case already has and skipping the ones that did not change; on a row that has just been created
   * everything it holds is null, so that reduces to "drop the empties". Kept here so the bulk import
   * does not have to reimplement isEmptyValue's idea of empty.
   */
  writableValuesForNewTestCase(normalized: Body): { definitionId: string; value: unknown }[] {
    return Object.entries(normalized || {})
      .filter(([, value]) => !isEmptyValue(value))
      .map(([definitionId, value]) => ({ definitionId, value }));
  }

  /**
   * Validates and writes one test case's values against an already-loaded context.
   *
   * `testCaseIsNew` is the bulk import's shortcut: a row inserted moments ago in the same transaction
   * cannot have values yet, so the read of its current ones is skipped rather than issued to come
   * back empty.
   */
  async setValuesWithContext(
    actorId: string | null | undefined,
    projectId: string,
    testcaseId: string,
    values: Body,
    context: CustomFieldWriteContext,
    runner: QueryRunner = this.db,
    options: { testCaseIsNew?: boolean } = {}
  ): Promise<void> {
    const { definitions, definitionsById } = context;
    if (!definitions.length && !Object.keys(values || {}).length) return;

    const existingByDefinition = new Map<string, unknown>();
    if (!options.testCaseIsNew) {
      const existingRes = await runner.query<{ definition_id: string; value: unknown }>(
        "SELECT definition_id, value FROM custom_field_values WHERE testcase_id = $1",
        [testcaseId]
      );
      for (const row of existingRes.rows) existingByDefinition.set(row.definition_id, row.value);
    }

    const { normalized, errors } = this.normalizeValues(values, context, existingByDefinition);

    if (errors.length) throw new BadRequestException({ errors });

    const changedDefinitionIds: string[] = [];
    for (const [definitionId, value] of Object.entries(normalized)) {
      const before = existingByDefinition.has(definitionId) ? existingByDefinition.get(definitionId) : null;
      const beforeStr = JSON.stringify(before ?? null);
      const afterStr = JSON.stringify(isEmptyValue(value) ? null : value);
      if (beforeStr === afterStr) continue;
      changedDefinitionIds.push(definitionId);

      if (isEmptyValue(value)) {
        await runner.query("DELETE FROM custom_field_values WHERE definition_id = $1 AND testcase_id = $2", [definitionId, testcaseId]);
      } else {
        await runner.query(
          `INSERT INTO custom_field_values (definition_id, testcase_id, value, created_by, updated_by)
           VALUES ($1,$2,$3::jsonb,$4,$4)
           ON CONFLICT (definition_id, testcase_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [definitionId, testcaseId, JSON.stringify(value), actorId ?? null]
        );
      }
    }

    if (changedDefinitionIds.length) {
      const tcRes = await runner.query<{ external_id: string; title: string }>("SELECT external_id, title FROM testcases WHERE id = $1", [testcaseId]);
      const tc = tcRes.rows[0];
      const entityName = tc ? `${tc.external_id} - ${tc.title}` : null;
      for (const definitionId of changedDefinitionIds) {
        const definition = definitionsById.get(definitionId)!;
        await runner.query(
          `INSERT INTO audit_logs (project_id, actor_id, action, entity_type, entity_id, entity_name, diff, organization_id)
           VALUES ($1,$2,'testcase_custom_field_updated','testcase',$3,$4,$5::jsonb, (SELECT organization_id FROM projects WHERE id = $1))`,
          [
            projectId,
            actorId ?? null,
            testcaseId,
            entityName,
            JSON.stringify({
              fieldId: definitionId,
              fieldKey: definition.key,
              fieldName: definition.name,
              before: existingByDefinition.get(definitionId) ?? null,
              after: normalized[definitionId]
            })
          ]
        );
      }
    }
  }

  async copyValues(fromTestcaseId: string, toTestcaseId: string, actorId: string | null | undefined, runner: QueryRunner = this.db): Promise<void> {
    await runner.query(
      `INSERT INTO custom_field_values (definition_id, testcase_id, value, created_by, updated_by)
       SELECT definition_id, $2, value, $3, $3 FROM custom_field_values WHERE testcase_id = $1
       ON CONFLICT (definition_id, testcase_id) DO NOTHING`,
      [fromTestcaseId, toTestcaseId, actorId ?? null]
    );
  }

  async listActiveDefinitionsForColumns(userId: string | null | undefined, projectId: string): Promise<CustomFieldDefinitionDto[]> {
    return this.listDefinitions(userId, projectId, ["active"]);
  }

  private parseFilterInput(raw: unknown): CustomFieldFilterInput[] {
    if (!raw) return [];
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new BadRequestException({ error: "Invalid customFieldFilters" });
    }
  }

  /**
   * Builds the LEFT JOIN + WHERE fragment for listTestCases's custom-field filters.
   * Deliberately does not require userId/project access — listTestCases itself has no
   * user context today (no @Req() on that route), so this only reads definitions scoped
   * to the given projectId, matching that route's existing (pre-existing gap) behavior.
   */
  async buildListFilterSql(projectId: string, rawFilters: unknown, paramIndexStart: number) {
    const filters = this.parseFilterInput(rawFilters);
    if (!filters.length) return { joinSql: "", whereSql: "", params: [] as unknown[] };
    const res = await this.db.query<{ id: string; field_type: FieldType }>(
      "SELECT id, field_type FROM custom_field_definitions WHERE project_id = $1 AND deleted_at IS NULL",
      [projectId]
    );
    const definitionsById = new Map(res.rows.map((r) => [r.id, { fieldType: r.field_type }]));
    return buildCustomFieldFiltersSql(filters, definitionsById, paramIndexStart);
  }
}
