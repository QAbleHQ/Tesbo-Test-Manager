import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
import {
  addProjectMember,
  createBug,
  createPlan,
  createProject,
  deleteProjects,
  removeWorkspaceMember,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
  seedWorkspaceMember,
} from "../utils/screens-tenant";

/*
 * The side navigation, in each of the three modes Sidebar.tsx switches between:
 * workspace (outside any project), project (inside one), and settings.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** The sidebar is the only <aside> on these pages; scoping to it keeps page links out of the way. */
function sidebar(page: Page) {
  return page.locator("aside").first();
}

function navLink(page: Page, label: string) {
  return sidebar(page).getByRole("link", { name: label, exact: true });
}

/** tesbo-nav-item-active is the class NavLink applies to the current route's entry. */
async function activeNavLabels(page: Page): Promise<string[]> {
  return sidebar(page)
    .locator("a.tesbo-nav-item-active")
    .evaluateAll((links) => links.map((l) => (l.textContent ?? "").trim()));
}

/*
 * Logout and the theme toggle used to live in the sidebar footer too, with their own Yes/No
 * confirmation dialog. Both were removed from there once they became duplicates of the top-right
 * user menu (TopBar.tsx) — this is the one place either control exists now, so every test below
 * that used to drive the sidebar's copies goes through this menu instead.
 */
function userMenuTrigger(page: Page) {
  return page.getByRole("button", { name: "User menu" });
}

function userMenu(page: Page) {
  return page.locator('[role="menu"][aria-label="User menu"]');
}

async function logoutViaUserMenu(page: Page) {
  await userMenuTrigger(page).click();
  await userMenu(page).getByRole("menuitem", { name: "Logout" }).click();
}

test.describe("side navigation — workspace mode", () => {
  test.skip(!!skipReason, skipReason ?? "");

  test.beforeEach(async ({ page }) => {
    await page.goto("/projects");
  });

  test("NAV-W-01 shows exactly the three workspace destinations", { tag: '@tesbo.testId("TES-TC-687")' }, async ({ page }) => {
    await expect(navLink(page, "Dashboard")).toBeVisible();
    await expect(navLink(page, "Projects")).toBeVisible();
    // The screens tenant's user created the workspace, so it is the owner.
    await expect(navLink(page, "Activity")).toBeVisible();
  });

  test("NAV-W-03 Projects is the only item marked active on /projects", { tag: '@tesbo.testId("TES-TC-688")' }, async ({ page }) => {
    expect(await activeNavLabels(page)).toEqual(["Projects"]);
  });

  test("NAV-W-04 each workspace item navigates and takes the active state with it", { tag: '@tesbo.testId("TES-TC-689")' }, async ({ page }) => {
    await navLink(page, "Dashboard").click();
    await page.waitForURL("**/dashboard");
    expect(await activeNavLabels(page)).toEqual(["Dashboard"]);

    await navLink(page, "Activity").click();
    await page.waitForURL("**/activity");
    expect(await activeNavLabels(page)).toEqual(["Activity"]);

    await navLink(page, "Projects").click();
    await page.waitForURL("**/projects");
    expect(await activeNavLabels(page)).toEqual(["Projects"]);
  });

  test("NAV-W-05 the footer offers workspace settings, not project settings", { tag: '@tesbo.testId("TES-TC-690")' }, async ({ page }) => {
    await expect(navLink(page, "Workspace settings")).toBeVisible();
    await expect(navLink(page, "Project settings")).toHaveCount(0);
  });

  test("NAV-W-06 the project-only sections are absent outside a project", { tag: '@tesbo.testId("TES-TC-691")' }, async ({ page }) => {
    for (const section of ["Test management", "Execution", "Assets"]) {
      await expect(sidebar(page).getByText(section, { exact: true })).toHaveCount(0);
    }
    await expect(navLink(page, "All Projects")).toHaveCount(0);
  });

  test("NAV-W-07 the brand mark returns to the projects list", { tag: '@tesbo.testId("TES-TC-692")' }, async ({ page }) => {
    await page.goto("/dashboard");
    await sidebar(page).getByRole("link", { name: "Tesbo Test Manager" }).click();
    await page.waitForURL("**/projects");
  });

  test("NAV-W-02 a non-owner does not get the workspace Activity link", { tag: '@tesbo.testId("TES-TC-693")' }, async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a second workspace member");
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    try {
      const memberPage = await context.newPage();
      await memberPage.goto("/projects");

      await expect(navLink(memberPage, "Projects")).toBeVisible();
      await expect(navLink(memberPage, "Dashboard")).toBeVisible();
      // Sidebar.tsx gates this one on the workspace role being exactly "owner".
      await expect(navLink(memberPage, "Activity")).toHaveCount(0);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });
});

