"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createPortalSession,
  getBillingHistory,
  getBillingInfo,
  getBillingInvoices,
  getBillingUsage,
  reconcileBilling,
  type BillingHistoryEntry,
  type BillingInfo,
  type BillingInvoice,
  type PlanUsageSummary,
} from "@/lib/api";
import { Button, Card, PageLoader } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import PricingModal from "@/components/PricingModal";
import { useAppData } from "@/components/app/AppDataProvider";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** Minor units (paise / cents) to a display string, matching the currency actually charged. */
function formatMoney(amountMinor: number, currency: string): string {
  const upper = (currency || "usd").toUpperCase();
  const symbol = upper === "INR" ? "₹" : upper === "USD" ? "$" : "";
  const major = amountMinor / 100;
  const formatted = new Intl.NumberFormat(upper === "INR" ? "en-IN" : "en-US", {
    maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
  }).format(major);
  return symbol ? `${symbol}${formatted}` : `${formatted} ${upper}`;
}

// Colour-codes the timeline so money-in, money-failed and plan loss are scannable at a glance.
const HISTORY_DOT: Record<string, string> = {
  billing_upgraded: "bg-[var(--success)]",
  billing_payment_succeeded: "bg-[var(--success)]",
  billing_cancel_reverted: "bg-[var(--success)]",
  billing_payment_failed: "bg-[var(--error)]",
  billing_downgraded: "bg-[var(--warning)]",
  billing_cancel_scheduled: "bg-[var(--warning)]",
  billing_limits_enforced: "bg-[var(--error)]",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function UsageBar({ label, used, limit, usedLabel, limitLabel }: {
  label: string;
  used: number;
  limit: number | null;
  usedLabel: string;
  limitLabel: string;
}) {
  const pct = limit == null ? 0 : Math.min(100, (used / limit) * 100);
  const barColor = limit == null ? "" : pct >= 100 ? "bg-[var(--error)]" : pct >= 80 ? "bg-[var(--warning)]" : "bg-[var(--brand-primary)]";

  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium text-[var(--foreground)]">{label}</span>
        <span className="text-[var(--muted-soft)]">
          {usedLabel} {limit == null ? "· unlimited" : `/ ${limitLabel}`}
        </span>
      </div>
      {limit != null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)]">
          <div className={cx("h-full rounded-full transition-[width]", barColor)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function BillingTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspace } = useAppData();
  const [loading, setLoading] = useState(true);
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [usage, setUsage] = useState<PlanUsageSummary | null>(null);
  const [history, setHistory] = useState<BillingHistoryEntry[]>([]);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  const isOwner = (workspace?.role || "").toLowerCase() === "owner";

  const load = useCallback(async () => {
    try {
      const [billing, usageSummary] = await Promise.all([getBillingInfo(), getBillingUsage()]);
      setBillingInfo(billing);
      setUsage(usageSummary);
      // Secondary panels: a failure here shouldn't blank the plan card above it, so they settle
      // independently and simply stay empty if Stripe or the history query is unavailable.
      getBillingHistory().then(setHistory).catch(() => setHistory([]));
      getBillingInvoices().then(setInvoices).catch(() => setInvoices([]));
    } catch (e) {
      setError((e as Error).message || "Failed to load billing information");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4500);
  }

  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (!checkout) return;
    if (checkout === "success") {
      // Reconcile against Stripe rather than trusting the redirect: the plan only flips when a
      // webhook lands, and the webhook may be late, dropped, or not configured. This also means the
      // toast reports what actually happened instead of always claiming success.
      reconcileBilling()
        .then((info) => {
          setBillingInfo(info);
          showToast(
            info.plan === "pro"
              ? "You're on Tesbo Pro. Welcome aboard!"
              : "Payment received — we're still activating your plan. Refresh in a moment."
          );
        })
        .catch(() => showToast("Payment received — we're still activating your plan. Refresh in a moment."))
        .finally(() => {
          getBillingUsage().then(setUsage).catch(() => {});
        });
    } else if (checkout === "cancelled") {
      showToast("Checkout was cancelled — no changes were made.");
    }
    router.replace("/settings?tab=billing", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function formatShortDate(iso: string | null): string {
    return iso ? formatDate(iso) : "";
  }

  async function handleManageBilling() {
    setError("");
    setRedirecting(true);
    try {
      const { url } = await createPortalSession();
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message || "Failed to open billing portal");
      setRedirecting(false);
    }
  }

  if (loading) {
    return <PageLoader />;
  }

  const plan = billingInfo?.plan ?? "launch";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">Billing</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Tesbo Cloud plan for this workspace — billed per workspace, with unlimited team members.
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-[var(--radius-control)] bg-[var(--toast-surface)] px-4 py-2.5 text-sm text-[var(--toast-foreground)] shadow-lg">
          {toast}
        </div>
      )}

      {/* Payment is failing and Stripe is still retrying. Pro access continues for now, so this is
          the one screen that can recover the payment before it lapses — make it impossible to miss. */}
      {billingInfo?.paymentFailedAt && plan === "pro" && (
        <div className="rounded-[10px] border border-[var(--error)] bg-[var(--error-soft)] p-4">
          <p className="text-[13px] font-semibold text-[var(--error-foreground)]">We couldn&apos;t process your last payment</p>
          <p className="mt-1 text-[13px] text-[var(--ink-600)]">
            Your card was declined on {formatShortDate(billingInfo.paymentFailedAt)}. Pro access continues while we retry, but the
            workspace will move to the free Launch plan if the payment can&apos;t be collected.
          </p>
          {isOwner && (
            <Button className="mt-3" onClick={handleManageBilling} disabled={redirecting}>
              {redirecting ? "Opening…" : "Update payment method"}
            </Button>
          )}
        </div>
      )}

      {/* Downgraded but still inside the grace window: full access, with a clear deadline. */}
      {billingInfo?.inGracePeriod && (
        <div className="rounded-[10px] border border-[var(--warning)] bg-[var(--warning-soft)] p-4">
          <p className="text-[13px] font-semibold text-[var(--warning-foreground)]">
            Your Pro subscription has ended — full access until {formatShortDate(billingInfo.graceEndsAt)}
          </p>
          <p className="mt-1 text-[13px] text-[var(--ink-600)]">
            Nothing has been deleted and everything still works as before. After {formatShortDate(billingInfo.graceEndsAt)}, Launch
            limits apply: projects beyond the first two become read-only and new uploads pause until you&apos;re under 500 MB.
          </p>
          {isOwner && (
            <Button className="mt-3" onClick={() => setPricingOpen(true)}>
              Resubscribe to Pro
            </Button>
          )}
        </div>
      )}

      {/* Grace window closed — limits are actively applied. Lead with "your data is safe". */}
      {billingInfo?.limitsEnforced && (
        <div className="rounded-[10px] border border-[var(--error)] bg-[var(--error-soft)] p-4">
          <p className="text-[13px] font-semibold text-[var(--error-foreground)]">Launch plan limits are now in effect</p>
          <p className="mt-1 text-[13px] text-[var(--ink-600)]">
            <strong>Your data is safe — nothing has been deleted.</strong> Projects beyond the first two are read-only and new uploads
            are paused. Upgrading restores full access immediately; you can also archive a project to free a slot.
          </p>
          {isOwner && (
            <Button className="mt-3" onClick={() => setPricingOpen(true)}>
              Upgrade to Pro
            </Button>
          )}
        </div>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--accent-light)]">
                {plan === "pro" ? "Pro" : "Launch"}
              </span>
              {billingInfo?.cancelAtPeriodEnd && billingInfo.currentPeriodEnd && (
                <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--warning-foreground)]">
                  Cancels {formatDate(billingInfo.currentPeriodEnd)}
                </span>
              )}
            </div>
            <p className="mt-1 text-[13px] text-[var(--muted-soft)]">
              {plan === "pro"
                ? billingInfo?.currentPeriodEnd
                  ? `Renews ${formatDate(billingInfo.currentPeriodEnd)}${
                      billingInfo.billingInterval ? ` · billed ${billingInfo.billingInterval}` : ""
                    }`
                  : "Unlimited projects, 5GB storage, and the full agent marketplace."
                : "Free forever — up to 2 projects and 500MB storage, with unlimited team members."}
            </p>
          </div>

          <div className="flex gap-2">
            {isOwner && plan === "pro" && (
              <Button variant="secondary" onClick={handleManageBilling} disabled={redirecting}>
                {redirecting ? "Opening…" : "Manage billing"}
              </Button>
            )}
            {isOwner && plan === "launch" && <Button onClick={() => setPricingOpen(true)}>Upgrade to Pro</Button>}
          </div>
        </div>

        {!isOwner && (
          <p className="mt-4 text-[13px] text-[var(--muted-soft)]">
            Contact your workspace owner to change plans or manage billing.
          </p>
        )}

        {error && <p className="mt-4 text-[13px] text-[var(--error-foreground)]">{error}</p>}
      </Card>

      {usage && (
        <Card className="p-5">
          <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">Usage</h3>
          <div className="space-y-4">
            <UsageBar
              label="Projects"
              used={usage.projectCount}
              limit={usage.projectLimit}
              usedLabel={String(usage.projectCount)}
              limitLabel={String(usage.projectLimit)}
            />
            <UsageBar
              label="Storage"
              used={usage.storageUsedBytes}
              limit={usage.storageLimitBytes}
              usedLabel={formatBytes(usage.storageUsedBytes)}
              limitLabel={formatBytes(usage.storageLimitBytes)}
            />
          </div>
          {(() => {
            const storagePct = usage.storageLimitBytes > 0 ? (usage.storageUsedBytes / usage.storageLimitBytes) * 100 : 0;
            const atProjectLimit = usage.projectCount >= (usage.projectLimit ?? Infinity);
            // The limits in force are Pro-sized during a grace window, so key the messaging off the
            // effective plan rather than the billed one.
            const onProLimits = usage.plan === "pro" || usage.inGracePeriod;

            // Storage is the case a Pro customer can actually hit, and "upgrade" is no answer for
            // them — previously they got a red bar and no next step at all.
            if (storagePct >= 80) {
              return (
                <p className="mt-4 text-[13px] text-[var(--warning-foreground)]">
                  {storagePct >= 100
                    ? "Your workspace is out of storage — new uploads are blocked until you free space."
                    : `Your workspace is at ${Math.floor(storagePct)}% of its storage limit.`}{" "}
                  {onProLimits ? (
                    <>
                      You&apos;re on our largest plan, so{" "}
                      <a
                        href={`mailto:${usage.supportContactEmail}?subject=${encodeURIComponent("More storage for my Tesbo workspace")}`}
                        className="font-medium underline"
                      >
                        contact us
                      </a>{" "}
                      to add more, or delete large knowledge-base files and attachments you no longer need.
                    </>
                  ) : (
                    <>
                      <button type="button" className="cursor-pointer font-medium underline" onClick={() => setPricingOpen(true)}>
                        Upgrade to Pro
                      </button>{" "}
                      for 5 GB, or delete files you no longer need.
                    </>
                  )}
                </p>
              );
            }

            if (atProjectLimit && !onProLimits) {
              return (
                <p className="mt-4 text-[13px] text-[var(--warning-foreground)]">
                  You&apos;ve reached the Launch plan&apos;s {usage.projectLimit}-project limit.{" "}
                  <button type="button" className="cursor-pointer font-medium underline" onClick={() => setPricingOpen(true)}>
                    Upgrade to Pro
                  </button>{" "}
                  for unlimited projects.
                </p>
              );
            }
            return null;
          })()}
        </Card>
      )}

      {invoices.length > 0 && (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-[var(--foreground)]">Invoices</h3>
            {isOwner && (
              <button
                type="button"
                onClick={handleManageBilling}
                disabled={redirecting}
                className="cursor-pointer text-[13px] font-medium text-[var(--accent-light)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
              >
                {redirecting ? "Opening…" : "All invoices & payment methods →"}
              </button>
            )}
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13px]">
                <div className="min-w-0">
                  <span className="font-medium text-[var(--foreground)]">
                    {formatMoney(inv.status === "paid" ? inv.amountPaid : inv.amountDue, inv.currency)}
                  </span>
                  <span className="ml-2 text-[var(--muted-soft)]">{formatDate(inv.createdAt)}</span>
                  {inv.number && <span className="ml-2 text-[var(--muted-soft)]">· {inv.number}</span>}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cx(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      inv.status === "paid"
                        ? "bg-[var(--success-soft)] text-[var(--success-foreground)]"
                        : "bg-[var(--warning-soft)] text-[var(--warning-foreground)]"
                    )}
                  >
                    {inv.status ?? "unknown"}
                  </span>
                  {inv.hostedInvoiceUrl && (
                    <a
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[var(--accent-light)] hover:underline"
                    >
                      View
                    </a>
                  )}
                  {inv.invoicePdf && (
                    <a
                      href={inv.invoicePdf}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[var(--accent-light)] hover:underline"
                    >
                      PDF
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Plan changes, payments and cancellations, so the workspace can see what happened and when
          without anyone having to open Stripe. Backed by the append-only audit trail. */}
      {history.length > 0 && (
        <Card className="p-5">
          <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">Billing activity</h3>
          <ul className="space-y-3">
            {history.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="flex gap-3">
                <span
                  className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", HISTORY_DOT[entry.action] ?? "bg-[var(--muted-soft)]")}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--foreground)]">{entry.summary}</p>
                  <p className="text-[12px] text-[var(--muted-soft)]">
                    {new Date(entry.at).toLocaleString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} billingInfo={billingInfo} />
    </div>
  );
}
