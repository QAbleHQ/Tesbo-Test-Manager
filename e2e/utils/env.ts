import fs from "node:fs";
import path from "node:path";
import { loadEnvironmentFile } from "./env-file";
export { loadedEnvironment } from "./env-file";

/*
 * Applied before anything below is read.
 *
 * Every consumer in the suite — specs, global-setup and playwright.config.ts alike — resolves its
 * configuration through this module, so this is the one place that can guarantee an environment file
 * is in process.env before the first value is taken from it. The constants immediately below are
 * evaluated at import time, which is why this cannot be deferred into a function.
 *
 * A no-op unless E2E_ENV or E2E_ENV_FILE is set, so every existing local invocation is unaffected.
 */
loadEnvironmentFile();

function isLocalHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:1011";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://localhost:1010";
const targetIsLocal = isLocalHost(apiBaseUrl);

const ROOT_ENV_PATH = path.resolve(__dirname, "../../.env");
let rootEnvCache: Record<string, string> | null = null;

/**
 * The repo-root `.env` the local docker stack is booted from.
 *
 * Read only so the billing suites can reuse the backend's own Stripe values (webhook signing
 * secret, price IDs) without a human copying them into a second file. Consulted ONLY for a
 * localhost target: against a remote environment these values would be the wrong ones, and
 * signing a webhook with the wrong secret produces a confusing 400 rather than a clean skip.
 */
