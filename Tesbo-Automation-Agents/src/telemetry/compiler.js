/**
 * Playwright compiler: telemetry → executable Playwright test code.
 * Locator priority: data-testid > role+name > label > placeholder > text > css > xpath
 * Never emit raw LLM text as code. Derive from telemetry only.
 */
import { randomUUID } from "node:crypto";

const LOCATOR_PRIORITY = [
  "data-testid",
  "role",
  "label",
  "placeholder",
  "text",
  "css",
  "xpath",
];

function esc(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeXPathForPlaywright(selector) {
  const s = String(selector || "").trim();
  if (!s) return null;
  if (s.startsWith("xpath=")) return s;
  if (s.startsWith("/") || s.startsWith("(")) return `xpath=${s}`;
  return s;
}

/**
 * Derive a Playwright locator expression from act action telemetry.
 * Prefers semantic locators; falls back to xpath only when necessary.
 */
function deriveLocator(action, method) {
  const desc = String(action.description || "").trim();
  const selector = String(action.selector || "").trim();
  const args = action.arguments || [];

  const lowerDesc = desc.toLowerCase();

  if (selector.includes("data-testid") || selector.includes("data-test")) {
    const match = selector.match(/data-testid=["']([^"']+)["']/) || selector.match(/data-test=["']([^"']+)["']/);
    if (match?.[1]) {
      return { type: "testid", expr: `page.getByTestId('${esc(match[1])}')`, priority: 1 };
    }
  }

  const tabMatch = /tab\s+(?:in|on|of)?\s*["']?([^"']+)["']?|([^,]+)\s+tab/i.exec(desc);
  if (tabMatch) {
    const name = (tabMatch[1] || tabMatch[2] || desc).trim();
    if (name) return { type: "role", expr: `page.getByRole('tab', { name: '${esc(name)}', exact: false })`, priority: 2 };
  }

  const linkMatch = /link|nav|menu|breadcrumb/i.test(desc);
  if (linkMatch) {
    return { type: "role", expr: `page.getByRole('link', { name: '${esc(desc)}', exact: false })`, priority: 2 };
  }

  const buttonMatch = /button|submit|login|logout|save|cancel|add|delete|edit|create|search|back|next|close|open|publish|click/i.test(desc);
  if (buttonMatch || method === "click") {
    const name = desc || "element";
    return { type: "role", expr: `page.getByRole('button', { name: '${esc(name)}', exact: false }).or(page.getByText('${esc(name)}', { exact: false }))`, priority: 2 };
  }

  const labelMatch = desc.match(/(?:email|password|username|name|search|input|field)\s*(?:field|input)?/i)
    || /email|password|username|name|search|input|field/i.test(lowerDesc);
  if (labelMatch || method === "fill" || method === "type") {
    const name = desc || "input";
    return { type: "label", expr: `page.getByLabel('${esc(name)}', { exact: false }).or(page.getByPlaceholder('${esc(name)}', { exact: false }))`, priority: 3 };
  }

  if (desc) {
    return { type: "text", expr: `page.getByText('${esc(desc)}', { exact: false })`, priority: 5 };
  }

  const xpath = normalizeXPathForPlaywright(selector);
  if (xpath) {
    return { type: "xpath", expr: `page.locator('${esc(xpath)}')`, priority: 7 };
  }

  return null;
}

/**
 * Convert a single act action to a Playwright code line.
 */
function actionToPlaywright(action, fallbackReason = {}) {
  const method = (action.method || "click").toLowerCase();
  const args = action.arguments || [];
  const value = args[0] != null ? String(args[0]) : "";

  let loc = deriveLocator(action, method);
  if (!loc) {
    const xpath = normalizeXPathForPlaywright(action.selector);
    if (xpath) {
      loc = { type: "xpath", expr: `page.locator('${esc(xpath)}')`, priority: 7 };
    }
  }
  if (!loc) {
    return { code: null, fallback: "no_locator" };
  }

  if (loc.priority >= 7) {
    fallbackReason[action.description || "unknown"] = "xpath used; no stable semantic locator derived";
  }

  const base = `${loc.expr}.first()`;

  switch (method) {
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
      return { code: `await ${base}.click();`, fallback: null };
    case "fill":
    case "type":
      if (value) {
        return { code: `await ${base}.fill('${esc(value)}');`, fallback: null };
      }
      return { code: `await ${base}.fill('');`, fallback: null };
    case "press":
      const key = value || "Enter";
      return { code: `await ${base}.press('${esc(key)}');`, fallback: null };
    case "select":
      return { code: `await ${base}.selectOption('${esc(value)}');`, fallback: null };
    case "hover":
      return { code: `await ${base}.hover();`, fallback: null };
    default:
      return { code: `await ${base}.click();`, fallback: null };
  }
}

/**
 * Convert extract result to assertion.
 */
function extractToAssertion(extractEvent) {
  const result = extractEvent.result || {};
  const lines = [];

  for (const [key, value] of Object.entries(result)) {
    if (value == null) continue;
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      if (/^https?:\/\//i.test(text)) {
        lines.push(`  await expect(page).toHaveURL('${esc(text)}');`);
      } else if (text.length < 200) {
        lines.push(`  await expect(page.getByText('${esc(text)}', { exact: false }).first()).toBeVisible();`);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const text = typeof item === "string" ? item : String(item);
        if (text.trim() && text.length < 200) {
          lines.push(`  await expect(page.getByText('${esc(text.trim())}', { exact: false }).first()).toBeVisible();`);
        }
      }
    }
  }

  return lines;
}

