#!/bin/bash
# Run the Playwright e2e suite against a DEPLOYED environment, from a CI job.
#
# This is the headless sibling of scripts/e2e-run.sh and scripts/e2e-stage.sh. Those two are for a
# human at a Mac: they open a Terminal.app window with osascript and stream the run into it. Neither
# can work on a build agent, which is what this script exists for — no AppleScript, no Docker, no
# interactive confirmation, everything from the environment, and a non-zero exit on failure.
#
# THE POINT OF THIS SCRIPT is that pointing the suite at a different environment should be a matter
# of changing a URL. What used to stop that was the database transport: utils/psql.ts reached Postgres
# through `docker compose exec postgres psql`, which needs the compose stack on the same host, so on
# a build agent every DB-backed fixture skipped itself and 46 of 60 spec files went dark. psql.ts now
# connects directly, so a connection string is enough.
#
#   Required:
#     API_BASE_URL          https://api-app-stage.tesbo.io
#     WEB_BASE_URL          https://app-stage.tesbo.io
#
#   Required ONLY when E2E_DATABASE_URL is absent (with it, the suite provisions these itself):
#     E2E_TEST_EMAIL        account A — must already exist on the target
#     E2E_TEST_PASSWORD
#
#   Strongly recommended:
#     E2E_DATABASE_URL      the target environment's own DATABASE_URL. Without it every spec that
#                           arranges state through SQL skips itself, and tenants must pre-exist.
#     E2E_TEST_EMAIL_B      account B, for the cross-tenant authorization suite. Auto-created when
#     E2E_TEST_PASSWORD_B   E2E_DATABASE_URL is set.
#
#   Optional:
#     E2E_WORKERS           default 10
#     E2E_ALLOW_PROD        "yes" to permit a production-looking host (refused otherwise)
#     E2E_SPECS             space-separated spec paths; default is the reported-ticket regressions
#
#   Usage:
#     scripts/e2e-ci.sh                              # the regression folder
#     scripts/e2e-ci.sh regression/ api/health.spec.ts
#     E2E_SPECS="api/ ui/" scripts/e2e-ci.sh         # everything

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$REPO/e2e"
WORKERS="${E2E_WORKERS:-10}"

die() { echo "error: $*" >&2; exit 1; }

# ─── Inputs ──────────────────────────────────────────────────────────────────
: "${API_BASE_URL:?set API_BASE_URL to the API origin of the target environment}"
: "${WEB_BASE_URL:?set WEB_BASE_URL to the web origin of the target environment}"
# Account A is only an INPUT when there is no database to build it from. With E2E_DATABASE_URL set,
# global-setup seeds every tenant it needs — account A, account B and the five sacrificial ones —
# from the deterministic identities in utils/env.ts, so demanding them here would force a CI job to
# carry credentials for data the framework already owns. Without a database they cannot be created,
# and a missing account A is then a fatal misconfiguration rather than a detail.
if [ -z "${E2E_DATABASE_URL:-}" ]; then
  : "${E2E_TEST_EMAIL:?no E2E_DATABASE_URL, so account A cannot be provisioned — set E2E_TEST_EMAIL to an account that already exists on the target, or supply E2E_DATABASE_URL and let the suite create it}"
  : "${E2E_TEST_PASSWORD:?set E2E_TEST_PASSWORD}"
fi

api_host="${API_BASE_URL#*://}"; api_host="${api_host%%/*}"
web_host="${WEB_BASE_URL#*://}"; web_host="${web_host%%/*}"

# The suite creates, mutates and deletes real rows — that is what an end-to-end test does. Against
# production that is not a test run, it is an incident, and a copy-pasted job definition is exactly
# how it would happen. Refuse by default and make the override say what it is doing.
if [ "${E2E_ALLOW_PROD:-no}" != "yes" ]; then
  for h in "$api_host" "$web_host"; do
    case "$h" in
      *stage*|*staging*|*dev*|*test*|*qa*|localhost*|127.0.0.1*) ;;
      *) die "refusing to run against '$h': it does not look like a non-production host. This suite writes real data. Set E2E_ALLOW_PROD=yes only if that is genuinely intended." ;;
    esac
  done
fi