function rootEnv(): Record<string, string> {
  if (rootEnvCache) return rootEnvCache;
  rootEnvCache = {};
  if (!targetIsLocal) return rootEnvCache;
  try {
    for (const line of fs.readFileSync(ROOT_ENV_PATH, "utf-8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      rootEnvCache[match[1]] = value;
    }
  } catch {
    // No root .env (or unreadable) — every consumer treats "" as "not configured" and skips.
  }
  return rootEnvCache;
}

/*
 * Prefers an explicit E2E_-prefixed override (the only workable option against a remote target),
 * then the value already in this process's environment, then the local stack's own .env.
 *
 * Against a REMOTE target only the E2E_-prefixed form is accepted. The unprefixed names are the
 * local stack's own — a shell that has sourced the repo-root .env carries DATABASE_URL and the
 * STRIPE_* set for :1021, and before this guard those were inherited by a run pointed at stage.
 * The result is the failure mode CLAUDE.md's database rule exists to prevent, in its worst form:
 * dbControlAvailable() returns true, every SQL fixture lands in the LOCAL database, and the
 * assertions run against stage — so the fixtures are invisible and the failures look like product
 * bugs. (A wrong Stripe webhook secret is milder: a confusing 400 instead of a clean skip.)
 *
 * scripts/e2e-stage.sh already `unset`s these before launching. That only protects the runs that go
 * through it; this protects `npx playwright test` too, which is the whole point of E2E_ENV.
 */
function backendValue(key: string): string {
  // An exported-but-empty variable is "not configured" too, and must not shadow the next source.
  // `??` alone steps past undefined but not "", which is how an empty E2E_DATABASE_URL used to
  // silence the repo-root .env and dark-skip every DB-backed spec.
  const first = (...values: (string | undefined)[]) => values.find((v) => v) ?? "";
  if (!targetIsLocal) return first(process.env[`E2E_${key}`]);
  return first(process.env[`E2E_${key}`], process.env[key], rootEnv()[key]);
}

/*
 * The domain every address this suite invents lives at. Keep it a real, mail-accepting one.
 *
 * History: this suite used to mint addresses at `tesbo.local` / `tesbo-e2e.local`, domains that do
 * not exist, while a LIVE Postmark token sat in the repo-root .env — so every signup, OTP and invite
 * was a real delivery attempt to nowhere. ~1100 bounces accumulated and the sending account was
 * flagged.
 *
 * The backend now refuses to deliver unless it is explicitly in EMAIL_DELIVERY_MODE=live against a
 * Live Postmark server (see Tesbo-Backend-Nest/src/config/email-delivery.policy.ts, and the guard
 * spec in e2e/api/email-delivery.spec.ts that fails the run if this stack could email real people).
 * That, not this domain, is what makes a run bounce-proof.
 *
 * mailinator.com stays the default anyway, as the second line of defence for anything that reaches
 * a mail server despite the above — it accepts every address without bouncing, and its inboxes are
 * readable over a public API if a spec ever does need to read a real message. Keep local-parts to
 * [a-z0-9-] so they remain valid inbox names.
 *
 * Note that Mailinator inboxes are PUBLIC. That's fine for throwaway tenants on a local stack;
 * don't point this at a domain whose mail matters, and don't rely on these addresses being
 * private on a deployed target.
 */
export const emailDomain = process.env.E2E_EMAIL_DOMAIN ?? "mailinator.com";

/** `testAddress("invite-badcode")` → `e2e-invite-badcode-<unique>@<emailDomain>`. */
export function testAddress(label: string, unique: string | number = Date.now()): string {
  const slug = `e2e-${label}-${unique}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${slug}@${emailDomain}`;
}

export const env = {
  apiBaseUrl,
  webBaseUrl,
  ci: !!process.env.CI,

  /** The environment file in effect: "local", "stage", … or null when none was found. */
  environment: loadEnvironmentFile().name,

  /*
   * Whether the stack under test is this machine's docker-compose stack.
   *
   * The distinction that matters is not "localhost" for its own sake — it is whether there is a
   * backend container whose stdout can be read. Signup OTPs are printed there and nowhere else
   * outside production, so every provisioning path that scrapes a log is available here and
   * unavailable against a deployed target.
   */
  targetIsLocal,

  // Disposable smoke-test account. On a fresh stack this user doesn't exist yet —
  // global-setup creates it automatically when autoProvision is enabled (see below).
  //
  // Every *person* name below is deliberately "EndToEnd ...", not "E2E ...": validatePersonName()
  // allows only letters, marks, space, hyphen, apostrophe and period, so the "2" in "E2E" is a 400
  // on signup/start and on invite registration. Org and project names keep the "E2E " prefix — they
  // are not name-validated, and global-setup finds existing fixtures by matching projectName, so
  // renaming those would orphan every tenant already provisioned in the shared database.
  testEmail: process.env.E2E_TEST_EMAIL ?? `e2e-smoke@${emailDomain}`,
  testPassword: process.env.E2E_TEST_PASSWORD ?? "E2eSmokeTest!2026",
  testName: process.env.E2E_TEST_NAME ?? "EndToEnd Smoke User",

  orgName: process.env.E2E_ORG_NAME ?? "E2E Smoke Org",
  projectName: process.env.E2E_PROJECT_NAME ?? "E2E Smoke Project",

  // Second, fully independent tenant — used only by the cross-tenant authorization suite
  // (e2e/api/authorization.spec.ts) to prove account B can't reach account A's resources.
  testEmailB: process.env.E2E_TEST_EMAIL_B ?? `e2e-smoke-b@${emailDomain}`,
  testPasswordB: process.env.E2E_TEST_PASSWORD_B ?? "E2eSmokeTestB!2026",
  testNameB: process.env.E2E_TEST_NAME_B ?? "EndToEnd Smoke User B",
  orgNameB: process.env.E2E_ORG_NAME_B ?? "E2E Smoke Org B",
  projectNameB: process.env.E2E_PROJECT_NAME_B ?? "E2E Smoke Project B",

  /*
   * Two more disposable tenants, existing purely for the payment suites.
   *
   * Those suites drive plan transitions by writing the workspace's billing columns straight into
   * Postgres — there is no other way to reach "grace period expired" or "payment failed" without
   * real money and real waiting. That makes them destructive to whatever workspace they run
   * against, so they never touch the shared smoke workspace (account A), whose plan every other
   * spec implicitly depends on being unrestricted Launch.
   *
   * One tenant per spec FILE, not one for both: playwright.config.ts sets fullyParallel: false,
   * which serialises tests within a file but still runs different files concurrently across
   * workers. Sharing a workspace between the API and UI billing specs would let one file's
   * "downgrade now" land in the middle of the other file's "we're on Pro" assertions.
   */
  billingApiEmail: process.env.E2E_BILLING_API_EMAIL ?? `e2e-billing-api@${emailDomain}`,
  billingApiPassword: process.env.E2E_BILLING_API_PASSWORD ?? "E2eBillingApi!2026",
  billingApiName: process.env.E2E_BILLING_API_NAME ?? "EndToEnd Billing API User",
  billingApiOrgName: process.env.E2E_BILLING_API_ORG_NAME ?? "E2E Billing API Org",
  billingApiProjectName: process.env.E2E_BILLING_API_PROJECT_NAME ?? "E2E Billing API Project",

  billingUiEmail: process.env.E2E_BILLING_UI_EMAIL ?? `e2e-billing-ui@${emailDomain}`,
  billingUiPassword: process.env.E2E_BILLING_UI_PASSWORD ?? "E2eBillingUi!2026",
  billingUiName: process.env.E2E_BILLING_UI_NAME ?? "EndToEnd Billing UI User",
  billingUiOrgName: process.env.E2E_BILLING_UI_ORG_NAME ?? "E2E Billing UI Org",
  billingUiProjectName: process.env.E2E_BILLING_UI_PROJECT_NAME ?? "E2E Billing UI Project",

  /*
   * One more disposable tenant, for the screen-level UI suites (projects list, navigation, theme,
   * project dashboard) and the project-dashboard API suite.
   *
   * These suites need to create and delete SEVERAL projects at once — to assert list ordering, the
   * grid/list parity, per-status cards, and per-project dashboard arithmetic — and they need the
   * project list to hold nothing but their own fixtures so a count or an order is deterministic.
   *
   * Account A can't give them that. It's a Launch workspace, and PROJECT_LIMITS.launch is 2, so with
   * its own smoke project already in place there is exactly ONE spare project slot in the entire
   * workspace. Different spec FILES run concurrently across workers (fullyParallel only serialises
   * within a file), so two files both reaching for that slot would 403 each other at random. Hence a
   * tenant of its own, which global-setup puts on Pro for unlimited projects.
   */
  screensEmail: process.env.E2E_SCREENS_EMAIL ?? `e2e-screens@${emailDomain}`,
  screensPassword: process.env.E2E_SCREENS_PASSWORD ?? "E2eScreens!2026",
  screensName: process.env.E2E_SCREENS_NAME ?? "EndToEnd Screens User",
  screensOrgName: process.env.E2E_SCREENS_ORG_NAME ?? "E2E Screens Org",
  screensProjectName: process.env.E2E_SCREENS_PROJECT_NAME ?? "E2E Screens Base Project",

  /*
   * One more disposable tenant, for the workspace-creation suite.
   *
   * That suite creates additional workspaces, and POST /api/workspaces switches the caller's
   * ACTIVE workspace to the one it just made. Every other spec resolves its data through the
   * caller's active workspace, so running this against account A would silently repoint account A
   * at an empty org — and since fullyParallel is false but different FILES still run concurrently,
   * it could do that in the middle of another file's assertions. Hence a tenant of its own.
   *
   * It also needs a name that is NOT any other tenant's org name: the suite asserts on how many
   * workspaces this account owns, so a shared name would make those counts depend on run order.
   */
  workspacesEmail: process.env.E2E_WORKSPACES_EMAIL ?? `e2e-workspaces@${emailDomain}`,
  workspacesPassword: process.env.E2E_WORKSPACES_PASSWORD ?? "E2eWorkspaces!2026",
  workspacesName: process.env.E2E_WORKSPACES_NAME ?? "EndToEnd Workspaces User",
  workspacesOrgName: process.env.E2E_WORKSPACES_ORG_NAME ?? "E2E Workspaces Org",
  workspacesProjectName: process.env.E2E_WORKSPACES_PROJECT_NAME ?? "E2E Workspaces Project",

  /*
   * Stripe values mirrored from the backend's own configuration.
   *
   * The webhook secret is what lets the payment suites exercise the FULL Stripe webhook
   * lifecycle — upgrade, dunning, cancellation, downgrade — with locally signed synthetic events.
   * That verification is a local HMAC, so those tests reach the real handlers without a single
   * Stripe API call and without any Stripe object existing. Empty means the webhook suite skips.
   */
  stripeWebhookSecret: backendValue("STRIPE_WEBHOOK_SECRET"),
  stripePriceIdProMonthly: backendValue("STRIPE_PRICE_ID_PRO_MONTHLY"),
  stripePriceIdProAnnual: backendValue("STRIPE_PRICE_ID_PRO_ANNUAL"),
  stripePriceIdProMonthlyInr: backendValue("STRIPE_PRICE_ID_PRO_MONTHLY_INR"),
  stripePriceIdProAnnualInr: backendValue("STRIPE_PRICE_ID_PRO_ANNUAL_INR"),
  planGraceDays: Number(backendValue("PLAN_GRACE_DAYS") || 30),

  /*
   * Opt-in for the handful of tests that make Stripe WRITE calls (creating a real Checkout
   * Session, opening a real Billing Portal session). Off by default and deliberately so: a
   * deployment's STRIPE_SECRET_KEY is frequently a live key, and a Checkout Session created
   * against a live account creates a real Customer and permanently pins that workspace's
   * billing currency. Everything else in the payment suites is either read-only against Stripe
   * or driven by locally signed webhooks, so the default run is safe against any environment.
   */
  allowStripeWrites: process.env.E2E_BILLING_ALLOW_STRIPE_WRITES === "true",

  /*
   * Whether global-setup may create the tenants it needs, rather than requiring them to exist.
   *
   * Signup requires an OTP, and there are two ways to get one without a human in the loop:
   *   1. sign up over the real API and scrape the code out of `docker compose logs` — available
   *      only for this machine's stack, since it reads a container's stdout;
   *   2. seed the user straight into Postgres with a correctly hashed password, bypassing OTP
   *      delivery entirely — available wherever the database is reachable.
   *
   * (2) is why this no longer defaults to false against a deployed target. utils/psql.ts now
   * connects directly rather than through `docker compose exec`, so a DATABASE_URL for the
   * environment under test is enough to provision every tenant there — which is what makes a CI
   * run against staging need nothing but a URL pair and a connection string. With no database
   * configured this still defaults to false for a remote host, and the tenants must pre-exist.
   */
  autoProvision: process.env.E2E_AUTO_PROVISION
    ? process.env.E2E_AUTO_PROVISION === "true"
    : targetIsLocal || !!backendValue("DATABASE_URL"),
  dockerComposeFile:
    process.env.E2E_DOCKER_COMPOSE_FILE ?? path.resolve(__dirname, "../../docker-compose.yml"),
  dockerService: process.env.E2E_DOCKER_SERVICE ?? "backend",
  // Only the container that supplies the psql binary and the network path. It is never the database
  // itself — see dbUrl.
  dbService: process.env.E2E_DB_SERVICE ?? "postgres",
  /*
   * The one database this suite is allowed to touch: whatever DATABASE_URL the stack under test is
   * booted from.
   *
   * There is deliberately no E2E_DB_USER / E2E_DB_NAME pair any more. Those fed a `psql -U postgres
   * -d tesbo` call against the compose postgres container, which on this stack is an orphan holding
   * its own unrelated copy of the schema — so it connected, answered SELECT 1, and served a
   * database the API had never written to. dbControlAvailable() reported true, fixtures landed
   * where the API could not see them, and suites failed on assertions about rows that had genuinely
   * been inserted, into the wrong server. Removing the pair removes the fallback that made that
   * reachable; psql.ts throws when this is unset rather than guessing.
   *
   * The repo's CLAUDE.md carries this as a standing rule: no local database, for any reason.
   */
  dbUrl: backendValue("DATABASE_URL"),
};
