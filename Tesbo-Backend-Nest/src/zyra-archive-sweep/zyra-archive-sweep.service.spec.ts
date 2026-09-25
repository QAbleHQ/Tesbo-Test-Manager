import type { DatabaseService } from "../database/database.service";
import type { LegacyService } from "../legacy/legacy.service";
import { ZyraArchiveSweepService } from "./zyra-archive-sweep.service";
import { ZYRA_ARCHIVE_SWEEP_LINEAR_CONCURRENCY } from "./zyra-archive-sweep.constants";

/*
 * ZyraArchiveSweepService.run() tested against a mocked DatabaseService (candidate query, dedup
 * pre-filter query) and a mocked LegacyService (the sub-task B/C lookup and staging methods) — no
 * real queue, no real DB, no real Jira/Linear call. The layer below this mock boundary
 * (fetchLiveJiraTicketCategoriesBulk, fetchLiveTicketCategory, stageArchiveSweepProposal
 * themselves) is covered in src/legacy/zyra-archive-sweep-lookup.spec.ts and
 * src/legacy/zyra-live-ticket-category.spec.ts.
 */

type Body = Record<string, any>;

interface LookupLike {
  found: boolean;
  doneness: "done" | "not_done" | null;
  rawCategory: string | null;
  reason: "ok" | "not_connected" | "not_found" | "unmapped_category" | "error";
}

function lookupMap(entries: Array<[string, LookupLike]>): Map<string, LookupLike> {
  return new Map(entries);
}

function candidate(id: string, projectId: string, overrides: Partial<{ jiraIssueKey: string | null; linearIssueKey: string | null }> = {}): Body {
  return { id, projectId, jiraIssueKey: overrides.jiraIssueKey ?? null, linearIssueKey: overrides.linearIssueKey ?? null };
}

function makeService(candidates: Body[], alreadyStagedIds: string[] = []) {
  const dbQuery = jest.fn().mockImplementation((sql: string) => {
    if (String(sql).includes("FROM testcases_active")) return Promise.resolve({ rows: candidates });
    if (String(sql).includes("sweep_testcase_id FROM ai_generation_requests")) {
      return Promise.resolve({ rows: alreadyStagedIds.map((id) => ({ sweep_testcase_id: id })) });
    }
    return Promise.resolve({ rows: [] });
  });
  const db = { query: dbQuery } as unknown as DatabaseService;

  const fetchLiveJiraTicketCategoriesBulk = jest.fn();
  const fetchLiveTicketCategory = jest.fn();
  const stageArchiveSweepProposal = jest.fn().mockResolvedValue("staged");
  const notifyProjectMembers = jest.fn().mockResolvedValue(1);
  const legacy = { fetchLiveJiraTicketCategoriesBulk, fetchLiveTicketCategory, stageArchiveSweepProposal, notifyProjectMembers } as unknown as LegacyService;

  const svc = new ZyraArchiveSweepService(db, legacy);
  return { svc, dbQuery, fetchLiveJiraTicketCategoriesBulk, fetchLiveTicketCategory, stageArchiveSweepProposal, notifyProjectMembers };
}

const DONE = { found: true, doneness: "done" as const, rawCategory: "done", reason: "ok" as const };
const NOT_DONE = { found: true, doneness: "not_done" as const, rawCategory: "new", reason: "ok" as const };
const NOT_CONNECTED = { found: false, doneness: null, rawCategory: null, reason: "not_connected" as const };
const NOT_FOUND = { found: false, doneness: null, rawCategory: null, reason: "not_found" as const };
const UNMAPPED = { found: true, doneness: null, rawCategory: "weird", reason: "unmapped_category" as const };

