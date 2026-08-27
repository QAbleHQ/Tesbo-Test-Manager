# Report Playwright results into Tesbo

`@tesbox/playwright-reporter` is a Playwright reporter. You add it to your own Playwright project,
tag each test with the Tesbo test case it validates, and every run posts its results back into
Tesbo — as one Test Run (Cycle) containing those cases, with pass/fail, duration, error text and
failure evidence.

Nothing about your suite changes except the reporter list and the tags. Your tests still run exactly
as they did, and a Tesbo outage cannot fail them — see
[It will not break your pipeline](#it-will-not-break-your-pipeline).

---

## What happens on a run

| When | What the reporter does |
| --- | --- |
| Before the first test | Collects every `@tesbo.testId(...)` tag, checks the ids exist in your project, and opens **one** Test Run with those cases attached |
| As each test finishes | Posts that result — status, duration, retry count, and on failure the error message and stack |
| On a failure | Uploads Playwright's screenshots, video and trace as evidence on that case |
| At the end | Closes the run with a summary, and prints any disagreement between what it sent and what Tesbo stored |

One run per `playwright test` invocation — never one per test.

Automation **reports results only.** It never creates or approves a test case. A tag pointing at a
case that does not exist is reported as an error rather than helpfully creating one, because your QA
engineers own the repository.

---

## Before you start

You need:

- **Node.js 20** or newer, and **Playwright 1.42** or newer (it is a peer dependency).
- **A Tesbo project** with the test cases you want to report against already created.
- **Each case's ID** as shown in Tesbo — e.g. `TES-1042`. This is the linking key, not an internal
  UUID.
- **A project API token** with the `read` and `write` scopes, from
  **Project → Settings → API & MCP**. It is scoped to one project: a token issued for project A
  cannot report into project B.

---

## Step 1 — Install

In your Playwright project:

```bash
npm install --save-dev @tesbox/playwright-reporter
```

## Step 2 — Collect your three values

All three live under **Project → Settings → API & MCP** in Tesbo:

| Value | Environment variable | Notes |
| --- | --- | --- |
| API host | `TESBO_BASE_URL` | e.g. `https://api-app.tesbo.io`. **No default** |
| Project ID | `TESBO_PROJECT_ID` | The project UUID results are reported into |
| API token | `TESBO_API_TOKEN` | Starts `tsbo_`; needs `read` and `write` |

> **The single most common setup mistake.** `TESBO_BASE_URL` is your **API** host, not the web app
> host. Tesbo serves them separately and the app host has no `/api` route, so pointing at the app
> makes every call 404 — and because the reporter never breaks your suite, the run stays green with
> no results in Tesbo. There is deliberately no default for this reason. `doctor` detects it and
> names the host you probably want.

**Shortcut:** paste the MCP URL from that same settings page
(`https://…/api/projects/<uuid>/mcp`) as `TESBO_BASE_URL`. It is trimmed to the origin and the
project UUID is read out of it, so one paste configures two of the three values.

## Step 3 — Verify the values before wiring anything up

```bash
npx @tesbox/playwright-reporter init
```

`init` asks for all three values, checks they actually work together, and writes them to
**`tesbo.config.json`** in the current directory:

```json
{
  "baseUrl": "https://api-app.tesbo.io",
  "projectId": "41dba2a2-a60b-4917-8d63-9f8a86986703"
}
```

Re-run `init` any time to change the server or project — it rewrites that file in place, so there is
nothing to re-paste and no second reporter entry appended to your config.

**Where the token goes is your choice.** By default it stays out of the file and `init` offers to put
it in `.env` instead. It can go in `tesbo.config.json` too — reasonable for a private repository — and
`init` will say plainly whether that file is gitignored before it writes a credential into it. A token
in a tracked file remains in git history after you rotate it, so the default is the environment.

Add `tesbo.config.json` to `.gitignore` if you choose to keep the token in it.

To check an existing setup instead — including in CI, where it prompts for nothing and just reports:

```bash
npx @tesbox/playwright-reporter doctor
```

| Exit code | Meaning |
| --- | --- |
| `0` | Reachable, token valid, scoped to this project |
| `1` | Verification failed — the reason and a hint are printed |
| `2` | Not configured, or configured incompletely |

Both commands only ever **read**, so they are safe to run against production. The probe confirms the
`read` scope; `write` can only be confirmed by an actual run, because a write probe would leave an
undeletable empty run behind in your project.

> **Why a CLI and not a prompt at run time.** A Playwright reporter runs inside a non-interactive
> test process, usually on a CI runner with no TTY. A prompt there does not ask anyone anything — it
> hangs the job until it times out. So the reporter fails fast and says what is missing, and the
> asking happens in a command a human runs.

## Step 4 — Register the reporter

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@tesbox/playwright-reporter', {
      // Not secrets — commit them. A self-hosted install needs its own baseUrl in version control.
      baseUrl: 'https://api-app.tesbo.io',
      projectId: '<your-project-uuid>',
      environment: 'staging',
      // The token is a secret: leave it in TESBO_API_TOKEN, never in this file.
    }],
  ],
});
```

Keep `['list']` (or whichever reporter you already use). The Tesbo reporter adds to your reporter
list; it does not replace your console output.

If you ran `init`, the values are already in `tesbo.config.json` and this is all you need:

```ts
  reporter: [
    ['list'],
    ['@tesbox/playwright-reporter'],
  ]
