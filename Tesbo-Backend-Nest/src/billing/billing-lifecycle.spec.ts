import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import type Stripe from "stripe";
import type { EmailService } from "../auth/email.service";
import type { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import type { LegacyService } from "../legacy/legacy.service";
import type { PlanLimitsService } from "../plan-limits/plan-limits.service";
import { BillingService } from "./billing.service";
import type { CountryDetectionService } from "./country-detection.service";
import type { StripeClientProvider } from "./stripe-client.provider";

/**
 * DB double routing queries to `{ match, rows | handler }` rules by SQL substring (same style as
 * linear-integration.spec.ts / mcp.service.spec.ts). Unmatched queries return no rows.
 */
type Route = { match: string; rows?: Record<string, unknown>[]; handler?: (params: unknown[]) => { rows: Record<string, unknown>[] } };

function makeDb(routes: Route[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (sql.includes(route.match)) {
        return Promise.resolve(route.handler ? route.handler(params) : { rows: route.rows ?? [] });
      }
    }
    return Promise.resolve({ rows: [] });
  });
  return { db: { query } as unknown as DatabaseService, query, calls };
}

const PRICES = {
  usdMonthly: "price_usd_m",
  usdAnnual: "price_usd_a",
  inrMonthly: "price_inr_m",
  inrAnnual: "price_inr_a"
};

function makeConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    stripePriceIdProMonthly: PRICES.usdMonthly,
    stripePriceIdProAnnual: PRICES.usdAnnual,
    stripePriceIdProMonthlyInr: PRICES.inrMonthly,
    stripePriceIdProAnnualInr: PRICES.inrAnnual,
    frontendUrl: "https://app.example.com",
    supportContactEmail: "support@example.com",
    planGraceDays: 30,
    stripeWebhookSecret: "whsec_test",
    ...overrides
  } as unknown as AppConfigService;
}

/** Stripe double: prices resolve to fixed amounts; subscriptions/customers are caller-supplied. */
function makeStripe(
  opts: {
    subscriptions?: Array<Partial<Stripe.Subscription>>;
    customerCurrency?: string | null;
    /** Whether the customer has ever been invoiced — decides if a currency pin is binding. */
    invoiced?: boolean;
  } = {}
) {
  const created: Array<Record<string, unknown>> = [];
  const client = {
    invoices: {
      list: jest.fn(() => Promise.resolve({ data: opts.invoiced ? [{ id: "in_1" }] : [] }))
    },
    prices: {
      retrieve: jest.fn((id: string) => {
        const inr = id === PRICES.inrMonthly || id === PRICES.inrAnnual;
        const monthly = id === PRICES.usdMonthly || id === PRICES.inrMonthly;
        return Promise.resolve({
          id,
          currency: inr ? "inr" : "usd",
          unit_amount: inr ? (monthly ? 130000 : 1200000) : monthly ? 4000 : 36000
        });
      })
    },
    subscriptions: {
      list: jest.fn(() => Promise.resolve({ data: opts.subscriptions ?? [] })),
      update: jest.fn(() => Promise.resolve({}))
    },
    customers: {
      retrieve: jest.fn(() => Promise.resolve({ id: "cus_1", currency: opts.customerCurrency ?? null, deleted: false })),
      create: jest.fn(() => Promise.resolve({ id: "cus_new" }))
    },
    checkout: {
      sessions: {
        create: jest.fn((args: Record<string, unknown>) => {
          created.push(args);
          return Promise.resolve({ url: "https://checkout.example.com/s/1" });
        })
      }
    }
  };
  return { provider: { client } as unknown as StripeClientProvider, client, created };
}

function makeEmail() {
  return {
    sendPaymentFailed: jest.fn().mockResolvedValue(undefined),
    sendPaymentSucceeded: jest.fn().mockResolvedValue(undefined),
    sendPlanDowngraded: jest.fn().mockResolvedValue(undefined),
    sendGraceEnded: jest.fn().mockResolvedValue(undefined),
    sendStorageWarning: jest.fn().mockResolvedValue(undefined)
  } as unknown as EmailService & Record<string, jest.Mock>;
}

