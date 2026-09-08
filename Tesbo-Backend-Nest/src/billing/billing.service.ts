import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from "@nestjs/common";
import type { Request } from "express";
import Stripe from "stripe";
import { EmailService } from "../auth/email.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService, PlanUsageSummary } from "../plan-limits/plan-limits.service";
import { CountryDetectionService, type CountrySource } from "./country-detection.service";
import { StripeClientProvider } from "./stripe-client.provider";

export type BillingInterval = "monthly" | "annual";
export type Currency = "usd" | "inr";

/** Just the bits of the request the currency decision depends on. */
export type BillingRequestContext = Pick<Request, "ip" | "headers">;

export interface BillingInfo {
  /** False when STRIPE_SECRET_KEY is unset — Stripe checkout/portal are unavailable. */
  enabled: boolean;
  plan: "launch" | "pro";
  billingInterval: BillingInterval | null;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Set while a subscription invoice is unpaid — drives the "update your card" banner. */
  paymentFailedAt: string | null;
  /** When Launch limits start being enforced after a downgrade; null once enforced or never owed. */
  graceEndsAt: string | null;
  /** True while a downgraded workspace still has Pro-sized limits. */
  inGracePeriod: boolean;
  /** True once the grace window closed and Launch limits are actually being applied. */
  limitsEnforced: boolean;
}

/** One entry in the workspace's billing history, rendered as a timeline in settings. */
export interface BillingHistoryEntry {
  action: string;
  summary: string;
  detail: Record<string, unknown>;
  at: string;
}

export interface BillingInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amountPaid: number;
  amountDue: number;
  currency: string;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export interface BillingPricing {
  currency: Currency;
  monthlyAmount: number | null;
  annualAmount: number | null;
  /**
   * Whether this specific visitor may choose INR. True only when INR prices are configured AND
   * the request was detected as coming from India (or the workspace is already locked to INR) —
   * so the UI never offers a toggle the server would reject.
   */
  inrAvailable: boolean;
  /**
   * Which signal decided the country. Returned so support can answer "why am I seeing USD?" without
   * reading logs — "unknown" means no signal at all, "declared" means only the self-reported
   * workspace country was available.
   */
  countrySource: CountrySource;
  /**
   * True when a past charge has fixed this workspace's currency in Stripe, so it can no longer be
   * changed. The UI shows the toggle disabled rather than letting the buyer hit a Stripe error.
   */
  currencyLocked: boolean;
}

// Subscription statuses that mean the workspace no longer has an active Pro subscription
// (as opposed to e.g. "past_due", where Stripe is still retrying payment and Pro access
// is kept during the grace period).
const ENDED_SUBSCRIPTION_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

// Statuses that mean "this workspace already has a subscription Stripe would bill", used to stop a
// second checkout creating a duplicate. past_due/unpaid count: those are existing subscriptions
// mid-dunning, and adding a second one alongside would bill the customer twice for one workspace.
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

