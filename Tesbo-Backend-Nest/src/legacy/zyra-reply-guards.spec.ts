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

/*
 * The two guards that stop Zyra reporting work it did not do.
 *
 * Four cards, one shape — Basecamp 10231190735 ("falsely confirms test case creation and archiving
 * when no repository changes were performed"), 10231274688 ("reports test cases as created in the
 * same chat session, but no test cases are actually created"), 10231923903 ("contradictory
 * responses") and 10231842465 ("does not respond after the user confirms"). In every one the turn
 * routed to `answer`, wrote nothing, and said otherwise.
 *
 * A separate file from zyra-response-parsing.spec.ts deliberately: that file owns reconcile's
 * partial-application behaviour, and at the time of writing it does not compile — another session's
 * in-flight edits use a two-argument `expect(value, message)` that this project's Jest typings do
 * not accept, which would have taken these tests down with it.
 */
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

type Statics = {
  zyraFailureReply: (attempt: string, detail: string, retried: boolean) => string;
  zyraAttemptSummary: (input: {
    requestedCount?: number | null;
    knowledgeCount: number;
    jiraCount: number;
    suiteName?: string | null;
  }) => string;
  zyraUngroundedNote: (count: number) => string;
  zyraDraftFilingHint: (suiteName: string | null) => string;
  ZYRA_DRAFT_SUITE_NAME: string;
};

function statics(): Statics {
  return LegacyService as unknown as Statics;
}

type Internals = {
  reconcileZyraReply: (
    decision: { reply: string; actionType: string; operations: { type: string }[] },
    applied: { testcases: unknown[]; activity: { title?: string; detail?: string }[] }
  ) => string;
  zyraTranscript: (history: Record<string, unknown>[]) => string;
};

function internals(svc: LegacyService): Internals {
  return svc as unknown as Internals;
}

