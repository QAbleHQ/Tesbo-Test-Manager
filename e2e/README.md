# Tesbo E2E Smoke Suite

Playwright-based API + UI smoke tests that run against a **deployed** instance of Tesbo
(local docker-compose by default, or any environment via env vars). This is deliberately a
smoke suite, not full coverage: health check, login, and one create/read/update/delete pass
each for the API and the UI, enough to catch a broken deploy.

Wiring this into GitHub Actions on every PR is a separate, later piece of work — this suite
is meant to be run manually or from a post-deploy step for now.

## Running locally

From the repo root, after the docker-compose stack is up and healthy:

```
scripts/deploy-and-test.sh
```

This rebuilds the backend/frontend/migrator images, brings the stack up, waits for the
backend and frontend health checks, then runs the full suite.

To run the suite directly (stack already up):

```
cd e2e
npm install
npm run install-browsers   # once, downloads the Chromium binary
npm test                   # both projects
npm run test:api           # API tests only
npm run test:ui            # UI tests only
npm run report             # open the last HTML report
```

## How auth works in these tests

There's no API endpoint that returns a signup OTP. Outside production the backend runs with
`EMAIL_DELIVERY_MODE=log` (the default), which prints the code to the backend container's stdout and
never emails it — whether or not a `POSTMARK_API_TOKEN` is configured. So:

- `global-setup.ts` runs once before any test. It first tries `POST
  /api/auth/password/login` with the configured smoke-test credentials
  (`E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD`, defaults in `.env.example`).
- If that fails and the target looks local (`API_BASE_URL` is localhost/127.0.0.1, or
  `E2E_AUTO_PROVISION=true` is set explicitly), it signs the user up via `/api/auth/signup/start`,
  scrapes the OTP out of `docker compose logs <service>`, and verifies it via
  `/api/auth/signup/verify`.
- It then ensures the user has a workspace + project (creating `E2E_ORG_NAME` /
  `E2E_PROJECT_NAME` if needed), and saves the authenticated session cookie to
  `.auth/state.json` plus `{ organizationId, projectId }` to `.auth/context.json` for every
  spec file to reuse.
- Against a remote target where you don't have docker log access, pre-create this user
  yourself and set `E2E_AUTO_PROVISION=false` (or just leave it unset — it already defaults
  to false for non-local hosts).

The seeded user and its "E2E Smoke Project" persist across runs (the docker volume isn't
wiped), so re-runs reuse the same account/project rather than accumulating new ones. Test
cases created by tests delete themselves at the end of the test.

## Choosing an environment

One file per environment under [`environments/`](environments/), selected with `E2E_ENV`. Nothing
else changes — the specs, the helpers and `playwright.config.ts` all resolve their target through
[`utils/env.ts`](utils/env.ts), which loads the selected file before the first value is read.

```bash
npx playwright test                       # local  — environments/local.env (the default)
E2E_ENV=stage npx playwright test         # stage  — environments/stage.env
E2E_ENV=stage npx playwright test regression/
E2E_ENV_FILE=/secrets/qa.env npx playwright test    # or name the file outright

npm run test:stage                        # the same thing, spelled as a script
```

Every run prints what it resolved before the first test, so a misdirected run is visible
immediately rather than forty lines into a `global-setup` stack trace:

```
e2e environment: stage — environments/stage.env
  api:      https://api-app-stage.tesbo.io
  web:      https://app-stage.tesbo.io
  account:  testing.staging105070@mailinator.com
  database: not configured — SQL-fixture specs will skip themselves
  provision: off — tenants must already exist
```

Three rules worth knowing:

- **`process.env` beats the file.** CI injects credentials as environment variables and the
  committed file supplies only the non-secret remainder. It also lets you override one value for a
  single run without editing anything.
- **`KEY=` means "not configured"**, not "the empty string" — the loader skips those lines, so
  whatever fallback sits behind them still applies.
- **A named environment that doesn't exist is a hard error**, never a silent fall-back to
  localhost. The *default* (`local`) is the one exception: if `environments/local.env` is absent,
  the built-in defaults apply and nothing fails.

Real `.env` files are gitignored; each environment ships a committed `.env.example`. Never commit a
password or a connection string.

