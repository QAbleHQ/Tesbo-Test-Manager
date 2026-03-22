# MVP Validation and Phase 2 Rollout Criteria

## End-to-end checks completed

- Backend compiles successfully with new automation session services and handlers.
- Automation-agent runtime passes JavaScript syntax checks.
- Frontend automation workspace route compiles in lint scope (repo has existing unrelated lint errors).

## Manual validation checklist

1. Open a testcase and click `Automate`.
2. Confirm a new automation session is created.
3. Send command: `navigate to https://example.com`.
4. Verify timeline receives command and step events.
5. Verify browser pane shows a refreshed screenshot and URL updates.
6. Send login intent without credentials and verify clarification question is returned.
7. Send credential command in requested format and verify execution occurs.
8. Click `Save Script` and confirm testcase is marked `Automated`.
9. Confirm script is persisted in testcase automation fields.
10. Cancel a second session and confirm status changes to `cancelled`.

## Phase 2 readiness criteria

- Session success rate >= 90% for MVP action set (`navigate`, `click`, `type`).
- Stream disconnected state < 5% of active sessions.
- Median command-to-step completion < 3 seconds for simple actions.
- No cross-project session data leakage in audit review.
- Retry and timeout behavior validated against at least 20 flaky selector scenarios.