describe("ZyraArchiveSweepService.run", () => {
  afterEach(() => jest.restoreAllMocks());

  it("no candidates: a clean, all-zero summary, no lookups attempted", async () => {
    const { svc, fetchLiveJiraTicketCategoriesBulk, fetchLiveTicketCategory } = makeService([]);
    const summary = await svc.run();
    expect(summary).toMatchObject({ candidatesFound: 0, checked: 0, staged: 0, failed: 0 });
    expect(fetchLiveJiraTicketCategoriesBulk).not.toHaveBeenCalled();
    expect(fetchLiveTicketCategory).not.toHaveBeenCalled();
  });

  it("groups Jira candidates by project into one bulk call per project, not one call per candidate", async () => {
    const candidates = [
      candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }),
      candidate("tc-2", "proj-a", { jiraIssueKey: "A-2" }),
      candidate("tc-3", "proj-b", { jiraIssueKey: "B-1" })
    ];
    const { svc, fetchLiveJiraTicketCategoriesBulk } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", NOT_DONE], ["A-2", NOT_DONE], ["B-1", NOT_DONE]]));

    await svc.run();

    expect(fetchLiveJiraTicketCategoriesBulk).toHaveBeenCalledTimes(2);
    expect(fetchLiveJiraTicketCategoriesBulk).toHaveBeenCalledWith("proj-a", ["A-1", "A-2"]);
    expect(fetchLiveJiraTicketCategoriesBulk).toHaveBeenCalledWith("proj-b", ["B-1"]);
  });

  it("a done Jira candidate is staged; a not-done one is not", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }), candidate("tc-2", "proj-a", { jiraIssueKey: "A-2" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, stageArchiveSweepProposal } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE], ["A-2", NOT_DONE]]));

    const summary = await svc.run();

    expect(stageArchiveSweepProposal).toHaveBeenCalledTimes(1);
    expect(stageArchiveSweepProposal).toHaveBeenCalledWith("proj-a", "tc-1", expect.stringContaining("A-1"));
    expect(summary.staged).toBe(1);
    expect(summary.skippedNotDone).toBe(1);
    expect(summary.checked).toBe(2);
  });

  it("a Linear candidate is checked via fetchLiveTicketCategory (single-issue), not the Jira bulk path", async () => {
    const candidates = [candidate("tc-1", "proj-a", { linearIssueKey: "ENG-1" })];
    const { svc, fetchLiveTicketCategory, fetchLiveJiraTicketCategoriesBulk } = makeService(candidates);
    fetchLiveTicketCategory.mockResolvedValue(DONE);

    await svc.run();

    expect(fetchLiveTicketCategory).toHaveBeenCalledWith("proj-a", "linear", "ENG-1");
    expect(fetchLiveJiraTicketCategoriesBulk).not.toHaveBeenCalled();
  });

  it("Linear lookups never exceed the configured concurrency bound", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(`tc-${i}`, "proj-a", { linearIssueKey: `ENG-${i}` }));
    const { svc, fetchLiveTicketCategory } = makeService(candidates);
    let inFlight = 0;
    let maxInFlight = 0;
    fetchLiveTicketCategory.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return NOT_DONE;
    });

    await svc.run();

    expect(maxInFlight).toBeLessThanOrEqual(ZYRA_ARCHIVE_SWEEP_LINEAR_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1); // proves it's actually concurrent, not accidentally serialized
  });

  it("a candidate already covered by an unresolved proposal from a prior sweep is skipped before any lookup — the dedup pre-filter", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }), candidate("tc-2", "proj-a", { jiraIssueKey: "A-2" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk } = makeService(candidates, ["tc-1"]);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-2", NOT_DONE]]));

    const summary = await svc.run();

    expect(fetchLiveJiraTicketCategoriesBulk).toHaveBeenCalledWith("proj-a", ["A-2"]); // tc-1's key never sent
    expect(summary.alreadyStaged).toBe(1);
  });

  it("one project's Jira bulk lookup throwing doesn't abort other projects' candidates", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }), candidate("tc-2", "proj-b", { jiraIssueKey: "B-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, stageArchiveSweepProposal } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockImplementation(async (projectId: string) => {
      if (projectId === "proj-a") throw new Error("unexpected crash");
      return lookupMap([["B-1", DONE]]);
    });

    const summary = await svc.run();

    expect(summary.failed).toBe(1);
    expect(summary.failures[0]).toMatchObject({ testcaseId: "tc-1", provider: "jira" });
    expect(stageArchiveSweepProposal).toHaveBeenCalledWith("proj-b", "tc-2", expect.any(String));
    expect(summary.staged).toBe(1);
  });

  it("one Linear candidate's lookup throwing doesn't abort the others", async () => {
    const candidates = [candidate("tc-1", "proj-a", { linearIssueKey: "ENG-1" }), candidate("tc-2", "proj-a", { linearIssueKey: "ENG-2" })];
    const { svc, fetchLiveTicketCategory } = makeService(candidates);
    fetchLiveTicketCategory.mockImplementation(async (_p: string, _prov: string, key: string) => {
      if (key === "ENG-1") throw new Error("timeout");
      return DONE;
    });

    const summary = await svc.run();

    expect(summary.failed).toBe(1);
    expect(summary.failures[0]).toMatchObject({ testcaseId: "tc-1", provider: "linear", reason: "error" });
    expect(summary.staged).toBe(1);
  });

  it("not_found and error results are counted as failed, distinctly from not_connected and unmapped_category", async () => {
    const candidates = [
      candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }),
      candidate("tc-2", "proj-a", { jiraIssueKey: "A-2" }),
      candidate("tc-3", "proj-a", { jiraIssueKey: "A-3" })
    ];
    const { svc, fetchLiveJiraTicketCategoriesBulk } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(
      lookupMap([
        ["A-1", NOT_FOUND],
        ["A-2", NOT_CONNECTED],
        ["A-3", UNMAPPED]
      ])
    );

    const summary = await svc.run();

    expect(summary.failed).toBe(1);
    expect(summary.skippedNotConnected).toBe(1);
    expect(summary.skippedUnmappedCategory).toBe(1);
    expect(summary.checked).toBe(2); // not_connected never counted as "checked"
  });

  it("a test case linked to both Jira and Linear, both done, stages exactly once — the second attempt reports already_staged", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1", linearIssueKey: "ENG-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, fetchLiveTicketCategory, stageArchiveSweepProposal } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE]]));
    fetchLiveTicketCategory.mockResolvedValue(DONE);
    stageArchiveSweepProposal.mockResolvedValueOnce("staged").mockResolvedValueOnce("already_staged");

    const summary = await svc.run();

    expect(stageArchiveSweepProposal).toHaveBeenCalledTimes(2);
    expect(summary.staged).toBe(1);
    expect(summary.alreadyStaged).toBe(1);
  });

  it("stageArchiveSweepProposal returning 'skipped' (archived/deleted mid-run) is counted separately from staged/already_staged", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, stageArchiveSweepProposal } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE]]));
    stageArchiveSweepProposal.mockResolvedValueOnce("skipped");

    const summary = await svc.run();

    expect(summary.skippedArchivedMeanwhile).toBe(1);
    expect(summary.staged).toBe(0);
  });

  it("reports a duration and never throws even when every candidate fails", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockRejectedValue(new Error("total outage"));

    const summary = await svc.run();

    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.failed).toBe(1);
  });
});

