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

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function makeLegacy(): LegacyService {
  return new LegacyService(
    { query: jest.fn(() => Promise.resolve({ rows: [] })) } as unknown as DatabaseService,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as IntegrationSyncService,
    {} as unknown as ApiTokenService,
    {} as unknown as PlanLimitsService,
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
    decision: { reply: string; actionType: string; operations: Array<{ type: string }> },
    applied: {
      testcases: unknown[];
      activity: unknown[];
      moveBreakdown?: Array<{ suiteId: string; suiteName: string; created: boolean; count: number }>;
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
      expect(internals(svc).chatTestcasePlan("lots", "1-10", { requestedCount: 500 })).toEqual({ requestedCount: 25 });
    });

    it("falls back to the message and project range when the router reported nothing", () => {
      expect(internals(svc).chatTestcasePlan("generate 7 test cases", "1-10")).toEqual({ requestedCount: 7 });
      expect(internals(svc).chatTestcasePlan("generate some cases", "10-30").testcaseRange).toBe("10-30");
    });

    it("ignores a nonsense router count", () => {
      expect(internals(svc).chatTestcasePlan("generate cases", "1-10", { requestedCount: "many" }).testcaseRange).toBe("1-10");
      expect(internals(svc).chatTestcasePlan("generate cases", "1-10", { requestedCount: 0 }).testcaseRange).toBe("1-10");
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
