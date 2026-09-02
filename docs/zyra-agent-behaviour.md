# Zyra — agreed agent behaviour

The contract for how the Zyra chat agent behaves. Anything that changes behaviour described here is
a deliberate decision, recorded in the changelog at the bottom — not a silent edit.

Implementation: `Tesbo-Backend-Nest/src/legacy/legacy.service.ts` (`buildZyraChatDecision` and
below). Tests: `Tesbo-Backend-Nest/src/legacy/zyra-chat-intent.spec.ts`.

---

## 1. The pivot: the AI understands the request, the system performs the action

There is **no keyword router in front of the model**. One AI call reads the request in the context of
the conversation and the project and returns a structured decision; the backend validates it,
capability-gates it, executes it, and reconciles the reply against what actually happened.

```
message
  │
  ├─▶ gather context (always, before deciding anything)
  │     • knowledge base — semantic/RAG retrieval + folder-name lookup + recency floor
  │     • existing test cases — what is already covered
  │     • Jira tickets mentioned, project snapshot, suites, last generated batch
  │     • transcript, annotated with what each past turn actually persisted
  │
  ├─▶ AI router (one call) ──▶ { action, operations[], requestedCount, exhaustive, reply }
  │
  ├─▶ dispatch on the router's action
  │     create ─────────▶ generator call (own prompt, range instructions, draft schema)
  │     update/archive ─▶ operations against resolved test cases
  │     suite ──────────▶ create_suite / move_to_suite
  │     jira_pending ───▶ deterministic query, then AI writes the summary
  │     list/answer ────▶ reply only
  │
  ├─▶ applyZyraChatOperations — capability gates, real-entity validation, per-message cap, audit log
  │
  └─▶ finalizeZyraChatReply — table-only enforcement + mutation-claim reconciliation
```

**Why no keyword router:** a regex table cannot tell "start generating" from "generate", and cannot
know that "save it" means *create these* when the cases were never written and *move these* when
they were. It also silently overrode the model: a message classified `answer` had its operations
dropped, so the model's reply ("saved!") was published over zero writes. See the changelog.

The model decides. **The model never writes.**

## 2. Context first — always

Before Zyra proposes or authors anything it grounds itself in, in this order of preference:

1. **Knowledge base**, via `zyraGenerationContext`: folder-name lookup (for "the EAD-11215 folder"),
   semantic/RAG retrieval, and a recency snapshot as the floor. Gated by the `knowledgeBase`
   capability — off means the model is told it has no KB access and must not claim otherwise.
2. **Existing test cases** (`existingTestcaseSnapshot`) — coverage answers must come from these, not
   from guesses, and new cases must fill gaps rather than duplicate them.
3. **Jira tickets** (`relevantJiraSnapshot`): keys named in the message (with a live-API fallback for
   keys not yet synced), **plus the most relevant tickets from the synced cache** — a request that
   never types an issue key still needs the tickets it is about. Relevance is required, never padded:
   an unrelated ticket is worse than no ticket. Terms are stemmed against a stopword stem list, so
   "generate test cases covering the login flow" searches for `login`, not for `test`/`coverage`.
4. The project snapshot and suite list.

Note that the integration sync **also mirrors every Jira ticket into the knowledge base** as a
`KEY: summary` document, so Jira context reaches Zyra through both the KB retrieval and the dedicated
Jira slot. Any "sources read" line must count both (`countZyraJiraSourcedKnowledge`) — reporting
"0 Jira ticket(s)" next to 20 knowledge items reads as "Jira is disconnected", which is wrong.

The same gatherer runs for the interactive turn **and for every background batch**. Batches re-read
context so batch N sees what batches 1..N-1 just wrote and does not duplicate it.

## 3. Configuration drives volume

Test case volume comes from Zyra → Settings → Test case range (`minimum`, `1-10`, `10-30`, `all`).

- The configured range is the default and is stated in the router prompt.
- An explicit user request wins: the router reports `requestedCount` (so "fifteen" works, not just
  "15") or `exhaustive: true` ("all possible cases", "as many as you can").
- A message-level regex remains as fallback only when the router reports neither.
- Hard ceiling of 25 per message (`ZYRA_CHAT_MAX_OPERATIONS`); anything above goes through batching.

## 4. Test cases appear in the table, and nowhere else

Generated and listed test cases go in the structured `testcases` array, which the UI renders as a
table (id, title, priority, status, first step, source). The `reply` gets a one-or-two-line summary.

This is **enforced, not requested**: `stripZyraTestcaseTables` removes markdown tables of test cases
from replies. Tables of other things (coverage per module, Jira comparisons) are legitimate prose and
are left alone. When a stripped table was the only record of cases that were never saved, the reply
says so and tells the user how to actually get them.

