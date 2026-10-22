#!/usr/bin/env bash
# Quality gates that must pass before a build is allowed to deploy (and on every pull request).
#
# Runs from the repo root, needs only bash, Node 22 and network access for `npm ci`. It is the one
# definition of "good enough to ship": Jenkinsfile, Jenkinsfile.stage and .github/workflows/ci.yml all
# call it, so the three can never drift apart.
#
# Every gate runs even if an earlier one failed, so one run shows every problem instead of the first.
# The exit status is non-zero when any BLOCKING gate failed. Warnings (non-blocking) are printed in a
# summary and never fail the run.
#
#   scripts/ci-check.sh                 everything
#   CI_SKIP="frontend audit" ...        skip named gates (hotfix or local use; the names are printed in the summary)
#
# Gates:
#   repo-hygiene   stray NUL bytes in source, focused tests (.only), duplicate or malformed migration numbers
#   backend        npm ci, typecheck (specs included), eslint ratchet, jest
#   frontend       npm ci, typecheck, eslint ratchet
#                  (lint is a ratchet, not "zero errors": see scripts/lint-ratchet.js)
#   audit          npm audit of production dependencies: critical blocks, high only warns
#
# Why audit blocks only on critical: the advisory database changes daily, so a deploy that touched nothing
# near a package can start failing overnight. Blocking on every "high" would turn an unrelated new advisory
# into a stopped release; critical is worth stopping for, high is shown and tracked.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP=" ${CI_SKIP:-} "
BLOCKING_FAILURES=()
WARNINGS=()
SKIPPED=()

# Keep npm out of the user's home and quiet, and make it fail instead of waiting for a prompt.
export CI=true
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export npm_config_loglevel="${npm_config_loglevel:-error}"

banner() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

skipped() {
  case "$SKIP" in *" $1 "*) SKIPPED+=("$1"); banner "SKIPPED: $1 (CI_SKIP)"; return 0 ;; esac
  return 1
}

# run <gate-name> <command...>: a failure is recorded as blocking and the script carries on.
run() {
  local name="$1"; shift
  if skipped "$name"; then return 0; fi
  banner "$name"
  # A subshell, so a gate that cd's into a package cannot leave the next gate in the wrong directory.
  if ! ( "$@" ); then
    BLOCKING_FAILURES+=("$name")
    printf '\033[31mFAILED: %s\033[0m\n' "$name"
  fi
}

# warn <gate-name> <command...>: a failure is only a warning.
warn() {
  local name="$1"; shift
  if skipped "$name"; then return 0; fi
  banner "$name (warning only)"
  # A subshell, so a gate that cd's into a package cannot leave the next gate in the wrong directory.
  if ! ( "$@" ); then
    WARNINGS+=("$name")
    printf '\033[33mWARNING: %s\033[0m\n' "$name"
  fi
}

# ── repo hygiene ────────────────────────────────────────────────────────────────────────────────────

check_no_nul_bytes() {
  # A raw NUL in a source file makes git treat it as binary (so the diff becomes the whole file and
  # review is impossible) and is how a bad escape in a scripted edit once corrupted legacy.service.ts.
  # One grep over everything rather than a process per file: it runs in a few seconds, not minutes.
  local hits
  hits="$(grep -rlaP '\x00' \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.sql' --include='*.json' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
    Tesbo-Backend-Nest/src Tesbo-Backend-Nest/migrations Tesbo-Frontend/app Tesbo-Frontend/components Tesbo-Frontend/lib \
    e2e/api e2e/ui e2e/utils sdk scripts 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "$hits" | sed 's/^/NUL byte in /'
    return 1
  fi
}

check_no_focused_tests() {
  # test.only / describe.only silently skips every other test in the run, and a green run proves nothing.
  local hits
  hits="$(grep -rnE '\b(test|it|describe)\.only\(' e2e/api e2e/ui Tesbo-Backend-Nest/src sdk --include='*.ts' 2>/dev/null | grep -v node_modules || true)"
  if [ -n "$hits" ]; then echo "$hits"; echo "A focused test (.only) is committed."; return 1; fi
}

