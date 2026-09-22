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

// Zyra chat routes on the model's decision, not on keywords. These tests cover the pieces around
// that decision: the state the model is given, how its answer is dispatched, and the guards that
// stop a decision from being reported as done when the system did not do it.
type Internals = {
  zyraTranscript: (history: Array<Record<string, unknown>>) => string;
  intentFromZyraModelAction: (action: unknown, actionType?: unknown) => string;
  chatTestcasePlan: (
    message: string,
    projectTestcaseRange: string,
    routed?: { requestedCount?: unknown; exhaustive?: boolean }
  ) => { requestedCount: number; testcaseRange?: string };
  routedZyraSuite: (
    raw: Record<string, unknown>,
    suites: Array<{ id: string; name: string }>
  ) => { id?: string; name?: string } | null;
  resolveRoutedZyraSuite: (
    routed: { id?: string; name?: string } | null | undefined,
    suites: Array<{ id: string; name: string }>
  ) => { id?: string; name: string } | null;
  reconcileZyraReply: (
    decision: { reply: string; actionType: string; operations: Array<{ type: string }>; __salvaged?: boolean },
    applied: {
      testcases: unknown[];
      activity: unknown[];
      moveBreakdown?: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }>;
      unresolvedMoveTargetCount?: number;
    }
  ) => string;
  zyraMoveBreakdownSuffix: (
    moveBreakdown: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }> | undefined
  ) => string;
  zyraMoveBreakdown: (
    projectId: string,
    moveSuites: Map<string, { suiteName: string; created: boolean }>,
    moveTargetIds: Set<string>
  ) => Promise<Array<{ suiteId: string; suiteName: string; created: boolean; count: number }>>;
  stripZyraTestcaseTables: (reply: string, hasRows: boolean) => string;
  detectZyraChatIntent: (message: string) => string;
  zyraPendingConfirmation: (row: Record<string, unknown>) => { kind: "proposal" | "offer"; actionType?: string; content: string } | null;
  zyraIsConfirmation: (message: string) => boolean;
  zyraDegradedDecision: (
    message: string,
    existingTestcases: Array<Record<string, unknown>>,
    reason: string
  ) => { reply: string; actionType: string; operations: unknown[]; testcases: unknown[] };
  zyraSearchTerms: (text: string, limit?: number) => string[];
  countZyraJiraSourcedKnowledge: (knowledge: Array<{ title: string }>) => number;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

