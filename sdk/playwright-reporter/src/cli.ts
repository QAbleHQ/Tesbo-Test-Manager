#!/usr/bin/env node
/**
 * `tesbo-playwright` — the interactive half of the SDK.
 *
 * **Why the prompting lives here and not in the reporter.** The natural request is "before running,
 * the SDK should ask for the three values". A Playwright reporter cannot: it runs inside a
 * non-interactive test process, usually on a CI runner with no TTY, and a prompt there does not ask
 * anybody anything — it hangs the pipeline until the job times out. So the reporter's contract is to
 * *fail fast and say what is missing*, and the asking happens here, in a command a human runs.
 *
 *   npx @tesbox/playwright-reporter doctor   # verify what is configured, prompt for what is not
 *   npx @tesbox/playwright-reporter init     # ask for all three and print the config to paste
 *
 * Both refuse to prompt when stdin is not a TTY, and exit non-zero instead, so neither can ever be
 * the reason a CI job hangs.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline/promises";
import { TesboClient } from "./client";
import {
  ENV_BASE_URL,
  ENV_PROJECT_ID,
  ENV_TOKEN,
  maskToken,
  normalizeBaseUrl,
  resolveConfig,
  type ResolvedTesboConfig
} from "./config";
import {
  CONFIG_FILENAME,
  configFilePath,
  detectsDotenv,
  readConfigFile,
  writeConfigFile
} from "./file-config";

/** Exit codes, so a script wrapping this can tell the two failures apart. */
const EXIT_OK = 0;
const EXIT_VERIFY_FAILED = 1;
const EXIT_NOT_CONFIGURED = 2;

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function version(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/* ─────────────────────────────── asking ─────────────────────────────── */

interface Asker {
  ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string): Promise<boolean>;
  close(): void;
}

/**
 * A prompt that cannot hang a CI job.
 *
 * Callers check `interactive()` first; this throws if constructed anyway, so a future code path that
 * forgets the check fails loudly here rather than blocking on a read that will never return.
 */
function createAsker(): Asker {
  if (!interactive()) throw new Error("refusing to prompt without a TTY");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question, opts = {}) {
      const suffix = opts.default ? ` [${opts.secret ? maskToken(opts.default) : opts.default}]` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer || opts.default || "";
    },
    async confirm(question) {
      const answer = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    close: () => rl.close()
  };
}

/* ─────────────────────────────── verifying ─────────────────────────────── */

interface VerifyOutcome {
  ok: boolean;
  detail: string;
  /** What to do about it, when the failure has an obvious cause. */
  hint?: string;
}

/**
 * Proves the three values actually work together, using the cheapest call that exercises all of them.
 *
 * `POST /automation/cases/resolve` with an empty list is a read-only no-op that still passes through
 * the whole auth chain the reporter depends on: the URL proves the host, the bearer proves the token,
 * and the controller's `assertTokenScope` proves the token is scoped to *this* project. Nothing is
 * created, so doctor is safe to run against production.
 */
async function verify(config: ResolvedTesboConfig): Promise<VerifyOutcome> {
  const client = new TesboClient({
    baseUrl: config.baseUrl,
    projectId: config.projectId,
    token: config.token,
    timeoutMs: 10_000,
    // One attempt: a doctor is a diagnostic, and three rounds of backoff on an unreachable host just
    // makes the person wait 7 seconds longer for the same answer.
    retries: 1,
    // The client logs failures itself; this command formats its own, so silence the duplicate.
    log: () => {}
  });

  const probe = await client.resolveCases([]);
  if (probe.ok) return { ok: true, detail: "reachable, token valid, scoped to this project" };

  const status = probe.status;

  /*
   * An HTML body is the unmistakable signature of pointing at the web app instead of the API: the
   * frontend has no /api route, so Next.js serves its own 404 *page*. Without this check the message
   * is "no such project" plus 300 characters of markup, which sends the reader off to verify a
   * project id that was never the problem.
   */
  if (/^\s*(<!doctype|<html)/i.test(probe.error)) {
    return {
      ok: false,
      detail: `${config.baseUrl} returned an HTML page rather than an API response (HTTP ${status ?? "?"})`,
      hint:
        `That host is serving the Tesbo web app, not its API. They are separate hosts — try ` +
        `"api-${new URL(config.baseUrl).hostname}".`
    };
  }

  if (status === null) {
    return {
      ok: false,
      detail: `could not reach ${config.baseUrl} (${probe.error})`,
      hint:
        `Check ${ENV_BASE_URL}. It must be the **API** host, not the web app — Tesbo serves them on ` +
        `separate hosts and the app host has no /api route.`
    };
  }
  if (status === 401) {
    return { ok: false, detail: `the token was rejected (401: ${probe.error})`, hint: `Re-issue it under Project → Settings → API & MCP.` };
  }
  if (status === 403) {
    return {
      ok: false,
      detail: `the token is not allowed to use this project (403: ${probe.error})`,
      hint: `The token must be scoped to project ${config.projectId} and carry the "read" and "write" scopes.`
    };
  }
  if (status === 404) {
    return {
      ok: false,
      detail: `no such project on this server (404: ${probe.error})`,
      hint: `Check ${ENV_PROJECT_ID}, and that it belongs to the server at ${config.baseUrl}.`
    };
  }
  return { ok: false, detail: `HTTP ${status}: ${probe.error}` };
}

