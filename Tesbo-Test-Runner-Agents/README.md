# Tesbo-Test-Runner-Agents

Node.js **BullMQ** workers and queue HTTP API for TesboX scheduled/queued Playwright runs (default API port **7410**).

## What this service does

- Accepts enqueue/cancel/stats requests from the Java backend (`AUTOMATION_QUEUE_API_BASE_URL`).
- Runs Playwright scripts via providers (default: local Chromium).
- Reports job heartbeats and completion to the backend.

## Environment variables

- `PORT` (default: `7410` for API; workers may use another port locally)
- `AUTOMATION_SERVICE_ROLE` (`all`, `api`, `worker`; default: `all`)
- `PLAYWRIGHT_HEADLESS`, `REDIS_URL`, `AUTOMATION_QUEUE_*`, `BACKEND_BASE_URL`, `AUTOMATION_QUEUE_SHARED_TOKEN`
- `AGENT_SHARED_TOKEN` (must match backend `AUTOMATION_AGENT_SHARED_TOKEN` for `x-agent-token` on queue API)
- `SCREENSHOT_DIR`, `VIDEO_DIR`, `TRACE_DIR`, `RECORD_VIDEO`

## Local run

```bash
npm install
npm run dev
```

Split API vs worker locally:

```bash
AUTOMATION_SERVICE_ROLE=api PORT=7410 npm run dev
AUTOMATION_SERVICE_ROLE=worker PORT=7411 npm run dev
```

## Internal API

- `GET /health`
- `POST /internal/queue/jobs`, `POST /internal/queue/jobs/batch`
- `POST /internal/queue/runs/:runId/cancel`
- `GET /internal/queue/stats`

Interactive automate APIs live in **`Tesbo-Automation-Agents`**.
