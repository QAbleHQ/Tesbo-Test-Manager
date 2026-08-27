import * as fs from "fs";
import * as path from "path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult
} from "@playwright/test/reporter";
import { TesboClient, type ResultBody } from "./client";
import { detectRunSource } from "./ci";
import { extractCaseId, tesboTag } from "./tag";
import { resolveConfig } from "./config";
import { readConfigFile } from "./file-config";

export { tesboTag } from "./tag";
export { TesboClient } from "./client";
export { detectRunSource } from "./ci";
export { resolveConfig, normalizeBaseUrl, maskToken } from "./config";
export { readConfigFile, writeConfigFile, configFilePath, CONFIG_FILENAME } from "./file-config";
export type { FileConfig } from "./file-config";
export type { TesboConfigInput, ResolvedTesboConfig, ConfigResolution } from "./config";

/**
 * Tesbo reporter for Playwright — Basecamp 10189985971, build sequence item 2.
 *
 * Usage in `playwright.config.ts`:
 *
 *     reporter: [
 *       ['list'],
 *       ['@tesbox/playwright-reporter', { projectId: process.env.TESBO_PROJECT_ID }],
 *     ]
 *
 * and tag each test with the case it validates:
 *
 *     test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {});
 *
 * Four constraints from the card shape the implementation:
 *
 * - **One run per session, never per test** (§4). `onBegin` opens exactly one run.
 * - **Untagged tests are skipped and counted, not fatal** (§3). `strict: true` opts into failing at
 *   collection time instead; the default keeps a suite mid-adoption working.
 * - **Never break the customer's CI** (§7). Every ingest call resolves; `TesboClient` logs and
 *   counts failures rather than throwing. The process exit code is left entirely alone — see the
 *   closing note.
 * - **Non-blocking submission** (§7). `onTestEnd` starts the submission and returns immediately;
 *   the promises are collected and drained once in `onEnd`, so result posting never sits in the
 *   critical path between two tests.
 */

export interface TesboReporterOptions {
  /** Tesbo project id. Defaults to `TESBO_PROJECT_ID`. */
  projectId?: string;
  /** Project API token (`tsbo_...`). Defaults to `TESBO_API_TOKEN`. Never hard-code it. */
  token?: string;
  /**
   * Tesbo API base URL, e.g. `https://api-app.tesbo.io`. Defaults to `TESBO_BASE_URL`.
   *
   * **No fallback default.** It used to default to `https://app.tesbo.io` — the web app, not the
   * API — which 404'd every ingest call while the suite stayed green, because the client logs
   * failures rather than throwing. There is also no correct default for a self-hosted install.
   */
  baseUrl?: string;
  /** Run name. Defaults to a name derived from the CI context. */
  runName?: string;
  /** Recorded on the run for filtering, e.g. 'staging'. */
  environment?: string;
  buildVersion?: string;
  releaseName?: string;
  /**
   * Fail at collection time if any test lacks a `@tesbo.testId(...)` tag, or if a tagged id does not
   * exist in the project. Off by default: the card asks in §3 for untagged tests to be skipped and
   * surfaced in the summary, and turning a partially-tagged suite red on day one is the onboarding
   * cliff that would stop teams adopting it at all. A team that wants the guarantee turns this on.
   */
  strict?: boolean;
  /** Which results get evidence. 'failed' (default) matches §5; 'always' costs storage. */
  attachEvidence?: "failed" | "always" | "never";
  /**
   * Treat a completely unconfigured environment as an error instead of an opt-out.
   *
   * Off by default so a fork's pull request build, which has no secrets, keeps working — card §7.
   * A *partially* configured environment is always a hard failure regardless of this flag: that is
   * a typo or a secret that did not reach the runner, never a deliberate choice.
   */
  requireConfig?: boolean;
  /** Disable entirely without editing the config — e.g. on a fork's PR with no token. */
  enabled?: boolean;
  timeoutMs?: number;
  retries?: number;
}

/** Playwright status -> the ingest's wire vocabulary. */
const STATUS_MAP: Record<TestResult["status"], ResultBody["status"]> = {
  passed: "pass",
  failed: "fail",
  skipped: "skip",
  timedOut: "timedOut",
  interrupted: "interrupted"
};

/** Which evidence kind a Playwright attachment counts as, by file extension. */
const EVIDENCE_BY_EXTENSION: Record<string, "screenshot" | "video" | "trace" | "log"> = {
  png: "screenshot",
  jpg: "screenshot",
  jpeg: "screenshot",
  webp: "screenshot",
  mp4: "video",
  webm: "video",
  mov: "video",
  zip: "trace",
  txt: "log",
  log: "log",
  json: "log",
  md: "log",
  xml: "log"
};