/**
 * Convert wait to Playwright code.
 */
function waitToPlaywright(ms) {
  const duration = Math.min(Math.max(Number(ms) || 1000, 100), 10000);
  return `  await page.waitForTimeout(${Math.round(duration)});`;
}

/**
 * Compile telemetry events to agentActions (for frontend compatibility).
 * @param {object[]} events - Telemetry events from executor
 * @returns {object[]} Array of { type, action, playwright, targetDescription, value, ... }
 */
export function compileTelemetryToActions(events) {
  const actions = [];
  const actEvents = events.filter((e) => e.eventType === "act");
  const extractEvents = events.filter((e) => e.eventType === "extract");

  for (const ev of actEvents) {
    if (!ev.success) continue;

    const evActions = ev.actions || [];
    if (evActions.length === 0) {
      if (ev.urlBefore && ev.urlAfter && ev.urlAfter !== ev.urlBefore) {
        actions.push({
          type: "act",
          action: "navigate",
          url: ev.urlAfter,
          playwright: `await page.goto('${esc(ev.urlAfter)}');`,
        });
      }
      continue;
    }

    for (const action of evActions) {
      const method = (action.method || "click").toLowerCase();
      if (method === "scroll" || method === "scrollto") {
        actions.push({
          type: "act",
          action: "scroll",
          playwright: "await page.mouse.wheel(0, 300);",
        });
        continue;
      }

      const { code } = actionToPlaywright(action, {});
      if (code) {
        actions.push({
          type: "act",
          action: method,
          targetDescription: action.description,
          value: (action.arguments || [])[0],
          playwright: code,
        });
      }
    }
  }

  for (const ev of extractEvents) {
    const assertionLines = extractToAssertion(ev);
    for (const line of assertionLines) {
      const match = line.match(/expect\((.+)\)\.toBeVisible\(\)/);
      if (match) {
        actions.push({
          type: "act",
          action: "assert_text",
          playwright: line.trim(),
        });
      }
    }
  }

  return actions;
}

/**
 * Compile telemetry events to Playwright test spec.
 * @param {object[]} events - Telemetry events from executor
 * @param {object} options - { scenario, runId, addHeader }
 * @returns {string} Playwright TypeScript test code
 */
export function compileTelemetryToPlaywright(events, options = {}) {
  const { scenario = "generated automation test", addHeader = true } = options;
  const actions = compileTelemetryToActions(events);
  const lines = actions.map((a) => `  ${a.playwright}`);

  if (lines.length === 0) {
    lines.push("  // No deterministic Playwright actions could be emitted from telemetry.");
  } else {
    lines.push("  await expect(page).toHaveURL(/.*/);");
  }

  const header = addHeader
    ? `import { test, expect } from '@playwright/test';

test('${esc(scenario)}', async ({ page }) => {
`
    : "";

  const footer = `
});`;

  return header + lines.join("\n") + footer;
}

/**
 * Convert agent actions to telemetry-like format
 * for the compiler when full telemetry is not available.
 */
export function agentActionsToTelemetryLike(actions) {
  const events = [];

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const type = String(a.type || "").toLowerCase();
    const action = String(a.action || "").toLowerCase();

    if (type === "wait" || action === "wait") {
      events.push({
        eventType: "act",
        success: true,
        actions: [{ method: "wait", description: "wait", arguments: [a.timeMs || 2000] }],
      });
      continue;
    }

    if (action === "scroll") {
      events.push({
        eventType: "act",
        success: true,
        actions: [{ method: "scroll", description: a.description || "scroll", arguments: [] }],
      });
      continue;
    }

    const selector = a.selector || a.targetDescription || a.description || "";
    const method = action === "type" ? "fill" : action === "click" ? "click" : action;
    const value = a.value || "";

    events.push({
      eventType: "act",
      success: true,
      actions: [
        {
          selector: selector.startsWith("xpath") || selector.startsWith("/") ? selector : `xpath=//*[contains(text(),'${selector}')]`,
          description: a.targetDescription || a.description || selector,
          method,
          arguments: value ? [value] : [],
        },
      ],
    });
  }

  return events;
}
