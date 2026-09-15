import { NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import type { DatabaseService } from "../database/database.service";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { IntegrationSyncService } from "../integration-sync/integration-sync.service";
import type { ApiTokenService } from "../auth/api-token.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import type { CustomFieldsService } from "../custom-fields/custom-fields.service";
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * notifications (V6) previously had no writer anywhere in this codebase, and GET
 * /api/notifications / POST /api/notifications/:id/read were hardcoded stubs (empty list,
 * always-404) — see ZYRA_IMPLEMENTATION_LOG.md's entry for the full investigation. These three
 * LegacyService methods are the first real read/write path this table has ever had:
 * notifyProjectMembers (the archive sweep's own writer, but generic — nothing about it names
 * "sweep"), notificationsForUser (backs GET), markNotificationRead (backs POST .../read).
 */

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const NOTIFICATION_ID = "00000000-0000-4000-8000-0000000000bb";

function makeLegacy(): { svc: LegacyService; dbQuery: jest.Mock } {
  const dbQuery = jest.fn();
  const db = { query: dbQuery } as unknown as DatabaseService;
  const ragIngestion = { enqueueTestcaseEmbedding: jest.fn().mockResolvedValue(undefined) } as unknown as RagIngestionService;
  const svc = new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    ragIngestion,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    {} as unknown as RequestCacheService,
    {} as unknown as ProjectLookupService,
    {} as unknown as KbExtractionRunnerService,
    {} as unknown as SuitesCacheService,
    {} as unknown as TestcasesListCacheService,
    {} as unknown as ProjectOverviewCacheService,
    {} as unknown as CustomFieldsService
  );
  return { svc, dbQuery };
}

describe("notifyProjectMembers", () => {
  afterEach(() => jest.restoreAllMocks());

  it("INSERTs via one INSERT..SELECT from project_members, scoped to non-archived projects, with the ON CONFLICT dedup clause", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "n1" }, { id: "n2" }] });

    const count = await svc.notifyProjectMembers(PROJECT_ID, {
      type: "zyra_archive_sweep",
      title: "Zyra found 3 archive candidates",
      body: "Review them.",
      linkEntityType: "zyra_task_board",
      linkEntityId: PROJECT_ID,
      dedupeKey: "archive_sweep:proj-a:2026-09-15"
    });

    expect(count).toBe(2);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO notifications");
    expect(String(sql)).toContain("FROM project_members pm");
    expect(String(sql)).toContain("JOIN projects p ON p.id = pm.project_id");
    expect(String(sql)).toContain("p.archived_at IS NULL");
    expect(String(sql)).toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(String(sql)).toContain("DO NOTHING");
    expect(params).toEqual([
      PROJECT_ID,
      "zyra_archive_sweep",
      "Zyra found 3 archive candidates",
      "Review them.",
      "zyra_task_board",
      PROJECT_ID,
      "archive_sweep:proj-a:2026-09-15"
    ]);
  });

  it("a project with no members (or all rejected by dedup) returns 0 — not an error", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const count = await svc.notifyProjectMembers(PROJECT_ID, { type: "zyra_archive_sweep", title: "t" });

    expect(count).toBe(0);
  });

  it("omitted optional fields (body/link/dedupeKey) pass through as NULL, not undefined", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await svc.notifyProjectMembers(PROJECT_ID, { type: "zyra_archive_sweep", title: "t" });

    const params = dbQuery.mock.calls[0][1] as unknown[];
    expect(params).toEqual([PROJECT_ID, "zyra_archive_sweep", "t", null, null, null, null]);
  });

  it("a genuine DB failure propagates (the caller — the sweep — is responsible for deciding it's non-fatal, not this method)", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockRejectedValueOnce(new Error("connection lost"));

    await expect(svc.notifyProjectMembers(PROJECT_ID, { type: "t", title: "t" })).rejects.toThrow("connection lost");
  });
});

describe("notificationsForUser", () => {
  afterEach(() => jest.restoreAllMocks());

  it("requires a session and scopes the query to the caller's own user_id", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({
      rows: [{ id: NOTIFICATION_ID, type: "zyra_archive_sweep", title: "t", body: "b", link_entity_type: "zyra_task_board", link_entity_id: PROJECT_ID, read_at: null, created_at: "2026-09-15T00:00:00.000Z" }]
    });

    const list = await svc.notificationsForUser(USER_ID);

    expect(list).toHaveLength(1);
    // Returned RAW (snake_case), not toCamel'd — matches the frontend's existing AppNotification
    // type, which was already written expecting link_entity_type/link_entity_id.
    expect(list[0]).toMatchObject({ link_entity_type: "zyra_task_board", link_entity_id: PROJECT_ID });
    const params = dbQuery.mock.calls[0][1] as unknown[];
    expect(params).toEqual([USER_ID]);
  });

  it("no userId throws (unauthenticated caller)", async () => {
    const { svc } = makeLegacy();
    await expect(svc.notificationsForUser(null)).rejects.toThrow();
  });

  it("an empty list is a completely normal outcome, not an error", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const list = await svc.notificationsForUser(USER_ID);

    expect(list).toEqual([]);
  });
});

describe("markNotificationRead", () => {
  afterEach(() => jest.restoreAllMocks());

  it("updates read_at scoped to id AND the caller's own user_id", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [{ id: NOTIFICATION_ID }] });

    await svc.markNotificationRead(USER_ID, NOTIFICATION_ID);

    const [sql, params] = dbQuery.mock.calls[0];
    expect(String(sql)).toContain("UPDATE notifications");
    expect(String(sql)).toContain("WHERE id = $1 AND user_id = $2");
    expect(String(sql)).toContain("COALESCE(read_at, now())");
    expect(params).toEqual([NOTIFICATION_ID, USER_ID]);
  });

  it("a notification belonging to a different user (or that doesn't exist) 404s — the exact gap the removed stub's own comment flagged", async () => {
    const { svc, dbQuery } = makeLegacy();
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await expect(svc.markNotificationRead(USER_ID, NOTIFICATION_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a malformed id 404s without ever reaching the database", async () => {
    const { svc, dbQuery } = makeLegacy();

    await expect(svc.markNotificationRead(USER_ID, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundException);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("no userId throws (unauthenticated caller)", async () => {
    const { svc } = makeLegacy();
    await expect(svc.markNotificationRead(null, NOTIFICATION_ID)).rejects.toThrow();
  });
});
