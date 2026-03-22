/**
 * Telemetry schema for autonomous browser automation.
 * Version: 1.0.0
 * Every event includes runId, stepId, timestamp, url, and event type.
 */
import { z } from "zod";

const baseEvent = z.object({
  runId: z.string(),
  stepId: z.string(),
  timestamp: z.string().datetime(),
  url: z.string(),
  eventType: z.string(),
});

export const observeCandidateSchema = z.object({
  selector: z.string(),
  description: z.string(),
  method: z.string().optional(),
  arguments: z.array(z.string()).optional(),
});

export const observeTelemetrySchema = baseEvent.extend({
  eventType: z.literal("observe"),
  instruction: z.string(),
  candidates: z.array(observeCandidateSchema),
  chosenIndex: z.number().int().min(0).optional(),
  chosenReason: z.string().optional(),
  instructionRefined: z.boolean().optional(),
  elapsedMs: z.number().optional(),
});

export const actActionSchema = z.object({
  selector: z.string(),
  description: z.string(),
  method: z.string().optional(),
  arguments: z.array(z.union([z.string(), z.number()])).optional(),
});

export const actTelemetrySchema = baseEvent.extend({
  eventType: z.literal("act"),
  instruction: z.string(),
  refinedInstruction: z.string().optional(),
  success: z.boolean(),
  message: z.string().optional(),
  actionDescription: z.string().optional(),
  actions: z.array(actActionSchema),
  urlBefore: z.string().optional(),
  urlAfter: z.string().optional(),
  titleBefore: z.string().optional(),
  titleAfter: z.string().optional(),
  screenshotBefore: z.string().optional(),
  screenshotAfter: z.string().optional(),
  elapsedMs: z.number().optional(),
  cacheStatus: z.enum(["HIT", "MISS"]).optional(),
  retryCount: z.number().int().min(0).optional(),
  failureReason: z.string().optional(),
});

export const extractTelemetrySchema = baseEvent.extend({
  eventType: z.literal("extract"),
  instruction: z.string(),
  schemaUsed: z.string().optional(),
  selectorScope: z.string().optional(),
  result: z.record(z.unknown()),
  usage: z.enum(["assertion", "dynamic_test_data", "branching_condition"]).optional(),
  elapsedMs: z.number().optional(),
  cacheStatus: z.enum(["HIT", "MISS"]).optional(),
});

export const browserContextTelemetrySchema = baseEvent.extend({
  eventType: z.literal("browser_context"),
  pageTitle: z.string().optional(),
  navigationEvent: z.string().optional(),
  newTabOpened: z.boolean().optional(),
  dialogAppeared: z.boolean().optional(),
  iframeInvolved: z.boolean().optional(),
  consoleErrors: z.array(z.string()).optional(),
  networkFailures: z.array(z.string()).optional(),
});

export const generationTelemetrySchema = baseEvent.extend({
  eventType: z.literal("generation"),
  compilerInputRunId: z.string(),
  stepToCodeMapping: z.record(z.string()),
  locatorStrategyChosen: z.record(z.string()).optional(),
  fallbackReason: z.record(z.string()).optional(),
  generatedAssertions: z.array(z.string()).optional(),
  finalSpecPath: z.string().optional(),
  validationResult: z.enum(["passed", "failed", "draft"]).optional(),
});

export const telemetryEventSchema = z.discriminatedUnion("eventType", [
  observeTelemetrySchema,
  actTelemetrySchema,
  extractTelemetrySchema,
  browserContextTelemetrySchema,
  generationTelemetrySchema,
]);

export const runTelemetrySchema = z.object({
  version: z.literal("1.0.0"),
  runId: z.string(),
  scenario: z.string(),
  startUrl: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  events: z.array(telemetryEventSchema),
  credentialsProvided: z.boolean().optional(),
  environmentMetadata: z.record(z.unknown()).optional(),
});

/**
 * AgiS workflow contracts (execution context + action impact + page knowledge).
 * These are used by the execution orchestrator to keep deterministic traces.
 */
export const agisRunContextSchema = z.object({
  runId: z.string(),
  commandId: z.string(),
  sessionId: z.string(),
  testCaseTitle: z.string(),
  intent: z.string(),
  startUrl: z.string().optional(),
  testData: z.string().optional(),
  description: z.string().optional(),
  expectedThings: z.array(z.string()).default([]),
  planSteps: z.array(z.object({
    stepId: z.string(),
    instruction: z.string(),
  })).default([]),
  createdAt: z.string().datetime(),
  status: z.enum(["running", "completed", "failed", "partial"]).default("running"),
});

export const agisActionEvaluationSchema = z.object({
  goalMatchScore: z.number().min(0).max(1),
  expectedOutcomeMatch: z.boolean(),
  stateChangeDetected: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  risk: z.enum(["low", "medium", "high"]),
  issues: z.array(z.string()).default([]),
  nextStepDecision: z.enum(["continue", "replan", "recover", "fail"]),
  recoveryPlan: z.string().optional(),
});

export const agisActionRecordSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  screenId: z.string(),
  actionType: z.string(),
  instruction: z.string(),
  targetElement: z.string().optional(),
  locatorUsed: z.string().optional(),
  inputValue: z.string().optional(),
  beforeScreenshot: z.string().nullable().optional(),
  afterScreenshot: z.string().nullable().optional(),
  domBeforeKeyElements: z.array(z.object({
    ref: z.number().int().optional(),
    tag: z.string().optional(),
    text: z.string().optional(),
    selectorHint: z.string().nullable().optional(),
  })).default([]),
  domAfterKeyElements: z.array(z.object({
    ref: z.number().int().optional(),
    tag: z.string().optional(),
    text: z.string().optional(),
    selectorHint: z.string().nullable().optional(),
  })).default([]),
  result: z.enum(["passed", "failed"]),
  urlBefore: z.string().optional(),
  urlAfter: z.string().optional(),
  attemptedAt: z.string().datetime(),
  evaluation: agisActionEvaluationSchema,
});

export const agisPageKnowledgeEntrySchema = z.object({
  pageId: z.string(),
  pageUrlPattern: z.string(),
  pageTitle: z.string().default(""),
  pageDescriptionEditable: z.string().default(""),
  importantElements: z.array(z.object({
    semanticName: z.string(),
    selectorHint: z.string().nullable().optional(),
    elementType: z.string().optional(),
    roleInFlow: z.string().optional(),
  })).default([]),
  representativeScreenshots: z.array(z.string()).default([]),
  lastValidatedAt: z.string().datetime().optional(),
});

export function validateTelemetryEvent(data) {
  return telemetryEventSchema.safeParse(data);
}

export function validateRunTelemetry(data) {
  return runTelemetrySchema.safeParse(data);
}

export function validateAgisRunContext(data) {
  return agisRunContextSchema.safeParse(data);
}

export function validateAgisActionRecord(data) {
  return agisActionRecordSchema.safeParse(data);
}

export function validateAgisPageKnowledgeEntry(data) {
  return agisPageKnowledgeEntrySchema.safeParse(data);
}