check_migrations() {
  # Two branches that both add the next migration number merge cleanly and then break the deploy:
  # the migrator refuses a duplicate or a name that is not V<number>_<name>.sql.
  local dir=Tesbo-Backend-Nest/migrations bad=0 file name number
  declare -A seen=()
  for file in "$dir"/*.sql; do
    name="$(basename "$file")"
    if ! [[ "$name" =~ ^V([0-9]+)_[A-Za-z0-9_]+\.sql$ ]]; then echo "Bad migration name: $name (expected V<number>_<name>.sql)"; bad=1; continue; fi
    number="${BASH_REMATCH[1]}"
    if [ -n "${seen[$number]:-}" ]; then echo "Duplicate migration number V$number: ${seen[$number]} and $name"; bad=1; fi
    seen[$number]="$name"
  done
  return $bad
}

repo_hygiene() {
  local rc=0
  check_no_nul_bytes || rc=1
  check_no_focused_tests || rc=1
  check_migrations || rc=1
  echo "-- gate scripts"; node --test "$ROOT/scripts/ci-gates.test.js" || rc=1
  return $rc
}

# ── backend ─────────────────────────────────────────────────────────────────────────────────────────

backend() {
  cd "$ROOT/Tesbo-Backend-Nest" || return 1
  local rc=0
  echo "-- npm ci";        npm ci || return 1
  echo "-- typecheck";     npm run --silent typecheck || rc=1
  echo "-- eslint (ratchet)"; node "$ROOT/scripts/lint-ratchet.js" "$PWD" || rc=1
  echo "-- jest";          npx jest --ci --runInBand || rc=1
  return $rc
}

# ── frontend ────────────────────────────────────────────────────────────────────────────────────────

frontend() {
  cd "$ROOT/Tesbo-Frontend" || return 1
  local rc=0
  echo "-- npm ci";        npm ci || return 1
  echo "-- typecheck";     npx tsc --noEmit || rc=1
  echo "-- eslint (ratchet)"; node "$ROOT/scripts/lint-ratchet.js" "$PWD" || rc=1
  return $rc
}

# ── dependency audit ────────────────────────────────────────────────────────────────────────────────

audit_critical() {
  local rc=0 dir
  for dir in Tesbo-Backend-Nest Tesbo-Frontend; do
    echo "-- $dir"
    # npm ci already ran in backend/frontend; if a gate was skipped there is no node_modules, which audit does not need.
    (cd "$ROOT/$dir" && npm audit --omit=dev --audit-level=critical) || rc=1
  done
  return $rc
}

audit_high() {
  local rc=0 dir
  for dir in Tesbo-Backend-Nest Tesbo-Frontend; do
    echo "-- $dir"
    (cd "$ROOT/$dir" && npm audit --omit=dev --audit-level=high) || rc=1
  done
  return $rc
}

# ── run ─────────────────────────────────────────────────────────────────────────────────────────────

echo "node $(node -v), npm $(npm -v)"
case "$(node -v)" in v22.*) ;; *) echo "WARNING: the images and Dockerfiles use Node 22; this run uses $(node -v)" ;; esac

run  "repo-hygiene" repo_hygiene
run  "backend"      backend
run  "frontend"     frontend
run  "audit-critical" audit_critical
warn "audit-high"   audit_high

banner "Summary"
if [ "${#SKIPPED[@]}" -gt 0 ]; then printf 'SKIPPED gates: %s\n' "${SKIPPED[*]}"; fi
if [ "${#WARNINGS[@]}" -gt 0 ]; then printf 'Warnings: %s\n' "${WARNINGS[*]}"; fi
if [ "${#BLOCKING_FAILURES[@]}" -gt 0 ]; then
  printf '\033[31mBLOCKED by: %s\033[0m\n' "${BLOCKING_FAILURES[*]}"
  exit 1
fi
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  # Green would be a lie: part of what "ready to ship" means was not checked.
  printf '\033[33mNothing failed, but %s gate(s) were SKIPPED, so this is not a full pass.\033[0m\n' "${#SKIPPED[@]}"
else
  printf '\033[32mAll blocking gates passed.\033[0m\n'
fi
