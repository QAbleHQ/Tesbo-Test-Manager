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
import type { RequestCacheService } from "../request-cache/request-cache.service";
import type { ProjectLookupService } from "../request-cache/project-lookup.service";
import type { KbExtractionRunnerService } from "./kb-extraction-runner.service";
import type { SuitesCacheService } from "../cache/suites-cache.service";
import type { TestcasesListCacheService } from "../cache/testcases-list-cache.service";
import type { ProjectOverviewCacheService } from "../cache/project-overview-cache.service";

process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/*
 * Fix for the render/enrichment gap ZYRA_IMPLEMENTATION_LOG.md's investigation entry found: the
 * task-board surfaces (list, TaskQuickViewPanel, the [taskId] detail page) render task.drafts
 * assuming every entry is the flat AiGeneratedDraft shape task-board generation has always produced
 * — but a sweep-staged (or, in principle, chat-staged) row's generated_payload entries are WRAPPED
 * (`{opType, testcaseId, externalId, fields, reason}` for update/archive; `{opType: "create",
 * draft}` for create), carrying none of `title`/`priority`/`stepsJson`/etc directly.
 *
 * formatAiTask now normalizes each generated_payload entry per-item before returning `drafts`:
 * a FLAT entry (no `opType` key — task-board's own shape) passes through completely untouched; a
 * WRAPPED entry is normalized via chatDraftRow/chatTestcaseRow — the exact same normalization
 * applyZyraChatOperations already uses for the chat surface — not a second copy of that logic.
 *
 * Exercised here via zyraTask() (the one GET that all three frontend surfaces' underlying data
 * ultimately flows through — see the investigation entry for the full trace), the same boundary
 * zyra-system-actor.spec.ts already uses for this exact method.
 */

type Body = Record<string, any>;

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000003";
const TESTCASE_ID = "00000000-0000-4000-8000-000000000010";

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
    {} as unknown as CustomFieldsService,
    {} as unknown as CustomTagsService
  );
  return { svc, dbQuery };
}

function mockAuth(svc: LegacyService): void {
  jest.spyOn(svc as unknown as { requireProjectAccess: (...a: unknown[]) => Promise<unknown> }, "requireProjectAccess").mockResolvedValue({});
}

function baseRow(generatedPayload: Body[]): Body {
  return {
    id: TASK_ID,
    provider: "zyra_archive_sweep",
    model: null,
    user_story: "Zyra archive sweep: EAD-TC-1 — Login test",
    acceptance_criteria: null,
    custom_prompt: null,
    style: "strict",
    requested_count: 1,
    generated_count: 1,
    // pg's jsonb type parser already returns a jsonb column as a parsed JS value, not a string —
    // normalizeJsonArray (legacy.service.ts:628) only ever checks Array.isArray, it never JSON.parses
    // — so the mock must match that shape, not stringify it.
    generated_payload: generatedPayload,
    saved_count: 0,
    save_events: "[]",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    agent_name: "Zyra the Test Generator",
    task_status: "in_review",
    feedback: null,
    context: null,
    jira_issue_keys: [],
    linear_issue_keys: [],
    token_input: 0,
    token_output: 0,
    token_total: 0,
    source_summary: "[]",
    activity_log: "[]"
  };
}

const ACTIVE_TESTCASE = {
  id: TESTCASE_ID,
  project_id: PROJECT_ID,
  external_id: "EAD-TC-1",
  title: "Login with valid credentials",
  priority: "P1",
  status: "Active",
  type: "Functional",
  preconditions: "User has an account",
  steps_json: '[{"stepNumber":1,"action":"Enter credentials","expectedResult":"Logs in"}]',
  description: "Verify login works"
};

