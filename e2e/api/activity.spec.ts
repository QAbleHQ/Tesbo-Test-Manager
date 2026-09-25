import { expect, test, type APIRequestContext } from "@playwright/test";
import { exec, execAllowingAuditImmutability, literal } from "../utils/psql";
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
});
