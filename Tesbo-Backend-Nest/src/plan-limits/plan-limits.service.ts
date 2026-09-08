import { ForbiddenException, Injectable } from "@nestjs/common";
import { EmailService } from "../auth/email.service";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";

export type Plan = "launch" | "pro";

export interface PlanUsageSummary {
  plan: Plan;
  projectCount: number;
  projectLimit: number | null;
  storageUsedBytes: number;
  storageLimitBytes: number;
  /** True while a downgraded workspace still has Pro-sized limits (see effectivePlan). */
  inGracePeriod: boolean;
  /** When the grace window closes and the limits above start being enforced. */
  graceEndsAt: string | null;
  /** Where to send someone who needs more room than their plan allows. */
  supportContactEmail: string;
}

// Per-workspace ceilings for Tesbo Cloud plans (see pricing doc: "per workspace", not per seat).
// Pro's project count is unlimited (null); its storage is generous but still capped at 5GB.
const PROJECT_LIMITS: Record<Plan, number | null> = { launch: 2, pro: null };
const STORAGE_LIMITS_BYTES: Record<Plan, number> = {
  launch: 500 * 1024 * 1024,
  pro: 5 * 1024 * 1024 * 1024
};

// Launch includes Jira only; every other integration (Linear, and anything added later) is Pro-only.
const LAUNCH_ALLOWED_INTEGRATIONS = new Set(["jira"]);

// Storage percentages the workspace owner is emailed about, highest first.
const STORAGE_WARN_THRESHOLDS = [100, 95, 80];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/** What a workspace is entitled to right now, which is not always what it's billed for. */
interface Entitlement {
  /** The plan being billed. */
  plan: Plan;
  /** The plan whose limits actually apply — 'pro' during a post-downgrade grace window. */
  effectivePlan: Plan;
  inGracePeriod: boolean;
  graceEndsAt: string | null;
}