function build(opts: {
  routes?: Route[];
  isIndia?: boolean;
  subscriptions?: Array<Partial<Stripe.Subscription>>;
  customerCurrency?: string | null;
  invoiced?: boolean;
  role?: string;
  config?: Partial<AppConfigService>;
}) {
  const { db, query, calls } = makeDb(opts.routes ?? []);
  const stripe = makeStripe({ subscriptions: opts.subscriptions, customerCurrency: opts.customerCurrency, invoiced: opts.invoiced });
  const email = makeEmail();
  const legacy = {
    workspace: jest.fn().mockResolvedValue({ id: "org-1", name: "Acme", role: opts.role ?? "owner" }),
    normalizeRole: (r: string) => r,
    // Billing history writes go through here; the real one swallows its own errors.
    logWorkspaceActivity: jest.fn().mockResolvedValue(undefined)
  } as unknown as LegacyService;
  // Stands in for a hard IP match either way, which is what most of these tests care about; the
  // declared-country describe block below exercises the soft fallback path instead.
  const hard = opts.isIndia ? "IN" : "US";
  const countries = {
    resolve: jest.fn().mockResolvedValue({ country: hard, source: "ip", detected: hard })
  } as unknown as CountryDetectionService;
  const planLimits = {
    invalidateEntitlementCache: jest.fn().mockResolvedValue(undefined)
  } as unknown as PlanLimitsService;

  const service = new BillingService(db, makeConfig(opts.config), stripe.provider, legacy, planLimits, countries, email);
  return { service, query, calls, stripe, email };
}

const REQ = { ip: "1.2.3.4", headers: {} } as never;

describe("India pricing eligibility", () => {
  it("quotes INR and offers the toggle to a visitor detected in India", async () => {
    const { service } = build({ isIndia: true });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("inr");
    expect(pricing.monthlyAmount).toBe(130000);
    expect(pricing.inrAvailable).toBe(true);
  });

  it("quotes USD and hides the toggle for a visitor outside India", async () => {
    const { service } = build({ isIndia: false });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("usd");
    expect(pricing.inrAvailable).toBe(false);
  });

  // The anti-abuse gate: the INR list is materially cheaper, so a self-declared claim from outside
  // India must be refused rather than honoured.
  it("refuses an explicit INR request from outside India", async () => {
    const { service } = build({ isIndia: false });
    await expect(service.getPricing("user-1", REQ, "inr")).rejects.toThrow(ForbiddenException);
  });

  it("blocks checkout in INR from outside India", async () => {
    const { service } = build({ isIndia: false });
    await expect(service.createCheckoutSession("user-1", "annual", REQ, "inr")).rejects.toThrow(ForbiddenException);
  });

  it("lets a visitor in India opt out to USD", async () => {
    const { service } = build({ isIndia: true });
    const pricing = await service.getPricing("user-1", REQ, "usd");
    expect(pricing.currency).toBe("usd");
    // Still true, so the checkbox stays visible (just unticked) rather than vanishing.
    expect(pricing.inrAvailable).toBe(true);
  });

  it("rejects an unsupported currency instead of silently defaulting", async () => {
    const { service } = build({ isIndia: true });
    await expect(service.getPricing("user-1", REQ, "eur")).rejects.toThrow(BadRequestException);
  });

  it("charges the currency it quoted", async () => {
    const { service, stripe } = build({ isIndia: true });
    await service.createCheckoutSession("user-1", "monthly", REQ);
    expect(stripe.created[0].line_items).toEqual([{ price: PRICES.inrMonthly, quantity: 1 }]);
  });
});

describe("currency lock", () => {
  const lockedTo = (currency: string): Route[] => [
    { match: "SELECT billing_currency", rows: [{ billing_currency: currency, stripe_customer_id: "cus_1" }] },
    { match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: "cus_1" }] }
  ];

  it("keeps quoting INR even from outside India once locked", async () => {
    const { service } = build({ isIndia: false, routes: lockedTo("inr") });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("inr");
    expect(pricing.currencyLocked).toBe(true);
  });

  it("hides the India toggle when locked to USD, even for a visitor in India", async () => {
    const { service } = build({ isIndia: true, routes: lockedTo("usd") });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("usd");
    expect(pricing.inrAvailable).toBe(false);
  });

  // Without this, Stripe rejects the mismatched subscription with an opaque error at checkout.
  it("explains the conflict instead of letting Stripe fail cryptically", async () => {
    const { service } = build({ isIndia: true, routes: lockedTo("usd") });
    await expect(service.getPricing("user-1", REQ, "inr")).rejects.toThrow(ConflictException);
  });

  it("reads the lock from Stripe when not mirrored locally yet", async () => {
    const { service, query } = build({
      isIndia: false,
      customerCurrency: "inr",
      invoiced: true,
      routes: [
        { match: "SELECT billing_currency", rows: [{ billing_currency: null, stripe_customer_id: "cus_1" }] },
        { match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: "cus_1" }] }
      ]
    });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("inr");
    // And mirrors it so later calls skip the Stripe round trip.
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET billing_currency = $1"))).toBe(true);
  });
});