# Stripe writes create real Customers and permanently pin a workspace's billing currency, and a
# deployment's key is frequently a live one. Never from an unattended job.
[ "${E2E_BILLING_ALLOW_STRIPE_WRITES:-false}" != "true" ] \
  || die "E2E_BILLING_ALLOW_STRIPE_WRITES=true is refused in CI — a live key would create a real Stripe Customer."

# ─── Database transport ──────────────────────────────────────────────────────
#
# Pinned rather than probed. utils/psql.ts falls back to the Docker transport when a direct connection
# fails, which on an agent with no Docker turns a wrong connection string into 46 silently skipped
# spec files that still report success. Pinning "direct" makes that a loud failure instead.
if [ -n "${E2E_DATABASE_URL:-}" ]; then
  export E2E_DB_TRANSPORT=direct
  export E2E_AUTO_PROVISION="${E2E_AUTO_PROVISION:-true}"
  DB_NOTE="direct connection — SQL-backed fixtures ENABLED, tenants will be provisioned as needed"
else
  export E2E_AUTO_PROVISION="${E2E_AUTO_PROVISION:-false}"
  DB_NOTE="not configured — SQL-backed fixtures will SKIP, and every tenant must already exist"
fi

# A local stack's values must never leak into a run aimed somewhere else. utils/env.ts reads
# process.env.DATABASE_URL as a fallback, so an agent that sourced a .env for another purpose would
# point the fixtures at the wrong database while every assertion ran against the target.
unset DATABASE_URL STRIPE_WEBHOOK_SECRET STRIPE_SECRET_KEY \
      STRIPE_PRICE_ID_PRO_MONTHLY STRIPE_PRICE_ID_PRO_ANNUAL \
      STRIPE_PRICE_ID_PRO_MONTHLY_INR STRIPE_PRICE_ID_PRO_ANNUAL_INR || true

export API_BASE_URL WEB_BASE_URL CI=1

# ─── Dependencies ────────────────────────────────────────────────────────────
cd "$E2E"
# Unconditionally, never `[ -d node_modules ] ||`. A CI agent's workspace is persistent, so the
# directory left by the previous build always exists and that guard skips the install for exactly
# the case that needs it: a dependency ADDED since that build. It is not a hypothetical — nightlies
# #3 and #4 (2026-08-27, 2026-08-28) both died in 74s, because `@tesbox/playwright-reporter` had
# landed on dev and playwright.config.ts imports it at module scope. The config could not load, so
# `--list` printed nothing, and the selection guard below reported "0 tests" with no reason given.
#
# `npm ci` is the right command precisely because it is unconditional: it deletes node_modules and
# installs the lockfile exactly, so the tree always matches package-lock.json. Its cost on a warm
# npm cache is seconds; a silently stale tree costs a night's run.
npm ci --no-audit --no-fund
# Chromium only — the ui project is the sole browser project (playwright.config.ts). --with-deps is
# what pulls the shared libraries a bare container lacks.
#
# The official mcr.microsoft.com/playwright image already carries both, pinned to the same Playwright
# version this lockfile installs, so re-running the installer there spends minutes on an apt-get that
# can only fail — and on a stale apt mirror it fails the whole job before a test has run.
if [ "${E2E_SKIP_BROWSER_INSTALL:-no}" = "yes" ]; then
  echo "browser install skipped — E2E_SKIP_BROWSER_INSTALL=yes (the runner image is expected to ship them)"
else
  npx playwright install --with-deps chromium
fi

# ─── Selection ───────────────────────────────────────────────────────────────
if [ "$#" -gt 0 ]; then
  SPECS=("$@")
else
  # shellcheck disable=SC2206
  SPECS=(${E2E_SPECS:-regression/})
fi