/* ─────────────────────────────── reporting ─────────────────────────────── */

/** Widest env var name, so the three names and the usage block line up in one column. */
const LABEL_WIDTH = Math.max(ENV_BASE_URL.length, ENV_PROJECT_ID.length, ENV_TOKEN.length) + 2;

const label = (name: string): string => name.padEnd(LABEL_WIDTH);

function printResolved(config: ResolvedTesboConfig, notes: string[]): void {
  console.log(`  ${label(ENV_BASE_URL)}${config.baseUrl}`);
  console.log(`  ${label(ENV_PROJECT_ID)}${config.projectId}`);
  console.log(`  ${label(ENV_TOKEN)}${maskToken(config.token)}`);
  for (const note of notes) console.log(`\n  note: ${note}`);
}

function printConfigSnippet(config: ResolvedTesboConfig, tokenInFile: boolean): void {
  console.log(`
Name the reporter in playwright.config.ts. This is the only edit it needs, ever — re-running init
rewrites ${CONFIG_FILENAME}, not this file:

  reporter: [
    ['list'],
    ['@tesbox/playwright-reporter'],
  ]

${
  tokenInFile
    ? `All three values are in ${CONFIG_FILENAME}.`
    : `${CONFIG_FILENAME} holds the server and project. Keep the token in the environment:

  ${ENV_TOKEN}=${maskToken(config.token)}`
}

Then tag each test with the case it validates:

  test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {});
`);
}

/**
 * Offers to persist the token to `.env`, and refuses to pretend that worked.
 *
 * Two checks, both with a concrete failure behind them:
 *
 * - **Is `.env` gitignored?** Writing a live credential into a tracked file is the one irreversible
 *   mistake this command could cause, and it is silent until the push lands.
 * - **Does anything here load `.env`?** Playwright does not read it. Without a loader the file is
 *   written, chmodded and reported as a success — and the reporter still sees nothing. That is the
 *   same silent-success failure this SDK exists to refuse, so it is stated before the offer.
 */
async function maybeWriteEnv(asker: Asker, config: ResolvedTesboConfig): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env");
  const exists = fs.existsSync(envPath);
  const current = exists ? fs.readFileSync(envPath, "utf-8") : "";

  if (new RegExp(`^\s*${ENV_TOKEN}=`, "m").test(current)) {
    console.log(`\n${ENV_TOKEN} is already set in ${envPath} — leaving it alone.`);
    return;
  }

  if (!detectsDotenv()) {
    console.warn(
      `\n  NOTE: nothing in this project appears to load .env, and Playwright does not read it by\n` +
        `  itself, so a token written there would be ignored. Either add "import 'dotenv/config'" to\n` +
        `  playwright.config.ts, or set ${ENV_TOKEN} in your shell or CI secrets instead.`
    );
  }

  if (!(await asker.confirm(`\nWrite ${ENV_TOKEN} to ${envPath}?`))) {
    console.log("Not written. Set it in your shell or CI secrets instead.");
    return;
  }

  const ignore = path.resolve(process.cwd(), ".gitignore");
  const ignored = fs.existsSync(ignore) && /^\s*\.env\s*$/m.test(fs.readFileSync(ignore, "utf-8"));
  if (!ignored) {
    console.warn(`\n  WARNING: .env is not in .gitignore. A committed token is a leaked token.`);
    if (!(await asker.confirm("  Write it anyway?"))) {
      console.log("Not written.");
      return;
    }
  }

  const prefix = !exists || current.endsWith("\n") || current === "" ? "" : "\n";
  fs.appendFileSync(envPath, `${prefix}${ENV_TOKEN}=${config.token}\n`, { mode: 0o600 });
  console.log(`Wrote ${ENV_TOKEN} to ${envPath}.`);
}

/**
 * Whether `tesbo.config.json` would be committed if the token went into it.
 *
 * Only a literal entry counts. Matching loosely — any line mentioning "tesbo", say — would report a
 * token as safely ignored when it is not, and that mistake is unrecoverable once pushed.
 *
 * **Leading whitespace does not count**, verified against git itself: git treats the spaces as part
 * of the pattern, so `  tesbo.config.json` ignores nothing and the file is committed. Accepting it
 * here would produce exactly the false "it's ignored" this function exists to prevent. Trailing
 * whitespace *is* accepted, because git strips it. `\r` too, for a CRLF checkout.
 */
