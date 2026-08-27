import path from "node:path";
import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
import { readConfigFile } from "@tesbox/playwright-reporter";
import { env, loadedEnvironment } from "./utils/env";

/*
 * tesbo.config.json, read once here for the same reason the reporter reads it: it is the lowest
 * rung of the reporter's precedence chain (inline options, then environment, then this file), so
 * the inline options below have to know whether it supplies a value before they hardcode one.
 *
 * __dirname rather than the reporter's process.cwd() default: `npx playwright test` is always run
 * from e2e/ today, but a run launched from the repo root would otherwise resolve a different file
 * here than the reporter resolves at onBegin, and the two disagreeing is precisely the silent
 * misconfiguration this block exists to prevent.
 */
const tesboFileConfig = readConfigFile(__dirname);

/*
 * Which environment this run is aimed at, printed before the first test.
 *
 * Selected with E2E_ENV (see utils/env-file.ts); `local` when nothing is given. The banner is here
 * rather than in global-setup so it also prints for `--list`, and because the failure it exists to
 * prevent happens *before* global-setup gets far enough to say anything useful: a run that silently
 * defaulted to the wrong host reported "Provisioned <user> but the follow-up password login still
 * failed", forty lines of stack, and no mention anywhere of the URL it had been talking to.
 *
 * Printed once — TEST_WORKER_INDEX is set in workers, which re-import this config.
 */
if (process.env.TEST_WORKER_INDEX === undefined) {
  const loaded = loadedEnvironment();
  const db = env.dbUrl
    ? "configured — SQL-fixture specs will run and WRITE to it"
    : "not configured — SQL-fixture specs will skip themselves";
  process.stdout.write(
    [
      `e2e environment: ${loaded.name ?? "(none — built-in defaults)"}` +
        `${loaded.file ? ` — ${path.relative(__dirname, loaded.file)}` : ""}` +
        `${loaded.explicit ? "" : " [default; set E2E_ENV to change]"}`,
      `  api:      ${env.apiBaseUrl}`,
      `  web:      ${env.webBaseUrl}`,
      `  account:  ${env.testEmail}`,
      `  database: ${db}`,
      `  provision: ${env.autoProvision ? "on — tenants are created as needed" : "off — tenants must already exist"}`,
      "",
    ].join("\n"),
  );
}

