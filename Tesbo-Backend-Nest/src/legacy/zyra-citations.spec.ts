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
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * Per-test-case citations: which knowledge-base doc/file, Jira ticket, or existing test case
 * actually informed a Zyra-generated test case (the "citation for the testcases" request).
 *
 * Two pieces, one principle — never trust the model's own claim beyond what it was actually shown,
 * the same rule zyra-reply-guards.spec.ts already covers for completion claims:
 *   - zyraSourceRefIndex builds the exact set of citable labels for one turn, from the same
 *     knowledge/jira/existingTestcases arrays the prompt itself was built from.
 *   - sanitizeZyraSourceRefs filters a draft's model-reported labels down to that set and resolves
 *     the survivors — a label the model invents (or carries over from an unrelated turn) is
 *     dropped silently, never surfaced as a citation.
 */
function makeLegacy(): LegacyService {
  const db = { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService;
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

type SourceRef = { type: string; id: string; title: string };

type Statics = {
  sanitizeZyraSourceRefs: (rawRefs: unknown, knownRefs: Map<string, SourceRef>) => SourceRef[];
};

function statics(): Statics {
  return LegacyService as unknown as Statics;
}

type Internals = {
  zyraSourceRefIndex: (input: {
    knowledge: Array<{ title: string; content: string; citation?: { sourceType: "document" | "file"; sourceId: string } }>;
    jira: Array<{ key: string; summary: string; description: string }>;
    existingTestcases: Array<{ externalId: string; title: string }>;
  }) => Map<string, SourceRef>;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("Zyra citation guards", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  describe("zyraSourceRefIndex", () => {
    it("labels knowledge items 'KB N' in order and resolves type from citation.sourceType", () => {
      const index = internals(svc).zyraSourceRefIndex({
        knowledge: [
          { title: "Refund policy v4", content: "...", citation: { sourceType: "document", sourceId: "doc-1" } },
          { title: "Upload.pdf", content: "...", citation: { sourceType: "file", sourceId: "file-2" } }
        ],
        jira: [],
        existingTestcases: []
      });
      expect(index.get("KB 1")).toEqual({ type: "knowledge_document", id: "doc-1", title: "Refund policy v4" });
      expect(index.get("KB 2")).toEqual({ type: "knowledge_file", id: "file-2", title: "Upload.pdf" });
    });

    it("skips a knowledge item with no citation (e.g. a synthetic empty-folder marker row)", () => {
      const index = internals(svc).zyraSourceRefIndex({
        knowledge: [{ title: "Knowledge base folder: EAD-11215", content: "" }],
        jira: [],
        existingTestcases: []
      });
      expect(index.size).toBe(0);
    });

    it("labels Jira tickets by their own key and existing testcases by their own external id", () => {
      const index = internals(svc).zyraSourceRefIndex({
        knowledge: [],
        jira: [{ key: "HBP-14", summary: "Card-first settlement", description: "" }],
        existingTestcases: [{ externalId: "AIP-TC-73", title: "Successful login" }]
      });
      expect(index.get("HBP-14")).toEqual({ type: "jira_ticket", id: "HBP-14", title: "Card-first settlement" });
      expect(index.get("AIP-TC-73")).toEqual({ type: "testcase", id: "AIP-TC-73", title: "Successful login" });
    });
  });

  describe("sanitizeZyraSourceRefs", () => {
    const knownRefs = new Map<string, SourceRef>([
      ["KB 1", { type: "knowledge_document", id: "doc-1", title: "Refund policy v4" }],
      ["HBP-14", { type: "jira_ticket", id: "HBP-14", title: "Card-first settlement" }]
    ]);

    it("resolves labels that were genuinely offered this turn", () => {
      const out = statics().sanitizeZyraSourceRefs(["KB 1", "HBP-14"], knownRefs);
      expect(out).toEqual([
        { type: "knowledge_document", id: "doc-1", title: "Refund policy v4" },
        { type: "jira_ticket", id: "HBP-14", title: "Card-first settlement" }
      ]);
    });

    it("silently drops a label the model invented or carried over from an unrelated turn", () => {
      const out = statics().sanitizeZyraSourceRefs(["KB 1", "PAY-2291"], knownRefs);
      expect(out).toEqual([{ type: "knowledge_document", id: "doc-1", title: "Refund policy v4" }]);
    });

    it("returns [] for a draft that cites nothing", () => {
      expect(statics().sanitizeZyraSourceRefs([], knownRefs)).toEqual([]);
    });

    it("degrades to [] rather than throwing when sourceRefs is missing or malformed — the field this " +
      "feature adds must never become a new way for the whole generation to fail (the origin bug behind " +
      "this card was literally 'AI testcase generation returned invalid JSON')", () => {
      expect(statics().sanitizeZyraSourceRefs(undefined, knownRefs)).toEqual([]);
      expect(statics().sanitizeZyraSourceRefs(null, knownRefs)).toEqual([]);
      expect(statics().sanitizeZyraSourceRefs("KB 1", knownRefs)).toEqual([]); // a string, not an array
      expect(statics().sanitizeZyraSourceRefs({ label: "KB 1" }, knownRefs)).toEqual([]); // an object, not an array
      expect(statics().sanitizeZyraSourceRefs([{ nested: "junk" }], knownRefs)).toEqual([]); // array of junk
    });

    it("de-duplicates a repeated label instead of citing the same source twice", () => {
      const out = statics().sanitizeZyraSourceRefs(["KB 1", "KB 1"], knownRefs);
      expect(out).toHaveLength(1);
    });

    it("caps an absurdly long list rather than resolving all of it", () => {
      const many = Array.from({ length: 500 }, () => "KB 1");
      const out = statics().sanitizeZyraSourceRefs(many, knownRefs);
      expect(out.length).toBeLessThanOrEqual(20);
    });

    it("ignores non-string entries inside an otherwise-valid array", () => {
      const out = statics().sanitizeZyraSourceRefs([123, null, "KB 1", {}], knownRefs);
      expect(out).toEqual([{ type: "knowledge_document", id: "doc-1", title: "Refund policy v4" }]);
    });
  });
});
