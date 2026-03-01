package com.bettercases.automation;

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

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("'", "\\'");
    }

    private AutomationScriptBuilderService() {}
}
