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
        boolean wroteAction = false;
        for (Map<String, Object> event : events) {
            String type = String.valueOf(event.getOrDefault("eventType", ""));
            if ("command_executed".equals(type) || "autonomous_turn_executed".equals(type)) {
                @SuppressWarnings("unchecked")
                Map<String, Object> parsed = (Map<String, Object>) event.get("parsedAction");
                if (parsed != null) {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> plannedSteps = (List<Map<String, Object>>) parsed.get("steps");
                    if (plannedSteps != null) {
                        for (Map<String, Object> step : plannedSteps) {
                            wroteAction |= appendStepAction(sb, step);
                        }
                    }
                }
                continue;
            }
            if (!"step_finished".equals(type) && !"manual_action_executed".equals(type)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = (Map<String, Object>) event.get("parsedAction");
            if (parsed == null) continue;
            wroteAction |= appendStepAction(sb, parsed);
        }
        if (!wroteAction) {
            sb.append("  // No recorded actions were available. Add steps manually.\n");
        }
        sb.append("  await expect(page).toHaveURL(/.*/);\n");
        sb.append("});\n");
        return sb.toString();
    }

    public static List<Map<String, Object>> buildTestSteps(List<Map<String, Object>> events) {
        List<Map<String, Object>> out = new ArrayList<>();
        List<Map<String, Object>> rawActions = new ArrayList<>();
        for (Map<String, Object> event : events) {
            String type = String.valueOf(event.getOrDefault("eventType", ""));
            if ("command_executed".equals(type) || "autonomous_turn_executed".equals(type)) {
                @SuppressWarnings("unchecked")
                Map<String, Object> parsed = (Map<String, Object>) event.get("parsedAction");
                if (parsed != null) {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> plannedSteps = (List<Map<String, Object>>) parsed.get("steps");
                    if (plannedSteps != null) {
                        for (Map<String, Object> step : plannedSteps) {
                            rawActions.add(copyAction(step));
                        }
                    }
                }
                continue;
            }
            if (!"step_finished".equals(type) && !"manual_action_executed".equals(type)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = (Map<String, Object>) event.get("parsedAction");
            if (parsed == null) continue;
            rawActions.add(copyAction(parsed));
        }

        List<Map<String, Object>> compactedActions = compactTypingActions(rawActions);
        for (Map<String, Object> action : compactedActions) {
            appendHumanStep(out, action);
        }

        for (int i = 0; i < out.size(); i++) {
            out.get(i).put("stepNumber", i + 1);
        }
        return out;
    }

    private static boolean appendStepAction(StringBuilder sb, Map<String, Object> parsed) {
        String action = String.valueOf(parsed.getOrDefault("action", ""));
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
            if (!selector.isBlank()) {
                sb.append("  await page.locator('").append(escape(selector)).append("').first().click();\n");
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
            if (!selector.isBlank() && !"activeElement".equals(selector)) {
                sb.append("  await page.locator('").append(escape(selector)).append("').first().fill('")
                        .append(escape(value)).append("');\n");
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
            if (!selector.isBlank()) {
                sb.append("  await expect(page.locator('").append(escape(selector)).append("').first()).toBeVisible();\n");
                return true;
            }
            if (!expectedText.isBlank()) {
                sb.append("  await expect(page.getByText('").append(escape(expectedText)).append("', { exact: false })).toBeVisible();\n");
                return true;
            }
            return false;
        }
        if ("assert_text".equals(action)) {
            String selector = String.valueOf(parsed.getOrDefault("selector", ""));
            String expectedText = String.valueOf(parsed.getOrDefault("expectedText", ""));
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
