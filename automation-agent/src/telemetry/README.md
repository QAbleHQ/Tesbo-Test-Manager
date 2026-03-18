# Telemetry-Driven Autonomous Automation

Agis uses a telemetry-driven architecture to produce reliable Playwright scripts.

## Flow

1. **Planner** (`planScenario`) – Parses scenario text into atomic steps
2. **Executor** (`executeAgentWithTelemetry` in langchainAgent.js) – For each step:
   - DOM snapshot via `getInteractiveDOM()` → simplified page view for LLM
   - LLM reasoning → identify element and action
   - Playwright action → execute directly via page API
3. **Compiler** (`compileTelemetryToActions`) – Converts telemetry events to Playwright with locator priority:
   - data-testid > role+name > label > placeholder > text > css > xpath
4. **Validator** – Replay generated script via `runPlaywrightScript`

## Schema

All events include: `runId`, `stepId`, `timestamp`, `url`, `eventType`.

- `act` – success, actions[], screenshots, elapsedMs
- `extract` – result, usage (assertion | dynamic_test_data)
- `browser_context` – navigation, dialogs, console errors

## Usage

```javascript
import { planScenario } from "./telemetry/executor.js";
import { compileTelemetryToPlaywright } from "./telemetry/compiler.js";
import { createAgentSession, executeAgentWithTelemetry } from "./langchainAgent.js";

const session = await createAgentSession(sessionId, startUrl, modelConfig);
const result = await executeAgentWithTelemetry(session, commandId, objective);
const script = compileTelemetryToPlaywright(result.telemetryEvents, { scenario: "My test" });
```

## Integration

- `executeAgentWithTelemetry` in langchainAgent.js is the default path for autonomous runs
- Falls back to `executeAgentObjective` (LangGraph ReAct agent mode) when plan is empty or telemetry fails
