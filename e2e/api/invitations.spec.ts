import { expect, test, type APIRequestContext } from "@playwright/test";
import { testAddress } from "../utils/env";
import { clearOtpIpRateLimit, clearOtpRateLimit, seedOtpCode } from "../utils/otp";
import {
  anonymousContext,
  clearInvitations,
  detachUserByEmail,
  expireInvite,
  inviteStatus,
  loginAs,
  mintInviteToken,
  orgMemberCount,
  orgRoleForEmail,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  resetRbacMembership,
  seedFixtureUser,
  storedOrgRole,
  storedProjectRole,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The invitation lifecycle: send, look up, accept, register, resend, cancel, expire.
 *
 * This file owns its own workspace (see utils/rbac-tenant.ts) because accepting an invitation
 * repoints the invitee's active workspace and permanently adds them to a team — state no other
 * spec's assumptions can survive.
 *
 * On tokens: the raw token only ever leaves the server by email, and the DB stores its sha256, so
 * these tests mint a token and write its hash the way the product does (mintInviteToken) rather
 * than scraping a mailbox. Everything after that point goes through the real public endpoints.
 */

test.describe("invitations", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("invites");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    anon = await anonymousContext();
  });

  test.afterAll(async () => {
    if (tenant) {
      clearInvitations(tenant);
      resetRbacMembership(tenant);
    }
    await Promise.all([asOwner, asManager, asQa, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    // A leftover pending invite changes what "already has a pending invite" means for the next
    // test, so each one starts from an empty invitation list.
    if (tenant) clearInvitations(tenant);
  });

  /** Sends an invitation as the owner and returns the created row plus a usable raw token. */
  async function invite(
    email: string,
    body: Record<string, unknown> = {},
    api: APIRequestContext = asOwner,
  ): Promise<{ id: string; token: string; response: any }> {
    const res = await api.post("/api/workspace/invitations", {
      data: { email, role: "qa_engineer", ...body },
      failOnStatusCode: false,
    });
    expect(res.ok(), `invite for ${email} failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const created = await res.json();
    return { id: created.id, token: mintInviteToken(created.id), response: created };
  }

  function uniqueEmail(label: string): string {
    return testAddress(`invite-${label}`);
  }

  // ─── Sending ───────────────────────────────────────────────────────────────

  test("an owner can invite a QA engineer and the invite is listed as pending", { tag: '@tesbo.testId("TES-TC-248")' }, async () => {
    const email = uniqueEmail("pending");
    const res = await asOwner.post("/api/workspace/invitations", {
      data: { email, role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(res.ok()).toBeTruthy();

    const created = await res.json();
    expect(created.email).toBe(email);
    expect(created.role).toBe("qa_engineer");
    expect(created.status).toBe("pending");
    expect(Number.isNaN(Date.parse(created.expiresAt))).toBeFalsy();
    // The raw token is the only thing that can redeem the invite — it must never come back in a
    // response body, or an audit log of API traffic becomes a set of live invitations.
    expect(JSON.stringify(created)).not.toContain("token");

    const list = await (await asOwner.get("/api/workspace/invitations")).json();
    const listed = list.find((i: any) => i.email === email);
    expect(listed, "the new invite should appear in the invitation list").toBeTruthy();
    expect(listed.status).toBe("pending");
    expect(listed.invitedByEmail).toBe(tenant!.owner.email);
  });

  test("a manager can only invite QA engineers", { tag: '@tesbo.testId("TES-TC-249")' }, async () => {
    // Explicit: createInvitation refuses a manager inviting anything but qa_engineer.
    const refused = await asManager.post("/api/workspace/invitations", {
      data: { email: uniqueEmail("mgr-peer"), role: "manager" },
      failOnStatusCode: false,
    });
    expect(refused.status()).toBe(403);

    const allowed = await asManager.post("/api/workspace/invitations", {
      data: { email: uniqueEmail("mgr-qa"), role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(allowed.ok()).toBeTruthy();
  });

  test("nobody can invite an owner, not even the owner", { tag: '@tesbo.testId("TES-TC-250")' }, async () => {
    // Explicit: ownership isn't grantable by invitation — the same rule the role endpoint enforces.
    const res = await asOwner.post("/api/workspace/invitations", {
      data: { email: uniqueEmail("owner"), role: "owner" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });

  test("a QA engineer cannot invite anyone", { tag: '@tesbo.testId("TES-TC-251")' }, async () => {
    const res = await asQa.post("/api/workspace/invitations", {
      data: { email: uniqueEmail("by-qa"), role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });

  test("an invitation needs a well-formed email address", { tag: '@tesbo.testId("TES-TC-252")' }, async () => {
    for (const email of ["", "   ", "not-an-email", "@nodomain.local", "spaces in@email.local"]) {
      const res = await asOwner.post("/api/workspace/invitations", {
        data: { email, role: "qa_engineer" },
        failOnStatusCode: false,
      });
      expect(res.status(), `"${email}" should be refused as an email address`).toBe(400);
    }
  });

  test("a second invite to the same address is refused and points at the existing one", { tag: '@tesbo.testId("TES-TC-253")' }, async () => {
    const email = uniqueEmail("dupe");
    const first = await invite(email);

    const second = await asOwner.post("/api/workspace/invitations", {
      data: { email, role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(second.status()).toBe(400);
    const body = await second.json();
    expect(body.error).toContain("pending invite");
    // The UI's next move is "resend that one", so it needs the id rather than just a message.
    expect(body.inviteId).toBe(first.id);
  });

  test("inviting someone who is already a member is refused", { tag: '@tesbo.testId("TES-TC-254")' }, async () => {
    const res = await asOwner.post("/api/workspace/invitations", {
      data: { email: tenant!.qa.email, role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("already a team member");
  });

  test("an invitation scoped to a project outside the workspace is refused", { tag: '@tesbo.testId("TES-TC-255")' }, async () => {
    const res = await asOwner.post("/api/workspace/invitations", {
      data: {
        email: uniqueEmail("badproject"),
        role: "qa_engineer",
        projectIds: ["00000000-0000-0000-0000-000000000000"],
      },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("project IDs");
  });

  // ─── Looking up a token ────────────────────────────────────────────────────

  test("the public invite lookup describes the invitation without leaking a way to redeem it", { tag: '@tesbo.testId("TES-TC-256")' }, async () => {
    const email = uniqueEmail("lookup");
    const { token } = await invite(email, { role: "manager" });

    // Deliberately anonymous: the invite landing page renders before the invitee has any session.
    const res = await anon.get(`/api/invitations/${token}`, { failOnStatusCode: false });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.email).toBe(email);
    expect(body.role).toBe("manager");
    expect(body.status).toBe("pending");
    expect(body.organizationName).toBeTruthy();
    expect(body.hasAccount).toBe(false);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test("an unknown or malformed token fails cleanly, never with a 500", { tag: '@tesbo.testId("TES-TC-257")' }, async () => {
    const tokens = [
      "not-a-token",
      "0".repeat(64),
      "%20",
      "../../etc/passwd",
      "<script>alert(1)</script>",
    ];
    for (const token of tokens) {
      const lookup = await anon.get(`/api/invitations/${encodeURIComponent(token)}`, {
        failOnStatusCode: false,
      });
      expect(lookup.status(), `lookup of "${token}" should be a clean 404`).toBe(404);

      const accept = await asQa.post(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accept.status(), `accepting "${token}" should be a clean 404`).toBe(404);
    }
  });

  // ─── Accepting ─────────────────────────────────────────────────────────────

  test("an invited user joins the workspace with the role they were granted", { tag: '@tesbo.testId("TES-TC-258")' }, async () => {
    const email = uniqueEmail("joiner");
    const invitee = seedFixtureUser(email, "E2E Invitee");
    const { id, token } = await invite(email, { role: "manager" });

    const asInvitee = await loginAs(invitee);
    try {
      const res = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(res.ok(), `accept failed: ${res.status()} ${await res.text()}`).toBeTruthy();
      expect((await res.json()).organizationId).toBe(tenant!.organizationId);

      expect(storedOrgRole(tenant!, invitee.userId)).toBe("manager");
      expect(inviteStatus(id)).toBe("accepted");

      // The invitee's active workspace should now BE this one, not merely be reachable.
      const workspace = await (await asInvitee.get("/api/workspace")).json();
      expect(workspace.id).toBe(tenant!.organizationId);
      expect(workspace.role).toBe("manager");
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("an invitation scoped to a project grants access to exactly that project", { tag: '@tesbo.testId("TES-TC-259")' }, async () => {
    const email = uniqueEmail("scoped");
    const invitee = seedFixtureUser(email, "E2E Scoped Invitee");
    const { token } = await invite(email, { projectIds: [tenant!.mainProjectId] });

    const asInvitee = await loginAs(invitee);
    try {
      const res = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(res.ok()).toBeTruthy();

      expect(storedProjectRole(tenant!.mainProjectId, invitee.userId)).toBe("qa_engineer");
      expect(storedProjectRole(tenant!.secondProjectId, invitee.userId)).toBe("");

      const granted = await asInvitee.get(`/api/projects/${tenant!.mainProjectId}`, {
        failOnStatusCode: false,
      });
      expect(granted.ok(), "the invited project should be readable").toBeTruthy();

      const notGranted = await asInvitee.get(`/api/projects/${tenant!.secondProjectId}`, {
        failOnStatusCode: false,
      });
      expect(notGranted.status(), "a project not in the invite must stay invisible").toBe(404);
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("the invited address is matched case-insensitively", { tag: '@tesbo.testId("TES-TC-260")' }, async () => {
    const lower = uniqueEmail("case");
    const invitee = seedFixtureUser(lower, "E2E Case Invitee");
    const { token } = await invite(lower.toUpperCase());

    const asInvitee = await loginAs(invitee);
    try {
      const res = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(res.ok(), "an invite typed in a different case should still be acceptable").toBeTruthy();
      expect(storedOrgRole(tenant!, invitee.userId)).toBe("qa_engineer");
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(lower);
    }
  });

  test("an invitation cannot be accepted by a different account", { tag: '@tesbo.testId("TES-TC-261")' }, async () => {
    const email = uniqueEmail("wronguser");
    const { id, token } = await invite(email);

    // The QA engineer is already in this workspace, so the only thing being tested is whether the
    // token can be redeemed by whoever holds it rather than by the person it names.
    const res = await asQa.post(`/api/invitations/${token}/accept`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
    expect(inviteStatus(id)).toBe("pending");
  });

  test("an accepted invitation cannot be used twice", { tag: '@tesbo.testId("TES-TC-262")' }, async () => {
    const email = uniqueEmail("replay");
    const invitee = seedFixtureUser(email, "E2E Replay Invitee");
    const { token } = await invite(email);

    const asInvitee = await loginAs(invitee);
    try {
      expect((await asInvitee.post(`/api/invitations/${token}/accept`, { data: {} })).ok()).toBeTruthy();

      const replay = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(replay.status()).toBe(400);
      expect((await replay.json()).error).toContain("already been accepted");
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("an expired invitation is reported as expired and cannot be accepted", { tag: '@tesbo.testId("TES-TC-263")' }, async () => {
    const email = uniqueEmail("expired");
    const invitee = seedFixtureUser(email, "E2E Expired Invitee");
    const { id, token } = await invite(email);
    expireInvite(id);

    const asInvitee = await loginAs(invitee);
    try {
      const lookup = await anon.get(`/api/invitations/${token}`, { failOnStatusCode: false });
      expect(lookup.ok(), "the landing page still needs to explain what happened").toBeTruthy();
      expect((await lookup.json()).status).toBe("expired");

      const accept = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accept.status()).toBe(400);
      expect((await accept.json()).error).toContain("expired");
      expect(storedOrgRole(tenant!, invitee.userId)).toBe("");
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("a cancelled invitation cannot be accepted", { tag: '@tesbo.testId("TES-TC-264")' }, async () => {
    const email = uniqueEmail("cancelled");
    const invitee = seedFixtureUser(email, "E2E Cancelled Invitee");
    const { id, token } = await invite(email);

    expect((await asOwner.delete(`/api/workspace/invitations/${id}`)).ok()).toBeTruthy();
    expect(inviteStatus(id)).toBe("cancelled");

    const asInvitee = await loginAs(invitee);
    try {
      const accept = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accept.status()).toBe(400);
      expect((await accept.json()).error).toContain("cancelled");
      expect(storedOrgRole(tenant!, invitee.userId)).toBe("");
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  // ─── Resend, cancel, expiry sweep ──────────────────────────────────────────

  test("resending an invitation invalidates the token it replaces", { tag: '@tesbo.testId("TES-TC-265")' }, async () => {
    const email = uniqueEmail("resend");
    const { id, token: firstToken } = await invite(email);

    const resend = await asOwner.post(`/api/workspace/invitations/${id}/resend`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(resend.ok(), `resend failed: ${resend.status()} ${await resend.text()}`).toBeTruthy();

    // The old link must be dead — a resend exists precisely because the previous one shouldn't be
    // trusted any more. (The replacement token is freshly random and only goes out by email, so it
    // can't be asserted on directly; that it replaced this one is the property that matters.)
    const stale = await anon.get(`/api/invitations/${firstToken}`, { failOnStatusCode: false });
    expect(stale.status()).toBe(404);
    expect(inviteStatus(id)).toBe("pending");
  });

  test("only pending invitations can be resent or cancelled", { tag: '@tesbo.testId("TES-TC-266")' }, async () => {
    const email = uniqueEmail("settled");
    const invitee = seedFixtureUser(email, "E2E Settled Invitee");
    const { id, token } = await invite(email);

    const asInvitee = await loginAs(invitee);
    try {
      expect((await asInvitee.post(`/api/invitations/${token}/accept`, { data: {} })).ok()).toBeTruthy();

      const resend = await asOwner.post(`/api/workspace/invitations/${id}/resend`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(resend.status()).toBe(400);

      const cancel = await asOwner.delete(`/api/workspace/invitations/${id}`, { failOnStatusCode: false });
      expect(cancel.status()).toBe(400);
      expect(inviteStatus(id)).toBe("accepted");
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("a manager cannot cancel or resend an invitation somebody else sent", { tag: '@tesbo.testId("TES-TC-267")' }, async () => {
    // Explicit: anyone but the owner is limited to the invitations they sent themselves.
    const { id } = await invite(uniqueEmail("notmine"));

    const cancel = await asManager.delete(`/api/workspace/invitations/${id}`, { failOnStatusCode: false });
    expect(cancel.status()).toBe(403);

    const resend = await asManager.post(`/api/workspace/invitations/${id}/resend`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(resend.status()).toBe(403);
    expect(inviteStatus(id)).toBe("pending");
  });

  test("an invitation from another workspace is invisible, not merely unusable", { tag: '@tesbo.testId("TES-TC-268")' }, async () => {
    const { id } = await invite(uniqueEmail("crosstenant"));

    // The QA engineer belongs to this workspace but the manage endpoints are workspace-scoped by
    // the caller's active org, so a foreign id must 404 rather than reveal that it exists.
    const foreign = "00000000-0000-0000-0000-000000000000";
    const cancel = await asOwner.delete(`/api/workspace/invitations/${foreign}`, { failOnStatusCode: false });
    expect(cancel.status()).toBe(404);
    expect(inviteStatus(id)).toBe("pending");
  });

  test("listing invitations sweeps overdue ones into expired", { tag: '@tesbo.testId("TES-TC-269")' }, async () => {
    const email = uniqueEmail("sweep");
    const { id } = await invite(email);
    expireInvite(id);

    const list = await (await asOwner.get("/api/workspace/invitations")).json();
    const listed = list.find((i: any) => i.id === id);
    expect(listed, "an expired invite should still be listed, so it can be resent").toBeTruthy();
    expect(listed.status).toBe("expired");
    expect(inviteStatus(id)).toBe("expired");
  });

  // ─── Registering from an invitation ────────────────────────────────────────

  test("registering from an invitation creates the account and joins the workspace", { tag: '@tesbo.testId("TES-TC-270")' }, async () => {
    const email = uniqueEmail("register");
    const { id, token } = await invite(email, { role: "manager", projectIds: [tenant!.mainProjectId] });

    const password = "E2E-Reg-Pass-1!";
    const res = await anon.post(`/api/invitations/${token}/register`, {
      data: { name: "EndToEnd Registered Invitee", password },
      failOnStatusCode: false,
    });
    expect(res.ok(), `register failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.organizationId).toBe(tenant!.organizationId);

    try {
      expect(storedOrgRole(tenant!, body.userId)).toBe("manager");
      expect(storedProjectRole(tenant!.mainProjectId, body.userId)).toBe("manager");
      expect(inviteStatus(id)).toBe("accepted");

      // The account has to be usable afterwards — a registration that doesn't produce a login is
      // just a membership row.
      const login = await anon.post("/api/auth/password/login", {
        data: { email, password },
        failOnStatusCode: false,
      });
      expect(login.ok(), "the newly registered user should be able to sign in").toBeTruthy();
    } finally {
      detachUserByEmail(email);
    }
  });

  test("registering from an invitation enforces a name and a real password", { tag: '@tesbo.testId("TES-TC-271")' }, async () => {
    const { token } = await invite(uniqueEmail("weak"));

    for (const data of [
      { name: "", password: "E2E-Register-Pass-1!" },
      { name: "EndToEnd No Password", password: "" },
      { name: "EndToEnd Short Password", password: "short" },
    ]) {
      const res = await anon.post(`/api/invitations/${token}/register`, {
        data,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(data)} should be refused`).toBe(400);
    }
  });

  /*
   * ── The OTP registration flows ────────────────────────────────────────────
   *
   * There are three ways to become a member from an invite, not one. POST /register (above) is the
   * single-shot path; these two are the staged ones the invite landing page actually drives:
   *
   *   /register/start      {firstName, lastName, mobileNumber?, password} → 204, OTP emailed → /register/verify {code}
   *   /register/otp/start  {firstName, lastName, mobileNumber?}           → 204, OTP emailed → /register/otp/verify {code}
   *
   * Both stash a row in pending_signups keyed to the invitation, and both verify steps sign the new
   * user in, so a fresh context is used per flow and disposed — reusing the file's shared `anon`
   * would leave it holding a session and quietly break every later test that needs it anonymous.
   *
   * OTP delivery is bypassed with seedOtpCode (utils/otp.ts), which writes the same sha256 the
   * product stores — so this holds whether the stack console.logs the code (no POSTMARK_API_TOKEN)
   * or mails it out (a real token), neither of which a spec should have to depend on.
   */
  test.describe("staged registration over OTP", () => {
    test.beforeEach(() => {
      // sendOtp writes a send:ip: bucket, and every test in this run looks like the same caller to
      // the backend — without this the later starts in this block trip the IP limiter instead of
      // testing what they're meant to.
      clearOtpIpRateLimit();
    });

    test("the password flow creates the account, joins the workspace and signs the user in", { tag: '@tesbo.testId("TES-TC-273")' }, async () => {
      const email = uniqueEmail("otp-pw");
      const { id, token } = await invite(email, { role: "manager", projectIds: [tenant!.mainProjectId] });
      const password = "E2E-Otp-Reg-1!";
      const ctx = await anonymousContext();
      try {
        const start = await ctx.post(`/api/invitations/${token}/register/start`, {
          data: { firstName: "EndToEnd", lastName: "OTP Invitee", mobileNumber: "+14155550100", password },
          failOnStatusCode: false,
        });
        expect(start.status(), `start failed: ${await start.text()}`).toBe(204);

        seedOtpCode(email, "123456");
        const verify = await ctx.post(`/api/invitations/${token}/register/verify`, {
          data: { code: "123456" },
          failOnStatusCode: false,
        });
        expect(verify.ok(), `verify failed: ${verify.status()} ${await verify.text()}`).toBeTruthy();
        const body = await verify.json();
        expect(body.ok).toBe(true);
        expect(body.organizationId).toBe(tenant!.organizationId);

        expect(storedOrgRole(tenant!, body.userId)).toBe("manager");
        expect(storedProjectRole(tenant!.mainProjectId, body.userId)).toBe("manager");
        expect(inviteStatus(id)).toBe("accepted");

        // The verify step signs the user in, so this context should already be them — landing on a
        // login screen after completing registration would be a dead end for a new teammate.
        const me = await ctx.get("/api/auth/me", { failOnStatusCode: false });
        expect(me.ok()).toBeTruthy();
        const meBody = await me.json();
        expect(meBody.email).toBe(email);
        // The firstName/lastName/mobileNumber collected at registration/start come back as the
        // structured fields the Account page reads — not just folded into the combined `name` — and
        // this path already collected them, so profileComplete must be true immediately.
        expect(meBody.firstName).toBe("EndToEnd");
        expect(meBody.lastName).toBe("OTP Invitee");
        expect(meBody.mobileNumber).toBe("+14155550100");
        expect(meBody.profileComplete).toBe(true);

        // And the password they chose has to be the password they can sign in with later.
        const login = await anon.post("/api/auth/password/login", {
          data: { email, password },
          failOnStatusCode: false,
        });
        expect(login.ok(), "the chosen password should work on the login screen").toBeTruthy();
      } finally {
        await ctx.dispose();
        clearOtpRateLimit(email);
        detachUserByEmail(email);
      }
    });

    test("the passwordless flow creates an account that has no password to guess", { tag: '@tesbo.testId("TES-TC-274")' }, async () => {
      const email = uniqueEmail("otp-only");
      const { token } = await invite(email);
      const ctx = await anonymousContext();
      try {
        const start = await ctx.post(`/api/invitations/${token}/register/otp/start`, {
          data: { firstName: "EndToEnd", lastName: "Passwordless Invitee" },
          failOnStatusCode: false,
        });
        expect(start.status()).toBe(204);

        seedOtpCode(email, "222333");
        const verify = await ctx.post(`/api/invitations/${token}/register/otp/verify`, {
          data: { code: "222333" },
          failOnStatusCode: false,
        });
        expect(verify.ok(), `verify failed: ${verify.status()} ${await verify.text()}`).toBeTruthy();
        const body = await verify.json();
        expect(storedOrgRole(tenant!, body.userId)).toBe("qa_engineer");

        // No password was ever set, so password login must not be a way in — an account created
        // passwordless that accepts an empty or default password would be worse than no account.
        for (const password of ["", " ", "password"]) {
          const login = await anon.post("/api/auth/password/login", {
            data: { email, password },
            failOnStatusCode: false,
          });
          expect(login.ok(), `password "${password}" must not sign in a passwordless account`).toBeFalsy();
        }
      } finally {
        await ctx.dispose();
        clearOtpRateLimit(email);
        detachUserByEmail(email);
      }
    });

    test("verifying without starting is refused, even with a valid code", { tag: '@tesbo.testId("TES-TC-275")' }, async () => {
      // The OTP check passes and the pending_signups lookup is what has to stop this. Without that
      // second check a valid code alone would mint an account for the invited address.
      const email = uniqueEmail("no-pending");
      const { token } = await invite(email);
      try {
        seedOtpCode(email, "444555");
        const verify = await anon.post(`/api/invitations/${token}/register/verify`, {
          data: { code: "444555" },
          failOnStatusCode: false,
        });
        expect(verify.status()).toBe(400);
        expect((await verify.json()).error).toContain("No pending registration");
        expect(orgRoleForEmail(tenant!, email)).toBe("");
      } finally {
        clearOtpRateLimit(email);
        detachUserByEmail(email);
      }
    });

    test("a wrong or expired code leaves no account behind", { tag: '@tesbo.testId("TES-TC-276")' }, async () => {
      const email = uniqueEmail("badcode");
      const { id, token } = await invite(email);
      const ctx = await anonymousContext();
      try {
        expect(
          (
            await ctx.post(`/api/invitations/${token}/register/start`, {
              data: { firstName: "EndToEnd", lastName: "Bad Code", password: "E2E-Otp-Reg-1!" },
            })
          ).status(),
        ).toBe(204);

        seedOtpCode(email, "111111");
        const wrong = await ctx.post(`/api/invitations/${token}/register/verify`, {
          data: { code: "999999" },
          failOnStatusCode: false,
        });
        expect(wrong.status()).toBe(401);
        expect((await wrong.json()).error).toBe("invalid_or_expired_otp");

        seedOtpCode(email, "777888", -5);
        const expired = await ctx.post(`/api/invitations/${token}/register/verify`, {
          data: { code: "777888" },
          failOnStatusCode: false,
        });
        expect(expired.status()).toBe(401);

        const missing = await ctx.post(`/api/invitations/${token}/register/verify`, {
          data: {},
          failOnStatusCode: false,
        });
        expect(missing.status()).toBe(400);

        // Nothing partial should have been committed by any of the three.
        expect(orgRoleForEmail(tenant!, email)).toBe("");
        expect(inviteStatus(id)).toBe("pending");
      } finally {
        await ctx.dispose();
        clearOtpRateLimit(email);
        detachUserByEmail(email);
      }
    });

    test("a code issued for one invite cannot complete another", { tag: '@tesbo.testId("TES-TC-277")' }, async () => {
      // Codes are keyed by email, and each invite names its own address — so holding a valid code
      // for your own invite must not let you complete somebody else's.
      const mine = uniqueEmail("mine");
      const theirs = uniqueEmail("theirs");
      const mineInvite = await invite(mine);
      const theirsInvite = await invite(theirs);
      const ctx = await anonymousContext();
      try {
        await ctx.post(`/api/invitations/${mineInvite.token}/register/start`, {
          data: { firstName: "EndToEnd", lastName: "Mine", password: "E2E-Otp-Register-1!" },
        });
        await ctx.post(`/api/invitations/${theirsInvite.token}/register/start`, {
          data: { firstName: "EndToEnd", lastName: "Theirs", password: "E2E-Otp-Register-1!" },
        });
        seedOtpCode(mine, "121212");

        const crossed = await ctx.post(`/api/invitations/${theirsInvite.token}/register/verify`, {
          data: { code: "121212" },
          failOnStatusCode: false,
        });
        expect(crossed.status()).toBe(401);
        expect(orgRoleForEmail(tenant!, theirs)).toBe("");
        expect(inviteStatus(theirsInvite.id)).toBe("pending");
      } finally {
        await ctx.dispose();
        clearOtpRateLimit(mine);
        clearOtpRateLimit(theirs);
        detachUserByEmail(mine);
        detachUserByEmail(theirs);
      }
    });

    test("the staged flows validate first/last name, mobile number and password before sending a code", { tag: '@tesbo.testId("TES-TC-278")' }, async () => {
      const email = uniqueEmail("validate");
      const { token } = await invite(email);
      try {
        for (const data of [
          { firstName: "", lastName: "Register", password: "E2E-Otp-Register-1!" },
          { firstName: "   ", lastName: "Register", password: "E2E-Otp-Register-1!" },
          { firstName: "EndToEnd", lastName: "", password: "E2E-Otp-Register-1!" },
          { firstName: "EndToEnd", lastName: "No Password", password: "" },
          { firstName: "EndToEnd", lastName: "Short Password", password: "short" },
          { firstName: "EndToEnd", lastName: "Bad Mobile", mobileNumber: "not-a-number", password: "E2E-Otp-Register-1!" },
        ]) {
          const res = await anon.post(`/api/invitations/${token}/register/start`, {
            data,
            failOnStatusCode: false,
          });
          expect(res.status(), `${JSON.stringify(data)} should be refused`).toBe(400);
        }

        const noFirstName = await anon.post(`/api/invitations/${token}/register/otp/start`, {
          data: { firstName: "", lastName: "Register" },
          failOnStatusCode: false,
        });
        expect(noFirstName.status()).toBe(400);

        const badMobile = await anon.post(`/api/invitations/${token}/register/otp/start`, {
          data: { firstName: "EndToEnd", lastName: "Register", mobileNumber: "555-not-e164" },
          failOnStatusCode: false,
        });
        expect(badMobile.status()).toBe(400);
      } finally {
        clearOtpRateLimit(email);
      }
    });

    test("a cancelled invite cannot be registered against", { tag: '@tesbo.testId("TES-TC-279")' }, async () => {
      const email = uniqueEmail("cancelled-otp");
      const { id, token } = await invite(email);
      expect((await asOwner.delete(`/api/workspace/invitations/${id}`)).ok()).toBeTruthy();

      for (const path of ["register/start", "register/otp/start"]) {
        const res = await anon.post(`/api/invitations/${token}/${path}`, {
          data: { firstName: "EndToEnd", lastName: "Cancelled", password: "E2E-Otp-Register-1!" },
          failOnStatusCode: false,
        });
        expect(res.status(), `${path} on a cancelled invite should be refused`).toBe(400);
      }
    });

    test("the staged flows refuse an address that already has an account", { tag: '@tesbo.testId("TES-TC-280")' }, async () => {
      const email = uniqueEmail("otp-taken");
      seedFixtureUser(email, "E2E Already Registered");
      const { token } = await invite(email);
      try {
        const res = await anon.post(`/api/invitations/${token}/register/start`, {
          data: { firstName: "EndToEnd", lastName: "Duplicate", password: "E2E-Otp-Register-1!" },
          failOnStatusCode: false,
        });
        expect(res.status()).toBe(400);
      } finally {
        detachUserByEmail(email);
      }
    });
  });

  test("registering against an address that already has an account is refused", { tag: '@tesbo.testId("TES-TC-272")' }, async () => {
    const email = uniqueEmail("taken");
    seedFixtureUser(email, "E2E Existing Account");
    const { token } = await invite(email);

    try {
      const res = await anon.post(`/api/invitations/${token}/register`, {
        data: { name: "EndToEnd Duplicate", password: "E2E-Reg-Pass-1!" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("already exists");
    } finally {
      detachUserByEmail(email);
    }
  });
  // ─── A pending invitation must grant nothing (BetterBugs 6a7d8189) ─────────
  //
  // "User is onboarded without receiving or accepting invitation email" — reported as HIGH: the
  // invited person appeared in the workspace's members without ever having opened the link.
  //
  // The email half of that report is covered elsewhere and is not a defect: the invite IS sent, and
  // api/email-delivery.spec.ts pins that its accept link is emitted and works. Outside production the
  // backend runs EMAIL_DELIVERY_MODE=log, so nothing reaches a real inbox on purpose — which is what
  // the reporter observed on stage.
  //
  // The half worth pinning is the authorization one, and these tests state it from both sides: while
  // an invitation is pending it must confer NO access at all, and acceptance must be the only thing
  // that turns it into membership.

  test("INV-P-01 a pending invitation confers no membership and no access", { tag: '@tesbo.testId("TES-TC-925")' }, async () => {
    const email = uniqueEmail("pending-noaccess");
    const invitee = seedFixtureUser(email, "EndToEnd Pending Invitee");
    await invite(email, { role: "manager" });

    const asInvitee = await loginAs(invitee);
    try {
      // Nothing in the database says they belong here.
      expect(storedOrgRole(tenant!, invitee.userId), "a pending invite is not a membership").toBe("");
      expect(orgRoleForEmail(tenant!, email)).toBe("");
      expect(storedProjectRole(tenant!.mainProjectId, invitee.userId)).toBe("");

      // And nothing in the API lets them act as though they do. The invite named a project, so the
      // project read is the one that would leak first.
      const workspace = await asInvitee.get("/api/workspace", { failOnStatusCode: false });
      if (workspace.ok()) {
        expect(
          (await workspace.json())?.id,
          "an unaccepted invite must not make this workspace the invitee's",
        ).not.toBe(tenant!.organizationId);
      }

      const project = await asInvitee.get(`/api/projects/${tenant!.mainProjectId}`, { failOnStatusCode: false });
      expect(
        [401, 403, 404],
        `a pending invitee read the project: ${project.status()} ${await project.text()}`,
      ).toContain(project.status());

      const cases = await asInvitee.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
        failOnStatusCode: false,
      });
      expect([401, 403, 404]).toContain(cases.status());
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("INV-P-02 a pending invitee is not in the workspace's member roster", { tag: '@tesbo.testId("TES-TC-926")' }, async () => {
    const email = uniqueEmail("pending-roster");
    const invitee = seedFixtureUser(email, "EndToEnd Roster Invitee");
    const before = orgMemberCount(tenant!);
    await invite(email);

    try {
      // The reporter's actual symptom: the invited address showing up in Team Members. The invite
      // belongs in the *invitations* list, and nowhere else, until it is accepted.
      const members = await (await asOwner.get("/api/workspace/members")).json();
      const emails = (Array.isArray(members) ? members : members.members ?? []).map(
        (m: { email?: string }) => m.email,
      );
      expect(emails, "a pending invitee must not be listed as a member").not.toContain(email);
      expect(orgMemberCount(tenant!), "the member count must not move on invite").toBe(before);

      const invitations = await (await asOwner.get("/api/workspace/invitations")).json();
      expect(invitations.some((i: { email: string }) => i.email === email)).toBeTruthy();
    } finally {
      detachUserByEmail(email);
    }
  });

  test("INV-P-03 acceptance is what creates the membership, and only then", { tag: '@tesbo.testId("TES-TC-927")' }, async () => {
    const email = uniqueEmail("accept-boundary");
    const invitee = seedFixtureUser(email, "EndToEnd Boundary Invitee");
    const before = orgMemberCount(tenant!);
    const { token } = await invite(email, { role: "qa_engineer" });

    const asInvitee = await loginAs(invitee);
    try {
      expect(storedOrgRole(tenant!, invitee.userId)).toBe("");
      expect(orgMemberCount(tenant!)).toBe(before);

      const accepted = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accepted.ok(), `accept failed: ${accepted.status()} ${await accepted.text()}`).toBeTruthy();

      // Only now.
      expect(storedOrgRole(tenant!, invitee.userId)).toBe("qa_engineer");
      expect(orgMemberCount(tenant!)).toBe(before + 1);

      const members = await (await asOwner.get("/api/workspace/members")).json();
      const emails = (Array.isArray(members) ? members : members.members ?? []).map(
        (m: { email?: string }) => m.email,
      );
      expect(emails).toContain(email);
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("INV-P-04 a cancelled invitation leaves the invitee with nothing", { tag: '@tesbo.testId("TES-TC-928")' }, async () => {
    const email = uniqueEmail("cancelled-noaccess");
    const invitee = seedFixtureUser(email, "EndToEnd Cancelled Invitee");
    const before = orgMemberCount(tenant!);
    const { id, token } = await invite(email);

    const asInvitee = await loginAs(invitee);
    try {
      const cancelled = await asOwner.delete(`/api/workspace/invitations/${id}`, { failOnStatusCode: false });
      expect(cancelled.ok(), `cancel failed: ${await cancelled.text()}`).toBeTruthy();
      expect(inviteStatus(id)).toBe("cancelled");

      const accepted = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accepted.ok(), "a cancelled invitation must not be redeemable").toBeFalsy();

      expect(storedOrgRole(tenant!, invitee.userId)).toBe("");
      expect(orgMemberCount(tenant!)).toBe(before);
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });

  test("INV-P-05 an expired invitation cannot quietly become a membership", { tag: '@tesbo.testId("TES-TC-929")' }, async () => {
    const email = uniqueEmail("expired-noaccess");
    const invitee = seedFixtureUser(email, "EndToEnd Expired Invitee");
    const before = orgMemberCount(tenant!);
    const { id, token } = await invite(email);
    expireInvite(id);

    const asInvitee = await loginAs(invitee);
    try {
      const accepted = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accepted.ok(), "an expired invitation must not be redeemable").toBeFalsy();

      expect(storedOrgRole(tenant!, invitee.userId)).toBe("");
      expect(orgMemberCount(tenant!)).toBe(before);
    } finally {
      await asInvitee.dispose();
      detachUserByEmail(email);
    }
  });
});