/**
 * Stripe pins Customer.currency when a Checkout Session is CREATED, not when it's paid. Treating that
 * as binding would permanently lock a workspace out of INR because someone once opened a USD checkout
 * page and closed it — with nothing ever charged. Regression cover for exactly that.
 */
describe("abandoned checkout must not lock the currency", () => {
  const withCustomer: Route[] = [
    { match: "SELECT billing_currency", rows: [{ billing_currency: null, stripe_customer_id: "cus_1" }] },
    { match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: "cus_1" }] }
  ];

  it("still offers INR to a visitor in India when the pin came from an unpaid checkout", async () => {
    const { service } = build({ isIndia: true, customerCurrency: "usd", invoiced: false, routes: withCustomer });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("inr");
    expect(pricing.inrAvailable).toBe(true);
    expect(pricing.currencyLocked).toBe(false);
  });

  it("does not mirror an unpaid pin into the database", async () => {
    const { service, query } = build({ isIndia: true, customerCurrency: "usd", invoiced: false, routes: withCustomer });
    await service.getPricing("user-1", REQ);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET billing_currency = $1"))).toBe(false);
  });

  it("locks once the customer has actually been invoiced", async () => {
    const { service } = build({ isIndia: true, customerCurrency: "usd", invoiced: true, routes: withCustomer });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("usd");
    expect(pricing.currencyLocked).toBe(true);
  });

  it("swaps in a fresh customer at checkout rather than letting Stripe reject the purchase", async () => {
    const { service, stripe, query } = build({
      isIndia: true,
      customerCurrency: "usd",
      invoiced: false,
      routes: withCustomer
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await service.createCheckoutSession("user-1", "monthly", REQ);

    expect(stripe.client.customers.create).toHaveBeenCalled();
    expect(stripe.created[0].customer).toBe("cus_new");
    // Charged in INR on the new customer, which is the whole point.
    expect(stripe.created[0].line_items).toEqual([{ price: PRICES.inrMonthly, quantity: 1 }]);
    // Mirrored currency cleared alongside the swap so the lock re-derives from the new customer.
    expect(query.mock.calls.some(([sql]) => String(sql).includes("billing_currency = NULL"))).toBe(true);
    warn.mockRestore();
  });

  it("keeps a customer that has real billing history instead of orphaning its invoices", async () => {
    const { service, stripe } = build({
      isIndia: true,
      customerCurrency: "inr",
      invoiced: true,
      routes: withCustomer
    });
    await service.createCheckoutSession("user-1", "monthly", REQ);
    expect(stripe.client.customers.create).not.toHaveBeenCalled();
    expect(stripe.created[0].customer).toBe("cus_1");
  });
});

describe("double subscription guard", () => {
  const customerRoute: Route[] = [{ match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: "cus_1" }] }];

  it.each(["active", "trialing", "past_due", "unpaid", "incomplete"])(
    "refuses a second checkout while a %s subscription exists",
    async (status) => {
      const { service, stripe } = build({ routes: customerRoute, subscriptions: [{ id: "sub_1", status } as Partial<Stripe.Subscription>] });
      await expect(service.createCheckoutSession("user-1", "monthly", REQ)).rejects.toThrow(ConflictException);
      expect(stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
    }
  );

  it.each(["canceled", "incomplete_expired"])("allows resubscribing after a %s subscription", async (status) => {
    const { service, stripe } = build({ routes: customerRoute, subscriptions: [{ id: "sub_1", status } as Partial<Stripe.Subscription>] });
    await expect(service.createCheckoutSession("user-1", "monthly", REQ)).resolves.toEqual({
      url: "https://checkout.example.com/s/1"
    });
    expect(stripe.client.checkout.sessions.create).toHaveBeenCalled();
  });

  // The guard asks Stripe, not our own `plan` column, precisely because the column lags the webhook.
  it("catches a subscription Stripe already has but our plan column doesn't reflect yet", async () => {
    const { service } = build({
      routes: [...customerRoute, { match: "SELECT plan", rows: [{ plan: "launch" }] }],
      subscriptions: [{ id: "sub_1", status: "active" } as Partial<Stripe.Subscription>]
    });
    await expect(service.createCheckoutSession("user-1", "monthly", REQ)).rejects.toThrow(ConflictException);
  });
});

