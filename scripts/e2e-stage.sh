#!/bin/bash
# Launch a Playwright e2e run against the STAGE environment, in its own Terminal.app window.
#
# Same mandated protocol as scripts/e2e-run.sh — confirmed with the user first, --workers=10, a
# visible window — with the extra guards a shared remote target needs:
#
#   * credentials come from e2e/stage.env (gitignored; copy e2e/stage.env.example)
#   * the target host must actually be a stage host, so a typo cannot point this at production
#   * the local stack's DATABASE_URL / STRIPE_* are scrubbed from the environment, so a value
#     exported for the local stack cannot silently become the remote run's database or webhook key
#   * writing to the stage database is opt-in twice: E2E_DATABASE_URL plus E2E_STAGE_DB_WRITES_ACK
#   * Stripe write tests are refused outright
#
#   scripts/e2e-stage.sh api/health.spec.ts api/testcases.spec.ts
#   WORKERS=6 scripts/e2e-stage.sh api/suites.spec.ts        # override only with a stated reason

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$REPO/e2e"
WORKERS="${WORKERS:-10}"

die() { echo "error: $*" >&2; exit 1; }

# e2e/environments/stage.env is the current home — the same file `E2E_ENV=stage npx playwright test`
# reads, so the two ways of aiming a run at stage cannot drift apart. e2e/stage.env is where this
# lived before there were environment files; still honoured so an un-migrated checkout keeps working.
if [ -f "$E2E/environments/stage.env" ]; then
  STAGE_ENV="$E2E/environments/stage.env"
else
  STAGE_ENV="$E2E/stage.env"
  [ -f "$STAGE_ENV" ] && echo "note: using the legacy $STAGE_ENV — move it to e2e/environments/stage.env" >&2
fi

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/e2e-stage.sh <spec> [<spec>...] [-g 'TC-042']" >&2
  die "name the specs to run. A bare full-suite run against stage must be asked for explicitly."
fi

[ -f "$STAGE_ENV" ] || die "no $STAGE_ENV — copy e2e/environments/stage.env.example to e2e/environments/stage.env and fill it in."

# The local stack's values must not leak into a remote run. utils/env.ts falls back to
# process.env.DATABASE_URL, so a shell that has sourced the repo-root .env would point the psql
# helpers at the local stack's database while every assertion ran against stage.
unset DATABASE_URL STRIPE_WEBHOOK_SECRET STRIPE_SECRET_KEY \
      STRIPE_PRICE_ID_PRO_MONTHLY STRIPE_PRICE_ID_PRO_ANNUAL \
      STRIPE_PRICE_ID_PRO_MONTHLY_INR STRIPE_PRICE_ID_PRO_ANNUAL_INR || true

