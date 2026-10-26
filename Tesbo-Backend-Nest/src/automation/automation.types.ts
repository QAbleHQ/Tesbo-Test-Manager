/**
 * Automation ingest — shared vocabulary.
 *
 * Basecamp 10189985971 §3/§4. The one job of this file is to keep the *wire* vocabulary an SDK
 * sends separate from the *stored* vocabulary Tesbo's dashboards aggregate on, and to make the
 * translation between them explicit and total.
 *
 * This matters more than it looks. `executions.status` is a bare VARCHAR(32) and, until this
 * card, the single-result write path (`LegacyService.updateExecution`) validated nothing — so a
 * literal `"pass"` was stored verbatim and then counted as neither passed nor executed by every
 * aggregate in the product. The card's own draft contract in §6 specifies lowercase
 * `pass/fail/skip`, so an SDK written to the card would have corrupted every run it reported.
 */

/** The agent slug seeded by V84, used to attribute ingested writes. */
export const AUTOMATION_AGENT_SLUG = "tesbo-automation";

/** `cycles.triggered_by` — bounded so a typo in a CI config is refused, not stored. */
export const TRIGGERED_BY_VALUES = [
  "local",
  "github-actions",
  "jenkins",
  "gitlab-ci",
  "circleci",
  "azure-pipelines",
  "bitbucket-pipelines",
  "other"
] as const;
export type TriggeredBy = (typeof TRIGGERED_BY_VALUES)[number];

/** `attachments.evidence_kind` — what a stored evidence file is, so the viewer can render it. */
export const EVIDENCE_KINDS = ["screenshot", "video", "trace", "log", "api"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Wire status → stored `executions.status`.
 *
 * Keys are lower-cased and stripped of separators before lookup, so `timedOut`, `timed_out`,
 * `TIMED-OUT` and `timedout` are one entry. Every value on the right is a member of
 * `LegacyService.EXECUTION_STATUSES`; anything not a key here is refused with the full list
 * rather than written.
 *
 * The two non-obvious mappings are Playwright's, and they are why this table exists rather than
 * a `capitalize()` call:
 *   - `timedout`    → Failed.  A test that ran out of time did not pass, and Tesbo has no
 *                     "timed out" status. Calling it Skipped (its nearest lexical neighbour)
 *                     would hide real failures from every pass-rate figure.
 *   - `interrupted` → Blocked. Playwright reports this when the *run* was torn down (another
 *                     test failed under --max-failures, or someone hit Ctrl-C), so the case never
 *                     reached a verdict of its own. Blocked is exactly that: not run, not the
 *                     case's fault. Recording Failed here would invent failures out of a
 *                     cancelled build.
 */
const WIRE_STATUS_MAP: Record<string, string> = {
  pass: "Passed",
  passed: "Passed",
  fail: "Failed",
  failed: "Failed",
  skip: "Skipped",
  skipped: "Skipped",
  blocked: "Blocked",
  retest: "Retest",
  untested: "Untested",
  timedout: "Failed",
  interrupted: "Blocked"
};

/** The forms a caller may send, for error messages. Deduped and ordered for readability. */
export const ACCEPTED_WIRE_STATUSES = Object.keys(WIRE_STATUS_MAP);

/**
 * Normalises one wire status, or returns null if it is not recognised.
 *
 * Returns null rather than throwing so the caller decides the error shape (a 400 on the results
 * endpoint, a per-row skip in a future batch endpoint).
 */
export function normalizeWireStatus(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const key = input.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!key) return null;
  return WIRE_STATUS_MAP[key] ?? null;
}

/**
 * Evidence extensions accepted per kind.
 *
 * NOT `LegacyService.KB_ALLOWED_EXTENSIONS`. That list deliberately excludes `zip` — "a zip hides
 * anything past an extension check" — and a Playwright trace is a `.zip`, so the card's §5
 * requirement to accept traces cannot be met by reusing it.
 *
 * The exception is narrow on purpose, and each clause below is load-bearing:
 *   - `zip` is accepted ONLY under kind 'trace', so a caller cannot smuggle one in as a
 *     screenshot;
 *   - the file is never opened, extracted or parsed server-side — it is an opaque blob stored
 *     and handed back for Playwright's trace viewer to open client-side;
 *   - it is served as a download, never inline, so nothing inside it is interpreted by a browser
 *     in Tesbo's origin;
 *   - the route requires a project-scoped API token or a project member, and the bytes are
 *     capped and billed against the workspace's plan meter exactly like every other upload.
 *
 * The residual risk is that a token holder can store up to EVIDENCE_MAX_FILE_SIZE of arbitrary
 * bytes in the workspace's own storage — which `.mp4` and `.webm` already allow. What the
 * original allowlist was protecting against was a *human* upload path where the extension is the
 * only signal of intent; that path is unchanged.
 */
export const EVIDENCE_EXTENSIONS: Record<EvidenceKind, ReadonlySet<string>> = {
  screenshot: new Set(["png", "jpg", "jpeg", "webp"]),
  video: new Set(["mp4", "webm", "mov"]),
  trace: new Set(["zip"]),
  log: new Set(["txt", "log", "json", "xml", "md"]),
  // A JSON envelope or a HAR (which is JSON); the viewer parses it, so assertValidEvidence also
  // refuses a body that is not JSON rather than storing something it can only show as an error.
  api: new Set(["json", "har"])
};

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

export function isTriggeredBy(value: unknown): value is TriggeredBy {
  return typeof value === "string" && (TRIGGERED_BY_VALUES as readonly string[]).includes(value);
}