/**
 * The declared country is a SOFT signal: it must rescue a genuine Indian customer when hard
 * detection yields nothing, without ever letting a self-report beat a hard signal that disagrees.
 */
describe("declared country (soft signal)", () => {
  const declared = (code: string | null): Route[] => [{ match: "SELECT country FROM organizations", rows: [{ country: code }] }];

  // Real country detection, so "hard signal absent" means absent rather than stubbed.
  function withRealDetection(opts: { ip?: string; declaredCountry: string | null }) {
    const { db } = makeDb(declared(opts.declaredCountry));
    const stripe = makeStripe();
    const legacy = {
      workspace: jest.fn().mockResolvedValue({ id: "org-1", name: "Acme", role: "owner" }),
      normalizeRole: (r: string) => r
    } as unknown as LegacyService;
    // Stands in for CountryDetectionService with no override and header trust off: a private IP
    // yields nothing hard, so only the declared value is left.
    const countries = {
      resolve: jest.fn(async (_req: unknown, declaredCountry?: string | null) => {
        const hard = opts.ip === "public-in" ? "IN" : opts.ip === "public-us" ? "US" : null;
        if (hard) return { country: hard, source: "ip" as const, detected: hard };
        const soft = (declaredCountry ?? "").toUpperCase();
        return /^[A-Z]{2}$/.test(soft)
          ? { country: soft, source: "declared" as const, detected: null }
          : { country: null, source: "unknown" as const, detected: null };
      })
    } as unknown as CountryDetectionService;
    const service = new BillingService(db, makeConfig(), stripe.provider, legacy, {} as PlanLimitsService, countries, makeEmail());
    return { service };
  }

  it("quotes INR when detection fails but the workspace declared India", async () => {
    const { service } = withRealDetection({ declaredCountry: "IN" });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("inr");
    expect(pricing.inrAvailable).toBe(true);
    // Flagged as the soft path so support can tell it apart from a hard match.
    expect(pricing.countrySource).toBe("declared");
  });

  it("stays on USD when detection fails and nothing was declared", async () => {
    const { service } = withRealDetection({ declaredCountry: null });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("usd");
    expect(pricing.inrAvailable).toBe(false);
    expect(pricing.countrySource).toBe("unknown");
  });

  // The important one: a self-report must not override a contradicting hard signal.
  it("ignores a declared IN when the IP says otherwise", async () => {
    const { service } = withRealDetection({ ip: "public-us", declaredCountry: "IN" });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("usd");
    expect(pricing.inrAvailable).toBe(false);
    expect(pricing.countrySource).toBe("ip");
  });

  it("still quotes INR on a hard India match even if the workspace declared elsewhere", async () => {
    const { service } = withRealDetection({ ip: "public-in", declaredCountry: "US" });
    const pricing = await service.getPricing("user-1", REQ);
    expect(pricing.currency).toBe("inr");
    expect(pricing.countrySource).toBe("ip");
  });

  it("records the detected country so declared/detected disagreement is reviewable", async () => {
    const { db, query } = makeDb(declared("IN"));
    const stripe = makeStripe();
    const legacy = {
      workspace: jest.fn().mockResolvedValue({ id: "org-1", name: "Acme", role: "owner" }),
      normalizeRole: (r: string) => r
    } as unknown as LegacyService;
    const countries = {
      resolve: jest.fn().mockResolvedValue({ country: "US", source: "ip", detected: "US" })
    } as unknown as CountryDetectionService;
    const service = new BillingService(db, makeConfig(), stripe.provider, legacy, {} as PlanLimitsService, countries, makeEmail());

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await service.getPricing("user-1", REQ);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET last_detected_country"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("country mismatch"));
    warn.mockRestore();
  });
});

/**
 * A real incident: a customer paid ₹1,300, Stripe had an active subscription, but the workspace sat on
 * the free plan because no live webhook endpoint was registered so `checkout.session.completed` never
 * arrived. Loading the billing page must recover from that on its own.
 */
