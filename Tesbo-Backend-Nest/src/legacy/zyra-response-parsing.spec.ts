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

// The parsing helpers are private implementation detail — reached here directly because the
// whole point of these tests is the text-in/text-out contract, with no provider round trip.
type Internals = {
  parseModelJson: (raw: string, salvageFields?: string[]) => Record<string, unknown> | null;
  sanitizeZyraReply: (raw: unknown, fallback: string) => string;
  reconcileZyraReply: (
    decision: { reply: string; actionType: string; operations: { type: string }[]; __salvaged?: boolean },
    applied: { testcases: unknown[]; activity: { title?: string; detail?: string }[] }
  ) => string;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("Zyra model-response parsing", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  describe("parseModelJson", () => {
    it("parses a well-formed envelope unchanged", () => {
      const raw = JSON.stringify({ reply: "## Fine\n\nA \"quoted\" phrase.", action: "answer" });
      expect(internals(svc).parseModelJson(raw)).toMatchObject({
        reply: '## Fine\n\nA "quoted" phrase.',
        action: "answer"
      });
    });

    it("recovers an envelope with unescaped quotes inside reply", () => {
      // The exact break seen in production: the model wrote "remember me" without escaping.
      const raw = '{"reply":"## Gaps\\n\\n- Does a session survive a restart if a "remember me" option exists?","reasoningSummary":"Coverage analysis.","action":"answer","actionType":"answer","operations":[],"testcases":[]}';
      expect(() => JSON.parse(raw)).toThrow(); // strict parse cannot handle it
      const parsed = internals(svc).parseModelJson(raw);
      expect(parsed?.reply).toContain('"remember me"');
      expect(parsed?.reasoningSummary).toBe("Coverage analysis.");
    });

    it("recovers an envelope with literal newlines inside reply", () => {
      const raw = '{"reply":"## Coverage\n\nAll 10 cases live in one suite.\n\n### Gaps\n- Password reset","action":"answer"}';
      expect(() => JSON.parse(raw)).toThrow();
      expect(internals(svc).parseModelJson(raw)?.reply).toContain("Password reset");
    });

    it("recovers an envelope broken by newlines and unescaped quotes together", () => {
      const raw = '{"reply":"## Gaps\n\n- A "remember me" flow\n- Reset link expiry","reasoningSummary":"note","operations":[],"testcases":[]}';
      const parsed = internals(svc).parseModelJson(raw);
      expect(parsed?.reply).toContain('"remember me"');
      expect(parsed?.reply).toContain("Reset link expiry");
    });

    it("unwraps a markdown-fenced envelope", () => {
      const raw = '```json\n{"reply":"## Hello\\n\\nWorld","action":"answer"}\n```';
      expect(internals(svc).parseModelJson(raw)?.reply).toBe("## Hello\n\nWorld");
    });

    it("salvages the reply text when the envelope is unrecoverably malformed", () => {
      // Truncated mid-array: neither strict nor repaired parse can succeed.
      const raw = '{"reply":"## Partial answer with a "quote" inside","operations":[{"type":"create",';
      expect(internals(svc).parseModelJson(raw)?.reply).toContain("Partial answer");
    });

    it("returns null for prose so callers can surface it as a plain answer", () => {
      expect(internals(svc).parseModelJson("Here is a plain answer with no JSON.")).toBeNull();
      expect(internals(svc).parseModelJson("")).toBeNull();
    });

    /*
     * Salvage recovers only the string fields it is asked for — "reply" and "reasoningSummary".
     * `action`, `operations` and `testcases` are gone, so the caller's routing defaults to "answer"
     * and generation never runs. Indistinguishable from a model that genuinely chose to answer,
     * which is exactly how a create request became a confident chat reply with an empty table.
     *
     * The router prompt puts `reply` first in the envelope, so a response cut short at the
     * provider's output ceiling loses the decision fields every time.
     */
    it("marks a salvaged envelope so the caller can tell the decision fields were lost", () => {
      const truncated =
        '{"reply":"## Coverage Analysis\\n\\nGenerated 15 test cases covering the full Projects, Test Suites & Test Cases module — happy path, negative';
      const parsed = internals(svc).parseModelJson(truncated);
      expect(parsed?.reply).toContain("Generated 15 test cases");
      // salvage cannot recover the action
      expect(parsed?.action).toBeUndefined();
      // a salvaged fragment must be distinguishable from a clean parse. Double-underscore prefix
      // (matching __zyraUsage) deliberately: a bare "salvaged" key is a name a model could plausibly
      // hallucinate into an otherwise-clean response — see the dedicated test below.
      expect((parsed as Record<string, unknown>)?.__salvaged).toBe(true);
    });

    it("does not mark a cleanly parsed envelope as salvaged", () => {
      const clean = JSON.stringify({ reply: "All good.", action: "create", operations: [] });
      const parsed = internals(svc).parseModelJson(clean);
      expect(parsed?.action).toBe("create");
      expect((parsed as Record<string, unknown>)?.__salvaged).toBeUndefined();
    });

    it("does not mark a repaired-but-complete envelope as salvaged", () => {
      // Unescaped quotes are repairable without losing any field, so routing is intact.
      const repairable = '{"reply":"A "quoted" phrase","action":"create","operations":[]}';
      const parsed = internals(svc).parseModelJson(repairable);
      expect(parsed?.action).toBe("create");
      expect((parsed as Record<string, unknown>)?.__salvaged).toBeUndefined();
    });

    it("does not confuse a model-authored 'salvaged' field with the internal __salvaged marker", () => {
      // buildZyraChatDecision's retry gate checks raw.__salvaged specifically so a model that
      // (implausibly, but not impossibly) emits a bare "salvaged" field in an otherwise clean,
      // fully-parseable response can never trigger a false-positive retry.
      const clean = JSON.stringify({ reply: "All good.", action: "answer", operations: [], salvaged: true });
      const parsed = internals(svc).parseModelJson(clean);
      expect(parsed?.salvaged).toBe(true);
      expect((parsed as Record<string, unknown>)?.__salvaged).toBeUndefined();
    });
  });

  describe("sanitizeZyraReply", () => {
    it("passes markdown prose straight through", () => {
      expect(internals(svc).sanitizeZyraReply("## Coverage\n\n- One", "fb")).toBe("## Coverage\n\n- One");
    });

    it("unwraps a nested well-formed envelope", () => {
      const nested = JSON.stringify({ reply: "## Real answer", action: "answer" });
      expect(internals(svc).sanitizeZyraReply(nested, "fb")).toBe("## Real answer");
    });

    it("unwraps a nested malformed envelope instead of showing raw JSON", () => {
      const nested = '{"reply":"## Real answer with a "quote"","action":"answer","operations":[],"testcases":[]}';
      const out = internals(svc).sanitizeZyraReply(nested, "fb");
      expect(out).toContain("## Real answer");
      expect(out).not.toContain('"action"');
      expect(out).not.toContain('"operations"');
    });

    it("falls back rather than leaking an envelope with no usable reply", () => {
      const nested = '{"action":"answer","actionType":"answer","operations":[],"testcases":[]}';
      const out = internals(svc).sanitizeZyraReply(nested, "Fallback answer.");
      expect(out).toBe("Fallback answer.");
    });

    it("never returns text that still looks like a JSON envelope", () => {
      const blobs = [
        '{"reply":"ok","action":"answer"}',
        '{"reply":"ok with "quotes"","action":"answer"}',
        '{"action":"answer","operations":[]}',
        '{"reply":"trailing truncation","operations":[{"type":'
      ];
      for (const blob of blobs) {
        const out = internals(svc).sanitizeZyraReply(blob, "Fallback answer.");
        expect(out.trim().startsWith("{")).toBe(false);
        expect(out).not.toContain('"actionType"');
      }
    });
  });
  /*
   * Basecamp 10212827246 ("AI Test Case Creation Shows Success but Test Cases Are Not Reflected") and
   * the "Created 20 edge case test scenarios..." / "7 test cases generated" mismatch on 10212918496.
   *
   * decision.reply is model prose describing what the model INTENDED. applyZyraChatOperations is what
   * writes, and it drops operations for the per-message cap, external-id conflicts, missing test cases
   * or suites, and capability gating. reconcileZyraReply used to correct only the all-or-nothing case,
   * so a partial application returned the model's larger number verbatim.
   *
   * Driven directly rather than through the API for the reason the whole file exists: this is a
   * text-in/text-out contract, and the e2e suite deliberately never calls a model.
   */
  describe("reconcileZyraReply", () => {
    const creates = (n: number) => Array.from({ length: n }, () => ({ type: "create" }));
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `tc-${i}` }));
    // Staged (not yet saved) rows carry a "proposed-*" action, per applyZyraChatOperations' create
    // branch — this is what proposedCount/reviewHint and the false-completion-claim guard key off,
    // distinct from `rows()` above which stands in for something genuinely already applied.
    const stagedRows = (n: number) => Array.from({ length: n }, (_, i) => ({ draftIndex: i, action: "proposed-create" }));

    it("passes the reply through when every requested operation was applied", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 3 test cases.", actionType: "create", operations: creates(3) },
        { testcases: rows(3), activity: [] }
      );
      expect(out).toBe("Created 3 test cases.");
    });

    // The gap item 4 closes: a create/update/archive turn's own reply text was never checked for a
    // false past-tense completion claim — only the `answer` branch was. A reply saying "Created" for
    // rows that are still only staged (proposedCount > 0) is exactly as false here as it is on an
    // `answer` turn, and now gets the same correction banner prepended.
    it("corrects a create-turn reply that claims completion while its rows are still staged", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 3 test cases and saved them to the repository.", actionType: "create", operations: creates(3) },
        { testcases: stagedRows(3), activity: [] }
      );
      expect(out).toContain("Sorry! Nothing was saved");
      expect(out).toContain("Created 3 test cases and saved them to the repository.");
      expect(out).toContain("staged for your review");
    });

    // The banner must not fire on rows that really were written immediately (move_to_suite), even
    // though the reply text uses the same "saved"/"moved" language — proposedCount is 0 there because
    // nothing about a move is staged, so the claim is true.
    it("does not correct a reply whose completion claim is actually true", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Moved 3 test cases into the Login suite.", actionType: "suite", operations: [{ type: "move_to_suite" }] },
        { testcases: rows(3), activity: [] }
      );
      expect(out).not.toContain("Nothing was saved");
      expect(out).toBe("Moved 3 test cases into the Login suite.");
    });

    // A reply that already honestly discloses staging (uses "drafted"/"staged" language the system
    // prompt asks for, or explicitly says nothing is saved yet) must not be double-corrected.
    it("does not double-correct a reply that already discloses staging honestly", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Drafted 3 test cases for review; nothing was saved yet.", actionType: "create", operations: creates(3) },
        { testcases: stagedRows(3), activity: [] }
      );
      expect(out).not.toContain("Sorry! Nothing was saved");
    });

    // The near-miss the naive fix for the case above would have caused: generateZyraChatTestcasesWithAi
    // (the real code that authors a create turn's reply) always says "I drafted N test case(s)
    // after reading ..." — exactly the wording the system prompt asks for when something IS staged.
    // A completion-claim check reusing the answer branch's broad ZYRA_COMPLETION_CLAIM (which
    // treats "drafted"/"staged"/"proposed" as false-claim verbs, correctly so when nothing at all
    // was applied) would flag every ordinary successful generation as a false claim. Only a verb
    // implying real persistence (created/saved/archived/updated) is false while staged.
    it("does not flag the real generation reply's own 'I drafted N test case(s)' wording", () => {
      const out = internals(svc).reconcileZyraReply(
        {
          reply: "I drafted 2 test case(s) after reading 3 knowledge-base item(s), 0 Jira ticket(s) read directly, 4 existing test case(s) to avoid duplicating coverage.\n\nThey're staged as drafts in **Zyra generated test cases** — say \"save them to <suite>\" and I'll file them where they belong.",
          actionType: "create",
          operations: creates(2)
        },
        { testcases: stagedRows(2), activity: [] }
      );
      expect(out).not.toContain("Sorry! Nothing was saved");
      expect(out).toContain("staged for your review");
    });

    it("flags a partial application instead of repeating the model's larger number", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 20 edge case test scenarios.", actionType: "create", operations: creates(20) },
        { testcases: rows(7), activity: [] }
      );
      expect(out).toContain("7 of 20");
      // The model's own prose is kept below the correction rather than discarded.
      expect(out).toContain("Created 20 edge case test scenarios.");
    });

    it("names the reason a partial application dropped operations", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 30 test cases.", actionType: "create", operations: creates(30) },
        {
          testcases: rows(25),
          activity: [
            { title: "Skipped some operations", detail: "5 operation(s) beyond the 25-per-message limit were not applied." },
            { title: "Created testcase", detail: "AIP-TC-1 Login" }
          ]
        }
      );
      expect(out).toContain("25 of 30");
      expect(out).toContain("25-per-message limit");
      // An ordinary success entry is not a failure reason and must not be quoted as one.
      expect(out).not.toContain("AIP-TC-1 Login");
    });

    it("still reports the all-or-nothing case as nothing saved", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 5 test cases.", actionType: "create", operations: creates(5) },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Nothing was saved");
    });

    it("treats a suite-only turn as a complete success", () => {
      // create_suite touches no test case, so it must not read as a partial application.
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created the Smoke Tests suite.", actionType: "create_suite", operations: [{ type: "create_suite" }] },
        { testcases: [], activity: [] }
      );
      expect(out).toBe("Created the Smoke Tests suite.");
    });

    it("leaves a plain answer alone", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "There are 12 login test cases.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(out).toBe("There are 12 login test cases.");
    });

    /*
     * The answer path was the one branch this function did not check, and it is where every silent
     * failure lands: a routing loss forces actionType to "answer" with no operations, so the model's
     * prose shipped verbatim. Reported in prod (zyra_chat_messages 2026-07-28 11:45:34): action_type
     * "answer", zero stored rows, reply "Generated 15 test cases covering the full Projects, Test
     * Suites & Test Cases module" — and the suite still holds 0 cases today.
     *
     * A turn that saved nothing may still ANSWER freely; what it may not do is claim it wrote.
     */
    it("corrects an answer turn whose reply claims it generated cases", () => {
      const out = internals(svc).reconcileZyraReply(
        {
          reply: "Generated 15 test cases covering the full Projects, Test Suites & Test Cases module.",
          actionType: "answer",
          operations: []
        },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Nothing was saved");
    });

    it("keeps the model's prose below the correction rather than discarding the turn", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 10 test cases, saved into the matching suite.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Nothing was saved");
      expect(out).toContain("Created 10 test cases, saved into the matching suite.");
    });

    it("catches a claim written without a number", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "I've added the missing test cases to the Login suite.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Nothing was saved");
    });

    it("does not fire on a reply that already says nothing was written", () => {
      // Otherwise the guard stacks a warning on top of its own earlier warning, and on the
      // capability refusals ("testcase storage is disabled") that are already honest.
      for (const reply of [
        "Nothing was saved — test case storage is disabled for Zyra in this project.",
        "I could not create the test cases because generation is turned off.",
        "No test cases were created. Enable generation in Zyra settings first."
      ]) {
        const out = internals(svc).reconcileZyraReply(
          { reply, actionType: "answer", operations: [] },
          { testcases: [], activity: [] }
        );
        // must not double-warn on: ${reply}
        expect(out).toBe(reply);
      }
    });

    it("does not fire on an analysis that merely counts existing coverage", () => {
      for (const reply of [
        "The Login suite has 12 test cases covering the happy path.",
        "## Coverage gaps\n\nThese 10 login scenarios appear uncovered.",
        "Shall I go ahead and create test cases covering these gaps?"
      ]) {
        const out = internals(svc).reconcileZyraReply(
          { reply, actionType: "answer", operations: [] },
          { testcases: [], activity: [] }
        );
        // must not warn on: ${reply}
        expect(out).toBe(reply);
      }
    });

    it("leaves a claim alone when the rows really are behind it", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "Created 3 test cases.", actionType: "answer", operations: [] },
        { testcases: rows(3), activity: [] }
      );
      expect(out).toBe("Created 3 test cases.");
    });

    /*
     * The evasion this closes: a router response that failed to parse and got text-salvaged still
     * carries the model's OWN honest-sounding words, written when it believed it was emitting a real
     * create decision — including the exact "staged for your review" phrasing
     * ZYRA_ALREADY_DISCLOSED exists to trust. Left unguarded, a turn that produced zero real
     * operations reads identically to a genuinely staged batch. __salvaged: true means this reply's
     * text cannot be trusted as a considered answer at all, so the ALREADY_DISCLOSED bypass must not
     * apply to it — this is the mechanism the original bug report ("8 flight booking test cases
     * drafted and staged for your review" with no table, no review panel) traced back to.
     */
    it("corrects a salvaged answer turn even though its own text says 'staged for your review'", () => {
      const out = internals(svc).reconcileZyraReply(
        {
          reply: "Here are 8 flight booking test cases drafted and staged for your review. Once you review and save, they will be filed under 'Zyra generated test cases'.",
          actionType: "answer",
          operations: [],
          __salvaged: true
        },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Sorry! Nothing was saved");
    });

    // Identical reply text to the salvaged case above — the only variable changed is __salvaged
    // itself — must still pass through untouched. Isolates the fix to genuinely salvaged decisions
    // rather than tightening the guard for every answer turn that happens to use staging language.
    it("still trusts genuine (non-salvaged) staging disclosure on an answer turn", () => {
      const out = internals(svc).reconcileZyraReply(
        {
          reply: "Here are 8 flight booking test cases drafted and staged for your review. Once you review and save, they will be filed under 'Zyra generated test cases'.",
          actionType: "answer",
          operations: []
        },
        { testcases: [], activity: [] }
      );
      expect(out).not.toContain("Sorry! Nothing was saved");
    });

    /*
     * Second, independent loophole in the same guard, found while designing the fix above:
     * ZYRA_COMPLETION_CLAIM only matched a mutation verb BEFORE the testcase/suite noun, or the
     * explicit "have/has/were/was been VERB" construction. A reduced relative clause puts the noun
     * first with neither of those — "the test cases created for this flow" — and evaded the guard on
     * a perfectly well-formed, non-salvaged response.
     */
    it("catches a noun-first completion claim the original regex order missed", () => {
      const out = internals(svc).reconcileZyraReply(
        { reply: "The test cases created for this login flow cover the happy path and two edge cases.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(out).toContain("Sorry! Nothing was saved");
    });

    it("does not flag legitimate present-tense staging language in noun-first order", () => {
      // "staged"/"drafted"/"proposed" deliberately stay out of the new noun-first list — this is
      // exactly the honest disclosure wording the model is instructed to use. No other mutation verb
      // appears anywhere in this reply, so neither the new alternation nor the old ones should fire.
      const out = internals(svc).reconcileZyraReply(
        { reply: "The test cases drafted here are staged for your review; nothing has been written to the repository yet.", actionType: "answer", operations: [] },
        { testcases: [], activity: [] }
      );
      expect(out).not.toContain("Sorry! Nothing was saved");
    });

    /*
     * Regression tests for a real false-positive class found by review, before this shipped: the
     * noun-first alternation's original 80-char, any-order window had no requirement that the verb
     * actually describe something done TO the noun — an ordinary answer that merely mentions "test
     * cases" or "suite" and, later in the SAME sentence, an unrelated use of a mutation verb
     * (reporting history, a precondition, a UI change) tripped it exactly like a genuine claim would.
     * Each of these three replies is a real shape a coverage-analysis answer can take, verified to
     * match the pre-fix regex directly (not just plausible) before the window was tightened.
     */
    it("does not flag an ordinary answer where a mutation verb appears in an unrelated clause", () => {
      for (const reply of [
        "These test cases assume the user updated their profile before login.",
        "There are 12 login test cases already covering this flow; one suite was recently removed from the sidebar view due to a UI change.",
        // "drafted" deliberately avoided here — it's already a trigger word in the pre-existing
        // verb-first alternation (staged/drafted/proposed count as false claims on an answer turn,
        // by design — see this file's own doc comment above ZYRA_COMPLETION_CLAIM), so a sentence
        // containing "drafted ... suite" matches independently of the noun-first alternation this
        // test targets. Isolating the noun-first case specifically needs a verb that means nothing
        // to alternation 1 at all.
        "These 3 test cases are documented for the checkout suite based on the ticket that was updated yesterday."
      ]) {
        const out = internals(svc).reconcileZyraReply(
          { reply, actionType: "answer", operations: [] },
          { testcases: [], activity: [] }
        );
        // must not warn on: ${reply}
        expect(out).toBe(reply);
      }
    });

    it("still catches the genuine reduced-relative-clause claim the tightened window is meant to preserve", () => {
      for (const reply of [
        "The test cases created for this login flow cover the happy path and two edge cases.",
        "The suite created for onboarding now has 5 cases.",
        "Test cases already updated to reflect the new flow."
      ]) {
        const out = internals(svc).reconcileZyraReply(
          { reply, actionType: "answer", operations: [] },
          { testcases: [], activity: [] }
        );
        expect(out).toContain("Sorry! Nothing was saved");
      }
    });

    /*
     * Regression for a SECOND review pass catching a regression in the FIRST fix above: excluding a
     * bare "was"/"were" from the noun-first lookbehind (to kill the "suite that was removed last
     * week" false positive) also silenced simple-past-passive claims — "3 test cases were created",
     * "The suite was archived" — the single most idiomatic phrasing an LLM uses for exactly the
     * reported bug. Verified directly (node -e) that these went from a real match to silently missed
     * before this second fix; none of the other two alternations catch this phrasing (alternation 1
     * needs the noun AFTER the verb; alternation 2 requires the literal word "been"). The lookbehind
     * is now narrowed to only the RELATIVE-CLAUSE form ("that/which/who was/were …") instead of a
     * bare "was"/"were" anywhere.
     */
    it("still catches a bare simple-past-passive claim ('X test cases were created') — the exact original bug phrasing", () => {
      for (const reply of [
        "3 test cases were created for the checkout flow.",
        "The test cases were saved.",
        "Your test cases were deleted.",
        "The 4 test cases were updated with the new precondition.",
        "The suite was archived."
      ]) {
        const out = internals(svc).reconcileZyraReply(
          { reply, actionType: "answer", operations: [] },
          { testcases: [], activity: [] }
        );
        // must warn on: ${reply}
        expect(out).toContain("Sorry! Nothing was saved");
      }
    });

    it("still excludes the relative-clause false positive the bare exclusion was originally trying to fix", () => {
      for (const reply of [
        "The suite that was removed last week is no longer visible in the sidebar.",
        "The test cases that were archived earlier are still visible in the history tab."
      ]) {
        const out = internals(svc).reconcileZyraReply(
          { reply, actionType: "answer", operations: [] },
          { testcases: [], activity: [] }
        );
        expect(out).toBe(reply);
      }
    });
  });
});
