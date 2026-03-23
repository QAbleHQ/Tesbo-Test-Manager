import {
  validateAgisRunContext,
  validateAgisActionRecord,
  validateAgisPageKnowledgeEntry,
} from "./schema.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .match(/\b[a-z0-9]{4,}\b/g) || [];
}

function unique(items) {
  return Array.from(new Set(items));
}

function normalizeUrlPattern(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const compactPath = parsed.pathname.replace(/\/\d+/g, "/:id");
    return `${parsed.origin}${compactPath}`;
  } catch {
    return raw;
  }
}

function describePageFromSnapshot(snapshot) {
  const title = normalizeText(snapshot?.title);
  const heading = normalizeText(snapshot?.headings?.[0]);
  const forms = Number(snapshot?.elements?.filter((el) => ["input", "textarea", "select"].includes(String(el?.tag))).length || 0);
  const buttons = Number(snapshot?.elements?.filter((el) => ["button"].includes(String(el?.tag))).length || 0);
  const parts = [];
  if (title) parts.push(`Page title "${title}"`);
  if (heading) parts.push(`primary heading "${heading}"`);
  parts.push(`contains ${forms} input-like controls and ${buttons} buttons`);
  return parts.join("; ");
}

export function buildAgisRunContext({
  sessionId,
  commandId,
  objective,
  currentUrl,
  plan,
  status = "running",
}) {
  const expectedThings = [];
  const objectiveText = String(objective || "");
  const expectationHints = objectiveText.match(/\b(expect|verify|assert|ensure|confirm)\b.+/gi) || [];
  for (const hint of expectationHints.slice(0, 8)) {
    expectedThings.push(normalizeText(hint));
  }
  const runContext = {
    runId: sessionId,
    commandId: String(commandId || ""),
    sessionId: String(sessionId || ""),
    testCaseTitle: normalizeText(objectiveText.split("\n")[0] || "Untitled objective"),
    intent: normalizeText(objectiveText).slice(0, 1500),
    startUrl: normalizeText(currentUrl || ""),
    testData: "",
    description: normalizeText(objectiveText).slice(0, 1200),
    expectedThings,
    planSteps: Array.isArray(plan) ? plan.map((p) => ({ stepId: p.stepId, instruction: p.instruction })) : [],
    createdAt: nowIso(),
    status,
  };
  const validation = validateAgisRunContext(runContext);
  return validation.success ? validation.data : runContext;
}

export function evaluateActionImpact({
  instruction,
  objective,
  beforeUrl,
  afterUrl,
  beforeSnapshot,
  afterSnapshot,
  success,
  error,
}) {
  const beforeText = normalizeText(beforeSnapshot?.text).toLowerCase();
  const afterText = normalizeText(afterSnapshot?.text).toLowerCase();
  const stateChangeDetected =
    normalizeText(beforeUrl) !== normalizeText(afterUrl) ||
    normalizeText(beforeSnapshot?.title) !== normalizeText(afterSnapshot?.title) ||
    beforeText !== afterText;

  const objectiveTokens = unique(tokenize(objective)).slice(0, 12);
  const instructionTokens = unique(tokenize(instruction)).slice(0, 10);
  const candidate = `${normalizeText(afterUrl)} ${normalizeText(afterSnapshot?.title)} ${afterText}`;
  const matchedObjective = objectiveTokens.filter((t) => candidate.includes(t)).length;
  const matchedInstruction = instructionTokens.filter((t) => candidate.includes(t)).length;
  const totalSignals = Math.max(1, objectiveTokens.length + instructionTokens.length);
  const goalMatchScore = Math.min(1, (matchedObjective + matchedInstruction) / totalSignals);

  const issues = [];
  if (!success) issues.push(error || "Action execution failed");
  if (success && !stateChangeDetected) issues.push("No visible DOM or URL change observed after action");
  if (goalMatchScore < 0.2) issues.push("Weak alignment with test intent");

  const expectedOutcomeMatch = success && (stateChangeDetected || goalMatchScore >= 0.2);
  let confidence = "high";
  if (!success || goalMatchScore < 0.2) confidence = "low";
  else if (!stateChangeDetected) confidence = "medium";

  let risk = "low";
  if (!success || issues.length >= 2) risk = "high";
  else if (!stateChangeDetected || goalMatchScore < 0.35) risk = "medium";

  let nextStepDecision = "continue";
  let recoveryPlan;
  if (!success) {
    nextStepDecision = "recover";
    recoveryPlan = "Retry with alternate locator strategy and refreshed DOM context";
  } else if (!stateChangeDetected && goalMatchScore < 0.2) {
    nextStepDecision = "replan";
    recoveryPlan = "Re-evaluate current screen and attempt an alternate route";
  }

  return {
    goalMatchScore,
    expectedOutcomeMatch,
    stateChangeDetected,
    confidence,
    risk,
    issues,
    nextStepDecision,
    recoveryPlan,
  };
}

