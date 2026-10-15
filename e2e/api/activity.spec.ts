import { expect, test, type APIRequestContext } from "@playwright/test";
import { exec, execAllowingAuditImmutability, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The activity feed: GET /api/projects/:projectId/activity and GET /api/workspace/activity, plus
 * both /summary companions.
 *
 * Reported as "Activity data is not displayed correctly" (BetterBugs 6a7c763c), against both the
 * project Activity stream and the workspace Activity page. The report's Actual Result is truncated
 * mid-sentence in Basecamp and in BetterBugs, so these tests specify the feed from its own stated
 * contract instead: the project page calls itself "A full audit log of all actions taken across this
 * project — who did what and when".
 *
 * Tested at the API rather than through the browser on purpose. The pages render whatever the feed
 * returns — `activityShared.tsx` computes `actorName || actorEmail || "System"` and nothing else — so
 * every way the display can be wrong is a way the payload is wrong, and asserting the payload names
 * the defect instead of a rendered string.
 *
 * WHAT IS ALREADY KNOWN TO BE WRONG, from reading `activityEventsSql`:
 *
 * The feed is a UNION of `audit_logs` rows (which carry a real actor) and rows SYNTHESIZED from the
 * base tables. Every synthetic branch selects `NULL::uuid AS actor_id, NULL AS actor_name` except
 * plan-created / cycle-created / bug-created, which use the owner or reporter. So:
 *
 *   - suite created and suite updated have NO actor, ever
 *   - plan updated and cycle updated have NO actor
 *   - bug updated is attributed to `reported_by` — whoever FILED it, not whoever changed it
 *
 * and each of those renders in the UI as the word "System". A person's action shown as "System" is
 * exactly "activity data is not displayed correctly".
 *
 * The suite half is downstream of §3 bug 1: `createSuite(projectId, body)` takes no `userId`
 * parameter at all, so there is no actor to record even in principle. ACT-A-02 stays red until that
 * handler takes a caller and the branch records it. Do not weaken it to `toBeDefined()`.
 *
 * Also pinned here: the feed calls itself an audit log, and the synthetic rows are derived from the
 * live row — so an entity's hard deletion retroactively erases its history. `deleteSuite` is no
 * longer one: migrations/V110_suites_soft_delete.sql plus the deleteSuite rewrite mean a deleted
 * suite's row survives (soft-deleted), so its "created"/"updated" synthetic entries now survive too —
 * genuinely, not merely because a separate audit_logs entry happens to remember it. ACT-A-11 states
 * the audit-log expectation and now passes for the reason the feed's own name implies it should, not
 * despite it.
 *
 * `deleteCycle` was also a hard delete when the paragraph above was first written, so the same
 * erasure applied to cycle-created/cycle-updated too — that has since changed. Hard-delete
 * remediation Phase 1 (migrations/V111_cycles_soft_delete.sql) made deleteCycle a soft-delete, and
 * Phase 2 applied the identical "(deleted)" marker treatment `activityEventsSql` already gives
 * suites to the cycle-created/cycle-updated branches (legacy.service.ts:7161-7173). ACT-A-18 below
 * is the cycle equivalent of ACT-A-11.
 */

test.describe("activity feed", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asQa: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("activity");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asQa = await loginAs(tenant.qa);
    anon = await anonymousContext();
  });

  test.afterAll(async () => {
    if (tenant) purgeActivity();
    await Promise.all([asOwner, asQa, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    if (tenant) purgeActivity();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Empties everything the feed derives from, so each test's events are the only ones in it.
   *
   * The feed synthesizes rows from suites/plans/cycles/bugs, so those tables ARE the feed's history —
   * clearing them is how a test gets a known starting point. Done through psql because the point is
   * to reset state, not to exercise the delete endpoints.
   */
  function purgeActivity(): void {
    const projects = `${literal(tenant!.mainProjectId)}, ${literal(tenant!.secondProjectId)}`;
    /*
     * audit_logs is NOT cleared here, and cannot be — that is the point of an audit log.
     *
     * Migration V62_audit_logs_immutable.sql makes it tamper-evident: a trigger rejects UPDATE and DELETE
     * for every role, and the grants are revoked from the app role as a second layer. The statement is
     * kept (harmless, and it still clears anything not yet protected) but its refusal is tolerated,
     * because throwing here fired in beforeAll AND afterEach — killing all 17 tests in this file and
     * leaving the workspace dirty for whatever ran next.
     *
     * CONSEQUENCE FOR EVERY ASSERTION BELOW: this project's feed ACCUMULATES across tests and across
     * runs. No test may assume an empty feed, a specific feed length, or an absolute position. Instead:
     *
     *   - every entity is created with stamp(), which embeds Date.now() + a random suffix, so a name can
     *     never collide with another test's or an earlier run's;
     *   - entries are located with entryFor(name), never by index;
     *   - ordering is asserted on the RELATIVE positions of this test's own stamped entries;
     *   - counts are asserted as "at least", or scoped by a filter that isolates this test's rows.
     *
     * The other tables ARE cleared: the feed synthesizes rows from suites/plans/cycles/bugs, and those
     * deletes still work, so a purged entity's synthesized row disappears while its audit row remains.
     * A feed entry for an entity that no longer exists is therefore normal here, not a bug — ACT-A-11
     * asserts exactly that survival.
     */
    execAllowingAuditImmutability(`DELETE FROM audit_logs WHERE project_id IN (${projects});`);
    exec(`DELETE FROM executions WHERE cycle_item_id IN (SELECT ci.id FROM cycle_items ci JOIN cycles c ON c.id = ci.cycle_id WHERE c.project_id IN (${projects}));`);
    exec(`DELETE FROM cycle_items WHERE cycle_id IN (SELECT id FROM cycles WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM cycles WHERE project_id IN (${projects});`);
    exec(`DELETE FROM plan_items WHERE plan_id IN (SELECT id FROM plans WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM plans WHERE project_id IN (${projects});`);
    exec(`DELETE FROM bug_links WHERE bug_id IN (SELECT id FROM bugs WHERE project_id IN (${projects}));`);
    exec(`DELETE FROM bugs WHERE project_id IN (${projects});`);
    exec(`DELETE FROM testcases WHERE project_id IN (${projects});`);
    exec(`DELETE FROM suites WHERE project_id IN (${projects});`);
  }

  function stamp(label: string): string {
    return `E2E ACT ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  interface ActivityItem {
    id: string;
    actorId?: string | null;
    actorName?: string | null;
    actorEmail?: string | null;
    actorKind?: string | null;
    action?: string;
    entityType?: string;
    entityId?: string;
    entityName?: string;
    createdAt?: string;
  }

  async function feed(
    params: Record<string, string | number> = {},
    api: APIRequestContext = asOwner,
    projectId = tenant!.mainProjectId,
  ): Promise<{ list: ActivityItem[]; total: number }> {
    const res = await api.get(`/api/projects/${projectId}/activity`, {
      params: params as Record<string, string>,
      failOnStatusCode: false,
    });
    expect(res.status(), `project activity — ${await res.text()}`).toBe(200);
    return res.json();
  }

  async function workspaceFeed(params: Record<string, string | number> = {}) {
    const res = await asOwner.get("/api/workspace/activity", {
      params: params as Record<string, string>,
      failOnStatusCode: false,
    });
    expect(res.status(), `workspace activity — ${await res.text()}`).toBe(200);
    return res.json() as Promise<{ list: ActivityItem[]; total: number }>;
  }

  /** The feed entry naming a given entity, or undefined. */
  function entryFor(list: ActivityItem[], entityName: string, action?: string): ActivityItem | undefined {
    return list.find((i) => i.entityName === entityName && (action ? i.action === action : true));
  }

  /** What the UI would print for an entry — activityShared.tsx's exact expression. */
  function renderedActor(item: ActivityItem | undefined): string {
    if (!item) return "<no entry>";
    return item.actorName || item.actorEmail || "System";
  }

  async function createSuite(name: string, api: APIRequestContext = asOwner): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/suites`, { data: { name } });
    expect(res.ok(), `creating suite — ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
  }

  async function createTestCase(title: string, api: APIRequestContext = asOwner): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/testcases`, { data: { title } });
    expect(res.ok(), `creating test case — ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
  }

  async function createCycle(name: string, api: APIRequestContext = asOwner): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/cycles`, { data: { name } });
    expect(res.ok(), `creating run — ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
  }

  // ─── The feed records what happened ────────────────────────────────────────

  test("ACT-A-01 an action in a project appears in that project's feed", { tag: '@tesbo.testId("TES-TC-886")' }, async () => {
    const suiteName = stamp("Suite");
    const caseTitle = stamp("Case");
    await createSuite(suiteName);
    await createTestCase(caseTitle);

    const { list, total } = await feed({ limit: 100 });

    expect(total, "the feed reports how many events it has").toBeGreaterThanOrEqual(2);
    expect(entryFor(list, suiteName, "created"), `no "created" entry for the suite — got ${JSON.stringify(list.map((i) => [i.entityType, i.action, i.entityName]))}`).toBeTruthy();
    expect(entryFor(list, caseTitle), "no entry for the new test case").toBeTruthy();
  });

  test("ACT-A-02 every entry says who did it, never 'System'", { tag: '@tesbo.testId("TES-TC-887")' }, async () => {
    const suiteName = stamp("AttributedSuite");
    const caseTitle = stamp("AttributedCase");
    const suiteId = await createSuite(suiteName);
    await createTestCase(caseTitle);

    // An update as well as a create: the synthetic *-updated- branches drop the actor even where the
    // create branch keeps it, so a create-only assertion would miss half the defect.
    const renamed = `${suiteName} renamed`;
    // PATCH /api/suites/:suiteId, not PUT /api/projects/:projectId/suites/:suiteId — suite update
    // and delete are addressed by suite id alone (LegacyController), so the project-scoped PUT this
    // spec used answered "Cannot PUT …" and read as a failure to rename.
    const updated = await asOwner.patch(`/api/suites/${suiteId}`, {
      data: { name: renamed },
      failOnStatusCode: false,
    });
    expect(updated.ok(), `renaming the suite — ${await updated.text()}`).toBeTruthy();

    const { list } = await feed({ limit: 100 });

    // The test case goes through logProjectActivity and carries a real actor — proof the feed CAN
    // attribute, so the suite entries below are a defect and not a missing feature.
    const caseEntry = entryFor(list, caseTitle);
    expect(renderedActor(caseEntry), "a test case action is attributed").toBe(tenant!.owner.email);

    // Every entry, whatever produced it. "System" is what the UI prints when actorName and
    // actorEmail are both null, so asserting on that string asserts on what the user actually sees.
    const unattributed = list.filter((i) => renderedActor(i) === "System");
    expect(
      unattributed.map((i) => `${i.entityType}/${i.action}/${i.entityName}`),
      "these entries render as 'System' although a person performed them",
    ).toEqual([]);
  });

  test("ACT-A-03 the same action also reaches the workspace-wide feed", { tag: '@tesbo.testId("TES-TC-888")' }, async () => {
    const suiteName = stamp("WorkspaceVisible");
    await createSuite(suiteName);

    const { list } = await workspaceFeed({ limit: 100 });

    // The reporter checked both surfaces. The workspace feed is a different query with its own
    // project-scope predicate and an extra org-only branch, so it can disagree with the project one.
    expect(entryFor(list, suiteName), "the event is missing from the workspace feed").toBeTruthy();
  });

  test("ACT-A-04 an entry carries the entity it describes and when it happened", { tag: '@tesbo.testId("TES-TC-889")' }, async () => {
    const suiteName = stamp("Shaped");
    const suiteId = await createSuite(suiteName);

    const { list } = await feed({ limit: 100 });
    const entry = entryFor(list, suiteName, "created");
    expect(entry).toBeTruthy();

    expect(entry!.entityType).toBe("suite");
    expect(entry!.entityId).toBe(suiteId);
    expect(entry!.entityName).toBe(suiteName);
    expect(entry!.action).toBe("created");
    // A row the UI groups by day has to have a parseable date to be grouped at all.
    expect(Number.isNaN(Date.parse(entry!.createdAt ?? "")), `createdAt was ${entry!.createdAt}`).toBe(false);
    expect(entry!.id, "every entry needs a stable key for the list").toBeTruthy();
  });

  test("ACT-A-05 the feed is newest first", { tag: '@tesbo.testId("TES-TC-890")' }, async () => {
    const first = stamp("Oldest");
    const second = stamp("Middle");
    const third = stamp("Newest");
    // Awaited in turn so created_at genuinely increases.
    for (const name of [first, second, third]) await createSuite(name);

    const { list } = await feed({ limit: 100 });

    // Global ordering still holds however many entries have accumulated.
    const times = list.map((i) => Date.parse(i.createdAt ?? ""));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times, "entries must arrive in descending time order").toEqual(sorted);

    /*
     * Ordering is checked on THIS test's three entries only.
     *
     * The feed accumulates (see purgeActivity), so absolute positions mean nothing. The previous form
     * compared `names.indexOf(third)` with `names.indexOf(first)` — and indexOf returns -1 for a name
     * that is not in the window at all, so a feed that had dropped these entries scored -1 < -1 = false,
     * or worse, -1 < 5 = true and passed while proving nothing.
     */
    const names = list.map((i) => i.entityName);
    for (const name of [first, second, third]) {
      expect(names, `${name} is missing from the feed, so ordering cannot be judged`).toContain(name);
    }
    const [iFirst, iSecond, iThird] = [first, second, third].map((n) => names.indexOf(n));
    expect(iThird, "the newest suite should sit above the middle one").toBeLessThan(iSecond);
    expect(iSecond, "the middle suite should sit above the oldest one").toBeLessThan(iFirst);
  });

  test("ACT-A-06 one action produces one entry, not two", { tag: '@tesbo.testId("TES-TC-891")' }, async () => {
    const caseTitle = stamp("NoDuplicate");
    await createTestCase(caseTitle);

    const { list } = await feed({ limit: 100 });

    // The union of audit_logs and synthesized rows is where double-counting comes from — the code
    // comment says testcases are deliberately not synthesized for exactly this reason, and this is
    // the test that keeps that true.
    const matching = list.filter((i) => i.entityName === caseTitle && i.action === "testcase_created");
    const anyMatching = list.filter((i) => i.entityName === caseTitle);
    expect(anyMatching.length, `${anyMatching.length} entries for one created test case`).toBe(
      Math.max(1, matching.length),
    );
    expect(new Set(list.map((i) => i.id)).size, "entry ids must be unique").toBe(list.length);
  });

  // ─── Filters ───────────────────────────────────────────────────────────────

  test("ACT-A-07 the entityType filter narrows the feed to that type", { tag: '@tesbo.testId("TES-TC-892")' }, async () => {
    const suiteName = stamp("TypeFilterSuite");
    const caseTitle = stamp("TypeFilterCase");
    await createSuite(suiteName);
    await createTestCase(caseTitle);

    const suitesOnly = await feed({ entityType: "suite", limit: 100 });
    expect(suitesOnly.list.length).toBeGreaterThan(0);
    expect(suitesOnly.list.every((i) => i.entityType === "suite"), "a non-suite survived the filter").toBe(true);
    expect(entryFor(suitesOnly.list, caseTitle)).toBeFalsy();

    // The UI's Knowledge base option sends a comma-separated list, so that form has to work too.
    const multi = await feed({ entityType: "suite,testcase", limit: 100 });
    expect(multi.list.every((i) => ["suite", "testcase"].includes(i.entityType ?? "")), "the comma form leaked another type").toBe(true);
    expect(multi.list.length).toBeGreaterThanOrEqual(suitesOnly.list.length);
  });

  test("ACT-A-08 the search filter matches an entity's name", { tag: '@tesbo.testId("TES-TC-893")' }, async () => {
    const needle = `Needle${Date.now()}`;
    const hit = stamp(`${needle} Hit`);
    const miss = stamp("Miss");
    await createSuite(hit);
    await createSuite(miss);

    const { list } = await feed({ search: needle, limit: 100 });

    expect(entryFor(list, hit), "the matching entity is missing").toBeTruthy();
    expect(entryFor(list, miss), "a non-matching entity survived the search").toBeFalsy();
  });

  test("ACT-A-09 the since filter drops everything older than it", { tag: '@tesbo.testId("TES-TC-894")' }, async () => {
    const older = stamp("BeforeCutoff");
    await createSuite(older);

    // A cutoff in the future must empty the feed; the epoch must not drop anything.
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const afterFuture = await feed({ since: future, limit: 100 });
    expect(afterFuture.list, `entries survived a cutoff an hour in the future`).toEqual([]);
    expect(afterFuture.total).toBe(0);

    const afterEpoch = await feed({ since: "1970-01-01T00:00:00.000Z", limit: 100 });
    expect(entryFor(afterEpoch.list, older)).toBeTruthy();
  });

  test("ACT-A-10 the actorId filter narrows the feed to one person's actions", { tag: '@tesbo.testId("TES-TC-895")' }, async () => {
    const byOwner = stamp("ByOwner");
    const byQa = stamp("ByQa");
    await createTestCase(byOwner, asOwner);
    await createTestCase(byQa, asQa);

    const ownerOnly = await feed({ actorId: tenant!.owner.userId, limit: 100 });

    expect(entryFor(ownerOnly.list, byOwner), "the owner's own action is missing").toBeTruthy();
    expect(entryFor(ownerOnly.list, byQa), "another actor's action survived the filter").toBeFalsy();
    expect(
      ownerOnly.list.every((i) => !i.actorId || i.actorId === tenant!.owner.userId),
      "an entry belonging to someone else came back",
    ).toBe(true);
  });

  // ─── Scope, paging and refusals ────────────────────────────────────────────

  test("ACT-A-11 an entity's history survives the entity being deleted", { tag: '@tesbo.testId("TES-TC-896")' }, async () => {
    const suiteName = stamp("DeletedButRemembered");
    const suiteId = await createSuite(suiteName);
    expect(entryFor((await feed({ limit: 100 })).list, suiteName)).toBeTruthy();

    // Addressed by suite id alone, as above.
    const deleted = await asOwner.delete(`/api/suites/${suiteId}`, {
      failOnStatusCode: false,
    });
    expect(deleted.ok(), `deleting the suite — ${await deleted.text()}`).toBeTruthy();

    // The page calls itself "a full audit log". Before Zyra context integrity Phase 3/4
    // (migrations/V110_suites_soft_delete.sql, legacy.service.ts's deleteSuite rewrite), deleteSuite
    // was a HARD delete and the suite branches read from the live row, so the record of it ever
    // existing went with it — an audit log that forgets is the one thing an audit log may not do.
    // Now the suite row survives (soft-deleted), so this entry survives too — genuinely, not by
    // accident of a separate audit_logs row remembering it. Per Q10's resolution, the surviving name
    // is marked "(deleted)" rather than shown as if the suite were still live — the same
    // "history, not current state" treatment planItemRows gets (see plans.spec.ts).
    const { list } = await feed({ limit: 100 });
    const entry = entryFor(list, `${suiteName} (deleted)`);
    expect(
      entry,
      `the audit log lost its record of the suite when the suite was deleted — got ${JSON.stringify(list.map((i) => i.entityName))}`,
    ).toBeTruthy();
    expect(entry!.entityType).toBe("suite");
  });

  test("ACT-A-12 another project's activity is not in this project's feed", { tag: '@tesbo.testId("TES-TC-897")' }, async () => {
    const mine = stamp("MyProject");
    await createSuite(mine);
    const theirsName = stamp("OtherProject");
    const theirs = await asOwner.post(`/api/projects/${tenant!.secondProjectId}/suites`, {
      data: { name: theirsName },
    });
    expect(theirs.ok()).toBeTruthy();
    const theirSuiteId = (await theirs.json()).id;

    const { list } = await feed({ limit: 100 });

    expect(entryFor(list, mine)).toBeTruthy();
    expect(entryFor(list, theirsName), "the second project's event leaked into this feed").toBeFalsy();
    expect(
      list.every((i) => i.entityId !== theirSuiteId),
      "the other project's entity id appeared here",
    ).toBe(true);
  });

  test("ACT-A-13 limit and offset page the feed, and total ignores them", { tag: '@tesbo.testId("TES-TC-898")' }, async () => {
    for (let i = 0; i < 4; i++) await createSuite(stamp(`Page${i}`));

    const all = await feed({ limit: 100 });
    expect(all.total).toBeGreaterThanOrEqual(4);

    const firstPage = await feed({ limit: 2, offset: 0 });
    const secondPage = await feed({ limit: 2, offset: 2 });

    expect(firstPage.list).toHaveLength(2);
    expect(secondPage.list).toHaveLength(2);
    // total is the count before paging — the projects list and the "Load more" button both depend on
    // that, and a total equal to the page size is what makes a full page look like the last one.
    expect(firstPage.total).toBe(all.total);
    expect(secondPage.total).toBe(all.total);
    const overlap = firstPage.list.filter((a) => secondPage.list.some((b) => b.id === a.id));
    expect(overlap, "pages must not repeat entries").toEqual([]);
  });

  test("ACT-A-14 a malformed limit or offset is not a 500", { tag: '@tesbo.testId("TES-TC-899")' }, async () => {
    await createSuite(stamp("BadPaging"));

    // pageNumber() exists because NaN used to survive Math.max/Math.min and reach the LIMIT clause.
    const malformed: Record<string, string>[] = [
      { limit: "abc" },
      { limit: "-5" },
      { limit: "99999" },
      { offset: "not-a-number" },
      { offset: "-1" },
      { since: "not-a-date" },
      { actorId: "not-a-uuid" },
      { entityType: "," },
    ];
    for (const params of malformed) {
      const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/activity`, {
        params,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(params)} — ${await res.text()}`).toBeLessThan(500);
    }
  });

  test("ACT-A-14b a malformed since or actorId is refused as a bad request, not swallowed", { tag: '@tesbo.testId("TES-TC-1107")' }, async () => {
    /*
     * These two used to reach Postgres unchecked — `since` as `$n::timestamptz` (22007) and
     * `actorId` against a uuid column (22P02) — and both answered 500. "Not a 500" is the floor;
     * the contract is that a bad query parameter says so, because the screen's date picker and
     * actor filter are what put these values on the wire and it has to know which one it got wrong.
     */
    const malformed: Record<string, string>[] = [
      { since: "not-a-date" },
      { since: "2026-13-45" },
      { actorId: "not-a-uuid" },
    ];
    for (const params of malformed) {
      const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/activity`, {
        params,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(params)} — ${await res.text()}`).toBe(400);
    }

    // A well-formed value on the same parameters still works, so the guard rejects the input rather
    // than the feature.
    const ok = await feed({ since: "1970-01-01T00:00:00.000Z", limit: 5 });
    expect(Array.isArray(ok.list)).toBe(true);
  });

  test("ACT-A-14c the since filter resolves against a feed that joins projects", { tag: '@tesbo.testId("TES-TC-1108")' }, async () => {
    /*
     * Regression for Postgres 42702. The feed's outer query is
     * `FROM activity_events ae LEFT JOIN projects pr`, and `projects` has a `created_at` of its own,
     * so the unqualified `created_at >= $n` that `?since=` built was ambiguous and every filtered
     * request answered 500. A plain 200 with the entry present is the whole assertion — the bug was
     * that the query would not run at all.
     */
    const name = stamp("SinceResolves");
    await createSuite(name);

    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const { list } = await feed({ since, limit: 100 });
    expect(entryFor(list, name), "an entry from the last hour is missing from a since-filtered feed").toBeTruthy();
  });

  test("ACT-A-15 the summary agrees with the feed it summarises", { tag: '@tesbo.testId("TES-TC-900")' }, async () => {
    const caseTitle = stamp("SummaryCase");
    await createTestCase(caseTitle);

    const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/activity/summary`, {
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    const summary = await res.json();

    // The panel beside the feed reads from this, so a summary that disagrees with the list next to it
    // is the same class of "displayed incorrectly" as a missing actor.
    expect(Array.isArray(summary.activity) || typeof summary === "object").toBe(true);
    /*
     * Each named actor is confirmed with a FILTERED query rather than by scanning a window of the feed.
     *
     * The feed accumulates, so the newest 100 entries are not the whole history: a legitimate top actor
     * whose entries sit beyond that window would have read as "absent from the feed" and failed a
     * correct summary. Asking the feed for that actor specifically is accumulation-proof and is the
     * consistency the panel actually needs — the summary must not name anyone the feed cannot produce.
     */
    if (Array.isArray(summary.topActors) && summary.topActors.length) {
      for (const actor of summary.topActors) {
        if (!actor?.actorId) continue;
        const theirs = await feed({ actorId: actor.actorId, limit: 5 });
        expect(
          theirs.list.length,
          `summary names actor ${actor.actorId}, but the feed returns nothing for them`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("ACT-A-16 an anonymous caller and a non-member are both refused", { tag: '@tesbo.testId("TES-TC-901")' }, async () => {
    await createSuite(stamp("Guarded"));

    const anonRes = await anon.get(`/api/projects/${tenant!.mainProjectId}/activity`, { failOnStatusCode: false });
    expect(anonRes.status(), `anonymous read answered ${anonRes.status()}`).toBe(401);

    // The workspace feed is owner-only by its own rule, so a QA engineer in the same workspace is the
    // sharpest case: authenticated, a real member, and still not entitled to the rollup.
    const qaWorkspace = await asQa.get("/api/workspace/activity", { failOnStatusCode: false });
    expect([401, 403]).toContain(qaWorkspace.status());

    const anonWorkspace = await anon.get("/api/workspace/activity", { failOnStatusCode: false });
    expect(anonWorkspace.status()).toBe(401);
  });

  test("ACT-A-17 a workspace member with no project access cannot read its activity", { tag: '@tesbo.testId("TES-TC-902")' }, async () => {
    await createSuite(stamp("NoAccess"));
    const asGuest = await loginAs(tenant!.guest);
    try {
      const res = await asGuest.get(`/api/projects/${tenant!.mainProjectId}/activity`, {
        failOnStatusCode: false,
      });
      expect([401, 403, 404], `a non-member read the activity: ${await res.text()}`).toContain(res.status());
    } finally {
      await asGuest.dispose();
    }
  });

  // ─── Hard-delete remediation Phase 2: cycle-created/cycle-updated survive the run's own deletion ──

  test("ACT-A-18 a run's created/updated history survives the run being soft-deleted, marked rather than blanked", async () => {
    // The cycle equivalent of ACT-A-11's suite case. Before this fix, cycle-created/cycle-updated
    // rendered the LIVE cycles.name with no deleted_at-aware CASE at all, so once deleteCycle
    // (hard-delete remediation Phase 1) started soft-deleting the row instead of removing it, the
    // synthetic rows kept resolving the live (still-present) name forever — a "deleted" run's
    // history never said so. This proves both halves: the entry survives, AND it is marked.
    const runName = stamp("RunDeletedButRemembered");
    const cycleId = await createCycle(runName);
    const createdEntry = entryFor((await feed({ limit: 100 })).list, runName, "created");
    expect(createdEntry, "the run's own creation must appear in the feed before it is touched").toBeTruthy();
    expect(createdEntry!.entityType).toBe("cycle");

    // updated_at must move past created_at by more than the union's 1-second guard before the
    // synthetic "updated" branch fires at all — same requirement activityEventsSql applies to every
    // other entity. Backdating created_at (rather than sleeping in the test) makes that gap
    // deterministic without slowing the suite down.
    const renamed = `${runName} (renamed)`;
    exec(`UPDATE cycles SET created_at = now() - interval '5 seconds' WHERE id = ${literal(cycleId)};`);
    const patchRes = await asOwner.patch(`/api/cycles/${cycleId}`, { data: { name: renamed } });
    expect(patchRes.ok(), `renaming the run — ${await patchRes.text()}`).toBeTruthy();
    const updatedEntry = entryFor((await feed({ limit: 100 })).list, renamed, "updated");
    expect(updatedEntry, "the rename must appear as its own 'updated' entry").toBeTruthy();

    const deleteRes = await asOwner.delete(`/api/cycles/${cycleId}`);
    expect(deleteRes.ok(), `deleting the run — ${await deleteRes.text()}`).toBeTruthy();

    const { list } = await feed({ limit: 100 });
    // Both branches select the live cycles.name column (there is no snapshot the way plan_items
    // takes one) — so once the run is renamed, BOTH the "created" and "updated" synthetic rows read
    // the same current name, and after the delete both independently apply the CASE WHEN marker to
    // it. Two distinct entries (different id suffix and action), same displayed name — which is
    // exactly why the fix has to live in both branches rather than one: an unfixed "created" branch
    // would still leak the live name even with "updated" already marked correctly.
    const createdAfterDelete = entryFor(list, `${renamed} (deleted)`, "created");
    expect(
      createdAfterDelete,
      `the run's creation entry lost its record when the run was deleted — got ${JSON.stringify(list.map((i) => i.entityName))}`,
    ).toBeTruthy();
    expect(createdAfterDelete!.entityType).toBe("cycle");

    const updatedAfterDelete = entryFor(list, `${renamed} (deleted)`, "updated");
    expect(
      updatedAfterDelete,
      `the run's rename entry lost its record when the run was deleted — got ${JSON.stringify(list.map((i) => i.entityName))}`,
    ).toBeTruthy();
  });

  // ─── Volume: the zyra de-duplication must scale linearly ───────────────────

  /**
   * Seeds testcase_* audit rows directly, since creating thousands through the API is minutes of
   * round trips. audit_logs is append-only (see purgeActivity), so these rows are permanent: seed only
   * the shortfall, which keeps repeated runs from growing the table without bound.
   */
  function seedBulkTestcaseAudit(total: number): void {
    const have = Number(
      scalar(
        `SELECT count(*) FROM audit_logs WHERE project_id = ${literal(tenant!.mainProjectId)} AND entity_name LIKE 'E2E ACT BULK %' AND created_at > now() - interval '5 days';`,
      ) || "0",
    );
    const missing = total - have;
    if (missing <= 0) return;
    exec(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, entity_name, project_id, organization_id, created_at)
       SELECT ${literal(tenant!.owner.userId)},
              CASE WHEN g % 2 = 0 THEN 'testcase_created' ELSE 'testcase_updated' END,
              'testcase', 'e2e-act-bulk-' || ${literal(String(Date.now()))} || '-' || g, 'E2E ACT BULK ' || g,
              ${literal(tenant!.mainProjectId)}, ${literal(tenant!.organizationId)},
              now() - (g || ' seconds')::interval
       FROM generate_series(1, ${missing}) g;`,
    );
  }

  test("ACT-A-19 a project with thousands of test-case audit rows still answers the feed and summary promptly", async () => {
    /*
     * Regression for the project dashboard's 500 + redirect to All Projects. The zyra de-duplication
     * was a correlated NOT (… AND EXISTS (SELECT … FROM activity_events z …)) that full-scanned the
     * materialized CTE once per testcase_created/updated row — O(testcase rows × all rows). Measured
     * on a 7k-row project that was 2.9s; at 8k testcase rows it is well past the 30s statement_timeout
     * and the endpoint answered 500. The shipped shape is a hash anti-join (~0.5s here).
     *
     * The budget is a regression tripwire, not a benchmark: ~10x the fixed latency over a hosted
     * database, and far below the quadratic plan's time at this volume.
     */
    test.setTimeout(120_000);
    seedBulkTestcaseAudit(8000);

    const t0 = Date.now();
    const page = await feed({ limit: 10 });
    const feedMs = Date.now() - t0;
    expect(page.list.length, "limit=10 must return 10 entries").toBe(10);
    expect(page.total, "total counts every seeded row").toBeGreaterThanOrEqual(8000);
    expect(feedMs, `GET /activity?limit=10 took ${feedMs}ms with 8000 testcase audit rows`).toBeLessThan(8000);

    const s0 = Date.now();
    const res = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/activity/summary`, { failOnStatusCode: false });
    const summaryMs = Date.now() - s0;
    expect(res.status(), `summary — ${await res.text()}`).toBe(200);
    expect((await res.json()).weekly.total, "summary sees the 7-day rows").toBeGreaterThanOrEqual(8000);
    expect(summaryMs, `GET /activity/summary took ${summaryMs}ms with 8000 testcase audit rows`).toBeLessThan(8000);

    // The workspace rollup shares the same SQL builder.
    const w0 = Date.now();
    const ws = await workspaceFeed({ limit: 10 });
    expect(Date.now() - w0, "GET /workspace/activity at volume").toBeLessThan(8000);
    expect(ws.list).toHaveLength(10);

    // Paging deep into the set still works and stays bounded.
    const deep = await feed({ limit: 100, offset: 7000 });
    expect(deep.list.length, "a deep page is a full page").toBe(100);
  });

  test("ACT-A-20 a testcase_* row is dropped only for a zyra_* sibling on the same entity within 5 seconds", async () => {
    /*
     * Pins the de-duplication semantics the performance rewrite must not change. Rows are inserted
     * directly with chosen created_at values, so the 5s window is exact rather than racy.
     */
    const tag = stamp("Dedup");
    const proj = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    const owner = literal(tenant!.owner.userId);
    const base = `now() - interval '2 hours'`;
    // [entity suffix, action, actor SQL, seconds after base, entity type]
    const rows: [string, string, string, number, string][] = [
      // E1: zyra 2s after the testcase row -> the plain row is dropped, the zyra row stays.
      ["e1", "testcase_updated", owner, 0, "testcase"],
      ["e1", "zyra_updated", "NULL", 2, "testcase"],
      // E2: zyra 6s away -> outside the window, both stay.
      ["e2", "testcase_updated", owner, 0, "testcase"],
      ["e2", "zyra_updated", "NULL", 6, "testcase"],
      // E3: no zyra sibling at all -> stays.
      ["e3", "testcase_created", owner, 0, "testcase"],
      // E4: sibling is hidden by the actor filter below, but must still de-duplicate.
      ["e4", "testcase_created", owner, 0, "testcase"],
      ["e4", "zyra_created", "NULL", 1, "testcase"],
      // E5: not a testcase_* action -> never dropped, even with a zyra sibling in the window.
      ["e5", "suite_renamed", owner, 0, "suite"],
      ["e5", "zyra_created", "NULL", 1, "testcase"],
      // E6: two zyra siblings in the window -> one drop, and no duplicated rows from the join.
      ["e6", "testcase_created", owner, 0, "testcase"],
      ["e6", "zyra_created", "NULL", 1, "testcase"],
      ["e6", "zyra_updated", "NULL", 2, "testcase"],
      // E7: a zyra row for a DIFFERENT entity in the window does not suppress this one.
      ["e7", "testcase_created", owner, 0, "testcase"],
      ["e8", "zyra_created", "NULL", 0, "testcase"],
      // E9: zyra sibling BEFORE the testcase row (abs window, both directions).
      ["e9", "zyra_archived", "NULL", 0, "testcase"],
      ["e9", "testcase_updated", owner, 3, "testcase"],
    ];
    exec(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, entity_name, project_id, organization_id, created_at) VALUES ` +
        rows
          .map(
            ([e, action, actor, secs, type]) =>
              `(${actor}, ${literal(action)}, ${literal(type)}, ${literal(`${tag}-${e}`)}, ${literal(`${tag}-${e}`)}, ${proj}, ${org}, ${base} + interval '${secs} seconds')`,
          )
          .join(", ") +
        ";",
    );

    const seen = async (extra: Record<string, string | number> = {}) =>
      (await feed({ search: tag, limit: 100, ...extra })).list.map((i) => `${i.entityName!.slice(tag.length + 1)}:${i.action}`).sort();

    expect(await seen()).toEqual(
      [
        "e1:zyra_updated",
        "e2:testcase_updated",
        "e2:zyra_updated",
        "e3:testcase_created",
        "e4:zyra_created", // e4's testcase_created is dropped
        "e5:suite_renamed",
        "e5:zyra_created",
        "e6:zyra_created",
        "e6:zyra_updated", // exactly one drop for e6, each zyra row once
        "e7:testcase_created",
        "e8:zyra_created",
        "e9:zyra_archived", // e9's testcase_updated is dropped
      ].sort(),
    );

    // The sibling is hidden by this filter (its actor is NULL), yet e4's plain row is still dropped:
    // de-duplication looks at the unfiltered event set, not at what the filter lets through.
    const mine = await seen({ actorId: tenant!.owner.userId });
    expect(mine, "e4's testcase_created must stay dropped when its zyra sibling is filtered out").not.toContain("e4:testcase_created");
    expect(mine).toContain("e3:testcase_created");

    // total agrees with the rows returned, so COUNT and the list use the same de-duplication.
    const all = await feed({ search: tag, limit: 100 });
    expect(all.total).toBe(all.list.length);

    // The workspace rollup de-duplicates identically.
    const ws = (await workspaceFeed({ search: tag, limit: 100 })).list.map((i) => `${i.entityName!.slice(tag.length + 1)}:${i.action}`).sort();
    expect(ws).toEqual(await seen());
  });

  // ─── Paging at the seams: the page query reads only the newest offset+limit rows of each source ───

  type SeedRow = [suffix: string, action: string, actorId: string | null, createdAtSql: string, entityType: string];

  /** Inserts audit rows at chosen instants; every row is named `${tag}-${suffix}`. */
  function seedAudit(tag: string, rows: SeedRow[]): void {
    const proj = literal(tenant!.mainProjectId);
    const org = literal(tenant!.organizationId);
    exec(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, entity_name, project_id, organization_id, created_at) VALUES ` +
        rows
          .map(
            ([e, action, actor, at, type]) =>
              `(${actor ? literal(actor) : "NULL"}, ${literal(action)}, ${literal(type)}, ${literal(`${tag}-${e}`)}, ${literal(`${tag}-${e}`)}, ${proj}, ${org}, ${at})`,
          )
          .join(", ") +
        ";",
    );
  }

  test("ACT-A-21 walking the feed page by page returns every row exactly once, across sources and timestamp ties", async () => {
    /*
     * The feed is read newest-first from several sources (audit rows, and rows derived from suites,
     * plans, runs and bugs), and each page only reads the newest offset+limit rows of each source. A
     * page boundary that lands between sources, or inside a group of rows sharing one timestamp (a bulk
     * action writes many rows in one transaction, so they tie), must neither repeat nor skip a row.
     */
    const tag = stamp("PageWalk");
    const owner = tenant!.owner.userId;
    const tie = `now() - interval '3 hours'`;
    // Seven audit rows at the SAME instant, two older ones, and three derived suite rows that are newer.
    seedAudit(tag, [
      ...["a", "b", "c", "d", "e", "f", "g"].map((e): SeedRow => [e, "testcase_created", owner, tie, "testcase"]),
      ["old1", "testcase_updated", owner, `now() - interval '5 hours'`, "testcase"],
      ["old2", "testcase_updated", owner, `now() - interval '6 hours'`, "testcase"],
    ]);
    for (let i = 0; i < 3; i++) await createSuite(`${tag} suite ${i}`);

    const readers: [string, (p: Record<string, string | number>) => Promise<{ list: ActivityItem[]; total: number }>][] = [
      ["project", (p) => feed({ search: tag, ...p })],
      ["workspace", (p) => workspaceFeed({ search: tag, ...p })],
    ];
    for (const [label, read] of readers) {
      const all = await read({ limit: 100 });
      expect(all.list, `${label}: every seeded and derived row is in the full read`).toHaveLength(12);
      expect(all.total, `${label}: total counts them all`).toBe(12);

      for (const size of [1, 2, 3, 5]) {
        const walked: string[] = [];
        for (let offset = 0; offset < 14; offset += size) {
          const page = await read({ limit: size, offset });
          expect(page.total, `${label}: total is the same on every page`).toBe(12);
          walked.push(...page.list.map((i) => i.id));
        }
        expect(walked, `${label}: page size ${size} walked the feed in a different order, or lost or repeated rows`).toEqual(
          all.list.map((i) => i.id),
        );
      }
    }
  });

  test("ACT-A-22 total is exact under de-duplication and every filter, and agrees with the rows", async () => {
    const tag = stamp("TotalExact");
    const owner = tenant!.owner.userId;
    const base = `now() - interval '2 hours'`;
    seedAudit(tag, [
      // e1: the plain row has a zyra sibling 2s later -> dropped, the zyra row stays (actor NULL).
      ["e1", "testcase_updated", owner, base, "testcase"],
      ["e1", "zyra_updated", null, `${base} + interval '2 seconds'`, "testcase"],
      // e2: nothing nearby -> stays.
      ["e2", "testcase_created", owner, base, "testcase"],
      // e3: a zyra row alone.
      ["e3", "zyra_created", null, base, "testcase"],
    ]);
    const names = (r: { list: ActivityItem[] }) =>
      r.list.map((i) => `${i.entityName!.slice(tag.length + 1)}:${i.action}`).sort();

    const all3 = ["e1:zyra_updated", "e2:testcase_created", "e3:zyra_created"];
    const cases: [string, Record<string, string | number>, string[]][] = [
      ["no filter", {}, all3],
      ["entityType", { entityType: "testcase" }, all3],
      ["entityType that matches nothing", { entityType: "bug" }, []],
      // e1's plain row is dropped even though its sibling (actor NULL) is hidden by this filter.
      ["actorId", { actorId: owner }, ["e2:testcase_created"]],
      ["since in the future", { since: new Date(Date.now() + 3_600_000).toISOString() }, []],
      ["since before the rows", { since: new Date(Date.now() - 3 * 3_600_000).toISOString() }, all3],
    ];
    for (const [label, params, expected] of cases) {
      const res = await feed({ search: tag, limit: 100, ...params });
      expect(names(res), label).toEqual(expected);
      expect(res.total, `${label}: total must equal the rows the filter lets through`).toBe(expected.length);
    }
  });

  test("ACT-A-23 paging parameters at the edges answer a well-formed page, never an error", async () => {
    const tag = stamp("PagingEdges");
    seedAudit(tag, [
      ["a", "testcase_created", tenant!.owner.userId, `now() - interval '1 hour'`, "testcase"],
      ["b", "testcase_created", tenant!.owner.userId, `now() - interval '2 hours'`, "testcase"],
    ]);

    // limit=0 is a valid "just the total" read.
    const none = await feed({ search: tag, limit: 0 });
    expect(none.list).toEqual([]);
    expect(none.total).toBe(2);

    // Past the end, and absurdly far past it: empty, with the real total.
    for (const offset of [2, 50, 9007199254740991]) {
      const past = await feed({ search: tag, limit: 10, offset });
      expect(past.list, `offset ${offset}`).toEqual([]);
      expect(past.total, `offset ${offset}`).toBe(2);
    }

    // An oversized limit is capped, not rejected and not honoured.
    const capped = await feed({ limit: 100000 });
    expect(capped.list.length).toBeLessThanOrEqual(100);

    // An entity's own history (Bug Details) pages through the same query.
    const entity = await feed({ entityId: `${tag}-a`, limit: 10 });
    expect(entity.list.map((i) => i.entityId)).toEqual([`${tag}-a`]);
    expect(entity.total).toBe(1);
  });

  test("ACT-A-24 the three requests the Activity screen makes at once all answer within the page-load budget", async () => {
    /*
     * The screen fires the dashboard's limit=10 feed, its own limit=30 feed and the summary together.
     * Each used to read the project's whole history, so together they saturated the connection pool and
     * timed out for a large project. The wall time of all three at once is what a person waits for.
     */
    test.setTimeout(120_000);
    seedBulkTestcaseAudit(8000);

    const url = `/api/projects/${tenant!.mainProjectId}/activity`;
    const t0 = Date.now();
    const [dash, page, summary] = await Promise.all([
      asOwner.get(url, { params: { limit: 10 }, failOnStatusCode: false }),
      asOwner.get(url, { params: { limit: 30, offset: 0 }, failOnStatusCode: false }),
      asOwner.get(`${url}/summary`, { failOnStatusCode: false }),
    ]);
    const wall = Date.now() - t0;

    expect(dash.status(), await dash.text()).toBe(200);
    expect(page.status(), await page.text()).toBe(200);
    expect(summary.status(), await summary.text()).toBe(200);
    expect((await page.json()).list).toHaveLength(30);
    expect(wall, `the Activity screen's three requests took ${wall}ms together with 8000 testcase audit rows`).toBeLessThan(5000);
  });

  test("ACT-A-25 workspace-level events (no project) reach the workspace feed and its total, and never a project feed", async () => {
    /*
     * Invites and membership changes are audit rows with project_id NULL. The workspace feed reads them
     * through its own branch (the project feed has none), which is also the branch that has to find them
     * without reading every tenant's history. They must page and count like any other row.
     */
    const tag = stamp("OrgEvents");
    const owner = tenant!.owner.userId;
    const org = literal(tenant!.organizationId);
    exec(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, entity_name, project_id, organization_id, created_at) VALUES ` +
        ["a", "b", "c"]
          .map(
            (e, i) =>
              `(${literal(owner)}, 'member_invited', 'invitation', ${literal(`${tag}-${e}`)}, ${literal(`${tag}-${e}`)}, NULL, ${org}, now() - interval '${i + 1} hours')`,
          )
          .join(", ") +
        ";",
    );

    const all = await workspaceFeed({ search: tag, limit: 100 });
    expect(all.list.map((i) => i.entityName).sort(), "all three workspace-level rows are in the workspace feed").toEqual(
      [`${tag}-a`, `${tag}-b`, `${tag}-c`],
    );
    expect(all.total).toBe(3);
    expect(all.list.every((i) => !i.entityType || i.entityType === "invitation")).toBe(true);

    // Paged one at a time they come back newest first, each once.
    const walked: string[] = [];
    for (let offset = 0; offset < 4; offset++) {
      const page = await workspaceFeed({ search: tag, limit: 1, offset });
      expect(page.total).toBe(3);
      walked.push(...page.list.map((i) => i.entityName!));
    }
    expect(walked).toEqual([`${tag}-a`, `${tag}-b`, `${tag}-c`]);

    // A project feed has no such branch: these rows must not leak into it.
    const project = await feed({ search: tag, limit: 100 });
    expect(project.list, "a workspace-level event leaked into a project feed").toEqual([]);
    expect(project.total).toBe(0);
  });

  test("ACT-A-26 the workspace Activity screen's two requests answer within the page-load budget at volume", async () => {
    test.setTimeout(120_000);
    seedBulkTestcaseAudit(8000);

    const t0 = Date.now();
    const [feedRes, summaryRes] = await Promise.all([
      asOwner.get("/api/workspace/activity", { params: { limit: 30, offset: 0 }, failOnStatusCode: false }),
      asOwner.get("/api/workspace/activity/summary", { failOnStatusCode: false }),
    ]);
    const wall = Date.now() - t0;

    expect(feedRes.status(), await feedRes.text()).toBe(200);
    expect(summaryRes.status(), await summaryRes.text()).toBe(200);
    expect((await feedRes.json()).list).toHaveLength(30);
    expect(wall, `the workspace Activity screen's requests took ${wall}ms together with 8000 testcase audit rows`).toBeLessThan(5000);
  });
});
