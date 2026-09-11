import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { RequestCacheService } from "./request-cache.service";

// Same structural shape as custom-fields.types.ts's QueryRunner (DatabaseService or a pg PoolClient
// handed out by DatabaseService.transaction()) — duplicated here rather than imported to keep this
// module independent of custom-fields; both interfaces are satisfied by the same two runtime types.
export interface QueryRunner {
  query<T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ProjectBasics {
  organizationId: string;
  archivedAt: string | null;
  key: string;
  settings: unknown;
}

/**
 * The handful of `projects` columns read independently — and often redundantly — by
 * ProjectWriteLockGuard, CustomFieldsService.loadWriteContext, and LegacyService.externalIdPrefix
 * (organization_id, archived_at, key, settings). See B1 of the platform performance remediation plan.
 *
 * Memoized for the request ONLY when reading through the plain pool (no `runner` passed, or the
 * same DatabaseService instance this service already holds) — never when a caller passes an
 * explicit transaction's PoolClient. Those calls read intentionally through an in-progress
 * transaction (e.g. inside the testcase-external-id advisory lock — see externalIdPrefix's own
 * comment) specifically to avoid racing that lock; serving a memoized value in place of a live read
 * through that transaction would reintroduce exactly the race the lock exists to close.
 */
@Injectable()
export class ProjectLookupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly requestCache: RequestCacheService
  ) {}

  async getProjectBasics(projectId: string, runner?: QueryRunner): Promise<ProjectBasics | null> {
    const useCache = !runner || runner === this.db;
    const load = () => this.fetch(projectId, runner ?? this.db);
    return useCache ? this.requestCache.remember(`projectBasics:${projectId}`, load) : load();
  }

  private async fetch(projectId: string, runner: QueryRunner): Promise<ProjectBasics | null> {
    const res = await runner.query<{ organization_id: string; archived_at: string | null; key: string; settings: unknown }>(
      "SELECT organization_id, archived_at, key, settings FROM projects WHERE id = $1",
      [projectId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { organizationId: row.organization_id, archivedAt: row.archived_at, key: row.key, settings: row.settings };
  }
}
