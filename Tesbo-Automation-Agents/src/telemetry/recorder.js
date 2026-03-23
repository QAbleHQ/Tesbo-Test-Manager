/**
 * ActionRecorder – single unified timeline that captures every agent
 * interaction: reasoning, browser actions, extractions, and results.
 *
 * Replaces the old 3-channel approach (events + directActions + reasoningLog)
 * with one chronologically ordered timeline array.
 *
 * Every entry has:
 *   { seq, kind, ts, stepId?, url?, ...kind-specific fields }
 *
 * Kinds:
 *   "action"    – browser action with playwright code
 *   "reasoning" – AI model thinking/analysis text
 *   "result"    – extraction data, completion, or assertion outcomes
 */
import { randomUUID } from "node:crypto";

const RECORDING_STATES = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  PAUSED: "paused",
  STOPPED: "stopped",
});

export class ActionRecorder {
  /**
   * @param {object} [options]
   * @param {string} [options.runId]
   * @param {string} [options.scenarioName]
   * @param {number} [options.maxEntries] - Cap on timeline entries (default 10 000)
   */
  constructor({ runId, scenarioName, maxEntries } = {}) {
    this.runId = runId || randomUUID();
    this.scenarioName = scenarioName || "recorded automation test";
    this.maxEntries = maxEntries || 10000;

    /** @type {object[]} unified chronological timeline */
    this._timeline = [];

    this._state = RECORDING_STATES.IDLE;
    this._startedAt = null;
    this._stoppedAt = null;
    this._scriptCache = null;
  }

  get state() {
    return this._state;
  }

  get isRecording() {
    return this._state === RECORDING_STATES.RECORDING;
  }

  get entryCount() {
    return this._timeline.length;
  }

  start() {
    if (this._state === RECORDING_STATES.STOPPED) {
      throw new Error("Cannot restart a stopped recorder – create a new instance");
    }
    this._state = RECORDING_STATES.RECORDING;
    this._startedAt = this._startedAt || new Date().toISOString();
    this._scriptCache = null;
  }

  pause() {
    if (this._state === RECORDING_STATES.RECORDING) {
      this._state = RECORDING_STATES.PAUSED;
    }
  }

  resume() {
    if (this._state === RECORDING_STATES.PAUSED) {
      this._state = RECORDING_STATES.RECORDING;
    }
  }

  stop() {
    this._state = RECORDING_STATES.STOPPED;
    this._stoppedAt = new Date().toISOString();
    this._scriptCache = null;
  }

  /** @private Push one entry to the timeline. */
  _push(kind, data) {
    if (this._state !== RECORDING_STATES.RECORDING) return;
    if (this._timeline.length >= this.maxEntries) return;

    this._timeline.push({
      seq: this._timeline.length,
      kind,
      ts: new Date().toISOString(),
      ...data,
    });
    this._scriptCache = null;
  }

  /**
   * Record a browser action (click, type, navigate, wait, etc.).
   * @param {object} entry
   * @param {string} entry.tool       - Original tool name (click, fillFormVision, wait, etc.)
   * @param {string} entry.action     - Normalized action (click, type, navigate, wait, press, scroll, assert_visible)
   * @param {string} entry.playwright - Playwright code line
   * @param {string} [entry.target]   - Element description / label
   * @param {string} [entry.value]    - Input value (for type actions)
   * @param {string} [entry.description]
   * @param {string} [entry.stepId]
   * @param {string} [entry.url]
   */
  recordAction({ tool, action, playwright, target, value, description, stepId, url, ...extra }) {
    if (!playwright) return;
    this._push("action", {
      tool: tool || null,
      action: action || "act",
      playwright,
      target: target || null,
      value: value || null,
      description: description || null,
      stepId: stepId || null,
      url: url || null,
      ...extra,
    });
  }

  /**
   * Record AI reasoning / thinking text.
   * @param {string} text
   * @param {object} [meta]
   */
  recordReasoning(text, { stepId, url, toolName } = {}) {
    if (!text || typeof text !== "string") return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this._push("reasoning", {
      text: trimmed,
      stepId: stepId || null,
      url: url || null,
      toolName: toolName || null,
    });
  }

  /**
   * Record an extraction / completion result.
   * @param {object} entry
   */
  recordResult({ tool, data, message, assertions, stepId, url } = {}) {
    this._push("result", {
      tool: tool || null,
      data: data || null,
      message: message || null,
      assertions: assertions || [],
      stepId: stepId || null,
      url: url || null,
    });
  }