describe("formatAiTask — normalizing non-create generated_payload entries (via zyraTask)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a flat task-board create draft (no opType key) passes through completely untouched — tags included", async () => {
    const { svc, dbQuery } = makeLegacy();
    const flatDraft = { title: "Checkout flow", priority: "P1", stepsJson: "[]", expectedSummary: "Order completes", preconditions: "", tags: ["regression", "checkout"] };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([flatDraft])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts).toEqual([flatDraft]);
    expect(dbQuery).toHaveBeenCalledTimes(1); // no extra lookup for a flat entry
  });

  it("a wrapped create entry (opType: 'create') is unwrapped via chatDraftRow, action = proposed-create", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = { opType: "create", draft: { title: "New test", priority: "P2", stepsJson: "[]", preconditions: "" }, reason: "Suggested from chat" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts).toHaveLength(1);
    expect(task.drafts[0]).toMatchObject({ title: "New test", priority: "P2", action: "proposed-create", reason: "Suggested from chat" });
    expect(dbQuery).toHaveBeenCalledTimes(1); // wrapped create never needs getTestCase
  });

  it("a wrapped archive entry resolves the CURRENT test case and shows its real title/priority — not a blank card", async () => {
    const { svc, dbQuery } = makeLegacy();
    const archiveEntry = { opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "Linked Jira ticket EAD-11215 is Done." };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([archiveEntry])] }); // zyraTask's own SELECT
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_TESTCASE] }); // getTestCase
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts).toHaveLength(1);
    expect(task.drafts[0]).toMatchObject({
      title: "Login with valid credentials",
      priority: "P1",
      externalId: "EAD-TC-1",
      action: "proposed-archive",
      reason: "Linked Jira ticket EAD-11215 is Done."
    });
  });

  it("a wrapped update entry merges `fields` on top of the current row — action = proposed-update", async () => {
    const { svc, dbQuery } = makeLegacy();
    const updateEntry = { opType: "update", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { priority: "P0" }, reason: "Bumped priority per feedback" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([updateEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_TESTCASE] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0]).toMatchObject({ title: "Login with valid credentials", priority: "P0", action: "proposed-update" });
  });

  it("a wrapped entry whose test case has been deleted since staging shows an identifiable fallback row, never a crash or a blank one", async () => {
    const { svc, dbQuery } = makeLegacy();
    const archiveEntry = { opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "Ticket is done." };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([archiveEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [] }); // getTestCase finds nothing -> throws NotFoundException internally
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts).toHaveLength(1);
    expect(task.drafts[0].title).toBe("EAD-TC-1 (no longer exists)");
    expect(task.drafts[0].action).toBe("proposed-archive");
    expect(task.drafts[0].reason).toBe("Ticket is done.");
  });

  it("a test case already archived by someone else still resolves normally (status shows the merged/post-save state)", async () => {
    const { svc, dbQuery } = makeLegacy();
    const archiveEntry = { opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "Ticket is done." };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([archiveEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_TESTCASE, status: "Archived" }] }); // already archived by someone else
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].title).toBe("Login with valid credentials");
    expect(task.drafts[0].action).toBe("proposed-archive");
  });

  it("a wrapped entry with no reason text (empty string) doesn't crash — reason comes back empty, not undefined", async () => {
    const { svc, dbQuery } = makeLegacy();
    const archiveEntry = { opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([archiveEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_TESTCASE] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].reason).toBe("");
  });

  it("an unrecognized opType is passed through as-is rather than guessed at", async () => {
    const { svc, dbQuery } = makeLegacy();
    const weird = { opType: "move_to_suite", suiteId: "s1", reason: "" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([weird])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0]).toEqual(weird);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("a mixed batch (flat create + wrapped archive) normalizes each entry independently, preserving array order", async () => {
    const { svc, dbQuery } = makeLegacy();
    const flatDraft = { title: "Checkout flow", priority: "P1", stepsJson: "[]", expectedSummary: "", preconditions: "", tags: [] };
    const archiveEntry = { opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "Ticket is done." };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([flatDraft, archiveEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_TESTCASE] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts).toHaveLength(2);
    expect(task.drafts[0]).toEqual(flatDraft);
    expect(task.drafts[1]).toMatchObject({ title: "Login with valid credentials", action: "proposed-archive" });
  });
});

/*
 * "Surface techniques to human reviewers" work: chatDraftRow's allowlist gained a `techniques`
 * field alongside the existing sourceRefs one, using the identical default-to-[] convention (see
 * chatDraftRow's own comment) rather than ["general"] — a row that never had a generation-time
 * technique (an update/archive preview, a "no longer exists" stub) should say "no data", not
 * imply one was assigned and happened to be the fallback.
 */