/** Mirrors the backend's per-file ceiling, so an oversized artifact is dropped locally not uploaded. */
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

/** ANSI SGR sequences Playwright colours its error text with. */
const ANSI_SGR = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

interface Counters {
  passed: number;
  failed: number;
  skipped: number;
  untagged: number;
  malformed: number;
  unknownCase: number;
  evidenceSkippedByQuota: number;
}

export default class TesboReporter implements Reporter {
  private client: TesboClient | null = null;
  private runId: string | null = null;
  private enabled: boolean;
  private readonly options: TesboReporterOptions;
  private readonly source = detectRunSource();
  private readonly inFlight: Promise<unknown>[] = [];
  private readonly counters: Counters = {
    passed: 0,
    failed: 0,
    skipped: 0,
    untagged: 0,
    malformed: 0,
    unknownCase: 0,
    evidenceSkippedByQuota: 0
  };
  private readonly untaggedTitles: string[] = [];
  private readonly malformedNotices: string[] = [];
  private disabledReason: string | null = null;

  constructor(options: TesboReporterOptions = {}) {
    this.options = options;
    this.enabled = options.enabled !== false;
  }

  /** The reporter prints its own summary, so Playwright must not treat it as silent. */
  printsToStdio(): boolean {
    return true;
  }

  /**
   * Opens the run and validates the suite's case ids.
   *
   * Collection-time validation is card §3: "the tag/decorator must be parsed at test-collection
   * time (before execution), so unlinked tests can be flagged upfront rather than discovered as a
   * missing result later", and "a typo in the ID fails fast locally instead of silently not
   * reporting". Both are only possible here, before the first test runs.
   */
  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    if (!this.enabled) return;

    /*
     * Three outcomes, not two — see the ConfigResolution doc in config.ts.
     *
     * `incomplete` and `invalid` throw here even when `requireConfig` is off, and that is the point
     * of separating them from `unconfigured`: somebody who set two of the three values meant to
     * report, so silently reporting nothing and exiting 0 hides their typo indefinitely. Only the
     * genuinely-unconfigured case is allowed to degrade quietly.
     */
    const resolution = resolveConfig(this.options, process.env, readConfigFile());
    if (resolution.state === "incomplete" || resolution.state === "invalid") {
      throw new Error(`[tesbo] ${resolution.message}`);
    }
    if (resolution.state === "unconfigured") {
      if (this.options.requireConfig) throw new Error(`[tesbo] ${resolution.message}`);
      this.disable(resolution.message);
      return;
    }

    const { baseUrl, projectId, token } = resolution.config;
    // Notes are how a forgiving baseUrl stays honest: anything that was trimmed, inferred or looks
    // suspicious is stated rather than applied silently.
    for (const note of resolution.notes) console.warn(`[tesbo] ${note}`);

    this.client = new TesboClient({
      baseUrl,
      projectId,
      token,
      timeoutMs: this.options.timeoutMs,
      retries: this.options.retries
    });

    const { caseIds, untagged, malformed } = this.scanSuite(suite);
    this.untaggedTitles.push(...untagged);
    this.malformedNotices.push(...malformed);

    if (malformed.length && this.options.strict) {
      throw new Error(`[tesbo] ${malformed.length} test(s) have an unreadable Tesbo marker:\n  ${malformed.join("\n  ")}`);
    }
    if (untagged.length && this.options.strict) {
      const shown = untagged.slice(0, 20).join("\n  ");
      const more = untagged.length > 20 ? `\n  ...and ${untagged.length - 20} more` : "";
      throw new Error(`[tesbo] strict mode: ${untagged.length} test(s) have no ${tesboTag("<CASE_ID>")} tag:\n  ${shown}${more}`);
    }

    if (!caseIds.length) {
      this.disable(`no test carries a ${tesboTag("<CASE_ID>")} tag, so there is nothing to report against.`);
      return;
    }

    // Fail fast on typos before spending the run. In non-strict mode an unknown id is a warning: the
    // run still proceeds and the result is counted as unreported, which is more useful than
    // refusing to run tests because one tag went stale.
    const resolved = await this.client.resolveCases(caseIds);
    if (resolved.ok && resolved.data.unknown.length) {
      const list = resolved.data.unknown.join(", ");
      if (this.options.strict) {
        throw new Error(`[tesbo] these case ids do not exist in project ${projectId}: ${list}`);
      }
      console.warn(`[tesbo] ${resolved.data.unknown.length} tagged case id(s) not found in Tesbo: ${list}`);
    }

