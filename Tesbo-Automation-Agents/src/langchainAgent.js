/**
 * LangChain/LangGraph-powered agent for browser automation.
 * Uses plain Playwright for all browser control
 * and LangChain for LLM reasoning.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";
import { planScenario } from "./telemetry/executor.js";
import { compileTelemetryToActions } from "./telemetry/compiler.js";
import { BrowserRecorder } from "./telemetry/browserRecorder.js";
import {
  buildAgisRunContext,
  evaluateActionImpact,
  createActionRecord,
  createPageKnowledgeEntry,
  mergePageKnowledgeEntries,
  validateExecutionArtifacts,
  buildExecutionWalkthrough,
} from "./telemetry/workflow.js";
import { buildPlaywrightTools } from "./playwrightTools.js";
import { getInteractiveDOM, getPageText, getDomSummary } from "./domSnapshot.js";

const DEFAULT_VIEWPORT = { width: 1366, height: 768 };

const AGENT_SYSTEM_PROMPT = `You are an expert browser automation agent. You navigate web applications and perform actions to achieve objectives.

RULES:
1. Always call get_page_content first to understand the current page before acting.
2. Use click_element with the visible text/label of the element you want to click.
3. Use type_text with the field label/placeholder and the text to enter.
4. After completing all steps, verify the result with assert_visible if appropriate.
5. If an action fails, try alternative approaches (different element descriptions, scrolling, waiting).
6. For login flows, fill each field individually then click the submit button.
7. Do NOT guess — always observe the page first.

LOCATOR STRATEGY:
- Prefer visible text labels, button text, and accessible names.
- For form fields, use the label text or placeholder text.
- Avoid CSS selectors or XPath — use human-readable descriptions.`;

function nowIso() {
  return new Date().toISOString();
}

async function ensureScreenshotDir() {
  await fs.mkdir(config.screenshotDir, { recursive: true });
}

async function ensureVideoDir() {
  if (!config.recordVideo) return;
  await fs.mkdir(config.videoDir, { recursive: true });
}

async function takeScreenshot(page, sessionId, prefix = "") {
  const normalizedPrefix = String(prefix || "").trim();
  const fileName = normalizedPrefix
    ? `${sessionId}-${normalizedPrefix}-${Date.now()}.png`
    : `${sessionId}-${Date.now()}.png`;
  const outputPath = path.join(config.screenshotDir, fileName);
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}

/**
 * Create an LLM instance based on provider config.
 */
function createLLM(modelConfig) {
  const provider = (modelConfig.provider || "openai").toLowerCase();
  const apiKey = modelConfig.apiKey;
  let modelName = modelConfig.model || "";

  if (modelName.includes("/")) {
    modelName = modelName.split("/").slice(1).join("/");
  }

  if (provider === "anthropic") {
    return new ChatAnthropic({
      model: modelName || "claude-sonnet-4-5-20250929",
      anthropicApiKey: apiKey,
      temperature: 0,
      maxTokens: 4096,
    });
  }

  return new ChatOpenAI({
    model: modelName || "gpt-4o",
    openAIApiKey: apiKey,
    temperature: 0,
  });
}

/**
 * Create an agent session with plain Playwright + LangChain LLM config.
 */