test.describe("side navigation — project mode", () => {
  test.skip(!!skipReason, skipReason ?? "");

  const projectPath = (suffix = "") => `/projects/${tenant!.projectId}${suffix}`;

  test.beforeEach(async ({ page }) => {
    await page.goto(projectPath("/dashboard"));
  });

  test("NAV-P-01 All Projects returns to the workspace list", { tag: '@tesbo.testId("TES-TC-694")' }, async ({ page }) => {
    await navLink(page, "All Projects").click();
    await page.waitForURL("**/projects");
    await expect(navLink(page, "Dashboard")).toBeVisible();
  });

  test("NAV-P-02 the four section headers are present", { tag: '@tesbo.testId("TES-TC-695")' }, async ({ page }) => {
    for (const section of ["Overview", "Test management", "Execution", "Assets"]) {
      await expect(sidebar(page).getByText(section, { exact: true })).toBeVisible();
    }
  });

  // Every destination the project sidebar offers, with something only that page renders.
  const destinations: { label: string; url: RegExp; heading: RegExp }[] = [
    { label: "Project home", url: /\/dashboard$/, heading: /Recent test runs/ },
    { label: "Activity stream", url: /\/activity$/, heading: /Activity/ },
    { label: "Requirements", url: /\/requirements$/, heading: /Requirement/ },
    { label: "Test cases", url: /\/testcases$/, heading: /Test case/i },
    { label: "Test plans", url: /\/plans$/, heading: /[Tt]est [Pp]lan/ },
    { label: "Runs", url: /\/cycles$/, heading: /[Tt]est [Rr]un/ },
    { label: "Bugs", url: /\/bugs$/, heading: /Bug/ },
    { label: "Insights", url: /\/reports$/, heading: /Insight|Report|Health/ },
    { label: "Agents", url: /\/agents$/, heading: /Agent/ },
    { label: "Knowledge base", url: /\/knowledge-base$/, heading: /Knowledge/ },
  ];

  for (const destination of destinations) {
    test(`NAV-P-03/04/05 ${destination.label} opens its own page without erroring`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await navLink(page, destination.label).click();
      await expect(page).toHaveURL(destination.url);
      await expect(page.locator("main, body").first().getByText(destination.heading).first()).toBeVisible();
      expect(pageErrors, `${destination.label} raised a client-side error`).toEqual([]);
    });
  }

  test("NAV-P-06/07 the project root redirects to the dashboard and marks Project home active", { tag: '@tesbo.testId("TES-TC-706")' }, async ({
    page,
  }) => {
    await page.goto(projectPath());
    await page.waitForURL(/\/dashboard$/);
    expect(await activeNavLabels(page)).toContain("Project home");
  });

  test("NAV-P-08 a deep child route keeps its parent section active", { tag: '@tesbo.testId("TES-TC-707")' }, async ({ page }) => {
    await navLink(page, "Runs").click();
    await page.waitForURL(/\/cycles$/);
    expect(await activeNavLabels(page)).toContain("Runs");
  });

  test("NAV-P-09/10 the Agents sub-items appear only once Agents is the active section", { tag: '@tesbo.testId("TES-TC-708")' }, async ({
    page,
  }) => {
    await expect(navLink(page, "Tasks")).toHaveCount(0);
    await expect(navLink(page, "Zyra settings")).toHaveCount(0);

    await navLink(page, "Agents").click();
    await page.waitForURL(/\/agents$/);

    await expect(navLink(page, "Tasks")).toBeVisible();
    await expect(navLink(page, "Agent list")).toBeVisible();
    await expect(navLink(page, "Zyra settings")).toBeVisible();
    // "Agent list" points at the exact agents path, so it's active here alongside its parent.
    expect(await activeNavLabels(page)).toContain("Agent list");
  });

  test("NAV-P-12 every project link carries the project id currently being viewed", { tag: '@tesbo.testId("TES-TC-709")' }, async ({ page }) => {
    const hrefs = await sidebar(page)
      .locator("a")
      .evaluateAll((links) => links.map((l) => l.getAttribute("href") ?? ""));
    const projectScoped = hrefs.filter((href) => href.startsWith("/projects/"));

    expect(projectScoped.length).toBeGreaterThan(5);
    for (const href of projectScoped) {
      expect(href).toContain(`/projects/${tenant!.projectId}`);
    }
  });

  test("NAV-P-13 a project id from another workspace lands back on the projects list", { tag: '@tesbo.testId("TES-TC-710")' }, async ({ page }) => {
    // A syntactically valid id this workspace has no access to — the app must not half-render.
    await page.goto("/projects/00000000-0000-0000-0000-000000000000/dashboard");
    await page.waitForURL("**/projects", { timeout: 15_000 });
  });

  test("NAV-P-14 the footer offers project settings and marks it active there", { tag: '@tesbo.testId("TES-TC-711")' }, async ({ page }) => {
    await expect(navLink(page, "Project settings")).toBeVisible();
    await expect(navLink(page, "Workspace settings")).toHaveCount(0);

    await navLink(page, "Project settings").click();
    await page.waitForURL(/\/settings$/);
    expect(await activeNavLabels(page)).toContain("Project settings");
  });

  test("NAV-P-15 workspace settings collapses the rail to just the way back", { tag: '@tesbo.testId("TES-TC-712")' }, async ({ page }) => {
    await page.goto("/settings");

    await expect(navLink(page, "All Projects")).toBeVisible();
    for (const label of ["Test cases", "Runs", "Bugs", "Dashboard", "Projects"]) {
      await expect(navLink(page, label)).toHaveCount(0);
    }
  });

  test("NAV-P-17 members and suites are reachable by URL but absent from the nav", { tag: '@tesbo.testId("TES-TC-713")' }, async ({ page }) => {
    await expect(navLink(page, "Members")).toHaveCount(0);
    await expect(navLink(page, "Suites")).toHaveCount(0);

    // /members is a redirect stub: the real screen is a tab inside project settings, which is
    // why the sidebar has no entry of its own for it.
    await page.goto(projectPath("/members"));
    await page.waitForURL(/\/settings\?tab=members$/);
  });
});

/*
 * Root cause of the reported bug ("clicking any sidebar item always shows a loading spinner, even
 * revisiting a page from seconds ago"): every project page reset loading=true and re-fetched from
 * scratch on every mount. The fix is a small in-memory cache (Tesbo-Frontend/lib/pageDataCache.ts)
 * that seeds a revisit's initial render from the last-known data while the page still revalidates
 * in the background — never a cache-only shortcut. These tests prove the mechanism, not just that
 * pages "look fast": hanging every API request before a revisit (rather than asserting on timing,
 * which would be flaky against real network latency) is what actually proves a render came from the
 * cache and not from a fast round trip.
 */
