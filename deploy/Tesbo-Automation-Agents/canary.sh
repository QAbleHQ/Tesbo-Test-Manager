#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <agent-base-url> <agent-token>"
  exit 1
fi

BASE_URL="$1"
TOKEN="$2"
SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
COMMAND_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

echo "Running automation-agent canary against ${BASE_URL}"

curl -fsS "${BASE_URL}/health" >/dev/null

curl -fsS -X POST "${BASE_URL}/internal/sessions" \
  -H "Content-Type: application/json" \
  -H "x-agent-token: ${TOKEN}" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"startUrl\":\"https://example.com\"}" >/dev/null

curl -fsS -X POST "${BASE_URL}/internal/sessions/${SESSION_ID}/execute" \
  -H "Content-Type: application/json" \
  -H "x-agent-token: ${TOKEN}" \
  -d "{\"commandId\":\"${COMMAND_ID}\",\"steps\":[{\"id\":\"canary-step\",\"action\":\"assert_text\",\"expectedText\":\"Example Domain\"}]}" >/dev/null

curl -fsS -X POST "${BASE_URL}/internal/sessions/${SESSION_ID}/close" \
  -H "Content-Type: application/json" \
  -H "x-agent-token: ${TOKEN}" \
  -d "{}" >/dev/null

echo "Canary passed"
