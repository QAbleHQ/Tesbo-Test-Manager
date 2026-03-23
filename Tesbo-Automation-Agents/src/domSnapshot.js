/**
 * DOM snapshot utility for LLM consumption.
 * Extracts a simplified, annotated view of the page's interactive elements
 * so an LLM can reason about which element to interact with.
 */

const DEFAULT_MAX_ELEMENTS = 120;

/**
 * Extract an annotated snapshot of all interactive DOM elements.
 * Each element gets a numeric ref ID that the LLM can reference.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.maxElements]
 * @returns {Promise<{ text: string, elements: object[], url: string, title: string }>}
 */
export async function getInteractiveDOM(page, options = {}) {
  const maxElements = options.maxElements || DEFAULT_MAX_ELEMENTS;

  const snapshot = await page.evaluate((max) => {
    const INTERACTIVE = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='switch']",
      "[role='combobox']",
      "[role='searchbox']",
      "[contenteditable='true']",
      // Image-based controls (often lack button role / inner text; vision is not sent to the LLM).
      "img[id]",
      "img[onclick]",
      "img[tabindex]:not([tabindex='-1'])",
    ].join(", ");

    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const getText = (el) => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel.trim();
      if (el.tagName === "IMG") {
        const alt = el.getAttribute("alt");
        if (alt && alt.trim()) return alt.trim().slice(0, 80);
        const title = el.getAttribute("title");
        if (title && title.trim()) return title.trim().slice(0, 80);
      }
      const innerText = (el.textContent || "").replace(/\s+/g, " ").trim();
      return innerText.slice(0, 80);
    };

    const allElements = document.querySelectorAll(INTERACTIVE);
    const elements = [];
    let refId = 1;

    for (const el of allElements) {
      if (elements.length >= max) break;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      const attrs = {};
      for (const name of [
        "id",
        "name",
        "type",
        "placeholder",
        "aria-label",
        "alt",
        "title",
        "role",
        "data-testid",
        "href",
        "value",
        "checked",
        "disabled",
        "tabindex",
      ]) {
        const val = el.getAttribute(name);
        if (val != null && val !== "") attrs[name] = val.length > 100 ? val.slice(0, 100) : val;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        attrs.currentValue = (el.value || "").slice(0, 80);
      }
      if (el instanceof HTMLSelectElement) {
        attrs.currentValue = el.value || "";
        attrs.options = Array.from(el.options).slice(0, 10).map((o) => o.text.trim()).join(", ");
      }

      const text = getText(el);

      let selectorHint = null;
      const testId = el.getAttribute("data-testid");
      if (testId) {
        selectorHint = `[data-testid="${testId}"]`;
      } else if (attrs.id) {
        selectorHint = `#${attrs.id}`;
      } else if (attrs.name) {
        selectorHint = `${tag}[name="${attrs.name}"]`;
      }

      elements.push({
        ref: refId++,
        tag,
        text: text || "",
        attrs,
        selectorHint,
      });
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5);

    return {
      url: window.location.href,
      title: document.title || "",
      headings,
      elements,
    };
  }, maxElements);

  const text = formatSnapshotAsText(snapshot);
  return { ...snapshot, text };
}

/**
 * Format a DOM snapshot as a compact text representation for the LLM.
 */
function formatSnapshotAsText(snapshot) {
  const lines = [];
  lines.push(`Page: ${snapshot.title} (${snapshot.url})`);
  if (snapshot.headings.length > 0) {
    lines.push(`Headings: ${snapshot.headings.join(" | ")}`);
  }
  lines.push("");
  lines.push("Interactive elements:");
  for (const el of snapshot.elements) {
    const parts = [`[${el.ref}]`, `<${el.tag}>`];
    if (el.text) parts.push(`"${el.text}"`);
    const importantAttrs = [];
    if (el.attrs.id) importantAttrs.push(`id=${el.attrs.id}`);
    if (el.attrs["data-testid"]) importantAttrs.push(`data-testid=${el.attrs["data-testid"]}`);
    if (el.attrs.type) importantAttrs.push(`type=${el.attrs.type}`);
    if (el.attrs.placeholder) importantAttrs.push(`placeholder="${el.attrs.placeholder}"`);
    if (el.attrs.alt) importantAttrs.push(`alt="${el.attrs.alt}"`);
    if (el.attrs.title) importantAttrs.push(`title="${el.attrs.title}"`);
    if (el.attrs.role) importantAttrs.push(`role=${el.attrs.role}`);
    if (el.attrs.name) importantAttrs.push(`name=${el.attrs.name}`);
    if (el.attrs.href) importantAttrs.push(`href=${el.attrs.href.slice(0, 60)}`);
    if (el.attrs.disabled === "true" || el.attrs.disabled === "") importantAttrs.push("disabled");
    if (el.attrs.currentValue) importantAttrs.push(`value="${el.attrs.currentValue}"`);
    if (importantAttrs.length > 0) parts.push(`(${importantAttrs.join(", ")})`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

/**
 * Get page text content for state reporting.
 */
export async function getPageText(page, maxLength = 4000) {
  try {
    return await page.evaluate((max) => {
      return (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, max);
    }, maxLength);
  } catch {
    return "";
  }
}

/**
 * Get a DOM summary for session state (headings, buttons, links, inputs).
 */
export async function getDomSummary(page) {
  try {
    return await page.evaluate(() => {
      const collectVisible = (selector) =>
        Array.from(document.querySelectorAll(selector)).filter((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        });
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 8);
      const buttons = collectVisible("button, [role='button'], input[type='submit']");
      const links = collectVisible("a[href]");
      const inputs = collectVisible("input, textarea, select, [contenteditable='true']");
      return {
        title: document.title || "",
        url: window.location.href,
        headings,
        forms: document.querySelectorAll("form").length,
        visibleButtons: buttons.length,
        visibleLinks: links.length,
        visibleInputs: inputs.length,
        buttonLabels: buttons
          .map((el) => (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 10),
        linkLabels: links
          .map((el) => (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 10),
        inputHints: inputs
          .map((el) => el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || "")
          .map((v) => (v || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 12),
      };
    });
  } catch {
    return null;
  }
}