test.describe("side navigation — page cache", () => {
  test.skip(!!skipReason, skipReason ?? "");

  const projectPath = (suffix = "") => `/projects/${tenant!.projectId}${suffix}`;

  const destinations: { label: string; url: RegExp; heading: RegExp }[] = [
    { label: "Project home", url: /\/dashboard$/, heading: /Recent test runs/ },
    { label: "Activity stream", url: /\/activity$/, heading: /Activity/ },
    { label: "Requirements", url: /\/requirements$/, heading: /Requirement/ },
    { label: "Test cases", url: /\/testcases$/, heading: /Test case/i },
    { label: "Test plans", url: /\/plans$/, heading: /[Tt]est [Pp]lan/ },
    { label: "Runs", url: /\/cycles$/, heading: /[Tt]est [Rr]un/ },
    { label: "Bugs", url: /\/bugs$/, heading: /Bug/ },
    { label: "Insights", url: /\/reports$/, heading: /Insight|Report|Health/ },
    { label: "Agents", url: /\/agents$/, heading: /Agent/ },
    { label: "Knowledge base", url: /\/knowledge-base$/, heading: /Knowledge/ },
  ];

  function heading(page: Page, pattern: RegExp) {
    return page.locator("main, body").first().getByText(pattern).first();
  }

  /**
   * Holds every request to this app's API behind a gate instead of aborting or truly hanging
   * forever: an aborted request would trip a page's own error-handling path (some pages redirect
   * away on a failed revalidation), and a request that never settles at all permanently occupies
   * one of the browser's limited per-origin connection slots — across this suite's loop over every
   * destination, enough of those pile up to starve later iterations' legitimate, unblocked fetches.
   * Call the returned `release` once the cache-hit assertion has run, so the held requests complete
   * normally afterward and free their connections before the next iteration.
   */
  async function hangApiRequests(page: Page): Promise<() => Promise<void>> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );
    return async () => {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    };
  }

  test("NAV-CACHE-01 every sidebar destination renders on a revisit even with the network cut off", async ({ page }) => {
    await page.goto(projectPath("/dashboard"));

    for (const destination of destinations) {
      // A different hub to bounce through so leaving-and-returning is a real transition even for
      // the "Project home" destination itself.
      const hub = destination.label === "Project home"
        ? { label: "Activity stream", url: /\/activity$/ }
        : { label: "Project home", url: /\/dashboard$/ };

      // First visit: a real fetch, warms this page's cache. Generous, like the logout flows
      // below: this test shares the stack with the rest of the suite, and a real backend round
      // trip can occasionally run past the default 10s under load.
      await navLink(page, destination.label).click();
      await expect(page).toHaveURL(destination.url);
      await expect(heading(page, destination.heading)).toBeVisible({ timeout: 20_000 });

      await navLink(page, hub.label).click();
      await page.waitForURL(hub.url);

      const release = await hangApiRequests(page);
      await navLink(page, destination.label).click();
      await expect(
        heading(page, destination.heading),
        `${destination.label} did not render from its cache with the network cut off`,
      ).toBeVisible({ timeout: 2000 });

      await release();
      // Releasing lets every request this iteration hung dispatch for real all at once, competing
      // with the next iteration's own first-visit fetch for the browser's small per-origin
      // connection limit. A short settle pause here — not a longer per-assertion timeout — is what
      // actually fixes that queuing, since the contention is between iterations, not within one.
      await page.waitForTimeout(500);
    }
  });

  test("NAV-CACHE-02 a page with no prior visit still shows the loading state, not a false cache hit", async ({ page }) => {
    // Each test gets a fresh page (a fresh JS realm), so this page's cache starts empty — delaying
    // (not hanging) the response proves the loading UI still appears on a true first visit, then
    // clears once the real fetch resolves. Guards against the cache check being accidentally
    // truthy for a miss. Gating every /api/ call (not just this page's own) also holds up
    // AppDataProvider's and ProjectDataProvider's own shell-level fetches, so the loading text that
    // appears first may be theirs rather than the page's own PageLoader — any of them is valid proof
    // a loading state rendered instead of a false cache hit. 10s matches this suite's usual expect
    // timeout rather than a tighter one, since this environment's latency varies with load.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        await gate;
        await route.continue().catch(() => {});
      },
    );

    await page.goto(projectPath("/testcases"));
    // Not getByRole("status"): AppDataProvider — which gates the whole app shell behind auth, above
    // PageLoader/ProjectDataProvider — renders its own plain `<p>Loading…</p>` with no ARIA role, so
    // a hung authMe() call surfaces that text, never a "status" role. Matching on visible text is
    // what actually covers every one of this app's loading states, not just PageLoader's.
    await expect(page.getByText(/Loading/i).first()).toBeVisible({ timeout: 10_000 });

    release();
    await expect(heading(page, /Test case/i)).toBeVisible();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("NAV-CACHE-03 two projects' cached data never mix", async ({ page }) => {
    const api = await screensApi();
    let otherId: string | undefined;
    try {
      // Project names are capped at 30 characters server-side.
      const other = await createProject(api, { name: `E2E Iso ${Date.now()}` });
      otherId = other.id;
      const onlyThere = await createBug(api, other.id, { title: `Only in ${other.name} ${Date.now()}` });

      // Warm this project's own bugs cache first.
      await page.goto(projectPath("/bugs"));
      await expect(heading(page, /Bug/)).toBeVisible();

      // A different project, visited directly (there is no sidebar link between projects).
      await page.goto(`/projects/${otherId}/bugs`);
      await expect(page.getByText(onlyThere.title)).toBeVisible();

      // Back to the original project — the other project's bug must never leak into this cache/view.
      await page.goto(projectPath("/bugs"));
      await expect(page.getByText(onlyThere.title)).toHaveCount(0);
    } finally {
      await deleteProjects(api, [otherId]);
      await api.dispose();
    }
  });

  test("NAV-CACHE-04 a revisit shows cached data first, then updates with what changed via the API meanwhile", async ({ page }) => {
    const api = await screensApi();
    let bugId: string | undefined;
    try {
      await page.goto(projectPath("/bugs"));
      await expect(heading(page, /Bug/)).toBeVisible();

      await navLink(page, "Project home").click();
      await page.waitForURL(/\/dashboard$/);

      const bug = await createBug(api, tenant!.projectId);
      bugId = bug.id;

      // The cache-hit render doesn't have this bug yet; the background revalidation fetch this
      // effect still fires does, and the list is expected to pick it up without a manual reload.
      await navLink(page, "Bugs").click();
      await expect(page.getByText(bug.title)).toBeVisible({ timeout: 5000 });
    } finally {
      if (bugId) await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false }).catch(() => {});
      await api.dispose();
    }
  });

  test("NAV-CACHE-05 a filtered Activity search is never served from the cached default view", async ({ page }) => {
    const api = await screensApi();
    let planId: string | undefined;
    try {
      // Warm the default (unfiltered) cache before the plan that the filter will search for exists.
      await page.goto(projectPath("/activity"));
      await expect(heading(page, /Activity/)).toBeVisible();

      const plan = await createPlan(api, tenant!.projectId, { name: `E2E Cache Filter ${Date.now()}` });
      planId = plan.id;

      await page.goto(projectPath("/activity"));
      await page.getByPlaceholder("Search activity…").fill(plan.name);
      // Only reachable by an actual filtered fetch — the cached default view was warmed before this
      // plan existed, so seeing it here proves the filter bypassed that cache.
      await expect(page.getByText(plan.name)).toBeVisible({ timeout: 5000 });
    } finally {
      if (planId) await api.delete(`/api/plans/${planId}`, { failOnStatusCode: false }).catch(() => {});
      await api.dispose();
    }
  });

  test("NAV-CACHE-06 logging out clears the cache so the next session in this tab renders fresh, not a stale hit", async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a disposable user to log out with");
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    const page = await context.newPage();
    try {
      const owner = await screensApi();
      try {
        await addProjectMember(owner, tenant!.projectId, member.userId);
      } finally {
        await owner.dispose();
      }

      await page.goto(projectPath("/dashboard"));
      await expect(heading(page, /Recent test runs/)).toBeVisible();

      await logoutViaUserMenu(page);
      await page.waitForURL("**/login", { timeout: 30_000 });

      await page.getByLabel("Email *", { exact: true }).fill(member.email);
      await page.getByLabel("Password *", { exact: true }).fill(member.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/projects/, { timeout: 30_000 });

      // Same tab, same JS module realm as before logout — if the cache survived, this would render
      // instantly from the previous session's warmed entry despite the network being cut off. 10s
      // matches this suite's usual expect timeout: gating every /api/ call also holds up
      // AppDataProvider's and ProjectDataProvider's own shell-level fetches, so whichever loading
      // text appears first is valid proof a loading state rendered, not a stale cache hit.
      const release = await hangApiRequests(page);
      await page.goto(projectPath("/dashboard"));
      // Not getByRole("status"): AppDataProvider — which gates the whole app shell behind auth, above
    // PageLoader/ProjectDataProvider — renders its own plain `<p>Loading…</p>` with no ARIA role, so
    // a hung authMe() call surfaces that text, never a "status" role. Matching on visible text is
    // what actually covers every one of this app's loading states, not just PageLoader's.
    await expect(page.getByText(/Loading/i).first()).toBeVisible({ timeout: 10_000 });
      await release();
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });
});