export function configFileIsGitIgnored(cwd: string = process.cwd()): boolean {
  try {
    const text = fs.readFileSync(path.resolve(cwd, ".gitignore"), "utf-8");
    return new RegExp(`^/?${CONFIG_FILENAME.replace(/\./g, "\\.")}[ \t\r]*$`, "m").test(text);
  } catch {
    return false;
  }
}

/**
 * Persists the server and project to `tesbo.config.json`, and asks where the token should live.
 *
 * The token defaults to the environment because a credential in a tracked file stays in git history
 * after it is rotated and travels with every clone and fork. Putting it in the file is a deliberate,
 * stated choice — reasonable for a private repository, which is why it is offered — and never the
 * quiet default for whoever installs this package next.
 */
async function persistConfig(asker: Asker, config: ResolvedTesboConfig): Promise<{ tokenInFile: boolean }> {
  let tokenInFile = false;

  if (await asker.confirm(`\nStore the token in ${CONFIG_FILENAME} too, instead of the environment?`)) {
    if (configFileIsGitIgnored()) {
      tokenInFile = true;
    } else {
      console.warn(
        `\n  WARNING: ${CONFIG_FILENAME} is not in .gitignore, so the token will be committed and will\n` +
          `  remain in git history after you rotate it. Fine for a private repo if that is your call.`
      );
      tokenInFile = await asker.confirm("  Store it there anyway?");
    }
  }

  const written = writeConfigFile(
    {
      baseUrl: config.baseUrl,
      projectId: config.projectId,
      // undefined removes the key, so answering "no" also cleans up a token an earlier run stored.
      token: tokenInFile ? config.token : undefined
    },
    { cwd: process.cwd() }
  );

  console.log(
    `\nWrote ${written.path}${written.hasToken ? " (mode 600 — it holds the token)" : ""}.\n` +
      `Re-running init rewrites this file, so changing the server or project needs no other edit.`
  );

  if (!tokenInFile) await maybeWriteEnv(asker, config);
  return { tokenInFile };
}

/* ─────────────────────────────── commands ─────────────────────────────── */

/**
 * Checks what is configured, asks for whatever is missing, and proves the result works.
 *
 * Deliberately verifies even when nothing was missing: "all three are set" is not the question
 * anybody actually has — "will my run report" is, and only the probe answers that.
 */
async function doctor(): Promise<number> {
  console.log(`tesbo-playwright doctor (v${version()})\n`);

  const fileConfig = readConfigFile();
  if (fileConfig.path && !fileConfig.error) console.log(`Using ${fileConfig.path}\n`);
  let resolution = resolveConfig({}, process.env, fileConfig);

  if (resolution.state !== "ok") {
    /*
     * The resolver's own message points the reader at `doctor`, which is the right advice inside the
     * reporter and circular here. State the problem in this command's own terms instead.
     */
    if (resolution.state === "incomplete") {
      console.log(`Configuration incomplete — missing ${resolution.missing.join(", ")}.\n`);
    } else if (resolution.state === "invalid") {
      console.log(`Configuration invalid — ${resolution.message}\n`);
    } else {
      console.log(`Nothing configured yet.\n`);
    }

    if (!interactive()) {
      console.error(
        `Not a TTY, so there is nobody to ask. Set ${ENV_BASE_URL}, ${ENV_PROJECT_ID} and ${ENV_TOKEN} ` +
          `in the environment.`
      );
      return EXIT_NOT_CONFIGURED;
    }

    // Same seeding as init: the file supplies a default for anything the environment does not.
    const seed = (key: "baseUrl" | "projectId" | "token", envName: string): string | undefined =>
      process.env[envName] ?? fileConfig.values[key];
    const asker = createAsker();
    try {
      const baseUrl = await asker.ask(
        `  ${ENV_BASE_URL} (the API host, or paste the MCP URL from Project → Settings → API & MCP)`,
        { default: seed("baseUrl", ENV_BASE_URL) }
      );
      // Parsed immediately so a pasted MCP URL can supply the project id as its default below,
      // rather than making the person find the same uuid twice.
      const parsed = baseUrl ? normalizeBaseUrl(baseUrl) : null;
      const projectId = await asker.ask(`  ${ENV_PROJECT_ID}`, {
        default: parsed?.inferredProjectId ?? seed("projectId", ENV_PROJECT_ID)
      });
      const token = await asker.ask(`  ${ENV_TOKEN}`, { default: seed("token", ENV_TOKEN), secret: true });
      resolution = resolveConfig({ baseUrl, projectId, token }, process.env, fileConfig);
    } finally {
      asker.close();
    }

    if (resolution.state !== "ok") {
      console.error(`\n${resolution.message}`);
      return EXIT_NOT_CONFIGURED;
    }
  }

  console.log("Resolved:");
  printResolved(resolution.config, resolution.notes);

  console.log(`\nVerifying against ${resolution.config.baseUrl}…`);
  const outcome = await verify(resolution.config);
  if (!outcome.ok) {
    console.error(`\n  FAILED — ${outcome.detail}`);
    if (outcome.hint) console.error(`  ${outcome.hint}`);
    return EXIT_VERIFY_FAILED;
  }

  console.log(`  OK — ${outcome.detail}.`);
  /*
   * Said plainly rather than implied. The probe is a read, so it cannot prove the token may write,
   * and the alternative — a write probe — would leave a junk run in the customer's project that
   * nothing can delete. Better to be honest about the one thing this cannot check.
   */
  console.log(
    `\n  Note: this checks the "read" scope. Reporting results also needs "write", which only an\n` +
      `  actual run can confirm — a write probe would leave an undeletable empty run behind.`
  );
  return EXIT_OK;
}

