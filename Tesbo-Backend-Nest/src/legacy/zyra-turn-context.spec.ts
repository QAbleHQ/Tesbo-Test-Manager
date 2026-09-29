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
import type { CustomTagsService } from "../custom-tags/custom-tags.service";
import { RequestCacheService } from "../request-cache/request-cache.service";
import { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import { SuitesCacheService } from "../cache/suites-cache.service";
import { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";
import type Redis from "ioredis";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * Carrying a chat turn's sources into the next turn (ZyraTurnContextRefs).
 *
 * The defect: every lookup a Zyra chat turn makes is keyed on that turn's own message text. A user
 * asks about the hotel-booking ticket, Zyra identifies it and offers to generate test cases; the user
 * replies "yes". "yes" resolves no ticket, so the ticket is absent from the generation prompt, and
 * sanitizeZyraSourceRefs — correctly — drops every draft's citation of a label this turn was never
 * shown. The drafts render "No specific source cited".
 *
 * The fix merges the previous turn's resolved sources (re-fetched by reference, project-scoped) into
 * the current turn's, so the citation index contains the ticket again. The sanitizer is untouched.
 */
function makeLegacy(query: jest.Mock = jest.fn(() => Promise.resolve({ rows: [] }))): LegacyService {
  const db = { query } as unknown as DatabaseService;
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
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
}

type KnowledgeItem = { title: string; content: string; citation?: { sourceType: "document" | "file"; sourceId: string } };
type Bug = { id: string; title: string; description: string; status: string; priority: string };
type Confidence = "none" | "weak" | "strong";
type Sources = {
  jiraIssueKeys: string[];
  jira: Array<{ key: string; summary: string; description: string }>;
  knowledge: KnowledgeItem[];
  knowledgeConfidence: Confidence;
  bugs: Bug[];
};
type Refs = {
  jiraIssueKeys: string[];
  jiraKeys: string[];
  knowledge: Array<{ sourceType: "document" | "file"; sourceId: string }>;
  knowledgeConfidence: Confidence;
  bugIds: string[];
};
type SourceRef = { type: string; id: string; title: string };

type Statics = {
  mergeZyraTurnSources: (own: Sources, carried: Sources) => Sources;
  normalizeZyraContextRefs: (raw: unknown) => Refs | null;
  zyraContextRefsFor: (sources: Sources) => Refs;
  sanitizeZyraSourceRefs: (rawRefs: unknown, knownRefs: Map<string, SourceRef>) => SourceRef[];
};
type Internals = {
  zyraSourceRefIndex: (input: { knowledge: KnowledgeItem[]; jira: Sources["jira"]; existingTestcases: Array<{ externalId: string; title: string }>; bugs?: Bug[] }) => Map<string, SourceRef>;
  zyraResolveContextRefs: (projectId: string, refs: Refs | null, kbEnabled: boolean) => Promise<Sources>;
  zyraPriorTurnContextRefs: (projectId: string, sessionId: string) => Promise<Refs | null>;
};

const statics = () => LegacyService as unknown as Statics;
const internals = (svc: LegacyService) => svc as unknown as Internals;

const none = (): Sources => ({ jiraIssueKeys: [], jira: [], knowledge: [], knowledgeConfidence: "none", bugs: [] });
const ticket = (key: string, summary = `${key} summary`) => ({ key, summary, description: "" });
const doc = (id: string, title = `Doc ${id}`): KnowledgeItem => ({ title, content: "...", citation: { sourceType: "document", sourceId: id } });
const bug = (id: string): Bug => ({ id, title: `Bug ${id}`, description: "", status: "Open", priority: "" });

describe("Zyra turn context carry-over", () => {
  describe("regression: a follow-up keeps the ticket the previous turn identified", () => {
    const hotelTicket = ticket("HBP-4", "Hotel Details & Room Selection");

    it("without carry-over, a draft citing the ticket loses its citation (the reported defect)", () => {
      // What a "yes" turn resolved on its own before the fix: nothing.
      const own = none();
      const index = internals(makeLegacy()).zyraSourceRefIndex({ knowledge: own.knowledge, jira: own.jira, existingTestcases: [], bugs: own.bugs });
      expect(statics().sanitizeZyraSourceRefs(["HBP-4"], index)).toEqual([]);
    });

    it("with the previous turn's sources merged in, the same citation resolves to the ticket", () => {
      const merged = statics().mergeZyraTurnSources(none(), { ...none(), jira: [hotelTicket] });
      const index = internals(makeLegacy()).zyraSourceRefIndex({ knowledge: merged.knowledge, jira: merged.jira, existingTestcases: [], bugs: merged.bugs });
      expect(statics().sanitizeZyraSourceRefs(["HBP-4"], index)).toEqual([
        { type: "jira_ticket", id: "HBP-4", title: "Hotel Details & Room Selection" }
      ]);
    });

    it("still drops a label neither turn resolved — carry-over never widens citations beyond real sources", () => {
      const merged = statics().mergeZyraTurnSources(none(), { ...none(), jira: [hotelTicket] });
      const index = internals(makeLegacy()).zyraSourceRefIndex({ knowledge: merged.knowledge, jira: merged.jira, existingTestcases: [] });
      expect(statics().sanitizeZyraSourceRefs(["HBP-99"], index)).toEqual([]);
    });
  });

  describe("mergeZyraTurnSources", () => {
    it("returns exactly the turn's own sources when nothing is carried", () => {
      const own: Sources = {
        jiraIssueKeys: ["ABC-1"],
        jira: [ticket("ABC-1")],
        knowledge: [doc("d1"), doc("d1")], // own duplicates are left exactly as gathered
        knowledgeConfidence: "weak",
        bugs: [bug("b1")]
      };
      expect(statics().mergeZyraTurnSources(own, none())).toEqual(own);
    });

    it("keeps the message's own tickets first and never displaces them", () => {
      const own = { ...none(), jira: [ticket("NEW-1"), ticket("NEW-2")] };
      const carried = { ...none(), jira: [ticket("OLD-1"), ticket("NEW-1")] };
      expect(statics().mergeZyraTurnSources(own, carried).jira.map((t) => t.key)).toEqual(["NEW-1", "NEW-2", "OLD-1"]);
    });

    it("fills only the remaining room up to 8, so older subjects age out as new ones arrive", () => {
      const own = { ...none(), jira: Array.from({ length: 6 }, (_, i) => ticket(`NEW-${i}`)) };
      const carried = { ...none(), jira: Array.from({ length: 5 }, (_, i) => ticket(`OLD-${i}`)) };
      const keys = statics().mergeZyraTurnSources(own, carried).jira.map((t) => t.key);
      expect(keys).toHaveLength(8);
      expect(keys.slice(0, 6)).toEqual(own.jira.map((t) => t.key));
      expect(keys.slice(6)).toEqual(["OLD-0", "OLD-1"]);
    });

    it("carries explicitly referenced keys, so a follow-up still links the drafted testcase to the ticket", () => {
      const merged = statics().mergeZyraTurnSources(none(), { ...none(), jiraIssueKeys: ["HBP-4"], jira: [ticket("HBP-4")] });
      expect(merged.jiraIssueKeys).toEqual(["HBP-4"]);
    });

    it("a key typed in THIS message leads the explicit list", () => {
      const merged = statics().mergeZyraTurnSources({ ...none(), jiraIssueKeys: ["NEW-7"] }, { ...none(), jiraIssueKeys: ["HBP-4"] });
      expect(merged.jiraIssueKeys).toEqual(["NEW-7", "HBP-4"]);
    });

    it("ranks carried knowledge ahead of the follow-up's own weaker matches and takes its confidence", () => {
      const own = { ...none(), knowledge: [doc("noise")], knowledgeConfidence: "weak" as const };
      const carried = { ...none(), knowledge: [doc("spec")], knowledgeConfidence: "strong" as const };
      const merged = statics().mergeZyraTurnSources(own, carried);
      expect(merged.knowledge.map((k) => k.citation?.sourceId)).toEqual(["spec", "noise"]);
      expect(merged.knowledgeConfidence).toBe("strong");
    });

    it("keeps its own knowledge first, and its own confidence, when the carried set is not stronger", () => {
      const own = { ...none(), knowledge: [doc("fresh")], knowledgeConfidence: "strong" as const };
      const carried = { ...none(), knowledge: [doc("older")], knowledgeConfidence: "weak" as const };
      const merged = statics().mergeZyraTurnSources(own, carried);
      expect(merged.knowledge.map((k) => k.citation?.sourceId)).toEqual(["fresh", "older"]);
      expect(merged.knowledgeConfidence).toBe("strong");
    });

    it("does not raise confidence when every carried document was already found by this turn", () => {
      const own = { ...none(), knowledge: [doc("d1")], knowledgeConfidence: "weak" as const };
      const carried = { ...none(), knowledge: [doc("d1")], knowledgeConfidence: "strong" as const };
      const merged = statics().mergeZyraTurnSources(own, carried);
      expect(merged.knowledge).toHaveLength(1);
      expect(merged.knowledgeConfidence).toBe("weak");
    });

    it("dedupes carried bugs against the turn's own", () => {
      const merged = statics().mergeZyraTurnSources({ ...none(), bugs: [bug("b1")] }, { ...none(), bugs: [bug("b1"), bug("b2")] });
      expect(merged.bugs.map((b) => b.id)).toEqual(["b1", "b2"]);
    });
  });

  describe("zyraContextRefsFor / normalizeZyraContextRefs", () => {
    it("round-trips a turn's sources by reference only", () => {
      const refs = statics().zyraContextRefsFor({
        jiraIssueKeys: ["HBP-4"],
        jira: [ticket("HBP-4"), ticket("HBP-9")],
        knowledge: [doc("d1"), { title: "Folder marker", content: "" }],
        knowledgeConfidence: "strong",
        bugs: [bug("b1")]
      });
      expect(refs).toEqual({
        jiraIssueKeys: ["HBP-4"],
        jiraKeys: ["HBP-4", "HBP-9"],
        knowledge: [{ sourceType: "document", sourceId: "d1" }],
        knowledgeConfidence: "strong",
        bugIds: ["b1"]
      });
      expect(statics().normalizeZyraContextRefs(JSON.parse(JSON.stringify(refs)))).toEqual(refs);
    });

    it("treats a missing or malformed row as nothing to carry", () => {
      expect(statics().normalizeZyraContextRefs(null)).toBeNull();
      expect(statics().normalizeZyraContextRefs("HBP-4")).toBeNull();
      expect(statics().normalizeZyraContextRefs(["HBP-4"])).toBeNull();
    });

    it("drops invalid entries, unknown confidence values and anything beyond the 8-per-source cap", () => {
      const refs = statics().normalizeZyraContextRefs({
        jiraIssueKeys: "HBP-4",
        jiraKeys: ["A-1", "", null, "A-1", ...Array.from({ length: 10 }, (_, i) => `B-${i}`)],
        knowledge: [{ sourceType: "document", sourceId: "d1" }, { sourceType: "email", sourceId: "x" }, { sourceType: "file" }],
        knowledgeConfidence: "certain",
        bugIds: [42]
      });
      expect(refs).toEqual({
        jiraIssueKeys: [],
        jiraKeys: ["A-1", "B-0", "B-1", "B-2", "B-3", "B-4", "B-5", "B-6"],
        knowledge: [{ sourceType: "document", sourceId: "d1" }],
        knowledgeConfidence: "none",
        bugIds: ["42"]
      });
    });
  });

  describe("zyraResolveContextRefs", () => {
    const refs: Refs = {
      jiraIssueKeys: ["HBP-4"],
      jiraKeys: ["HBP-4"],
      knowledge: [{ sourceType: "document", sourceId: "d1" }],
      knowledgeConfidence: "strong",
      bugIds: ["b1"]
    };

    function fakeDb() {
      return jest.fn((sql: string) => {
        if (sql.includes("FROM jira_tickets")) return Promise.resolve({ rows: [{ jira_issue_key: "HBP-4", summary: "Hotel Details", description: "d", status: "Open" }] });
        if (sql.includes("FROM knowledge_documents")) return Promise.resolve({ rows: [{ id: "d1", title: "Room spec", content_text: "rooms" }] });
        if (sql.includes("FROM bugs")) return Promise.resolve({ rows: [{ id: "b1", title: "Room price wrong", description: "", status: "Open", priority: "P1" }] });
        return Promise.resolve({ rows: [] });
      });
    }

    it("re-fetches every carried source scoped to the current project", async () => {
      const query = fakeDb();
      const sources = await internals(makeLegacy(query)).zyraResolveContextRefs("project-A", refs, true);
      expect(sources.jira.map((t) => t.key)).toEqual(["HBP-4"]);
      expect(sources.knowledge).toEqual([{ title: "Room spec", content: "rooms", citation: { sourceType: "document", sourceId: "d1" } }]);
      expect(sources.bugs.map((b) => b.id)).toEqual(["b1"]);
      expect(sources.knowledgeConfidence).toBe("strong");
      // A stored ref can never pull in another project's row: every lookup is bound to the caller's project.
      for (const [sql, params] of query.mock.calls as unknown as Array<[string, unknown[]]>) {
        expect(sql).toMatch(/project_id = \$1/);
        expect(params[0]).toBe("project-A");
      }
    });

    it("skips knowledge and bugs when knowledge-base access is off, but still carries the ticket", async () => {
      const query = fakeDb();
      const sources = await internals(makeLegacy(query)).zyraResolveContextRefs("project-A", refs, false);
      expect(sources.jira.map((t) => t.key)).toEqual(["HBP-4"]);
      expect(sources.knowledge).toEqual([]);
      expect(sources.bugs).toEqual([]);
      expect(sources.knowledgeConfidence).toBe("none");
      const sqls = (query.mock.calls as unknown as Array<[string]>).map(([sql]) => sql);
      expect(sqls.some((sql) => sql.includes("knowledge_documents") || sql.includes("FROM bugs"))).toBe(false);
    });

    it("drops a ref that no longer resolves and does not claim its confidence", async () => {
      const sources = await internals(makeLegacy()).zyraResolveContextRefs("project-A", { ...refs, jiraKeys: [], bugIds: [] }, true);
      expect(sources.knowledge).toEqual([]);
      expect(sources.knowledgeConfidence).toBe("none");
    });

    it("carries nothing, and queries nothing, when there is no previous turn", async () => {
      const query = fakeDb();
      expect(await internals(makeLegacy(query)).zyraResolveContextRefs("project-A", null, true)).toEqual(none());
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("zyraPriorTurnContextRefs", () => {
    it("reads the latest assistant turn that recorded refs, in this session and project only", async () => {
      const query = jest.fn(() => Promise.resolve({ rows: [{ context_refs: { jiraKeys: ["HBP-4"] } }] }));
      const refs = await internals(makeLegacy(query)).zyraPriorTurnContextRefs("project-A", "session-1");
      expect(refs?.jiraKeys).toEqual(["HBP-4"]);
      const [sql, params] = (query.mock.calls as unknown as Array<[string, unknown[]]>)[0];
      expect(sql).toMatch(/role = 'assistant' AND context_refs IS NOT NULL/);
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(params).toEqual(["session-1", "project-A"]);
    });

    it("fails open — an unreadable row carries nothing instead of failing the turn", async () => {
      const query = jest.fn(() => Promise.reject(new Error("column context_refs does not exist")));
      await expect(internals(makeLegacy(query)).zyraPriorTurnContextRefs("project-A", "session-1")).resolves.toBeNull();
    });
  });
});