# Parsed, not sourced. `source` runs the file as shell, so an unquoted value with a space in it
# ("Testing Stagging 105070") is read as a command — and a stray backtick in a password would be
# executed. This reads KEY=VALUE the way a .env file is actually written, and strips one layer of
# surrounding quotes if present.
declare -a STAGE_KEYS=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"
  val="${BASH_REMATCH[2]}"
  val="${val%"${val##*[![:space:]]}"}"                       # trim trailing whitespace
  if [ "${#val}" -ge 2 ]; then
    case "$val" in
      \"*\"|\'*\') val="${val:1:${#val}-2}" ;;
    esac
  fi
  export "$key=$val"
  STAGE_KEYS+=("$key")
done < "$STAGE_ENV"

: "${API_BASE_URL:?set API_BASE_URL in e2e/stage.env}"
: "${WEB_BASE_URL:?set WEB_BASE_URL in e2e/stage.env}"

api_host="${API_BASE_URL#*://}"; api_host="${api_host%%/*}"
web_host="${WEB_BASE_URL#*://}"; web_host="${web_host%%/*}"
for h in "$api_host" "$web_host"; do
  case "$h" in
    *stage*) ;;
    *) die "refusing to run: '$h' does not look like a stage host. This runner is for stage only." ;;
  esac
done

# global-setup.ts fails the entire run — not one suite — if either of these cannot log in, and on a
# remote target it has no way to create them. Catch that here with a readable message instead.
[ -n "${E2E_TEST_EMAIL:-}" ] && [ -n "${E2E_TEST_PASSWORD:-}" ] \
  || die "E2E_TEST_EMAIL / E2E_TEST_PASSWORD are required — account A must already exist on stage."
[ -n "${E2E_TEST_EMAIL_B:-}" ] && [ -n "${E2E_TEST_PASSWORD_B:-}" ] \
  || die "E2E_TEST_EMAIL_B / E2E_TEST_PASSWORD_B are required — account B must already exist on stage."

# There is no backend stdout to scrape a signup OTP from, so auto-provisioning cannot work here.
# It already defaults to false for a non-local host; make that explicit and unoverridable.
export E2E_AUTO_PROVISION=false

if [ "${E2E_BILLING_ALLOW_STRIPE_WRITES:-false}" = "true" ]; then
  die "E2E_BILLING_ALLOW_STRIPE_WRITES=true is refused against stage — a live key would create a real Customer."
fi

DB_NOTE="skipping (no E2E_DATABASE_URL — SQL-fixture specs will skip themselves)"
if [ -n "${E2E_DATABASE_URL:-}" ]; then
  [ "${E2E_STAGE_DB_WRITES_ACK:-}" = "yes" ] \
    || die "E2E_DATABASE_URL is set, so the SQL-fixture specs will INSERT/UPDATE/DELETE in the STAGE database. Set E2E_STAGE_DB_WRITES_ACK=yes to confirm that is intended."
  DB_NOTE="ENABLED — SQL-fixture specs will write to the stage database"
fi

# e2e/.auth is shared with local runs: a concurrent run rewrites state.json mid-flight, and here it
# would also swap stage cookies in under a local run (or the reverse).
if pgrep -f "playwright test" >/dev/null 2>&1; then
  echo "error: a Playwright run is already in progress — it shares e2e/.auth/state.json." >&2
  pgrep -fl "playwright test" | sed 's/^/       /' >&2
  exit 3
fi

cd "$E2E"
SELECTED="$(npx playwright test "$@" --list 2>/dev/null | tail -1)"
TOTAL="$(npx playwright test --list 2>/dev/null | tail -1)"

echo "Target:    $WEB_BASE_URL (api $API_BASE_URL)"
echo "Account A: $E2E_TEST_EMAIL"
echo "Stage DB:  $DB_NOTE"
echo "Selection: $SELECTED"
echo "Suite:     $TOTAL"
case "$SELECTED" in
  *"Total: 0 "*|"") die "selection resolved to 0 tests — that is a failed selection, not a pass." ;;
esac

mkdir -p "$E2E/.run-logs"
STAMP="stage-$(date +%Y%m%d-%H%M%S)"
LOG="$E2E/.run-logs/$STAMP.log"
LAUNCHER="$E2E/.run-logs/$STAMP.command"

# Hand Terminal a file rather than an escaped one-liner — no AppleScript quoting hazards. The
# credentials are written into it, so it is created private and removed when the run ends.
{
  echo '#!/bin/bash'
  echo "cd $(printf '%q' "$E2E")"
  echo "trap 'rm -f $(printf '%q' "$LAUNCHER")' EXIT"
  echo "echo '=== e2e STAGE run $STAMP — workers=$WORKERS ==='"
  echo "echo 'target: $WEB_BASE_URL'"
  echo "echo 'specs:  $*'"
  echo "echo 'log:    $LOG'"
  echo "echo"
  for key in "${STAGE_KEYS[@]}"; do
    printf 'export %s=%q\n' "$key" "${!key:-}"
  done
  echo "export E2E_AUTO_PROVISION=false"
  printf 'npx playwright test'
  for a in "$@"; do printf ' %q' "$a"; done
  printf ' --workers=%q 2>&1 | tee %q\n' "$WORKERS" "$LOG"
  echo "echo"
  echo "echo '=== run finished ==='"
} > "$LAUNCHER"
chmod 700 "$LAUNCHER"

osascript >/dev/null <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "$LAUNCHER"
  set custom title of front window to "e2e STAGE $STAMP (workers=$WORKERS)"
end tell
APPLESCRIPT

echo "Launched in a new Terminal window at --workers=$WORKERS."
echo "Log: $LOG"
