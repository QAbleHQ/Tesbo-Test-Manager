import { describe, it } from "node:test";
import assert from "node:assert";
import { compileTelemetryToActions, compileTelemetryToPlaywright, stagehandActionsToTelemetryLike } from "../src/telemetry/compiler.js";

describe("compileTelemetryToActions", () => {
  it("converts act events with click to getByRole", () => {
    const events = [
      {
        eventType: "act",
        success: true,
        actions: [{ method: "click", description: "Login button", selector: "xpath=/foo" }],
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].playwright.includes("getByRole"));
    assert.ok(actions[0].playwright.includes("Login"));
  });

  it("converts act events with fill to getByLabel", () => {
    const events = [
      {
        eventType: "act",
        success: true,
        actions: [
          {
            method: "fill",
            description: "Email",
            selector: "xpath=/input",
            arguments: ["user@test.com"],
          },
        ],
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].playwright.includes("getByLabel") || actions[0].playwright.includes("getByPlaceholder"));
    assert.ok(actions[0].playwright.includes("user@test.com"));
  });

  it("converts scroll to mouse.wheel", () => {
    const events = [
      {
        eventType: "act",
        success: true,
        actions: [{ method: "scroll", description: "scroll down", selector: "" }],
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].playwright.includes("mouse.wheel"));
  });

  it("converts scrollTo to mouse.wheel", () => {
    const events = [
      {
        eventType: "act",
        success: true,
        actions: [{ method: "scrollTo", description: "scroll to element", selector: "xpath=/html/body" }],
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].playwright.includes("mouse.wheel"));
  });

  it("emits playwright from xpath selector when description is minimal", () => {
    const events = [
      {
        eventType: "act",
        success: true,
        actions: [
          {
            method: "hover",
            description: "x",
            selector: "xpath=/html[1]/body[1]/div[1]",
            arguments: [],
          },
        ],
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.strictEqual(actions.length, 1);
    assert.ok(actions[0].playwright.includes(".hover()"));
  });

  it("converts extract to assertions", () => {
    const events = [
      {
        eventType: "extract",
        result: { heading: "Welcome", extraction: "Success" },
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.ok(actions.length >= 1);
    assert.ok(actions.some((a) => a.playwright && a.playwright.includes("expect")));
  });

  it("skips failed act events", () => {
    const events = [
      {
        eventType: "act",
        success: false,
        actions: [{ method: "click", description: "Broken", selector: "xpath=/x" }],
      },
    ];
    const actions = compileTelemetryToActions(events);
    assert.strictEqual(actions.length, 0);
  });
});

describe("compileTelemetryToPlaywright", () => {
  it("produces valid test structure", () => {
    const events = [
      {
        eventType: "act",
        success: true,
        actions: [{ method: "click", description: "Submit", selector: "xpath=/btn" }],
      },
    ];
    const script = compileTelemetryToPlaywright(events, { scenario: "Golden test" });
    assert.ok(script.includes("import { test, expect }"));
    assert.ok(script.includes("test('Golden test'"));
    assert.ok(script.includes("getByRole") || script.includes("getByText"));
    assert.ok(script.includes("toHaveURL"));
  });
});

describe("stagehandActionsToTelemetryLike", () => {
  it("converts normalized actions to telemetry-like events", () => {
    const actions = [
      { type: "wait", action: "wait", timeMs: 2000 },
      { type: "act", action: "click", targetDescription: "Button" },
    ];
    const events = stagehandActionsToTelemetryLike(actions);
    assert.ok(events.length >= 1);
  });
});