describe("chatDraftRow techniques allowlist — via zyraTask's wrapped-create normalization", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a single real technique survives unwrapping", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = { opType: "create", draft: { title: "New test", priority: "P2", stepsJson: "[]", preconditions: "", techniques: ["boundary_value_analysis"] }, reason: "Suggested from chat" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].techniques).toEqual(["boundary_value_analysis"]);
  });

  it("multiple techniques on one case all survive, in order", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = {
      opType: "create",
      draft: { title: "New test", priority: "P2", stepsJson: "[]", preconditions: "", techniques: ["boundary_value_analysis", "state_testing", "error_guessing"] },
      reason: ""
    };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].techniques).toEqual(["boundary_value_analysis", "state_testing", "error_guessing"]);
  });

  it("the general fallback is preserved as data (rendering decides whether to hide it, not this layer)", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = { opType: "create", draft: { title: "New test", priority: "P2", stepsJson: "[]", preconditions: "", techniques: ["general"] }, reason: "" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].techniques).toEqual(["general"]);
  });

  it("an older draft from before this field existed (no techniques key at all) comes back as [], not undefined or a crash", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = { opType: "create", draft: { title: "Old-shaped draft", priority: "P2", stepsJson: "[]", preconditions: "" }, reason: "" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].techniques).toEqual([]);
  });

  it("a wrapped archive/update preview never carries techniques — [] every time, since these aren't generation-time drafts", async () => {
    const { svc, dbQuery } = makeLegacy();
    const archiveEntry = { opType: "archive", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { status: "Archived" }, reason: "Ticket is done." };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([archiveEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [ACTIVE_TESTCASE] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].techniques).toEqual([]);
  });

  it("a flat task-board create draft (no opType key) passes techniques through untouched, same as every other field", async () => {
    const { svc, dbQuery } = makeLegacy();
    const flatDraft = { title: "Checkout flow", priority: "P1", stepsJson: "[]", expectedSummary: "", preconditions: "", tags: [], techniques: ["pairwise_testing"] };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([flatDraft])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0]).toEqual(flatDraft);
  });
});

/*
 * "[Zyra] Severity and Component Are Missing in Generated Test Cases" — the chat/task-board
 * DISPLAY half of the same ticket zyra.spec.ts's ZYR-A-71..74 cover the SAVE half of. Generation
 * and persistence already carry severity/component correctly (normalizeAiDrafts,
 * zyraBatchInsertTestCases); this is where they were silently dropped before ever reaching the
 * chat/task-board UI — chatDraftRow/chatTestcaseRow rebuild the row field-by-field and, unlike
 * every other generation-time field (priority, preconditions, stepsJson, techniques...), never
 * copied these two across. Same allowlist-was-incomplete shape as the techniques fix above,
 * exercised through the identical zyraTask() boundary.
 */
describe("chatDraftRow/chatTestcaseRow severity+component — via zyraTask's wrapped-entry normalization", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a wrapped create entry's severity and component survive chatDraftRow, alongside the fields that already worked", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = {
      opType: "create",
      draft: { title: "New test", priority: "P2", stepsJson: "[]", preconditions: "", severity: "High", component: "Checkout" },
      reason: "Suggested from chat",
    };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0]).toMatchObject({ title: "New test", severity: "High", component: "Checkout" });
  });

  it("a wrapped create entry with no severity/component yet comes back null, not undefined or dropped", async () => {
    const { svc, dbQuery } = makeLegacy();
    const wrapped = { opType: "create", draft: { title: "New test", priority: "P2", stepsJson: "[]", preconditions: "" }, reason: "" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([wrapped])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0].severity).toBeNull();
    expect(task.drafts[0].component).toBeNull();
  });

  it("a wrapped archive/update preview shows the EXISTING test case's real severity/component, not blank", async () => {
    const { svc, dbQuery } = makeLegacy();
    const updateEntry = { opType: "update", testcaseId: TESTCASE_ID, externalId: "EAD-TC-1", fields: { priority: "P0" }, reason: "Bumped priority per feedback" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([updateEntry])] });
    dbQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_TESTCASE, severity: "Medium", component: "Auth" }] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0]).toMatchObject({ severity: "Medium", component: "Auth" });
  });

  it("a flat task-board create draft (no opType key) passes severity/component through untouched, same as every other field", async () => {
    const { svc, dbQuery } = makeLegacy();
    const flatDraft = { title: "Checkout flow", priority: "P1", stepsJson: "[]", expectedSummary: "", preconditions: "", tags: [], severity: "Low", component: "Billing" };
    dbQuery.mockResolvedValueOnce({ rows: [baseRow([flatDraft])] });
    mockAuth(svc);

    const task = await svc.zyraTask(PROJECT_ID, "u1", TASK_ID);

    expect(task.drafts[0]).toEqual(flatDraft);
  });
});