**There is no draft buffer.** Choosing `create` writes to the repository immediately. Zyra must never
call test cases "ready to save", never offer to save them later, and never enumerate cases it did not
create.

## 5. Batching for volume

Large asks are planned then executed in batches (`ZYRA_PLAN_BATCH_SIZE = 5`,
`ZYRA_PLAN_MAX_SCENARIOS = 40`) rather than one oversized call that truncates past the provider's
output ceiling and returns invalid JSON.

- Scenarios are planned first, then each batch is generated, saved, and posted as its own message.
- The plan is persisted (`zyra_chat_sessions.active_plan`), so it survives a backend restart and
  resumes on boot.
- A new user message supersedes an in-flight plan; the loop checks the plan id before each batch.
- The user can stop it; the plan **pauses** (keeping progress) and "continue" resumes it.
- The plan carries the routed suite, so every batch files into the suite the user asked for.

## 6. Failure is always graceful, and always honest

| Failure | Behaviour |
|---|---|
| No AI key allocated | Degraded mode: read-only requests answered from the repository (as table rows); mutations refused with the reason and where to fix it. |
| Router call fails | Same degraded mode, reason surfaced, logged as `zyra_chat_ai_failed` (`stage: routing`). |
| Generation fails after routing succeeded | Keep the router's answer, prefix that no cases were produced and nothing was saved. Logged with `stage: generation`. |
| Router response unusable/garbled | Treated as `answer` — never as a guessed mutation. |
| Batch fails mid-plan | Plan pauses with progress intact; "continue" retries. |
| A batch saves nothing | Reported as saving nothing, never as a successful batch. |
| Operations resolve to nothing | Visible activity entry, and the reply is corrected to "⚠️ Nothing was saved". |
| Capability disabled | Declined with the capability name and how to enable it — never silently substituted. |
| Operations exceed the per-message cap | Applied up to the cap, with the overflow reported (never silently truncated). |

**Never** report success for work that did not happen. `reconcileZyraReply` exists because the reply
is written before the operations run, so nothing else compares the claim to the outcome.

## 7. Guards that must not be removed

- Capability gates in `applyZyraChatOperations` — the final word regardless of what the model emitted.
- Operations may only reference test cases that actually resolve (`findProjectTestcase`,
  `resolveZyraMoveTargets`). `resolveZyraMoveTargets` never creates.
- An invented suite id is dropped; an invented suite name is allowed (suites are created by name).
- Archive is a status change, never a delete, and requires explicit confirmation first.
- `reconcileZyraReply` + `stripZyraTestcaseTables` on every outgoing reply.
- Hypothetical/exploratory questions ("what would happen if we deleted…") are `answer`, never action.

## 8. Changelog