const SUITES = [
  { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Login" },
  { id: "aaaaaaaa-0000-0000-0000-000000000002", name: "Checkout" }
];

describe("Zyra chat AI routing", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  describe("zyraTranscript", () => {
    it("marks an assistant turn that saved nothing, however many cases its text lists", () => {
      // The reported session: a reply enumerating 15 test cases that were never written. As prose
      // this is indistinguishable from a successful save, so the outcome is stated explicitly.
      const transcript = internals(svc).zyraTranscript([
        { role: "user", content: "Yes, Please start generating" },
        {
          role: "assistant",
          content: "Here are **15 high-priority test cases**. These are ready to save.",
          testcases: []
        }
      ]);
      expect(transcript).toContain("[saved nothing — any testcases named in this reply do not exist in the repository]");
    });

    it("marks an assistant turn that really saved, with the external ids", () => {
      const transcript = internals(svc).zyraTranscript([
        {
          role: "assistant",
          content: "Created 2 test cases.",
          testcases: [
            { id: "11111111-1111-1111-1111-111111111111", externalId: "TC-1" },
            { id: "22222222-2222-2222-2222-222222222222", externalId: "TC-2" }
          ]
        }
      ]);
      expect(transcript).toContain("[saved 2 testcase(s) to the repository: TC-1, TC-2]");
    });

    it("counts only persisted rows when a turn mixes saved and suggested", () => {
      const transcript = internals(svc).zyraTranscript([
        {
          role: "assistant",
          content: "Mixed turn.",
          testcases: [{ id: "11111111-1111-1111-1111-111111111111", externalId: "TC-1" }, { id: null, externalId: "" }]
        }
      ]);
      expect(transcript).toContain("[saved 1 testcase(s) to the repository: TC-1]");
    });

    it("unwraps a reply that was stored as a JSON envelope", () => {
      const transcript = internals(svc).zyraTranscript([
        { role: "assistant", content: JSON.stringify({ reply: "Plain prose reply." }), testcases: [] }
      ]);
      expect(transcript).toContain("Plain prose reply.");
      expect(transcript).not.toContain("{\"reply\"");
    });

    it("reports an empty session rather than an empty string", () => {
      expect(internals(svc).zyraTranscript([])).toBe("No prior chat.");
    });

    // Basecamp-reported: gap analysis identifies coverage gaps and asks "Would you like me to
    // generate test cases for any of these gaps?"; the user replies "yes"; nothing happens. That turn
    // routes `answer` (correctly — it changed nothing), so it never got the PROPOSAL annotation below,
    // which only ever fires for create/archive/update. This is the same antecedent, for the one action
    // type that didn't have it.
    it("flags an answer turn that ends in an offer to act, so a following 'yes' has an antecedent", () => {
      const transcript = internals(svc).zyraTranscript([
        {
          role: "assistant",
          action_type: "answer",
          content: "I found 3 coverage gaps around password reset. Would you like me to generate test cases for any of these gaps?",
          testcases: []
        }
      ]);
      expect(transcript).toContain("this turn ended with an offer to act");
    });

    it("does not flag an ordinary clarifying question as an offer to act", () => {
      const transcript = internals(svc).zyraTranscript([
        { role: "assistant", action_type: "answer", content: "Which module should this cover — checkout or login?", testcases: [] }
      ]);
      expect(transcript).not.toContain("offer to act");
    });

    it("does not flag an answer turn that already reports what it found, with no offer", () => {
      const transcript = internals(svc).zyraTranscript([
        { role: "assistant", action_type: "answer", content: "This project has 12 existing test cases covering login.", testcases: [] }
      ]);
      expect(transcript).not.toContain("offer to act");
    });

    it("prefers the PROPOSAL annotation over the offer annotation for a routed create/archive/update turn", () => {
      const transcript = internals(svc).zyraTranscript([
        {
          role: "assistant",
          action_type: "archive",
          content: "I found TC-5 Login Test. Should I archive it? Reply yes to confirm.",
          testcases: []
        }
      ]);
      expect(transcript).toContain("PROPOSAL still awaiting the user's go-ahead");
      expect(transcript).not.toContain("offer to act");
    });
  });

  // zyraPendingConfirmation is the exact predicate zyraTranscript uses to decide the PROPOSAL/offer
  // annotation above, reused by sendZyraChatMessage's confirmation retry so the two can never drift
  // apart (see the comment on `pending` in zyraTranscript's implementation). Covered directly here
  // for the same reason the annotation itself is covered above: the shape it returns is what decides
  // whether "yes" gets a retried model call at all.
  describe("zyraPendingConfirmation", () => {
    it("returns a proposal for a create/update/archive turn that wrote nothing", () => {
      const pending = internals(svc).zyraPendingConfirmation({
        role: "assistant",
        action_type: "archive",
        content: "I found TC-5 Login Test. Should I archive it? Reply yes to confirm.",
        testcases: []
      });
      expect(pending).toEqual({ kind: "proposal", actionType: "archive", content: expect.stringContaining("TC-5") });
    });

    it("returns an offer for an answer turn that ends with an offer to act", () => {
      const pending = internals(svc).zyraPendingConfirmation({
        role: "assistant",
        action_type: "answer",
        content: "I found 3 coverage gaps around password reset. Would you like me to generate test cases for any of these gaps?",
        testcases: []
      });
      expect(pending).toEqual({ kind: "offer", content: expect.stringContaining("coverage gaps") });
    });

    it("returns null once the turn actually saved something — nothing left to confirm", () => {
      const pending = internals(svc).zyraPendingConfirmation({
        role: "assistant",
        action_type: "create",
        content: "Created 2 test cases.",
        testcases: [{ id: "11111111-1111-1111-1111-111111111111", externalId: "TC-1" }]
      });
      expect(pending).toBeNull();
    });

    it("returns null for a plain answer with no offer and for a user row", () => {
      expect(internals(svc).zyraPendingConfirmation({
        role: "assistant",
        action_type: "answer",
        content: "This project has 12 existing test cases covering login.",
        testcases: []
      })).toBeNull();
      expect(internals(svc).zyraPendingConfirmation({ role: "user", content: "yes" })).toBeNull();
    });
  });

  // The gate for sendZyraChatMessage's confirmation retry — deliberately anchored to the whole
  // (trimmed) message, not a substring match, so a qualified "yes" doesn't auto-confirm something
  // the user didn't fully agree to.
  describe("zyraIsConfirmation", () => {
    it.each(["yes", "Yes.", "yes please", "go ahead", "do it", " OK ", "sounds good", "please proceed"])(
      "treats %j as a confirmation",
      (message) => {
        expect(internals(svc).zyraIsConfirmation(message)).toBe(true);
      }
    );

    it.each([
      "yes but not the archive one",
      "no",
      "yes, delete the login suite instead",
      "generate test cases for the gaps",
      ""
    ])("does not treat %j as a confirmation", (message) => {
      expect(internals(svc).zyraIsConfirmation(message)).toBe(false);
    });
  });

  describe("intentFromZyraModelAction", () => {
    it("dispatches on the router's action", () => {
      expect(internals(svc).intentFromZyraModelAction("create")).toBe("create");
      expect(internals(svc).intentFromZyraModelAction("move_to_suite")).toBe("suite");
      expect(internals(svc).intentFromZyraModelAction("jira_pending_testcases")).toBe("jira_pending_testcases");
      expect(internals(svc).intentFromZyraModelAction("list")).toBe("list");
    });

    it("falls back to actionType when action is missing", () => {
      expect(internals(svc).intentFromZyraModelAction(undefined, "create")).toBe("create");
      expect(internals(svc).intentFromZyraModelAction("", "suite")).toBe("suite");
    });

    it("treats an unusable response as answer, never as a mutation", () => {
      // A garbled router response must not be turned into a guess that writes to the repository.
      expect(internals(svc).intentFromZyraModelAction("do_the_thing")).toBe("answer");
      expect(internals(svc).intentFromZyraModelAction(null, null)).toBe("answer");
      expect(internals(svc).intentFromZyraModelAction("delete_everything", "wat")).toBe("answer");
    });
  });

  describe("chatTestcasePlan", () => {
    it("takes the count from the router when it read one", () => {
      // "fifteen" spelled out — no regex over the message finds this.
      expect(internals(svc).chatTestcasePlan("generate fifteen cases", "1-10", { requestedCount: 15 }))
        .toEqual({ requestedCount: 15 });
    });

    it("takes exhaustive from the router", () => {
      expect(internals(svc).chatTestcasePlan("cover everything you can", "1-10", { exhaustive: true }).testcaseRange).toBe("all");
    });

    it("clamps a router count to the per-message ceiling", () => {
      // Ceiling is 50, not 25: the "all" tier's own configured requestedCount is 50, and the
      // 30-50 tier's upper bound is also 50 — a lower clamp here would silently truncate both.
      expect(internals(svc).chatTestcasePlan("lots", "1-10", { requestedCount: 500 })).toEqual({ requestedCount: 50 });
    });

    it("falls back to the message and project range when the router reported nothing", () => {
      expect(internals(svc).chatTestcasePlan("generate 7 test cases", "1-10")).toEqual({ requestedCount: 7 });
      expect(internals(svc).chatTestcasePlan("generate some cases", "10-30").testcaseRange).toBe("10-30");
      expect(internals(svc).chatTestcasePlan("generate some cases", "30-50").testcaseRange).toBe("30-50");
    });

    it("ignores a nonsense router count", () => {
      expect(internals(svc).chatTestcasePlan("generate cases", "1-10", { requestedCount: "many" }).testcaseRange).toBe("1-10");
      expect(internals(svc).chatTestcasePlan("generate cases", "1-10", { requestedCount: 0 }).testcaseRange).toBe("1-10");
    });

    it("resolves the project's 30-50 range to a requestedCount of 40 when nothing else is specified", () => {
      expect(internals(svc).chatTestcasePlan("generate cases", "30-50")).toEqual({ testcaseRange: "30-50", requestedCount: 40 });
    });

    it("no longer truncates an explicit 30-50 chat request down to the old 25 ceiling", () => {
      // Regression test: this used to clamp to 25 regardless of what the user or the project's
      // configured range asked for, making the "up to 50" promise of both "all" and "30-50" false
      // for anything requested via chat instead of the settings page.
      expect(internals(svc).chatTestcasePlan("generate 45 test cases", "1-10")).toEqual({ requestedCount: 45 });
      expect(internals(svc).chatTestcasePlan("generate cases", "1-10", { requestedCount: 45 })).toEqual({ requestedCount: 45 });
    });
  });

  describe("suite resolution from the router", () => {
    it("reads the suite off whichever operation carries one", () => {
      const routed = internals(svc).routedZyraSuite(
        { operations: [{ type: "create", draft: {}, suiteName: "Login" }] },
        SUITES
      );
      expect(routed).toEqual({ name: "Login" });
    });

    it("keeps a real suite id", () => {
      const routed = internals(svc).routedZyraSuite({ operations: [{ type: "create", suiteId: SUITES[0].id }] }, SUITES);
      expect(routed).toEqual({ id: SUITES[0].id, name: "Login" });
    });

    it("drops an invented suite id instead of trusting it", () => {
      const resolved = internals(svc).resolveRoutedZyraSuite({ id: "99999999-9999-9999-9999-999999999999" }, SUITES);
      expect(resolved).toBeNull();
    });

    it("matches an existing suite by name case-insensitively", () => {
      expect(internals(svc).resolveRoutedZyraSuite({ name: "login" }, SUITES)).toEqual({ id: SUITES[0].id, name: "Login" });
    });

    it("passes a genuinely new suite name through to be created on demand", () => {
      expect(internals(svc).resolveRoutedZyraSuite({ name: "Regression" }, SUITES)).toEqual({ name: "Regression" });
    });

    it("returns null when the router named no suite", () => {
      expect(internals(svc).routedZyraSuite({ operations: [{ type: "create", draft: {} }] }, SUITES)).toBeNull();
      expect(internals(svc).resolveRoutedZyraSuite(null, SUITES)).toBeNull();
    });
  });

  describe("stripZyraTestcaseTables", () => {
    // The exact shape Zyra wrote in the reported session, where this table was the whole deliverable.
    const testcaseTable = [
      "Here are the 15 test cases:",
      "",
      "| # | Title | Priority | Area |",
      "|---|---|---|---|",
      "| 1 | Login with valid email and password | P1 | Authentication |",
      "| 2 | Login with invalid password | P1 | Authentication |",
      "",
      "Let me know if you want changes."
    ].join("\n");

    it("removes a testcase table when the rows are rendered by the UI", () => {
      const out = internals(svc).stripZyraTestcaseTables(testcaseTable, true);
      expect(out).not.toContain("| 1 | Login with valid email");
      expect(out).toContain("Here are the 15 test cases:");
      expect(out).toContain("Let me know if you want changes.");
      expect(out).not.toContain("were not saved");
    });

    it("removes it and says so when nothing was saved", () => {
      const out = internals(svc).stripZyraTestcaseTables(testcaseTable, false);
      expect(out).not.toContain("| 1 | Login with valid email");
      expect(out).toContain("were not saved to the repository");
    });

    it("leaves a coverage summary table alone", () => {
      const coverage = [
        "## Coverage by module",
        "",
        "| Module | Existing | Missing |",
        "|---|---|---|",
        "| Auth | 3 | 8 |"
      ].join("\n");
      expect(internals(svc).stripZyraTestcaseTables(coverage, false)).toBe(coverage);
    });

    it("leaves a Jira comparison table alone", () => {
      const jira = ["| Ticket | Summary | Linked |", "|---|---|---|", "| TTM-94 | Login | 0 |"].join("\n");
      expect(internals(svc).stripZyraTestcaseTables(jira, false)).toBe(jira);
    });

    it("passes prose through untouched", () => {
      const prose = "## Gap analysis\n\nAuthentication has the weakest coverage.";
      expect(internals(svc).stripZyraTestcaseTables(prose, false)).toBe(prose);
    });

    it("does not treat pipe-prefixed prose without a separator row as a table", () => {
      const notATable = "| this is not really a table\n| just some piped lines";
      expect(internals(svc).stripZyraTestcaseTables(notATable, false)).toBe(notATable);
    });

    /*
     * The fixtures above ("| Module | Existing | Missing |", "| Ticket | Summary | Linked |") both
     * dodge the failure: neither header contains the phrase "test case", so neither reaches the
     * anchor test. The tables Zyra really writes for a coverage answer DO — a coverage table's
     * natural column for "which cases cover this" is literally headed "Test Cases".
     *
     * Verbatim from a reported prod session (zyra_chat_messages, project TTM Testing - Web): the
     * reply's whole "What's Covered" section was this table, and the user saw the heading with
     * nothing under it, plus a footer implying their cases had gone missing.
     */
    const coveredAreasTable = [
      "### ✅ What's Covered",
      "",
      "| Area | Test Cases |",
      "|---|---|",
      "| Happy-path login (email + OTP) | TTM-TC-1 |",
      "| Invalid password on login | TTM-TC-2 |",
      "",
      "### 🔴 Critical Missing Coverage"
    ].join("\n");

    it("leaves the covered-areas table alone — a 'Test Cases' column of ids is not a testcase table", () => {
      expect(internals(svc).stripZyraTestcaseTables(coveredAreasTable, false)).toBe(coveredAreasTable);
    });

    it("does not append the 'never saved' footer to a coverage answer that created nothing", () => {
      // hasRows=false is correct for a coverage answer — it saved nothing because it was never
      // asked to. That must not be dressed up as cases that went missing.
      expect(internals(svc).stripZyraTestcaseTables(coveredAreasTable, false)).not.toContain("were not saved");
    });

    it("leaves a per-module coverage table alone even with a Status column", () => {
      const perModule = ["| Module | Test Cases | Status |", "|---|---|---|", "| Billing | 12 | Good |"].join("\n");
      expect(internals(svc).stripZyraTestcaseTables(perModule, false)).toBe(perModule);
    });

    it("leaves a Jira comparison table alone when it references linked cases by id", () => {
      const jira = ["| Ticket | Linked Test Case | Priority |", "|---|---|---|", "| TTM-95 | TTM-TC-4 | P1 |"].join("\n");
      expect(internals(svc).stripZyraTestcaseTables(jira, false)).toBe(jira);
    });

    it("leaves a suite summary table alone", () => {
      const suites = ["| Suite | Test Case Count |", "|---|---|", "| Login | 10 |"].join("\n");
      expect(internals(svc).stripZyraTestcaseTables(suites, false)).toBe(suites);
    });

    it("still strips a table that carries authored testcase content", () => {
      const authored = [
        "| ID | Title | Steps | Expected |",
        "|---|---|---|---|",
        "| 1 | Login with valid credentials | Open /login | Dashboard loads |"
      ].join("\n");
      const out = internals(svc).stripZyraTestcaseTables(authored, false);
      expect(out).not.toContain("Login with valid credentials");
      expect(out).toContain("were not saved to the repository");
    });

    it("strips only the authored table when a reply carries both kinds", () => {
      const both = [coveredAreasTable, "", "| Title | Priority | Status |", "|---|---|---|", "| New login case | P1 | Draft |"].join("\n");
      const out = internals(svc).stripZyraTestcaseTables(both, true);
      // The coverage table is the answer and must survive; the authored rows belong in the
      // structured array, not the prose reply.
      expect(out).toContain("| Area | Test Cases |");
      expect(out).not.toContain("New login case");
    });
  });

  describe("Jira context selection", () => {
    it("keeps only the selective words from a QA request", () => {
      // Without stopwords every ticket matches on "test"/"cases"/"coverage" and relevance is noise.
      expect(internals(svc).zyraSearchTerms("generate test cases covering the login flow"))
        .toEqual(["login"]);
      expect(internals(svc).zyraSearchTerms("please create test case coverage for checkout and refunds"))
        .toEqual(["checkout", "refunds"]);
    });

    it("returns no terms when the request is all filler, so nothing irrelevant is matched", () => {
      expect(internals(svc).zyraSearchTerms("please generate some test cases")).toEqual([]);
    });

    it("collapses inflections through the stem list, not a hand-written form list", () => {
      for (const filler of ["cover", "covers", "covering", "coverage", "generate", "generating", "generated", "cases", "testcases", "scenarios", "validate", "verify"]) {
        expect(internals(svc).zyraSearchTerms(`${filler} login`)).toEqual(["login"]);
      }
    });

    it("does not over-stem a real domain word into a stopword", () => {
      // "checkout" must survive even though "check" is filler.
      expect(internals(svc).zyraSearchTerms("test the checkout")).toEqual(["checkout"]);
      expect(internals(svc).zyraSearchTerms("cases for password reset")).toEqual(["password", "reset"]);
    });

    it("caps the term list", () => {
      const terms = internals(svc).zyraSearchTerms("alpha bravo charlie delta echo foxtrot golf hotel india juliet", 4);
      expect(terms).toHaveLength(4);
    });

    it("counts Jira tickets mirrored into the knowledge base", () => {
      // The sync writes them as "KEY: summary" documents, so a reply can report them honestly
      // instead of saying "0 Jira ticket(s)" while most retrieved items were Jira tickets.
      const count = internals(svc).countZyraJiraSourcedKnowledge([
        { title: "TTM-164: Authentication & Login" },
        { title: "TTM-89: Section F — AI-Powered Test Generation" },
        { title: "Release checklist" },
        { title: "Zyra AI Memory" }
      ]);
      expect(count).toBe(2);
    });

    it("does not count an ordinary note that merely mentions a key", () => {
      expect(internals(svc).countZyraJiraSourcedKnowledge([{ title: "Notes about TTM-164 login" }])).toBe(0);
    });
  });

  describe("degraded mode (AI unreachable)", () => {
    const existing = [
      { externalId: "TC-1", title: "Login works", description: "", priority: "P2", status: "Draft", stepsSummary: "[]" }
    ];

    it("refuses to mutate without the provider, and says why", () => {
      const decision = internals(svc).zyraDegradedDecision("generate 5 test cases for login", existing, "no key allocated");
      expect(decision.actionType).toBe("answer");
      expect(decision.operations).toEqual([]);
      expect(decision.testcases).toEqual([]);
      expect(decision.reply).toContain("AI provider is unavailable");
      expect(decision.reply).toContain("no key allocated");
    });

    it("still answers a read-only coverage request from the repository, as table rows", () => {
      const decision = internals(svc).zyraDegradedDecision("show me the existing test cases", existing, "provider timeout");
      expect(decision.testcases).toHaveLength(1);
      expect(decision.operations).toEqual([]);
      expect(decision.reply).toContain("AI provider is unavailable");
    });

    it("is only a fallback shape, never the live router", () => {
      // detectZyraChatIntent survives for this path alone — it must not be reachable when the AI is
      // up, which buildZyraChatDecision guarantees by never calling it there.
      expect(typeof internals(svc).detectZyraChatIntent).toBe("function");
      expect(internals(svc).detectZyraChatIntent("generate test cases")).toBe("create");
    });

    // Reported bug: every degraded-mode reply already says "no test cases were generated or
    // changed" — an honest disclosure — but reconcileZyraReply's own false-completion guard
    // (ZYRA_ALREADY_DISCLOSED) only recognized "no test cases were created/saved/added", not
    // "generated" or "changed". So its "Sorry! Nothing was saved... Ask me to go ahead..." banner
    // got stacked on top of a reply that had already said exactly that, on every degraded turn —
    // a refused create request and a served read-only listing alike.
    it("reconcileZyraReply does not double-warn a degraded create-refusal that already discloses nothing happened", () => {
      const decision = internals(svc).zyraDegradedDecision("generate 5 test cases for login", existing, "credit balance too low");
      const reply = internals(svc).reconcileZyraReply(decision as any, { testcases: [], activity: [] });
      expect(reply).not.toContain("Sorry! Nothing was saved");
      expect(reply).toContain("AI provider is unavailable");
    });

    it("reconcileZyraReply does not double-warn the plain degraded fallback (no create/list intent matched) either", () => {
      // detectZyraChatIntent("hello") falls through every word group to "answer" — the same
      // `note` prefix, same testcases: [], same gap.
      const decision = internals(svc).zyraDegradedDecision("hello", existing, "provider timeout");
      expect(decision.testcases).toEqual([]);
      const reply = internals(svc).reconcileZyraReply(decision as any, { testcases: [], activity: [] });
      expect(reply).not.toContain("Sorry! Nothing was saved");
    });
  });

  describe("reconcileZyraReply", () => {
    const suiteClaim = "All 15 test cases have been saved into the **Login** suite. You're all set! 🎉";

    it("corrects a mutation reply that persisted nothing", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: suiteClaim, actionType: "suite", operations: [{ type: "move_to_suite" }] },
        { testcases: [], activity: [] }
      );
      expect(reply).toContain("Nothing was saved");
      expect(reply).toContain("do not exist in this project");
      expect(reply).toContain(suiteClaim);
    });

    it("corrects a mutation reply that produced no operations at all", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: suiteClaim, actionType: "create", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(reply).toContain("did not produce any test case operations");
    });

    it("leaves a reply alone when testcases really were written", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: suiteClaim, actionType: "suite", operations: [{ type: "move_to_suite" }] },
        { testcases: [{ id: "11111111-1111-1111-1111-111111111111" }], activity: [] }
      );
      expect(reply).toBe(suiteClaim);
    });

    it("treats creating an empty suite as a success", () => {
      const claim = "Created the **Regression** suite.";
      const reply = internals(svc).reconcileZyraReply(
        { reply: claim, actionType: "suite", operations: [{ type: "create_suite" }] },
        { testcases: [], activity: [] }
      );
      expect(reply).toBe(claim);
    });

    it("leaves conversational answers alone", () => {
      const claim = "Playwright drives the end-to-end suite.";
      const reply = internals(svc).reconcileZyraReply(
        { reply: claim, actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(reply).toBe(claim);
    });

    // The reported bug: Zyra's prose claimed "10 Email Login" + "3 Mobile Login" (13) against 11
    // real testcases. The model's own count is never trusted for this — a ground-truth footer is
    // appended below whatever the prose says, built from applied.moveBreakdown (see zyraMoveBreakdown).
    it("appends the real per-suite breakdown below a reply that miscounted", () => {
      const wrongClaim = "Email Login suite will receive the 10 email login test cases, and Mobile Login suite will receive the mobile login test cases.";
      const reply = internals(svc).reconcileZyraReply(
        { reply: wrongClaim, actionType: "mixed", operations: [{ type: "move_to_suite" }, { type: "move_to_suite" }] },
        {
          testcases: Array.from({ length: 11 }, (_, i) => ({ id: `id-${i}` })),
          activity: [],
          moveBreakdown: [
            { suiteId: "s-email", suiteName: "Email Login", created: true, count: 8 },
            { suiteId: "s-mobile", suiteName: "Mobile Login", created: true, count: 3 }
          ]
        }
      );
      // The (wrong) model prose is preserved verbatim above the correction, same as every other
      // reconciliation banner in this function — never silently rewritten.
      expect(reply).toContain(wrongClaim);
      expect(reply).toContain("📦 **Moved to suites (actual):** Email Login (created): 8 · Mobile Login (created): 3 — 11 test case(s) total.");
    });

    it("marks a targeted suite that matched nothing instead of omitting it", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: "Moved everything into QA Regression.", actionType: "suite", operations: [{ type: "move_to_suite" }] },
        {
          testcases: [],
          activity: [],
          moveBreakdown: [{ suiteId: "s-1", suiteName: "QA Regression", created: false, count: 0 }]
        }
      );
      // testcases is empty, so the "nothing was saved" banner fires too — the breakdown must still
      // show underneath it rather than being dropped because the happy path never ran.
      expect(reply).toContain("Nothing was saved");
      expect(reply).toContain("QA Regression: 0 (none matched)");
    });

    it("does not append a breakdown when no move_to_suite operation ran", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: suiteClaim, actionType: "suite", operations: [{ type: "move_to_suite" }] },
        { testcases: [{ id: "11111111-1111-1111-1111-111111111111" }], activity: [] }
      );
      expect(reply).toBe(suiteClaim);
      expect(reply).not.toContain("📦");
    });

    // Same bug shape as the degraded-mode fix above, different trigger: applyStorageGateToGenerated
    // forces actionType to "answer" (so a generation reply never routes through the save-branch's
    // narrower zyraPersistedClaimBanner, which legitimately allows "drafted"/"staged" wording). That
    // reroutes it through zyraFalseCompletionBanner instead — the WIDER check meant for genuine
    // answer turns, where ZYRA_COMPLETION_CLAIM's own verb list includes "drafted". The gate's own
    // prefix ("I did not save them...") wasn't recognized by ZYRA_ALREADY_DISCLOSED, so every
    // generation reply shown while test case storage is disabled got the false-completion banner
    // stacked on top — with a call-to-action ("ask me to go ahead") that is actively wrong here: no
    // amount of asking Zyra to proceed saves anything while the capability itself is off.
    it("does not double-warn the storage-capability gate's reply, which already says it didn't save anything", () => {
      const storageGateReply =
        'Test case storage is disabled for Zyra in this project, so these are suggestions only — I did not save them. Enable "Test case storage operations" under Zyra → Settings → Capabilities to let me save generated testcases.\n\n' +
        'I drafted 3 test case(s) after reading 2 knowledge-base item(s). They\'re staged as drafts in **Zyra Drafts** — say "save them to <suite>" and I\'ll file them where they belong.';
      const reply = internals(svc).reconcileZyraReply(
        { reply: storageGateReply, actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(reply).not.toContain("Sorry! Nothing was saved");
      expect(reply).toContain("I did not save them");
    });

    // F3: the all-create_suite branch used to return decision.reply unchecked (necessary — a
    // genuine "Created the Regression suite" would otherwise trip ZYRA_COMPLETION_CLAIM itself,
    // since "suite" is one of its own nouns), but that meant a reply could ALSO hallucinate an
    // unrelated, unrequested testcase claim in the same message and nothing would ever catch it.
    it("flags a create_suite-only turn whose reply also hallucinates an unrelated testcase claim", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: "Created the Regression suite and added 5 test cases to it.", actionType: "suite", operations: [{ type: "create_suite" }] },
        { testcases: [], activity: [] }
      );
      expect(reply).toContain("Sorry! Nothing was saved");
      expect(reply).toContain("Created the Regression suite and added 5 test cases to it.");
    });

    it("still treats a genuine, unembellished create_suite success as success (no false positive from stripping 'suite' out of the narrower check)", () => {
      const claim = "Created the **Regression** suite.";
      const reply = internals(svc).reconcileZyraReply(
        { reply: claim, actionType: "suite", operations: [{ type: "create_suite" }] },
        { testcases: [], activity: [] }
      );
      expect(reply).toBe(claim);
    });

    // F4: appliedCount (rows) vs. requested (operations) can never fall short for a move_to_suite
    // whose targets only partially resolved — one operation can produce 0..N rows, so "1 operation,
    // 2 of 5 named ids resolved" always read as full success by the old comparison alone. Wired
    // through unresolvedMoveTargetCount instead of appliedCount/requested (which structurally can't
    // see it) — see resolveZyraMoveTargets/applyZyraChatOperations' own comments.
    it("warns when a move_to_suite operation only partially resolved its named targets, even though the operation itself 'succeeded'", () => {
      const reply = internals(svc).reconcileZyraReply(
        { reply: "Moved TC-1, TC-2, TC-3, TC-4, and TC-5 into QA Regression.", actionType: "suite", operations: [{ type: "move_to_suite" }] },
        {
          testcases: [{ id: "id-1" }, { id: "id-2" }],
          activity: [{ title: "Some testcases could not be moved", detail: "3 of 5 requested testcase(s) could not be found in this project and were skipped when moving into \"QA Regression\"." }],
          unresolvedMoveTargetCount: 3
        }
      );
      expect(reply).toContain("could not be moved");
      expect(reply).toContain("3 of 5 requested testcase(s) could not be found");
      expect(reply).toContain("Moved TC-1, TC-2, TC-3, TC-4, and TC-5 into QA Regression.");
    });

    it("does not warn when every named move target resolved", () => {
      const claim = "Moved TC-1 and TC-2 into QA Regression.";
      const reply = internals(svc).reconcileZyraReply(
        { reply: claim, actionType: "suite", operations: [{ type: "move_to_suite" }] },
        { testcases: [{ id: "id-1" }, { id: "id-2" }], activity: [], unresolvedMoveTargetCount: 0 }
      );
      expect(reply).toBe(claim);
    });
  });

  describe("zyraMoveBreakdownSuffix", () => {
    it("returns nothing for an empty or missing breakdown", () => {
      expect(internals(svc).zyraMoveBreakdownSuffix(undefined)).toBe("");
      expect(internals(svc).zyraMoveBreakdownSuffix([])).toBe("");
    });

    it("sums counts across suites into the trailing total, not the operation count", () => {
      const suffix = internals(svc).zyraMoveBreakdownSuffix([
        { suiteId: "a", suiteName: "Email Login", created: false, count: 8 },
        { suiteId: "b", suiteName: "Mobile Login", created: false, count: 3 }
      ]);
      expect(suffix).toContain("Email Login: 8");
      expect(suffix).toContain("Mobile Login: 3");
      expect(suffix).toContain("11 test case(s) total");
    });

    it("labels a suite created this turn", () => {
      const suffix = internals(svc).zyraMoveBreakdownSuffix([
        { suiteId: "a", suiteName: "Regression", created: true, count: 5 }
      ]);
      expect(suffix).toContain("Regression (created): 5");
    });
  });

  describe("zyraMoveBreakdown (ground truth read-back)", () => {
    function withDbQuery(impl: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>): LegacyService {
      const instance = makeLegacy();
      (instance as unknown as { db: { query: jest.Mock } }).db.query = jest.fn(impl);
      return instance;
    }

    it("returns [] and never queries when no move_to_suite operation targeted a suite", async () => {
      const query = jest.fn();
      const instance = withDbQuery(query);
      const result = await internals(instance).zyraMoveBreakdown("project-1", new Map(), new Set());
      expect(result).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it("reports 0 for a targeted suite that matched no testcases, without querying", async () => {
      const query = jest.fn();
      const instance = withDbQuery(query);
      const moveSuites = new Map([["s-1", { suiteName: "QA Regression", created: false }]]);
      const result = await internals(instance).zyraMoveBreakdown("project-1", moveSuites, new Set());
      expect(result).toEqual([{ suiteId: "s-1", suiteName: "QA Regression", created: false, count: 0 }]);
      expect(query).not.toHaveBeenCalled();
    });

    it("splits the real per-suite counts from the grouped read-back query", async () => {
      const query = jest.fn((_sql: string, _values: unknown[]) =>
        Promise.resolve({
          rows: [
            { suite_id: "s-email", count: 8 },
            { suite_id: "s-mobile", count: 3 }
          ]
        })
      );
      const instance = withDbQuery(query);
      const moveSuites = new Map([
        ["s-email", { suiteName: "Email Login", created: true }],
        ["s-mobile", { suiteName: "Mobile Login", created: true }]
      ]);
      const targetIds = new Set(["tc-1", "tc-2", "tc-3", "tc-4", "tc-5", "tc-6", "tc-7", "tc-8", "tc-9", "tc-10", "tc-11"]);
      const result = await internals(instance).zyraMoveBreakdown("project-1", moveSuites, targetIds);
      expect(result).toEqual([
        { suiteId: "s-email", suiteName: "Email Login", created: true, count: 8 },
        { suiteId: "s-mobile", suiteName: "Mobile Login", created: true, count: 3 }
      ]);
      // Exactly one read-back query for the whole turn, scoped to the project and the union of ids.
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, values] = query.mock.calls[0];
      expect(sql).toContain("GROUP BY suite_id");
      expect(values[0]).toBe("project-1");
      expect(values[1]).toHaveLength(11);
    });

    it("counts a testcase only once, under its final suite, when two ops in the same turn target it", async () => {
      // Simulates the model putting the same id in two move operations: whichever UPDATE ran last
      // wins in the database, so the grouped read-back — the only source this function trusts —
      // returns it under exactly one suite_id. A naive per-operation counter would have double-counted it.
      const query = jest.fn(() => Promise.resolve({ rows: [{ suite_id: "s-mobile", count: 1 }] }));
      const instance = withDbQuery(query);
      const moveSuites = new Map([
        ["s-email", { suiteName: "Email Login", created: false }],
        ["s-mobile", { suiteName: "Mobile Login", created: false }]
      ]);
      const result = await internals(instance).zyraMoveBreakdown("project-1", moveSuites, new Set(["tc-overlap"]));
      expect(result).toEqual([
        { suiteId: "s-email", suiteName: "Email Login", created: false, count: 0 },
        { suiteId: "s-mobile", suiteName: "Mobile Login", created: false, count: 1 }
      ]);
    });

    it("falls back to zero counts instead of throwing when the read-back query fails", async () => {
      const instance = withDbQuery(() => Promise.reject(new Error("connection reset")));
      const moveSuites = new Map([["s-1", { suiteName: "Email Login", created: false }]]);
      const result = await internals(instance).zyraMoveBreakdown("project-1", moveSuites, new Set(["tc-1"]));
      expect(result).toEqual([{ suiteId: "s-1", suiteName: "Email Login", created: false, count: 0 }]);
    });
  });
});