@Injectable()
export class PlanLimitsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly email: EmailService
  ) {}

  /**
   * Resolves the limits that apply to a workspace right now.
   *
   * A workspace that loses Pro drops to the 'launch' plan for billing immediately, but keeps
   * Pro-sized limits until `plan_grace_ends_at`. That window exists so non-payment never instantly
   * locks someone out of work in progress — they get PLAN_GRACE_DAYS (default 30) of unchanged
   * access, with email warnings, before Launch limits bite.
   *
   * Evaluated lazily on each check rather than flipped by a scheduled job: this app runs no cron, and
   * a deadline comparison is exact at the moment it matters. Nothing is ever deleted or archived
   * when the window closes — access is derived from these columns, so resubscribing restores
   * everything with no data to migrate back.
   *
   * A plan an operator set by hand (plan_source = 'admin', V76_admin_plan_override.sql) is read the
   * same way — it is an ordinary value in `plan` — except that a grant carrying an expiry is retired
   * here the moment it lapses, on the same lazy principle.
   */
  private async getEntitlement(organizationId: string): Promise<Entitlement> {
    const res = await this.db.query<{
      plan: string;
      plan_grace_ends_at: string | null;
      plan_source: string | null;
      plan_override_expires_at: string | null;
    }>(
      `SELECT plan, plan_grace_ends_at, plan_source, plan_override_expires_at
         FROM organizations WHERE id = $1`,
      [organizationId]
    );
    const row = res.rows[0];
    let plan: Plan = row?.plan === "pro" ? "pro" : "launch";
    let graceEndsAt = row?.plan_grace_ends_at ?? null;

    const overrideLapsed =
      row?.plan_source === "admin" &&
      !!row.plan_override_expires_at &&
      new Date(row.plan_override_expires_at).getTime() <= Date.now();

    if (overrideLapsed) {
      await this.expireAdminOverride(organizationId, plan);
      plan = "launch";
      graceEndsAt = null;
    }

    const inGracePeriod = plan === "launch" && !!graceEndsAt && new Date(graceEndsAt).getTime() > Date.now();
    return { plan, effectivePlan: inGracePeriod ? "pro" : plan, inGracePeriod, graceEndsAt };
  }

  /**
   * Retires a hand-granted plan whose end date has passed, handing the workspace back to Stripe.
   *
   * No grace window is opened. plan_grace_ends_at exists to soften a *loss* the customer did not
   * choose — a failed card, a cancellation processed mid-cycle — by keeping Pro-sized limits for
   * PLAN_GRACE_DAYS. A comp reaching the end date it was given is not that: the date was the deal,
   * and extending it by another 30 days silently would make every expiry a two-month one.
   *
   * The write is guarded on plan_source still being 'admin' so that a workspace which subscribed
   * for real in the meantime — checkout resets plan_source to 'stripe' — cannot be knocked off Pro
   * by a stale grant expiring underneath it.
   */
  private async expireAdminOverride(organizationId: string, planAtExpiry: Plan): Promise<void> {
    const res = await this.db.query(
      `UPDATE organizations
          SET plan = 'launch',
              plan_source = 'stripe',
              plan_override_by = NULL,
              plan_override_at = NULL,
              plan_override_reason = NULL,
              plan_override_expires_at = NULL,
              updated_at = now()
        WHERE id = $1 AND plan_source = 'admin'
          AND plan_override_expires_at IS NOT NULL
          AND plan_override_expires_at <= now()`,
      [organizationId]
    );
    if (!res.rowCount) return;

    await this.db
      .query(
        `INSERT INTO audit_logs (organization_id, actor_id, action, entity_type, entity_id, entity_name, diff)
         VALUES ($1, NULL, 'billing_downgraded', 'billing', NULL, $2, $3::jsonb)`,
        [
          organizationId,
          "Moved to Launch — granted plan reached its end date",
          JSON.stringify({ from: planAtExpiry, to: "launch", source: "admin_override_expired" })
        ]
      )
      .catch(() => undefined);
  }

  private async getProjectCount(organizationId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM projects WHERE organization_id = $1 AND archived_at IS NULL",
      [organizationId]
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  private async getStorageUsedBytes(organizationId: string): Promise<number> {
    const res = await this.db.query<{ total: string }>(
      `SELECT
         COALESCE((SELECT SUM(file_size) FROM knowledge_files WHERE organization_id = $1 AND is_deleted = false), 0) +
         COALESCE((SELECT SUM(a.file_size) FROM attachments a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1), 0)
         AS total`,
      [organizationId]
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  /**
   * Sends the "your grace period has ended" email the first time enforcement actually bites.
   *
   * Guarded by a timestamp column so it goes out once, not on every blocked action. Failures are
   * swallowed inside EmailService, so this can never turn a limit check into a 500.
   */
  private async notifyGraceEndedOnce(organizationId: string): Promise<void> {
    const claimed = await this.db.query<{ name: string }>(
      `UPDATE organizations SET grace_locked_notified_at = now(), updated_at = now()
       WHERE id = $1 AND plan = 'launch' AND plan_grace_ends_at IS NOT NULL AND grace_locked_notified_at IS NULL
       RETURNING name`,
      [organizationId]
    );
    if (claimed.rows.length === 0) return;

    const owner = await this.db.query<{ email: string }>(
      `SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`,
      [organizationId]
    );
    // Mirrors BillingService.recordBillingEvent — same append-only audit_logs trail, so the billing
    // history shows the moment limits actually started applying, not just when the plan changed.
    // Errors are swallowed: a history write must never fail the request that triggered it.
    await this.db
      .query(
        `INSERT INTO audit_logs (organization_id, actor_id, action, entity_type, entity_id, entity_name, diff)
         VALUES ($1, NULL, 'billing_limits_enforced', 'billing', NULL, $2, '{}'::jsonb)`,
        [organizationId, "Grace period ended — Launch limits now apply"]
      )
      .catch(() => undefined);

    const email = owner.rows[0]?.email;
    if (!email) return;
    await this.email.sendGraceEnded(email, claimed.rows[0].name, `${this.config.frontendUrl}/settings?tab=billing`);
  }

  async assertCanCreateProject(organizationId: string): Promise<void> {
    if (!this.config.isStripeBillingEnabled) return;
    const { effectivePlan, plan } = await this.getEntitlement(organizationId);
    const limit = PROJECT_LIMITS[effectivePlan];
    if (limit == null) return;
    const count = await this.getProjectCount(organizationId);
    if (count >= limit) {
      if (plan === "launch") await this.notifyGraceEndedOnce(organizationId);
      throw new ForbiddenException({
        error: `The Launch plan is limited to ${limit} projects. Upgrade to Pro for unlimited projects.`
      });
    }
  }

  /**
   * Blocks writes to projects beyond the free allowance once a former Pro workspace's grace window
   * has closed.
   *
   * The rule is deterministic and stable: the OLDEST `limit` active projects stay writable, the rest
   * become read-only. Ordering by creation date (not by name or id) means the same projects stay
   * available across calls, and it favours the workspace's long-lived projects over recent ones.
   *
   * Read access is untouched, and no data is deleted or archived — the workspace can still export or
   * copy anything out, and resubscribing lifts the lock immediately.
   */
  async assertProjectWritable(organizationId: string, projectId: string): Promise<void> {
    if (!this.config.isStripeBillingEnabled) return;
    const { effectivePlan } = await this.getEntitlement(organizationId);
    const limit = PROJECT_LIMITS[effectivePlan];
    if (limit == null) return;

    const res = await this.db.query<{ locked: boolean }>(
      `SELECT rank > $2 AS locked FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rank
           FROM projects WHERE organization_id = $1 AND archived_at IS NULL
       ) ranked WHERE id = $3`,
      [organizationId, limit, projectId]
    );
    if (!res.rows[0]?.locked) return;

    await this.notifyGraceEndedOnce(organizationId);
    throw new ForbiddenException({
      error: `This project is read-only because the workspace is over the Launch plan's ${limit}-project limit. Your data is safe — upgrade to Pro to unlock it, or archive another project.`
    });
  }

  /**
   * Whether an upload of `incomingBytes` fits, WITHOUT throwing when it doesn't.
   *
   * Split out of assertStorageAvailable for the automation ingest (Basecamp 10189985971 §5), which
   * needs the opposite outcome to every other upload path: "at 100% of quota, new evidence uploads
   * are skipped going forward, but the pass/fail/skip result itself still records normally — a full
   * quota must never block test result reporting, only evidence attachment." A CI pipeline that
   * loses its screenshots is inconvenienced; one that loses its results is broken, and a workspace
   * that quietly stops recording test outcomes because someone uploaded a large video is a far
   * worse failure than a missing screenshot.
   *
   * Same computation, same thresholds, same warning email as the throwing version — which now
   * delegates here, so the two can never drift apart.
   */
  async checkStorageAvailable(
    organizationId: string,
    incomingBytes: number
  ): Promise<{ allowed: boolean; reason: string | null; usedBytes: number; limitBytes: number }> {
    if (!this.config.isStripeBillingEnabled) {
      const used = await this.getStorageUsedBytes(organizationId);
      return { allowed: true, reason: null, usedBytes: used, limitBytes: Number.MAX_SAFE_INTEGER };
    }
    const { effectivePlan, plan } = await this.getEntitlement(organizationId);
    const limit = STORAGE_LIMITS_BYTES[effectivePlan];
    const used = await this.getStorageUsedBytes(organizationId);

    if (used + incomingBytes > limit) {
      if (plan === "launch" && effectivePlan === "launch") await this.notifyGraceEndedOnce(organizationId);
      // A Pro workspace is already on the largest plan, so "upgrade" is not an answer — point it at
      // a human instead of leaving a dead end.
      const nextStep =
        effectivePlan === "pro"
          ? ` You're on our largest plan — contact ${this.config.supportContactEmail} to add more storage.`
          : " Upgrade to Pro for 5GB of storage.";
      return {
        allowed: false,
        reason: `This upload would exceed your workspace's ${formatBytes(limit)} storage limit.${nextStep}`,
        usedBytes: used,
        limitBytes: limit
      };
    }

    // Warn on the way up, after confirming the upload fits, so the owner hears about 80% before
    // they hit the wall at 100%.
    await this.maybeWarnStorage(organizationId, used + incomingBytes, limit, effectivePlan === "pro");
    return { allowed: true, reason: null, usedBytes: used, limitBytes: limit };
  }

  async assertStorageAvailable(organizationId: string, incomingBytes: number): Promise<void> {
    const check = await this.checkStorageAvailable(organizationId, incomingBytes);
    if (!check.allowed) throw new ForbiddenException({ error: check.reason });
  }

  /**
   * Emails the owner when storage crosses 80/95/100%, at most once per threshold.
   *
   * `storage_warned_pct` records the highest threshold already sent and is lowered again when usage
   * drops, so a workspace that clears space and refills gets warned afresh. The UPDATE is
   * conditional, which also makes it safe under concurrent uploads: only one wins the claim.
   */
  private async maybeWarnStorage(organizationId: string, usedBytes: number, limitBytes: number, isPro: boolean): Promise<void> {
    const pct = limitBytes > 0 ? Math.floor((usedBytes / limitBytes) * 100) : 0;
    const crossed = STORAGE_WARN_THRESHOLDS.find((t) => pct >= t) ?? null;

    if (crossed === null) {
      await this.db.query("UPDATE organizations SET storage_warned_pct = NULL WHERE id = $1 AND storage_warned_pct IS NOT NULL", [
        organizationId
      ]);
      return;
    }

    const claimed = await this.db.query<{ name: string }>(
      `UPDATE organizations SET storage_warned_pct = $2, updated_at = now()
       WHERE id = $1 AND (storage_warned_pct IS NULL OR storage_warned_pct < $2)
       RETURNING name`,
      [organizationId, crossed]
    );
    if (claimed.rows.length === 0) {
      // Not a new high-water mark, but usage may have fallen below the recorded threshold — step it
      // back down so a later climb warns again.
      await this.db.query(
        `UPDATE organizations SET storage_warned_pct = $2 WHERE id = $1 AND storage_warned_pct > $2`,
        [organizationId, crossed]
      );
      return;
    }

    const owner = await this.db.query<{ email: string }>(
      `SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`,
      [organizationId]
    );
    const email = owner.rows[0]?.email;
    if (!email) return;
    await this.email.sendStorageWarning(
      email,
      claimed.rows[0].name,
      crossed,
      formatBytes(usedBytes),
      formatBytes(limitBytes),
      isPro,
      `${this.config.frontendUrl}/settings?tab=billing`,
      this.config.supportContactEmail
    );
  }

  async assertCustomFieldsEnabled(organizationId: string): Promise<void> {
    if (!this.config.isStripeBillingEnabled) return;
    const { effectivePlan } = await this.getEntitlement(organizationId);
    if (effectivePlan !== "pro") {
      throw new ForbiddenException({
        error: "Custom fields are a Pro plan feature. Upgrade to Pro to create and manage custom fields."
      });
    }
  }

  async assertIntegrationAllowed(organizationId: string, provider: string): Promise<void> {
    if (!this.config.isStripeBillingEnabled) return;
    const { effectivePlan } = await this.getEntitlement(organizationId);
    if (effectivePlan === "pro" || LAUNCH_ALLOWED_INTEGRATIONS.has(provider)) return;
    throw new ForbiddenException({
      error: `${provider[0].toUpperCase()}${provider.slice(1)} is a Pro plan integration. The Launch plan includes Jira only — upgrade to Pro to connect it.`
    });
  }

  /**
   * Non-throwing sibling of assertIntegrationAllowed (same relationship as checkStorageAvailable
   * vs assertStorageAvailable above) — for the nightly sync scheduler, which needs to silently skip
   * a provider for a workspace rather than fail a request.
   */
  async isIntegrationAllowed(organizationId: string, provider: string): Promise<boolean> {
    const { effectivePlan } = await this.getEntitlement(organizationId);
    return effectivePlan === "pro" || LAUNCH_ALLOWED_INTEGRATIONS.has(provider);
  }

  async getUsageSummary(organizationId: string): Promise<PlanUsageSummary> {
    const [projectCount, storageUsedBytes] = await Promise.all([
      this.getProjectCount(organizationId),
      this.getStorageUsedBytes(organizationId)
    ]);
    // Without Stripe configured there is no paid upgrade path — do not enforce Launch ceilings.
    if (!this.config.isStripeBillingEnabled) {
      return {
        plan: "pro",
        projectCount,
        projectLimit: null,
        storageUsedBytes,
        storageLimitBytes: Number.MAX_SAFE_INTEGER,
        inGracePeriod: false,
        graceEndsAt: null,
        supportContactEmail: this.config.supportContactEmail
      };
    }
    const { plan, effectivePlan, inGracePeriod, graceEndsAt } = await this.getEntitlement(organizationId);
    return {
      plan,
      projectCount,
      // Report the limits actually in force, so the usage bars match what the API will allow.
      projectLimit: PROJECT_LIMITS[effectivePlan],
      storageUsedBytes,
      storageLimitBytes: STORAGE_LIMITS_BYTES[effectivePlan],
      inGracePeriod,
      graceEndsAt,
      supportContactEmail: this.config.supportContactEmail
    };
  }
}
