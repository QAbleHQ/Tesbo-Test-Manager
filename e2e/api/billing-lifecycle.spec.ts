import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import {
  activeProjectIdsOldestFirst,
  billingModuleUnavailableReason,
  billingSuitePrerequisites,
  billingTenant,
  countBillingAuditEntries,
  isoDaysFromNow,
  readBillingState,
  resetToLaunch,
  setBillingState,
  setGraceWindow,
  setProPlan,
  webhookEventRecorded,
  type BillingState,
} from "../utils/billing-db";
import {
  checkoutSessionCompleted,
  invoicePaid,
  invoicePaymentFailed,
  postStripeWebhook,
  subscriptionEvent,
  unhandledEvent,
  uniqueStripeId,
  unixDaysFromNow,
} from "../utils/stripe-webhook";

/*
 * The payment lifecycle, end to end: what Stripe tells us, what we persist, and what the app then
 * lets a workspace do.
 *
 * This is the suite that has to be green before a billing deploy, because these are the paths that
 * cost money when they're wrong — a paying customer silently downgraded, a cancelled customer
 * keeping Pro forever, a dunning customer locked out while Stripe is still retrying, or a workspace
 * whose data becomes unreachable after a downgrade.
 *
 * Two techniques make it testable without money or waiting:
 *
 *   1. Webhooks are LOCALLY SIGNED (utils/stripe-webhook.ts). Signature verification is an HMAC, so
 *      synthetic events drive the real handlers with no Stripe API call and no Stripe object.
 *   2. States that are otherwise 30 days or one declined card away are written straight into the
 *      workspace's billing columns (utils/billing-db.ts), then exercised through the real endpoints
 *      and the real guards.
 *
 * Everything runs against a DISPOSABLE workspace provisioned by global-setup, never the shared
 * smoke workspace — see env.billingApiEmail. Each test arranges its own state from scratch so it
 * can't inherit the previous one's leftovers.
 */

const tenant = billingTenant("api");
const skipReason = billingSuitePrerequisites(tenant);

// A signing secret is the one thing the webhook half can't work around. The plan-limit half doesn't
// need it, so it's gated separately rather than skipping the whole file.
const webhookSkipReason = env.stripeWebhookSecret
  ? null
  : "needs the backend's STRIPE_WEBHOOK_SECRET to sign synthetic events (set E2E_STRIPE_WEBHOOK_SECRET for a remote target)";