@Injectable()
export class BillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly stripeClient: StripeClientProvider,
    private readonly legacy: LegacyService,
    private readonly planLimits: PlanLimitsService,
    private readonly countries: CountryDetectionService,
    private readonly email: EmailService
  ) {}

  private requireUser(userId?: string | null): string {
    if (!userId) throw new BadRequestException({ error: "Authentication required" });
    return userId;
  }

  private requireOwner(role: string): void {
    if (this.legacy.normalizeRole(role) !== "owner") {
      throw new ForbiddenException({ error: "Only the workspace owner can manage billing" });
    }
  }

  private requireStripeEnabled(): void {
    if (!this.config.isStripeBillingEnabled) {
      throw new ServiceUnavailableException({
        error: "Stripe billing is not configured. Set STRIPE_SECRET_KEY (and price IDs) in .env to enable it."
      });
    }
  }

  // Stripe SDK errors are plain Error subclasses, not NestJS HttpExceptions, so left
  // uncaught they all surface to the client as a generic "Internal server error" —
  // this turns them into a clear, appropriately-coded response instead.
  private async callStripe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeConnectionError) {
        throw new ServiceUnavailableException({ error: "Couldn't reach Stripe right now. Please try again in a moment." });
      }
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadGatewayException({ error: `Stripe request failed: ${error.message}` });
      }
      throw error;
    }
  }

  async getBillingInfo(userId: string | null | undefined): Promise<BillingInfo> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    // Stripe not configured: keep the settings page loadable, unlock Pro-gated UI, no Stripe calls.
    if (!this.config.isStripeBillingEnabled) {
      return {
        enabled: false,
        plan: "pro",
        billingInterval: null,
        status: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        paymentFailedAt: null,
        graceEndsAt: null,
        inGracePeriod: false,
        limitsEnforced: false
      };
    }
    await this.reconcileDriftedPlan(workspace.id, uid);
    const res = await this.db.query(
      `SELECT plan, billing_interval, subscription_status, current_period_end, cancel_at_period_end,
              payment_failed_at, plan_grace_ends_at
       FROM organizations WHERE id = $1`,
      [workspace.id]
    );
    const row = res.rows[0];
    const plan = row?.plan === "pro" ? "pro" : "launch";
    const graceEndsAt: string | null = row?.plan_grace_ends_at ?? null;
    const inGracePeriod = plan === "launch" && !!graceEndsAt && new Date(graceEndsAt).getTime() > Date.now();
    return {
      enabled: true,
      plan,
      billingInterval: row?.billing_interval ?? null,
      status: row?.subscription_status ?? null,
      currentPeriodEnd: row?.current_period_end ?? null,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
      paymentFailedAt: row?.payment_failed_at ?? null,
      graceEndsAt,
      inGracePeriod,
      // A workspace that was never on Pro has always had Launch limits; "enforced" here means
      // specifically that a former Pro workspace's grace window has run out.
      limitsEnforced: plan === "launch" && !!graceEndsAt && !inGracePeriod
    };
  }

  /**
   * Reconciles a workspace whose plan has drifted from Stripe because a webhook never arrived.
   *
   * Webhooks are the primary mechanism; this is the safety net for when they're late, dropped, or —
   * as on a newly configured account — delivered to an endpoint that isn't serving the route yet.
   * Both directions of drift are real and both were observed in practice:
   *
   *   Under-provisioned: charged but still on the free plan, because `checkout.session.completed`
   *   never landed. The post-checkout redirect calls reconcile, but that only helps someone still on
   *   that redirect — not someone who closed the tab or paid on another device.
   *
   *   Over-provisioned: still on Pro after the subscription was cancelled or went unpaid, because
   *   `customer.subscription.deleted` never landed. Left alone, a cancelled customer keeps Pro
   *   forever, which is the more expensive of the two mistakes.
   *
   * Each direction is gated so the Stripe call only happens for a workspace that could actually be
   * adrift. The downgrade path retrieves the ONE subscription we already recorded and applies its
   * real status, rather than inferring "no active subscription found" from a list — a transient
   * empty/filtered list must never be able to downgrade a paying customer.
   *
   * Never throws: this runs on every billing page load, and a Stripe hiccup must not take the page
   * down. Worst case the caller sees the un-healed state and the next load tries again.
   */
  private async reconcileDriftedPlan(organizationId: string, userId: string): Promise<void> {
    const res = await this.db.query<{
      plan: string;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      plan_source: string | null;
    }>(
      "SELECT plan, stripe_customer_id, stripe_subscription_id, plan_source FROM organizations WHERE id = $1",
      [organizationId]
    );
    const row = res.rows[0];
    if (!row) return;

    // Nothing to reconcile against: this workspace's plan was set by an operator, so a disagreement
    // with Stripe is the intended state rather than drift. Reconciling would be actively wrong here
    // — a comped ex-customer still carries the id of the cancelled subscription that churned them,
    // and "over-provisioned" below would read that as Pro to be taken away. The override is cleared
    // from the admin panel, or by the customer subscribing for real (see applySubscriptionState).
    if (row.plan_source === "admin") return;

    const mayBeUnderProvisioned = row.plan === "launch" && !!row.stripe_customer_id && !row.stripe_subscription_id;
    const mayBeOverProvisioned = row.plan === "pro" && !!row.stripe_subscription_id;
    if (!mayBeUnderProvisioned && !mayBeOverProvisioned) return;

    try {
      if (mayBeOverProvisioned) {
        const subscription = await this.stripeClient.client.subscriptions.retrieve(row.stripe_subscription_id as string);
        if (!ENDED_SUBSCRIPTION_STATUSES.has(subscription.status)) return;
        if (!subscription.metadata?.organizationId) {
          subscription.metadata = { ...subscription.metadata, organizationId };
        }
        console.warn(
          `[billing] downgrading organization ${organizationId}: Stripe subscription ${subscription.id} is ${subscription.status} but the workspace was still on Pro — the subscription webhook never arrived`
        );
        await this.applySubscriptionState(subscription);
        return;
      }

      const subs = await this.stripeClient.client.subscriptions.list({
        customer: row.stripe_customer_id as string,
        status: "all",
        limit: 20
      });
      const subscription = subs.data.find((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status));
      if (!subscription) return;
      if (!subscription.metadata?.organizationId) {
        subscription.metadata = { ...subscription.metadata, organizationId };
      }
      console.warn(
        `[billing] activating organization ${organizationId} from Stripe subscription ${subscription.id} — the checkout webhook never arrived (is a live webhook endpoint configured?)`
      );
      await this.applySubscriptionState(subscription);
    } catch (error) {
      console.error(
        `[billing] could not reconcile organization ${organizationId} (user ${userId}):`,
        error instanceof Error ? error.message : error
      );
    }
  }

  async getUsageSummary(userId: string | null | undefined): Promise<PlanUsageSummary> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    return this.planLimits.getUsageSummary(workspace.id);
  }

  /**
   * Quotes the Pro plan in the currency this visitor will actually be charged in.
   *
   * RBI rules block Indian-issued cards from paying a non-INR amount to an India-registered
   * merchant, so buyers in India are quoted and charged in INR. Because the INR list is
   * materially cheaper than the USD one, eligibility is decided SERVER-side from the detected
   * country — a client asking for INR from outside India is refused, not accommodated. See
   * resolveCurrency for the full precedence.
   *
   * getPricing and createCheckoutSession both go through resolveCurrency + resolvePriceId, so the
   * amount shown is always the amount charged.
   */
  async getPricing(
    userId: string | null | undefined,
    req: BillingRequestContext | undefined,
    requestedCurrency?: string
  ): Promise<BillingPricing> {
    this.requireStripeEnabled();
    const lockedCurrency = await this.lockedCurrencyFor(userId);
    const eligibility = await this.resolveIndiaEligibility(userId, req, lockedCurrency);
    const currency = await this.resolveCurrency(req, requestedCurrency, lockedCurrency, eligibility.indiaEligible);

    const monthly = this.resolvePriceId("monthly", currency);
    const annual = this.resolvePriceId("annual", currency);

    const [monthlyPrice, annualPrice] = await Promise.all([
      monthly.priceId ? this.callStripe(() => this.stripeClient.client.prices.retrieve(monthly.priceId)) : null,
      annual.priceId ? this.callStripe(() => this.stripeClient.client.prices.retrieve(annual.priceId)) : null
    ]);

    return {
      currency: (monthlyPrice?.currency ?? annualPrice?.currency ?? "usd") as Currency,
      monthlyAmount: monthlyPrice?.unit_amount ?? null,
      annualAmount: annualPrice?.unit_amount ?? null,
      inrAvailable: this.inrPricesConfigured && eligibility.indiaEligible,
      currencyLocked: lockedCurrency !== null,
      countrySource: eligibility.source
    };
  }

  /**
   * Decides whether this request may be quoted in INR, and records what the request itself said.
   *
   * A locked currency short-circuits everything: once Stripe has fixed the workspace's currency,
   * where the visitor is has no bearing on what they can be charged.
   *
   * Otherwise the workspace's declared country is passed to detection as a soft last-resort signal,
   * and the hard-detected country is written back so a declared/detected disagreement can be
   * reviewed later. A mismatch is logged but NOT acted on — the hard signal already won by virtue of
   * the precedence order, so there's nothing to correct at request time.
   */
  private async resolveIndiaEligibility(
    userId: string | null | undefined,
    req: BillingRequestContext | undefined,
    lockedCurrency: Currency | null
  ): Promise<{ indiaEligible: boolean; source: CountrySource }> {
    if (lockedCurrency) return { indiaEligible: lockedCurrency === "inr", source: "override" };

    const org = userId ? await this.legacy.workspace(userId) : null;
    let declared: string | null = null;
    if (org) {
      const res = await this.db.query<{ country: string | null }>("SELECT country FROM organizations WHERE id = $1", [org.id]);
      declared = res.rows[0]?.country ?? null;
    }

    const resolution = await this.countries.resolve(req, declared);

    if (org && resolution.detected) {
      await this.db.query(
        `UPDATE organizations SET last_detected_country = $1, last_detected_country_at = now() WHERE id = $2`,
        [resolution.detected, org.id]
      );
      if (declared && declared !== resolution.detected) {
        console.warn(
          `[billing] country mismatch for organization ${org.id}: declared=${declared} detected=${resolution.detected} — using detected`
        );
      }
    }

    return { indiaEligible: resolution.country === "IN", source: resolution.source };
  }

  async createCheckoutSession(
    userId: string | null | undefined,
    interval: BillingInterval,
    req: BillingRequestContext | undefined,
    requestedCurrency?: string
  ): Promise<{ url: string }> {
    this.requireStripeEnabled();
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    this.requireOwner(workspace.role);

    if (interval !== "monthly" && interval !== "annual") {
      throw new BadRequestException({ error: "interval must be 'monthly' or 'annual'" });
    }

    const lockedCurrency = await this.lockedCurrencyFor(uid);
    const { indiaEligible } = await this.resolveIndiaEligibility(uid, req, lockedCurrency);
    const currency = await this.resolveCurrency(req, requestedCurrency, lockedCurrency, indiaEligible);
    const { priceId } = this.resolvePriceId(interval, currency);
    if (!priceId) throw new BadRequestException({ error: "Stripe is not configured for this plan yet" });

    const customerId = await this.resolveStripeCustomerId(workspace.id, workspace.name, currency);
    await this.assertNoLiveSubscription(customerId);

    const session = await this.callStripe(() =>
      this.stripeClient.client.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${this.config.frontendUrl}/settings?tab=billing&checkout=success`,
        cancel_url: `${this.config.frontendUrl}/settings?tab=billing&checkout=cancelled`,
        metadata: { organizationId: workspace.id },
        subscription_data: { metadata: { organizationId: workspace.id } }
      })
    );

    if (!session.url) throw new BadRequestException({ error: "Stripe did not return a checkout URL" });
    return { url: session.url };
  }

  async createPortalSession(userId: string | null | undefined): Promise<{ url: string }> {
    this.requireStripeEnabled();
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    this.requireOwner(workspace.role);

    const res = await this.db.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1",
      [workspace.id]
    );
    const customerId = res.rows[0]?.stripe_customer_id;
    if (!customerId) throw new BadRequestException({ error: "This workspace has no billing account yet" });

    const session = await this.callStripe(() =>
      this.stripeClient.client.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${this.config.frontendUrl}/settings?tab=billing`
      })
    );
    return { url: session.url };
  }

  async constructWebhookEvent(rawBody: Buffer | undefined, signature: string | undefined): Promise<Stripe.Event> {
    this.requireStripeEnabled();
    if (!rawBody || !signature) throw new BadRequestException({ error: "Missing Stripe signature" });
    if (!this.config.stripeWebhookSecret) throw new BadRequestException({ error: "Stripe webhook secret is not configured" });
    try {
      return this.stripeClient.client.webhooks.constructEvent(rawBody, signature, this.config.stripeWebhookSecret);
    } catch (error) {
      // A verification failure is permanent for that payload — usually the wrong signing secret. Left
      // uncaught it surfaces as a 500, which Stripe treats as retryable and redelivers for days
      // against a secret that will never match. 400 tells Stripe to stop and surfaces the real cause.
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        console.error(`[billing] webhook signature verification failed — is STRIPE_WEBHOOK_SECRET the signing secret for this endpoint?`);
        throw new BadRequestException({ error: "Stripe signature verification failed" });
      }
      throw error;
    }
  }

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    // Stripe retries webhook deliveries; record the event id first so a re-delivery of an
    // already-processed event is a no-op instead of applying the update twice.
    const inserted = await this.db.query("INSERT INTO stripe_webhook_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id", [
      event.id,
      event.type
    ]);
    if (inserted.rows.length === 0) return;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (organizationId && subscriptionId) {
          const before = await this.db.query<{ plan: string }>("SELECT plan FROM organizations WHERE id = $1", [organizationId]);
          await this.db.query(
            `UPDATE organizations
                SET plan = 'pro',
                    stripe_subscription_id = $1,
                    -- The customer has paid, so Stripe owns this plan from now on and any
                    -- hand-set grant is retired. Done here as well as in applySubscriptionState
                    -- because that runs off customer.subscription.created, and a workspace left
                    -- marked 'admin' by a webhook that never arrives is one this service would
                    -- then permanently decline to reconcile — the exact failure the reconcile
                    -- path exists to catch.
                    plan_source = 'stripe',
                    plan_override_by = NULL,
                    plan_override_at = NULL,
                    plan_override_reason = NULL,
                    plan_override_expires_at = NULL,
                    updated_at = now()
              WHERE id = $2`,
            [subscriptionId, organizationId]
          );
          /*
           * The upgrade is recorded HERE, not in applySubscriptionState.
           *
           * customer.subscription.created lands moments later and also calls applySubscriptionState,
           * but by then this handler has already set plan='pro' — so its "wasn't pro, now is"
           * check sees no transition and would record nothing. Recording at the point of checkout is
           * both the accurate moment and the one that can't be missed.
           *
           * applySubscriptionState keeps its own upgrade entry for activations that never involve a
           * checkout event at all — the reconcile and self-heal paths — and its !wasPro guard stops
           * the two ever double-recording.
           */
          if (before.rows[0]?.plan !== "pro") {
            await this.recordBillingEvent(organizationId, "billing_upgraded", subscriptionId, "Upgraded to Pro", {
              via: "checkout",
              amountTotal: session.amount_total,
              currency: session.currency
            });
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await this.applySubscriptionState(event.data.object as Stripe.Subscription);
        break;
      }
      case "invoice.payment_failed": {
        await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      }
      case "invoice.paid": {
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      }
      default:
        break;
    }
  }

  /**
   * A subscription invoice failed. Stripe now runs its retry schedule (Dashboard → Billing →
   * Revenue recovery) and the subscription sits in past_due, which deliberately keeps Pro access —
   * we only downgrade once Stripe gives up and the status becomes canceled/unpaid.
   *
   * The timestamp is recorded so the billing page can show an "update your card" banner, and so
   * the warning email fires once rather than on every retry.
   */
  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const organizationId = await this.organizationIdForInvoice(invoice);
    if (!organizationId) return;

    const res = await this.db.query<{ payment_failed_at: string | null }>(
      `UPDATE organizations SET payment_failed_at = COALESCE(payment_failed_at, now()), updated_at = now()
       WHERE id = $1
       RETURNING (SELECT payment_failed_at FROM organizations WHERE id = $1) AS payment_failed_at`,
      [organizationId]
    );
    // Only notify on the first failure of a dunning cycle; Stripe retries would otherwise mail
    // the customer three or four times about the same invoice.
    const alreadyNotified = !!res.rows[0]?.payment_failed_at;
    if (alreadyNotified) return;

    await this.recordBillingEvent(
      organizationId,
      "billing_payment_failed",
      invoice.id ?? null,
      `Payment failed — ${this.formatMoney(invoice.amount_due ?? 0, invoice.currency ?? "usd")}`,
      { amountDue: invoice.amount_due, currency: invoice.currency, invoiceUrl: invoice.hosted_invoice_url ?? null }
    );

    const owner = await this.workspaceOwner(organizationId);
    if (!owner) return;
    await this.email.sendPaymentFailed(owner.email, owner.workspaceName, this.billingUrl, this.config.planGraceDays);
  }

  /** A subscription invoice was paid — clears the failure state and sends the receipt. */
  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const organizationId = await this.organizationIdForInvoice(invoice);
    if (!organizationId) return;

    await this.db.query("UPDATE organizations SET payment_failed_at = NULL, updated_at = now() WHERE id = $1", [organizationId]);

    const amountLabel = this.formatMoney(invoice.amount_paid ?? 0, invoice.currency ?? "usd");
    await this.recordBillingEvent(organizationId, "billing_payment_succeeded", invoice.id ?? null, `Payment received — ${amountLabel}`, {
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      invoiceNumber: invoice.number ?? null,
      invoiceUrl: invoice.hosted_invoice_url ?? null
    });

    const owner = await this.workspaceOwner(organizationId);
    if (!owner) return;
    const periodEnd = invoice.lines?.data?.[0]?.period?.end ?? null;
    await this.email.sendPaymentSucceeded(
      owner.email,
      owner.workspaceName,
      amountLabel,
      periodEnd ? this.formatDate(new Date(periodEnd * 1000)) : null,
      invoice.hosted_invoice_url ?? null
    );
  }

  /**
   * Pulls the current subscription state from Stripe and applies it.
   *
   * Called after checkout returns so an upgrade lands even when the webhook is late, dropped, or —
   * as on a freshly configured account — not yet set up at all. Without this, a customer who paid
   * successfully would sit on the free plan until someone noticed.
   */
  async reconcileFromStripe(userId: string | null | undefined): Promise<BillingInfo> {
    this.requireStripeEnabled();
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    const res = await this.db.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1",
      [workspace.id]
    );
    const customerId = res.rows[0]?.stripe_customer_id;
    if (!customerId) return this.getBillingInfo(uid);

    const subs = await this.callStripe(() =>
      this.stripeClient.client.subscriptions.list({ customer: customerId, status: "all", limit: 20 })
    );
    // Prefer a billable subscription; fall back to the most recent so a cancellation that never
    // arrived by webhook is still reflected instead of leaving the workspace on stale Pro.
    const subscription = subs.data.find((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status)) ?? subs.data[0];
    if (subscription) {
      // Checkout sets this metadata, but a subscription created directly in the Dashboard won't
      // have it — fill it in so applySubscriptionState and later webhooks can route it.
      if (!subscription.metadata?.organizationId) {
        subscription.metadata = { ...subscription.metadata, organizationId: workspace.id };
        await this.callStripe(() =>
          this.stripeClient.client.subscriptions.update(subscription.id, { metadata: subscription.metadata })
        );
      }
      await this.applySubscriptionState(subscription);
    }
    return this.getBillingInfo(uid);
  }

  private async organizationIdForInvoice(invoice: Stripe.Invoice): Promise<string | null> {
    // On current API versions the subscription that produced an invoice hangs off `parent`, and its
    // metadata is a snapshot taken at finalization — which is where checkout's organizationId lands.
    const fromMetadata =
      invoice.parent?.subscription_details?.metadata?.organizationId ?? invoice.metadata?.organizationId;
    if (fromMetadata) return fromMetadata;

    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (!customerId) return null;
    const res = await this.db.query<{ id: string }>("SELECT id FROM organizations WHERE stripe_customer_id = $1", [customerId]);
    return res.rows[0]?.id ?? null;
  }

  private async workspaceOwner(organizationId: string): Promise<{ email: string; workspaceName: string } | null> {
    const res = await this.db.query<{ email: string; name: string }>(
      `SELECT u.email, o.name
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.role = 'owner'
        ORDER BY m.created_at
        LIMIT 1`,
      [organizationId]
    );
    const row = res.rows[0];
    return row ? { email: row.email, workspaceName: row.name } : null;
  }

  private get billingUrl(): string {
    return `${this.config.frontendUrl}/settings?tab=billing`;
  }

  /**
   * Appends one entry to the workspace's billing history.
   *
   * Reuses audit_logs (organization-scoped, append-only by trigger) rather than a dedicated table,
   * so this history inherits the same immutability guarantee as the rest of the audit trail — a
   * billing record nobody can quietly rewrite is the point of keeping it.
   *
   * actor_id is null because these originate from Stripe, not from a person clicking something. The
   * underlying helper swallows its own errors, so a logging failure can never fail a webhook and
   * trigger a Stripe retry.
   */
  private async recordBillingEvent(
    organizationId: string,
    action: string,
    entityId: string | null,
    summary: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    await this.legacy.logWorkspaceActivity(organizationId, null, action, "billing", entityId, summary, detail);
  }

  /** Billing history for the current workspace, newest first. */
  async getBillingHistory(userId: string | null | undefined, limit = 50): Promise<BillingHistoryEntry[]> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    const res = await this.db.query<{ action: string; entity_name: string | null; diff: Record<string, unknown> | null; created_at: string }>(
      `SELECT action, entity_name, diff, created_at
         FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'billing'
        ORDER BY created_at DESC
        LIMIT $2`,
      [workspace.id, Math.min(Math.max(1, limit), 200)]
    );
    return res.rows.map((r) => ({
      action: r.action,
      summary: r.entity_name ?? r.action,
      detail: r.diff ?? {},
      at: r.created_at
    }));
  }

  /**
   * The workspace's Stripe invoices, so past receipts are reachable from inside the app.
   *
   * Read live from Stripe rather than mirrored locally: invoices are Stripe's record, and the hosted
   * URLs it returns are what customers actually need for accounting.
   */
  async getInvoices(userId: string | null | undefined): Promise<BillingInvoice[]> {
    this.requireStripeEnabled();
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    const res = await this.db.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1",
      [workspace.id]
    );
    const customerId = res.rows[0]?.stripe_customer_id;
    if (!customerId) return [];

    const invoices = await this.callStripe(() => this.stripeClient.client.invoices.list({ customer: customerId, limit: 24 }));
    return invoices.data
      // Drafts have no stable number or hosted page yet and aren't money that moved.
      .filter((inv) => inv.status !== "draft")
      .map((inv) => ({
        id: inv.id ?? "",
        number: inv.number ?? null,
        status: inv.status ?? null,
        amountPaid: inv.amount_paid ?? 0,
        amountDue: inv.amount_due ?? 0,
        currency: (inv.currency ?? "usd").toLowerCase(),
        createdAt: new Date((inv.created ?? 0) * 1000).toISOString(),
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdf: inv.invoice_pdf ?? null
      }));
  }

  private formatMoney(amountMinor: number, currency: string): string {
    const upper = currency.toUpperCase();
    const symbol = upper === "INR" ? "₹" : upper === "USD" ? "$" : "";
    const locale = upper === "INR" ? "en-IN" : "en-US";
    const major = amountMinor / 100;
    const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: Number.isInteger(major) ? 0 : 2 }).format(major);
    return symbol ? `${symbol}${formatted}` : `${formatted} ${upper}`;
  }

  private formatDate(date: Date): string {
    return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
  }

  // INR is offered only when BOTH interval prices exist in INR. Falling back per interval
  // would let the monthly card read ₹ while the annual one silently charged USD (getPricing
  // reports a single currency for the whole plan), so a half-configured INR setup stays on
  // USD for both rather than showing an amount that doesn't match the charge.
  private get inrPricesConfigured(): boolean {
    return Boolean(this.config.stripePriceIdProMonthlyInr && this.config.stripePriceIdProAnnualInr);
  }

  // Picks the Price ID for an interval, using the INR price when the buyer is on India
  // pricing and INR is configured, otherwise falling back to USD — so checkout never breaks
  // even if the INR prices haven't been set up yet.
  private resolvePriceId(interval: BillingInterval, currency: Currency): { priceId: string; currency: Currency } {
    if (currency === "inr" && this.inrPricesConfigured) {
      const inrId = interval === "monthly" ? this.config.stripePriceIdProMonthlyInr : this.config.stripePriceIdProAnnualInr;
      return { priceId: inrId, currency: "inr" };
    }
    const usdId = interval === "monthly" ? this.config.stripePriceIdProMonthly : this.config.stripePriceIdProAnnual;
    return { priceId: usdId, currency: "usd" };
  }

  /**
   * Decides the currency for a quote or a checkout. Precedence, highest first:
   *
   *   1. A locked currency — a past invoice has fixed it in Stripe and it cannot change.
   *   2. An explicit request from the client, but ONLY if allowed: asking for INR requires the
   *      server to have independently placed this visitor in India. This is the anti-abuse gate;
   *      the INR list is much cheaper, so a self-declared claim is never sufficient.
   *   3. Detected country — India gets INR by default so RBI-affected buyers don't have to know
   *      to ask.
   *
   * Unsupported codes are rejected outright rather than defaulting, so a typo can never result in
   * charging the wrong currency.
   */
  private async resolveCurrency(
    req: BillingRequestContext | undefined,
    requested: string | undefined,
    lockedCurrency: Currency | null,
    indiaEligible: boolean
  ): Promise<Currency> {
    const raw = requested?.trim().toLowerCase();
    const override = raw ? this.asCurrency(raw) : null;
    if (raw && !override) {
      throw new BadRequestException({ error: "currency must be 'usd' or 'inr'" });
    }

    if (lockedCurrency) {
      // Silently ignoring a mismatched request would show one currency and charge another, so say
      // plainly what happened instead.
      if (override && override !== lockedCurrency) {
        throw new ConflictException({
          error: `This workspace is already billed in ${lockedCurrency.toUpperCase()}. Stripe fixes a customer's billing currency once they've been invoiced, so it can't be changed — contact ${this.config.supportContactEmail} if you need to switch.`
        });
      }
      return lockedCurrency;
    }

    if (override === "inr" && !indiaEligible) {
      throw new ForbiddenException({
        error: "India pricing is only available to customers in India. Your card will be charged in USD."
      });
    }
    if (override) return override;

    return indiaEligible ? "inr" : "usd";
  }

  /**
   * The currency this workspace is permanently pinned to, or null while it's still open.
   *
   * Stripe fixes `Customer.currency` and every later subscription for that customer must match it.
   * Since a workspace reuses one customer, a workspace that paid in INR can never start a USD
   * subscription (and vice versa) — Stripe rejects it. Reading the pin up front turns what would be
   * an opaque "Stripe request failed" into a clear message, and lets the UI disable the toggle.
   *
   * Crucially, a pin is only treated as binding when the customer has actually been billed. Stripe
   * sets `currency` when a Checkout Session is CREATED, not when it's paid — so someone who opens
   * checkout and abandons it would otherwise be locked to that currency forever, despite never
   * having paid a penny. When there's no payment history the pin is ignored here and
   * resolveStripeCustomerId swaps in a fresh customer at checkout instead.
   *
   * Mirrored locally by applySubscriptionState (which only runs for real subscriptions) to keep this
   * off the hot path; Stripe is consulted only when we have a customer but no mirrored currency.
   */
  private async lockedCurrencyFor(userId: string | null | undefined): Promise<Currency | null> {
    if (!userId) return null;
    const workspace = await this.legacy.workspace(userId);
    const res = await this.db.query<{ billing_currency: string | null; stripe_customer_id: string | null }>(
      "SELECT billing_currency, stripe_customer_id FROM organizations WHERE id = $1",
      [workspace.id]
    );
    const row = res.rows[0];
    const mirrored = this.asCurrency(row?.billing_currency);
    if (mirrored) return mirrored;
    if (!row?.stripe_customer_id) return null;

    const customer = await this.callStripe(() => this.stripeClient.client.customers.retrieve(row.stripe_customer_id as string));
    if (customer.deleted) return null;
    const currency = this.asCurrency(customer.currency);
    if (!currency) return null;

    if (!(await this.hasBillingHistory(row.stripe_customer_id))) return null;

    await this.db.query("UPDATE organizations SET billing_currency = $1, updated_at = now() WHERE id = $2", [currency, workspace.id]);
    return currency;
  }

  /**
   * Whether Stripe has ever actually billed this customer.
   *
   * One invoice is enough to prove it: subscriptions always generate one, so invoices alone cover
   * both. Used to distinguish "genuinely committed to a currency" from "opened a checkout page once".
   */
  private async hasBillingHistory(customerId: string): Promise<boolean> {
    const invoices = await this.callStripe(() => this.stripeClient.client.invoices.list({ customer: customerId, limit: 1 }));
    return invoices.data.length > 0;
  }

  private asCurrency(value: string | null | undefined): Currency | null {
    const v = (value ?? "").trim().toLowerCase();
    return v === "usd" || v === "inr" ? v : null;
  }

  /**
   * Refuses a second checkout while Stripe already has a billable subscription for this customer.
   *
   * The UI disables the upgrade button once the workspace is Pro, but that's not a guard: two open
   * tabs, a double submit, or a direct API call would each create another subscription and bill the
   * customer twice for one workspace. Stripe is asked rather than our own `plan` column because the
   * column only updates when a webhook lands — during that window our DB still says "launch" while
   * Stripe already has an active subscription.
   */
  private async assertNoLiveSubscription(customerId: string): Promise<void> {
    const subs = await this.callStripe(() =>
      this.stripeClient.client.subscriptions.list({ customer: customerId, status: "all", limit: 20 })
    );
    const live = subs.data.find((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status));
    if (live) {
      throw new ConflictException({
        error:
          "This workspace already has an active Tesbo Pro subscription. Use “Manage billing” to change or cancel it instead of subscribing again."
      });
    }
  }

  /**
   * The Stripe customer to bill this workspace in `currency`, creating or replacing it as needed.
   *
   * The replacement case matters: Stripe pins a customer's currency the moment a Checkout Session is
   * created, and that pin is immutable. So a workspace that once opened a USD checkout and walked
   * away cannot start an INR subscription on that customer — Stripe rejects it outright. When the
   * pinned currency conflicts and the customer has never been billed, there's nothing worth keeping,
   * so we point the workspace at a fresh customer instead of failing the purchase.
   *
   * A customer WITH billing history is never replaced — that would orphan real invoices. The
   * currency lock in resolveCurrency has already forced `currency` to match in that case, so a
   * conflict can't reach here.
   */
  private async resolveStripeCustomerId(organizationId: string, organizationName: string, currency: Currency): Promise<string> {
    const existing = await this.db.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1",
      [organizationId]
    );
    const current = existing.rows[0]?.stripe_customer_id;

    if (current) {
      const customer = await this.callStripe(() => this.stripeClient.client.customers.retrieve(current));
      const pinned = customer.deleted ? null : this.asCurrency(customer.currency);
      if (!pinned || pinned === currency) return current;
      if (await this.hasBillingHistory(current)) return current;
      console.warn(
        `[billing] organization ${organizationId}: Stripe customer ${current} is pinned to ${pinned} by an abandoned checkout but has never been billed — issuing a fresh customer for ${currency}`
      );
    }

    const customer = await this.callStripe(() =>
      this.stripeClient.client.customers.create({
        name: organizationName,
        metadata: { organizationId }
      })
    );
    // Clear any mirrored currency alongside the swap, so the lock is re-derived from the new customer.
    await this.db.query(
      "UPDATE organizations SET stripe_customer_id = $1, billing_currency = NULL, updated_at = now() WHERE id = $2",
      [customer.id, organizationId]
    );
    return customer.id;
  }

  private async applySubscriptionState(subscription: Stripe.Subscription): Promise<void> {
    const organizationId = subscription.metadata?.organizationId;
    if (!organizationId) return;

    const priceId = subscription.items.data[0]?.price?.id ?? "";
    const monthlyPriceIds = new Set([this.config.stripePriceIdProMonthly, this.config.stripePriceIdProMonthlyInr]);
    const annualPriceIds = new Set([this.config.stripePriceIdProAnnual, this.config.stripePriceIdProAnnualInr]);
    const billingInterval: BillingInterval | null = monthlyPriceIds.has(priceId)
      ? "monthly"
      : annualPriceIds.has(priceId)
        ? "annual"
        : null;
    const periodEndSeconds = subscription.items.data[0]?.current_period_end;
    const plan = ENDED_SUBSCRIPTION_STATUSES.has(subscription.status) ? "launch" : "pro";
    // Mirror the currency Stripe actually billed in, so lockedCurrencyFor stays off the hot path.
    const currency = this.asCurrency(subscription.items.data[0]?.price?.currency);

    const before = await this.db.query<{
      plan: string;
      plan_grace_ends_at: string | null;
      payment_failed_at: string | null;
      grace_locked_notified_at: string | null;
      cancel_at_period_end: boolean | null;
      plan_source: string | null;
    }>(
      `SELECT plan, plan_grace_ends_at, payment_failed_at, grace_locked_notified_at, cancel_at_period_end,
              plan_source
         FROM organizations WHERE id = $1`,
      [organizationId]
    );
    const current = before.rows[0];

    /*
     * A plan an operator set by hand (V76_admin_plan_override.sql) outranks a *dead* subscription,
     * and loses to a live one.
     *
     * The dead case is the one that bites: comping a churned workspace leaves plan = 'pro' next to
     * the id of their old, cancelled subscription. Any late-delivered customer.subscription.* event
     * for that corpse would otherwise land here, compute 'launch', and undo the grant — with a
     * "your plan was downgraded" email to the customer we were trying to win back.
     *
     * The live case is not a conflict at all: the customer is paying now, so Stripe becomes the
     * authority again and the override is cleared below rather than defended.
     */
    if (current?.plan_source === "admin" && ENDED_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      console.warn(
        `[billing] ignoring ${subscription.status} subscription ${subscription.id} for organization ${organizationId}: its plan was set by an admin and is not Stripe's to change`
      );
      return;
    }
    const wasPro = current?.plan === "pro";
    const droppingToLaunch = wasPro && plan === "launch";
    const wasCancelling = current?.cancel_at_period_end === true;
    const nowCancelling = subscription.cancel_at_period_end === true;

    /*
     * Grace window bookkeeping.
     *
     * Losing Pro: start a countdown (PLAN_GRACE_DAYS, default 30) during which the workspace keeps
     * Pro-sized limits. Nothing is deleted or archived — the workspace stays fully usable, and only
     * once the window closes do Launch limits start being enforced. An existing deadline is kept, so
     * repeated subscription.updated events can't keep pushing it back.
     *
     * Regaining Pro: clear the window, the dunning flag, and the lock notification. This is what
     * makes re-upgrading instantly restore everything — access is derived from these columns, so
     * clearing them is the whole "restore", with no data to move back.
     *
     * Computed here in JS rather than as conditional SQL. The previous version spliced different
     * expressions into the statement and reused $1 in both an assignment and a comparison, which
     * left Postgres unable to deduce a consistent parameter type ("inconsistent types deduced for
     * parameter $1") and made every customer.subscription.* webhook fail. Plain assignments with one
     * value per column can't reproduce that.
     */
    const graceDays = Math.max(0, this.config.planGraceDays);
    const graceEndsAt = droppingToLaunch
      ? (current?.plan_grace_ends_at ?? new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString())
      : plan === "pro"
        ? null
        : (current?.plan_grace_ends_at ?? null);

    await this.db.query(
      `UPDATE organizations
       SET plan = $1,
           billing_interval = COALESCE($2, billing_interval),
           stripe_subscription_id = $3,
           subscription_status = $4,
           current_period_end = $5,
           cancel_at_period_end = $6,
           billing_currency = COALESCE($7, billing_currency),
           plan_grace_ends_at = $8,
           payment_failed_at = $9,
           grace_locked_notified_at = $10,
           -- Stripe is speaking for a live subscription, so it is the authority again: any
           -- hand-set plan is stood down rather than left to fight the next webhook.
           plan_source = 'stripe',
           plan_override_by = NULL,
           plan_override_at = NULL,
           plan_override_reason = NULL,
           plan_override_expires_at = NULL,
           updated_at = now()
       WHERE id = $11`,
      [
        plan,
        billingInterval,
        subscription.id,
        subscription.status,
        periodEndSeconds ? new Date(periodEndSeconds * 1000).toISOString() : null,
        subscription.cancel_at_period_end ?? false,
        currency,
        graceEndsAt,
        plan === "pro" ? null : (current?.payment_failed_at ?? null),
        plan === "pro" ? null : (current?.grace_locked_notified_at ?? null),
        organizationId
      ]
    );

    // History entries, so the workspace can see what changed and when without reading Stripe.
    const intervalLabel = billingInterval ?? "";
    if (!wasPro && plan === "pro") {
      await this.recordBillingEvent(
        organizationId,
        "billing_upgraded",
        subscription.id,
        `Upgraded to Pro${intervalLabel ? ` (${intervalLabel})` : ""}`,
        { interval: billingInterval, currency, status: subscription.status }
      );
    } else if (droppingToLaunch) {
      await this.recordBillingEvent(
        organizationId,
        "billing_downgraded",
        subscription.id,
        `Subscription ${subscription.status === "canceled" ? "cancelled" : subscription.status} — moved to Launch`,
        { status: subscription.status, graceEndsAt, limitsApplyFrom: graceEndsAt }
      );
    }

    if (plan === "pro" && nowCancelling !== wasCancelling) {
      await this.recordBillingEvent(
        organizationId,
        nowCancelling ? "billing_cancel_scheduled" : "billing_cancel_reverted",
        subscription.id,
        nowCancelling
          ? `Cancellation scheduled${periodEndSeconds ? ` for ${this.formatDate(new Date(periodEndSeconds * 1000))}` : ""}`
          : "Cancellation reverted — subscription will renew",
        { cancelAtPeriodEnd: nowCancelling }
      );
    }

    if (droppingToLaunch) {
      const owner = await this.workspaceOwner(organizationId);
      if (owner) {
        await this.email.sendPlanDowngraded(
          owner.email,
          owner.workspaceName,
          graceEndsAt ? this.formatDate(new Date(graceEndsAt)) : null,
          this.billingUrl
        );
      }
    }
  }
}