```

That makes `playwright.config.ts` a one-time edit — later changes go to the JSON file, not here.

### Where each value can come from

Highest precedence first. The file is last on purpose: a CI runner's secret must beat a value someone
committed months ago.

| Source | Example |
| --- | --- |
| Inline reporter options | `['@tesbox/playwright-reporter', { baseUrl: '…' }]` |
| Environment variables | `TESBO_BASE_URL`, `TESBO_PROJECT_ID`, `TESBO_API_TOKEN` |
| `tesbo.config.json` | `{ "baseUrl": "…", "projectId": "…", "token": "…" }` |

A malformed `tesbo.config.json` is a hard failure at collection time, not a silent fallback to
"unconfigured" — whoever wrote the file meant to report.

## Step 5 — Tag each test with the case it validates

```ts
import { test, expect } from '@playwright/test';

test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
});
```

`TES-1042` is the test case's ID as shown in Tesbo.

> **Note the leading `@`.** Playwright validates every tag against `^@` and throws
> `Tag must start with "@" symbol` at collection time otherwise — so the unprefixed
> `tesbo.testId("TES-1042")` will not load your suite at all. With the `@`, the marker is
> character-for-character the same as the pytest decorator and the JUnit annotation.

An annotation works too, for ids computed at runtime:

```ts
test('...', { annotation: { type: 'tesbo', description: caseId } }, async () => {});
```

A test may declare **exactly one** case id. Two is reported as an error rather than resolved by a
coin flip, because the alternative is a result silently attached to the wrong case.

### Untagged tests

By default they are **skipped and counted**, and the run summary says `N test(s) not linked to
Tesbo`. Adopting the reporter on an existing suite does not turn it red. Set `strict: true` to fail
at collection time instead — on an untagged test, an unreadable marker, or an id that does not exist
in your project.

## Step 6 — Run it, and check what it says

```bash
TESBO_API_TOKEN=tsbo_… npx playwright test
```

The reporter prints its own lines alongside your usual output:

```
[tesbo] reporting 14 linked test(s) to run 8f2c… 
[tesbo] run 8f2c… closed (completed): 12 passed, 2 failed, 0 skipped
[tesbo] 3 test(s) not linked to Tesbo (no @tesbo.testId("<CASE_ID>") tag).
```

Then open **Project → Cycles (Test Runs)** in Tesbo. Your run is there, containing the tagged cases
with their results; open a failed case to see the error message and its evidence.

**Read those `[tesbo]` lines.** Because the reporter cannot fail your suite, they are the only place
a problem is visible — a lost request, an unknown case id, or a storage quota that dropped evidence.

---

## What you have to add — the complete list

**Nothing inside your test code beyond the tag.** There is no import, no fixture, no `await`, no
flush call, and no global setup or teardown. The reporter reads Playwright's own `tags` and
`annotations`, and everything else — opening the run, posting each result live, retrying transient
failures, draining in-flight requests and closing the run — happens in reporter lifecycle hooks that
Playwright calls itself.

So the whole footprint in a project is:

| Where | What | Required? |
| --- | --- | --- |
| `playwright.config.ts` | the reporter entry | **Yes** |
| `tesbo.config.json`, env vars, or inline options | the three values | **Yes** |
| each spec | `{ tag: '@tesbo.testId("TES-1042")' }` | **Yes**, per test you want reported |
| `playwright.config.ts` → `use` | `screenshot` / `video` / `trace` capture | Only if you want evidence |

### Evidence needs Playwright's capture turned on

This is the one that catches people out. The reporter uploads the attachments **Playwright produces**
— it does not capture anything itself. If your config has capture off, a failed test reports its
status and error message with no screenshot, video or trace, and nothing is broken.

```ts
export default defineConfig({
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  reporter: [['list'], ['@tesbox/playwright-reporter']],
});
```

### Your own attachments need a file on disk

`testInfo.attach()` with a `body` is skipped — there is no file to read. Use `path`:

```ts
// uploaded
await testInfo.attach('response', { path: '/tmp/response.json', contentType: 'application/json' });