test.describe("payment lifecycle", () => {
  test.skip(!!skipReason, skipReason ?? undefined);

  // Non-null once the skip above has been evaluated.
  const orgId = tenant?.organizationId ?? "";

  let asBilling: APIRequestContext;
  let anon: APIRequestContext;
  let snapshot: BillingState;
  let projectIds: string[] = [];
  let unavailableReason: string | null = null;
  const createdProjectIds: string[] = [];

  /**
   * Four active projects, so the read-only lock has something to lock.
   *
   * The Launch allowance is 2, ranked oldest-first: with four projects the newest two are locked
   * once enforcement bites, which leaves one to prove writes are refused and a second to prove
   * archiving — the documented way out — is still allowed. Created while the workspace is on Pro,
   * because creating them on Launch is exactly what the limit forbids.
   */
  async function ensureActiveProjects(target: number): Promise<string[]> {
    setProPlan(orgId);
    let ids = activeProjectIdsOldestFirst(orgId);
    while (ids.length < target) {
      const suffix = `${Date.now().toString(36)}${ids.length}`.slice(-9).toUpperCase();
      const res = await asBilling.post("/api/projects", {
        data: { name: `E2E Billing Project ${suffix}`, key: `BILL${suffix}` },
        failOnStatusCode: false,
      });
      if (!res.ok()) {
        throw new Error(`Could not arrange ${target} projects: ${res.status()} ${await res.text()}`);
      }
      createdProjectIds.push((await res.json()).id);
      ids = activeProjectIdsOldestFirst(orgId);
    }
    return ids;
  }

  test.beforeAll(async () => {
    asBilling = await request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: tenant!.storageStatePath,
    });
    // Stripe posts webhooks with no session cookie; deliver them the same way so the tests would
    // catch the route accidentally being put behind auth (Stripe could never reach it).
    anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });

    unavailableReason = await billingModuleUnavailableReason(anon);
    if (unavailableReason) return;

    snapshot = readBillingState(orgId);
    projectIds = await ensureActiveProjects(4);
  });

  test.beforeEach(() => {
    test.skip(!!unavailableReason, unavailableReason ?? undefined);
  });

  test.afterAll(async () => {
    if (!unavailableReason) {
      // Restore the plan BEFORE archiving, so a run that ended mid-enforcement doesn't leave this
      // tenant locked for the next one.
      setProPlan(orgId);
      for (const id of createdProjectIds) {
        await asBilling.delete(`/api/projects/${id}`, { failOnStatusCode: false });
      }
      setBillingState(orgId, snapshot);
    }
    await asBilling.dispose();
    await anon.dispose();
  });

  async function billingInfo(): Promise<Record<string, any>> {
    const res = await asBilling.get("/api/billing");
    expect(res.ok()).toBeTruthy();
    return res.json();
  }

  async function usage(): Promise<Record<string, any>> {
    const res = await asBilling.get("/api/billing/usage");
    expect(res.ok()).toBeTruthy();
    return res.json();
  }

  async function history(): Promise<{ action: string; summary: string; detail: Record<string, any> }[]> {
    const res = await asBilling.get("/api/billing/history?limit=200");
    expect(res.ok()).toBeTruthy();
    return res.json();
  }

  async function createProject(name: string) {
    const suffix = `${Date.now().toString(36)}`.slice(-9).toUpperCase();
    return asBilling.post("/api/projects", {
      data: { name: `${name} ${suffix}`, key: `BILX${suffix}` },
      failOnStatusCode: false,
    });
  }

  test.describe("webhook-driven subscription state", () => {
    test.skip(!!webhookSkipReason, webhookSkipReason ?? undefined);

    test("checkout.session.completed upgrades the workspace and records the upgrade", { tag: '@tesbo.testId("TES-TC-43")' }, async () => {
      resetToLaunch(orgId);
      const subscriptionId = uniqueStripeId("sub");

      const res = await postStripeWebhook(
        anon,
        checkoutSessionCompleted({ organizationId: orgId, subscriptionId, amountTotal: 36000, currency: "usd" }),
      );
      expect(res.ok()).toBeTruthy();
      expect(await res.json()).toMatchObject({ received: true });

      const info = await billingInfo();
      expect(info.plan).toBe("pro");
      expect(readBillingState(orgId).stripe_subscription_id).toBe(subscriptionId);

      // Recorded at the point of checkout, which is both the accurate moment and the one that can't
      // be missed — customer.subscription.created lands afterwards and by then there's no
      // transition left to notice.
      const upgraded = (await history()).find((e) => e.action === "billing_upgraded");
      expect(upgraded).toBeTruthy();
      expect(upgraded!.detail.via).toBe("checkout");
      expect(upgraded!.detail.amountTotal).toBe(36000);
    });

    test("customer.subscription.created activates a workspace that never saw a checkout event", { tag: '@tesbo.testId("TES-TC-44")' }, async () => {
      resetToLaunch(orgId);
      const subscriptionId = uniqueStripeId("sub");

      // The self-heal path: a subscription created straight in the Stripe Dashboard, or a checkout
      // whose session event was dropped. Without this a paying customer sits on the free plan.
      const res = await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.created", {
          organizationId: orgId,
          subscriptionId,
          status: "active",
          priceId: env.stripePriceIdProAnnual,
          currency: "usd",
          currentPeriodEndSeconds: unixDaysFromNow(365),
        }),
      );
      expect(res.ok()).toBeTruthy();

      const info = await billingInfo();
      expect(info.plan).toBe("pro");
      expect(info.status).toBe("active");
      expect(Date.parse(info.currentPeriodEnd)).toBeGreaterThan(Date.now());
      expect((await history()).some((e) => e.action === "billing_upgraded")).toBeTruthy();
    });

    test("the billing interval is derived from the configured price, not from the event", { tag: '@tesbo.testId("TES-TC-50")' }, async () => {
      test.skip(
        !env.stripePriceIdProMonthly || !env.stripePriceIdProAnnual,
        "needs both configured USD price IDs to tell the two intervals apart",
      );
      resetToLaunch(orgId);
      const subscriptionId = uniqueStripeId("sub");

      await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.created", {
          organizationId: orgId,
          subscriptionId,
          status: "active",
          priceId: env.stripePriceIdProMonthly,
        }),
      );
      expect((await billingInfo()).billingInterval).toBe("monthly");

      await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.updated", {
          organizationId: orgId,
          subscriptionId,
          status: "active",
          priceId: env.stripePriceIdProAnnual,
        }),
      );
      expect((await billingInfo()).billingInterval).toBe("annual");
    });

    test("a scheduled cancellation is surfaced and reverting it is recorded too", { tag: '@tesbo.testId("TES-TC-46")' }, async () => {
      setProPlan(orgId, { cancel_at_period_end: false });
      const subscriptionId = uniqueStripeId("sub");
      const periodEnd = unixDaysFromNow(20);

      const scheduledBefore = countBillingAuditEntries(orgId, "billing_cancel_scheduled");
      await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.updated", {
          organizationId: orgId,
          subscriptionId,
          status: "active",
          priceId: env.stripePriceIdProAnnual,
          currentPeriodEndSeconds: periodEnd,
          cancelAtPeriodEnd: true,
        }),
      );

      let info = await billingInfo();
      // Access continues to the end of the paid period — a scheduled cancellation is not a downgrade.
      expect(info.plan).toBe("pro");
      expect(info.cancelAtPeriodEnd).toBe(true);
      expect(Math.abs(Date.parse(info.currentPeriodEnd) - periodEnd * 1000)).toBeLessThan(2000);
      expect(countBillingAuditEntries(orgId, "billing_cancel_scheduled")).toBe(scheduledBefore + 1);

      const revertedBefore = countBillingAuditEntries(orgId, "billing_cancel_reverted");
      await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.updated", {
          organizationId: orgId,
          subscriptionId,
          status: "active",
          priceId: env.stripePriceIdProAnnual,
          currentPeriodEndSeconds: periodEnd,
          cancelAtPeriodEnd: false,
        }),
      );

      info = await billingInfo();
      expect(info.cancelAtPeriodEnd).toBe(false);
      expect(countBillingAuditEntries(orgId, "billing_cancel_reverted")).toBe(revertedBefore + 1);
    });

    test("a failed invoice flags the workspace but keeps Pro access while Stripe retries", { tag: '@tesbo.testId("TES-TC-47")' }, async () => {
      setProPlan(orgId, { payment_failed_at: null });

      const res = await postStripeWebhook(
        anon,
        invoicePaymentFailed({ organizationId: orgId, amountDue: 36000, currency: "usd" }),
      );
      expect(res.ok()).toBeTruthy();

      const info = await billingInfo();
      // Deliberate: Stripe is still running its retry schedule, so this is the one screen that can
      // recover the payment. Cutting access here would punish a customer whose card just expired.
      expect(info.plan).toBe("pro");
      expect(info.paymentFailedAt).not.toBeNull();

      const failed = (await history()).find((e) => e.action === "billing_payment_failed");
      expect(failed).toBeTruthy();
      expect(failed!.summary).toContain("Payment failed");
      expect(failed!.detail.amountDue).toBe(36000);
    });

    test("Stripe's retries don't re-notify: only the first failure of a dunning cycle is recorded", { tag: '@tesbo.testId("TES-TC-53")' }, async () => {
      setProPlan(orgId, { payment_failed_at: null });
      const before = countBillingAuditEntries(orgId, "billing_payment_failed");

      // Stripe retries a failed invoice three or four times. Each retry is a fresh event id, so the
      // replay guard doesn't cover this — the timestamp column is what stops the customer being
      // emailed about the same invoice on every attempt.
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await postStripeWebhook(anon, invoicePaymentFailed({ organizationId: orgId }));
        expect(res.ok()).toBeTruthy();
      }

      expect(countBillingAuditEntries(orgId, "billing_payment_failed")).toBe(before + 1);
      const firstFailure = readBillingState(orgId).payment_failed_at;
      expect(firstFailure).not.toBeNull();
    });

    test("a paid invoice clears the failure state and records the receipt", { tag: '@tesbo.testId("TES-TC-48")' }, async () => {
      setProPlan(orgId, { payment_failed_at: isoDaysFromNow(-3) });

      const res = await postStripeWebhook(
        anon,
        invoicePaid({ organizationId: orgId, amountPaid: 36000, currency: "usd", number: "E2E-0007" }),
      );
      expect(res.ok()).toBeTruthy();

      expect((await billingInfo()).paymentFailedAt).toBeNull();
      const paid = (await history()).find((e) => e.action === "billing_payment_succeeded");
      expect(paid).toBeTruthy();
      expect(paid!.summary).toContain("Payment received");
      expect(paid!.detail.invoiceNumber).toBe("E2E-0007");
    });

    test("a cancelled subscription drops to Launch and opens a grace window", { tag: '@tesbo.testId("TES-TC-49")' }, async () => {
      setProPlan(orgId);
      const subscriptionId = uniqueStripeId("sub");

      const res = await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.deleted", {
          organizationId: orgId,
          subscriptionId,
          status: "canceled",
          priceId: env.stripePriceIdProAnnual,
        }),
      );
      expect(res.ok()).toBeTruthy();

      const info = await billingInfo();
      expect(info.plan).toBe("launch");
      expect(info.status).toBe("canceled");
      // Nothing is deleted and nothing is locked yet: the workspace keeps Pro-sized limits for the
      // whole grace window so a lapsed card never strands work in progress.
      expect(info.inGracePeriod).toBe(true);
      expect(info.limitsEnforced).toBe(false);
      const graceDays = (Date.parse(info.graceEndsAt) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(graceDays).toBeGreaterThan(env.planGraceDays - 2);
      expect(graceDays).toBeLessThan(env.planGraceDays + 2);

      const downgraded = (await history()).find((e) => e.action === "billing_downgraded");
      expect(downgraded).toBeTruthy();
      expect(downgraded!.detail.status).toBe("canceled");
      expect(downgraded!.detail.limitsApplyFrom).toBeTruthy();
    });

    test("repeated subscription updates can't push an open grace deadline back", { tag: '@tesbo.testId("TES-TC-55")' }, async () => {
      setGraceWindow(orgId, 5);
      const originalDeadline = readBillingState(orgId).plan_grace_ends_at;
      const subscriptionId = uniqueStripeId("sub");

      // Stripe sends several customer.subscription.updated events around a cancellation. If each one
      // reset the countdown, a workspace could sit in perpetual grace and never actually downgrade.
      for (let i = 0; i < 2; i++) {
        const res = await postStripeWebhook(
          anon,
          subscriptionEvent("customer.subscription.updated", {
            organizationId: orgId,
            subscriptionId,
            status: "canceled",
            priceId: env.stripePriceIdProAnnual,
          }),
        );
        expect(res.ok()).toBeTruthy();
      }

      const after = readBillingState(orgId).plan_grace_ends_at;
      expect(Math.abs(Date.parse(after!) - Date.parse(originalDeadline!))).toBeLessThan(2000);
      expect((await billingInfo()).inGracePeriod).toBe(true);
    });

    test("resubscribing clears the grace window, the dunning flag and the lock notice", { tag: '@tesbo.testId("TES-TC-51")' }, async () => {
      // A workspace that lapsed, ran out its grace window, got locked, and is now paying again.
      setGraceWindow(orgId, -1, {
        payment_failed_at: isoDaysFromNow(-40),
        grace_locked_notified_at: isoDaysFromNow(-5),
      });
      expect((await billingInfo()).limitsEnforced).toBe(true);

      const res = await postStripeWebhook(
        anon,
        subscriptionEvent("customer.subscription.created", {
          organizationId: orgId,
          subscriptionId: uniqueStripeId("sub"),
          status: "active",
          priceId: env.stripePriceIdProAnnual,
        }),
      );
      expect(res.ok()).toBeTruthy();

      const info = await billingInfo();
      expect(info.plan).toBe("pro");
      expect(info.inGracePeriod).toBe(false);
      expect(info.limitsEnforced).toBe(false);
      expect(info.graceEndsAt).toBeNull();
      expect(info.paymentFailedAt).toBeNull();

      // Access is derived from these columns, so clearing them IS the restore — there is no data to
      // move back, which is what makes re-upgrading instant.
      const state = readBillingState(orgId);
      expect(state.plan_grace_ends_at).toBeNull();
      expect(state.grace_locked_notified_at).toBeNull();
    });

    test("a redelivered event is acknowledged but applied only once", { tag: '@tesbo.testId("TES-TC-52")' }, async () => {
      setProPlan(orgId, { payment_failed_at: null });
      const event = invoicePaid({ organizationId: orgId, amountPaid: 12345, number: "E2E-REPLAY" });
      const before = countBillingAuditEntries(orgId, "billing_payment_succeeded");

      const first = await postStripeWebhook(anon, event);
      expect(first.ok()).toBeTruthy();
      expect(webhookEventRecorded(event.id)).toBeTruthy();

      // Stripe redelivers on any slow or failed response. The redelivery has to be acknowledged
      // (a 4xx/5xx would just make it retry again) while changing nothing.
      const second = await postStripeWebhook(anon, event);
      expect(second.ok()).toBeTruthy();
      expect(countBillingAuditEntries(orgId, "billing_payment_succeeded")).toBe(before + 1);
    });

    test("an event type with no handler is acknowledged rather than retried", { tag: '@tesbo.testId("TES-TC-57")' }, async () => {
      const res = await postStripeWebhook(anon, unhandledEvent());
      expect(res.ok()).toBeTruthy();
      expect(await res.json()).toMatchObject({ received: true });
    });

    test("an event that can't be routed to a workspace is ignored, not applied to the wrong one", { tag: '@tesbo.testId("TES-TC-58")' }, async () => {
      setProPlan(orgId);
      const stateBefore = readBillingState(orgId);

      // No organizationId in the subscription metadata, and an invoice for a customer we've never
      // seen. Both are unroutable, and guessing would corrupt a different workspace's plan.
      const orphanSubscription = subscriptionEvent("customer.subscription.deleted", {
        organizationId: "",
        subscriptionId: uniqueStripeId("sub"),
        status: "canceled",
      });
      (orphanSubscription.data.object as Record<string, unknown>).metadata = {};
      expect((await postStripeWebhook(anon, orphanSubscription)).ok()).toBeTruthy();

      const orphanInvoice = invoicePaid({ organizationId: "" });
      (orphanInvoice.data.object as Record<string, unknown>).parent = {};
      (orphanInvoice.data.object as Record<string, unknown>).customer = "cus_e2e_unknown_customer";
      expect((await postStripeWebhook(anon, orphanInvoice)).ok()).toBeTruthy();

      const stateAfter = readBillingState(orgId);
      expect(stateAfter.plan).toBe(stateBefore.plan);
      expect(stateAfter.subscription_status).toBe(stateBefore.subscription_status);
    });

    test("a Stripe read failure on the billing page never downgrades a paying customer", { tag: '@tesbo.testId("TES-TC-59")' }, async () => {
      // getBillingInfo self-heals plan drift, which for a Pro workspace means retrieving its
      // subscription from Stripe. This tenant's subscription id is synthetic, so that retrieve
      // fails — and the page must still report Pro. Treating an unreachable or erroring Stripe as
      // "no subscription found" is the expensive direction of this bug: it cancels paying customers.
      setProPlan(orgId, { stripe_subscription_id: uniqueStripeId("sub") });

      for (let i = 0; i < 2; i++) {
        const info = await billingInfo();
        expect(info.plan).toBe("pro");
        expect(info.status).toBe("active");
      }
      expect(readBillingState(orgId).plan).toBe("pro");
    });
  });

  test.describe("plan limits on Launch", () => {
    test("usage reports the Launch ceilings", { tag: '@tesbo.testId("TES-TC-60")' }, async () => {
      resetToLaunch(orgId);
      const summary = await usage();
      expect(summary.plan).toBe("launch");
      expect(summary.projectLimit).toBe(2);
      expect(summary.storageLimitBytes).toBe(500 * 1024 * 1024);
      expect(summary.inGracePeriod).toBe(false);
    });

    test("creating a project beyond the allowance is refused with a route out", { tag: '@tesbo.testId("TES-TC-61")' }, async () => {
      resetToLaunch(orgId);
      const res = await createProject("E2E Billing Over Limit");
      expect(res.status()).toBe(403);
      const { error } = await res.json();
      expect(error).toContain("limited to 2 projects");
      expect(error).toContain("Upgrade to Pro");
    });

    test("custom fields are refused as a Pro feature", { tag: '@tesbo.testId("TES-TC-62")' }, async () => {
      resetToLaunch(orgId);
      const res = await asBilling.post(`/api/projects/${projectIds[0]}/custom-fields/definitions`, {
        data: { name: `E2E Billing Field ${Date.now()}`, fieldType: "text" },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("Pro plan feature");
    });

    test("Linear is refused as a Pro integration while Jira passes the plan gate", { tag: '@tesbo.testId("TES-TC-63")' }, async () => {
      resetToLaunch(orgId);

      const linear = await asBilling.post("/api/workspace/integrations/linear/callback", {
        data: {},
        failOnStatusCode: false,
      });
      expect(linear.status()).toBe(403);
      expect((await linear.json()).error).toContain("Pro plan integration");

      // Jira is included on Launch, so the plan gate lets this through and it fails later on the
      // missing OAuth code instead — which is how we can tell the gate opened without connecting
      // anything.
      const jira = await asBilling.post("/api/workspace/integrations/jira/callback", {
        data: {},
        failOnStatusCode: false,
      });
      expect(jira.status()).toBe(400);
      expect((await jira.json()).error).toContain("Authorization code");
    });

    test("POST /api/billing/portal-session refuses a workspace with no billing account", { tag: '@tesbo.testId("TES-TC-64")' }, async () => {
      resetToLaunch(orgId);
      expect(readBillingState(orgId).stripe_customer_id).toBeNull();

      // Returns before any Stripe call, which is also what makes this assertion safe to run against
      // a live key.
      const res = await asBilling.post("/api/billing/portal-session", { failOnStatusCode: false });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("no billing account");
    });
  });

  test.describe("plan limits on Pro", () => {
    test("usage reports unlimited projects and the larger storage allowance", { tag: '@tesbo.testId("TES-TC-65")' }, async () => {
      setProPlan(orgId);
      const summary = await usage();
      expect(summary.plan).toBe("pro");
      expect(summary.projectLimit).toBeNull();
      expect(summary.storageLimitBytes).toBe(5 * 1024 * 1024 * 1024);
    });

    test("projects beyond the Launch allowance can be created, and every project is writable", { tag: '@tesbo.testId("TES-TC-66")' }, async () => {
      setProPlan(orgId);
      const res = await createProject("E2E Billing Pro Extra");
      expect(res.ok()).toBeTruthy();
      const created = await res.json();

      try {
        const patch = await asBilling.patch(`/api/projects/${projectIds[projectIds.length - 1]}`, {
          data: { description: "Writable on Pro" },
          failOnStatusCode: false,
        });
        expect(patch.ok()).toBeTruthy();
      } finally {
        await asBilling.delete(`/api/projects/${created.id}`, { failOnStatusCode: false });
      }
    });

    test("custom fields and the Pro-only integration are available", { tag: '@tesbo.testId("TES-TC-67")' }, async () => {
      setProPlan(orgId);

      const created = await asBilling.post(`/api/projects/${projectIds[0]}/custom-fields/definitions`, {
        data: { name: `E2E Billing Pro Field ${Date.now()}`, fieldType: "text" },
        failOnStatusCode: false,
      });
      expect(created.ok()).toBeTruthy();
      const definition = await created.json();

      try {
        // Past the plan gate; it now fails on the missing OAuth code like any unconnected provider.
        const linear = await asBilling.post("/api/workspace/integrations/linear/callback", {
          data: {},
          failOnStatusCode: false,
        });
        expect(linear.status()).toBe(400);
        expect((await linear.json()).error).toContain("Authorization code");
      } finally {
        await asBilling.delete(
          `/api/projects/${projectIds[0]}/custom-fields/definitions/${definition.id}`,
          { failOnStatusCode: false },
        );
      }
    });
  });

  test.describe("the post-downgrade grace window", () => {
    test("an open window keeps Pro-sized limits and says when they end", { tag: '@tesbo.testId("TES-TC-68")' }, async () => {
      setGraceWindow(orgId, 7);

      const info = await billingInfo();
      expect(info.plan).toBe("launch");
      expect(info.inGracePeriod).toBe(true);
      expect(info.limitsEnforced).toBe(false);

      // The limits reported have to be the limits enforced, or the usage bars lie.
      const summary = await usage();
      expect(summary.plan).toBe("launch");
      expect(summary.inGracePeriod).toBe(true);
      expect(summary.projectLimit).toBeNull();
      expect(summary.storageLimitBytes).toBe(5 * 1024 * 1024 * 1024);

      const created = await createProject("E2E Billing Grace Extra");
      expect(created.ok()).toBeTruthy();
      await asBilling.delete(`/api/projects/${(await created.json()).id}`, { failOnStatusCode: false });
    });

    test("a closed window starts enforcing Launch limits", { tag: '@tesbo.testId("TES-TC-69")' }, async () => {
      setGraceWindow(orgId, -1);

      const info = await billingInfo();
      expect(info.inGracePeriod).toBe(false);
      expect(info.limitsEnforced).toBe(true);

      const summary = await usage();
      expect(summary.projectLimit).toBe(2);
      expect(summary.storageLimitBytes).toBe(500 * 1024 * 1024);

      const created = await createProject("E2E Billing Enforced Extra");
      expect(created.status()).toBe(403);
    });

    test("projects beyond the allowance become read-only, and reads are untouched", { tag: '@tesbo.testId("TES-TC-70")' }, async () => {
      setGraceWindow(orgId, -1);
      const oldest = activeProjectIdsOldestFirst(orgId);
      const writable = oldest[1];
      const locked = oldest[2];

      // The oldest two stay writable — a stable, creation-ordered rule, so the same projects remain
      // available across requests rather than shuffling.
      const allowed = await asBilling.patch(`/api/projects/${writable}`, {
        data: { description: `Still writable ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(allowed.ok()).toBeTruthy();

      const refused = await asBilling.patch(`/api/projects/${locked}`, {
        data: { description: "Should be refused" },
        failOnStatusCode: false,
      });
      expect(refused.status()).toBe(403);
      const { error } = await refused.json();
      expect(error).toContain("read-only");
      // "Your data is safe" is the whole promise of this design — a downgrade restricts changes, it
      // never withholds anything.
      expect(error).toContain("Your data is safe");

      // Reads must keep working so the workspace can always see and export what it has.
      const read = await asBilling.get(`/api/projects/${locked}`);
      expect(read.ok()).toBeTruthy();
      expect((await read.json()).id).toBe(locked);
      const testcases = await asBilling.get(`/api/projects/${locked}/testcases`);
      expect(testcases.ok()).toBeTruthy();

      // Writes nested under a locked project are covered too, not just the project itself.
      const nested = await asBilling.post(`/api/projects/${locked}/suites`, {
        data: { name: `Should be refused ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(nested.status()).toBe(403);
    });

    test("BUGC-A-10 a locked project's bug comments stay readable, but a new comment, a reply, an edit or a delete is refused", async () => {
      // Bug comments are routed under /api/projects/:projectId precisely so ProjectWriteLockGuard
      // covers them (the older /api/bugs/:bugId routes sit outside it). Seed while the grace window
      // is still open, then close it.
      setGraceWindow(orgId, 1);
      const locked = activeProjectIdsOldestFirst(orgId)[2];
      const bug = await (
        await asBilling.post(`/api/projects/${locked}/bugs`, { data: { title: `E2E Locked Comment Bug ${Date.now()}` } })
      ).json();
      try {
        const before = await asBilling.post(`/api/projects/${locked}/bugs/${bug.id}/comments`, {
          data: { body: "Written before the lock" },
        });
        expect(before.ok()).toBeTruthy();

        setGraceWindow(orgId, -1);
        const refused = await asBilling.post(`/api/projects/${locked}/bugs/${bug.id}/comments`, {
          data: { body: "Written after the lock" },
          failOnStatusCode: false,
        });
        expect(refused.status()).toBe(403);
        expect((await refused.json()).error).toContain("read-only");

        // Edit and delete are nested under the same project path, so the lock covers them too.
        const commentUrl = `/api/projects/${locked}/bugs/${bug.id}/comments/${(await before.json()).id}`;
        const edit = await asBilling.patch(commentUrl, { data: { body: "Edited after the lock" }, failOnStatusCode: false });
        expect(edit.status()).toBe(403);
        expect((await edit.json()).error).toContain("read-only");
        const del = await asBilling.delete(commentUrl, { failOnStatusCode: false });
        expect(del.status()).toBe(403);
        const reply = await asBilling.post(`/api/projects/${locked}/bugs/${bug.id}/comments`, {
          data: { body: "Reply after the lock", parentCommentId: commentUrl.split("/").pop() },
          failOnStatusCode: false,
        });
        expect(reply.status()).toBe(403);

        const read = await asBilling.get(`/api/projects/${locked}/bugs/${bug.id}/comments`);
        expect(read.ok()).toBeTruthy();
        expect((await read.json()).list.map((c: { body: string }) => c.body)).toEqual(["Written before the lock"]);
      } finally {
        // DELETE /api/bugs/:bugId is outside the project-path guard, so this works while locked.
        await asBilling.delete(`/api/bugs/${bug.id}`, { failOnStatusCode: false });
      }
    });

    test("archiving a locked project is still allowed — otherwise the lock is inescapable", { tag: '@tesbo.testId("TES-TC-71")' }, async () => {
      setGraceWindow(orgId, -1);
      const oldest = activeProjectIdsOldestFirst(orgId);
      const sacrificial = oldest[oldest.length - 1];

      // The error message tells the customer to archive a project to free a slot. If the write lock
      // blocked that DELETE too, the only way out would be to pay.
      const archived = await asBilling.delete(`/api/projects/${sacrificial}`, { failOnStatusCode: false });
      expect(archived.ok()).toBeTruthy();
      expect(activeProjectIdsOldestFirst(orgId)).not.toContain(sacrificial);

      // And the slot really is freed: the next project down is writable again.
      const remaining = activeProjectIdsOldestFirst(orgId);
      const nowWritable = remaining[1];
      const patch = await asBilling.patch(`/api/projects/${nowWritable}`, {
        data: { description: `Unlocked by archiving ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(patch.ok()).toBeTruthy();

      // Put the project count back for whatever runs next.
      projectIds = await ensureActiveProjects(4);
    });

    test("the enforcement notice fires exactly once, however many actions are blocked", { tag: '@tesbo.testId("TES-TC-72")' }, async () => {
      setGraceWindow(orgId, -1, { grace_locked_notified_at: null });
      const before = countBillingAuditEntries(orgId, "billing_limits_enforced");

      // The owner gets one email the first time limits actually bite, not one per blocked click.
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await createProject("E2E Billing Notify Once");
        expect(res.status()).toBe(403);
      }

      expect(countBillingAuditEntries(orgId, "billing_limits_enforced")).toBe(before + 1);
      expect(readBillingState(orgId).grace_locked_notified_at).not.toBeNull();

      // And the moment limits started applying is visible in the workspace's own timeline, not just
      // in a mailbox.
      const entry = (await history()).find((e) => e.action === "billing_limits_enforced");
      expect(entry).toBeTruthy();
      expect(entry!.summary).toContain("Grace period ended");
    });

    test("upgrading again immediately unlocks a read-only project", { tag: '@tesbo.testId("TES-TC-73")' }, async () => {
      setGraceWindow(orgId, -1);
      const locked = activeProjectIdsOldestFirst(orgId)[2];
      const refused = await asBilling.patch(`/api/projects/${locked}`, {
        data: { description: "Refused while enforced" },
        failOnStatusCode: false,
      });
      expect(refused.status()).toBe(403);

      // No migration, no restore job, no waiting: the lock is derived from the plan columns, so
      // changing the plan lifts it on the very next request.
      setProPlan(orgId);
      const allowed = await asBilling.patch(`/api/projects/${locked}`, {
        data: { description: `Unlocked by upgrading ${Date.now()}` },
        failOnStatusCode: false,
      });
      expect(allowed.ok()).toBeTruthy();
    });
  });

  test.describe("workspace isolation", () => {
    test("one workspace's plan says nothing about another's", { tag: '@tesbo.testId("TES-TC-74")' }, async ({ request }) => {
      // `request` here is the shared smoke workspace (account A) via the default storageState. It's
      // never written by this suite, so forcing this tenant onto Pro must leave it exactly as it was.
      const before = await (await request.get("/api/billing")).json();
      setProPlan(orgId);

      expect((await billingInfo()).plan).toBe("pro");
      const after = await (await request.get("/api/billing")).json();
      expect(after.plan).toBe(before.plan);
      expect(after.status).toBe(before.status);

      setGraceWindow(orgId, -1);
      const stillUnaffected = await (await request.get("/api/billing")).json();
      expect(stillUnaffected.limitsEnforced).toBe(before.limitsEnforced);
    });
  });
});
