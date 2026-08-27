# `@tesbox/playwright-reporter`

Reports Playwright results into Tesbo, linked to the test cases they validate.

Automation **reports results only**. It never creates or approves a test case — QA engineers own
those, and a tag pointing at a case that does not exist is reported as an error, not helpfully
created.

## Install

```bash
npm install --save-dev @tesbox/playwright-reporter
```

## Set it up

You need three values, all on **Project → Settings → API & MCP** in Tesbo. The CLI asks for them,
checks they work together, and writes them to `tesbo.config.json`:

```bash
npx @tesbox/playwright-reporter init
```

Re-run it whenever the server or project changes — it rewrites that file in place, so
`playwright.config.ts` is a one-time edit. The token stays out of the file by default; `init` offers
`.env` instead, and will put it in the JSON if you ask, saying first whether that file is gitignored.

To check an existing setup — including inside CI, where it prompts for nothing and just reports:

```bash
npx @tesbox/playwright-reporter doctor
```

`doctor` exits `0` when the three values are reachable and valid, `1` when verification failed, and
`2` when they are missing. It only ever *reads*, so it is safe to run against production.

> **Why a CLI and not a prompt at run time.** A Playwright reporter runs inside a non-interactive
> test process, usually on a CI runner with no TTY. A prompt there does not ask anyone anything — it
> hangs the job until it times out. So the reporter fails fast and says what is missing, and the
> asking happens in a command a human runs.

## Configure

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['list'],
    ['@tesbox/playwright-reporter', {
      // baseUrl and projectId are not secrets — commit them. A self-hosted install needs its own
      // baseUrl in version control anyway.
      baseUrl: 'https://api-app.tesbo.io',
      projectId: '<your-project-uuid>',
      environment: 'staging',
      // The token is a secret: leave it in TESBO_API_TOKEN, never in this file.
    }],
  ],
});
```

Create the token in Tesbo under **Project → Settings → API & MCP**. It needs the `write` scope, and
it is scoped to one project — a token issued for project A cannot report into project B.

Values resolve in this order — inline options, then environment variables, then
`tesbo.config.json`. The file is last so a CI secret always beats a committed value. A malformed file
fails at collection time rather than degrading to "unconfigured".

| Variable | Purpose |
|---|---|
| `TESBO_BASE_URL` | Your Tesbo **API** host, e.g. `https://api-app.tesbo.io`. **No default** |
| `TESBO_PROJECT_ID` | The project results are reported into |
| `TESBO_API_TOKEN` | Project API token (`tsbo_…`), needing the `read` and `write` scopes |

`TESBO_BASE_URL` is the API host, **not** the web app host — Tesbo serves them separately and the app
host has no `/api` route. Getting this wrong fails silently: every call 404s, and because the reporter
never breaks your suite, the run stays green with no results. There is deliberately no default for
this reason. `doctor` detects it and names the host you probably want.

You can also paste the MCP URL straight from Project Settings
(`https://…/api/projects/<uuid>/mcp`) as `TESBO_BASE_URL` — it is trimmed to the origin and the
project id is read out of it, so one paste configures two of the three values.

### Configured, half-configured, and not configured

| State | Behaviour |
|---|---|
| All three set | Reports normally |
| **None** set | Warns and reports nothing; your suite still passes. A fork's PR build with no secrets keeps working |
| **Some** set | **Fails at collection time.** Nobody half-configures a reporter on purpose, and a run that quietly reported nothing looks exactly like one that succeeded |

Set `requireConfig: true` to make the middle row an error too.

## Link a test to a case

```ts
test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {
  // ...
});
```

`TES-1042` is the test case's ID as shown in Tesbo.

> **Note the leading `@`.** Playwright validates every tag against `^@` and throws
> `Tag must start with "@" symbol` at collection time otherwise — so the unprefixed
> `tesbo.testId("TES-1042")` will not load. With the `@`, the marker is character-for-character the
> same as the pytest decorator and the JUnit annotation.

