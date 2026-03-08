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
        sb.append("    const selector = (hints.selector || '').trim();\n");
        sb.append("    const targetDescription = (hints.targetDescription || '').trim();\n");
        sb.append("    const expectedText = (hints.expectedText || '').trim();\n");
        sb.append("    if (selector) candidates.push(page.locator(selector));\n");
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
        String action = String.valueOf(parsed.getOrDefault("action", ""));
        String runtimeSelectorUsed = firstNonBlank(
                asText(parsed.get("runtimeSelectorUsed")),
                asText(parsed.get("selectorUsed"))
        );
        String runtimeLocatorExpr = runtimeLocatorExpression(runtimeSelectorUsed);
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
            if (!selector.isBlank()) {
                sb.append("  await page.locator('").append(escape(selector)).append("').first().click();\n");
                return true;
            }
            if (!targetDescription.isBlank()) {
                sb.append("  await (await pickLocator({ targetDescription: '").append(escape(targetDescription))
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
            if (!runtimeLocatorExpr.isBlank()) {
                sb.append("  await ").append(runtimeLocatorExpr).append(".fill('").append(escape(value)).append("');\n");
                return true;
            }
            if (!selector.isBlank() && !"activeElement".equals(selector)) {
                sb.append("  await page.locator('").append(escape(selector)).append("').first().fill('")
                        .append(escape(value)).append("');\n");
                return true;
            }
            if (!targetDescription.isBlank()) {
                sb.append("  await (await pickLocator({ targetDescription: '").append(escape(targetDescription))
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
            if (!selector.isBlank()) {
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
            if (!selector.isBlank() && !expectedText.isBlank()) {
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
        if ("assert_clickable".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            if (!runtimeLocatorExpr.isBlank()) {
                sb.append("  await expect(").append(runtimeLocatorExpr).append(").toBeEnabled();\n");
                return true;
            }
            if (!selector.isBlank()) {
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

    private static String runtimeLocatorExpression(String runtimeSelectorUsed) {
        String value = asText(runtimeSelectorUsed);
        if (value.isBlank()) return "";
        if (value.startsWith("selector:")) {
            String selector = value.substring("selector:".length()).trim();
            return selector.isBlank() ? "" : "page.locator('" + escape(selector) + "').first()";
        }
        if (value.startsWith("xpath:")) {
            String selector = value.substring("xpath:".length()).trim();
            return selector.isBlank() ? "" : "page.locator('xpath=" + escape(selector) + "').first()";
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

    private static String firstNonBlank(String first, String second) {
        if (first != null && !first.isBlank()) return first;
        return second == null ? "" : second;
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("'", "\\'");
    }

    private AutomationScriptBuilderService() {}
}
