import { IntegrationSyncService } from "./integration-sync.service";

/*
 * Which sync runs announce themselves, and to whom: a run someone started by hand reports to them; a
 * nightly run has no one waiting, so only a failure is announced (to the workspace owners); a
 * partial run is neither of the two matrix messages and stays silent.
 */

const ORG = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-0000000000a2";

function makeService(updateRow: Record<string, unknown> | null) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("UPDATE integration_sync_runs")) return { rows: updateRow ? [updateRow] : [], rowCount: updateRow ? 1 : 0 };
    // Checked before the owners lookup: the insert's own membership clause also mentions organization_members.
    if (sql.includes("INSERT INTO notifications")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "n" }], rowCount: 1 };
    }
    if (sql.includes("FROM organization_members")) return { rows: [{ user_id: OWNER }], rowCount: 1 };
    if (sql.includes("FROM projects")) return { rows: [{ name: "Project 1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const svc = new IntegrationSyncService({} as never, { query } as never, {} as never);
  return { svc, inserts };
}

const PROJECT = "00000000-0000-4000-8000-000000000001";
const run = (over: Record<string, unknown>) => ({ id: "run-1", provider: "jira", organization_id: ORG, project_id: PROJECT, triggered_by: USER, trigger_source: "manual", status: "succeeded", ...over });

describe("sync run notifications", () => {
  it("tells the user who started a manual run that it completed", async () => {
    const { svc, inserts } = makeService(run({}));
    await svc.finishRun("run-1", null);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toEqual([USER]);
    expect(inserts[0].params[1]).toBe("integration_sync_completed");
    expect(inserts[0].params[2]).toBe("Jira sync completed successfully for Project 1.");
    // Opens that project's own Jira integration page.
    expect(inserts[0].params[3]).toBe("project_integration");
    expect(inserts[0].params[4]).toBe(`${PROJECT}:jira`);
    expect(inserts[0].params[5]).toBe("sync_completed:run-1");
  });

  it("does not announce a nightly run that succeeded", async () => {
    const { svc, inserts } = makeService(run({ trigger_source: "nightly", triggered_by: null }));
    await svc.finishRun("run-1", null);
    expect(inserts).toHaveLength(0);
  });

  it("does not announce a partial run", async () => {
    const { svc, inserts } = makeService(run({ status: "partial" }));
    await svc.finishRun("run-1", null);
    expect(inserts).toHaveLength(0);
  });

  it("tells a manual run's starter that it failed", async () => {
    const { svc, inserts } = makeService(run({ provider: "linear" }));
    await svc.failRun("run-1", "boom");
    expect(inserts[0].params[0]).toEqual([USER]);
    expect(inserts[0].params[1]).toBe("integration_sync_failed");
    expect(inserts[0].params[2]).toBe("Linear sync failed for Project 1. Please review the connection.");
    expect(inserts[0].params[4]).toBe(`${PROJECT}:linear`);
  });

  it("tells the workspace owners when a nightly run fails", async () => {
    const { svc, inserts } = makeService(run({ provider: "notion", trigger_source: "nightly", triggered_by: null }));
    await svc.failRun("run-1", "boom");
    expect(inserts[0].params[0]).toEqual([OWNER]);
    expect(inserts[0].params[2]).toBe("Notion sync failed for Project 1. Please review the connection.");
    expect(inserts[0].params[4]).toBe(`${PROJECT}:notion`);
  });

  it("says nothing for a run that was already settled (the update matched no row)", async () => {
    const { svc, inserts } = makeService(null);
    await svc.failRun("run-1", "boom");
    await svc.finishRun("run-1", null);
    expect(inserts).toHaveLength(0);
  });
});
