package com.bettercases.automation;

import java.util.List;
import java.util.Map;

public final class AutomationScriptBuilderService {
    public static String buildPlaywrightScript(String testName, List<Map<String, Object>> events) {
        String sanitizedName = (testName == null || testName.isBlank()) ? "generated automation test" : testName.trim();
        StringBuilder sb = new StringBuilder();
        sb.append("import { test, expect } from '@playwright/test';\n\n");
        sb.append("test('").append(escape(sanitizedName)).append("', async ({ page }) => {\n");
        for (Map<String, Object> event : events) {
            String type = String.valueOf(event.getOrDefault("eventType", ""));
            if (!"step_finished".equals(type)) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = (Map<String, Object>) event.get("parsedAction");
            if (parsed == null) continue;
            String action = String.valueOf(parsed.getOrDefault("action", ""));
            if ("navigate".equals(action)) {
                String url = String.valueOf(parsed.getOrDefault("url", ""));
                if (!url.isBlank()) {
                    sb.append("  await page.goto('").append(escape(url)).append("');\n");
                }
            } else if ("click".equals(action)) {
                String selector = String.valueOf(parsed.getOrDefault("selector", ""));
                if (!selector.isBlank()) {
                    sb.append("  await page.locator('").append(escape(selector)).append("').first().click();\n");
                }
            } else if ("type".equals(action)) {
                String selector = String.valueOf(parsed.getOrDefault("selector", ""));
                String value = String.valueOf(parsed.getOrDefault("value", ""));
                if (!selector.isBlank()) {
                    sb.append("  await page.locator('").append(escape(selector)).append("').first().fill('")
                            .append(escape(value)).append("');\n");
                }
            }
        }
        sb.append("  await expect(page).toHaveURL(/.*/);\n");
        sb.append("});\n");
        return sb.toString();
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("'", "\\'");
    }

    private AutomationScriptBuilderService() {}
}
