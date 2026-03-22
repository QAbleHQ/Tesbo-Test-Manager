package com.bettercases.automation;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class AutomationScriptBuilderService {
    public static String buildPlaywrightScript(String testName, List<Map<String, Object>> events) {
        String sanitizedName = (testName == null || testName.isBlank()) ? "generated automation test" : testName.trim();
        StringBuilder sb = new StringBuilder();
        sb.append("import { test, expect } from '@playwright/test';\n\n");
        sb.append("test('").append(escape(sanitizedName)).append("', async ({ page }) => {\n");
        sb.append("  const pickLocator = async (hints = {}, kind = 'generic') => {\n");
        sb.append("    const candidates = [];\n");
        sb.append("    const isBrittleXPath = (value = '') => /^xpath\\s*=\\s*(\\/html\\b|\\/\\*\\[name\\(\\)='html'\\])/i.test(value.trim());\n");
        sb.append("    const selector = (hints.selector || '').trim();\n");
        sb.append("    const targetDescription = (hints.targetDescription || '').trim();\n");
        sb.append("    const expectedText = (hints.expectedText || '').trim();\n");
        sb.append("    if (selector && !isBrittleXPath(selector)) candidates.push(page.locator(selector));\n");
        sb.append("    const labelHint = targetDescription\n");
        sb.append("      .replace(/\\bin\\s+.+$/i, '')\n");
        sb.append("      .replace(/\\b(field|textbox|text box|input|button|link)\\b/gi, '')\n");
        sb.append("      .replace(/\\s+/g, ' ')\n");
        sb.append("      .trim();\n");
        sb.append("    if (labelHint) {\n");
        sb.append("      candidates.push(page.getByLabel(labelHint, { exact: false }));\n");
        sb.append("      candidates.push(page.getByPlaceholder(labelHint, { exact: false }));\n");
        sb.append("      if (kind === 'click') {\n");
        sb.append("        candidates.push(page.getByRole('button', { name: labelHint, exact: false }));\n");
        sb.append("        candidates.push(page.getByRole('link', { name: labelHint, exact: false }));\n");
        sb.append("      }\n");
        sb.append("      candidates.push(page.getByText(labelHint, { exact: false }));\n");
        sb.append("    }\n");
        sb.append("    if (expectedText) candidates.push(page.getByText(expectedText, { exact: false }));\n");
        sb.append("    for (const locator of candidates) {\n");
        sb.append("      try {\n");
        sb.append("        if (await locator.count()) return locator.first();\n");
        sb.append("      } catch {\n");
        sb.append("        // try next locator candidate\n");
        sb.append("      }\n");
        sb.append("    }\n");
        sb.append("    throw new Error(`Unable to resolve locator for ${JSON.stringify(hints)}`);\n");
        sb.append("  };\n\n");
        sb.append("  const assertAnyVisible = async (texts) => {\n");
        sb.append("    let lastError = null;\n");
        sb.append("    for (const text of texts) {\n");
        sb.append("      try {\n");
        sb.append("        await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 4000 });\n");
        sb.append("        return;\n");
        sb.append("      } catch (error) {\n");
        sb.append("        lastError = error;\n");
        sb.append("      }\n");
        sb.append("    }\n");
        sb.append("    throw lastError || new Error('None of the expected success indicators were visible.');\n");
        sb.append("  };\n\n");
        boolean wroteAction = false;
        List<Map<String, Object>> finalizedActions = collectFinalizedActions(events);
        for (Map<String, Object> action : finalizedActions) {
            wroteAction |= appendStepAction(sb, action);
        }
        boolean wroteAuthAssertions = appendPostLoginAssertions(sb, finalizedActions);
        wroteAction = wroteAction || wroteAuthAssertions;
        if (!wroteAction) {
            sb.append("  // No recorded actions were available. Add steps manually.\n");
        }
        if (!wroteAuthAssertions) {
            sb.append("  await expect(page).toHaveURL(/.*/);\n");
        }
        sb.append("});\n");
        return sb.toString();
    }

    public static List<Map<String, Object>> buildTestSteps(List<Map<String, Object>> events) {
        List<Map<String, Object>> out = new ArrayList<>();
        List<Map<String, Object>> rawActions = collectFinalizedActions(events);

        List<Map<String, Object>> compactedActions = compactTypingActions(rawActions);
        for (Map<String, Object> action : compactedActions) {
            appendHumanStep(out, action);
        }

        for (int i = 0; i < out.size(); i++) {
            out.get(i).put("stepNumber", i + 1);
        }
        return out;
    }

    private static List<Map<String, Object>> collectFinalizedActions(List<Map<String, Object>> events) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (events == null || events.isEmpty()) return out;

        boolean hasAutonomousStepEvents = hasEventType(events, "autonomous_step_executed");

        for (Map<String, Object> event : events) {
            if (event == null) continue;
            String type = String.valueOf(event.getOrDefault("eventType", ""));
            if ("autonomous_step_executed".equals(type)) {
                Map<String, Object> parsed = asMap(event.get("parsedAction"));
                if (parsed == null) continue;
                if (!isPassedStatus(asText(parsed.get("status")))) continue;
                Map<String, Object> step = asMap(parsed.get("step"));
                Map<String, Object> result = asMap(parsed.get("result"));
                if (step != null) out.add(mergeStepWithResult(step, result));
                continue;
            }
            if ("autonomous_turn_executed".equals(type) && !hasAutonomousStepEvents) {
                Map<String, Object> parsed = asMap(event.get("parsedAction"));
                if (parsed == null || !isPassedStatus(asText(parsed.get("status")))) continue;
                collectStepsFromBundle(out, parsed.get("steps"), parsed.get("results"));
                continue;
            }
            if ("command_executed".equals(type)) {
                Map<String, Object> parsed = asMap(event.get("parsedAction"));
                Map<String, Object> execution = asMap(event.get("executionResult"));
                if (isAutonomousEvent(parsed, execution)) continue;
                List<Map<String, Object>> agentActions = asListOfMaps(execution == null ? null : execution.get("agentActions"));
                if (!agentActions.isEmpty()) {
                    String commandStatus = firstNonBlank(
                            asText(parsed == null ? null : parsed.get("status")),
                            asText(execution == null ? null : execution.get("status"))
                    );
                    int before = out.size();
                    collectStepsFromAgentActions(out, agentActions, commandStatus);
                    int extracted = out.size() - before;
                    if (extracted > 0) continue;
                }
                if (parsed == null) continue;
                collectStepsFromBundle(out, parsed.get("steps"), execution == null ? null : execution.get("results"));
                continue;
            }
            if ("step_finished".equals(type) || "manual_action_executed".equals(type)) {
                if (!eventPassedOrUnknown(event)) continue;
                Map<String, Object> parsed = asMap(event.get("parsedAction"));
                if (parsed == null) continue;
                out.add(copyAction(parsed));
            }
        }
        return out;
    }

    private static void collectStepsFromAgentActions(
            List<Map<String, Object>> out,
            List<Map<String, Object>> agentActions,
            String commandStatus
    ) {
        if (agentActions == null || agentActions.isEmpty()) return;
        String normalizedStatus = asText(commandStatus).toLowerCase();
        if (!normalizedStatus.isBlank() && !isPassedStatus(normalizedStatus)) return;
        for (Map<String, Object> entry : agentActions) {
            if (entry == null || entry.isEmpty()) continue;
            String type = asText(entry.get("type")).toLowerCase();
            if ("wait".equals(type)) {
                Integer durationMs = asPositiveInt(entry.get("timeMs"));
                if (durationMs != null && durationMs > 0) {
                    Map<String, Object> waitStep = new HashMap<>();
                    waitStep.put("action", "wait");
                    waitStep.put("durationMs", durationMs);
                    out.add(waitStep);
                }
                continue;
            }
            if ("extract".equals(type)) {
                if (Boolean.FALSE.equals(entry.get("success"))) continue;
                Map<String, Object> result = asMap(entry.get("result"));
                appendExtractAssertions(out, result);
                continue;
            }
            if ("fillformvision".equals(type)) {
                List<Map<String, Object>> pwArgs = asListOfMaps(entry.get("playwrightArguments"));
                List<Map<String, Object>> fields = pwArgs.isEmpty() ? asListOfMaps(entry.get("fields")) : pwArgs;
                for (Map<String, Object> field : fields) {
                    String desc = firstNonBlank(asText(field.get("action")), asText(field.get("description")));
                    String value = firstNonBlank(asText(field.get("value")), asText(field.get("originalValue")));
                    // Skip fill entries that have no value — they represent uncaptured/failed input steps.
                    if (value.isBlank()) continue;
                    Map<String, Object> step = new HashMap<>();
                    step.put("action", "type");
                    step.put("targetDescription", desc);
                    step.put("value", value);
                    out.add(step);
                }
                continue;
            }
            if ("click".equals(type)) {
                String describe = firstNonBlank(
                        asText(entry.get("describe")),
                        firstNonBlank(asText(entry.get("description")), asText(entry.get("instruction")))
                );
                if (!describe.isBlank()) {
                    Map<String, Object> step = new HashMap<>();
                    step.put("action", "click");
                    step.put("targetDescription", describe);
                    out.add(step);
                    continue;
                }
            }
            String actionField = asText(entry.get("action")).toLowerCase();
            if (actionField.startsWith("assert") || type.startsWith("assert")) {
                String assertAction = actionField.startsWith("assert") ? actionField : type;
                Map<String, Object> step = new HashMap<>();
                step.put("action", assertAction);
                String target = asText(entry.get("targetDescription"));
                String expectedText = asText(entry.get("expectedText"));
                String playwright = asText(entry.get("playwright"));
                if (!target.isBlank()) step.put("targetDescription", target);
                if (!expectedText.isBlank()) step.put("expectedText", expectedText);
                if (!playwright.isBlank()) step.put("playwright", playwright);
                String selector = asText(entry.get("selector"));
                if (!selector.isBlank()) step.put("selector", selector);
                out.add(step);
                continue;
            }
            if (appendAgentPlaywrightAction(out, entry)) continue;
            List<Map<String, Object>> nestedActions = asListOfMaps(entry.get("actions"));
            boolean emitted = false;
            for (Map<String, Object> nested : nestedActions) {
                emitted |= appendAgentPlaywrightAction(out, nested);
            }
            if (emitted) continue;
            if (appendAgentInstructionAction(out, entry)) continue;
            if (appendAgentPlaywrightAction(out, asMap(entry.get("playwrightArguments")))) continue;
            for (Map<String, Object> pwa : asListOfMaps(entry.get("playwrightArguments"))) {
                if (appendAgentPlaywrightAction(out, pwa)) {
                    emitted = true;
                }
            }
            if (emitted) continue;
            appendAgentPlaywrightAction(out, entry);
        }
    }

    private static boolean appendAgentInstructionAction(List<Map<String, Object>> out, Map<String, Object> source) {
        if (source == null || source.isEmpty()) return false;
        String actionName = firstNonBlank(
                asText(source.get("action")),
                firstNonBlank(asText(source.get("type")),
                        firstNonBlank(asText(source.get("tool")), asText(source.get("name"))))
        ).toLowerCase();
        String instruction = asText(source.get("instruction"));
        String describe = asText(source.get("describe"));
        String targetDescription = asText(source.get("targetDescription"));
        String description = asText(source.get("description"));
        String target = firstNonBlank(describe, firstNonBlank(instruction, firstNonBlank(targetDescription, description)));
        String value = firstNonBlank(asText(source.get("value")), asText(source.get("text")));
        String playwrightCode = asText(source.get("playwright"));
        Map<String, Object> argumentsMap = asMap(source.get("arguments"));
        if (argumentsMap != null && !argumentsMap.isEmpty()) {
            String argDescribe = asText(argumentsMap.get("describe"));
            if (!argDescribe.isBlank()) target = argDescribe;
            String argValue = firstNonBlank(asText(argumentsMap.get("value")), asText(argumentsMap.get("text")));
            if (!argValue.isBlank()) value = argValue;
        }

        if (actionName.contains("click")) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "click");
            if (!target.isBlank()) step.put("targetDescription", target);
            if (!playwrightCode.isBlank()) step.put("playwright", playwrightCode);
            out.add(step);
            return true;
        }
        if (actionName.contains("type") || actionName.contains("fill")) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "type");
            if (!target.isBlank()) step.put("targetDescription", target);
            if (!value.isBlank()) step.put("value", value);
            if (!playwrightCode.isBlank()) step.put("playwright", playwrightCode);
            out.add(step);
            return true;
        }
        if (actionName.contains("press") || actionName.contains("key")) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "press");
            step.put("key", firstNonBlank(asText(source.get("key")), "Enter"));
            if (!playwrightCode.isBlank()) step.put("playwright", playwrightCode);
            out.add(step);
            return true;
        }
        if (actionName.startsWith("assert")) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", actionName);
            if (!target.isBlank()) step.put("targetDescription", target);
            String expectedText = asText(source.get("expectedText"));
            if (!expectedText.isBlank()) step.put("expectedText", expectedText);
            String playwright = asText(source.get("playwright"));
            if (!playwright.isBlank()) step.put("playwright", playwright);
            out.add(step);
            return true;
        }
        if (actionName.contains("goto") || actionName.contains("navigate")) {
            String url = firstNonBlank(asText(source.get("url")), asText(argumentsMap == null ? null : argumentsMap.get("url")));
            if (!url.isBlank()) {
                Map<String, Object> step = new HashMap<>();
                step.put("action", "navigate");
                step.put("url", url);
                if (!playwrightCode.isBlank()) step.put("playwright", playwrightCode);
                out.add(step);
                return true;
            }
        }
        if (actionName.contains("scroll")) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "scroll");
            if (!playwrightCode.isBlank()) step.put("playwright", playwrightCode);
            out.add(step);
            return true;
        }
        if (actionName.contains("drag")) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "drag");
            if (!playwrightCode.isBlank()) step.put("playwright", playwrightCode);
            out.add(step);
            return true;
        }
        if (!playwrightCode.isBlank()) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", actionName.isBlank() ? "act" : actionName);
            step.put("playwright", playwrightCode);
            if (!target.isBlank()) step.put("targetDescription", target);
            if (!value.isBlank()) step.put("value", value);
            out.add(step);
            return true;
        }
        return false;
    }

    private static boolean appendAgentPlaywrightAction(List<Map<String, Object>> out, Map<String, Object> source) {
        if (source == null || source.isEmpty()) return false;
        String method = firstNonBlank(asText(source.get("method")), asText(source.get("action"))).toLowerCase();
        String selector = normalizeSelector(asText(source.get("selector")));
        String firstArg = firstAgentArgument(source.get("arguments"));
        if (firstArg.isBlank()) {
            firstArg = firstNonBlank(asText(source.get("text")), asText(source.get("value")));
        }
        if (("fill".equals(method) || "type".equals(method)) && !selector.isBlank()) {
            if (firstArg.isBlank()) {
                return false; // skip fill/type steps where no value was captured
            }
            Map<String, Object> step = new HashMap<>();
            step.put("action", "type");
            step.put("selector", selector);
            step.put("value", firstArg);
            out.add(step);
            return true;
        }
        if ("type".equals(method) && selector.isBlank() && !firstArg.isBlank()) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "type");
            step.put("selector", "activeElement");
            step.put("value", firstArg);
            out.add(step);
            return true;
        }
        if (("click".equals(method) || "dblclick".equals(method) || "check".equals(method) || "uncheck".equals(method))
                && !selector.isBlank()) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "click");
            step.put("selector", selector);
            out.add(step);
            return true;
        }
        if ("press".equals(method) || "keypress".equals(method)) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "press");
            step.put("key", firstNonBlank(firstArg, "Enter"));
            out.add(step);
            return true;
        }
        if (("goto".equals(method) || "navigate".equals(method)) && !firstArg.isBlank()) {
            Map<String, Object> step = new HashMap<>();
            step.put("action", "navigate");
            step.put("url", firstArg);
            out.add(step);
            return true;
        }
        return false;
    }

    private static void appendExtractAssertions(List<Map<String, Object>> out, Map<String, Object> result) {
        if (result == null || result.isEmpty()) return;
        for (Object value : result.values()) {
            appendExtractAssertionValue(out, value);
        }
    }

    private static void appendExtractAssertionValue(List<Map<String, Object>> out, Object value) {
        if (value instanceof String textValue) {
            String text = textValue.trim();
            if (text.isBlank()) return;
            Map<String, Object> step = new HashMap<>();
            if (text.startsWith("http://") || text.startsWith("https://")) {
                step.put("action", "assert_url");
                step.put("url", text);
            } else {
                step.put("action", "assert_text");
                step.put("expectedText", text);
            }
            out.add(step);
            return;
        }
        if (value instanceof List<?> list) {
            for (Object item : list) {
                appendExtractAssertionValue(out, item);
            }
        }
    }

    private static void collectStepsFromBundle(List<Map<String, Object>> out, Object stepsObj, Object resultsObj) {
        List<Map<String, Object>> steps = asListOfMaps(stepsObj);
        if (steps.isEmpty()) return;

        List<Map<String, Object>> results = asListOfMaps(resultsObj);
        if (results.isEmpty()) {
            for (Map<String, Object> step : steps) {
                out.add(copyAction(step));
            }
            return;
        }

        int bound = Math.min(steps.size(), results.size());
        for (int i = 0; i < bound; i++) {
            if (isPassedStatus(asText(results.get(i).get("status")))) {
                out.add(mergeStepWithResult(steps.get(i), results.get(i)));
            }
        }
    }

    private static Map<String, Object> mergeStepWithResult(Map<String, Object> step, Map<String, Object> result) {
        Map<String, Object> merged = copyAction(step);
        if (result == null || result.isEmpty()) return merged;
        String runtimeSelectorUsed = asText(result.get("selectorUsed"));
        if (!runtimeSelectorUsed.isBlank()) {
            merged.put("runtimeSelectorUsed", runtimeSelectorUsed);
        }
        String resolvedLocatorType = asText(result.get("resolvedLocatorType"));
        if (!resolvedLocatorType.isBlank()) {
            merged.put("runtimeLocatorType", resolvedLocatorType);
        }
        String directSelector = runtimeSelectorToSelector(runtimeSelectorUsed);
        if (!directSelector.isBlank() && asText(merged.get("selector")).isBlank()) {
            merged.put("selector", directSelector);
        }
        if (asText(merged.get("targetDescription")).isBlank()) {
            String runtimeTarget = runtimeSelectorToTarget(runtimeSelectorUsed);
            if (!runtimeTarget.isBlank()) merged.put("targetDescription", runtimeTarget);
        }
        if ("assert_text".equals(asText(merged.get("action"))) && asText(merged.get("expectedText")).isBlank()) {
            String runtimeExpected = runtimeSelectorToTarget(runtimeSelectorUsed);
            if (!runtimeExpected.isBlank()) merged.put("expectedText", runtimeExpected);
        }
        return merged;
    }

    private static String runtimeSelectorToSelector(String runtimeSelectorUsed) {
        String value = asText(runtimeSelectorUsed);
        if (value.startsWith("selector:")) return value.substring("selector:".length()).trim();
        if (value.startsWith("xpath:")) return "xpath=" + value.substring("xpath:".length()).trim();
        return "";
    }

    private static String runtimeSelectorToTarget(String runtimeSelectorUsed) {
        String value = asText(runtimeSelectorUsed);
        int idx = value.lastIndexOf(':');
        if (idx < 0 || idx + 1 >= value.length()) return "";
        return value.substring(idx + 1).trim();
    }

    private static String agentInstructionForAction(Map<String, Object> action) {
        String type = asText(action.get("action")).toLowerCase();
        String target = asText(action.get("targetDescription"));
        String selector = asText(action.get("selector"));
        String value = asText(action.get("value"));
        if ("click".equals(type)) {
            if (!target.isBlank()) return "Click " + target;
            if (!selector.isBlank()) return "Click element matching selector " + selector;
            return "Click the primary actionable element for this step";
        }
        if ("type".equals(type)) {
            if (!value.isBlank() && !target.isBlank()) return "Type \"" + value + "\" into " + target;
            if (!value.isBlank() && !selector.isBlank()) return "Type \"" + value + "\" into selector " + selector;
            if (!target.isBlank()) return "Type the required value into " + target;
            return "Type the required value into the intended input field";
        }
        return "";
    }

    private static String agentAssertionPrompt(Map<String, Object> action) {
        String type = asText(action.get("action")).toLowerCase();
        String target = asText(action.get("targetDescription"));
        String expected = asText(action.get("expectedText"));
        if ("assert_visible".equals(type)) {
            if (!target.isBlank()) return "Check if " + target + " is visible. Return pass=true only if visible.";
            return "Check if the expected target element is visible. Return pass=true only if visible.";
        }
        if ("assert_clickable".equals(type)) {
            if (!target.isBlank()) return "Check if " + target + " is clickable/enabled. Return pass=true only if clickable.";
            return "Check if the expected target element is clickable/enabled. Return pass=true only if clickable.";
        }
        if ("assert_text".equals(type)) {
            if (!expected.isBlank()) {
                return "Check if the page displays text \"" + expected + "\". Return pass=true only if text is present.";
            }
            return "Check if expected confirmation text is present. Return pass=true only if present.";
        }
        return "";
    }

    private static boolean eventPassedOrUnknown(Map<String, Object> event) {
        Map<String, Object> execution = asMap(event.get("executionResult"));
        if (execution == null) return true;
        String status = asText(execution.get("status"));
        if (status.isBlank()) return true;
        return isPassedStatus(status);
    }

    private static boolean hasEventType(List<Map<String, Object>> events, String type) {
        for (Map<String, Object> event : events) {
            if (event == null) continue;
            String currentType = String.valueOf(event.getOrDefault("eventType", ""));
            if (type.equals(currentType)) return true;
        }
        return false;
    }

    private static boolean isAutonomousEvent(Map<String, Object> parsed, Map<String, Object> execution) {
        if ("autonomous".equalsIgnoreCase(asText(parsed == null ? null : parsed.get("mode")))) return true;
        return "autonomous".equalsIgnoreCase(asText(execution == null ? null : execution.get("mode")));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        if (value instanceof Map<?, ?> mapValue) {
            return (Map<String, Object>) mapValue;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> asListOfMaps(Object value) {
        if (!(value instanceof List<?> rawList)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : rawList) {
            if (item instanceof Map<?, ?> mapItem) {
                out.add((Map<String, Object>) mapItem);
            }
        }
        return out;
    }

    private static boolean isPassedStatus(String status) {
        if (status == null) return false;
        String normalized = status.trim().toLowerCase();
        return "passed".equals(normalized) || "success".equals(normalized);
    }

    private static boolean appendStepAction(StringBuilder sb, Map<String, Object> parsed) {
        String aiPlaywright = asText(parsed.get("playwright"));
        if (!aiPlaywright.isBlank()) {
            sb.append("  ").append(aiPlaywright).append("\n");
            return true;
        }
        String action = String.valueOf(parsed.getOrDefault("action", ""));
        if ("act".equalsIgnoreCase(action)) {
            action = inferActionForGenericAct(parsed);
        }
        String runtimeSelectorUsed = firstNonBlank(
                asText(parsed.get("runtimeSelectorUsed")),
                asText(parsed.get("selectorUsed"))
        );
        String runtimeLocatorExpr = runtimeLocatorExpression(runtimeSelectorUsed);
        if ("wait".equals(action)) {
            Integer durationMs = asPositiveInt(parsed.get("durationMs"));
            if (durationMs != null && durationMs > 0) {
                sb.append("  await page.waitForTimeout(").append(durationMs).append(");\n");
                return true;
            }
            return false;
        }
        if ("navigate".equals(action)) {
            String url = String.valueOf(parsed.getOrDefault("url", ""));
            if (!url.isBlank()) {
                sb.append("  await page.goto('").append(escape(url)).append("');\n");
                return true;
            }
            return false;
        }
        if ("click".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            String targetDescription = String.valueOf(parsed.getOrDefault("targetDescription", ""));
            if (!runtimeLocatorExpr.isBlank()) {
                sb.append("  await ").append(runtimeLocatorExpr).append(".click();\n");
                return true;
            }
            if (!selector.isBlank() && !isBrittleSelector(selector)) {
                sb.append("  await page.locator('").append(escape(selector)).append("').first().click();\n");
                return true;
            }
            if (!targetDescription.isBlank()) {
                sb.append("  await (await pickLocator({ targetDescription: '").append(escape(targetDescription))
                        .append("' }, 'click')).click();\n");
                return true;
            }
            if (!selector.isBlank()) {
                sb.append("  await (await pickLocator({ selector: '").append(escape(selector))
                        .append("' }, 'click')).click();\n");
                return true;
            }
            if (parsed.get("xRatio") instanceof Number xRatio && parsed.get("yRatio") instanceof Number yRatio) {
                sb.append("  {\n");
                sb.append("    const viewport = page.viewportSize() || { width: 1366, height: 768 };\n");
                sb.append("    await page.mouse.click(Math.round(").append(xRatio.doubleValue()).append(" * viewport.width), Math.round(")
                        .append(yRatio.doubleValue()).append(" * viewport.height));\n");
                sb.append("  }\n");
                return true;
            }
            return false;
        }
        if ("type".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            String value = String.valueOf(parsed.getOrDefault("value", ""));
            String targetDescription = String.valueOf(parsed.getOrDefault("targetDescription", ""));
            // Never emit a fill/type step without a value — it means the action wasn't captured correctly.
            if (value.isBlank()) {
                return false;
            }
            if (!runtimeLocatorExpr.isBlank()) {
                sb.append("  await ").append(runtimeLocatorExpr).append(".fill('").append(escape(value)).append("');\n");
                return true;
            }
            if (!selector.isBlank() && !"activeElement".equals(selector) && !isBrittleSelector(selector)) {
                sb.append("  await page.locator('").append(escape(selector)).append("').first().fill('")
                        .append(escape(value)).append("');\n");
                return true;
            }
            if (!targetDescription.isBlank()) {
                sb.append("  await (await pickLocator({ targetDescription: '").append(escape(targetDescription))
                        .append("' }, 'type')).fill('").append(escape(value)).append("');\n");
                return true;
            }
            if (!selector.isBlank() && !"activeElement".equals(selector)) {
                sb.append("  await (await pickLocator({ selector: '").append(escape(selector))
                        .append("' }, 'type')).fill('").append(escape(value)).append("');\n");
                return true;
            }
            if (!value.isBlank()) {
                sb.append("  await page.keyboard.type('").append(escape(value)).append("');\n");
                return true;
            }
            return false;
        }
        if ("assert_visible".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            String expectedText = String.valueOf(parsed.getOrDefault("expectedText", ""));
            String targetDescription = String.valueOf(parsed.getOrDefault("targetDescription", ""));
            if (!runtimeLocatorExpr.isBlank()) {
                sb.append("  await expect(").append(runtimeLocatorExpr).append(").toBeVisible();\n");
                return true;
            }
            if (!selector.isBlank() && !isBrittleSelector(selector)) {
                sb.append("  await expect(page.locator('").append(escape(selector)).append("').first()).toBeVisible();\n");
                return true;
            }
            if (!expectedText.isBlank()) {
                sb.append("  await expect(page.getByText('").append(escape(expectedText)).append("', { exact: false })).toBeVisible();\n");
                return true;
            }
            if (!targetDescription.isBlank()) {
                sb.append("  await expect(await pickLocator({ targetDescription: '").append(escape(targetDescription))
                        .append("' }, 'assert')).toBeVisible();\n");
                return true;
            }
            return false;
        }
        if ("assert_text".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            String expectedText = String.valueOf(parsed.getOrDefault("expectedText", ""));
            if (!runtimeLocatorExpr.isBlank() && !expectedText.isBlank()) {
                sb.append("  await expect(").append(runtimeLocatorExpr).append(").toContainText('")
                        .append(escape(expectedText)).append("');\n");
                return true;
            }
            if (!selector.isBlank() && !isBrittleSelector(selector) && !expectedText.isBlank()) {
                sb.append("  await expect(page.locator('").append(escape(selector)).append("').first()).toContainText('")
                        .append(escape(expectedText)).append("');\n");
                return true;
            }
            if (!expectedText.isBlank()) {
                sb.append("  await expect(page.getByText('").append(escape(expectedText)).append("', { exact: false })).toBeVisible();\n");
                return true;
            }
            return false;
        }
        if ("assert_url".equals(action)) {
            String url = String.valueOf(parsed.getOrDefault("url", ""));
            if (!url.isBlank()) {
                sb.append("  await expect(page).toHaveURL('").append(escape(url)).append("');\n");
                return true;
            }
            return false;
        }
        if ("assert_clickable".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            if (!runtimeLocatorExpr.isBlank()) {
                sb.append("  await expect(").append(runtimeLocatorExpr).append(").toBeEnabled();\n");
                return true;
            }
            if (!selector.isBlank() && !isBrittleSelector(selector)) {
                sb.append("  await expect(page.locator('").append(escape(selector)).append("').first()).toBeEnabled();\n");
                return true;
            }
            return false;
        }
        if ("drag".equals(action)) {
            String startSelector = String.valueOf(parsed.getOrDefault("startSelector", ""));
            String endSelector = String.valueOf(parsed.getOrDefault("endSelector", ""));
            if (!startSelector.isBlank() && !endSelector.isBlank()) {
                sb.append("  await page.locator('").append(escape(startSelector)).append("').first()")
                        .append(".dragTo(page.locator('").append(escape(endSelector)).append("').first());\n");
                return true;
            }
            if (parsed.get("xRatio") instanceof Number xRatio &&
                    parsed.get("yRatio") instanceof Number yRatio &&
                    parsed.get("toXRatio") instanceof Number toXRatio &&
                    parsed.get("toYRatio") instanceof Number toYRatio) {
                sb.append("  {\n");
                sb.append("    const viewport = page.viewportSize() || { width: 1366, height: 768 };\n");
                sb.append("    await page.mouse.move(Math.round(").append(xRatio.doubleValue()).append(" * viewport.width), Math.round(")
                        .append(yRatio.doubleValue()).append(" * viewport.height));\n");
                sb.append("    await page.mouse.down();\n");
                sb.append("    await page.mouse.move(Math.round(").append(toXRatio.doubleValue()).append(" * viewport.width), Math.round(")
                        .append(toYRatio.doubleValue()).append(" * viewport.height), { steps: 12 });\n");
                sb.append("    await page.mouse.up();\n");
                sb.append("  }\n");
                return true;
            }
            return false;
        }
        if ("scroll".equals(action)) {
            if (parsed.get("deltaY") instanceof Number deltaY) {
                Number deltaX = parsed.get("deltaX") instanceof Number n ? n : 0;
                sb.append("  await page.mouse.wheel(").append(deltaX.intValue()).append(", ").append(deltaY.intValue()).append(");\n");
                return true;
            }
            return false;
        }
        if ("press".equals(action)) {
            String key = String.valueOf(parsed.getOrDefault("key", ""));
            if (!key.isBlank()) {
                sb.append("  await page.keyboard.press('").append(escape(key)).append("');\n");
                return true;
            }
        }
        return false;
    }

    private static String inferActionForGenericAct(Map<String, Object> parsed) {
        String value = asText(parsed.get("value"));
        if (!value.isBlank()) return "type";
        String target = (
                asText(parsed.get("targetDescription")) + " " +
                asText(parsed.get("selector")) + " " +
                asText(parsed.get("expectedText"))
        ).toLowerCase();
        if (target.contains("password") || target.contains("email") || target.contains("input") || target.contains("field")) {
            return "type";
        }
        return "click";
    }

    private static String runtimeLocatorExpression(String runtimeSelectorUsed) {
        String value = asText(runtimeSelectorUsed);
        if (value.isBlank()) return "";
        if (value.startsWith("selector:")) {
            String selector = value.substring("selector:".length()).trim();
            return selector.isBlank() ? "" : "page.locator('" + escape(selector) + "').first()";
        }
        if (value.startsWith("xpath:")) {
            String selector = value.substring("xpath:".length()).trim();
            if (selector.isBlank()) return "";
            if (selector.startsWith("/html") || selector.startsWith("/*[name()='html']")) return "";
            return "page.locator('xpath=" + escape(selector) + "').first()";
        }
        if (value.startsWith("testid:")) {
            String testId = value.substring("testid:".length()).trim();
            return testId.isBlank() ? "" : "page.getByTestId('" + escape(testId) + "').first()";
        }
        if (value.startsWith("label-exact:")) {
            String label = value.substring("label-exact:".length()).trim();
            return label.isBlank() ? "" : "page.getByLabel('" + escape(label) + "', { exact: true }).first()";
        }
        if (value.startsWith("label:")) {
            String label = value.substring("label:".length()).trim();
            return label.isBlank() ? "" : "page.getByLabel('" + escape(label) + "', { exact: false }).first()";
        }
        if (value.startsWith("placeholder-exact:")) {
            String text = value.substring("placeholder-exact:".length()).trim();
            return text.isBlank() ? "" : "page.getByPlaceholder('" + escape(text) + "', { exact: true }).first()";
        }
        if (value.startsWith("placeholder:")) {
            String text = value.substring("placeholder:".length()).trim();
            return text.isBlank() ? "" : "page.getByPlaceholder('" + escape(text) + "', { exact: false }).first()";
        }
        if (value.startsWith("text-exact:")) {
            String text = value.substring("text-exact:".length()).trim();
            return text.isBlank() ? "" : "page.getByText('" + escape(text) + "', { exact: true }).first()";
        }
        if (value.startsWith("text:")) {
            String text = value.substring("text:".length()).trim();
            return text.isBlank() ? "" : "page.getByText('" + escape(text) + "', { exact: false }).first()";
        }
        if (value.startsWith("role:")) {
            String tail = value.substring("role:".length());
            int split = tail.indexOf(':');
            if (split <= 0 || split + 1 >= tail.length()) return "";
            String role = tail.substring(0, split).replace("-exact", "").trim();
            String name = tail.substring(split + 1).trim();
            boolean exact = tail.substring(0, split).endsWith("-exact");
            if (role.isBlank() || name.isBlank()) return "";
            return "page.getByRole('" + escape(role) + "', { name: '" + escape(name) + "', exact: " + (exact ? "true" : "false") + " }).first()";
        }
        return "";
    }

    private static boolean appendPostLoginAssertions(StringBuilder sb, List<Map<String, Object>> actions) {
        if (!isLikelyLoginFlow(actions)) return false;
        List<String> successIndicators = collectAuthSuccessIndicators(actions);
        sb.append("  await expect(page).toHaveURL(/dashboard|home|agenc|project|case|workspace/i);\n");
        if (!successIndicators.isEmpty()) {
            sb.append("  await assertAnyVisible([");
            for (int i = 0; i < successIndicators.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append("'").append(escape(successIndicators.get(i))).append("'");
            }
            sb.append("]);\n");
        }
        sb.append("  await expect(page.getByRole('button', { name: /log\\s*out|sign\\s*out|profile|account/i })")
                .append(".or(page.getByRole('link', { name: /log\\s*out|sign\\s*out|profile|account/i }))")
                .append(".or(page.getByText(/new\\s+agency|agencies|dashboard/i).first()))")
                .append(".toBeVisible();\n");
        return true;
    }

    private static boolean appendHumanStep(List<Map<String, Object>> out, Map<String, Object> parsed) {
        if (parsed == null) return false;
        String action = String.valueOf(parsed.getOrDefault("action", "")).trim();
        if (action.isBlank()) return false;
        String normalizedAction = action.toLowerCase();
        String actionText;
        String expectedResult;
        switch (normalizedAction) {
            case "navigate" -> {
                String url = asText(parsed.get("url"));
                if (url.isBlank()) return false;
                actionText = "Open " + url + ".";
                expectedResult = "The page loads successfully at " + url + ".";
            }
            case "click" -> {
                String target = friendlyClickTarget(parsed);
                actionText = target.isBlank() ? "Click on the target element." : "Click on " + target + ".";
                expectedResult = "The click action is performed and the UI responds correctly.";
            }
            case "type" -> {
                String target = friendlyInputTarget(parsed);
                String value = asText(parsed.get("value"));
                if (!target.isBlank()) {
                    actionText = value.isBlank()
                            ? "Type into " + target + "."
                            : "Enter \"" + value + "\" into " + target + ".";
                } else {
                    actionText = value.isBlank() ? "Type the required input." : "Type \"" + value + "\".";
                }
                expectedResult = value.isBlank()
                        ? "The input is accepted by the active field."
                        : "The field displays \"" + value + "\".";
            }
            case "press" -> {
                String key = asText(parsed.get("key"));
                if (key.isBlank()) key = "Enter";
                actionText = "Press " + key + ".";
                expectedResult = "The application handles the " + key + " key action successfully.";
            }
            case "scroll" -> {
                return false;
            }
            case "drag" -> {
                String start = asText(parsed.get("startSelector"));
                String end = asText(parsed.get("endSelector"));
                actionText = (!start.isBlank() && !end.isBlank())
                        ? "Drag " + start + " to " + end + "."
                        : "Drag and drop the target element.";
                expectedResult = "The element is moved to the intended location.";
            }
            case "assert_visible" -> {
                String target = firstNonBlank(asText(parsed.get("expectedText")), friendlyClickTarget(parsed));
                actionText = target.isBlank() ? "Verify the required element is visible." : "Verify " + target + " is visible.";
                expectedResult = target.isBlank()
                        ? "The required UI element is visible to the user."
                        : target + " is visible on the page.";
            }
            case "assert_text" -> {
                String expectedText = asText(parsed.get("expectedText"));
                String target = friendlyClickTarget(parsed);
                if (!target.isBlank() && !expectedText.isBlank()) {
                    actionText = "Verify " + target + " contains \"" + expectedText + "\".";
                    expectedResult = target + " contains \"" + expectedText + "\".";
                } else if (!expectedText.isBlank()) {
                    actionText = "Verify the page contains \"" + expectedText + "\".";
                    expectedResult = "The text \"" + expectedText + "\" is visible on the page.";
                } else {
                    actionText = "Verify the expected text is shown.";
                    expectedResult = "The required text is visible on the page.";
                }
            }
            case "assert_clickable" -> {
                String target = friendlyClickTarget(parsed);
                actionText = target.isBlank()
                        ? "Verify the target control is clickable."
                        : "Verify " + target + " is clickable.";
                expectedResult = target.isBlank()
                        ? "The target control is enabled for interaction."
                        : target + " is enabled for interaction.";
            }
            default -> {
                actionText = "Perform action: " + normalizedAction + ".";
                expectedResult = "The action completes successfully.";
            }
        }

        Map<String, Object> step = new HashMap<>();
        step.put("action", actionText);
        step.put("expectedResult", expectedResult);
        out.add(step);
        return true;
    }

    private static List<Map<String, Object>> compactTypingActions(List<Map<String, Object>> actions) {
        List<Map<String, Object>> mergedTyping = new ArrayList<>();
        for (Map<String, Object> action : actions) {
            if (action == null) continue;
            String currentAction = asText(action.get("action")).toLowerCase();
            if (!"type".equals(currentAction)) {
                mergedTyping.add(copyAction(action));
                continue;
            }
            if (mergedTyping.isEmpty()) {
                mergedTyping.add(copyAction(action));
                continue;
            }
            Map<String, Object> previous = mergedTyping.get(mergedTyping.size() - 1);
            String previousAction = asText(previous.get("action")).toLowerCase();
            if (!"type".equals(previousAction)) {
                mergedTyping.add(copyAction(action));
                continue;
            }
            String previousTarget = typingTargetKey(previous);
            String currentTarget = typingTargetKey(action);
            if (!previousTarget.equals(currentTarget)) {
                mergedTyping.add(copyAction(action));
                continue;
            }
            String mergedValue = asText(previous.get("value")) + asText(action.get("value"));
            previous.put("value", mergedValue);
            if (asText(previous.get("targetText")).isBlank() && !asText(action.get("targetText")).isBlank()) {
                previous.put("targetText", asText(action.get("targetText")));
            }
            if (asText(previous.get("selector")).isBlank() && !asText(action.get("selector")).isBlank()) {
                previous.put("selector", asText(action.get("selector")));
            }
        }

        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < mergedTyping.size(); i++) {
            Map<String, Object> current = mergedTyping.get(i);
            String currentAction = asText(current.get("action")).toLowerCase();
            if ("click".equals(currentAction) && isTextInputTarget(current) && i + 1 < mergedTyping.size()) {
                Map<String, Object> next = mergedTyping.get(i + 1);
                String nextAction = asText(next.get("action")).toLowerCase();
                if ("type".equals(nextAction) && interactionTargetKey(current).equals(interactionTargetKey(next))) {
                    continue;
                }
            }
            out.add(current);
        }
        return out;
    }

    private static String typingTargetKey(Map<String, Object> action) {
        String selector = asText(action.get("selector"));
        String targetText = asText(action.get("targetText"));
        if (!selector.isBlank()) return "selector:" + selector;
        if (!targetText.isBlank()) return "targetText:" + targetText;
        return "active-element";
    }

    private static Map<String, Object> copyAction(Map<String, Object> action) {
        return action == null ? new HashMap<>() : new HashMap<>(action);
    }

    private static String interactionTargetKey(Map<String, Object> action) {
        String selector = asText(action.get("selector"));
        if (!selector.isBlank()) return "selector:" + selector;
        String targetText = asText(action.get("targetText"));
        if (!targetText.isBlank()) return "targetText:" + targetText;
        return "active-element";
    }

    private static boolean isLikelyLoginFlow(List<Map<String, Object>> actions) {
        if (actions == null || actions.isEmpty()) return false;
        boolean hasEmailType = false;
        boolean hasPasswordType = false;
        boolean hasLoginClick = false;
        for (Map<String, Object> action : actions) {
            if (action == null) continue;
            String kind = asText(action.get("action")).toLowerCase();
            String target = (
                    asText(action.get("targetDescription")) + " " +
                    asText(action.get("targetText")) + " " +
                    asText(action.get("selector"))
            ).toLowerCase();
            if ("type".equals(kind) && target.contains("email")) hasEmailType = true;
            if ("type".equals(kind) && (target.contains("password") || target.contains("pass"))) hasPasswordType = true;
            if ("click".equals(kind) && (target.contains("log in") || target.contains("login") || target.contains("sign in"))) {
                hasLoginClick = true;
            }
        }
        return (hasEmailType && hasPasswordType) || hasLoginClick;
    }

    private static List<String> collectAuthSuccessIndicators(List<Map<String, Object>> actions) {
        List<String> out = new ArrayList<>();
        if (actions == null) return out;
        for (Map<String, Object> action : actions) {
            if (action == null) continue;
            String kind = asText(action.get("action")).toLowerCase();
            if (!kind.startsWith("assert_")) continue;
            String expected = asText(action.get("expectedText"));
            String targetDescription = asText(action.get("targetDescription"));
            String selector = asText(action.get("selector"));
            if (!expected.isBlank()) out.add(expected);
            if (!targetDescription.isBlank()) out.add(targetDescription);
            if (selector.toLowerCase().startsWith("text=")) {
                String textSelector = stripSurroundingQuotes(normalizeTextSelector(selector));
                if (!textSelector.isBlank()) out.add(textSelector);
            }
        }
        out.add("Dashboard");
        out.add("Profile");
        out.add("Account");
        out.add("Logout");
        out.add("Agencies");
        out.add("New Agency");
        return dedupeAndLimit(out, 8);
    }

    private static String normalizeTextSelector(String selector) {
        String text = asText(selector);
        if (text.toLowerCase().startsWith("text=")) return text.substring(5).trim();
        return text;
    }

    private static String stripSurroundingQuotes(String value) {
        String text = asText(value);
        if (text.length() >= 2) {
            if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
                return text.substring(1, text.length() - 1).trim();
            }
        }
        return text;
    }

    private static List<String> dedupeAndLimit(List<String> values, int max) {
        List<String> out = new ArrayList<>();
        if (values == null || values.isEmpty() || max <= 0) return out;
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<>();
        for (String value : values) {
            String candidate = asText(value);
            if (candidate.isBlank()) continue;
            seen.add(candidate);
            if (seen.size() >= max) break;
        }
        out.addAll(seen);
        return out;
    }

    private static boolean isTextInputTarget(Map<String, Object> action) {
        String selector = asText(action.get("selector")).toLowerCase();
        String targetHtml = asText(action.get("targetHtml")).toLowerCase();
        return selector.startsWith("input")
                || selector.startsWith("textarea")
                || selector.contains("input[")
                || selector.contains("textarea")
                || targetHtml.contains("<input")
                || targetHtml.contains("<textarea");
    }

    private static String friendlyInputTarget(Map<String, Object> parsed) {
        String fromText = prettifyTargetText(asText(parsed.get("targetText")));
        if (!fromText.isBlank()) return fromText + " text box";
        String selector = asText(parsed.get("selector"));
        String fromSelector = extractFriendlyName(selector);
        if (!fromSelector.isBlank()) return fromSelector + " text box";
        return "";
    }

    private static String friendlyClickTarget(Map<String, Object> parsed) {
        String fromText = prettifyTargetText(asText(parsed.get("targetText")));
        if (!fromText.isBlank()) return fromText;
        String selector = asText(parsed.get("selector"));
        String fromSelector = extractFriendlyName(selector);
        if (!fromSelector.isBlank()) {
            if (isTextInputTarget(parsed)) return fromSelector + " text box";
            return fromSelector;
        }
        return "";
    }

    private static String extractFriendlyName(String selector) {
        if (selector == null || selector.isBlank()) return "";
        String normalized = selector.trim();
        String nameAttr = extractAttributeValue(normalized, "name");
        if (!nameAttr.isBlank()) return humanizeToken(nameAttr);
        String ariaLabel = extractAttributeValue(normalized, "aria-label");
        if (!ariaLabel.isBlank()) return humanizeToken(ariaLabel);
        String placeholder = extractAttributeValue(normalized, "placeholder");
        if (!placeholder.isBlank()) return humanizeToken(placeholder);
        if (normalized.startsWith("#") && normalized.length() > 1) return humanizeToken(normalized.substring(1));
        if (normalized.startsWith(".")) return humanizeToken(normalized.substring(1));
        return "";
    }

    private static String extractAttributeValue(String selector, String attribute) {
        if (selector == null || selector.isBlank() || attribute == null || attribute.isBlank()) return "";
        String lower = selector.toLowerCase();
        String marker = attribute.toLowerCase() + "=";
        int markerIndex = lower.indexOf(marker);
        if (markerIndex < 0) return "";
        int valueStart = markerIndex + marker.length();
        if (valueStart >= selector.length()) return "";
        char startChar = selector.charAt(valueStart);
        if (startChar == '\'' || startChar == '"') {
            int valueEnd = selector.indexOf(startChar, valueStart + 1);
            if (valueEnd <= valueStart) return "";
            return selector.substring(valueStart + 1, valueEnd).trim();
        }
        int valueEnd = valueStart;
        while (valueEnd < selector.length()) {
            char c = selector.charAt(valueEnd);
            if (c == ']' || c == ',' || Character.isWhitespace(c)) break;
            valueEnd++;
        }
        if (valueEnd <= valueStart) return "";
        return selector.substring(valueStart, valueEnd).trim();
    }

    private static String prettifyTargetText(String targetText) {
        if (targetText == null || targetText.isBlank()) return "";
        return humanizeToken(targetText);
    }

    private static String humanizeToken(String raw) {
        if (raw == null || raw.isBlank()) return "";
        String normalized = raw
                .replaceAll("([a-z0-9])([A-Z])", "$1 $2")
                .replaceAll("[_\\-]+", " ")
                .replaceAll("\\s+", " ")
                .trim();
        if (normalized.isBlank()) return "";
        String[] parts = normalized.split(" ");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isBlank()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(Character.toUpperCase(part.charAt(0)));
            if (part.length() > 1) sb.append(part.substring(1).toLowerCase());
        }
        return sb.toString();
    }

    private static String asText(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static String normalizeSelector(String selector) {
        String value = asText(selector);
        if (value.startsWith("xpath:")) return "xpath=" + value.substring("xpath:".length()).trim();
        return value;
    }

    private static boolean isBrittleSelector(String selector) {
        String value = asText(selector).toLowerCase();
        if (value.isBlank()) return false;
        return value.startsWith("xpath=/html") || value.startsWith("xpath=/*[name()='html']");
    }

    private static String firstAgentArgument(Object argumentsObj) {
        if (argumentsObj instanceof List<?> args) {
            if (args.isEmpty()) return "";
            return asText(args.get(0));
        }
        if (argumentsObj instanceof Map<?, ?> mapValue) {
            Object describe = mapValue.get("describe");
            if (describe != null) return asText(describe);
            Object value = mapValue.get("value");
            if (value != null) return asText(value);
            Object text = mapValue.get("text");
            if (text != null) return asText(text);
            Object url = mapValue.get("url");
            if (url != null) return asText(url);
        }
        return "";
    }

    private static Integer asPositiveInt(Object value) {
        if (value instanceof Number n) {
            int parsed = n.intValue();
            return parsed > 0 ? parsed : null;
        }
        String text = asText(value);
        if (text.isBlank()) return null;
        try {
            int parsed = (int) Math.round(Double.parseDouble(text));
            return parsed > 0 ? parsed : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String firstNonBlank(String first, String second) {
        if (first != null && !first.isBlank()) return first;
        return second == null ? "" : second;
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("'", "\\'");
    }

    private static String quote(String value) {
        return "'" + escape(value == null ? "" : value) + "'";
    }

    private AutomationScriptBuilderService() {}
}
