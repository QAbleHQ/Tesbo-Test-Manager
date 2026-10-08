import { IntegrationSyncModule } from "./integration-sync.module";
import {
  INTEGRATION_SYNC_NIGHTLY_JIRA_JOB,
  INTEGRATION_SYNC_NIGHTLY_LINEAR_JOB,
  INTEGRATION_SYNC_NIGHTLY_NOTION_JOB,
  INTEGRATION_SYNC_WATCHDOG_JOB,
  NIGHTLY_SYNC_CRON,
  NIGHTLY_SYNC_TZ
} from "./integration-sync.constants";

describe("IntegrationSyncModule#onModuleInit — scheduler registration", () => {
  function boot(upsert: jest.Mock) {
    const sync = { failInterruptedRuns: jest.fn().mockResolvedValue(undefined) };
    return new IntegrationSyncModule(sync as never, { upsertJobScheduler: upsert } as never).onModuleInit();
  }

  it("registers Jira, Linear and Notion on the same nightly cron/tz, each with its own scheduler id", async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    await boot(upsert);
    const nightly = upsert.mock.calls.filter(([, repeat]) => repeat.pattern === NIGHTLY_SYNC_CRON);
    expect(nightly.map(([, repeat]) => repeat.tz)).toEqual([NIGHTLY_SYNC_TZ, NIGHTLY_SYNC_TZ, NIGHTLY_SYNC_TZ]);
    expect(nightly.map(([, , tpl]) => tpl.name)).toEqual([
      INTEGRATION_SYNC_NIGHTLY_JIRA_JOB,
      INTEGRATION_SYNC_NIGHTLY_LINEAR_JOB,
      INTEGRATION_SYNC_NIGHTLY_NOTION_JOB
    ]);
    expect(new Set(nightly.map(([id]) => id)).size).toBe(3);
    expect(upsert.mock.calls.some(([, , tpl]) => tpl.name === INTEGRATION_SYNC_WATCHDOG_JOB)).toBe(true);
  });

  it("a Redis failure registering one scheduler never blocks the others or boot", async () => {
    const upsert = jest.fn().mockRejectedValueOnce(new Error("redis down")).mockResolvedValue(undefined);
    await expect(boot(upsert)).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(4);
  });
});