    const run = await this.client.createRun({
      name: this.options.runName ?? this.source.suggestedName,
      externalId: this.source.externalId,
      triggeredBy: this.source.triggeredBy,
      commitSha: this.source.commitSha,
      branch: this.source.branch,
      buildUrl: this.source.buildUrl,
      environment: this.options.environment,
      buildVersion: this.options.buildVersion,
      releaseName: this.options.releaseName,
      caseIds
    });

    if (!run.ok) {
      this.disable(`could not create the run (${run.error}); results will not be reported.`);
      return;
    }
    this.runId = run.data.runId;
    const shardNote = config.shard ? ` (shard ${config.shard.current}/${config.shard.total})` : "";
    const reusedNote = run.data.reused ? " (existing)" : "";
    console.log(`[tesbo] reporting ${caseIds.length} linked test(s) to run ${run.data.runId}${reusedNote}${shardNote}`);
  }

  /**
   * Walks the collected suite for case ids.
   *
   * `suite.allTests()` is every test Playwright will actually run — after filters, greps and
   * sharding — so on a sharded matrix each shard declares only its own slice. That is what makes the
   * shared `externalId` the right way for the shards to converge on one run rather than opening N.
   */
  private scanSuite(suite: Suite): { caseIds: string[]; untagged: string[]; malformed: string[] } {
    const caseIds = new Set<string>();
    const untagged: string[] = [];
    const malformed: string[] = [];
    for (const test of suite.allTests()) {
      const { caseId, malformed: problem } = extractCaseId(test.tags ?? [], test.annotations ?? []);
      const label = test.titlePath().filter(Boolean).join(" > ");
      if (caseId) caseIds.add(caseId);
      else if (problem) malformed.push(`${label} — ${problem}`);
      else untagged.push(label);
    }
    return { caseIds: [...caseIds], untagged, malformed };
  }

  /**
   * Submits one result, without blocking the next test.
   *
   * The promise is pushed onto `inFlight` and awaited once in `onEnd`. Playwright retries a flaky
   * test by calling this again with a higher `result.retry`, and the ingest upserts on (run, case) —
   * so the last attempt is what stands, with `retryCount` carrying how many there were. Passing
   * `result.retry` explicitly rather than letting the server increment keeps a re-reported result
   * from inflating the count.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.enabled || !this.client || !this.runId) return;

    const { caseId, malformed } = extractCaseId(test.tags ?? [], test.annotations ?? []);
    if (!caseId) {
      if (malformed) this.counters.malformed += 1;
      else this.counters.untagged += 1;
      return;
    }

    if (result.status === "passed") this.counters.passed += 1;
    else if (result.status === "skipped") this.counters.skipped += 1;
    else this.counters.failed += 1;

    const client = this.client;
    const runId = this.runId;
    this.inFlight.push(
      (async () => {
        const posted = await client.recordResult(runId, {
          caseId,
          status: STATUS_MAP[result.status],
          durationMs: result.duration,
          retryCount: result.retry,
          errorMessage: this.errorMessage(result),
          errorStack: result.error?.stack
        });
        if (!posted.ok) {
          // 404 is specifically "no such case in this project" — worth counting separately from a
          // transport failure, because the fix is a tag edit, not a retry.
          if (posted.status === 404) this.counters.unknownCase += 1;
          return;
        }
        await this.submitEvidence(client, runId, caseId, result);
      })()
    );
  }

  /**
   * Playwright's error text, stripped of ANSI colour.
   *
   * The raw `message` carries terminal escape sequences which would be stored verbatim and rendered
   * as literal noise in Tesbo's UI.
   */
  private errorMessage(result: TestResult): string | undefined {
    const raw = result.error?.message ?? result.errors?.[0]?.message;
    if (!raw) return undefined;
    return raw.replace(ANSI_SGR, "").trim() || undefined;
  }

  /**
   * Uploads Playwright's own attachments as evidence, grouped by kind.
   *
   * Defaults to failures only, which is card §5: "Failed tests: full evidence bundle by default.
   * Passed tests: lightweight (status + duration) by default — configurable per project, since this
   * directly affects storage consumption." A passing suite of 2,000 tests each carrying a trace
   * would otherwise fill a workspace's whole allowance in one run.
   */
  private async submitEvidence(client: TesboClient, runId: string, caseId: string, result: TestResult): Promise<void> {
    const mode = this.options.attachEvidence ?? "failed";
    if (mode === "never") return;
    if (mode === "failed" && result.status === "passed") return;
    if (!result.attachments?.length) return;

    type Payload = { name: string; body: Uint8Array; contentType: string };
    const byKind = new Map<"screenshot" | "video" | "trace" | "log", Payload[]>();

    for (const attachment of result.attachments) {
      if (!attachment.path) continue; // inline `body` attachments have no file on disk
      const ext = path.extname(attachment.path).replace(/^\./, "").toLowerCase();
      const kind = EVIDENCE_BY_EXTENSION[ext];
      if (!kind) continue;
      let body: Uint8Array;
      try {
        const stat = await fs.promises.stat(attachment.path);
        // Size is checked before reading: a 500MB video would otherwise be pulled into memory only
        // to be rejected, and on a large matrix that is the difference between a slow run and an OOM.
        if (stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) continue;
        body = await fs.promises.readFile(attachment.path);
      } catch {
        continue; // traces and videos are finalised asynchronously and may not exist yet
      }
      const entry: Payload = {
        name: path.basename(attachment.path),
        body,
        contentType: attachment.contentType || "application/octet-stream"
      };
      const bucket = byKind.get(kind);
      if (bucket) bucket.push(entry);
      else byKind.set(kind, [entry]);
    }

    for (const [kind, files] of byKind) {
      const uploaded = await client.uploadEvidence(runId, caseId, kind, files);
      if (uploaded.ok && uploaded.data.skipped === "quota") this.counters.evidenceSkippedByQuota += files.length;
    }
  }

  /**
   * Drains the in-flight submissions, closes the run, and prints the summary.
   *
   * An interrupted run (Ctrl-C, or --max-failures tripping) closes as `incomplete`, so the run says
   * outright that results are missing instead of looking like a clean pass over fewer tests.
   */
  async onEnd(result: FullResult): Promise<void> {
    if (!this.enabled || !this.client || !this.runId) {
      if (this.disabledReason) console.warn(`[tesbo] ${this.disabledReason}`);
      this.printUnlinked();
      return;
    }

    await Promise.allSettled(this.inFlight);

    const interrupted = result.status === "interrupted" || result.status === "timedout";
    const closeStatus = interrupted ? "incomplete" : "completed";
    const closed = await this.client.closeRun(this.runId, closeStatus, {
      total: this.counters.passed + this.counters.failed + this.counters.skipped,
      passed: this.counters.passed,
      failed: this.counters.failed,
      skipped: this.counters.skipped
    });

    const counts = `${this.counters.passed} passed, ${this.counters.failed} failed, ${this.counters.skipped} skipped`;
    console.log(`[tesbo] run ${this.runId} closed (${closeStatus}): ${counts}`);

    this.printUnlinked();

    if (this.counters.unknownCase) {
      console.warn(`[tesbo] ${this.counters.unknownCase} result(s) had no matching test case in Tesbo and were not recorded.`);
    }
    if (this.counters.evidenceSkippedByQuota) {
      console.warn(
        `[tesbo] ${this.counters.evidenceSkippedByQuota} evidence file(s) were skipped: the workspace's storage quota is full. The results themselves were still recorded.`
      );
    }
    if (this.client.failures) {
      console.warn(`[tesbo] ${this.client.failures} request(s) to Tesbo failed; some results may be missing from run ${this.runId}.`);
    }
    /*
     * `mismatch` is the only place a dropped result is visible. The backend reconciles the summary
     * above against its own stored rows and reports any disagreement rather than trusting the SDK's
     * count — so if a result POST failed and was not retried, this line is what says so.
     */
    if (closed.ok && closed.data.mismatch) {
      console.warn(`[tesbo] Tesbo's stored counts differ from this run's: ${JSON.stringify(closed.data.mismatch)}`);
    }
  }

  /** Card §3: "surfaced in the run summary as 'N tests not linked to Tesbo'". */
  private printUnlinked(): void {
    const untagged = this.untaggedTitles.length || this.counters.untagged;
    if (untagged) console.log(`[tesbo] ${untagged} test(s) not linked to Tesbo (no ${tesboTag("<CASE_ID>")} tag).`);
    if (this.malformedNotices.length) {
      console.warn(
        `[tesbo] ${this.malformedNotices.length} test(s) have an unreadable Tesbo marker:\n  ${this.malformedNotices.join("\n  ")}`
      );
    }
  }

  private disable(reason: string): void {
    this.enabled = false;
    this.disabledReason = reason;
  }

  /*
   * Deliberately NOT implemented: any mutation of the process exit code.
   *
   * Card §7: "never let a Tesbo outage break someone's CI pipeline." A reporter that failed the run
   * because it could not reach Tesbo would do exactly that, so every failure above is a log line and
   * a counter. The suite's own pass/fail stays Playwright's to decide.
   */
}
