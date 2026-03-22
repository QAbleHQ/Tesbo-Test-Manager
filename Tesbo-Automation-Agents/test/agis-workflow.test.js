import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildAgisRunContext,
  evaluateActionImpact,
  createActionRecord,
  createPageKnowledgeEntry,
  validateExecutionArtifacts,
} from "../src/telemetry/workflow.js";

describe("agis workflow contracts", () => {
  it("builds a run context with planned steps", () => {
    const context = buildAgisRunContext({
      sessionId: "run-1",
      commandId: "cmd-1",
      objective: "Verify login then open dashboard",
      currentUrl: "https://app.example.com/login",
      plan: [{ stepId: "step-1", instruction: "Open login page" }],
    });
    assert.strictEqual(context.runId, "run-1");
    assert.strictEqual(context.planSteps.length, 1);
    assert.strictEqual(context.status, "running");
  });

  it("evaluates action impact and asks recovery on failures", () => {
    const evaluation = evaluateActionImpact({
      instruction: "Click Login",
      objective: "Login and verify dashboard",
      beforeUrl: "https://app.example.com/login",
      afterUrl: "https://app.example.com/login",
      beforeSnapshot: { title: "Login", text: "Email Password Sign in" },
      afterSnapshot: { title: "Login", text: "Email Password Sign in" },
      success: false,
      error: "Element not found",
    });
    assert.strictEqual(evaluation.nextStepDecision, "recover");
    assert.strictEqual(evaluation.confidence, "low");
  });

  it("creates action records with before/after evidence", () => {
    const record = createActionRecord({
      runId: "run-1",
      stepId: "step-1",
      screenId: "screen-1",
      actionType: "click",
      instruction: "Click Sign in",
      targetElement: "Sign in button",
      locatorUsed: "page.getByRole('button', { name: 'Sign in' })",
      beforeScreenshot: "/tmp/before.png",
      afterScreenshot: "/tmp/after.png",
      beforeSnapshot: { elements: [{ ref: 1, tag: "button", text: "Sign in", selectorHint: "#signin" }] },
      afterSnapshot: { elements: [{ ref: 2, tag: "h1", text: "Dashboard", selectorHint: null }] },
      result: "passed",
      urlBefore: "https://app.example.com/login",
      urlAfter: "https://app.example.com/dashboard",
      evaluation: {
        goalMatchScore: 0.9,
        expectedOutcomeMatch: true,
        stateChangeDetected: true,
        confidence: "high",
        risk: "low",
        issues: [],
        nextStepDecision: "continue",
      },
    });
    assert.strictEqual(record.result, "passed");
    assert.strictEqual(record.domBeforeKeyElements.length, 1);
    assert.strictEqual(record.domAfterKeyElements.length, 1);
  });

  it("creates page knowledge entries with important elements", () => {
    const entry = createPageKnowledgeEntry({
      pageId: "screen-1",
      url: "https://app.example.com/reports/123",
      title: "Reports",
      snapshot: {
        title: "Reports",
        headings: ["Reports"],
        elements: [
          { tag: "button", text: "Create report", selectorHint: "#create-report", attrs: {} },
          { tag: "input", text: "", selectorHint: "#search", attrs: { placeholder: "Search" } },
        ],
      },
      screenshotPath: "/tmp/reports.png",
    });
    assert.strictEqual(entry.pageUrlPattern, "https://app.example.com/reports/:id");
    assert.ok(entry.importantElements.length >= 2);
  });

  it("validates quality gates for deterministic output", () => {
    const checks = validateExecutionArtifacts({
      actionRecords: [{
        beforeScreenshot: "/tmp/a.png",
        afterScreenshot: "/tmp/b.png",
        domBeforeKeyElements: [{}],
        domAfterKeyElements: [{}],
      }],
      recordedScript: "await page.goto('https://app.example.com');",
    });
    const deterministic = checks.find((c) => c.key === "deterministic_script_ready");
    assert.ok(deterministic);
    assert.strictEqual(deterministic.passed, true);
  });
});