## Running against the stage environment

Stage is https://app-stage.tesbo.io with its API at https://api-app-stage.tesbo.io. The specs
themselves need no changes — the suite already targets whatever `API_BASE_URL` / `WEB_BASE_URL`
point at. Three things are different about a remote target, and `scripts/e2e-stage.sh` exists to
handle all three:

1. **Tenants must already exist.** `global-setup.ts` fails the whole run if it cannot log in as
   account A or account B. On a local stack it creates them by scraping the signup OTP out of
   `docker compose logs`; there is no container log to read on stage, so both accounts have to be
   signed up by hand first and their credentials put in `e2e/environments/stage.env`.
2. **The SQL-fixture specs skip by default.** `utils/psql.ts` refuses to guess a database, so
   `dbControlAvailable()` is false and every suite that arranges state through SQL skips itself
   (~29 spec files). Setting `E2E_DATABASE_URL` to stage's own connection string unlocks them —
   the local postgres container is only transport for the `psql` binary, so a hosted URL is
   reachable — at the cost of real writes to the stage database. The runner requires
   `E2E_STAGE_DB_WRITES_ACK=yes` on top of it for that reason.
3. **Stage is shared.** Stripe write tests are refused outright, and the runner refuses any host
   that does not look like a stage host. The local stack's `DATABASE_URL` and `STRIPE_*` cannot
   leak into a remote run: `utils/env.ts` accepts only the `E2E_`-prefixed form once the target is
   not localhost, so this holds for a plain `E2E_ENV=stage npx playwright test` too, not just for
   runs that go through the script.

```bash
cp e2e/environments/stage.env.example e2e/environments/stage.env   # then fill in the accounts
scripts/e2e-stage.sh api/health.spec.ts api/testcases.spec.ts
```

It announces the selection and the suite total, refuses a 0-test selection, refuses to start while
another run holds `e2e/.auth/state.json`, and opens a Terminal window at `--workers=10` teeing to
`e2e/.run-logs/stage-<stamp>.log` — the same protocol as `scripts/e2e-run.sh`.

Note that `e2e/.auth/` is shared with local runs. Each run's global setup rewrites it, so they
self-heal in sequence, but never run a local suite and a stage suite at the same time.

## Reporting results into Tesbo

`playwright.config.ts` registers `@tesbox/playwright-reporter`, so a run posts its results back into
the Tesbo project this suite tests (`Tesbo TTM - Web Official`) as one Test Run per
`playwright test` invocation. The API host and project id are committed there — neither is a secret.
The token is not: export `TESBO_API_TOKEN` (a `read`+`write` project token from
**Project -> Settings -> API & MCP**) for the run, or inject it as a credential in CI.

**With no token the reporter is switched off** and the suite behaves exactly as it did before, except
in CI, where a missing token fails the run rather than reporting nothing quietly. See the comment on
`reporter` in `playwright.config.ts` for why that asymmetry exists.

Each test is linked to the case it validates by a tag:

```ts
test("ACT-A-01 an action in a project appears in that project's feed", { tag: '@tesbo.testId("TES-TC-886")' }, async () => {
```

- The leading `@` is required — Playwright rejects any tag without it at collection time.
- **One id per test.** Two is an error, not a coin flip.
- An untagged test is reported as `not linked to Tesbo` and does not fail anything. Tests generated
  in a loop from a single `test()` call are untagged for that reason: one call site cannot carry one
  id per generated test.
- A tag pointing at a case that does not exist in the project fails the run at collection time.
  Automation never creates cases — a QA engineer owns the repository.

When adding a spec, look up the case in Tesbo and add its id. When there is no case yet, leave the
test untagged rather than pointing it at an approximate one.

## Config

Copy `.env.example` to `.env` and adjust if needed — every value has a working default for
the local stack. See that file for the full list (`API_BASE_URL`, `WEB_BASE_URL`,
`E2E_TEST_EMAIL`, etc).

## Layout

```
e2e/
  global-setup.ts     # provisions the smoke user + workspace/project, saves auth state
  playwright.config.ts
  api/                 # APIRequestContext-based tests, no browser
  ui/                  # browser-driven tests (chromium)
  utils/env.ts         # central env var + defaults
```
