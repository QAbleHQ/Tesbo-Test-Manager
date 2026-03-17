# automation-agent

Node.js Playwright runtime for TesboX automation sessions.

## What this service does

- Creates isolated browser sessions per TesboX automation session.
- Executes structured action plans (`navigate`, `click`, `type`) step-by-step.
- Captures screenshots and emits stream snapshots for live browser visibility.
- Exposes internal APIs used by the Java backend orchestrator.

## Environment variables

- `PORT` (default: `7400`)
- `AUTOMATION_SERVICE_ROLE` (`all`, `api`, `worker`; default: `all`)
- `PLAYWRIGHT_HEADLESS` (`true` or `false`, default: `true`)
- `SESSION_TTL_MS` (default: `900000`)
- `SCREENSHOT_DIR` (default: `./artifacts/screenshots`)
- `AGENT_SHARED_TOKEN` (required in non-local environments)
- `REDIS_URL` / `AUTOMATION_QUEUE_NAME` / `AUTOMATION_QUEUE_PREFIX` (queue settings)

## Local run

```bash
npm install
npm run dev
```

Run split roles locally:

```bash
# API gateway only
AUTOMATION_SERVICE_ROLE=api PORT=7400 npm run dev

# Worker only
AUTOMATION_SERVICE_ROLE=worker PORT=7401 npm run dev
```

## Internal API

- `GET /health`
- `POST /internal/sessions`
- `POST /internal/sessions/:sessionId/execute`
- `GET /internal/sessions/:sessionId/state`
- `POST /internal/sessions/:sessionId/close`
