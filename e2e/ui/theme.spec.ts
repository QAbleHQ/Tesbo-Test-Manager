import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
import {
  removeWorkspaceMember,
  screensSuiteSkipReason,
  screensTenant,
  seedWorkspaceMember,
} from "../utils/screens-tenant";

/*
 * Theme switching, and whether every screen actually follows it.
 *
 * Runs as the screens tenant so the sweep walks a project this suite owns — see
 * utils/screens-tenant.ts. Theme state itself is per-browser (localStorage), not per-account.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

const THEME_KEY = "tesbo-theme";

/** Reads the three things applyTheme() sets, so a partial application can't pass as a full one. */
async function readAppliedTheme(page: Page) {
  return page.evaluate(() => {
    // Guarded: THM-08 runs against a localStorage that throws on every access, and this helper
    // must still be able to report what the document looks like there.
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem("tesbo-theme");
    } catch {
      stored = null;
    }
    return {
      dataset: document.documentElement.dataset.theme ?? null,
      hasDarkClass: document.documentElement.classList.contains("dark"),
      colorScheme: document.documentElement.style.colorScheme || null,
      stored,
    };
  });
}

/**
 * Seeds a stored theme for every document this page loads.
 *
 * Only ever used to SET a value. "No stored theme" needs no arranging — each test gets a fresh
 * context, and the storage state these specs load was captured from an APIRequestContext, so it
 * carries cookies and no localStorage at all. Writing a remove-on-every-load init script instead
 * would re-clear the key on reload and quietly break the persistence tests.
 */
async function setStoredTheme(page: Page, value: string) {
  await page.addInitScript(
    ([key, theme]) => window.localStorage.setItem(key as string, theme as string),
    [THEME_KEY, value] as const,
  );
}

/**
 * The toggle lives in the top bar's own row (TopBar.tsx) as a single switch, not two separate
 * light/dark buttons — clicking it always flips to the opposite theme rather than selecting one
 * of two named targets.
 */
function themeSwitch(page: Page) {
  return page.getByRole("switch");
}