/** Asks for all three values, verifies them, and prints the config to paste. */
async function init(): Promise<number> {
  console.log(`tesbo-playwright init (v${version()})\n`);

  if (!interactive()) {
    console.error(`init is interactive and stdin is not a TTY. Use "doctor" in CI, or set the three env vars.`);
    return EXIT_NOT_CONFIGURED;
  }

  console.log(`Find all three under Project → Settings → API & MCP in Tesbo.\n`);
  // Seeded from the file as well as the environment, so re-running to change one value does not mean
  // retyping the other two.
  const fileConfig = readConfigFile();
  if (fileConfig.error) {
    console.error(fileConfig.error);
    return EXIT_NOT_CONFIGURED;
  }
  const seed = (key: "baseUrl" | "projectId" | "token", envName: string): string | undefined =>
    process.env[envName] ?? fileConfig.values[key];
  const asker = createAsker();
  let resolution;
  let persisted = { tokenInFile: false };
  try {
    const baseUrl = await asker.ask(`  ${ENV_BASE_URL} (or paste the MCP URL)`, {
      default: seed("baseUrl", ENV_BASE_URL)
    });
    const parsed = baseUrl ? normalizeBaseUrl(baseUrl) : null;
    const projectId = await asker.ask(`  ${ENV_PROJECT_ID}`, {
      default: parsed?.inferredProjectId ?? seed("projectId", ENV_PROJECT_ID)
    });
    const token = await asker.ask(`  ${ENV_TOKEN}`, { default: seed("token", ENV_TOKEN), secret: true });

    resolution = resolveConfig({ baseUrl, projectId, token }, process.env, fileConfig);
    if (resolution.state !== "ok") {
      console.error(`\n${resolution.message}`);
      return EXIT_NOT_CONFIGURED;
    }

    console.log(`\nVerifying…`);
    const outcome = await verify(resolution.config);
    if (!outcome.ok) {
      console.error(`\n  FAILED — ${outcome.detail}`);
      if (outcome.hint) console.error(`  ${outcome.hint}`);
      return EXIT_VERIFY_FAILED;
    }
    console.log(`  OK — ${outcome.detail}.`);

    persisted = await persistConfig(asker, resolution.config);
  } finally {
    asker.close();
  }

  printConfigSnippet(resolution.config, persisted.tokenInFile);
  return EXIT_OK;
}

function usage(): void {
  console.log(`tesbo-playwright (v${version()}) — Tesbo reporter for Playwright

Usage:
  npx @tesbox/playwright-reporter doctor    Verify the three values, prompting for any that are unset
  npx @tesbox/playwright-reporter init      Ask for all three, verify them, print the config to paste

Configuration (inline reporter options override these):
  ${label(ENV_BASE_URL)}API host, e.g. https://api-app.tesbo.io — no default, and not the web app host
  ${label(ENV_PROJECT_ID)}The project results are reported into
  ${label(ENV_TOKEN)}Project API token (tsbo_…), needing the read and write scopes

Exit codes: ${EXIT_OK} ok, ${EXIT_VERIFY_FAILED} verification failed, ${EXIT_NOT_CONFIGURED} not configured.
`);
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return EXIT_OK;
  }
  if (command === "--version" || command === "-v") {
    console.log(version());
    return EXIT_OK;
  }
  if (command === "doctor") return doctor();
  if (command === "init") return init();

  console.error(`Unknown command "${command}".\n`);
  usage();
  return EXIT_NOT_CONFIGURED;
}

/*
 * Guarded so the module can be imported by its own tests. Without this, `require("./cli")` runs the
 * CLI — which under `node --test` means a test file importing it would parse argv, prompt, and exit
 * the runner.
 */
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[tesbo] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT_VERIFY_FAILED);
    });
}