export default defineConfig({
  testDir: __dirname,
  testMatch: /(api|ui)\/.*\.spec\.ts/,
  /*
   * 30s was right when the stack's database was the compose postgres container. It is not right for
   * a stack pointed at a hosted Postgres: a single round trip costs tens of milliseconds instead of
   * a fraction of one, and provisionRbacTenant — which creates an org, three users, two projects and
   * their memberships before a suite can start — measures ~57s against this stack's Neon instance.
   * That overran the 30s budget in the `beforeAll` of all 22 suites that own a tenant, so they
   * failed to start rather than failing an assertion.
   *
   * This is the harness's setup budget, not a product-timing assertion, and no assertion below is
   * relaxed by it. Where the product's own speed is the thing under test, the bound is written into
   * the test and left tight — see execution-ops.spec.ts EXO-E-01, which still holds a 250-case add
   * to 30s because that is the ceiling the 524 came from.
   */
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: env.ci ? 1 : 0,
  /*
   * This suite reports its own results back into Tesbo — the product it tests.
   *
   * baseUrl and projectId live here rather than in the environment on purpose: neither is a secret,
   * and a self-hosted install has to carry its own API host in version control anyway. The
   * credential does not — the token comes from TESBO_API_TOKEN or from the gitignored
   * e2e/tesbo.config.json, and is never committed.
   *
   * baseUrl is the **API** host (:1021 for this stack, not the frontend's :1020). Pointing it at the
   * web app fails silently: every ingest call 404s, the reporter logs rather than throws, and the
   * run stays green with nothing recorded.
   *
   * With none of the three values set the reporter warns once and stays out of the way, so a
   * checkout with no token still runs an ordinary suite. Setting *some* of them is a hard failure at
   * collection time, because a run that quietly reported nothing looks exactly like one that
   * succeeded.
   *
   * All three may also come from e2e/tesbo.config.json, which is what `npx @tesbox/playwright-reporter
   * init` writes. It is the lowest rung of the precedence chain, so anything set here inline or in
   * the environment still wins — see the comments on each value below, which is where forgetting
   * that has actually bitten.
   */
  reporter: [
    ["list"],
    ...(env.ci ? [["html", { open: "never" }] as ReporterDescription] : []),
    [
      "@tesbox/playwright-reporter",
      {
        /*
         * Deliberately NOT env.apiBaseUrl. This is where results are *reported to*, which is not
         * the same question as which deployment is *under test* — an E2E_ENV=stage run still wants
         * its results in the local instance unless someone says otherwise, and pointing it at stage
         * with a projectId that only exists locally would 404 every ingest call silently.
         *
         * The `? undefined :` is load-bearing, not defensive. Inline options are the *top* of the
         * reporter's precedence chain, so a value written here unconditionally can never be
         * overridden by tesbo.config.json — which is the whole file's purpose. A hardcoded
         * localhost:1021 meant a stage run whose tesbo.config.json named the stage API still
         * reported to the local instance, or to nothing at all when it was not running. So each
         * value is supplied here only when nothing further down the chain supplies one; the
         * localhost default still applies to a checkout with no tesbo.config.json, unchanged.
         */
        baseUrl:
          process.env.TESBO_REPORTER_BASE_URL ??
          (tesboFileConfig.values.baseUrl ? undefined : "http://localhost:1021"),
        projectId:
          process.env.TESBO_REPORTER_PROJECT_ID ??
          (tesboFileConfig.values.projectId
            ? undefined
            : "41dba2a2-a60b-4917-8d63-9f8a86986703"),
        environment: process.env.TESBO_REPORTER_ENVIRONMENT ?? env.environment ?? "staging",
        /*
         * Why this gate is not optional.
         *
         * Committing two of the three values puts the reporter in its `incomplete` state whenever
         * the token is absent, and `incomplete` throws in onBegin — by design, because somebody who
         * configured two of three meant to report, and silently reporting nothing would hide the
         * typo. That is the right default for a suite whose config lives entirely in the
         * environment; here it would mean every token-less run of this suite dies before its first
         * test, which is not a price a local `scripts/e2e-run.sh` should pay.
         *
         * So: off locally when there is no token — the run behaves exactly as it did before this
         * reporter existed — and deliberately still on in CI, where a missing credential is a
         * misconfiguration that has to be loud rather than quietly unreported.
         *
         * A token in tesbo.config.json counts. It did not, and that cost a whole stage run: on
         * 2026-08-27 a 95-test stage run reported nothing at all, because the gate consulted only
         * process.env while the token that `init` had written sat in e2e/tesbo.config.json — and
         * environments/stage.env ships TESBO_API_TOKEN= empty on purpose, so the env var could
         * never satisfy it. The reporter printed not one line, because a disabled reporter returns
         * from onBegin before it resolves any configuration.
         *
         * `error` is here for the same reason `incomplete` throws: a tesbo.config.json that exists
         * but cannot be parsed must reach the reporter so it can say so, rather than being filtered
         * out by a gate that reads only its values.
         */
        enabled:
          Boolean(process.env.TESBO_API_TOKEN?.trim()) ||
          Boolean(tesboFileConfig.values.token) ||
          Boolean(tesboFileConfig.error) ||
          env.ci,
      },
    ],
  ],
  globalSetup: require.resolve("./global-setup"),
  use: {
    storageState: path.join(__dirname, ".auth/state.json"),
  },
  projects: [
    {
      name: "api",
      testMatch: /api\/.*\.spec\.ts/,
      use: { baseURL: env.apiBaseUrl },
    },
    {
      name: "ui",
      testMatch: /ui\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: env.webBaseUrl,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
      },
    },
  ],
});
