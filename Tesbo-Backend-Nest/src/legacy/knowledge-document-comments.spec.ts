import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
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
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

type Route = { match: string; rows?: Record<string, unknown>[]; handler?: (params: unknown[]) => { rows: Record<string, unknown>[] } };

function makeDb(routes: Route[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (sql.includes(route.match)) return Promise.resolve(route.handler ? route.handler(params) : { rows: route.rows ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
  return { db: { query } as unknown as DatabaseService, query, calls };
}

function makeLegacy(db: DatabaseService): LegacyService {
  const requestCache = new RequestCacheService({} as unknown as AppConfigService);
  const suitesCache = new SuitesCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const testcasesListCache = new TestcasesListCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  const projectOverviewCache = new ProjectOverviewCacheService({} as unknown as Redis, {} as unknown as AppConfigService);
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
    requestCache,
    new ProjectLookupService(db, requestCache),
    {} as unknown as KbExtractionRunnerService,
    suitesCache,
    testcasesListCache,
    projectOverviewCache,
    {} as unknown as CustomFieldsService
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (err) {
    return err;
  }
}

/**
 * requireProjectAccess resolves the caller's active workspace first, then the project membership
 * scoped to it — both need routing before any Knowledge Base query is reached.
 */
function accessRoutes(role = "qa_engineer"): Route[] {
  return [
    { match: "FROM users u", rows: [{ id: "org-1", name: "Acme", slug: "acme", role: "owner", created_at: "2026-01-01T00:00:00.000Z" }] },
    { match: "JOIN project_members pm", rows: [{ id: "proj-1", organization_id: "org-1", caller_role: role }] },
    { match: "SELECT role FROM project_members", rows: [{ role }] }
  ];
}

/** Project-access + document-exists routes every comment call needs to get past. */
function baseRoutes(role = "qa_engineer", docOverrides: Record<string, unknown> = {}): Route[] {
  return [
    ...accessRoutes(role),
    {
      match: "FROM knowledge_documents WHERE id = $1 AND project_id = $2",
      rows: [{ id: "doc-1", organization_id: "org-1", project_id: "proj-1", title: "EAD-1: Checkout", created_by: "user-1", ...docOverrides }]
    }
  ];
}

function commentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c-1",
    document_id: "doc-1",
    parent_comment_id: null,
    author_id: "user-1",
    author_name: "Priya Shah",
    body: "Looks wrong on Safari.",
    anchor_text: null,
    anchor_start: null,
    anchor_end: null,
    is_resolved: false,
    resolved_by: null,
    resolved_by_name: null,
    resolved_at: null,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
    ...over
  };
}

describe("LegacyService#listKnowledgeDocumentComments", () => {
  it("nests replies under their thread root and counts only unresolved threads as open", async () => {
    const { db } = makeDb([
      ...baseRoutes(),
      {
        match: "FROM knowledge_document_comments c",
        rows: [
          commentRow({ id: "t-1", body: "Thread one" }),
          commentRow({ id: "r-1", parent_comment_id: "t-1", body: "Reply to one", author_name: "Sam Ortiz" }),
          commentRow({ id: "t-2", body: "Thread two", is_resolved: true, resolved_by: "user-2", resolved_by_name: "Sam Ortiz" }),
          commentRow({ id: "r-2", parent_comment_id: "t-1", body: "Second reply" })
        ]
      }
    ]);
    const res = await makeLegacy(db).listKnowledgeDocumentComments("proj-1", "user-1", "doc-1");

    expect(res.total).toBe(2);
    // t-2 is resolved, so only t-1 is open.
    expect(res.openCount).toBe(1);
    expect(res.list.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(res.list[0].replies.map((r: Record<string, unknown>) => r.id)).toEqual(["r-1", "r-2"]);
    expect(res.list[1].replies).toEqual([]);
    expect(res.list[1].resolvedByName).toBe("Sam Ortiz");
  });

  it("drops replies whose thread root is gone rather than promoting them to top level", async () => {
    // Promoting an orphan would silently reorder the conversation and make a reply read as a new
    // thread; the row itself is left untouched in the table.
    const { db } = makeDb([
      ...baseRoutes(),
      {
        match: "FROM knowledge_document_comments c",
        rows: [commentRow({ id: "t-1", body: "Thread" }), commentRow({ id: "orphan", parent_comment_id: "deleted-root" })]
      }
    ]);
    const res = await makeLegacy(db).listKnowledgeDocumentComments("proj-1", "user-1", "doc-1");
    expect(res.list.map((t) => t.id)).toEqual(["t-1"]);
    expect(res.list[0].replies).toEqual([]);
  });

  it("404s when the document doesn't exist in this project", async () => {
    const { db } = makeDb([
      ...accessRoutes("owner"),
      { match: "FROM knowledge_documents WHERE id = $1 AND project_id = $2", rows: [] }
    ]);
    const err = await rejection(makeLegacy(db).listKnowledgeDocumentComments("proj-1", "user-1", "missing"));
    expect(err).toBeInstanceOf(NotFoundException);
  });
});

describe("LegacyService#createKnowledgeDocumentComment", () => {
  it("comments on a read-only synced mirror — the body is locked, the thread is not", async () => {
    // This is the whole point of V73: a synced document's body is overwritten every sync, so
    // comments (stored in their own table) are the writable channel on it.
    const { db, calls } = makeDb([
      ...baseRoutes("qa_engineer", { is_read_only: true, source_provider: "jira", source_role: "mirror" }),
      { match: "INSERT INTO knowledge_document_comments", rows: [{ id: "c-9" }] },
      { match: "FROM knowledge_document_comments c", rows: [commentRow({ id: "c-9" })] }
    ]);
    const created = await makeLegacy(db).createKnowledgeDocumentComment("proj-1", "user-1", "doc-1", { body: "Still broken." });
    expect(created.id).toBe("c-9");
    expect(calls.some((c) => c.sql.includes("INSERT INTO knowledge_document_comments"))).toBe(true);
  });

  it("stores an anchor on a thread root", async () => {
    const { db, calls } = makeDb([
      ...baseRoutes(),
      { match: "INSERT INTO knowledge_document_comments", rows: [{ id: "c-9" }] },
      { match: "FROM knowledge_document_comments c", rows: [commentRow({ id: "c-9" })] }
    ]);
    await makeLegacy(db).createKnowledgeDocumentComment("proj-1", "user-1", "doc-1", {
      body: "Which Safari version?",
      anchorText: "blank page after clicking Pay",
      anchorStart: 120,
      anchorEnd: 149
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO knowledge_document_comments"))!;
    expect(insert.params.slice(6)).toEqual(["blank page after clicking Pay", 120, 149]);
  });

  it("ignores an anchor sent on a reply — a reply inherits its thread's anchor", async () => {
    const { db, calls } = makeDb([
      ...baseRoutes(),
      { match: "SELECT id, parent_comment_id FROM knowledge_document_comments", rows: [{ id: "t-1", parent_comment_id: null }] },
      { match: "INSERT INTO knowledge_document_comments", rows: [{ id: "c-9" }] },
      { match: "FROM knowledge_document_comments c", rows: [commentRow({ id: "c-9" })] }
    ]);
    await makeLegacy(db).createKnowledgeDocumentComment("proj-1", "user-1", "doc-1", {
      body: "Agreed",
      parentCommentId: "t-1",
      anchorText: "should be dropped",
      anchorStart: 5,
      anchorEnd: 10
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO knowledge_document_comments"))!;
    expect(insert.params.slice(6)).toEqual([null, null, null]);
  });

  it("rejects a reply to a reply, keeping threads one level deep", async () => {
    const { db } = makeDb([
      ...baseRoutes(),
      { match: "SELECT id, parent_comment_id FROM knowledge_document_comments", rows: [{ id: "r-1", parent_comment_id: "t-1" }] }
    ]);
    const err = await rejection(
      makeLegacy(db).createKnowledgeDocumentComment("proj-1", "user-1", "doc-1", { body: "nested", parentCommentId: "r-1" })
    );
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("rejects an empty or whitespace-only comment", async () => {
    const { db } = makeDb(baseRoutes());
    const err = await rejection(makeLegacy(db).createKnowledgeDocumentComment("proj-1", "user-1", "doc-1", { body: "   \n  " }));
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("404s when replying to a comment that no longer exists", async () => {
    const { db } = makeDb([...baseRoutes(), { match: "SELECT id, parent_comment_id FROM knowledge_document_comments", rows: [] }]);
    const err = await rejection(
      makeLegacy(db).createKnowledgeDocumentComment("proj-1", "user-1", "doc-1", { body: "hi", parentCommentId: "gone" })
    );
    expect(err).toBeInstanceOf(NotFoundException);
  });
});

describe("LegacyService#updateKnowledgeDocumentComment", () => {
  const existing = (over: Record<string, unknown> = {}): Route => ({
    match: "SELECT id, author_id, parent_comment_id, document_id FROM knowledge_document_comments",
    rows: [{ id: "c-1", author_id: "user-1", parent_comment_id: null, document_id: "doc-1", ...over }]
  });

  it("refuses to let anyone but the author reword a comment, even an owner", async () => {
    // A manager rewriting someone else's words would misattribute them, so this is stricter than
    // the usual Knowledge Base mutate rule.
    const { db } = makeDb([
      ...accessRoutes("owner"),
      existing({ author_id: "someone-else" })
    ]);
    const err = await rejection(makeLegacy(db).updateKnowledgeDocumentComment("proj-1", "user-1", "c-1", { body: "edited" }));
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("lets the author reword their own comment", async () => {
    const { db, calls } = makeDb([
      ...accessRoutes("qa_engineer"),
      existing(),
      { match: "FROM knowledge_document_comments c", rows: [commentRow({ body: "edited" })] }
    ]);
    const updated = await makeLegacy(db).updateKnowledgeDocumentComment("proj-1", "user-1", "c-1", { body: "edited" });
    expect(updated.body).toBe("edited");
    expect(calls.find((c) => c.sql.includes("SET body = $2"))!.params).toEqual(["c-1", "edited"]);
  });

  it("lets an owner resolve someone else's thread and records who resolved it", async () => {
    const { db, calls } = makeDb([
      ...accessRoutes("owner"),
      existing({ author_id: "someone-else" }),
      { match: "FROM knowledge_document_comments c", rows: [commentRow({ is_resolved: true, resolved_by: "user-1" })] }
    ]);
    const updated = await makeLegacy(db).updateKnowledgeDocumentComment("proj-1", "user-1", "c-1", { isResolved: true });
    expect(updated.isResolved).toBe(true);
    const resolve = calls.find((c) => c.sql.includes("SET is_resolved = $2"))!;
    expect(resolve.params[1]).toBe(true);
    expect(resolve.params[2]).toBe("user-1");
  });

  it("clears the resolver when a thread is reopened", async () => {
    const { db, calls } = makeDb([
      ...accessRoutes("owner"),
      existing(),
      { match: "FROM knowledge_document_comments c", rows: [commentRow()] }
    ]);
    await makeLegacy(db).updateKnowledgeDocumentComment("proj-1", "user-1", "c-1", { isResolved: false });
    const resolve = calls.find((c) => c.sql.includes("SET is_resolved = $2"))!;
    expect(resolve.params.slice(1)).toEqual([false, null, null]);
  });

  it("refuses to resolve a reply — resolution is a thread-level action", async () => {
    const { db } = makeDb([...accessRoutes("owner"), existing({ parent_comment_id: "t-1" })]);
    const err = await rejection(makeLegacy(db).updateKnowledgeDocumentComment("proj-1", "user-1", "c-1", { isResolved: true }));
    expect(err).toBeInstanceOf(BadRequestException);
  });
});

describe("LegacyService#deleteKnowledgeDocumentComment", () => {
  it("takes the thread's replies with it so no orphans are left", async () => {
    const { db, calls } = makeDb([
      ...accessRoutes("qa_engineer"),
      { match: "SELECT id, author_id FROM knowledge_document_comments", rows: [{ id: "t-1", author_id: "user-1" }] }
    ]);
    await makeLegacy(db).deleteKnowledgeDocumentComment("proj-1", "user-1", "t-1");
    const del = calls.find((c) => c.sql.includes("SET is_deleted = true"))!;
    expect(del.sql).toContain("id = $1 OR parent_comment_id = $1");
    expect(del.params).toEqual(["t-1"]);
  });

  it("stops a non-author engineer from deleting someone else's comment", async () => {
    const { db } = makeDb([
      ...accessRoutes("qa_engineer"),
      { match: "SELECT id, author_id FROM knowledge_document_comments", rows: [{ id: "t-1", author_id: "someone-else" }] }
    ]);
    const err = await rejection(makeLegacy(db).deleteKnowledgeDocumentComment("proj-1", "user-1", "t-1"));
    expect(err).toBeInstanceOf(ForbiddenException);
  });
});