export async function createAgentSession(sessionId, startUrl, modelConfig) {
  if (!modelConfig?.apiKey) {
    throw new Error("LLM API key is required for agent sessions. Set project AI settings (OpenAI or Anthropic API key).");
  }

  await ensureScreenshotDir();
  await ensureVideoDir();

  const browser = await chromium.launch({ headless: config.headless });
  const contextOptions = {
    viewport: DEFAULT_VIEWPORT,
  };
  if (config.recordVideo) {
    contextOptions.recordVideo = {
      dir: config.videoDir,
      size: DEFAULT_VIEWPORT,
    };
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  if (startUrl && startUrl.trim()) {
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (err) {
      logError("agent_start_url_failed", { sessionId, startUrl, error: String(err) });
      try {
        await page.goto(startUrl, { waitUntil: "load", timeout: 60000 });
      } catch {
        // Continue with whatever page we have
      }
    }
  }

  const llm = createLLM(modelConfig);

  const browserRecorder = new BrowserRecorder({ sessionId });
  let browserRecorderAttached = false;
  try {
    await browserRecorder.attach(page);
    browserRecorderAttached = true;
  } catch (err) {
    logError("browser_recorder_attach_failed", { sessionId, error: String(err) });
  }

  let screenshotPath = null;
  try {
    screenshotPath = await takeScreenshot(page, sessionId);
  } catch {
    // Non-fatal
  }

  const state = {
    id: sessionId,
    type: "agent",
    browser,
    context,
    page,
    llm,
    currentUrl: page.url(),
    lastScreenshotPath: screenshotPath,
    lastVideoPath: null,
    lastTracePath: null,
    events: [],
    agentLogs: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    modelConfig: {
      provider: (modelConfig.provider || "openai").toLowerCase(),
      apiKey: modelConfig.apiKey,
      model: modelConfig.model || "",
    },
    browserRecorder: browserRecorderAttached ? browserRecorder : null,
  };

  if (typeof context.on === "function") {
    context.on("page", (newPage) => {
      logInfo("agent_popup_detected", { sessionId, url: newPage.url() });
      state.page = newPage;
      state.currentUrl = newPage.url();
      state.updatedAt = nowIso();
    });
  }
  state._popupListenerAttached = true;

  logInfo("agent_session_created", { sessionId, provider: state.modelConfig.provider });
  return state;
}

/**
 * Execute using the telemetry-driven flow: plan steps → for each step use
 * DOM snapshot + LLM to identify element → execute via Playwright.
 */
export async function executeAgentWithTelemetry(session, commandId, objective) {
  if (session.type !== "agent" || !session.llm) {
    throw new Error("Session is not an agent session");
  }

  const pushSessionEvent = (eventData) => {
    if (!session.events) session.events = [];
    session.events.push({ ...eventData, createdAt: nowIso() });
    if (session.events.length > 2000) {
      session.events.splice(0, session.events.length - 2000);
    }
    session.updatedAt = nowIso();
  };

  const plan = planScenario(objective);
  if (plan.length === 0) {
    return executeAgentObjective(session, commandId, objective);
  }

  const runContext = buildAgisRunContext({
    sessionId: session.id,
    commandId,
    objective,
    currentUrl: session.page.url(),
    plan,
    status: "running",
  });
  const workflowStates = ["InitSession", "OpenBrowserWithGivenURL", "ObservePageAndIntent"];
  const actionRecords = [];
  let pageKnowledgeBase = [];
  let screenCounter = 1;

  pushSessionEvent({
    type: "agent_reasoning",
    commandId,
    stepIndex: 0,
    reasoning: `Planned ${plan.length} steps for execution`,
    url: session.page.url(),
    plan: plan.map((s, i) => ({ index: i + 1, instruction: s.instruction })),
  });

  const events = [];
  const results = [];
  let allSuccess = true;

  try {
    for (let idx = 0; idx < plan.length; idx++) {
      const { stepId, instruction } = plan[idx];
      const preUrl = session.page.url();
      const beforeSnapshot = await getInteractiveDOM(session.page);
      const beforeScreenshot = await takeScreenshot(session.page, session.id, `before-${idx + 1}`);
      const screenId = `screen-${screenCounter}`;
      workflowStates.push("PlanStepsOnCurrentScreen", "InspectDOMForTargets", "PerformUIAction");

      pageKnowledgeBase = mergePageKnowledgeEntries(
        pageKnowledgeBase,
        createPageKnowledgeEntry({
          pageId: screenId,
          url: preUrl,
          title: beforeSnapshot.title,
          snapshot: beforeSnapshot,
          screenshotPath: beforeScreenshot,
        })
      );

      pushSessionEvent({
        type: "agent_reasoning",
        commandId,
        stepIndex: idx + 1,
        reasoning: `Step ${idx + 1}/${plan.length}: ${instruction}`,
        url: session.page.url(),
      });

      let stepResult = null;
      let finalInstruction = instruction;
      let finalError = null;
      let attempt = 0;
      const maxAttempts = 2;
      let postUrl = preUrl;
      let afterSnapshot = beforeSnapshot;
      let afterScreenshot = null;
      let evaluation = null;
      let nextDecision = "continue";

      while (attempt < maxAttempts) {
        attempt += 1;
        stepResult = await executeStepWithLLM(session, stepId, finalInstruction, events);
        postUrl = session.page.url();
        afterSnapshot = await getInteractiveDOM(session.page);
        afterScreenshot = await takeScreenshot(session.page, session.id, `after-${idx + 1}-attempt-${attempt}`);
        workflowStates.push("RecordActionDOMScreenshot", "EvaluateActionImpactAgainstGoal");

        evaluation = evaluateActionImpact({
          instruction: finalInstruction,
          objective,
          beforeUrl: preUrl,
          afterUrl: postUrl,
          beforeSnapshot,
          afterSnapshot,
          success: stepResult.success,
          error: stepResult.error,
        });
        nextDecision = evaluation.nextStepDecision;

        const primaryAction = Array.isArray(stepResult.actions) ? stepResult.actions[0] : null;
        actionRecords.push(
          createActionRecord({
            runId: session.id,
            stepId,
            screenId,
            actionType: primaryAction?.method || (stepResult.success ? "act" : "act_failed"),
            instruction: finalInstruction,
            targetElement: primaryAction?.description || finalInstruction,
            locatorUsed: primaryAction?.selector || "",
            inputValue: Array.isArray(primaryAction?.arguments) ? String(primaryAction.arguments[0] || "") : "",
            beforeScreenshot,
            afterScreenshot,
            beforeSnapshot,
            afterSnapshot,
            result: stepResult.success ? "passed" : "failed",
            urlBefore: preUrl,
            urlAfter: postUrl,
            evaluation,
          })
        );

        pageKnowledgeBase = mergePageKnowledgeEntries(
          pageKnowledgeBase,
          createPageKnowledgeEntry({
            pageId: `screen-${screenCounter}`,
            url: postUrl,
            title: afterSnapshot.title,
            snapshot: afterSnapshot,
            screenshotPath: afterScreenshot,
          })
        );

        if (preUrl !== postUrl) {
          screenCounter += 1;
          workflowStates.push("DefineNextStep");
        }

        if (stepResult.success && nextDecision !== "recover") {
          break;
        }

        finalError = stepResult.error || "Action did not achieve expected outcome";
        if (attempt < maxAttempts) {
          workflowStates.push("BacktrackAndTryNewApproach");
          finalInstruction = `${instruction}. Alternative approach: inspect nearby controls, then retry with a different actionable element.`;
          pushSessionEvent({
            type: "agent_reasoning",
            commandId,
            stepIndex: idx + 1,
            reasoning: `Recovery attempt ${attempt + 1}/${maxAttempts} for step ${stepId}: ${instruction}`,
            url: session.page.url(),
          });
        }
      }

      if (!stepResult) {
        stepResult = { success: false, error: "Step was not executed", actions: [] };
      }

      results.push({ stepId, instruction, ...stepResult });

      pushSessionEvent({
        type: "agent_action",
        commandId,
        stepIndex: idx + 1,
        toolName: stepResult.success ? "act" : "act_failed",
        args: { instruction },
        reasoning: stepResult.success
          ? `Completed: ${instruction}`
          : `Failed: ${finalError || stepResult.error || instruction}`,
        url: session.page.url(),
        success: stepResult.success,
      });

      if (!stepResult.success) {
        allSuccess = false;
      }
    }

    session.currentUrl = session.page.url();
    session.updatedAt = nowIso();

    // Allow BrowserRecorder's pending input flush (600ms timer) to complete
    await new Promise((r) => setTimeout(r, 800));

    let screenshotPath = session.lastScreenshotPath;
    try {
      screenshotPath = await takeScreenshot(session.page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      // keep existing
    }

    const compiledActions = events.length > 0 ? compileTelemetryToActions(events) : [];

    const stepResults = results.map((r, i) => ({
      commandId,
      stepId: r.stepId || `step-${i + 1}`,
      action: r.success ? "act" : "agent_execute",
      status: r.success ? "passed" : "failed",
      currentUrl: session.currentUrl,
      selectorUsed: null,
      message: r.instruction || (r.success ? "Executed" : r.error),
      screenshotPath: i === results.length - 1 ? screenshotPath : null,
      durationMs: 0,
    }));

    if (stepResults.length === 0) {
      stepResults.push({
        commandId,
        stepId: "step-1",
        action: "agent_execute",
        status: allSuccess ? "passed" : "failed",
        currentUrl: session.currentUrl,
        message: "Agent execution completed",
        screenshotPath,
        durationMs: 0,
      });
    }

    const browserRec = session.browserRecorder;
    if (browserRec) browserRec.stop();

    const browserPlaywrightActions = browserRec ? browserRec.getPlaywrightActions() : [];

    const qualityGates = validateExecutionArtifacts({
      actionRecords,
      recordedScript: browserRec ? browserRec.toPlaywrightScript() : "",
    });
    const walkthrough = buildExecutionWalkthrough({ actionRecords });
    const runContextStatus = allSuccess
      ? "completed"
      : actionRecords.length > 0
        ? "partial"
        : "failed";
    runContext.status = runContextStatus;
    workflowStates.push("CompleteRunAndExportTrace");

    const returnTelemetry = {
      commandId,
      currentUrl: session.currentUrl,
      results: stepResults,
      agentActions: browserPlaywrightActions.length > 0
        ? browserPlaywrightActions.map((ba) => ({
            type: ba.action === "scroll" ? "scroll" : ba.action === "navigate" ? "navigate" : "act",
            action: ba.action || "act",
            instruction: ba.target || "",
            targetDescription: ba.target || "",
            value: ba.value || "",
            description: ba.target ? `${ba.action}: ${ba.target}` : ba.action,
            playwright: ba.playwright || "",
            selector: ba.selector || "",
            selectorMethod: ba.selectorMethod || "unknown",
          }))
        : compiledActions,
      telemetryEvents: events,
      telemetryPlan: plan,
      completed: allSuccess,
      recordedScript: browserRec
        ? browserRec.toPlaywrightScript()
        : "// No browser recording available",
      agisWorkflow: {
        runContext,
        stateTransitions: workflowStates,
        actionRecords,
        pageKnowledgeBase: {
          pages: pageKnowledgeBase,
          editablePageDescriptions: pageKnowledgeBase.map((entry) => ({
            pageId: entry.pageId,
            pageDescriptionEditable: entry.pageDescriptionEditable,
          })),
        },
        qualityGates,
        walkthrough,
      },
    };
    if (browserRec) {
      returnTelemetry.browserRecording = browserRec.toJSON();
    }
    return returnTelemetry;
  } catch (err) {
    const browserRecErr = session.browserRecorder;
    if (browserRecErr) browserRecErr.stop();
    logError("agent_telemetry_failed", { sessionId: session.id, error: String(err) });
    return executeAgentObjective(session, commandId, objective);
  }
}

/**
 * Execute a single step using DOM snapshot + LLM element identification + Playwright action.
 * Records telemetry events compatible with the existing compiler.
 */
async function executeStepWithLLM(session, stepId, instruction, events) {
  const { page, llm } = session;
  const url = page.url();
  const startTime = Date.now();

  const isAssertion = /\b(verify|assert|check|confirm|ensure|validate|extract|get|read)\b/i.test(instruction);

  if (isAssertion) {
    return executeAssertionStepWithLLM(session, stepId, instruction, events);
  }

  try {
    const snapshot = await getInteractiveDOM(page);

    const prompt = `Given this page state:
${snapshot.text}

Execute this instruction: "${instruction}"

Respond with a JSON object describing the action:
{
  "action": "click" | "type" | "navigate" | "press" | "scroll" | "select",
  "ref": <element ref number from the list above>,
  "value": "<text to type, if action is 'type' or 'select'>",
  "url": "<URL if action is 'navigate'>",
  "key": "<key name if action is 'press'>",
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, nothing else.`;

    const response = await llm.invoke([new HumanMessage(prompt)]);
    const responseText = typeof response.content === "string" ? response.content : "";

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM did not return valid JSON for step action");
    }

    const actionPlan = JSON.parse(jsonMatch[0]);
    const element = actionPlan.ref ? snapshot.elements.find((e) => e.ref === actionPlan.ref) : null;
    const target = element?.text || element?.attrs?.["aria-label"] || element?.attrs?.placeholder || element?.selectorHint || instruction;

    let actSuccess = false;
    let actError = null;
    const urlBefore = page.url();

    try {
      switch (actionPlan.action) {
        case "click": {
          const clickTarget = target || instruction;
          const locator = page.getByRole("button", { name: clickTarget, exact: false })
            .or(page.getByRole("link", { name: clickTarget, exact: false }))
            .or(page.getByText(clickTarget, { exact: false }));
          await locator.first().click({ timeout: 10000 });
          actSuccess = true;
          break;
        }
        case "type": {
          const typeTarget = target || instruction;
          const locator = page.getByLabel(typeTarget, { exact: false })
            .or(page.getByPlaceholder(typeTarget, { exact: false }));
          await locator.first().fill(actionPlan.value || "", { timeout: 10000 });
          actSuccess = true;
          break;
        }
        case "navigate":
          await page.goto(actionPlan.url || actionPlan.value, { waitUntil: "domcontentloaded", timeout: 30000 });
          actSuccess = true;
          break;
        case "press":
          await page.keyboard.press(actionPlan.key || actionPlan.value || "Enter");
          actSuccess = true;
          break;
        case "scroll": {
          const deltaY = (actionPlan.value || "down").includes("up") ? -400 : 400;
          await page.mouse.wheel(0, deltaY);
          actSuccess = true;
          break;
        }
        case "select": {
          const selectTarget = target || instruction;
          const locator = page.getByLabel(selectTarget, { exact: false }).first();
          await locator.selectOption({ label: actionPlan.value }).catch(async () => {
            await locator.selectOption({ value: actionPlan.value });
          });
          actSuccess = true;
          break;
        }
        default:
          throw new Error(`Unknown action: ${actionPlan.action}`);
      }
    } catch (err) {
      actError = err.message;
      actSuccess = false;
    }

    await new Promise((r) => setTimeout(r, 500));
    const urlAfter = page.url();

    const actEvent = {
      runId: session.id,
      stepId,
      timestamp: nowIso(),
      url,
      eventType: "act",
      instruction,
      success: actSuccess,
      message: actError || "Action executed",
      actions: actSuccess ? [{
        selector: element?.selectorHint || "",
        description: target,
        method: actionPlan.action === "type" ? "fill" : actionPlan.action,
        arguments: actionPlan.value ? [actionPlan.value] : [],
      }] : [],
      urlBefore,
      urlAfter,
      elapsedMs: Date.now() - startTime,
    };
    events.push(actEvent);

    return { success: actSuccess, error: actError, actions: actEvent.actions };
  } catch (err) {
    const failEvent = {
      runId: session.id,
      stepId,
      timestamp: nowIso(),
      url,
      eventType: "act",
      instruction,
      success: false,
      message: err.message,
      actions: [],
      urlBefore: url,
      urlAfter: page.url(),
      elapsedMs: Date.now() - startTime,
    };
    events.push(failEvent);
    return { success: false, error: err.message };
  }
}

/**
 * Execute an assertion step using DOM snapshot + LLM extraction.
 */
async function executeAssertionStepWithLLM(session, stepId, instruction, events) {
  const { page, llm } = session;
  const url = page.url();
  const start = Date.now();

  try {
    const pageText = await getPageText(page, 6000);

    const prompt = `Given this page content:
URL: ${url}
Text: ${pageText.slice(0, 4000)}

Instruction: "${instruction}"

Check if the assertion/verification in the instruction passes based on the page content.
Return a JSON object:
{
  "passed": true/false,
  "extracted": { "key": "value" },
  "reasoning": "explanation"
}

Return ONLY the JSON object.`;

    const response = await llm.invoke([new HumanMessage(prompt)]);
    const responseText = typeof response.content === "string" ? response.content : "";

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { passed: false, reasoning: "Could not parse response" };

    const extractEvent = {
      runId: session.id,
      stepId,
      timestamp: nowIso(),
      url,
      eventType: "extract",
      instruction,
      result: result.extracted || {},
      usage: "assertion",
      elapsedMs: Date.now() - start,
    };
    events.push(extractEvent);

    return { success: result.passed !== false, result: result.extracted || {} };
  } catch (err) {
    logError("agent_extract_failed", { sessionId: session.id, stepId, instruction, error: String(err) });
    return { success: false, error: err.message };
  }
}

/**
 * Execute an autonomous objective using LangGraph ReAct agent.
 */
export async function executeAgentObjective(session, commandId, objective) {
  if (session.type !== "agent" || !session.llm) {
    throw new Error("Session is not an agent session");
  }

  const { page, llm } = session;

  const pushSessionEvent = (eventData) => {
    if (!session.events) session.events = [];
    session.events.push({ ...eventData, createdAt: nowIso() });
    if (session.events.length > 2000) {
      session.events.splice(0, session.events.length - 2000);
    }
    session.updatedAt = nowIso();
  };

  let stepCounter = 0;

  try {
    const tools = buildPlaywrightTools(page, session);

    const agent = createReactAgent({
      llm,
      tools,
      messageModifier: AGENT_SYSTEM_PROMPT,
    });

    pushSessionEvent({
      type: "agent_reasoning",
      commandId,
      stepIndex: 0,
      reasoning: `Starting autonomous agent for: ${objective.slice(0, 200)}`,
      url: page.url(),
    });

    const rawLimit = config.langchainMaxSteps;
    const recursionLimit =
      Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 1000) : 100;

    const result = await agent.invoke(
      { messages: [new HumanMessage(objective)] },
      { recursionLimit }
    );

    const messages = result.messages || [];
    for (const msg of messages) {
      if (msg.additional_kwargs?.tool_calls || msg.tool_calls) {
        stepCounter++;
        const toolCalls = msg.tool_calls || msg.additional_kwargs?.tool_calls || [];
        for (const tc of toolCalls) {
          pushSessionEvent({
            type: "agent_action",
            commandId,
            stepIndex: stepCounter,
            toolName: tc.name || tc.function?.name || "unknown",
            args: tc.args || (tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}),
            url: page.url(),
            success: true,
          });
        }
      }
    }

    session.currentUrl = page.url();
    session.updatedAt = nowIso();

    // Allow BrowserRecorder's pending input flush (600ms timer) to complete
    await new Promise((r) => setTimeout(r, 800));

    let screenshotPath = null;
    try {
      screenshotPath = await takeScreenshot(page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      screenshotPath = session.lastScreenshotPath;
    }

    const browserRecorder = session.browserRecorder;
    let browserActions = [];
    if (browserRecorder) {
      browserRecorder.stop();
      browserActions = browserRecorder.getPlaywrightActions();
    }

    const normalizedActions = browserActions.length > 0
      ? browserActions.map((ba) => ({
          type: ba.action === "scroll" ? "scroll" : ba.action === "navigate" ? "navigate" : "act",
          action: ba.action || "act",
          instruction: ba.target || "",
          targetDescription: ba.target || "",
          value: ba.value || "",
          description: ba.target ? `${ba.action}: ${ba.target}` : ba.action,
          playwright: ba.playwright || "",
          selector: ba.selector || "",
          selectorMethod: ba.selectorMethod || "unknown",
        }))
      : [];

    const results = normalizedActions.map((step, i) => ({
      commandId,
      stepId: `step-${i + 1}`,
      action: step.action || "act",
      status: "passed",
      currentUrl: session.currentUrl,
      selectorUsed: null,
      message: step.description || "Executed",
      screenshotPath: i === normalizedActions.length - 1 ? screenshotPath : null,
      durationMs: 0,
    }));

    if (results.length === 0) {
      results.push({
        commandId,
        stepId: "step-1",
        action: "agent_execute",
        status: "passed",
        currentUrl: session.currentUrl,
        selectorUsed: null,
        message: "Agent completed objective",
        screenshotPath,
        durationMs: 0,
      });
    }

    const returnObj = {
      commandId,
      currentUrl: session.currentUrl,
      results,
      agentActions: normalizedActions,
      completed: true,
    };

    if (browserRecorder) {
      returnObj.recordedScript = browserRecorder.toPlaywrightScript({
        testName: objective.slice(0, 200),
      });
      returnObj.browserRecording = browserRecorder.toJSON();
    }

    return returnObj;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("agent_execute_failed", { sessionId: session.id, commandId, error: msg });

    const browserRecorderErr = session.browserRecorder;
    if (browserRecorderErr) browserRecorderErr.stop();

    let screenshotPath = session.lastScreenshotPath;
    try {
      screenshotPath = await takeScreenshot(page, session.id);
      session.lastScreenshotPath = screenshotPath;
    } catch {
      // keep existing
    }
    session.currentUrl = page.url();
    session.updatedAt = nowIso();

    let failActions = [];
    if (browserRecorderErr) {
      failActions = browserRecorderErr.getPlaywrightActions().map((ba) => ({
        type: ba.action === "scroll" ? "scroll" : ba.action === "navigate" ? "navigate" : "act",
        action: ba.action || "act",
        instruction: ba.target || "",
        targetDescription: ba.target || "",
        value: ba.value || "",
        description: ba.target ? `${ba.action}: ${ba.target}` : ba.action,
        playwright: ba.playwright || "",
        selector: ba.selector || "",
        selectorMethod: ba.selectorMethod || "unknown",
      }));
    }

    const returnObj = {
      commandId,
      currentUrl: session.currentUrl,
      results: [{
        commandId,
        stepId: "step-1",
        action: "agent_execute",
        status: "failed",
        currentUrl: session.currentUrl,
        message: msg,
        screenshotPath,
        durationMs: 0,
      }],
      agentActions: failActions,
      completed: false,
    };

    if (browserRecorderErr) {
      returnObj.recordedScript = browserRecorderErr.toPlaywrightScript({
        testName: "recorded browser test",
      });
      returnObj.browserRecording = browserRecorderErr.toJSON();
    }
    return returnObj;
  }
}

/**
 * Get session state for agent sessions.
 */
export async function getAgentSessionState(session) {
  if (session.type !== "agent" || !session.page) {
    return { currentUrl: "", pageText: "", domSummary: "" };
  }
  const page = session.page;
  let currentUrl = "";
  let pageText = "";
  let domSummary = null;

  try {
    currentUrl = page.url();
    pageText = await getPageText(page, 8000);
    domSummary = await getDomSummary(page);
  } catch {
    // best effort
  }

  return { currentUrl, pageText, domSummary: domSummary ? JSON.stringify(domSummary) : "" };
}

/**
 * Close an agent session and release resources.
 */
export async function closeAgentSession(session) {
  if (session.type !== "agent") return;
  try {
    const video = session.page?.video?.();
    await session.page?.close?.().catch(() => {});
    if (video) {
      session.lastVideoPath = await video.path().catch(() => null);
    }
  } catch {
    // no-op
  }
  await session.context?.close?.().catch(() => {});
  await session.browser?.close?.().catch(() => {});
}