describe("Zyra reply guards", () => {
  let svc: LegacyService;

  beforeEach(() => {
    svc = makeLegacy();
  });

  /*
   * An `answer` decision used to return its reply unchecked, on the reasoning that an answer changes
   * nothing so there is nothing to reconcile. That is backwards: an answer changes nothing, so a
   * reply that SAYS it changed something is the one case no other guard can catch. On 10231190735
   * the user confirmed an archive, was told it had happened, asked "is it created?" a minute later,
   * and was correctly told it had not.
   */
  describe("an answer turn that claims work", () => {
    const answer = (reply: string) => ({ reply, actionType: "answer", operations: [] as { type: string }[] });
    const nothingApplied = { testcases: [] as unknown[], activity: [] as { title?: string }[] };

    it("corrects a claim that test cases were created", () => {
      const out = internals(svc).reconcileZyraReply(
        answer("Created test cases covering the key knowledge-base items."),
        nothingApplied
      );
      expect(out).toContain("Nothing was saved");
      // The model's prose is kept below the correction, as it is for a partial application.
      expect(out).toContain("Created test cases covering the key knowledge-base items.");
      expect(out.indexOf("Nothing was saved")).toBeLessThan(out.indexOf("Created test cases"));
    });

    it("corrects a claim that test cases were archived", () => {
      const out = internals(svc).reconcileZyraReply(
        answer("Archived PRO-TC-124 and TES-TC-1 as duplicates."),
        nothingApplied
      );
      expect(out).toContain("Nothing was saved");
    });

    it("corrects the passive form", () => {
      const out = internals(svc).reconcileZyraReply(
        answer("The 4 test cases have been saved to the Login suite."),
        nothingApplied
      );
      expect(out).toContain("Nothing was saved");
    });

    it("leaves a proposal alone — a question is not a claim", () => {
      const proposal = "I found PRO-TC-124 and TES-TC-1. Should I archive them? Reply yes to confirm.";
      expect(internals(svc).reconcileZyraReply(answer(proposal), nothingApplied)).toBe(proposal);
    });

    it("leaves an offer in the future tense alone", () => {
      const offer = "I'll create 8 test cases for the payment flow if you want me to.";
      expect(internals(svc).reconcileZyraReply(answer(offer), nothingApplied)).toBe(offer);
    });

    it("leaves an ordinary analytical answer alone", () => {
      const plain = "This project has 42 test cases, 12 of them P1, and login is the thinnest area.";
      expect(internals(svc).reconcileZyraReply(answer(plain), nothingApplied)).toBe(plain);
    });

    it("does not correct an answer turn that really did write rows", () => {
      // A plan batch posts its own message as an answer with that batch's rows attached; that reply
      // has every right to say what it saved.
      const out = internals(svc).reconcileZyraReply(answer("Created 5 test cases in this batch."), {
        testcases: [{ id: "tc-1" }],
        activity: []
      });
      expect(out).toBe("Created 5 test cases in this batch.");
    });
  });

  /*
   * The transcript is where the model learns what earlier turns actually did. It said what each turn
   * PERSISTED but not whether the turn was still waiting on the user — so a proposal that saved
   * nothing was annotated "saved nothing … do not exist in the repository", and the next instruction
   * tells the model to trust the annotation over its own wording. A "yes" then had no antecedent.
   */
  describe("the transcript's pending-proposal annotation", () => {
    it("marks an archive turn that wrote nothing as awaiting the user's go-ahead", () => {
      const out = internals(svc).zyraTranscript([
        { role: "user", content: "remove the duplicates and improve weak coverage" },
        { role: "assistant", content: "Should I archive PRO-TC-124?", action_type: "archive", testcases: [] },
        { role: "user", content: "yes" }
      ]);
      expect(out).toContain("PROPOSAL still awaiting the user's go-ahead");
      expect(out).toContain("routed as 'archive'");
    });

    it("still reports what a turn saved, and does not call that a proposal", () => {
      const out = internals(svc).zyraTranscript([
        {
          role: "assistant",
          content: "Created 2 test cases.",
          action_type: "create",
          testcases: [
            { id: "a", externalId: "PRO-TC-1" },
            { id: "b", externalId: "PRO-TC-2" }
          ]
        }
      ]);
      expect(out).toContain("saved 2 testcase(s) to the repository: PRO-TC-1, PRO-TC-2");
      expect(out).not.toContain("PROPOSAL");
    });

    it("does not turn a plain answer into a proposal", () => {
      const out = internals(svc).zyraTranscript([
        { role: "assistant", content: "This project has 42 test cases.", action_type: "answer", testcases: [] }
      ]);
      expect(out).toContain("saved nothing");
      expect(out).not.toContain("PROPOSAL");
    });
  });
  /*
   * Failing gracefully — asked for directly: say what I tried, say what went wrong in terms the
   * person can act on, say what they can do next. The provider's own words stay in the activity log.
   */
  describe("the failure reply", () => {
    const attempt = 'generate 20 test case(s) for the "Login" suite from 12 knowledge-base item(s)';

    it("says what was attempted, what went wrong and what to do", () => {
      const out = statics().zyraFailureReply(attempt, "AI testcase generation returned invalid JSON", false);
      expect(out).toContain("nothing was created or saved");
      expect(out).toContain("**What I tried:**");
      expect(out).toContain('generate 20 test case(s) for the "Login" suite');
      expect(out).toContain("**What went wrong:**");
      expect(out).toContain("**What you can do:**");
    });

    it("never puts the parser's own words in front of the user", () => {
      const out = statics().zyraFailureReply(attempt, "AI testcase generation returned invalid JSON", false);
      expect(out.toLowerCase()).not.toContain("json");
      expect(out).toContain("came back incomplete");
      // …and the advice is the actionable one for that cause.
      expect(out).toContain("fewer cases");
    });

    it("maps the current 'no testcase drafts' salvage-exhausted message the same as a JSON failure", () => {
      // normalizeAiDrafts throws this once strict-parse -> repair -> per-object salvage all yield
      // zero drafts (see extractAiDraftCandidates) — it replaced the old blunt "invalid JSON" message,
      // and the classifier regex must recognize it too or this falls through to the generic cause.
      const out = statics().zyraFailureReply(attempt, "AI testcase generation returned no testcase drafts", false);
      expect(out).toContain("came back incomplete");
      expect(out).toContain("fewer cases");
    });

    it("maps a rate limit to waiting, not to changing the request", () => {
      const out = statics().zyraFailureReply(attempt, "429 Too Many Requests", false);
      expect(out).toContain("rate-limiting");
      expect(out).toContain("nothing about your request was wrong");
    });

    it("maps a rejected key to the person who can fix it", () => {
      const out = statics().zyraFailureReply(attempt, "401 invalid api key", false);
      expect(out).toContain("rejected the workspace's key");
      expect(out).toContain("Settings → AI providers");
    });

    it("says so when the narrowed retry also failed", () => {
      const out = statics().zyraFailureReply(attempt, "timeout", true);
      expect(out).toContain("retried with a smaller batch");
    });

    it("does not claim a retry that did not happen", () => {
      const out = statics().zyraFailureReply(attempt, "timeout", false);
      expect(out).not.toContain("retried");
    });
  });

  describe("the attempt summary", () => {
    it("names the count, the suite and the sources it worked from", () => {
      const out = statics().zyraAttemptSummary({
        requestedCount: 20,
        knowledgeCount: 12,
        jiraCount: 3,
        suiteName: "Login"
      });
      expect(out).toBe('generate 20 test case(s) for the "Login" suite from 12 knowledge-base item(s) and 3 Jira ticket(s)');
    });

    it("is explicit when there was nothing to work from", () => {
      const out = statics().zyraAttemptSummary({ requestedCount: null, knowledgeCount: 0, jiraCount: 0 });
      expect(out).toContain("nothing matching in the knowledge base");
      expect(out).toContain("generate test cases");
    });
  });

  /*
   * The knowledge-base gap — Basecamp 10231923903. Say plainly that the feature is not in the
   * knowledge base, hand over generic cases anyway so the user has a starting point, and name the one
   * thing that would make them specific.
   */
  describe("the ungrounded-generation note", () => {
    it("says the knowledge base has nothing, without refusing", () => {
      const out = statics().zyraUngroundedNote(7);
      expect(out).toContain("don't have anything about this in the project's knowledge base");
      expect(out).toContain("no Jira ticket matched");
      expect(out).toContain("I've still written 7 test case(s)");
    });

    it("frames them as a draft to review rather than as real coverage", () => {
      const out = statics().zyraUngroundedNote(7);
      expect(out).toContain("draft to review");
      expect(out).not.toContain("after reading");
    });

    it("invites the detail that would make them specific", () => {
      const out = statics().zyraUngroundedNote(3);
      expect(out).toMatch(/add the requirement, spec or acceptance criteria/i);
      expect(out).toContain("ask me again");
    });
  });
  /*
   * Drafts, and where they are staged.
   *
   * Zyra's generations were already written with status Draft, but the reply called them created and
   * they landed with no suite — so "created" meant both "the row exists" and "the work is done", and
   * only the first was true. Asked for directly: draft language, a default suite of their own, and a
   * save step that files them.
   */
  describe("draft filing", () => {
    it("names the staging suite and how to file them when no suite was asked for", () => {
      const out = statics().zyraDraftFilingHint(statics().ZYRA_DRAFT_SUITE_NAME);
      expect(out).toContain("staged as drafts");
      expect(out).toContain("Zyra generated test cases");
      expect(out).toContain('say "save them to <suite>"');
    });

    it("does not call a named suite a staging area", () => {
      const out = statics().zyraDraftFilingHint("Login");
      expect(out).toContain("drafts in **Login**");
      expect(out).not.toContain("staged as drafts");
    });

    it("never describes a draft as saved or filed", () => {
      for (const suite of [statics().ZYRA_DRAFT_SUITE_NAME, "Login"]) {
        const out = statics().zyraDraftFilingHint(suite).toLowerCase();
        expect(out).not.toContain("saved");
        expect(out).not.toMatch(/\bfiled\b(?! them)/);
      }
    });
  });
});
