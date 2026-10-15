import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { env, testAddress } from "../utils/env";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  removeOrgMember,
  resetRbacMembership,
  storedOrgRole,
  storedProjectRole,
  writeStorageState,
  type RbacTenant,
  type RbacUser,
} from "../utils/rbac-tenant";

/*
 * The team screens, driven as each role sees them.
 *
 * What makes these worth a browser: the API decides what's *allowed*, but the screen decides what's
 * *offered*. A manager who is shown a role dropdown they can't use, or a QA engineer shown an
 * "Invite member" button that 403s, is a bug the API suite can't see. So each test asserts on the
 * affordances a role is given as well as on the outcome of using them.
 *
 * Every route Wave 1 covers lands here, including the three that turned out to be redirect stubs
 * (/settings/members, /settings/project-access, /projects/:id/members) — a stub that stops
 * redirecting is a dead link, so the redirect itself is the behaviour worth pinning.
 *
 * Runs against its own disposable workspace ("members-ui"): these tests promote, demote and remove
 * real members, which no shared account can absorb.
 */

const WORKSPACE_MEMBERS_URL = "/settings?tab=members";

test.describe("team members", () => {
  let tenant: RbacTenant | null = null;
  const states = new Map<string, string>();
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("members-ui");
    if (!tenant) return;
    for (const [label, user] of [
      ["owner", tenant.owner],
      ["manager", tenant.manager],
      ["qa", tenant.qa],
    ] as [string, RbacUser][]) {
      states.set(label, await writeStorageState(user, `members-ui-${label}`));
    }
  });

  test.afterAll(async () => {
    if (tenant) resetRbacMembership(tenant);
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /**
   * A page signed in as one of the fixture roles.
   *
   * browser.newContext() doesn't inherit the project's `use` options, so baseURL is passed
   * explicitly — without it every relative goto() resolves against nothing.
   */
  async function pageAs(browser: import("@playwright/test").Browser, label: string): Promise<Page> {
    const context = await browser.newContext({
      baseURL: env.webBaseUrl,
      storageState: states.get(label)!,
    });
    contexts.push(context);
    return context.newPage();
  }

  /*
   * Neither table carries an accessible name, and both render plain <tbody><tr>, so they're told
   * apart by a column only one of them has. Row-scoped locators built off these stay correct if a
   * section is reordered.
   */
  function membersTable(page: Page): Locator {
    return page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Joined" }) });
  }

  function invitesTable(page: Page): Locator {
    return page.locator("table").filter({ has: page.getByRole("columnheader", { name: "Expires" }) });
  }

  function rowFor(table: Locator, text: string): Locator {
    return table.locator("tbody tr").filter({ hasText: text });
  }

  function uniqueEmail(label: string): string {
    return testAddress(`ui-invite-${label}`);
  }

  // ─── The roster ────────────────────────────────────────────────────────────

  test("the roster lists every member with the role they hold", { tag: '@tesbo.testId("TES-TC-670")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(WORKSPACE_MEMBERS_URL);

    await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
    const table = membersTable(page);

    // The owner's own row reads as a badge with "(you)", never as an editable dropdown — an owner
    // demoting themselves by accident is exactly what the API refuses.
    const ownRow = rowFor(table, tenant!.owner.email);
    await expect(ownRow).toContainText("(you)");
    await expect(ownRow).toContainText("Owner");
    await expect(ownRow.locator("select")).toHaveCount(0);
    await expect(ownRow.getByTitle("Remove from team")).toHaveCount(0);

    // Everyone else is editable, and the dropdown shows the role actually stored.
    await expect(rowFor(table, tenant!.manager.email).locator("select")).toHaveValue("manager");
    await expect(rowFor(table, tenant!.qa.email).locator("select")).toHaveValue("qa_engineer");
    await expect(rowFor(table, tenant!.guest.email)).toBeVisible();
  });

  test("the role guide explains what each role can do", { tag: '@tesbo.testId("TES-TC-671")' }, async ({ browser }) => {
    // The screen hands out permissions, so it has to say what it's handing out. This is the only
    // place in the product that documents the three roles.
    //
    // Asserted on the descriptions rather than the role names: "Manager" and "QA Engineer" also
    // appear as <option> text inside the roster's role dropdowns, which are present but not
    // visible, so a name-only locator matches a hidden element instead of the guide.
    const page = await pageAs(browser, "owner");
    await page.goto(WORKSPACE_MEMBERS_URL);

    await expect(page.getByText("Role guide")).toBeVisible();
    for (const description of [
      "Full workspace access. Manages team, roles, and all projects.",
      "Can create projects, invite QA Engineers, and manage assigned projects.",
      "Works inside assigned projects. Cannot invite or create projects.",
    ]) {
      await expect(page.getByText(description)).toBeVisible();
    }
  });

  // ─── Inviting ──────────────────────────────────────────────────────────────

  test("an owner can invite a teammate and the invite appears as pending", { tag: '@tesbo.testId("TES-TC-672")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    const email = uniqueEmail("owner");
    const api = await loginAs(tenant!.owner);
    try {
      await page.goto(WORKSPACE_MEMBERS_URL);
      await page.getByRole("button", { name: "Invite member" }).click();

      // The modal renders without role="dialog", so it's located by its heading.
      await expect(page.getByText("Invite team member")).toBeVisible();
      await page.locator("#invite-email").fill(email);
      await page.locator("#invite-role").selectOption("manager");
      await page.getByRole("button", { name: "Send invite" }).click();

      await expect(page.getByText("Invite sent successfully")).toBeVisible();
      const row = rowFor(invitesTable(page), email);
      await expect(row).toBeVisible();
      await expect(row).toContainText("Manager");
      await expect(row).toContainText("Pending");

      // The row is only the UI's opinion — confirm the invitation really exists server-side.
      const invites = await (await api.get("/api/workspace/invitations")).json();
      expect(invites.map((i: any) => i.email)).toContain(email);
    } finally {
      const invites = await (await api.get("/api/workspace/invitations")).json();
      const created = invites.find((i: any) => i.email === email);
      if (created) {
        await api.delete(`/api/workspace/invitations/${created.id}`, { failOnStatusCode: false });
      }
      await api.dispose();
    }
  });

  test("an invitation can be scoped to specific projects from the modal", { tag: '@tesbo.testId("TES-TC-673")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    const email = uniqueEmail("scoped");
    const api = await loginAs(tenant!.owner);
    try {
      await page.goto(WORKSPACE_MEMBERS_URL);
      await page.getByRole("button", { name: "Invite member" }).click();
      await page.locator("#invite-email").fill(email);

      await expect(page.getByText("Project access (optional)")).toBeVisible();
      await page.getByRole("checkbox").first().check();
      await expect(page.getByText("1 project selected")).toBeVisible();
      await page.getByRole("button", { name: "Send invite" }).click();

      await expect(page.getByText("Invite sent successfully")).toBeVisible();

      const invites = await (await api.get("/api/workspace/invitations")).json();
      const created = invites.find((i: any) => i.email === email);
      expect(created, "the scoped invite should exist").toBeTruthy();
      expect(created.projectIds.length, "the chosen project should be recorded on the invite").toBe(1);
      // The pending row names the project, so an owner can see what they granted.
      await expect(rowFor(invitesTable(page), email)).toContainText(created.projects[0].name);
    } finally {
      const invites = await (await api.get("/api/workspace/invitations")).json();
      const created = invites.find((i: any) => i.email === email);
      if (created) {
        await api.delete(`/api/workspace/invitations/${created.id}`, { failOnStatusCode: false });
      }
      await api.dispose();
    }
  });

  test("an invitation scoped to several projects folds the extras into a +N chip instead of wrapping the column", async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    const email = uniqueEmail("multi");
    const stamp = Date.now();
    const api = await loginAs(tenant!.owner);
    const projectIds: string[] = [];
    let inviteId = "";
    try {
      for (let i = 1; i <= 3; i++) {
        const res = await api.post("/api/projects", {
          data: { name: `E2E Multi Invite ${i} ${stamp}`, key: `MI${i}${String(stamp).slice(-4)}`, description: "", projectType: "tesbox" },
        });
        projectIds.push((await res.json()).id);
      }
      const created = await (
        await api.post("/api/workspace/invitations", { data: { email, role: "qa_engineer", projectIds } })
      ).json();
      inviteId = created.id;

      await page.goto(WORKSPACE_MEMBERS_URL);
      const cell = rowFor(invitesTable(page), email).getByTestId("invite-projects");
      // Two names as chips, the third folded; the full list stays reachable via the chip's title.
      await expect(cell).toContainText("E2E Multi Invite");
      await expect(cell.getByText("+1 more")).toBeVisible();
      await expect(cell.getByText(`E2E Multi Invite 3 ${stamp}`)).toHaveCount(0);
      // Names are shown in full, never cut with an ellipsis.
      const chip = cell.getByText(`E2E Multi Invite 1 ${stamp}`);
      expect(await chip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
      // The old comma list wrapped word-by-word into a column taller than 100px.
      const box = await rowFor(invitesTable(page), email).boundingBox();
      expect(box!.height).toBeLessThan(100);

      // Clicking the chip reveals the hidden project, and "Show less" folds it again.
      await cell.getByRole("button", { name: "+1 more" }).click();
      await expect(cell.getByText(`E2E Multi Invite 3 ${stamp}`)).toBeVisible();
      await cell.getByRole("button", { name: "Show less" }).click();
      await expect(cell.getByText(`E2E Multi Invite 3 ${stamp}`)).toHaveCount(0);
    } finally {
      if (inviteId) await api.delete(`/api/workspace/invitations/${inviteId}`, { failOnStatusCode: false });
      for (const id of projectIds) await api.delete(`/api/projects/${id}`, { failOnStatusCode: false });
      await api.dispose();
    }
  });

  test("a rejected invite is explained in the modal instead of vanishing", { tag: '@tesbo.testId("TES-TC-674")' }, async ({ browser }) => {
    // The failure path: inviting an existing member is refused by the API, and the modal has to
    // stay open and say why. A silent close would read as success.
    const page = await pageAs(browser, "owner");
    await page.goto(WORKSPACE_MEMBERS_URL);
    await page.getByRole("button", { name: "Invite member" }).click();
    await page.locator("#invite-email").fill(tenant!.qa.email);
    await page.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText("already a team member")).toBeVisible();
    await expect(page.getByText("Invite team member")).toBeVisible();
    await expect(page.getByText("Invite sent successfully")).toHaveCount(0);
  });

  test("an empty email is caught before a request is sent", { tag: '@tesbo.testId("TES-TC-675")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    await page.goto(WORKSPACE_MEMBERS_URL);
    await page.getByRole("button", { name: "Invite member" }).click();
    await page.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText("Email is required")).toBeVisible();
  });

  test("a manager is only offered the role a manager may grant", { tag: '@tesbo.testId("TES-TC-676")' }, async ({ browser }) => {
    // The API refuses a manager inviting anything but a QA engineer, so the dropdown must not
    // offer Manager at all — being shown a choice that always 403s is the bug.
    const page = await pageAs(browser, "manager");
    await page.goto(WORKSPACE_MEMBERS_URL);
    await page.getByRole("button", { name: "Invite member" }).click();

    const roleSelect = page.locator("#invite-role");
    await expect(roleSelect.locator("option")).toHaveCount(1);
    await expect(roleSelect).toHaveValue("qa_engineer");
    await expect(roleSelect).toBeDisabled();
  });

  test("a QA engineer is turned away from workspace settings entirely", { tag: '@tesbo.testId("TES-TC-677")' }, async ({ browser }) => {
    // Workspace settings is owner/manager only, and the page redirects rather than rendering a
    // read-only version — so the roster, the invite button and the pending invitations are all
    // simply out of reach. Landing somewhere useful matters as much as being refused: a bare
    // "access denied" screen with no way out would be worse than the redirect.
    const page = await pageAs(browser, "qa");
    await page.goto(WORKSPACE_MEMBERS_URL);

    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Team" })).toHaveCount(0);
  });

  test("a manager can see the roster but not change it", { tag: '@tesbo.testId("TES-TC-678")' }, async ({ browser }) => {
    const page = await pageAs(browser, "manager");
    await page.goto(WORKSPACE_MEMBERS_URL);

    // A manager may invite, so the button is theirs — but role changes and removals are owner-only.
    await expect(page.getByRole("button", { name: "Invite member" })).toBeVisible();
    await expect(membersTable(page).locator("select")).toHaveCount(0);
    await expect(page.getByTitle("Remove from team")).toHaveCount(0);
  });

  // ─── Managing pending invitations ──────────────────────────────────────────

  test("an owner can resend and then cancel a pending invitation", { tag: '@tesbo.testId("TES-TC-679")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    const email = uniqueEmail("manage");
    const api = await loginAs(tenant!.owner);
    try {
      const created = await (
        await api.post("/api/workspace/invitations", { data: { email, role: "qa_engineer" } })
      ).json();

      await page.goto(WORKSPACE_MEMBERS_URL);
      const row = rowFor(invitesTable(page), email);
      await expect(row).toBeVisible();

      await row.getByTitle("Resend invite").click();
      await expect(page.getByText("Invitation resent")).toBeVisible();

      await row.getByTitle("Cancel invite").click();
      await expect(page.getByText("Invitation cancelled")).toBeVisible();
      await expect(rowFor(invitesTable(page), email)).toHaveCount(0);

      // Cancelled means cancelled server-side, not just hidden from this table.
      const invites = await (await api.get("/api/workspace/invitations")).json();
      expect(invites.find((i: any) => i.id === created.id)).toBeUndefined();
    } finally {
      await api.dispose();
    }
  });

  // ─── Changing roles and removing people ────────────────────────────────────

  test("an owner can change a member's role from the roster", { tag: '@tesbo.testId("TES-TC-680")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    try {
      await page.goto(WORKSPACE_MEMBERS_URL);
      const row = rowFor(membersTable(page), tenant!.qa.email);
      await row.locator("select").selectOption("manager");

      await expect(page.getByText("Role updated")).toBeVisible();
      await expect(rowFor(membersTable(page), tenant!.qa.email).locator("select")).toHaveValue("manager");
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("manager");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("an owner can remove a member and the roster reflects it", { tag: '@tesbo.testId("TES-TC-681")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");
    try {
      await page.goto(WORKSPACE_MEMBERS_URL);
      await rowFor(membersTable(page), tenant!.guest.email).getByTitle("Remove from team").click();
      await page.getByRole("button", { name: "Remove member" }).click();

      // Exactly one success toast — getByText resolves to a single node under Playwright's
      // strict mode, so a duplicate toast would fail this assertion rather than pass silently.
      await expect(page.getByText("Team member removed")).toBeVisible();
      await expect(rowFor(membersTable(page), tenant!.guest.email)).toHaveCount(0);
      expect(storedOrgRole(tenant!, tenant!.guest.userId)).toBe("");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a role change on a stale roster reports the failure instead of a success", { tag: '@tesbo.testId("TES-TC-682")' }, async ({
    browser,
  }) => {
    // The failure path that a real team hits: two owners on the settings screen at once. One
    // removes a member, the other still has them on screen and edits their role. The second
    // request has to be refused visibly — a success toast for a member who no longer exists is
    // the worst outcome, because the roster then reloads without them and looks like it worked.
    const page = await pageAs(browser, "owner");
    try {
      await page.goto(WORKSPACE_MEMBERS_URL);
      const row = rowFor(membersTable(page), tenant!.qa.email);
      await expect(row.locator("select")).toBeVisible();

      // The other tab's removal, applied behind this page's back.
      removeOrgMember(tenant!, tenant!.qa.userId);

      await row.locator("select").selectOption("manager");

      await expect(page.getByText("Member not found")).toBeVisible();
      await expect(page.getByText("Role updated")).toHaveCount(0);
      expect(storedOrgRole(tenant!, tenant!.qa.userId)).toBe("");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  // ─── Project members ───────────────────────────────────────────────────────

  test("an owner can add a workspace member to a project and take the access away", { tag: '@tesbo.testId("TES-TC-683")' }, async ({
    browser,
  }) => {
    const page = await pageAs(browser, "owner");
    try {
      await page.goto(`/projects/${tenant!.mainProjectId}/settings?tab=members`);
      await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();

      // The guest is in the workspace but not in this project, so they're a candidate the
      // "Add workspace member" picker offers. Selected by value (the user id) rather than by
      // label, which the option renders as "name (email)".
      await page.getByRole("combobox").first().selectOption(tenant!.guest.userId);
      await page.getByRole("button", { name: "Add member" }).click();

      const projectTable = page
        .locator("table")
        .filter({ has: page.getByRole("columnheader", { name: "Email" }) });
      await expect(rowFor(projectTable, tenant!.guest.email)).toBeVisible();
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("qa_engineer");

      await rowFor(projectTable, tenant!.guest.email).getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: "Remove member" }).click();

      // Exactly one success toast — same guarantee as the workspace-level removal above.
      await expect(page.getByText("Member removed from project")).toBeVisible();
      await expect(rowFor(projectTable, tenant!.guest.email)).toHaveCount(0);
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a manager can staff a project and keeps the manager-only tabs", { tag: '@tesbo.testId("TES-TC-684")' }, async ({ browser }) => {
    // The other side of the QA-engineer case below. A manager may add people to a project (as QA
    // engineers only), and Custom Fields is visible to them — that tab is hidden rather than
    // disabled below manager, so its presence is part of what distinguishes the two roles.
    const page = await pageAs(browser, "manager");
    try {
      await page.goto(`/projects/${tenant!.mainProjectId}/settings?tab=members`);
      await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Custom Fields" })).toBeVisible();

      await page.getByRole("combobox").first().selectOption(tenant!.guest.userId);
      await page.getByRole("button", { name: "Add member" }).click();

      const projectTable = page
        .locator("table")
        .filter({ has: page.getByRole("columnheader", { name: "Email" }) });
      await expect(rowFor(projectTable, tenant!.guest.email)).toBeVisible();
      // A manager may only hand out the QA Engineer role, so that's what the new row must say.
      await expect(rowFor(projectTable, tenant!.guest.email)).toContainText("QA Engineer");
      expect(storedProjectRole(tenant!.mainProjectId, tenant!.guest.userId)).toBe("qa_engineer");
    } finally {
      resetRbacMembership(tenant!);
    }
  });

  test("a QA engineer sees the project roster read-only", { tag: '@tesbo.testId("TES-TC-685")' }, async ({ browser }) => {
    const page = await pageAs(browser, "qa");
    await page.goto(`/projects/${tenant!.mainProjectId}/settings?tab=members`);
    await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
    // Custom Fields is the one tab that disappears entirely below manager, rather than going
    // read-only — so its absence is part of what this role sees.
    await expect(page.getByRole("button", { name: "Custom Fields" })).toHaveCount(0);
  });

  test("the project role legend describes the roles the product actually has", { tag: '@tesbo.testId("TES-TC-1344")' }, async ({ browser }) => {
    // Regression for a legend that used to describe a nonexistent "Admin"/generic "Member" tier
    // (the roles were literally "Owner: ... Admin: ... Manager: ... Member: ...") while the role
    // dropdown and the backend have only ever recognised owner/manager/qa_engineer. Asserted on the
    // descriptions rather than the bare role names: "Manager" and "QA Engineer" also appear as
    // <option> text inside the roster's hidden-but-present role dropdowns.
    const page = await pageAs(browser, "owner");
    await page.goto(`/projects/${tenant!.mainProjectId}/settings?tab=members`);
    await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();

    await expect(page.getByText("Admin:")).toHaveCount(0);
    for (const description of [
      "Full access to this project, including managing every member.",
      "Can add or remove QA Engineers and manage project settings",
      "Works inside this project, but cannot manage members or change project settings.",
    ]) {
      await expect(page.getByText(description)).toBeVisible();
    }
  });

  // ─── Routes that only redirect ─────────────────────────────────────────────

  test("the standalone team routes land on the tab that replaced them", { tag: '@tesbo.testId("TES-TC-686")' }, async ({ browser }) => {
    const page = await pageAs(browser, "owner");

    for (const from of ["/settings/members", "/settings/project-access"]) {
      await page.goto(from);
      await expect(page).toHaveURL(/\/settings\?tab=members/);
      await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
    }

    await page.goto(`/projects/${tenant!.mainProjectId}/members`);
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant!.mainProjectId}/settings\\?tab=members`));
    await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();
  });
});