export function createActionRecord({
  runId,
  stepId,
  screenId,
  actionType,
  instruction,
  targetElement,
  locatorUsed,
  inputValue,
  beforeScreenshot,
  afterScreenshot,
  beforeSnapshot,
  afterSnapshot,
  result,
  urlBefore,
  urlAfter,
  evaluation,
}) {
  const record = {
    runId: String(runId || ""),
    stepId: String(stepId || ""),
    screenId: String(screenId || ""),
    actionType: String(actionType || "act"),
    instruction: String(instruction || ""),
    targetElement: targetElement ? String(targetElement) : undefined,
    locatorUsed: locatorUsed ? String(locatorUsed) : undefined,
    inputValue: inputValue ? String(inputValue) : undefined,
    beforeScreenshot: beforeScreenshot || null,
    afterScreenshot: afterScreenshot || null,
    domBeforeKeyElements: Array.isArray(beforeSnapshot?.elements) ? beforeSnapshot.elements.slice(0, 20) : [],
    domAfterKeyElements: Array.isArray(afterSnapshot?.elements) ? afterSnapshot.elements.slice(0, 20) : [],
    result: result === "failed" ? "failed" : "passed",
    urlBefore: String(urlBefore || ""),
    urlAfter: String(urlAfter || ""),
    attemptedAt: nowIso(),
    evaluation,
  };
  const validation = validateAgisActionRecord(record);
  return validation.success ? validation.data : record;
}

export function createPageKnowledgeEntry({
  pageId,
  url,
  title,
  snapshot,
  screenshotPath,
}) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const importantElements = elements
    .slice(0, 24)
    .map((el) => ({
      semanticName: normalizeText(el.text || el.attrs?.["aria-label"] || el.attrs?.placeholder || el.attrs?.name || el.tag || "element"),
      selectorHint: el.selectorHint || null,
      elementType: normalizeText(el.tag || "unknown"),
      roleInFlow: "",
    }))
    .filter((el) => el.semanticName);

  const entry = {
    pageId: String(pageId || ""),
    pageUrlPattern: normalizeUrlPattern(url),
    pageTitle: normalizeText(title || snapshot?.title || ""),
    pageDescriptionEditable: describePageFromSnapshot(snapshot),
    importantElements,
    representativeScreenshots: screenshotPath ? [screenshotPath] : [],
    lastValidatedAt: nowIso(),
  };
  const validation = validateAgisPageKnowledgeEntry(entry);
  return validation.success ? validation.data : entry;
}

export function mergePageKnowledgeEntries(existingEntries, nextEntry) {
  const list = Array.isArray(existingEntries) ? [...existingEntries] : [];
  const idx = list.findIndex((item) => item.pageUrlPattern === nextEntry.pageUrlPattern);
  if (idx < 0) {
    list.push(nextEntry);
    return list;
  }
  const merged = {
    ...list[idx],
    pageTitle: nextEntry.pageTitle || list[idx].pageTitle,
    pageDescriptionEditable: nextEntry.pageDescriptionEditable || list[idx].pageDescriptionEditable,
    importantElements: unique(
      [...(list[idx].importantElements || []), ...(nextEntry.importantElements || [])]
        .map((el) => JSON.stringify(el))
    ).map((el) => JSON.parse(el)),
    representativeScreenshots: unique([...(list[idx].representativeScreenshots || []), ...(nextEntry.representativeScreenshots || [])]),
    lastValidatedAt: nextEntry.lastValidatedAt || list[idx].lastValidatedAt,
  };
  list[idx] = merged;
  return list;
}

export function validateExecutionArtifacts({ actionRecords, recordedScript }) {
  const checks = [];
  const records = Array.isArray(actionRecords) ? actionRecords : [];
  const missingEvidenceCount = records.filter((r) => !r.beforeScreenshot || !r.afterScreenshot).length;
  const missingDomCount = records.filter((r) => (r.domBeforeKeyElements || []).length === 0 || (r.domAfterKeyElements || []).length === 0).length;

  checks.push({
    key: "evidence_per_action",
    passed: missingEvidenceCount === 0,
    detail: missingEvidenceCount === 0
      ? "Every action has before/after screenshots"
      : `${missingEvidenceCount} action(s) are missing screenshot evidence`,
  });
  checks.push({
    key: "dom_capture_per_action",
    passed: missingDomCount === 0,
    detail: missingDomCount === 0
      ? "Every action has before/after key DOM elements"
      : `${missingDomCount} action(s) are missing key DOM capture`,
  });
  checks.push({
    key: "deterministic_script_ready",
    passed: /await\s+/.test(String(recordedScript || "")),
    detail: /await\s+/.test(String(recordedScript || ""))
      ? "Recorded script has executable Playwright actions"
      : "Recorded script does not contain deterministic executable actions",
  });
  return checks;
}

export function buildExecutionWalkthrough({ actionRecords }) {
  const records = Array.isArray(actionRecords) ? actionRecords : [];
  const singleScreen = [];
  const multiScreen = [];
  const seenScreens = [];
  for (const record of records) {
    if (!seenScreens.includes(record.screenId)) seenScreens.push(record.screenId);
    const line = `${record.stepId}: ${record.actionType} -> ${record.result} (${record.evaluation.nextStepDecision})`;
    if (seenScreens.length <= 1) singleScreen.push(line);
    multiScreen.push(`${record.screenId} :: ${line}`);
  }
  return {
    singleScreenScenario: singleScreen.slice(0, 12),
    multiScreenScenario: multiScreen.slice(0, 24),
  };
}