test.describe("theme toggle", () => {
  test.skip(!!skipReason, skipReason ?? "");

  test("THM-01 a browser that has never chosen renders light", { tag: '@tesbo.testId("TES-TC-837")' }, async ({ page }) => {
    await page.goto("/projects");
    await expect(themeSwitch(page)).toBeVisible();
    await expect(themeSwitch(page)).toHaveAttribute("aria-checked", "false");

    const applied = await readAppliedTheme(page);
    expect(applied.dataset).toBe("light");
    expect(applied.hasDarkClass).toBe(false);
    expect(applied.colorScheme).toBe("light");
    // Nothing is written until the user actually picks — a default is not a choice.
    expect(applied.stored).toBeNull();
  });

  test("THM-02/03 switching to dark and back applies and reverses all three signals", { tag: '@tesbo.testId("TES-TC-838")' }, async ({ page }) => {
    await page.goto("/projects");

    await themeSwitch(page).click();
    await expect.poll(async () => (await readAppliedTheme(page)).dataset).toBe("dark");
    const dark = await readAppliedTheme(page);
    expect(dark.hasDarkClass).toBe(true);
    expect(dark.colorScheme).toBe("dark");

    await themeSwitch(page).click();
    await expect.poll(async () => (await readAppliedTheme(page)).dataset).toBe("light");
    const light = await readAppliedTheme(page);
    expect(light.hasDarkClass).toBe(false);
    expect(light.colorScheme).toBe("light");
  });

  test("THM-04 the switch's aria-checked always reflects the current theme", { tag: '@tesbo.testId("TES-TC-839")' }, async ({ page }) => {
    await setStoredTheme(page, "dark");
    await page.goto("/projects");

    await expect(themeSwitch(page)).toHaveAttribute("aria-checked", "true");

    await themeSwitch(page).click();
    await expect(themeSwitch(page)).toHaveAttribute("aria-checked", "false");
  });

  test("THM-05 the choice is persisted and survives a reload", { tag: '@tesbo.testId("TES-TC-840")' }, async ({ page }) => {
    await page.goto("/projects");

    await themeSwitch(page).click();
    await expect.poll(async () => (await readAppliedTheme(page)).stored).toBe("dark");

    await page.reload();
    const afterReload = await readAppliedTheme(page);
    expect(afterReload.dataset).toBe("dark");
    expect(afterReload.hasDarkClass).toBe(true);
  });

  for (const stored of ["system", "", "AUTO", '{"mode":"dark"}']) {
    test(`THM-06 an unrecognised stored value (${JSON.stringify(stored)}) falls back to light`, async ({
      page,
    }) => {
      await setStoredTheme(page, stored);
      await page.goto("/projects");

      const applied = await readAppliedTheme(page);
      expect(applied.dataset).toBe("light");
      expect(applied.hasDarkClass).toBe(false);
    });
  }

  test("THM-07 dark is applied during parsing, before the app renders", { tag: '@tesbo.testId("TES-TC-845")' }, async ({ page, request }) => {
    /*
     * Two halves, both deterministic. First: the theme script is inline in <head>, ahead of any
     * body content, so the browser runs it while parsing rather than after hydration. Asserted
     * against the served HTML so it can't race. Second: the document really does come out dark.
     *
     * An earlier version raced the document with waitUntil:"commit" and flaked under full-suite
     * load; the served-HTML check proves the same property without depending on timing.
     */
    const html = await (await request.get("/projects")).text();
    const headEnd = html.indexOf("</head>");
    const scriptAt = html.indexOf("tesbo-theme");
    expect(scriptAt, "no theme bootstrap script in the document").toBeGreaterThan(-1);
    expect(scriptAt, "the theme bootstrap must run before the body is parsed").toBeLessThan(headEnd);

    await setStoredTheme(page, "dark");
    await page.goto("/projects", { waitUntil: "domcontentloaded" });

    const applied = await readAppliedTheme(page);
    expect(applied.dataset).toBe("dark");
    expect(applied.hasDarkClass).toBe(true);
  });

  test("THM-08 a browser that refuses localStorage still loads the app and themes the session", { tag: '@tesbo.testId("TES-TC-846")' }, async ({
    page,
  }) => {
    /*
     * lib/theme.ts wraps every localStorage access in try/catch, which says this scenario is meant
     * to be survivable. It isn't, anywhere else: the inline themeInitScript in app/layout.tsx and
     * the projects page's view-mode read (VIEW_STORAGE_KEY) both access storage unguarded, so the
     * throw escapes and Next renders its client-side exception screen instead of the app.
     *
     * The blast radius is the whole product, not the theme: a browser with site data blocked —
     * Safari private browsing, a locked-down enterprise profile — cannot use Tesbo at all.
     */
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.addInitScript(() => {
      const boom = () => {
        throw new DOMException("QuotaExceededError");
      };
      Object.defineProperty(window.localStorage, "setItem", { value: boom, configurable: true });
      Object.defineProperty(window.localStorage, "getItem", { value: boom, configurable: true });
    });
    await page.goto("/projects");

    await expect(
      page.getByText("Application error", { exact: false }),
      "the app should degrade to an unremembered theme, not to Next's client-side exception screen",
    ).toHaveCount(0);
    expect(pageErrors, "unguarded localStorage access escaped to the window").toEqual([]);

    await themeSwitch(page).click();
    await expect.poll(async () => (await readAppliedTheme(page)).dataset).toBe("dark");
  });

  test("THM-09 the theme holds across client-side navigation", { tag: '@tesbo.testId("TES-TC-847")' }, async ({ page }) => {
    await setStoredTheme(page, "dark");
    await page.goto("/projects");

    // Navigate the way a user does — through the nav, not by URL — so this exercises the
    // client-side transition rather than a fresh document each time.
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await page.waitForURL("**/dashboard");
    expect((await readAppliedTheme(page)).dataset).toBe("dark");

    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await page.waitForURL("**/projects");
    expect((await readAppliedTheme(page)).dataset).toBe("dark");
  });

  test("THM-10 the theme holds across a hard reload of a deep route", { tag: '@tesbo.testId("TES-TC-848")' }, async ({ page }) => {
    await setStoredTheme(page, "dark");
    await page.goto(`/projects/${tenant!.projectId}/testcases`);
    expect((await readAppliedTheme(page)).dataset).toBe("dark");

    await page.reload();
    expect((await readAppliedTheme(page)).dataset).toBe("dark");
  });

  test("THM-11 the theme belongs to the browser, not the session", { tag: '@tesbo.testId("TES-TC-849")' }, async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a disposable user to log out with");
    /*
     * A user of its own, never the shared screens session: logging out invalidates the session
     * server-side, and .auth/state-screens.json would still be holding that now-dead cookie for
     * every other spec in the run. A sacrificial member keeps the blast radius inside this test.
     */
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    const page = await context.newPage();
    try {
    await setStoredTheme(page, "dark");
    await page.goto("/projects");
    expect((await readAppliedTheme(page)).dataset).toBe("dark");

    // Logout lives in the top bar's user menu now, not the sidebar footer, and clicking it logs
    // out directly — there is no separate confirmation dialog to accept first.
    await page.getByRole("button", { name: "User menu" }).click();
    await page.getByRole("menuitem", { name: "Logout" }).click();
    await page.waitForURL("**/login");
    // Still dark with nobody signed in — the login screen follows the same stored choice.
    expect((await readAppliedTheme(page)).dataset).toBe("dark");

    await page.getByLabel("Email *", { exact: true }).fill(member.email);
    await page.getByLabel("Password *", { exact: true }).fill(member.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/projects/);

    expect((await readAppliedTheme(page)).dataset).toBe("dark");
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });
});

