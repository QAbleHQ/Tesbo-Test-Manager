# Telemetry-Driven Autonomous Automation

Agis uses a telemetry-driven architecture to produce reliable Playwright scripts.

## Flow

1. **Planner** (`planScenario`) – Parses scenario text into atomic steps
2. **Executor** (`executeScenarioWithTelemetry`) – For each step:
   - `observe(instruction)` → get candidates
   - `act(candidate | instruction)` → execute
   - `extract(instruction)` → for assertions
3. **Compiler** (`compileTelemetryToActions`) – Converts telemetry events to Playwright with locator priority:
   - data-testid > role+name > label > placeholder > text > css > xpath
4. **Validator** – Replay generated script via `runPlaywrightScript`

## Schema

All events include: `runId`, `stepId`, `timestamp`, `url`, `eventType`.

- `observe` – candidates, chosenIndex, chosenReason
- `act` – success, actions[], screenshots, elapsedMs
- `extract` – result, usage (assertion | dynamic_test_data)
- `browser_context` – navigation, dialogs, console errors

## Usage

```javascript
import { executeScenarioWithTelemetry, planScenario } from "./telemetry/executor.js";
import { compileTelemetryToPlaywright } from "./telemetry/compiler.js";

const { events, stagehandActions } = await executeScenarioWithTelemetry(session, scenario);
const script = compileTelemetryToPlaywright(events, { scenario: "My test" });
```

## Integration

- `executeStagehandWithTelemetry` in stagehandSession.js is the default path for autonomous runs
- Falls back to `executeStagehandObjective` (agent mode) when plan is empty or telemetry fails
