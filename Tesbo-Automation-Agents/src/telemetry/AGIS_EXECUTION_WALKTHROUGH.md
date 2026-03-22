# AgiS Execution Walkthrough

This walkthrough demonstrates how the implementation runs in two scenarios:

- multiple actions on a single screen
- actions across multiple screens

## 1) Single-screen scenario

Test intent: update a profile name on one settings page and verify success banner.

1. `OpenBrowserWithGivenURL` opens the settings URL.
2. `ObservePageAndIntent` captures a screenshot and DOM snapshot.
3. `PlanStepsOnCurrentScreen` schedules `type` then `click` on the same screen.
4. `PerformUIAction` executes `type` into the profile name field.
5. `RecordActionDOMScreenshot` stores before/after screenshots and key DOM elements.
6. `EvaluateActionImpactAgainstGoal` checks state changes and goal progress.
7. `DefineNextStep` schedules click of Save button.
8. After Save, validation confirms success toast/banner and marks run complete.

## 2) Multi-screen scenario

Test intent: log in, navigate to dashboard, open reports, verify report widget.

1. `OpenBrowserWithGivenURL` opens login page.
2. `ObservePageAndIntent` captures login page details into knowledge base.
3. `PlanStepsOnCurrentScreen` creates login actions.
4. `PerformUIAction` runs fill and submit.
5. URL changes to dashboard, creating a new `screenId`.
6. Agent replans on dashboard and clicks Reports.
7. URL changes again; page context and key elements are captured for reports screen.
8. Assertion step validates report widget visibility.

## Validation checklist used by implementation

- Every action has before/after evidence (`screenshot + key DOM`)
- Every step stores action evaluation (`goalMatchScore`, `nextStepDecision`, `confidence`)
- Multi-screen transitions are tracked by `screenId` changes
- Recorded Playwright output must include executable `await` actions