  /**
   * Legacy compat: record a telemetry event from the step-by-step executor.
   * Converts the event into a unified timeline entry.
   */
  record(event) {
    if (this._state !== RECORDING_STATES.RECORDING) return;
    if (!event || typeof event !== "object") return;

    const eventType = String(event.eventType || "").toLowerCase();

    if (eventType === "observe") {
      return;
    }

    if (eventType === "act") {
      this._push("action", {
        tool: "act",
        action: "act",
        playwright: null,
        target: event.instruction || null,
        description: event.actionDescription || event.instruction || null,
        stepId: event.stepId || null,
        url: event.url || null,
        success: event.success,
        _raw: event,
      });
      return;
    }

    if (eventType === "extract") {
      this._push("result", {
        tool: "extract",
        data: event.result || null,
        stepId: event.stepId || null,
        url: event.url || null,
      });
      return;
    }

    if (eventType === "navigate") {
      this._push("action", {
        tool: "navigate",
        action: "navigate",
        playwright: event.url ? `await page.goto('${esc(event.url)}');` : null,
        target: event.url || null,
        stepId: event.stepId || null,
        url: event.url || null,
      });
    }
  }

  /** Read-only copy of the full timeline. */
  getTimeline() {
    return [...this._timeline];
  }

  /** Get only action entries that have playwright code. */
  getActions() {
    return this._timeline.filter((e) => e.kind === "action" && e.playwright);
  }

  /** Get only reasoning entries. */
  getReasoningLog() {
    return this._timeline.filter((e) => e.kind === "reasoning");
  }

  /**
   * Compile the timeline into a Playwright TypeScript test spec.
   */
  toPlaywrightScript(options = {}) {
    const scenario = options.scenario || this.scenarioName;
    const addHeader = options.addHeader !== false;

    if (this._scriptCache && !options.scenario) return this._scriptCache;

    const actions = this.getActions();
    const lines = actions.map((a) => `  ${a.playwright}`);

    if (lines.length === 0) {
      lines.push("  // No deterministic Playwright actions recorded.");
    } else {
      lines.push("  await expect(page).toHaveURL(/.*/);");
    }

    const header = addHeader
      ? `import { test, expect } from '@playwright/test';\n\ntest('${esc(scenario)}', async ({ page }) => {\n`
      : "";
    const footer = `\n});`;
    const script = header + lines.join("\n") + footer;

    if (!options.scenario) {
      this._scriptCache = script;
    }
    return script;
  }

  /**
   * Serialise recorder state for persistence or transfer.
   */
  toJSON() {
    return {
      runId: this.runId,
      scenarioName: this.scenarioName,
      state: this._state,
      startedAt: this._startedAt,
      stoppedAt: this._stoppedAt,
      timeline: this._timeline,
      stats: this.getSummary(),
    };
  }

  /**
   * Restore a recorder from a serialised snapshot.
   */
  static fromJSON(data) {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid recorder snapshot");
    }
    const recorder = new ActionRecorder({
      runId: data.runId,
      scenarioName: data.scenarioName,
      maxEntries: data.maxEntries,
    });
    recorder._state = data.state || RECORDING_STATES.STOPPED;
    recorder._startedAt = data.startedAt || null;
    recorder._stoppedAt = data.stoppedAt || null;
    recorder._timeline = Array.isArray(data.timeline) ? data.timeline : [];
    return recorder;
  }

  /**
   * Summary stats computed from the unified timeline.
   */
  getSummary() {
    const actions = this._timeline.filter((e) => e.kind === "action");
    const reasoning = this._timeline.filter((e) => e.kind === "reasoning");
    const results = this._timeline.filter((e) => e.kind === "result");

    return {
      totalEntries: this._timeline.length,
      actionCount: actions.length,
      reasoningCount: reasoning.length,
      resultCount: results.length,
      clickCount: actions.filter((a) => a.action === "click").length,
      typeCount: actions.filter((a) => a.action === "type").length,
      navigateCount: actions.filter((a) => a.action === "navigate").length,
      waitCount: actions.filter((a) => a.action === "wait").length,
      pressCount: actions.filter((a) => a.action === "press").length,
      scrollCount: actions.filter((a) => a.action === "scroll").length,
      assertCount: actions.filter((a) => typeof a.action === "string" && a.action.startsWith("assert")).length,
      playwrightLineCount: actions.filter((a) => a.playwright).length,
    };
  }
}

function esc(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