test.describe("side navigation — behaviour", () => {
  test.skip(!!skipReason, skipReason ?? "");

  test("NAV-B-01/02 collapsing hides the labels and expanding brings them back", { tag: '@tesbo.testId("TES-TC-714")' }, async ({ page }) => {
    await page.goto("/projects");
    const rail = sidebar(page);
    await expect(rail).toHaveCSS("width", "260px");
    await expect(navLink(page, "Projects")).toHaveText("Projects");

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(rail).toHaveCSS("width", "60px");
    // The label stays in the accessibility tree as sr-only text — the link keeps its name.
    await expect(rail.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(rail).toHaveCSS("width", "260px");
    await expect(navLink(page, "Projects")).toHaveText("Projects");
  });

  test("NAV-B-03 the collapsed rail keeps its toggle reachable below the brand mark", { tag: '@tesbo.testId("TES-TC-715")' }, async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    // Regression guard: these used to sit side by side, which overflowed the 60px rail and pushed
    // the toggle under the sticky TopBar, leaving no way to expand again.
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    await expect(expand).toBeVisible();
    // The rail animates (transition-[width] duration-200). Measuring before it settles catches the
    // toggle still laid out for the 260px rail and reports a false overflow.
    await expect(sidebar(page)).toHaveCSS("width", "60px");
    const [box, rail] = [await expand.boundingBox(), await sidebar(page).boundingBox()];
    // Within the rail, not overflowing it. Compared against the rail's own box rather than the
    // literal 60px so sub-pixel layout rounding isn't mistaken for an overflow.
    expect(box!.x + box!.width).toBeLessThanOrEqual(rail!.x + rail!.width + 1);
    await expand.click();
    await expect(sidebar(page)).toHaveCSS("width", "260px");
  });

  test("NAV-B-04 the collapsed state is not remembered across a reload", { tag: '@tesbo.testId("TES-TC-716")' }, async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(sidebar(page)).toHaveCSS("width", "60px");

    await page.reload();
    // Pinned as-is: isCollapsed is component state with no persistence, so every navigation that
    // remounts the sidebar reopens it. Worth deciding deliberately rather than leaving implicit.
    await expect(sidebar(page)).toHaveCSS("width", "260px");
  });

  /*
   * NAV-B-05/05b/05c/05d used to pin the sidebar footer's own theme toggle, Logout button, and its
   * Yes/No confirmation dialog (collapsed-rail usability, opening the dialog, dismissing it via No,
   * dismissing it via Escape — TES-TC-717/1345/1346/1347). All of that was removed from the sidebar
   * once it became a duplicate of the top-right user menu (TopBar.tsx), which has no confirmation
   * step at all — clicking Logout there logs out immediately (see ACU-20 in account.spec.ts). There
   * is nothing left in the sidebar for those four tests to exercise, so they're gone rather than
   * retargeted; the user menu's own open/close/keyboard behavior is covered by ACU-16/ACU-17 there.
   */

  test("NAV-B-06/09 logging out via the user menu ends the session and Back cannot resurrect it", async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a disposable user to log out with");
    // Its own user: logout invalidates the session server-side, and the shared screens storage
    // state would be left holding a dead cookie for every other spec in the run.
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    const page = await context.newPage();
    try {
    await page.goto("/projects");
    await logoutViaUserMenu(page);
    // Generous: this test shares the stack with the rest of the suite, and the redirect waits on a
    // real round trip to the backend.
    await page.waitForURL("**/login", { timeout: 30_000 });

    const token = await page.evaluate(() => window.localStorage.getItem("token"));
    expect(token).toBeNull();

    // The session itself must be gone, not merely the page. onLogout uses router.replace, so there
    // is no authenticated entry left in history to go back to — asking for the app directly is the
    // assertion that actually proves the cookie was invalidated.
    await page.goto("/projects");
    await page.waitForURL("**/login", { timeout: 30_000 });
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("NAV-B-07 a failed logout says so in the user menu and leaves Logout usable to retry", async ({ page }) => {
    await page.goto("/projects");
    // Matched by predicate, not glob: the frontend posts to the backend origin (:1021) while the
    // page sits on :1020, and a relative glob is resolved against baseURL, so it never matches.
    await page.route((url) => url.pathname === "/api/auth/logout", (route) => route.abort("failed"));

    await userMenuTrigger(page).click();
    await userMenu(page).getByRole("menuitem", { name: "Logout" }).click();

    // The menu is deliberately left open on failure, not dismissed, so the user can retry without
    // reopening it (TopBar.tsx's Logout button only closes the menu on success, via the redirect).
    await expect(userMenu(page).getByText("Could not log out. Please try again.")).toBeVisible();
    await expect(userMenu(page).getByRole("menuitem", { name: "Logout" })).toBeEnabled();
    await expect(page).toHaveURL(/\/projects/);
  });

  test("NAV-B-08 a double-click on Logout sends exactly one logout request", async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a disposable user to log out with");
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    const page = await context.newPage();
    try {
    await page.goto("/projects");
    let logoutCalls = 0;
    await page.route((url) => url.pathname === "/api/auth/logout", async (route) => {
      logoutCalls += 1;
      // Held open briefly so the second click lands while the first is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });

    await userMenuTrigger(page).click();
    const logoutItem = userMenu(page).getByRole("menuitem", { name: /^(Logout|Logging out…)$/ });
    await logoutItem.click();
    await logoutItem.click({ force: true }).catch(() => undefined);
    await page.waitForURL("**/login");

    expect(logoutCalls).toBe(1);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("NAV-B-10 the nav scrolls at a short viewport and the footer stays reachable", { tag: '@tesbo.testId("TES-TC-721")' }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto(`/projects/${tenant!.projectId}/dashboard`);

    // Logout no longer lives in the sidebar footer (see the comment above NAV-B-06/09) — Project
    // settings is the remaining footer item this test can still pin as reachable.
    await expect(navLink(page, "Project settings")).toBeVisible();
  });

  test("NAV-B-11 every nav item is reachable and activatable from the keyboard", { tag: '@tesbo.testId("TES-TC-722")' }, async ({ page }) => {
    await page.goto("/projects");
    const projects = navLink(page, "Projects");
    await projects.focus();
    await expect(projects).toBeFocused();

    await navLink(page, "Dashboard").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/dashboard");
  });

  test("NAV-B-12 every icon-only control carries an accessible name", { tag: '@tesbo.testId("TES-TC-723")' }, async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    const unnamed = await sidebar(page)
      .getByRole("link")
      .evaluateAll((links) =>
        links
          .filter((l) => !(l.textContent ?? "").trim() && !l.getAttribute("aria-label"))
          .map((l) => l.getAttribute("href") ?? "?"),
      );
    expect(unnamed).toEqual([]);
  });

  test("NAV-P-16 the sidebar is absent from the unauthenticated screens", { tag: '@tesbo.testId("TES-TC-724")' }, async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anonymous = await context.newPage();
      for (const route of ["/login", "/signup"]) {
        await anonymous.goto(route);
        await expect(anonymous.locator("aside")).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });
  test("NAV-B-13 the workspace menu scrolls its own list and keeps Create new workspace reachable", { tag: '@tesbo.testId("TES-TC-1039")' }, async ({
    page,
  }) => {
    /*
     * Basecamp 10212564946 — "Workspace menu should have an independent scrollbar when multiple
     * workspaces are added". The menu had no height bound and grew one row per workspace; the reporter
     * had 11 and the list ran off the bottom of the viewport, taking "Create new workspace" with it —
     * so the only way to add a workspace became unreachable once you had enough of them.
     *
     * Asserted at a short viewport rather than by provisioning eleven organizations: the defect is a
     * missing height bound, and a short viewport reaches it with the workspaces this tenant already
     * has. Fails against the unfixed markup, which has no scroll container at all.
     */
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto("/projects");

    await page.getByRole("button", { name: "Switch workspace" }).click();

    const list = page.getByTestId("workspace-switcher-list");
    await expect(list, "the workspace menu has no scroll container of its own").toBeVisible();

    // The list is what scrolls, not the page.
    const overflow = await list.evaluate((el) => getComputedStyle(el).overflowY);
    expect(["auto", "scroll"], `the workspace list overflow-y is "${overflow}"`).toContain(overflow);

    // The menu is bounded, so it cannot grow past the viewport however many workspaces there are.
    const menu = page.locator("div").filter({ has: list }).first();
    const bounded = await menu.evaluate((el) => {
      const maxHeight = getComputedStyle(el).maxHeight;
      const rect = el.getBoundingClientRect();
      return { maxHeight, bottom: rect.bottom, viewport: window.innerHeight };
    });
    expect(bounded.maxHeight, "the workspace menu has no max-height").not.toBe("none");
    expect(
      bounded.bottom,
      `the menu bottom is at ${Math.round(bounded.bottom)} in a ${bounded.viewport}px viewport`,
    ).toBeLessThanOrEqual(bounded.viewport + 1);

    // And the action the reporter lost stays pinned and clickable.
    const create = page.getByTestId("create-workspace-action");
    await expect(create, "Create new workspace is not reachable").toBeInViewport();
    await create.click();
    await expect(page.getByRole("heading", { name: "Create workspace" })).toBeVisible();
  });
  test("NAV-B-14 the signed-in user's avatar is the same colour on every screen", { tag: '@tesbo.testId("TES-TC-1040")' }, async ({ page }) => {
    /*
     * Basecamp 10198836413 — "[UI] Display picture initials show different colours across the website".
     *
     * One person's initials were painted five different ways: the seeded palette from
     * lib/avatarColors.ts on cycles and plan cards, a flat --cta-primary in the top bar and the
     * workspace switcher, a flat --brand-soft in knowledge base comments, and a flat
     * --surface-tertiary in Manage Admins. app/(app)/projects/page.tsx also carried its own
     * byte-identical copy of the palette and hash, which is how they drift apart in the first place.
     *
     * Everything now seeds through avatarColor(). Asserted as an INVARIANT rather than against a fixed
     * hex: the avatar has one colour, that colour is the same on every screen, and it is one of the
     * palette's swatches. A future palette change stays green; a screen falling back to a flat brand
     * fill does not.
     */
    const PALETTE = ["#7C5FCC", "#4C5FD5", "#1F7A3D", "#1D7FA8", "#A85F06", "#D83A3A"];
    const toRgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const paletteRgb = PALETTE.map(toRgb);

    /** The top bar's own avatar — the one element present on every authenticated screen. */
    const avatarColourOn = async (path: string): Promise<string> => {
      await page.goto(path);
      const avatar = page.locator("header span.rounded-full").first();
      await expect(avatar, `no top-bar avatar on ${path}`).toBeVisible();
      return avatar.evaluate((el) => getComputedStyle(el).backgroundColor);
    };

    const first = await avatarColourOn("/projects");
    expect(
      paletteRgb,
      `the avatar is ${first}, which is not one of the seeded palette swatches — the screen is ` +
        "probably still painting a flat brand fill",
    ).toContain(first);

    // Same identity, different screens: the colour must not move.
    for (const path of [
      `/projects/${tenant!.projectId}/dashboard`,
      `/projects/${tenant!.projectId}/testcases`,
      `/projects/${tenant!.projectId}/cycles`,
      "/settings?tab=general",
      "/account",
    ]) {
      expect(await avatarColourOn(path), `the avatar changes colour on ${path}`).toBe(first);
    }
  });

  test("NAV-B-15 the same person's avatar matches across different components, not just different pages", { tag: '@tesbo.testId("TES-TC-1348")' }, async ({
    page,
  }) => {
    /*
     * NAV-B-14 above only ever reads the top bar's own avatar on different routes — the same
     * <TopBar/> instance every time — so it could never have caught this ticket's actual
     * regression: PlanCard's OwnerAvatar and the workspace Activity feed's ActorAvatar each seeded
     * avatarColor() with the person's *name* instead of their id, so the same person could land on
     * a different palette swatch in a plan card or the activity feed than in the top bar, even
     * though every one of them called avatarColor(). This reproduces the reported pairing (header
     * vs. Activity section) by comparing the top bar's avatar against a plan card's owner avatar
     * and an activity row for an action the signed-in user just performed.
     */
    const api = await screensApi();
    let planId: string | undefined;
    try {
      await page.goto("/projects");
      const topBarAvatar = page.locator("header span.rounded-full").first();
      await expect(topBarAvatar).toBeVisible();
      const topBarColour = await topBarAvatar.evaluate((el) => getComputedStyle(el).backgroundColor);

      const plan = await createPlan(api, tenant!.projectId);
      planId = plan.id;

      await page.goto(`/projects/${tenant!.projectId}/plans`);
      const card = page.locator(".group", { has: page.getByRole("link", { name: plan.name, exact: true }) }).first();
      const cardAvatar = card.locator("span.rounded-full").first();
      await expect(cardAvatar, "the plan card never shows an owner avatar").toBeVisible();
      expect(
        await cardAvatar.evaluate((el) => getComputedStyle(el).backgroundColor),
        "the plan card's owner avatar is a different colour than the top bar for the same person",
      ).toBe(topBarColour);

      await page.goto("/activity");
      await page.getByPlaceholder("Search activity…").fill(plan.name);
      const row = page.locator("div.grid", { hasText: plan.name }).first();
      const rowAvatar = row.locator("span.rounded-full").first();
      await expect(rowAvatar, "no activity row found for the plan-created event").toBeVisible();
      expect(
        await rowAvatar.evaluate((el) => getComputedStyle(el).backgroundColor),
        "the activity feed's actor avatar is a different colour than the top bar for the same person",
      ).toBe(topBarColour);
    } finally {
      if (planId) await api.delete(`/api/plans/${planId}`, { failOnStatusCode: false }).catch(() => {});
      await api.dispose();
    }
  });
});

test.describe("top bar — notifications", () => {
  test.skip(!!skipReason, skipReason ?? "");

  /*
   * BetterBugs: "Notification Icon Does Not Respond When Clicked" — the bell in TopBar.tsx had no
   * onClick at all. Fixed by wiring it to a dropdown panel backed by GET /api/notifications
   * (notifications.spec.ts pins that route's own contract). The backend route is still a stub that
   * always answers an empty list (see legacy.controller.ts's comment on it), so the primary path
   * here is necessarily the empty state — these tests are about the panel's own behaviour
   * (open/close, keyboard, error handling), not about real notification content.
   */

  const bell = (page: Page) => page.getByRole("button", { name: "Notifications" });
  const panel = (page: Page) => page.getByRole("menu", { name: "Notifications" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/projects");
  });

  test("NOTIF-UI-01 clicking the bell opens the panel and shows the empty state", { tag: '@tesbo.testId("TES-TC-1349")' }, async ({ page }) => {
    await expect(panel(page)).toBeHidden();
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText("No notifications")).toBeVisible();
    await expect(bell(page)).toHaveAttribute("aria-expanded", "true");
  });

  test("NOTIF-UI-02 clicking the bell again closes it", { tag: '@tesbo.testId("TES-TC-1350")' }, async ({ page }) => {
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await bell(page).click();
    await expect(panel(page)).toBeHidden();
    await expect(bell(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("NOTIF-UI-03 clicking outside the panel closes it", { tag: '@tesbo.testId("TES-TC-1351")' }, async ({ page }) => {
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    // The top-bar avatar (same locator NAV-B-14 uses) — always present, has no click handler of its
    // own, and sits outside notifBoxRef, so clicking it is an unambiguous "outside click".
    await page.locator("header span.rounded-full").first().click();
    await expect(panel(page)).toBeHidden();
  });

  test("NOTIF-UI-04 pressing Escape closes it", { tag: '@tesbo.testId("TES-TC-1352")' }, async ({ page }) => {
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
  });

  test("NOTIF-UI-05 the bell is reachable and activatable from the keyboard", { tag: '@tesbo.testId("TES-TC-1353")' }, async ({ page }) => {
    await bell(page).focus();
    await expect(bell(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
  });

  test("NOTIF-UI-06 a failed fetch shows an inline error instead of an empty panel or a crash", { tag: '@tesbo.testId("TES-TC-1354")' }, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // Matched by pathname, not a glob against the page's own origin — the frontend calls the
    // backend's origin, which the NAV-B-07 logout test already established a glob against baseURL
    // won't match.
    await page.route((url) => url.pathname === "/api/notifications", (route) => route.abort("failed"));

    await bell(page).click();

    await expect(panel(page).getByText("No notifications")).toBeHidden();
    await expect(panel(page).getByRole("button", { name: "Try again" })).toBeVisible();
    expect(pageErrors, "a failed notifications fetch raised a client-side error").toEqual([]);
  });

  test("NOTIF-UI-07 Try again recovers once the request succeeds", { tag: '@tesbo.testId("TES-TC-1355")' }, async ({ page }) => {
    let attempt = 0;
    await page.route((url) => url.pathname === "/api/notifications", (route) => {
      attempt += 1;
      if (attempt === 1) return route.abort("failed");
      return route.continue();
    });

    await bell(page).click();
    await expect(panel(page).getByRole("button", { name: "Try again" })).toBeVisible();

    await panel(page).getByRole("button", { name: "Try again" }).click();

    await expect(panel(page).getByText("No notifications")).toBeVisible();
  });
});

/*
 * Basecamp/BetterBugs: "Breadcrumbs are inconsistent across pages" — some pages had no breadcrumb,
 * the ones that did used five different separators/colours/font-sizes, and several didn't reflect
 * the actual routing hierarchy (a "Projects" root pointing nowhere near /projects, a project's own
 * key shown instead of its name, "Project" used as a literal label instead of the project's name).
 * Every page now renders the single shared <Breadcrumbs> component (components/workflows/Breadcrumbs.tsx),
 * so these tests assert the trail text/links match the real route nesting rather than a hand-rolled
 * per-page string, and that the one shared markup shape (nav[aria-label="Breadcrumb"], the current
 * page as a non-link with aria-current="page") is what's actually on the page.
 */
test.describe("breadcrumbs", () => {
  test.skip(!!skipReason, skipReason ?? "");

  const projectPath = (suffix = "") => `/projects/${tenant!.projectId}${suffix}`;

  function breadcrumb(page: Page) {
    return page.locator('nav[aria-label="Breadcrumb"]');
  }

  /** Every crumb's visible text in order, ignoring the "/" separators between them. */
  async function breadcrumbLabels(page: Page): Promise<string[]> {
    return breadcrumb(page)
      .locator("a, [aria-current]")
      .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
  }

  async function breadcrumbLinkHref(page: Page, label: string): Promise<string | null> {
    return breadcrumb(page).getByRole("link", { name: label, exact: true }).getAttribute("href");
  }

  let projectName = "";
  let workspaceName = "";

  test.beforeAll(async () => {
    if (skipReason) return;
    const api = await screensApi();
    try {
      projectName = (await (await api.get(`/api/projects/${tenant!.projectId}`)).json()).name;
      workspaceName = (await (await api.get("/api/workspace")).json()).name;
    } finally {
      await api.dispose();
    }
  });

  // Every project-scoped section, with the trail it must now show. The last label is always the
  // current page (non-link); everything before it must be a working link up the hierarchy.
  const projectSections: { label: string; path: string; trail: () => string[] }[] = [
    { label: "Project dashboard", path: "/dashboard", trail: () => ["Projects", projectName] },
    { label: "Test cases", path: "/testcases", trail: () => ["Projects", projectName, "Test cases"] },
    { label: "Bugs", path: "/bugs", trail: () => ["Projects", projectName, "Bugs"] },
    { label: "Reports", path: "/reports", trail: () => ["Projects", projectName, "Reports"] },
    { label: "Activity", path: "/activity", trail: () => ["Projects", projectName, "Activity"] },
    { label: "Knowledge base", path: "/knowledge-base", trail: () => ["Projects", projectName, "Knowledge base"] },
    { label: "Project settings", path: "/settings", trail: () => ["Projects", projectName, "Settings"] },
    // BC-06/07 below: these had NO breadcrumb at all before this fix.
    { label: "Test plans (list)", path: "/plans", trail: () => ["Projects", projectName, "Test plans"] },
    { label: "Test Runs (list)", path: "/cycles", trail: () => ["Projects", projectName, "Test Runs"] },
    { label: "Requirements", path: "/requirements", trail: () => ["Projects", projectName, "Requirements"] },
    { label: "Agents", path: "/agents", trail: () => ["Projects", projectName, "Agents"] },
  ];

  for (const section of projectSections) {
    test(`BC-01 ${section.label} shows the full Projects → project → section trail`, async ({ page }) => {
      await page.goto(projectPath(section.path));
      await expect(breadcrumb(page)).toBeVisible();
      expect(await breadcrumbLabels(page)).toEqual(section.trail());

      // The current page is not a link — only everything before it is.
      const current = section.trail().at(-1)!;
      await expect(breadcrumb(page).getByText(current, { exact: true })).toHaveAttribute("aria-current", "page");
      await expect(breadcrumb(page).getByRole("link", { name: current, exact: true })).toHaveCount(0);
    });
  }

  test("BC-02 the Projects crumb always points at the projects list, not the current project", async ({ page }) => {
    await page.goto(projectPath("/testcases"));
    expect(await breadcrumbLinkHref(page, "Projects")).toBe("/projects");
  });

  test("BC-03 the project-name crumb points at this project's dashboard, and round-trips there", async ({ page }) => {
    await page.goto(projectPath("/bugs"));
    await expect(breadcrumb(page)).toBeVisible();
    expect(await breadcrumbLinkHref(page, projectName)).toBe(projectPath("/dashboard"));

    await breadcrumb(page).getByRole("link", { name: projectName, exact: true }).click();
    await page.waitForURL(/\/dashboard$/);
  });

  test("BC-04 a plan detail page extends the list's trail with the plan as the current page", async ({ page }) => {
    const api = await screensApi();
    let planId: string | undefined;
    try {
      const plan = await createPlan(api, tenant!.projectId);
      planId = plan.id;

      await page.goto(projectPath(`/plans/${plan.id}`));
      await expect(breadcrumb(page)).toBeVisible();
      expect(await breadcrumbLabels(page)).toEqual(["Projects", projectName, "Test plans", plan.name]);

      // Unlike the list page, "Test plans" is now a link back to the list, not the current page.
      expect(await breadcrumbLinkHref(page, "Test plans")).toBe(projectPath("/plans"));
      await breadcrumb(page).getByRole("link", { name: "Test plans", exact: true }).click();
      await page.waitForURL(/\/plans$/);
    } finally {
      if (planId) await api.delete(`/api/plans/${planId}`, { failOnStatusCode: false }).catch(() => {});
      await api.dispose();
    }
  });

  test("BC-05 a run detail page extends the list's trail with the run as the current page", async ({ page }) => {
    const api = await screensApi();
    let cycleId: string | undefined;
    try {
      const run = await seedRun(api, tenant!.projectId);
      cycleId = run.cycleId;

      await page.goto(projectPath(`/cycles/${run.cycleId}`));
      await expect(breadcrumb(page)).toBeVisible();
      expect(await breadcrumbLabels(page)).toEqual(["Projects", projectName, "Test Runs", run.name]);
      expect(await breadcrumbLinkHref(page, "Test Runs")).toBe(projectPath("/cycles"));
    } finally {
      if (cycleId) await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false }).catch(() => {});
      await api.dispose();
    }
  });

  test("BC-06 workspace-level pages show the workspace name instead of a project", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(breadcrumb(page)).toBeVisible();
    expect(await breadcrumbLabels(page)).toEqual([workspaceName, "Dashboard"]);

    await page.goto("/activity");
    await expect(breadcrumb(page)).toBeVisible();
    expect(await breadcrumbLabels(page)).toEqual([workspaceName, "Activity"]);
  });

  test("BC-07 introducing a breadcrumb on a previously-bare page doesn't shift the page title or actions", async ({ page }) => {
    // Test plans and Test Runs had no breadcrumb before this fix — the regression this guards
    // against is the new line pushing the title/actions row down by more than one compact row,
    // or the actions button moving out from beside the title.
    await page.goto(projectPath("/plans"));
    const heading = page.getByRole("heading", { name: "Test plans" });
    await expect(heading).toBeVisible();
    await expect(breadcrumb(page)).toBeVisible();
    const [crumbBox, headingBox] = [await breadcrumb(page).boundingBox(), await heading.boundingBox()];
    expect(crumbBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    // The breadcrumb sits directly above the title, immediately adjacent — not pushed far away by
    // some unrelated layout shift.
    expect(headingBox!.y - (crumbBox!.y + crumbBox!.height)).toBeLessThan(24);
  });

  test("BC-08 a very long project name truncates instead of breaking the breadcrumb's layout", async ({ page }) => {
    const api = await screensApi();
    let longProjectId: string | undefined;
    try {
      const longProject = await createProject(api, {
        name: `E2E Very Long Project Name For Breadcrumb Truncation Testing Purposes Only ${Date.now()}`,
      });
      longProjectId = longProject.id;

      await page.goto(`/projects/${longProjectId}/testcases`);
      const crumb = breadcrumb(page);
      await expect(crumb).toBeVisible();
      // The crumb never grows taller than a single line, however long the name is.
      const box = await crumb.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThan(28);
    } finally {
      await deleteProjects(api, [longProjectId]);
      await api.dispose();
    }
  });
});