/*
 * ── THM-12/13/14: does every screen actually follow the theme? ──
 *
 * The toggle tests above prove the switch flips. These prove the app responds to it — that no page
 * keeps a hardcoded light surface, and that nothing becomes unreadable in either mode.
 *
 * The readability bar here is deliberately "unreadable", not "WCAG AA": a contrast ratio under 3:1
 * is text a person genuinely cannot make out, which is always a defect. Sub-AA-but-legible muted
 * text is a separate, softer question, asked once in THM-14 rather than on all 17 screens.
 *
 * Deliberately NOT screenshot baselines. Pixel snapshots of 17 screens x 2 themes would pass
 * trivially on the run that creates them, then fail on font rendering differences between a
 * developer's machine and CI — noise, not signal, and no statement about what "correct" means.
 */

/** Contrast/theming audit, run inside the page. Returns the offenders rather than a bare boolean. */
async function auditTheme(page: Page) {
  return page.evaluate(() => {
    const parseColor = (value: string): [number, number, number, number] | null => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((p) => parseFloat(p.trim()));
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };

    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    const contrast = (
      fg: [number, number, number, number],
      bg: [number, number, number, number],
    ): number => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    /**
     * What one element paints, or null if it paints nothing opaque.
     *
     * background-image has to be considered, not just background-color: globals.css gives body
     * `background: var(--shell-gradient)`, so the themed page background lives entirely in the
     * gradient and backgroundColor computes to rgba(0,0,0,0). Reading only the colour would
     * report every screen as transparent. Gradient stops are averaged — an approximation, but a
     * sound one for "is this surface light or dark".
     */
    const paintedBackground = (el: Element): [number, number, number, number] | null => {
      const style = getComputedStyle(el);
      const solid = parseColor(style.backgroundColor);
      if (solid && solid[3] > 0.9) return solid;

      const image = style.backgroundImage;
      if (image && image !== "none") {
        const stops = Array.from(image.matchAll(/rgba?\([^)]+\)/g))
          .map((m) => parseColor(m[0]))
          .filter((c): c is [number, number, number, number] => c !== null && c[3] > 0.9);
        if (stops.length > 0) {
          const avg = (i: number) => stops.reduce((sum, s) => sum + s[i], 0) / stops.length;
          return [avg(0), avg(1), avg(2), 1];
        }
      }
      return null;
    };

    /** The colour actually behind an element — walk up past everything that paints nothing. */
    const effectiveBackground = (el: Element): [number, number, number, number] => {
      let node: Element | null = el;
      while (node) {
        const painted = paintedBackground(node);
        if (painted) return painted;
        node = node.parentElement;
      }
      // Nothing in the tree paints: the user sees the UA canvas, which follows color-scheme.
      return getComputedStyle(document.documentElement).colorScheme.includes("dark")
        ? [18, 18, 18, 1]
        : [255, 255, 255, 1];
    };

    type Finding = { text: string; ratio: number; color: string; background: string };
    // Both bands carry their colour pair: sweepContrast dedups on it, and a subAA finding without
    // one collapsed every offender in a theme into a single entry that named none of them.
    const unreadable: Finding[] = [];
    const subAA: Finding[] = [];

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      if (ownText.length < 2) continue;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;

      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0") continue;

      const fg = parseColor(style.color);
      if (!fg || fg[3] === 0) continue;
      const bg = effectiveBackground(el);
      const ratio = contrast(fg, bg);

      // WCAG's large-text allowance: 18.66px bold, or 24px at any weight.
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const isLarge = size >= 24 || (bold && size >= 18.66);
      const aaFloor = isLarge ? 3 : 4.5;

      const finding: Finding = {
        text: ownText.slice(0, 60),
        ratio: Number(ratio.toFixed(2)),
        color: style.color,
        background: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
      };
      if (ratio < 3) unreadable.push(finding);
      else if (ratio < aaFloor) subAA.push(finding);
    }

    // Via effectiveBackground, not body's own backgroundColor: in light mode body is transparent
    // and <html> carries the paint, so reading body directly reports rgba(0,0,0,0) — which scores
    // as pure black and would fail every light-mode screen for the wrong reason.
    const bodyBg = effectiveBackground(document.body);
    return {
      theme: document.documentElement.dataset.theme ?? null,
      bodyLuminance: Number(luminance(bodyBg).toFixed(3)),
      unreadable,
      subAA,
    };
  });
}