// ignored — an inline body has no file on disk
await testInfo.attach('response', { body: JSON.stringify(data), contentType: 'application/json' });
```

Recognised by extension only: `png`/`jpg`/`jpeg`/`webp` → screenshot, `mp4`/`webm`/`mov` → video,
`zip` → trace, `txt`/`log`/`json`/`md`/`xml` → log. Anything else is skipped silently.

### Nothing to do for parallelism, retries or sharding

- **Workers and `fullyParallel`** need no configuration. Each result posts as its test finishes,
  without blocking the next one.
- **`retries`** works as it is: a retried test re-posts, the last attempt stands, and `retryCount`
  records how many there were.
- **Sharding** converges on a single run automatically on GitHub Actions, GitLab CI, Jenkins,
  CircleCI, Azure Pipelines and Bitbucket Pipelines, because the shards derive a shared idempotency
  key from the CI environment. **On any other CI provider each shard opens its own run**, and there is
  currently no option to supply that key yourself — so if you shard on an unsupported provider,
  expect one run per shard.

### Nothing is written to disk

Results are held only as pending requests in memory, never spooled to a file. `Ctrl-C` still closes
the run as `incomplete`, so it says outright that results are missing; a `SIGKILL` loses whatever was
in flight, and the reconciliation line at close is what reveals it.

---

## Reference

### Options

Every option may be set inline in `playwright.config.ts`; the first three fall back to environment
variables. Inline values win.

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `TESBO_BASE_URL` | Required; the API host. No fallback default |
| `projectId` | `TESBO_PROJECT_ID` | |
| `token` | `TESBO_API_TOKEN` | |
| `runName` | derived from the CI context | e.g. `E2E #128` |
| `environment`, `buildVersion`, `releaseName` | — | Recorded on the run for filtering |
| `strict` | `false` | About the *suite*: fail on untagged tests, bad markers, unknown ids |
| `requireConfig` | `false` | About the *environment*: fail when nothing is configured |
| `attachEvidence` | `'failed'` | `'always'` or `'never'`. `'always'` costs storage on every passing test |
| `enabled` | `true` | `false` disables without editing the reporter list |
| `timeoutMs` | `15000` | Per request |
| `retries` | `3` | Attempts per request, for transient failures only |

### Configured, half-configured, and not configured

| State | Behaviour |
| --- | --- |
| All three set | Reports normally |
| **None** set | Warns and reports nothing; your suite still passes. A fork's PR build with no secrets keeps working |
| **Some** set | **Fails at collection time.** Nobody half-configures a reporter on purpose, and a run that quietly reported nothing looks exactly like one that succeeded |

Set `requireConfig: true` to make the middle row an error too.

### How statuses map

