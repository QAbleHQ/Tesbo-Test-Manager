/**
 * `tesbo.config.json` — the file `init` owns.
 *
 * **Why a file the CLI owns, rather than editing `playwright.config.ts`.** The obvious request is
 * for `init` to write the values straight into the Playwright config, and re-running it to update
 * them. It cannot do that safely: the config may be `.ts`, `.js`, `.mjs` or `.cts`; its `reporter`
 * field may be absent, a bare string, an array of strings or an array of tuples; and rewriting
 * values inside somebody's hand-written TypeScript needs a real parser, not a regular expression.
 * Every version of that is a program that can mangle a file the user did not ask it to touch.
 *
 * So the values live here instead. `playwright.config.ts` names the reporter once and never changes
 * again, and re-running `init` with a different server rewrites this file — which is what makes the
 * update idempotent rather than a second entry appended to a growing array.
 *
 * Precedence is inline reporter options, then environment variables, then this file. The file is the
 * *lowest* rung deliberately: a CI runner sets `TESBO_API_TOKEN` in its secrets, and that must win
 * over whatever a developer committed months ago.
 */

import * as fs from "fs";
import * as path from "path";
import type { TesboConfigInput } from "./config";

export const CONFIG_FILENAME = "tesbo.config.json";

/** The keys this SDK owns. Anything else in the file is preserved untouched on rewrite. */
const OWNED_KEYS = ["baseUrl", "projectId", "token"] as const;
type OwnedKey = (typeof OWNED_KEYS)[number];

export interface FileConfig {
  /** The owned values that were present and usable. */
  values: TesboConfigInput;
  /** Absolute path of the file that was read, or null when there is none. */
  path: string | null;
  /**
   * Set when a file exists but could not be used.
   *
   * A malformed config is never ignored. Somebody who wrote the file meant to configure reporting,
   * and silently falling back to "unconfigured" would report nothing while exiting 0 — the exact
   * failure this SDK is built to refuse.
   */
  error?: string;
  /** Keys the SDK does not own, kept so a rewrite does not discard the user's own additions. */
  extra: Record<string, unknown>;
}

/** The "there is no file" value, and the default for callers that must not touch the disk. */
export const NO_FILE_CONFIG: FileConfig = { values: {}, path: null, extra: {} };

export function configFilePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, CONFIG_FILENAME);
}

/**
 * Reads `tesbo.config.json` from `cwd`, if it is there.
 *
 * A missing file is not a problem — it is the normal state for a project configured entirely through
 * the environment. Anything else that goes wrong is reported rather than swallowed.
 */
export function readConfigFile(cwd: string = process.cwd()): FileConfig {
  const file = configFilePath(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    // ENOENT is the ordinary case: no file, nothing configured here, no complaint.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...NO_FILE_CONFIG };
    return { values: {}, path: file, extra: {}, error: `${CONFIG_FILENAME} could not be read: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      values: {},
      path: file,
      extra: {},
      error: `${CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { values: {}, path: file, extra: {}, error: `${CONFIG_FILENAME} must contain a JSON object.` };
  }

  const source = parsed as Record<string, unknown>;
  const values: TesboConfigInput = {};
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (!(OWNED_KEYS as readonly string[]).includes(key)) {
      extra[key] = value;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      // Named rather than coerced: a number where a URL belongs is a mistake, and guessing at it is
      // how a config that looks fine reports nowhere.
      return {
        values: {},
        path: file,
        extra: {},
        error: `${CONFIG_FILENAME}: "${key}" must be a string, got ${Array.isArray(value) ? "array" : typeof value}.`
      };
    }
    // Whitespace-only is treated as unset, matching how the env vars are read.
    if (value.trim()) values[key as OwnedKey] = value.trim();
  }

  return { values, path: file, extra };
}

/**
 * Writes `tesbo.config.json`, preserving keys the SDK does not own.
 *
 * Merge rather than replace: a project may add its own keys to this file, and `init` re-running to
 * change a server must not silently delete them. An owned key set to `undefined` is removed, which
 * is how moving the token out of the file works.
 */
export function writeConfigFile(
  values: TesboConfigInput,
  opts: { cwd?: string } = {}
): { path: string; hasToken: boolean } {
  const cwd = opts.cwd ?? process.cwd();
  const file = configFilePath(cwd);
  const existing = readConfigFile(cwd);

  // A malformed file is not merged into — that would carry the damage forward. It is replaced, and
  // the caller has already been told it was unreadable.
  const body: Record<string, unknown> = existing.error ? {} : { ...existing.extra };
  const previous = existing.error ? {} : existing.values;

  for (const key of OWNED_KEYS) {
    const next = values[key] === undefined ? previous[key] : values[key];
    if (next && next.trim()) body[key] = next.trim();
    else delete body[key];
  }

  const hasToken = typeof body.token === "string" && body.token.length > 0;
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: hasToken ? 0o600 : 0o644 });
  // writeFileSync's mode applies only when creating the file, so an existing file that has just
  // gained a token would keep its old permissions without this.
  if (hasToken) fs.chmodSync(file, 0o600);

  return { path: file, hasToken };
}

/**
 * Whether anything in this project actually loads `.env`.
 *
 * Playwright does not read `.env` on its own, so offering to write a token there is only useful if
 * the project loads it — otherwise the file is written, the permissions are set, the command reports
 * success, and the reporter still sees nothing. This is the check that stops `init` from promising
 * that.
 */
export function detectsDotenv(cwd: string = process.cwd()): boolean {
  const pkgPath = path.resolve(cwd, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.dotenv || pkg.devDependencies?.dotenv) return true;
  } catch {
    // No package.json, or unreadable: fall through to the config scan below.
  }

  for (const name of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cts"]) {
    try {
      const text = fs.readFileSync(path.resolve(cwd, name), "utf-8");
      if (/dotenv/.test(text)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
