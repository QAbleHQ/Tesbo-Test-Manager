/**
 * LangChain tool wrappers for Playwright actions.
 * Each tool wraps a Playwright action and records telemetry events
 * so the existing BrowserRecorder / telemetry pipeline keeps working.
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getInteractiveDOM } from "./domSnapshot.js";
import { logInfo, logError } from "./logger.js";

/**
 * Build an array of LangChain tools bound to a specific page and session.
 *
 * @param {import('playwright').Page} page
 * @param {object} session - Session state (for event recording)
 * @param {object} [deps] - Optional dependencies { resolveLocator, buildLocatorCandidates }
 * @returns {import('@langchain/core/tools').DynamicStructuredTool[]}
 */
export function buildPlaywrightTools(page, session, deps = {}) {
  const { resolveLocatorFromTargetVariants, buildLocatorCandidates } = deps;

  const pushEvent = (eventData) => {
    if (!session.events) session.events = [];
    session.events.push({ ...eventData, createdAt: new Date().toISOString() });
    if (session.events.length > 2000) {
      session.events.splice(0, session.events.length - 2000);
    }
    session.updatedAt = new Date().toISOString();
  };

  const navigate = new DynamicStructuredTool({
    name: "navigate",
    description: "Navigate the browser to a URL",
    schema: z.object({
      url: z.string().describe("The URL to navigate to"),
    }),
    func: async ({ url }) => {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        session.currentUrl = page.url();
        pushEvent({ type: "agent_tool_action", tool: "navigate", url, status: "passed" });
        return `Navigated to ${page.url()}`;
      } catch (err) {
        pushEvent({ type: "agent_tool_action", tool: "navigate", url, status: "failed", error: err.message });
        return `Navigation failed: ${err.message}`;
      }
    },
  });

  const clickElement = new DynamicStructuredTool({
    name: "click_element",
    description: "Click on an element identified by its text description or visible label. Use the text you see on the page to identify the element.",
    schema: z.object({
      description: z.string().describe("The visible text, label, or description of the element to click"),
    }),
    func: async ({ description }) => {
      try {
        if (resolveLocatorFromTargetVariants) {
          const resolved = await resolveLocatorFromTargetVariants(page, description, "click", 10000);
          if (resolved?.locator) {
            await resolved.locator.click({ timeout: 10000 });
            session.currentUrl = page.url();
            pushEvent({ type: "agent_tool_action", tool: "click", target: description, selectorUsed: resolved.label, status: "passed" });
            return `Clicked on "${description}" (resolved via ${resolved.label})`;
          }
          if (resolved?.ambiguityError) {
            return `Could not click: ${resolved.ambiguityError}`;
          }
        }
        const locator = page.getByRole("button", { name: description, exact: false })
          .or(page.getByRole("link", { name: description, exact: false }))
          .or(page.getByText(description, { exact: false }));
        await locator.first().click({ timeout: 10000 });
        session.currentUrl = page.url();
        pushEvent({ type: "agent_tool_action", tool: "click", target: description, status: "passed" });
        return `Clicked on "${description}"`;
      } catch (err) {
        pushEvent({ type: "agent_tool_action", tool: "click", target: description, status: "failed", error: err.message });
        return `Click failed on "${description}": ${err.message}`;
      }
    },
  });

  const typeText = new DynamicStructuredTool({
    name: "type_text",
    description: "Type text into an input field identified by its label, placeholder, or description",
    schema: z.object({
      field: z.string().describe("The label, placeholder, or description of the input field"),
      text: z.string().describe("The text to type into the field"),
    }),
    func: async ({ field, text }) => {
      try {
        if (resolveLocatorFromTargetVariants) {
          const resolved = await resolveLocatorFromTargetVariants(page, field, "type", 10000);
          if (resolved?.locator) {
            await resolved.locator.fill(text, { timeout: 10000 });
            pushEvent({ type: "agent_tool_action", tool: "type", target: field, value: text, selectorUsed: resolved.label, status: "passed" });
            return `Typed "${text}" into "${field}" (resolved via ${resolved.label})`;
          }
          if (resolved?.ambiguityError) {
            return `Could not type: ${resolved.ambiguityError}`;
          }
        }
        const locator = page.getByLabel(field, { exact: false })
          .or(page.getByPlaceholder(field, { exact: false }));
        await locator.first().fill(text, { timeout: 10000 });
        pushEvent({ type: "agent_tool_action", tool: "type", target: field, value: text, status: "passed" });
        return `Typed "${text}" into "${field}"`;
      } catch (err) {
        pushEvent({ type: "agent_tool_action", tool: "type", target: field, value: text, status: "failed", error: err.message });
        return `Type failed on "${field}": ${err.message}`;
      }
    },
  });

  const pressKey = new DynamicStructuredTool({
    name: "press_key",
    description: "Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown)",
    schema: z.object({
      key: z.string().describe("The key to press (e.g., 'Enter', 'Tab', 'Escape')"),
    }),
    func: async ({ key }) => {
      try {
        await page.keyboard.press(key);
        pushEvent({ type: "agent_tool_action", tool: "press", key, status: "passed" });
        return `Pressed ${key}`;
      } catch (err) {
        pushEvent({ type: "agent_tool_action", tool: "press", key, status: "failed", error: err.message });
        return `Press failed: ${err.message}`;
      }
    },
  });

  const scroll = new DynamicStructuredTool({
    name: "scroll",
    description: "Scroll the page up or down",
    schema: z.object({
      direction: z.enum(["up", "down"]).describe("Scroll direction"),
      amount: z.number().optional().describe("Pixels to scroll (default 400)"),
    }),
    func: async ({ direction, amount }) => {
      const pixels = amount || 400;
      const deltaY = direction === "up" ? -pixels : pixels;
      try {
        await page.mouse.wheel(0, deltaY);
        await page.waitForTimeout(300);
        pushEvent({ type: "agent_tool_action", tool: "scroll", direction, amount: pixels, status: "passed" });
        return `Scrolled ${direction} by ${pixels}px`;
      } catch (err) {
        return `Scroll failed: ${err.message}`;
      }
    },
  });

  const waitTool = new DynamicStructuredTool({
    name: "wait",
    description: "Wait for a specified duration to let the page load or settle",
    schema: z.object({
      ms: z.number().describe("Milliseconds to wait (max 10000)"),
    }),
    func: async ({ ms }) => {
      const duration = Math.min(Math.max(ms, 100), 10000);
      await page.waitForTimeout(duration);
      return `Waited ${duration}ms`;
    },
  });

  const getPageContent = new DynamicStructuredTool({
    name: "get_page_content",
    description: "Get the current page's interactive elements and structure. Call this to understand what's on the page before acting.",
    schema: z.object({}),
    func: async () => {
      try {
        const snapshot = await getInteractiveDOM(page);
        return snapshot.text;
      } catch (err) {
        return `Failed to get page content: ${err.message}`;
      }
    },
  });

  const assertVisible = new DynamicStructuredTool({
    name: "assert_visible",
    description: "Assert that specific text is visible on the page",
    schema: z.object({
      text: z.string().describe("The text that should be visible on the page"),
    }),
    func: async ({ text }) => {
      try {
        const locator = page.getByText(text, { exact: false }).first();
        await locator.waitFor({ state: "visible", timeout: 10000 });
        pushEvent({ type: "agent_tool_action", tool: "assert_visible", target: text, status: "passed" });
        return `Assertion passed: "${text}" is visible`;
      } catch (err) {
        pushEvent({ type: "agent_tool_action", tool: "assert_visible", target: text, status: "failed", error: err.message });
        return `Assertion failed: "${text}" is NOT visible on the page`;
      }
    },
  });

  const selectOption = new DynamicStructuredTool({
    name: "select_option",
    description: "Select an option from a dropdown/select element",
    schema: z.object({
      field: z.string().describe("The label or description of the select element"),
      value: z.string().describe("The option text or value to select"),
    }),
    func: async ({ field, value }) => {
      try {
        if (resolveLocatorFromTargetVariants) {
          const resolved = await resolveLocatorFromTargetVariants(page, field, "type", 10000);
          if (resolved?.locator) {
            await resolved.locator.selectOption({ label: value }).catch(async () => {
              await resolved.locator.selectOption({ value });
            });
            pushEvent({ type: "agent_tool_action", tool: "select", target: field, value, status: "passed" });
            return `Selected "${value}" in "${field}"`;
          }
        }
        const locator = page.getByLabel(field, { exact: false }).first();
        await locator.selectOption({ label: value }).catch(async () => {
          await locator.selectOption({ value });
        });
        pushEvent({ type: "agent_tool_action", tool: "select", target: field, value, status: "passed" });
        return `Selected "${value}" in "${field}"`;
      } catch (err) {
        pushEvent({ type: "agent_tool_action", tool: "select", target: field, value, status: "failed", error: err.message });
        return `Select failed: ${err.message}`;
      }
    },
  });

  return [
    navigate,
    clickElement,
    typeText,
    pressKey,
    scroll,
    waitTool,
    getPageContent,
    assertVisible,
    selectOption,
  ];
}