test.describe("every screen follows the theme", () => {
  test.skip(!!skipReason, skipReason ?? "");

  const screens = (): { name: string; path: string }[] => [
    { name: "workspace dashboard", path: "/dashboard" },
    { name: "projects list", path: "/projects" },
    { name: "workspace activity", path: "/activity" },
    { name: "project dashboard", path: `/projects/${tenant!.projectId}/dashboard` },
    { name: "test cases", path: `/projects/${tenant!.projectId}/testcases` },
    { name: "test plans", path: `/projects/${tenant!.projectId}/plans` },
    { name: "runs", path: `/projects/${tenant!.projectId}/cycles` },
    { name: "bugs", path: `/projects/${tenant!.projectId}/bugs` },
    { name: "insights", path: `/projects/${tenant!.projectId}/reports` },
    { name: "requirements", path: `/projects/${tenant!.projectId}/requirements` },
    { name: "project activity", path: `/projects/${tenant!.projectId}/activity` },
    { name: "knowledge base", path: `/projects/${tenant!.projectId}/knowledge-base` },
    { name: "agents", path: `/projects/${tenant!.projectId}/agents` },
    { name: "project settings", path: `/projects/${tenant!.projectId}/settings` },
    { name: "workspace settings", path: "/settings" },
    { name: "workspace members", path: "/settings/members" },
    { name: "integrations", path: "/settings/integrations" },
  ];

  for (const theme of ["light", "dark"] as const) {
    for (const screen of skipReason ? [] : screens()) {
      test(`THM-12 ${screen.name} renders correctly in ${theme}`, async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await setStoredTheme(page, theme);
        await page.goto(screen.path);
        // Let the page settle past its loading spinner before auditing what it painted.
        await page.waitForLoadState("networkidle");

        const audit = await auditTheme(page);

        expect(audit.theme, "the theme was not applied to this route").toBe(theme);
        // THM-12e: a page that ignores the theme keeps a light surface in dark mode.
        if (theme === "dark") {
          expect(audit.bodyLuminance, "dark mode is painting a light page background").toBeLessThan(0.5);
        } else {
          expect(audit.bodyLuminance, "light mode is painting a dark page background").toBeGreaterThan(0.5);
        }
        expect(pageErrors, `client-side errors on ${screen.path}`).toEqual([]);
        // Contrast is deliberately NOT asserted per screen — see the aggregated sweeps below.
      });
    }
  }

  /**
   * Walks every screen in both themes and returns the distinct colour pairings that fall below
   * `floor`, worst first, with an example of the text affected and where it was found.
   *
   * Deduplicated by colour pair on purpose. These screens share a handful of components, so a
   * single bad token shows up on all 17 — asserting per screen would turn one root cause into 34
   * identical failures and bury the thing that actually needs fixing.
   */
  async function sweepContrast(page: Page, band: "unreadable" | "subAA") {
    const offenders = new Map<string, { color: string; background: string; ratio: number; example: string; screens: string[] }>();

    for (const theme of ["light", "dark"] as const) {
      await page.addInitScript(
        ([key, value]) => window.localStorage.setItem(key as string, value as string),
        [THEME_KEY, theme] as const,
      );
      for (const screen of screens()) {
        await page.goto(screen.path);
        await page.waitForLoadState("networkidle");
        const audit = await auditTheme(page);
        for (const finding of audit[band]) {
          const color = "color" in finding ? finding.color : "";
          const background = "background" in finding ? finding.background : "";
          const key = `${theme}|${color}|${background}`;
          const existing = offenders.get(key);
          if (existing) {
            if (!existing.screens.includes(screen.name)) existing.screens.push(screen.name);
          } else {
            offenders.set(key, {
              color: `${theme}: ${color}`,
              background,
              ratio: finding.ratio,
              example: finding.text,
              screens: [screen.name],
            });
          }
        }
      }
    }

    return Array.from(offenders.values()).sort((a, b) => a.ratio - b.ratio);
  }

  test("THM-13 no text anywhere is unreadable against what's behind it", { tag: '@tesbo.testId("TES-TC-884")' }, async ({ page }) => {
    test.slow();
    // Below 3:1 is not "a bit low" — it is text a person cannot reliably make out at any size.
    expect(await sweepContrast(page, "unreadable")).toEqual([]);
  });

  test("THM-14 text meets WCAG AA contrast in both themes", { tag: '@tesbo.testId("TES-TC-885")' }, async ({ page }) => {
    test.slow();
    // The softer bar: 4.5:1 for body text, 3:1 for large or bold text, per WCAG 2.1 AA.
    expect(await sweepContrast(page, "subAA")).toEqual([]);
  });
  test("THM-15 a toast is readable in both themes", { tag: '@tesbo.testId("TES-TC-1085")' }, async ({ page }) => {
    /*
     * Basecamp 10212550781 — "[work space settings] success message fonts are not visible".
     *
     * Every toast in the app was `bg-[var(--ink-800)] ... text-white`. --ink-800 flips with the theme
     * (#1C1E2A light, #F0EEFF dark) but `text-white` does not, so in dark mode a toast was near-white
     * text on a near-white chip — about 1.06:1, invisible. Five screens shared the markup.
     *
     * THM-13/THM-14 sweep every screen for exactly this and did not catch it, because a toast only
     * exists for a few seconds after a successful save and the sweep only ever walks resting screens.
     * This test closes that gap by actually producing one.
     *
     * Drives the workspace General tab's COUNTRY field rather than the workspace name: the save button
     * is disabled until something changes, and country is a harmless round-trip that no other spec
     * asserts on. The original value is restored at the end.
     */
    const contrastOf = (locator: import("@playwright/test").Locator) =>
      locator.evaluate((el) => {
        const parse = (value: string): [number, number, number] | null => {
          const m = value.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
          return parts.length >= 3 ? [parts[0], parts[1], parts[2]] : null;
        };
        const lum = ([r, g, b]: [number, number, number]) => {
          const ch = (c: number) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        const style = getComputedStyle(el);
        const fg = parse(style.color);
        const bg = parse(style.backgroundColor);
        if (!fg || !bg) return { ratio: 0, color: style.color, background: style.backgroundColor };
        const a = lum(fg);
        const b = lum(bg);
        return {
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          color: style.color,
          background: style.backgroundColor,
        };
      });

    let original = "";
    try {
      for (const theme of ["dark", "light"] as const) {
        await setStoredTheme(page, theme);
        /*
         * The page reloads shortly after a successful save so the sidebar and header pick the new name
         * up, which would tear the toast down mid-assertion. Neutralised for this test only — the
         * reload is not what is under test, the toast's legibility is.
         */
        await page.addInitScript(() => {
          Object.defineProperty(window.location, "reload", { configurable: true, value: () => {} });
        });
        await page.goto("/settings?tab=general");

        const country = page.locator("select").first();
        await expect(country).toBeVisible();
        if (!original) original = await country.inputValue();

        // Any value other than the one already saved, so Save is enabled.
        const options = await country.locator("option").evaluateAll((els) =>
          els.map((el) => (el as HTMLOptionElement).value).filter(Boolean),
        );
        const next = options.find((v) => v !== original);
        expect(next, "the country list offers only one value, so nothing can be changed").toBeTruthy();
        await country.selectOption(next!);

        await page.getByRole("button", { name: /Save changes/ }).click();

        const toast = page.getByText("Workspace details updated");
        await expect(toast, `no confirmation appeared in ${theme} mode`).toBeVisible();

        const measured = await contrastOf(toast);
        expect(
          measured.ratio,
          `the toast is ${measured.color} on ${measured.background} in ${theme} mode — ` +
            `${measured.ratio.toFixed(2)}:1, below the 4.5:1 AA bar`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      if (original) {
        // Put the workspace back the way it was found.
        await page.goto("/settings?tab=general");
        const country = page.locator("select").first();
        if (await country.isVisible().catch(() => false)) {
          await country.selectOption(original).catch(() => {});
          await page.getByRole("button", { name: /Save changes/ }).click().catch(() => {});
        }
      }
    }
  });
});