describe("reconcile a workspace whose plan drifted from Stripe", () => {
  const stuck: Route[] = [
    // Under-provisioned shape: free plan, has a customer, no subscription recorded.
    {
      match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
      rows: [{ plan: "launch", stripe_customer_id: "cus_1", stripe_subscription_id: null }]
    },
    { match: "SELECT plan, plan_grace_ends_at", rows: [{ plan: "launch", plan_grace_ends_at: null }] },
    {
      match: "SELECT plan, billing_interval",
      rows: [{ plan: "pro", billing_interval: "monthly", subscription_status: "active" }]
    }
  ];

  const activeSub = {
    id: "sub_1",
    status: "active",
    metadata: { organizationId: "org-1" },
    items: { data: [{ price: { id: PRICES.inrMonthly, currency: "inr" }, current_period_end: 1800000000 }] },
    cancel_at_period_end: false
  } as unknown as Stripe.Subscription;

  it("activates Pro from the live Stripe subscription", async () => {
    const { service, query } = build({ routes: stuck, subscriptions: [activeSub] });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const info = await service.getBillingInfo("user-1");

    const applied = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE organizations") && String(sql).includes("SET plan ="));
    expect(applied).toBeDefined();
    expect(applied?.[1]?.[0]).toBe("pro");
    expect(applied?.[1]?.[2]).toBe("sub_1");
    // Loudly flagged, because the underlying cause is a missing webhook endpoint that needs fixing.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("checkout webhook never arrived"));
    expect(info.plan).toBe("pro");
    warn.mockRestore();
  });

  it("does nothing when Stripe has no billable subscription", async () => {
    const { service, query } = build({ routes: stuck, subscriptions: [{ id: "sub_x", status: "canceled" } as Partial<Stripe.Subscription>] });
    await service.getBillingInfo("user-1");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET plan ="))).toBe(false);
  });

  it("skips the Stripe call entirely for workspaces that aren't adrift", async () => {
    // Free plan with no Stripe customer at all — the common case, neither direction applies.
    const { service, stripe } = build({
      routes: [
        {
          match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
          rows: [{ plan: "launch", stripe_customer_id: null, stripe_subscription_id: null }]
        }
      ],
      subscriptions: [activeSub]
    });
    await service.getBillingInfo("user-1");
    expect(stripe.client.subscriptions.list).not.toHaveBeenCalled();
  });

  /*
   * The expensive drift: a cancellation webhook that never landed leaves a cancelled customer on Pro
   * indefinitely. Observed in production when the destination pointed at a host not yet serving the
   * billing routes.
   */
  it("downgrades when the recorded subscription is cancelled in Stripe", async () => {
    const onPro: Route[] = [
      {
        match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
        rows: [{ plan: "pro", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" }]
      },
      { match: "SELECT plan, plan_grace_ends_at, payment_failed_at", rows: [{ plan: "pro", plan_grace_ends_at: null }] },
      { match: "SELECT plan, billing_interval", rows: [{ plan: "launch" }] },
      // workspaceOwner(): without this the downgrade email has no recipient and is skipped.
      { match: "FROM organization_members m", rows: [{ email: "owner@example.com", name: "Acme" }] }
    ];
    const { service, stripe, query, email } = build({ routes: onPro });
    (stripe.client.subscriptions as unknown as { retrieve: jest.Mock }).retrieve = jest
      .fn()
      .mockResolvedValue({ ...activeSub, status: "canceled" });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await service.getBillingInfo("user-1");

    const applied = query.mock.calls.find(([sql]) => String(sql).includes("SET plan ="));
    expect(applied?.[1]?.[0]).toBe("launch");
    // Grace window opened rather than limits applied immediately, and the owner told.
    expect(applied?.[1]?.[7]).toBeTruthy();
    expect((email as unknown as Record<string, jest.Mock>).sendPlanDowngraded).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves Pro alone while the recorded subscription is still active", async () => {
    const onPro: Route[] = [
      {
        match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
        rows: [{ plan: "pro", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" }]
      }
    ];
    const { service, query, stripe } = build({ routes: onPro });
    (stripe.client.subscriptions as unknown as { retrieve: jest.Mock }).retrieve = jest.fn().mockResolvedValue(activeSub);
    await service.getBillingInfo("user-1");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET plan ="))).toBe(false);
  });

  // A transient Stripe error must never be read as "subscription gone" and downgrade a payer.
  it("never downgrades a paying customer when Stripe errors", async () => {
    const onPro: Route[] = [
      {
        match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
        rows: [{ plan: "pro", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" }]
      }
    ];
    const { service, query, stripe } = build({ routes: onPro });
    (stripe.client.subscriptions as unknown as { retrieve: jest.Mock }).retrieve = jest
      .fn()
      .mockRejectedValue(new Error("stripe unavailable"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(service.getBillingInfo("user-1")).resolves.toBeDefined();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET plan ="))).toBe(false);
    err.mockRestore();
  });

  it("still renders the billing page when Stripe is unreachable", async () => {
    const { service, stripe } = build({ routes: stuck });
    (stripe.client.subscriptions.list as jest.Mock).mockRejectedValueOnce(new Error("network down"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(service.getBillingInfo("user-1")).resolves.toBeDefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("could not reconcile"), expect.anything());
    err.mockRestore();
  });
});

/*
 * Plans an operator set by hand from the admin panel (V76_admin_plan_override.sql).
 *
 * Stripe is not the authority for these workspaces, and the reason that matters is narrow: comping
 * a churned customer leaves plan='pro' next to the id of the cancelled subscription that churned
 * them. Every "over-provisioned" check in this service reads that shape as drift to be undone.
 */
describe("admin-granted plans", () => {
  const grantedPro: Route[] = [
    {
      match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
      rows: [{ plan: "pro", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_dead", plan_source: "admin" }]
    },
    { match: "SELECT plan, billing_interval", rows: [{ plan: "pro" }] }
  ];

  it("is never reconciled against Stripe", async () => {
    const { service, query, stripe } = build({ routes: grantedPro });
    // Without a retrieve() the reconcile path would throw and be swallowed, so the absence of a
    // plan write would prove nothing. Supplying one that reports the subscription as cancelled
    // makes this the exact shape reconcile downgrades — the guard is the only thing stopping it.
    const retrieve = jest.fn().mockResolvedValue({
      id: "sub_dead",
      status: "canceled",
      metadata: { organizationId: "org-1" },
      items: { data: [{ price: { id: PRICES.usdMonthly, currency: "usd" }, current_period_end: 1800000000 }] },
      cancel_at_period_end: false
    });
    (stripe.client.subscriptions as unknown as { retrieve: jest.Mock }).retrieve = retrieve;

    await service.getBillingInfo("user-1");

    expect(retrieve).not.toHaveBeenCalled();
    expect(stripe.client.subscriptions.list).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET plan ="))).toBe(false);
  });

  it("survives a late webhook for the subscription that churned them", async () => {
    const { service, query, email } = build({
      routes: [
        {
          match: "SELECT plan, plan_grace_ends_at, payment_failed_at",
          rows: [{ plan: "pro", plan_grace_ends_at: null, plan_source: "admin" }]
        },
        { match: "INSERT INTO stripe_webhook_events", rows: [{ id: "evt_1" }] }
      ]
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await service.handleWebhookEvent({
      id: "evt_1",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_dead",
          status: "canceled",
          metadata: { organizationId: "org-1" },
          items: { data: [{ price: { id: PRICES.usdMonthly, currency: "usd" }, current_period_end: 1800000000 }] },
          cancel_at_period_end: false
        }
      }
    } as unknown as Stripe.Event);

    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET plan ="))).toBe(false);
    // The customer we are trying to win back must not be emailed about losing a plan we gave them.
    expect((email as unknown as Record<string, jest.Mock>).sendPlanDowngraded).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stands down the moment the customer actually subscribes", async () => {
    const { service, query } = build({
      routes: [
        {
          match: "SELECT plan, plan_grace_ends_at, payment_failed_at",
          rows: [{ plan: "pro", plan_grace_ends_at: null, plan_source: "admin" }]
        },
        { match: "INSERT INTO stripe_webhook_events", rows: [{ id: "evt_2" }] }
      ]
    });

    await service.handleWebhookEvent({
      id: "evt_2",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_live",
          status: "active",
          metadata: { organizationId: "org-1" },
          items: { data: [{ price: { id: PRICES.usdMonthly, currency: "usd" }, current_period_end: 1800000000 }] },
          cancel_at_period_end: false
        }
      }
    } as unknown as Stripe.Event);

    const applied = query.mock.calls.find(([sql]) => String(sql).includes("SET plan ="));
    expect(applied?.[1]?.[0]).toBe("pro");
    expect(String(applied?.[0])).toContain("plan_source = 'stripe'");
    expect(String(applied?.[0])).toContain("plan_override_by = NULL");
  });

  it("hands the plan back to Stripe at checkout, without waiting for a second webhook", async () => {
    const { service, query } = build({
      routes: [
        { match: "INSERT INTO stripe_webhook_events", rows: [{ id: "evt_3" }] },
        { match: "SELECT plan FROM organizations", rows: [{ plan: "pro" }] }
      ]
    });

    await service.handleWebhookEvent({
      id: "evt_3",
      type: "checkout.session.completed",
      data: { object: { metadata: { organizationId: "org-1" }, subscription: "sub_new", amount_total: 4000, currency: "usd" } }
    } as unknown as Stripe.Event);

    const applied = query.mock.calls.find(([sql]) => String(sql).includes("SET plan = 'pro'"));
    expect(applied).toBeDefined();
    expect(String(applied?.[0])).toContain("plan_source = 'stripe'");
  });
});

describe("billing history", () => {
  const onPro = (from: string): Route[] => [
    {
      match: "SELECT plan, stripe_customer_id, stripe_subscription_id",
      rows: [{ plan: from, stripe_customer_id: "cus_1", stripe_subscription_id: from === "pro" ? "sub_1" : null }]
    },
    { match: "SELECT plan, plan_grace_ends_at, payment_failed_at", rows: [{ plan: from, plan_grace_ends_at: null }] },
    { match: "FROM organization_members m", rows: [{ email: "owner@example.com", name: "Acme" }] }
  ];

  const sub = (status: string) =>
    ({
      id: "sub_1",
      status,
      metadata: { organizationId: "org-1" },
      items: { data: [{ price: { id: PRICES.inrMonthly, currency: "inr" }, current_period_end: 1800000000 }] },
      cancel_at_period_end: false
    }) as unknown as Stripe.Subscription;

  function logCalls(legacyMock: unknown) {
    return (legacyMock as { logWorkspaceActivity: jest.Mock }).logWorkspaceActivity.mock.calls;
  }

  it("records an upgrade", async () => {
    const { service, stripe } = build({ routes: onPro("launch") });
    (stripe.client.subscriptions.list as jest.Mock).mockResolvedValue({ data: [sub("active")] });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await service.getBillingInfo("user-1");
     
    const legacyMock = (service as any).legacy;
    const actions = logCalls(legacyMock).map((c) => c[2]);
    expect(actions).toContain("billing_upgraded");
    warn.mockRestore();
  });

  it("records a downgrade with the date limits start applying", async () => {
    const { service, stripe } = build({ routes: onPro("pro") });
    (stripe.client.subscriptions as unknown as { retrieve: jest.Mock }).retrieve = jest.fn().mockResolvedValue(sub("canceled"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await service.getBillingInfo("user-1");
     
    const entry = logCalls((service as any).legacy).find((c) => c[2] === "billing_downgraded");
    expect(entry).toBeDefined();
    expect(entry?.[6]).toMatchObject({ status: "canceled" });
    expect((entry?.[6] as Record<string, unknown>).graceEndsAt).toBeTruthy();
    warn.mockRestore();
  });

  it("returns history newest-first for the workspace only", async () => {
    const { service, calls } = build({
      routes: [
        {
          match: "FROM audit_logs",
          rows: [
            { action: "billing_downgraded", entity_name: "Moved to Launch", diff: {}, created_at: "2026-07-29T00:00:00Z" },
            { action: "billing_upgraded", entity_name: "Upgraded to Pro", diff: {}, created_at: "2026-07-01T00:00:00Z" }
          ]
        }
      ]
    });
    const history = await service.getBillingHistory("user-1");
    expect(history.map((h) => h.action)).toEqual(["billing_downgraded", "billing_upgraded"]);
    const sql = calls.find((c) => c.sql.includes("FROM audit_logs"));
    expect(sql?.sql).toContain("organization_id = $1");
    expect(sql?.sql).toContain("entity_type = 'billing'");
  });

  it("caps the history limit so a caller can't request the whole table", async () => {
    const { service, calls } = build({ routes: [{ match: "FROM audit_logs", rows: [] }] });
    await service.getBillingHistory("user-1", 100000);
    expect(calls.find((c) => c.sql.includes("FROM audit_logs"))?.params[1]).toBe(200);
  });
});

describe("invoices", () => {
  it("returns hosted links and skips drafts", async () => {
    const { service, stripe } = build({ routes: [{ match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: "cus_1" }] }] });
    (stripe.client.invoices.list as jest.Mock).mockResolvedValue({
      data: [
        { id: "in_1", number: "T-001", status: "paid", amount_paid: 130000, amount_due: 130000, currency: "inr", created: 1785326719, hosted_invoice_url: "https://inv", invoice_pdf: "https://pdf" },
        { id: "in_draft", status: "draft", amount_paid: 0, amount_due: 130000, currency: "inr", created: 1785326720 }
      ]
    });
    const invoices = await service.getInvoices("user-1");
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ number: "T-001", status: "paid", amountPaid: 130000, currency: "inr", hostedInvoiceUrl: "https://inv" });
  });

  it("returns nothing rather than calling Stripe when the workspace has no customer", async () => {
    const { service, stripe } = build({ routes: [] });
    await expect(service.getInvoices("user-1")).resolves.toEqual([]);
    expect(stripe.client.invoices.list).not.toHaveBeenCalled();
  });
});

describe("owner-only billing", () => {
  it("refuses checkout for a non-owner", async () => {
    const { service } = build({ role: "manager" });
    await expect(service.createCheckoutSession("user-1", "monthly", REQ)).rejects.toThrow(ForbiddenException);
  });
});

/**
 * Subscriptions are per WORKSPACE, not per user: one person can own several workspaces and each is
 * billed independently. Every billing read and write must therefore be scoped to the caller's active
 * workspace, so acting on one can never move another's plan, currency, or grace window.
 */
describe("per-workspace isolation", () => {
  function forWorkspace(orgId: string, routes: Route[]) {
    const { db, query, calls } = makeDb(routes);
    const stripe = makeStripe();
    const legacy = {
      workspace: jest.fn().mockResolvedValue({ id: orgId, name: orgId, role: "owner" }),
      normalizeRole: (r: string) => r,
      logWorkspaceActivity: jest.fn().mockResolvedValue(undefined)
    } as unknown as LegacyService;
    const countries = {
      resolve: jest.fn().mockResolvedValue({ country: "IN", source: "ip", detected: "IN" })
    } as unknown as CountryDetectionService;
    const service = new BillingService(db, makeConfig(), stripe.provider, legacy, {} as PlanLimitsService, countries, makeEmail());
    return { service, query, calls, stripe };
  }

  const orgRow = (plan: string, currency: string | null, customer: string | null) => [
    { match: "SELECT plan, billing_interval", rows: [{ plan, subscription_status: "active", billing_currency: currency }] },
    { match: "SELECT plan, stripe_customer_id, stripe_subscription_id", rows: [{ plan, stripe_customer_id: customer, stripe_subscription_id: null }] },
    { match: "SELECT billing_currency", rows: [{ billing_currency: currency, stripe_customer_id: customer }] },
    { match: "SELECT country FROM organizations", rows: [{ country: null }] },
    { match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: customer }] },
    { match: "FROM audit_logs", rows: [] }
  ];

  it("scopes every billing read to the caller's active workspace", async () => {
    for (const orgId of ["org-A", "org-B"]) {
      const { service, calls } = forWorkspace(orgId, orgRow("launch", null, null));
      await service.getBillingInfo("user-1");
      await service.getBillingHistory("user-1");
      const scoped = calls.filter((c) => c.params.includes(orgId));
      expect(scoped.length).toBeGreaterThan(0);
      // Nothing may reference the other workspace.
      const other = orgId === "org-A" ? "org-B" : "org-A";
      expect(calls.some((c) => c.params.includes(other))).toBe(false);
    }
  });

  it("keeps each workspace's currency lock independent", async () => {
    // Workspace A pinned to INR by a past invoice; workspace B still open.
    const a = forWorkspace("org-A", orgRow("pro", "inr", "cus_A"));
    const b = forWorkspace("org-B", orgRow("launch", null, null));
    expect((await a.service.getPricing("user-1", REQ)).currency).toBe("inr");
    expect((await a.service.getPricing("user-1", REQ)).currencyLocked).toBe(true);
    const bPricing = await b.service.getPricing("user-1", REQ);
    expect(bPricing.currencyLocked).toBe(false);
  });

  it("filters billing history by organization", async () => {
    const { service, calls } = forWorkspace("org-A", orgRow("launch", null, null));
    await service.getBillingHistory("user-1");
    const q = calls.find((c) => c.sql.includes("FROM audit_logs"));
    expect(q?.sql).toContain("organization_id = $1");
    expect(q?.params[0]).toBe("org-A");
  });

  it("gives each workspace its own Stripe customer", async () => {
    // org-B has no customer yet, so checkout must create a fresh one rather than reuse another's.
    const { service, stripe } = forWorkspace("org-B", [
      { match: "SELECT plan, billing_interval", rows: [{ plan: "launch" }] },
      { match: "SELECT billing_currency", rows: [{ billing_currency: null, stripe_customer_id: null }] },
      { match: "SELECT country FROM organizations", rows: [{ country: null }] },
      { match: "SELECT stripe_customer_id", rows: [{ stripe_customer_id: null }] },
      { match: "SELECT plan, stripe_customer_id, stripe_subscription_id", rows: [{ plan: "launch", stripe_customer_id: null, stripe_subscription_id: null }] }
    ]);
    await service.createCheckoutSession("user-1", "monthly", REQ);
    expect(stripe.client.customers.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { organizationId: "org-B" } }));
  });
});
