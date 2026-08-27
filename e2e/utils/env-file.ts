import fs from "node:fs";
import path from "node:path";

/*
 * Per-environment configuration files, so a run can be aimed at a deployment without depending on
 * anything outside e2e/.
 *
 * The problem this solves. utils/env.ts reads the repo-root `.env` as a last resort, which is the
 * local docker stack's own configuration — the right answer on a developer's machine and the wrong
 * one everywhere else. A CI job has no reason to have that file, and if it does, its values describe
 * a stack the job is not testing. So "point the suite at staging" meant exporting a handful of
 * variables in the job definition and hoping none were missed; a missing DATABASE_URL in particular
 * fails silently, by skipping 46 spec files while still reporting success.
 *
 * The shape instead: one file per environment under e2e/environments/, named for the environment,
 * selected with E2E_ENV.
 *
 *     npx playwright test                      # reads e2e/environments/local.env (the default)
 *     E2E_ENV=stage npx playwright test        # reads e2e/environments/stage.env
 *     E2E_ENV_FILE=/secrets/qa.env …           # or name the file outright
 *
 * PRECEDENCE, and it matters: anything already in process.env WINS over the file. That is what makes
 * a CI job independent of the checkout — Jenkins injects credentials as environment variables, those
 * take priority, and the committed file supplies only the non-secret remainder (the two base URLs,
 * the fixture names). It also means a developer can override one value for a single run without
 * editing anything.
 *
 * Real files are gitignored (`*.env`); each environment ships a committed `.env.example` describing
 * what it needs. Never commit a connection string or a password here.
 */

const ENVIRONMENTS_DIR = path.resolve(__dirname, "../environments");

/*
 * The environment a bare `npx playwright test` runs against.
 *
 * Without this, an invocation that named no environment fell through to the hardcoded defaults at
 * the top of utils/env.ts — `http://localhost:1011`, which is the OPEN-SOURCE stack's port, not this
 * one's :1021. Nothing said so. The run then looked local to `targetIsLocal`, which switched
 * auto-provisioning on, which tried to sign up `e2e-smoke@mailinator.com` against a stack that was
 * not there, and died in global-setup with "Provisioned <user> but the follow-up password login
 * still failed" — an error that reads like an auth bug and is really "nobody said where to run".
 *
 * Defaulting to `local` puts the ports in a file a human can read and correct. It stays a soft
 * default: if e2e/environments/local.env has not been created, this is a no-op and the old
 * hardcoded fallbacks still apply, so a fresh checkout behaves exactly as it did before.
 */
const DEFAULT_ENVIRONMENT = "local";

/**
 * Parses a KEY=VALUE file the way a `.env` file is actually written.
 *
 * Deliberately NOT `source`d and not eval'd: a value with a space in it ("Testing Stagging 105070")
 * would be read as a command, and a backtick in a password would be executed. scripts/e2e-stage.sh
 * learned this the same way. Blank lines and `#` comments are skipped; one layer of surrounding
 * quotes is stripped; everything after the first `=` is the value, so a connection string's own `=`
 * characters survive.
 */
export function parseEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return values;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export type LoadedEnvironment = {
  /** The environment name in effect — the E2E_ENV value, or the default when none was given. */
  name: string | null;
  /** The file actually read, or null when none was requested and no default file exists. */
  file: string | null;
  /** Keys taken from the file (i.e. not already set in process.env). */
  applied: string[];
  /** Whether E2E_ENV / E2E_ENV_FILE named this environment, as opposed to it being the default. */
  explicit: boolean;
};

let loaded: LoadedEnvironment | null = null;

/**
 * Loads the selected environment file into process.env, without overwriting existing values.
 *
 * Called once, at the top of utils/env.ts, before any value is read — every consumer in the suite
 * resolves its configuration through that module, so this is the one place that has to run first.
 * Idempotent, because Playwright imports the module once per worker process.
 *
 * With neither E2E_ENV nor E2E_ENV_FILE set this falls back to DEFAULT_ENVIRONMENT, and is a no-op
 * if that file does not exist — so an untouched checkout behaves exactly as it did before.
 */
export function loadEnvironmentFile(): LoadedEnvironment {
  if (loaded) return loaded;

  const explicitFile = process.env.E2E_ENV_FILE;
  const requestedName = process.env.E2E_ENV;
  const explicit = Boolean(explicitFile || requestedName);

  const name = requestedName ?? (explicitFile ? null : DEFAULT_ENVIRONMENT);
  const file = explicitFile ?? path.join(ENVIRONMENTS_DIR, `${name}.env`);

  if (!fs.existsSync(file)) {
    /*
     * Named but missing is a mistake worth being loud about, not a reason to fall through to
     * localhost defaults and quietly test the wrong thing — or, worse, to test nothing while
     * reporting success. Whoever set E2E_ENV meant it.
     *
     * The DEFAULT is different: nobody asked for it, so its absence is not a mistake. Fall through
     * silently and let utils/env.ts use its hardcoded values, as it did before there were
     * environment files at all.
     */
    if (!explicit) {
      loaded = { name: null, file: null, applied: [], explicit: false };
      return loaded;
    }
    throw new Error(
      `E2E_ENV${explicitFile ? "_FILE" : ""} names "${explicitFile ?? name}" but ${file} does not ` +
        `exist. Copy the matching ${path.basename(file)}.example and fill it in, or pass the values ` +
        "as environment variables instead — process.env always takes precedence over the file.",
    );
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(file))) {
    // process.env wins: injected CI credentials must beat anything in the checkout.
    if (process.env[key] !== undefined) continue;
    /*
     * `KEY=` means "not configured", not "configured as the empty string" — which is how both
     * committed .env.example files use it, and how a .env file is read everywhere else.
     *
     * Assigning it would make the key *present*, and every fallback chain downstream is built on
     * `??`, which only steps past `undefined`. So `E2E_DATABASE_URL=` in local.env — a line whose
     * own comment says it is empty so that utils/env.ts falls back to the repo-root .env — would
     * instead shadow that .env with "". dbControlAvailable() then returns false and all 46
     * DB-backed spec files skip themselves while the run still reports success: the exact silent
     * failure this module was written to stop.
     */
    if (value === "") continue;
    process.env[key] = value;
    applied.push(key);
  }

  loaded = { name, file, applied, explicit };
  return loaded;
}

/** The environment resolved by loadEnvironmentFile(), for the banner in playwright.config.ts. */
export function loadedEnvironment(): LoadedEnvironment {
  return loadEnvironmentFile();
}