describe("ZyraArchiveSweepService.run — notifications", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a clean sweep (zero staged) never calls notifyProjectMembers — no spam for nothing found", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", NOT_DONE]]));

    const summary = await svc.run();

    expect(notifyProjectMembers).not.toHaveBeenCalled();
    expect(summary.notifiedProjects).toBe(0);
    expect(summary.notificationRows).toBe(0);
  });

  it("a project with a single staged candidate gets exactly ONE notifyProjectMembers call, not one per candidate", async () => {
    const candidates = [
      candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }),
      candidate("tc-2", "proj-a", { jiraIssueKey: "A-2" }),
      candidate("tc-3", "proj-a", { jiraIssueKey: "A-3" })
    ];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE], ["A-2", DONE], ["A-3", DONE]]));

    const summary = await svc.run();

    expect(notifyProjectMembers).toHaveBeenCalledTimes(1); // one call, not three
    expect(notifyProjectMembers).toHaveBeenCalledWith(
      "proj-a",
      expect.objectContaining({
        type: "zyra_archive_sweep",
        title: expect.stringContaining("3"),
        linkEntityType: "zyra_task_board",
        linkEntityId: "proj-a"
      })
    );
    expect(summary.notifiedProjects).toBe(1);
  });

  it("two projects with staged candidates each get their own notification call", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }), candidate("tc-2", "proj-b", { jiraIssueKey: "B-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE], ["B-1", DONE]]));

    const summary = await svc.run();

    expect(notifyProjectMembers).toHaveBeenCalledTimes(2);
    expect(notifyProjectMembers).toHaveBeenCalledWith("proj-a", expect.anything());
    expect(notifyProjectMembers).toHaveBeenCalledWith("proj-b", expect.anything());
    expect(summary.notifiedProjects).toBe(2);
  });

  it("the dedupe key is scoped per project per calendar day — same project, same day, same key across two runs", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE]]));

    await svc.run();

    const dedupeKey = (notifyProjectMembers.mock.calls[0][1] as Body).dedupeKey as string;
    expect(dedupeKey).toMatch(/^archive_sweep:proj-a:\d{4}-\d{2}-\d{2}$/);
  });

  it("a candidate whose proposal was already staged by a PRIOR sweep (the dedup pre-filter) does not trigger a fresh notification — only genuinely new staging does", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates, ["tc-1"]);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([]));

    const summary = await svc.run();

    expect(notifyProjectMembers).not.toHaveBeenCalled();
    expect(summary.alreadyStaged).toBe(1);
  });

  it("a notification failure for one project doesn't abort another project's notification, and never touches staging results already recorded", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" }), candidate("tc-2", "proj-b", { jiraIssueKey: "B-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE], ["B-1", DONE]]));
    notifyProjectMembers.mockImplementation(async (projectId: string) => {
      if (projectId === "proj-a") throw new Error("db exploded");
      return 2;
    });

    const summary = await svc.run();

    expect(summary.staged).toBe(2); // staging itself is unaffected by the notify failure
    expect(summary.notifyFailures).toBe(1);
    expect(summary.notifiedProjects).toBe(1);
    expect(summary.notificationRows).toBe(2);
  });

  it("zero recipients (notifyProjectMembers resolves 0 rows — e.g. a project with no members) is not counted as a notified project, but is not an error either", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE]]));
    notifyProjectMembers.mockResolvedValue(0);

    const summary = await svc.run();

    expect(notifyProjectMembers).toHaveBeenCalledTimes(1);
    expect(summary.notifiedProjects).toBe(0);
    expect(summary.notificationRows).toBe(0);
    expect(summary.notifyFailures).toBe(0);
    expect(summary.staged).toBe(1); // staging still succeeded regardless
  });

  it("a project-name lookup failure doesn't skip the notification — it's cosmetic, not required", async () => {
    const candidates = [candidate("tc-1", "proj-a", { jiraIssueKey: "A-1" })];
    const { svc, dbQuery, fetchLiveJiraTicketCategoriesBulk, notifyProjectMembers } = makeService(candidates);
    fetchLiveJiraTicketCategoriesBulk.mockResolvedValue(lookupMap([["A-1", DONE]]));
    dbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("FROM testcases_active")) return Promise.resolve({ rows: candidates });
      if (String(sql).includes("sweep_testcase_id FROM ai_generation_requests")) return Promise.resolve({ rows: [] });
      if (String(sql).includes("SELECT name FROM projects")) return Promise.reject(new Error("name lookup failed"));
      return Promise.resolve({ rows: [] });
    });

    const summary = await svc.run();

    expect(notifyProjectMembers).toHaveBeenCalledTimes(1);
    expect(summary.notifiedProjects).toBe(1);
  });
});
