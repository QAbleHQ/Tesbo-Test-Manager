# Action Contract (MVP)

This contract is shared between TesboX backend and `Tesbo-Automation-Agents` / `Tesbo-Test-Runner-Agents`.

## ActionPlan

```json
{
  "commandId": "uuid",
  "steps": [
    {
      "id": "step-1",
      "action": "navigate|click|type",
      "url": "https://example.com",
      "selector": "input[name='email']",
      "value": "user@example.com",
      "timeoutMs": 10000
    }
  ]
}
```

## StepResult

```json
{
  "commandId": "uuid",
  "stepId": "step-1",
  "action": "click",
  "status": "passed|failed",
  "currentUrl": "https://example.com/dashboard",
  "selectorUsed": "button[type='submit']",
  "message": "Clicked submit button",
  "screenshotPath": "/abs/path/to/screenshot.png",
  "durationMs": 321
}
```

## SessionStreamEvent

```json
{
  "sessionId": "uuid",
  "type": "step_started|step_finished|step_failed|snapshot",
  "commandId": "uuid",
  "stepId": "step-1",
  "currentUrl": "https://example.com",
  "screenshotPath": "/abs/path/to/screenshot.png",
  "createdAt": "2026-02-23T10:00:00Z"
}
```
