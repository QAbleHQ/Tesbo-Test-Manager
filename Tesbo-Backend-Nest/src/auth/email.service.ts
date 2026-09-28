import { Injectable } from "@nestjs/common";
import { escapeHtml } from "../common/integration-text.util";
import { AppConfigService } from "../config/app-config.service";
import { EmailDeliveryPolicy, EmailKind } from "../config/email-delivery.policy";

@Injectable()
export class EmailService {
  constructor(
    private readonly config: AppConfigService,
    private readonly delivery: EmailDeliveryPolicy
  ) {}

  /**
   * Posts one email to Postmark — but only when EmailDeliveryPolicy allows it.
   *
   * In log mode (the default, and what every local and CI stack runs) `logLabel` is written to
   * stdout: the e2e setup scrapes OTP codes and invite links out of container logs, so that path has
   * to stay, and it is the only way to read a code when nothing was emailed. See
   * config/email-delivery.policy.ts for which emails are still posted to the sandbox server.
   */
  private async send(
    to: string,
    subject: string,
    textBody: string,
    htmlBody: string | undefined,
    logLabel: string,
    kind: EmailKind = "communication",
    cc?: string
  ): Promise<void> {
    const decision = await this.delivery.decide(kind);
    if (!decision.post || this.delivery.logsEveryEmail) {
      console.log(logLabel);
    }
    if (!decision.post) return;

    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.config.postmarkApiToken
      },
      body: JSON.stringify({
        From: this.config.postmarkFromEmail,
        To: to,
        ...(cc && { Cc: cc }),
        Subject: subject,
        TextBody: textBody,
        ...(htmlBody && { HtmlBody: htmlBody })
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Postmark returned ${response.status}: ${body}`);
    }
  }

  /**
   * Billing emails never block the operation that triggered them.
   *
   * These are sent from Stripe webhook handlers and from upload paths: a Postmark outage must not
   * turn a successful payment into a failed webhook (which Stripe would then retry, re-running the
   * handler) or a successful upload into a 500. Failures are logged and swallowed.
   */
  private async sendBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(`[billing-email] ${label} failed:`, error instanceof Error ? error.message : error);
    }
  }

  private button(url: string, label: string): string {
    return `<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#E8600A;color:#fff;text-decoration:none;border-radius:6px">${label}</a></p>`;
  }

  /** A subscription invoice failed. Stripe keeps retrying; this tells them to fix the card. */
  async sendPaymentFailed(to: string, workspaceName: string, billingUrl: string, graceDays: number): Promise<void> {
    const subject = `Action needed: payment failed for ${workspaceName}`;
    const text = `Hi,\n\nWe couldn't process the payment for your Tesbo Pro subscription on ${workspaceName}.\n\nThis usually means the card expired or was declined. Your workspace still has full Pro access for now — we'll retry the payment automatically over the next few days.\n\nUpdate your payment method here:\n${billingUrl}\n\nIf the payment can't be collected, ${workspaceName} moves to the free Launch plan. You'd keep full access for a further ${graceDays} days after that before Launch limits apply, so nothing is lost immediately.\n\nTesbo Test Manager`;
    const html = `<p>Hi,</p>
<p>We couldn't process the payment for your Tesbo Pro subscription on <strong>${workspaceName}</strong>.</p>
<p>This usually means the card expired or was declined. Your workspace still has full Pro access for now — we'll retry the payment automatically over the next few days.</p>
${this.button(billingUrl, "Update payment method")}
<p style="color:#6B7280;font-size:12px">If the payment can't be collected, ${workspaceName} moves to the free Launch plan. You'd keep full access for a further ${graceDays} days after that before Launch limits apply, so nothing is lost immediately.</p>`;
    await this.sendBestEffort("payment-failed", () => this.send(to, subject, text, html, `[PAYMENT FAILED] ${to} → ${workspaceName}`));
  }

  /** A subscription invoice was paid — the renewal receipt. */
  async sendPaymentSucceeded(to: string, workspaceName: string, amountLabel: string, periodEnd: string | null, invoiceUrl: string | null): Promise<void> {
    const subject = `Payment received for ${workspaceName}`;
    const renews = periodEnd ? `\n\nYour next renewal is ${periodEnd}.` : "";
    const invoice = invoiceUrl ? `\n\nView your invoice:\n${invoiceUrl}` : "";
    const text = `Hi,\n\nWe've received your payment of ${amountLabel} for Tesbo Pro on ${workspaceName}. Your subscription is active.${renews}${invoice}\n\nTesbo Test Manager`;
    const html = `<p>Hi,</p>
<p>We've received your payment of <strong>${amountLabel}</strong> for Tesbo Pro on <strong>${workspaceName}</strong>. Your subscription is active.</p>
${periodEnd ? `<p>Your next renewal is ${periodEnd}.</p>` : ""}
${invoiceUrl ? this.button(invoiceUrl, "View invoice") : ""}`;
    await this.sendBestEffort("payment-succeeded", () =>
      this.send(to, subject, text, html, `[PAYMENT OK] ${to} → ${workspaceName} ${amountLabel}`)
    );
  }

  /** The subscription ended. Explains the grace window and exactly when limits start applying. */
  async sendPlanDowngraded(to: string, workspaceName: string, lockDate: string | null, billingUrl: string): Promise<void> {
    const subject = `${workspaceName} has moved to the Launch plan`;
    const window = lockDate
      ? `You keep full access to everything you have until ${lockDate}. After that, free Launch limits apply: 2 projects and 500 MB of storage.`
      : `Free Launch limits now apply: 2 projects and 500 MB of storage.`;
    const text = `Hi,\n\nThe Tesbo Pro subscription for ${workspaceName} has ended, so the workspace is now on the free Launch plan.\n\n${window}\n\nNothing has been deleted. Resubscribe any time to restore Pro:\n${billingUrl}\n\nTesbo Test Manager`;
    const html = `<p>Hi,</p>
<p>The Tesbo Pro subscription for <strong>${workspaceName}</strong> has ended, so the workspace is now on the free Launch plan.</p>
<p>${window}</p>
<p>Nothing has been deleted. Resubscribe any time to restore Pro.</p>
${this.button(billingUrl, "View billing")}`;
    await this.sendBestEffort("plan-downgraded", () => this.send(to, subject, text, html, `[DOWNGRADED] ${to} → ${workspaceName}`));
  }

  /** The grace window closed and Launch limits are now actually being enforced. */
  async sendGraceEnded(to: string, workspaceName: string, billingUrl: string): Promise<void> {
    const subject = `Launch plan limits now apply to ${workspaceName}`;
    const text = `Hi,\n\nThe grace period for ${workspaceName} has ended, so free Launch limits are now in effect: 2 projects and 500 MB of storage.\n\nProjects beyond the first two are read-only, and new uploads are paused until you're back under the storage limit. Nothing has been deleted — upgrading restores full access immediately.\n\n${billingUrl}\n\nTesbo Test Manager`;
    const html = `<p>Hi,</p>
<p>The grace period for <strong>${workspaceName}</strong> has ended, so free Launch limits are now in effect: 2 projects and 500 MB of storage.</p>
<p>Projects beyond the first two are read-only, and new uploads are paused until you're back under the storage limit. <strong>Nothing has been deleted</strong> — upgrading restores full access immediately.</p>
${this.button(billingUrl, "Upgrade to Pro")}`;
    await this.sendBestEffort("grace-ended", () => this.send(to, subject, text, html, `[GRACE ENDED] ${to} → ${workspaceName}`));
  }

  /** Workspace storage crossed a warning threshold (80 / 95 / 100%). */
  async sendStorageWarning(
    to: string,
    workspaceName: string,
    pct: number,
    usedLabel: string,
    limitLabel: string,
    isPro: boolean,
    billingUrl: string,
    contactEmail: string
  ): Promise<void> {
    const full = pct >= 100;
    const subject = full ? `${workspaceName} has run out of storage` : `${workspaceName} is at ${pct}% of its storage limit`;
    const nextStep = isPro
      ? `You're already on our largest plan, so to add more storage just reply to this email or contact ${contactEmail} and we'll sort it out.`
      : `Upgrading to Pro raises your limit to 5 GB:\n${billingUrl}`;
    const impact = full
      ? "New uploads are blocked until you free up space or increase your limit."
      : "You can keep uploading for now, but it's worth acting before you hit the cap.";
    const text = `Hi,\n\n${workspaceName} is using ${usedLabel} of its ${limitLabel} storage limit (${pct}%).\n\n${impact}\n\n${nextStep}\n\nYou can also free space by deleting large knowledge-base files and attachments you no longer need.\n\nTesbo Test Manager`;
    const html = `<p>Hi,</p>
<p><strong>${workspaceName}</strong> is using <strong>${usedLabel}</strong> of its ${limitLabel} storage limit (${pct}%).</p>
<p>${impact}</p>
${
  isPro
    ? `<p>You're already on our largest plan — reply to this email or contact <a href="mailto:${contactEmail}">${contactEmail}</a> and we'll sort out more storage.</p>`
    : `<p>Upgrading to Pro raises your limit to 5 GB.</p>${this.button(billingUrl, "Upgrade to Pro")}`
}
<p style="color:#6B7280;font-size:12px">You can also free space by deleting large knowledge-base files and attachments you no longer need.</p>`;
    await this.sendBestEffort("storage-warning", () =>
      this.send(to, subject, text, html, `[STORAGE ${pct}%] ${to} → ${workspaceName} ${usedLabel}/${limitLabel}`)
    );
  }

  async sendInvite(
    to: string,
    inviterName: string,
    role: string,
    workspaceName: string,
    rawToken: string,
    projectNames: string[],
    frontendUrl: string
  ): Promise<void> {
    const acceptUrl = `${frontendUrl}/invite/${rawToken}`;
    const roleLabel = role === "manager" ? "Manager" : "QA Engineer";
    const projectLine =
      projectNames.length > 0
        ? `\nYou have been assigned to: ${projectNames.join(", ")}.`
        : "";
    const textBody = `Hi,\n\n${inviterName} has invited you to join ${workspaceName} as ${roleLabel}.${projectLine}\n\nAccept your invitation here:\n${acceptUrl}\n\nThis invite expires in 7 days.\n\nTesbo Test Manager`;
    const htmlBody = `<p>Hi,</p>
<p><strong>${inviterName}</strong> has invited you to join <strong>${workspaceName}</strong> as <strong>${roleLabel}</strong>.</p>
${projectNames.length > 0 ? `<p>You have been assigned to: ${projectNames.map((n) => `<em>${n}</em>`).join(", ")}.</p>` : ""}
<p><a href="${acceptUrl}" style="display:inline-block;padding:10px 20px;background:#E8600A;color:#fff;text-decoration:none;border-radius:6px">Accept invite</a></p>
<p style="color:#6B7280;font-size:12px">This invite expires in 7 days. If you did not expect this, you can ignore it.</p>`;

    await this.send(to, `You have been invited to join ${workspaceName}`, textBody, htmlBody, `[INVITE] ${to} → ${acceptUrl}`);
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    const textBody = `Hi,\n\nWe received a request to reset your Tesbo Test Manager password.\n\nReset your password here:\n${resetUrl}\n\nThis link expires in 60 minutes. If you did not request this, you can ignore this email — your password will not be changed.\n\nTesbo Test Manager`;
    const htmlBody = `<p>Hi,</p>
<p>We received a request to reset your Tesbo Test Manager password.</p>
${this.button(resetUrl, "Reset password")}
<p style="color:#6B7280;font-size:12px">This link expires in 60 minutes. If you did not request this, you can ignore this email — your password will not be changed.</p>`;
    await this.send(
      to,
      "Reset your Tesbo Test Manager password",
      textBody,
      htmlBody,
      // Format kept parseable like the OTP line: e2e tests scrape reset links out of container logs.
      `PASSWORD RESET for ${to}: ${resetUrl}`
    );
  }

  /**
   * Fired after a password change, whether via account settings or a reset link. Best-effort:
   * a Postmark hiccup must not undo an otherwise-successful password change.
   */
  async sendPasswordChanged(to: string): Promise<void> {
    const resetUrl = `${this.config.frontendUrl}/forgot-password`;
    const subject = "Your Tesbo Test Manager password was changed";
    const textBody = `Hi,\n\nYour Tesbo Test Manager password was just changed. You've been signed out of all other active sessions.\n\nIf this was you, no action is needed.\n\nIf this wasn't you, reset your password immediately:\n${resetUrl}\n\nOr contact us at ${this.config.supportContactEmail}.\n\nTesbo Test Manager`;
    const htmlBody = `<p>Hi,</p>
<p>Your Tesbo Test Manager password was just changed. You've been signed out of all other active sessions.</p>
<p>If this was you, no action is needed.</p>
<p style="color:#6B7280;font-size:12px">If this wasn't you, <a href="${resetUrl}">reset your password now</a> or contact us at <a href="mailto:${this.config.supportContactEmail}">${this.config.supportContactEmail}</a>.</p>`;
    await this.sendBestEffort("password-changed", () =>
      this.send(to, subject, textBody, htmlBody, `[PASSWORD CHANGED] ${to}`)
    );
  }

  /**
   * The welcome email, sent a few hours after registration by welcome-email/. Recipient (the new
   * user) and CC (WELCOME_EMAIL_CC) are chosen by the caller, never derived here.
   *
   * Not best-effort: this runs inside a BullMQ job, so a Postmark failure has to throw for the job's
   * retries to kick in, rather than being swallowed the way the request-path emails above are.
   */
  async sendWelcome(to: string, cc: string | undefined, firstName: string): Promise<void> {
    const loginUrl = `${this.config.frontendUrl}/login`;
    const name = escapeHtml(firstName);
    const brand = "<strong>Tesbo Test Manager</strong>";
    const p = 'style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1F2937"';
    const subject = "Welcome to Tesbo Test Manager";
    const textBody = `Hi ${firstName},\n\nThank you for Choosing Tesbo Test Manager!\n\nWe noticed that you recently created your account, and we wanted to make sure you have everything you need to get started.\n\nYou can now log in to your account and explore Tesbo Test Manager. If you have any questions or need assistance, our team is happy to help.\n\nGet started: ${loginUrl}\n\nWe look forward to having you with us!\n\nBest regards,\nTesbo Test Manager`;
    // Table layout with inline styles only: that is what Gmail/Outlook actually render. The button is
    // a styled <a> inside its own cell so it stays a real, clickable button in clients that ignore
    // padding on inline elements.
    const htmlBody = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;font-family:Arial,Helvetica,sans-serif">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF">
<tr><td style="background:#1F2937;padding:28px 32px;font-size:26px;color:#FFFFFF">${brand}</td></tr>
<tr><td style="padding:32px">
<p ${p}>Hi <strong>${name}</strong>,</p>
<p ${p}>Thank you for Choosing ${brand}!</p>
<p ${p}>We noticed that you recently created your account, and we wanted to make sure you have everything you need to get started.</p>
<p ${p}>You can now log in to your account and explore ${brand}. If you have any questions or need assistance, our team is happy to help.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 28px"><tr><td style="background:#16A34A;border-radius:6px"><a href="${loginUrl}" style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:6px">Get started</a></td></tr></table>
<p ${p}>We look forward to having you with us!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#1F2937">Best regards,<br>${brand}</p>
</td></tr>
<tr><td style="padding:0 32px 28px"><div style="border-top:1px solid #E5E7EB;padding-top:16px;font-size:13px;color:#6B7280">${brand}</div></td></tr>
</table>
</td></tr>
</table>`;
    await this.send(to, subject, textBody, htmlBody, `[WELCOME] ${to}${cc ? ` cc ${cc}` : ""} → ${loginUrl}`, "communication", cc);
  }

  async sendOtp(to: string, code: string): Promise<void> {
    await this.send(
      to,
      "Your Tesbo Test Manager verification code",
      `Your Tesbo Test Manager verification code is ${code}. It expires in ${this.config.otpExpiryMinutes} minutes.`,
      undefined,
      // Format kept verbatim: e2e/global-setup.ts scrapes this line out of container logs.
      `OTP for ${to}: ${code}`,
      // Never posted to Postmark outside live mode, not even to a sandbox server: signup and login
      // are by far the highest-volume sends, they're the ones aimed at freshly invented addresses,
      // and nothing downstream needs the real send to have happened — the code is read from the log.
      "otp"
    );
  }
}
