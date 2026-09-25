import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { DatabaseService } from "../database/database.service";
import { isUuid, LegacyService } from "../legacy/legacy.service";
import { CustomTagDto } from "./custom-tags.types";

type Body = Record<string, any>;

/** custom_tags.name is VARCHAR(40) — a longer one has to be refused, not attempted. */
const NAME_MAX_LENGTH = 40;

function requireTagId(tagId: string): void {
  if (!isUuid(tagId)) throw new NotFoundException({ error: "Custom tag not found" });
}

function requireTagName(name: string): void {
  if (!name) throw new BadRequestException({ error: "name is required" });
  if (name.length > NAME_MAX_LENGTH) {
    throw new BadRequestException({ error: `name must be ${NAME_MAX_LENGTH} characters or fewer` });
  }
}

function mapTagRow(row: Body): CustomTagDto {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at
  };
}

@Injectable()
export class CustomTagsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(forwardRef(() => LegacyService)) private readonly legacy: LegacyService,
    private readonly testcasesListCache: TestcasesListCacheService
  ) {}

  private async requireManageAccess(userId: string | null | undefined, projectId: string) {
    const project = await this.legacy.requireProjectAccess(userId, projectId);
    const callerRole = this.legacy.normalizeRole(project.caller_role);
    if (callerRole === "qa_engineer") {
      throw new ForbiddenException({ error: "QA Engineers cannot manage custom tags" });
    }
    return project;
  }

  async listTags(userId: string | null | undefined, projectId: string): Promise<CustomTagDto[]> {
    await this.legacy.requireProjectAccess(userId, projectId);
    const res = await this.db.query("SELECT * FROM custom_tags WHERE project_id = $1 ORDER BY lower(name)", [projectId]);
    return res.rows.map(mapTagRow);
  }

  async createTag(userId: string | null | undefined, projectId: string, body: Body): Promise<CustomTagDto> {
    await this.requireManageAccess(userId, projectId);

    const name = String(body.name || "").trim();
    requireTagName(name);

    const clash = await this.db.query("SELECT 1 FROM custom_tags WHERE project_id = $1 AND lower(name) = lower($2)", [projectId, name]);
    if (clash.rows[0]) throw new BadRequestException({ error: "A tag with this name already exists" });

    const res = await this.db.query(
      `INSERT INTO custom_tags (project_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [projectId, name, userId]
    );
    const dto = mapTagRow(res.rows[0]);
    await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_tag_created", "custom_tag", dto.id, dto.name, { after: dto });
    return dto;
  }

  async deleteTag(userId: string | null | undefined, projectId: string, tagId: string): Promise<{ success: true }> {
    await this.requireManageAccess(userId, projectId);
    requireTagId(tagId);

    const res = await this.db.query("DELETE FROM custom_tags WHERE id = $1 AND project_id = $2 RETURNING *", [tagId, projectId]);
    if (!res.rows[0]) throw new NotFoundException({ error: "Custom tag not found" });
    const dto = mapTagRow(res.rows[0]);
    // The repository list rows carry each case's tags (listTestCasesUncached), and the delete
    // cascades off every case — a cached unfiltered page would otherwise keep showing the tag.
    await this.testcasesListCache.invalidate(projectId);
    await this.legacy.logProjectActivity(projectId, userId ?? null, "custom_tag_deleted", "custom_tag", dto.id, dto.name, { before: dto });
    return { success: true };
  }

  async getTagsForTestCase(userId: string | null | undefined, projectId: string, testcaseId: string): Promise<CustomTagDto[]> {
    await this.legacy.requireProjectAccess(userId, projectId);
    const tc = await this.db.query("SELECT 1 FROM testcases WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL", [testcaseId, projectId]);
    if (!tc.rows[0]) throw new NotFoundException({ error: "Test case not found" });
    const res = await this.db.query(
      `SELECT ct.* FROM testcase_custom_tags tct
       JOIN custom_tags ct ON ct.id = tct.tag_id
       WHERE tct.testcase_id = $1
       ORDER BY lower(ct.name)`,
      [testcaseId]
    );
    return res.rows.map(mapTagRow);
  }

  /**
   * Called from LegacyService inside the same transaction as the test case insert/update, so a
   * tag assignment commits or rolls back atomically with the test case row itself — never an HTTP
   * route of its own. Ids that don't belong to this project (foreign, stale, or already deleted)
   * are silently dropped rather than rejected, the same tolerance setValuesForTestCase gives a
   * value referencing an inactive/foreign custom field definition.
   */
  async setTagsForTestCase(projectId: string, testcaseId: string, tagIds: string[], client: PoolClient): Promise<void> {
    const validIds = tagIds.filter(isUuid);
    const owned = validIds.length
      ? (await client.query("SELECT id FROM custom_tags WHERE project_id = $1 AND id = ANY($2::uuid[])", [projectId, validIds])).rows.map(
          (r: { id: string }) => r.id
        )
      : [];

    if (owned.length) {
      await client.query("DELETE FROM testcase_custom_tags WHERE testcase_id = $1 AND tag_id <> ALL($2::uuid[])", [testcaseId, owned]);
      await client.query(
        `INSERT INTO testcase_custom_tags (testcase_id, tag_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT (testcase_id, tag_id) DO NOTHING`,
        [testcaseId, owned]
      );
    } else {
      await client.query("DELETE FROM testcase_custom_tags WHERE testcase_id = $1", [testcaseId]);
    }
  }

  /** Mirrors CustomFieldsService.copyValues — a duplicated test case keeps its source's tags. */
  async copyTags(sourceTestcaseId: string, newTestcaseId: string, client: PoolClient): Promise<void> {
    await client.query(
      `INSERT INTO testcase_custom_tags (testcase_id, tag_id)
       SELECT $2, tag_id FROM testcase_custom_tags WHERE testcase_id = $1`,
      [sourceTestcaseId, newTestcaseId]
    );
  }
}
