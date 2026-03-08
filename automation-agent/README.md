# automation-agent

Node.js Playwright runtime for TesboX automation sessions.

## What this service does

- Creates isolated browser sessions per TesboX automation session.
- Executes structured action plans (`navigate`, `click`, `type`) step-by-step.
- Captures screenshots and emits stream snapshots for live browser visibility.
- Exposes internal APIs used by the Java backend orchestrator.

## Environment variables

- `PORT` (default: `7400`)
- `PLAYWRIGHT_HEADLESS` (`true` or `false`, default: `true`)
- `SESSION_TTL_MS` (default: `900000`)
- `SCREENSHOT_DIR` (default: `./artifacts/screenshots`)
- `AGENT_SHARED_TOKEN` (required in non-local environments)

## Local run

```bash
npm install
npm run dev
```

## Internal API

- `GET /health`
- `POST /internal/sessions`
- `POST /internal/sessions/:sessionId/execute`
- `GET /internal/sessions/:sessionId/state`
- `POST /internal/sessions/:sessionId/close`