| Date | Change | Reason |
|---|---|---|
| 2026-07-31 | Removed the keyword intent router from the live path; the AI router decides, keyword logic retained for degraded mode only (`zyraDegradedDecision`). | A regex classifier read "Yes, Please start generating" as small talk, so generation never ran; its `answer` classification then dropped the model's operations while its reply claimed success. |
| 2026-07-31 | Transcript annotated with what each assistant turn actually persisted. | The model cannot distinguish its own successful save from its own prose; "save it" was unresolvable without this fact. |
| 2026-07-31 | `requestedCount` / `exhaustive` reported by the router; suite resolved from the router's operation. | Digit-scraping regexes missed "fifteen"; substring suite matching missed "put them in Login". |
| 2026-07-31 | Test case markdown tables stripped from replies; rows required in `testcases`. | Cases the user could read but not open, run, or edit — and in one session they did not exist at all. |
| 2026-07-31 | Per-message operation cap raised 10 → 25 and overflow reported. | "Generate 15" saved 10 and reported 15. |
| 2026-07-31 | Zero-target `move_to_suite` records activity instead of returning silently. | A suite was created and left empty with no audit trail while the reply announced a successful save. |
| 2026-07-31 | Batches re-gather RAG/KB context and carry the routed suite. | Batches 2..N used a plain recency snapshot with no RAG and no capability gate, drifting from batch 1's sources. |
| 2026-07-31 | Generation failure after successful routing degrades to the router's answer. | A truncated generation response returned a bare "AI unavailable" and discarded an otherwise good turn. |
| 2026-07-31 | Jira context is relevance-matched from the synced cache, not only from issue keys typed in the message (`relevantJiraSnapshot`). The "sources read" line now counts Jira tickets mirrored into the KB. | `jiraSnapshot` returned `[]` whenever no key was typed, so "generate test cases for the login flow" read 0 tickets with Jira connected and 83 tickets synced — and the reply's bare "0 Jira ticket(s)" read as a broken integration. |
| 2026-07-31 | `processZyraTask`'s failure handler unwraps the thrown `HttpException` payload (`extractAiErrorMessage` + the payload's `detail`) and logs the failure server-side. | The handler read `error.message`, which Nest sets to the generic status text for object-payload exceptions, so every Tasks failure recorded the literal string "Bad Request Exception" — a revoked key, a rate-limited provider, and truncated JSON were indistinguishable, and nothing was logged. The Zyra chat paths already used `extractAiErrorMessage`; only the Tasks path did not. |
| 2026-08-18 | `reconcileZyraReply` reports a PARTIAL application, not only an empty one — "N of M operation(s) were applied" plus the per-operation reason from the turn's activity. | It returned the model's prose verbatim whenever at least one case was written, so a turn that asked for 20 and applied 7 still read "Created 20 edge case test scenarios". The 2026-07-31 operation-cap entry fixed one cause of the mismatch; every other drop path (external-id conflict, missing test case or suite, capability gating) still overstated. Basecamp 10212827246 / 10212918496. |
| 2026-08-18 | Task mode (`zyraSave`) now writes the same `zyra_created` audit action chat mode writes, and the agent payload carries `testcasesCreated` counted from it. | The Agents screen summed `generated_count`, which only the task-board draft flow writes, so 33 cases created by talking to Zyra reported "0 tests generated". Basecamp 10212918496. |
| 2026-08-24 | `reconcileZyraReply` no longer returns an `answer` turn's reply unchecked: when the turn wrote nothing and the reply uses past-tense completion language about the repository ("Created 7 test cases", "Archived PRO-TC-124", "have been saved"), an honest correction is prefixed. Proposals, offers and analytical answers are untouched. | An answer changes nothing, so a reply that *says* it changed something was the one case no guard covered. Basecamp 10231190735 (user confirms an archive, is told it happened, asks "is it created?" and is correctly told it was not), 10231274688 (second creation request in the same session reports success with no ids and no rows), 10231923903. |
| 2026-08-24 | The transcript annotates a turn that was routed `create`/`archive`/`update` but wrote nothing as a PROPOSAL still awaiting the user's go-ahead, alongside the existing "saved nothing" note. | The annotation told the model its own proposal was something not to rely on — and the prompt tells it to trust annotations over its own earlier wording — so a following "yes" had no antecedent to resolve against. Uses `zyra_chat_messages.action_type`, which was already stored; no keyword matching, the model still decides what the confirmation refers to. Basecamp 10231190735 / 10231274688. |
| 2026-08-24 | A generation failure after a successful create routing no longer appends the router's own reply, and states the failure in the user's terms rather than the parser's. The provider detail stays in `reasoningSummary` and the activity log. | The router writes its reply expecting generation to follow, so appending it printed a failure and "Created 7 test cases covering passwordless biometric login…" one after the other about the same request — Basecamp 10231923903. The 2026-07-31 "degrade to the router's answer" entry stays correct for a ROUTING failure, where that answer is all there is. "AI testcase generation returned invalid JSON" in front of a user is Basecamp 10231965612. |
| 2026-08-24 | A create request with **no knowledge-base item and no matching Jira ticket** still generates, but the reply leads with the gap: it says the feature is not in the knowledge base, calls the cases a draft to review rather than coverage, and asks for the requirement/spec/ticket that would let it regenerate them grounded. | The old reply said "after reading 0 knowledge-base item(s)…", which reads as a broken lookup rather than an absent feature, and left the impression the cases came from the team's own requirements. Refusing outright was the alternative and was rejected: generic cases for a well-understood flow are a real starting point. Basecamp 10231923903. |
| 2026-08-24 | A generation failure retries **once with a deliberately different approach** — a 5-case batch instead of the original count — and, when that succeeds, the reply states that the first attempt failed, why, and that this is a narrowed retry. | The dominant failure is a truncated response, which is a function of how much was asked for, so repeating the identical call is the one thing guaranteed not to help. A user who asked for 20 and receives 5 is owed the reason. |
| 2026-08-24 | When both attempts fail, the reply is structured: what I tried (count, suite, sources), what went wrong (cause in the user's terms, mapped from the provider detail), what you can do. Rate limit → wait; rejected key → an admin checks Settings → AI providers; truncated → ask for fewer; timeout → try again. | "AI testcase generation returned invalid JSON" is what a developer needs and what a person asking for test cases cannot act on; it stays in reasoningSummary and the activity log. Basecamp 10231965612, and the graceful-failure behaviour asked for directly on 2026-08-24. |
| 2026-08-25 | Chat creations that name no suite are staged in a default **"Zyra generated test cases"** suite instead of being written with `suite_id NULL`. A named suite still wins. | Unfiled agent drafts were indistinguishable in the "No suite" bucket from a case a person created and forgot to sort. The rows are still written immediately and are still real, openable, runnable rows — the 2026-07-31 "no draft buffer" invariant is unchanged; only their default home is. |
| 2026-08-25 | The reply says **drafted**, names where they are staged, and says how to file them ("save them to <suite>"). The router is told the staging suite's count is how many unfiled cases it has generated, and that "save them" after a generation is a `move_to_suite` with `fromLastPlan`, never a second create. | "Created" was doing two jobs — the row exists, and the work is done — and only the first was true: everything Zyra writes has status Draft and nobody has reviewed it. The prompt previously instructed the opposite ("say they are saved"), which is why the wording had to change in the same edit as the rule. Asked for directly on 2026-08-25. |
| 2026-09-02 | `reconcileZyraReply`'s answer-turn correction now reads "⚠️ **Sorry! Nothing was saved.**" (previously "Nothing was changed in the repository..."). It no longer double-wraps a reply that already discloses failure on its own (e.g. "Nothing was saved — test case storage is disabled..."). `ZYRA_COMPLETION_CLAIM` now also catches a bare "Generated 15 test cases", not only the two-word "generated and saved". `parseModelJson`'s field-salvage path marks its result `salvaged: true` so a truncated envelope is distinguishable from a model that genuinely chose to answer. | Six tests in `zyra-response-parsing.spec.ts` were written 2026-08-24 alongside the product code but never ran — the spec file's own `expect(value, "message")` calls (Playwright/Vitest syntax) failed ts-jest compilation, so the suite silently reported 0 tests (PR #48 fixes the compile break). Once compiling, all six failed against the shipped code: "Generated 15 test cases…" didn't match the claim regex at all, the correction that did fire read "Nothing was changed" instead of "Nothing was saved", and an already-honest refusal got a second warning stacked on top of it. Reported by unit test, no BetterBugs session. |
| 2026-09-02 | `isZyraTestcaseTable`'s anchor list no longer treats a "Test Case(s)" column header as proof a table is authoring new cases. Only a column that *defines* content — title, scenario, steps, expected, precondition(s), postcondition(s) — counts as that signal now; "test case"/"testcase" (plus priority/status/area/module/id) moved to the secondary, count-only list every kind of table can carry. | A coverage answer's natural "which cases cover this" column is headed exactly "Test Cases" and holds ids of *existing* rows, not new content — so it tripped the same anchor an authored table's "Title" column does. `stripZyraTestcaseTables` deleted the table (the whole answer, in the reported session) and, seeing zero rows in `testcases`, appended "were not saved to the repository" — a false claim, since a coverage answer was never asked to save anything. Same misclassification hit a per-module table with a Status column and a Jira-to-testcase comparison table. Five tests in `zyra-chat-intent.spec.ts` (written 2026-08-24, blocked from ever running by the same ts-jest compile break PR #48 fixed) now pass; no other test in the suite relied on "test case" being an anchor. Reported by unit test, no BetterBugs session. |
| 2026-09-02 | `reconcileZyraReply` appends a deterministic per-suite footer ("📦 Moved to suites (actual): …") to every reply whenever a `move_to_suite` operation ran this turn, built by `applyZyraChatOperations` reading the real `suite_id` counts back from the database (`zyraMoveBreakdown`) after every operation in the turn has applied, never by trusting the model's own count. A suite that was targeted but matched nothing shows as `0 (none matched)` instead of being left out. The model's prose is never parsed or rewritten to check it — the footer states the truth underneath it, same as the other reconciliation banners in this function. | Reported: asked to create two suites and move existing cases into them, Zyra's prose said "Email Login suite will receive the 10 email login test cases" and "Mobile Login suite will receive the mobile login test cases" against 11 real cases (8 + 3) — a self-inconsistent 13. `reply` and `operations` are independent outputs of the same completion; the executed `UPDATE testcases SET suite_id = …` was always exact, but nothing ever compared the model's narrated counts to it — `reconcileZyraReply`'s only numeric check was operation-count vs applied-row-count, not a per-suite breakdown. The fix reads ground truth from the database rather than accumulating a count per operation specifically so that a testcase the model puts in two different move operations in one turn — a real classification mistake — is counted once, under whichever suite it actually ends up in, not double-counted across both. Reported directly, no BetterBugs session. |
