# Tesbo-Automation-Agents

Node.js Playwright service for TesboX **automate** flows: sessions, live view, recordings, LangChain/telemetry, and `POST /internal/playwright/run`.

## What this service does

- Creates isolated browser sessions per TesboX automation session.
- Executes structured plans, agent objectives, and in-session script runs.
- Captures screenshots, video, traces; exposes live MJPEG and recording APIs.
- Used by the Java backend via `AUTOMATION_AGENT_BASE_URL` (default port **7400**).

## Environment variables

- `PORT` (default: `7400`)
- `PLAYWRIGHT_HEADLESS` (`true` or `false`, default: `true`)
- `SESSION_TTL_MS`, `SESSION_CREATE_CONCURRENCY`, `START_URL_TIMEOUT_MS`
- `SCREENSHOT_DIR`, `VIDEO_DIR`, `TRACE_DIR`, `RECORD_VIDEO`
- `USE_TELEMETRY`, `LANGCHAIN_MAX_STEPS`, `DOM_SNAPSHOT_MAX_ELEMENTS`
- `AGENT_SHARED_TOKEN` (required in non-local environments)

## Local run

```bash
npm install
npm run dev
```

## Internal API (representative)

- `GET /health`
- `POST /internal/sessions`, `POST /internal/sessions/:id/reset`, `POST /internal/sessions/:id/close`
- `POST /internal/sessions/:id/execute`, `POST /internal/sessions/:id/execute-agent`, `POST /internal/sessions/:id/run-script`
- `POST /internal/playwright/run`
- `GET /internal/sessions/:id/state`, `GET /internal/sessions/:id/live`, recording endpoints

Queue execution lives in **`Tesbo-Test-Runner-Agents`**.