An annotation works too, for ids computed at runtime:

```ts
test('...', { annotation: { type: 'tesbo', description: caseId } }, async () => {});
```

A test may declare **exactly one** case id. Two is an error rather than a coin flip, because the
alternative is a result silently attached to the wrong case.

## What happens on a run

1. **Before any test runs**, the reporter collects every tagged id and validates it against your
   project, then opens **one** Test Run — not one per test.
2. **As each test finishes**, its result is posted with duration, retry count and, on failure,
   Playwright's error message. Submission is non-blocking: it never sits between two tests.
3. **On failure**, screenshots, video and the trace are attached as evidence.
4. **At the end**, the run is closed with a summary, and Tesbo reconciles it against what it actually
   stored — any disagreement is printed, which is the only place a dropped result is visible.

## What you have to add

Nothing inside your test code beyond the tag — no import, no fixture, no `await`, no flush, no global
setup. The reporter reads Playwright's own tags and annotations; opening the run, posting results,
retrying and closing all happen in lifecycle hooks Playwright calls itself.

The one prerequisite that is easy to miss: **evidence needs Playwright's capture enabled.** The
reporter uploads what Playwright produces, it does not capture anything itself, so with
`screenshot`/`video`/`trace` off a failed test reports status and error text and no evidence.

```ts
use: { screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'on-first-retry' }
```

Your own `testInfo.attach()` calls need a `path`; an inline `body` has no file on disk and is skipped.

Workers, `fullyParallel` and `retries` need no configuration. Sharding converges on one run on the six
detected CI providers; on any other, each shard opens its own run and the key cannot yet be set
manually.

## Untagged tests

By default they are **skipped and counted**, and the run summary says
`N test(s) not linked to Tesbo`. Adopting the reporter on an existing suite does not turn it red.

Set `strict: true` to fail at collection time instead — on an untagged test, an unreadable marker, or
an id that does not exist in the project.

## Options

| Option | Default | Notes |
|---|---|---|
| `projectId` | `TESBO_PROJECT_ID` | |
| `token` | `TESBO_API_TOKEN` | |
| `baseUrl` | `TESBO_BASE_URL` | Required; the API host. No fallback default |
| `runName` | derived from the CI context | e.g. `E2E #128` |
| `environment`, `buildVersion`, `releaseName` | — | Recorded on the run for filtering |
| `strict` | `false` | See above — about the *suite* (untagged tests) |
| `requireConfig` | `false` | About the *environment*: fail when nothing is configured |
| `attachEvidence` | `'failed'` | `'always'` or `'never'`. `'always'` costs storage on every passing test |
| `enabled` | `true` | `false` disables without editing the reporter list |
| `timeoutMs` | `15000` | Per request |
| `retries` | `3` | Attempts per request, transient failures only |

## CI provenance, captured for free

GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines and Bitbucket Pipelines are detected,
and the commit SHA, branch and a link to the build are recorded on the run — so a failure traces back
to an exact commit without leaving Tesbo. A local run is labelled `local`.

**Sharding works.** Every shard of one CI attempt shares an idempotency key, so they converge on a
single run rather than opening one each. A *re-run* of the workflow deliberately gets its own run —
overwriting the first attempt would destroy the record you re-ran in order to compare against.

## It will not break your pipeline

Card §7, and the rule this package is built around: **a Tesbo outage must never fail your suite.**

Every call to Tesbo resolves rather than throwing. Failures are retried with backoff, then logged and
counted, and the end-of-run summary says how many requests were lost. The reporter never touches the
process exit code — your suite's pass/fail is Playwright's decision alone.

The only exception is `strict: true`, which fails deliberately at collection time because the project
asked it to.

## Storage quota

Evidence counts against your workspace's plan storage. At 100% Tesbo **skips the evidence and still
records the result** — a full quota never costs you a pass/fail. The reporter prints how many files
were skipped.

## Develop

```bash
npm install
npm run build
npm test        # compiles, then runs the unit tests
```