| Playwright | Recorded in Tesbo |
| --- | --- |
| `passed` | pass |
| `failed` | fail |
| `skipped` | skip |
| `timedOut` | timedOut |
| `interrupted` | interrupted |

A flaky test that Playwright retries is upserted on (run, case): the last attempt stands, and the
retry count records how many there were.

### Evidence

On a failure, Playwright's own attachments are uploaded and grouped by kind:

| Extension | Kind |
| --- | --- |
| `png`, `jpg`, `jpeg`, `webp` | screenshot |
| `mp4`, `webm`, `mov` | video |
| `zip` | trace |
| `txt`, `log`, `json`, `md`, `xml` | log |

Files over 25 MB are skipped locally rather than uploaded and rejected. Evidence counts against your
workspace's plan storage; at 100% Tesbo **skips the file and still records the result**, so a full
quota never costs you a pass/fail. The reporter prints how many files were skipped.

Set `attachEvidence: 'always'` to also attach evidence for passing tests — a suite of 2,000 passing
tests each carrying a trace can fill a workspace's whole allowance in one run, so weigh it.

### CI provenance, captured for free

GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines and Bitbucket Pipelines are detected
automatically. The commit SHA, branch and a link to the build are recorded on the run, so a failure
traces back to an exact commit without leaving Tesbo. A local run is labelled `local`.

**Sharding works.** Every shard of one CI attempt shares an idempotency key, so the shards converge
on a single run rather than opening one each. A *re-run* of the workflow deliberately gets its own
run — overwriting the first attempt would destroy the record you re-ran in order to compare against.

Nothing needs configuring for any of this.

### It will not break your pipeline

**A Tesbo outage must never fail your suite.** Every call resolves rather than throwing: failures are
retried with backoff, then logged and counted, and the end-of-run summary says how many requests were
lost. The reporter never touches the process exit code — your suite's pass/fail stays Playwright's
decision alone.

The only exception is `strict: true`, which fails deliberately at collection time because the project
asked it to.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Suite is green, nothing appears in Tesbo | Almost always `TESBO_BASE_URL` pointing at the web app host instead of the API host. Run `doctor` |
| Fails at collection with "configuration incomplete" | One or two of the three values are set. Deliberate, not a bug — see the table above |
| `Tag must start with "@" symbol` | The tag is missing its leading `@`. Use `@tesbo.testId("TES-1042")` |
| `N tagged case id(s) not found in Tesbo` | A tag points at a case that does not exist in this project — check for a typo or a deleted case |
| `This API token is not scoped to this project` | The token belongs to another project. Mint one under this project's settings |
| `requires the "write" scope` | The token has `read` only. Reporting results needs both |
| `N test(s) not linked to Tesbo` | Expected while adopting. Those tests have no tag and were not reported |
| A failed test has no screenshot, video or trace | Playwright's capture is off in your config. The reporter uploads what Playwright produces; it does not capture anything itself |
| An attachment you added never appears | `testInfo.attach()` with a `body` has no file on disk and is skipped. Use `path` |
| A sharded CI run produced one run per shard | The provider is not one of the six detected, so the shards have no shared idempotency key |
| A token written to `.env` has no effect | Playwright does not load `.env`. Add `import 'dotenv/config'` to `playwright.config.ts`, or set the variable in your shell or CI secrets. `init` warns when it detects no loader |
| `tesbo.config.json is not valid JSON` | The file exists but cannot be parsed. Fixed by re-running `init`, which rewrites it |
| Tesbo's stored counts differ from this run's | Some result posts were lost. This line is the only place that is visible — treat it as real |

`doctor` diagnoses the first six directly, and is the fastest first move for any of them.

---

## Appendix — build from source

To run a local build instead of the published package:

```bash
# in this repository
cd sdk/playwright-reporter
npm install && npm run build && npm pack   # -> tesbox-playwright-reporter-<version>.tgz

# in your Playwright project
npm install --save-dev /path/to/tesbox-playwright-reporter-<version>.tgz
```

Everything from [Step 2](#step-2--collect-your-three-values) onward is unchanged.