# stderr is KEPT, not sent to /dev/null. `--list` writes its count to stdout and any collection
# error to stderr, so discarding stderr turns "the config could not be loaded" into an empty
# variable and a downstream message about a mistyped path. That is what two nightlies looked like:
# the log said "selection resolved to 0 tests" and never once said "Cannot find module".
LIST_ERR="$(mktemp)"
trap 'rm -f "$LIST_ERR"' EXIT
# `grep '^Total: '`, not `tail -1`. playwright.config.ts prints an environment banner to stdout as it
# loads, so when collection fails AFTER the config body has run, the last line of stdout is a banner
# line rather than nothing — and a guard testing for empty output would wave it through. Selecting
# the count line by shape means "no Total line" reliably identifies a failed listing whatever noise
# preceded it, which is the invariant that actually holds.
SELECTED="$(npx playwright test "${SPECS[@]}" --list 2>"$LIST_ERR" | grep -E '^Total: ' | tail -1 || true)"
TOTAL="$(npx playwright test --list 2>/dev/null | grep -E '^Total: ' | tail -1 || true)"

# Can the selection be counted at all yet?
#
# `--list` does not run globalSetup, and a great many specs read .auth/context.json at module scope
# (api/bugs.spec.ts:5, api/authorization.spec.ts:22, …). So on a workspace that has never run the
# suite, collection throws for every one of those files and --list reports the literal
# "Total: 0 tests in 0 files" with exit 1.
#
# A real run is not affected: globalSetup runs BEFORE the spec files are loaded and writes those
# context files first, so the run bootstraps itself. Treating this zero as a failed selection would
# therefore kill the first build on every fresh CI agent with a message about a mistyped path — the
# opposite of what happened. Only a zero on a workspace that HAS been bootstrapped is real evidence
# of a bad selection.
COUNTABLE=yes
[ -f .auth/context.json ] || COUNTABLE=no

echo "─────────────────────────────────────────────────────────────"
echo "Target:    $WEB_BASE_URL (api $API_BASE_URL)"
echo "Account A: ${E2E_TEST_EMAIL:-<provisioned by the suite from utils/env.ts defaults>}"
echo "Database:  $DB_NOTE"
echo "Specs:     ${SPECS[*]}"
if [ "$COUNTABLE" = "yes" ]; then
  echo "Selection: $SELECTED"
  echo "Suite:     $TOTAL"
else
  echo "Selection: not countable yet — e2e/.auth/context.json does not exist, so --list cannot"
  echo "           collect the specs that read it at import time. globalSetup writes it before the"
  echo "           spec files load, so the run itself is unaffected; the JUnit report carries the"
  echo "           real counts, and the next run on this workspace will announce them up front."
fi
echo "Workers:   $WORKERS"
echo "─────────────────────────────────────────────────────────────"

# A selection that resolved to nothing is a broken job definition, not a green run — a mistyped path
# would otherwise report success having tested nothing at all. Only enforced where the count means
# something; see COUNTABLE above.
if [ "$COUNTABLE" = "yes" ]; then
  case "$SELECTED" in
    *"Total: 0 "*|"")
      # An empty $SELECTED and a literal "Total: 0 tests" are different failures and must not read
      # the same. Empty means --list produced no stdout at all, i.e. collection never got as far as
      # counting — a missing dependency, a config that throws, a syntax error. The reason is in
      # $LIST_ERR and is the single most useful line in the build log, so print it before dying.
      if [ -z "$SELECTED" ] && [ -s "$LIST_ERR" ]; then
        echo "--- playwright --list failed; its output follows ---" >&2
        head -20 "$LIST_ERR" >&2
        echo "----------------------------------------------------" >&2
        die "the Playwright config could not be loaded, so no tests could be selected (see above)."
      fi
      die "selection resolved to 0 tests. That is a failed selection, not a pass."
      ;;
  esac
fi

# ─── Run ─────────────────────────────────────────────────────────────────────
mkdir -p .run-logs
export PLAYWRIGHT_JUNIT_OUTPUT_NAME="${PLAYWRIGHT_JUNIT_OUTPUT_NAME:-$E2E/.run-logs/junit.xml}"

# list for the console, junit for the CI test report, html for a browsable artifact.
set +e
npx playwright test "${SPECS[@]}" \
  --workers="$WORKERS" \
  --reporter=list,junit,html
STATUS=$?
set -e

echo
echo "JUnit:  $PLAYWRIGHT_JUNIT_OUTPUT_NAME"
echo "Report: $E2E/playwright-report/index.html"
[ "$STATUS" -eq 0 ] && echo "e2e: PASSED" || echo "e2e: FAILED (exit $STATUS)"
exit "$STATUS"
